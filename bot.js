const hydraBot = require('hydra-bot');
const path = require('path');
const { ipcMain } = require('electron');
const express = require('express');
const { getDatabase } = require('./database');
const PDFDocument = require('pdfkit');
const fs = require('fs');

const cookiesPath = path.join(__dirname, 'cookies.json');
const maxActiveChats = 3;

// Initialize Express
const server = express();

// Add JSON middleware
server.use(express.json());

let bot;
let activeChatsList = [];
let userCurrentTopic = {};
let botConnection = null;
let reportedProblems = [];

const defaultMessage = `Olá! Para iniciarmos seu atendimento, envie suas informações no formato abaixo:

Nome:
Cidade:
Cargo: (Aluno, Supervisor, Secretário, Professor, Administrador, Responsável)
Escola: (Informe o nome da escola, se você for Aluno, Responsável, Professor ou Supervisor)

⚠️ Atenção: Certifique-se de preencher todas as informações corretamente para agilizar o atendimento.`;

// Initialize the bot
async function startHydraBot(io) {
  try {
    bot = await hydraBot.initServer({
      puppeteerOptions: {
        headless: false,
        devtools: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
      printQRInTerminal: true,
    });

    console.log('Servidor Hydra iniciado!');

    bot.on('connection', async (conn) => {
      if (conn.connect) {
        console.log('Conexão Hydra estabelecida.');
        botConnection = conn;
        startListeningForMessages(conn, io);
      } else {
        console.error('Erro na conexão Hydra.');
      }
    });

    ipcMain.on('redirectToChat', async (event, chatId) => {
      if (botConnection) {
        await redirectToWhatsAppChat(botConnection, chatId);
      }
    });

    ipcMain.on('markProblemCompleted', (event, chatId) => {
      reportedProblems = reportedProblems.filter(problem => problem.chatId !== chatId);
      markProblemAsCompleted(chatId, io);
      sendStatusUpdateToMainProcess(io);
    });

    bot.on('qrcode', (qrcode) => {
      console.log('QR Code gerado pelo Hydra:', qrcode);
    });

  } catch (error) {
    console.error('Erro ao iniciar o Hydra:', error);
  }

  io.on('connection', (socket) => {
    socket.on('attendProblem', async (data) => {
      try {
        const { chatId, attendantId } = data;

        // Update problem status in database
        await getDatabase().run(
          `UPDATE problems 
           SET status = 'active', 
               attendant_id = ? 
           WHERE chatId = ? AND status = 'pending'`,
          [attendantId, chatId]
        );

        // Send status update to all clients
        sendStatusUpdateToMainProcess(io);

        // Send confirmation message to the user
        if (botConnection) {
          await sendMessage(
            botConnection,
            chatId,
            'Um atendente está analisando seu problema e entrará em contato em breve.'
          );
        }
      } catch (error) {
        console.error('Erro ao atender problema:', error);
      }
    });

    socket.on('endChat', async (data) => {
      try {
        const { chatId, id } = data;

        // Update chat status to completed
        await getDatabase().run(
          `UPDATE problems 
           SET status = 'completed', 
               date_completed = DATETIME('now')
           WHERE chatId = ? AND (id = ? OR status = 'pending')`, // Also update pending problems
          [chatId, id]
        );

        // Send message to user
        if (botConnection) {
          await sendMessage(
            botConnection,
            chatId,
            'Atendimento finalizado. Obrigado por utilizar nosso suporte!'
          );
        }

        // Process next user in queue
        const nextInLine = await getNextInWaitingList();
        if (nextInLine) {
          await getDatabase().run(
            'UPDATE problems SET status = "active" WHERE chatId = ?',
            [nextInLine.chatId]
          );

          await sendMessage(
            botConnection,
            nextInLine.chatId,
            `Olá ${nextInLine.name}! Sua vez chegou. Estamos iniciando seu atendimento.`
          );
          await sendProblemOptions(botConnection, nextInLine.chatId);
        }

        // Update waiting users
        await updateWaitingUsers(io);

        // Send status update to all clients
        sendStatusUpdateToMainProcess(io);

      } catch (error) {
        console.error('Erro ao finalizar atendimento:', error);
      }
    });
  });
}

// Listen for incoming messages
function startListeningForMessages(conn, io) {
  conn.client.ev.on('newMessage', async (newMsg) => {
    const chatId = newMsg.result.chatId;

    if (!newMsg.result.fromMe) {
      const messageText = newMsg.result.body.toLowerCase();

      if (messageText.startsWith("nome:")) {
        const userInfo = parseUserInfo(messageText);
        if (userInfo) {
          handleNewUser(conn, chatId, userInfo, io);
        } else {
          await sendMessage(conn, chatId, 'Por favor, insira suas informações no formato correto.');
        }
      } else {
        handleUserMessage(conn, chatId, messageText, io);
      }
    }
  });

  conn.client.ev.on('chatClosed', async (chatId) => {
    handleChatClosed(chatId, io);
  });
}

// Add this function before handleNewUser
async function updateDatabaseAndNotify(query, params, io) {
    return new Promise((resolve, reject) => {
        getDatabase().run(query, params, async function(err) {
            if (err) {
                console.error('Erro na atualização do banco:', err);
                reject(err);
                return;
            }

            try {
                // Buscar dados atualizados
                const statusData = await fetchCurrentStatus();
                // Emitir atualização para todos os clientes
                io.emit('statusUpdate', statusData);
                resolve(this.lastID);
            } catch (error) {
                console.error('Erro ao buscar dados atualizados:', error);
                reject(error);
            }
        });
    });
}

// Add this helper function to fetch current status
async function fetchCurrentStatus() {
    return new Promise((resolve, reject) => {
        const queries = {
            active: 'SELECT * FROM problems WHERE status = "active" ORDER BY date DESC LIMIT 3',
            waiting: 'SELECT * FROM problems WHERE status = "waiting" ORDER BY date ASC',
            pending: 'SELECT * FROM problems WHERE status = "pending" ORDER BY date DESC'
        };

        Promise.all([
            queryDatabase(queries.active),
            queryDatabase(queries.waiting),
            queryDatabase(queries.pending)
        ])
        .then(([active, waiting, pending]) => {
            resolve({
                activeChats: active,
                waitingList: waiting,
                problems: pending
            });
        })
        .catch(reject);
    });
}

// Add this helper function for database queries
function queryDatabase(query, params = []) {
    return new Promise((resolve, reject) => {
        getDatabase().all(query, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
}

// Handle new user
async function handleNewUser(conn, chatId, userInfo, io) {
    const activeCount = await getActiveChatsCount();
    const status = activeCount < maxActiveChats ? 'active' : 'waiting';
    
    try {
        await updateDatabaseAndNotify(
            `INSERT INTO problems (chatId, name, position, city, school, status, date) 
             VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
            [chatId, userInfo.name, userInfo.position, userInfo.city, userInfo.school, status],
            io
        );

        if (status === 'active') {
            await sendMessage(
                conn, 
                chatId, 
                `Olá ${userInfo.name}! Um atendente está disponível para ajudá-lo.`
            );
            await sendProblemOptions(conn, chatId);
        } else {
            const position = await getWaitingPosition(chatId);
            await sendMessage(
                conn,
                chatId,
                `Olá ${userInfo.name}!\n\nTodos os nossos atendentes estão ocupados no momento.\n` +
                `Você está na ${position}ª posição da fila.\n` +
                `Aguarde, você será notificado assim que um atendente estiver disponível.`
            );
        }
    } catch (error) {
        console.error('Erro ao processar novo usuário:', error);
        await sendMessage(conn, chatId, 'Desculpe, ocorreu um erro. Por favor, tente novamente mais tarde.');
    }
}

// Função para obter contagem de chats ativos
async function getActiveChatsCount() {
    return new Promise((resolve, reject) => {
        getDatabase().get('SELECT COUNT(*) as count FROM problems WHERE status = "active"', (err, row) => {
            if (err) reject(err);
            else resolve(row.count);
        });
    });
}

// Função para obter posição na fila
async function getWaitingPosition(chatId) {
    return new Promise((resolve, reject) => {
        getDatabase().all('SELECT chatId FROM problems WHERE status = "waiting" ORDER BY date ASC', (err, rows) => {
            if (err) reject(err);
            else {
                const position = rows.findIndex(row => row.chatId === chatId) + 1;
                resolve(position || rows.length + 1);
            }
        });
    });
}

// Handle user message
async function handleUserMessage(conn, chatId, messageText, io) {
    const currentTopic = userCurrentTopic[chatId];
    
    if (!currentTopic) {
        await sendMessage(conn, chatId, defaultMessage);
        return;
    }

    if (typeof currentTopic === 'object' && currentTopic.state === 'descricaoProblema') {
        await handleProblemDescription(conn, chatId, messageText, io);
        userCurrentTopic[chatId] = 'problema'; // Reset to problema after description
    } else if (currentTopic === 'problema') {
        await handleProblemSelection(conn, chatId, messageText, io);
    } else if (currentTopic.stage === 'subproblema') {
        await handleSubProblemSelection(conn, chatId, messageText, io);
    } else if (currentTopic === 'videoFeedback') {
        await handleVideoFeedback(conn, chatId, messageText, io);
    } else {
        await sendMessage(conn, chatId, defaultMessage);
    }
}

// Handle chat closed
async function handleChatClosed(chatId, io) {
    try {
        // Mark chat as completed
        await updateDatabaseAndNotify(
            `UPDATE problems 
             SET status = 'completed', 
             date_completed = datetime('now') 
             WHERE chatId = ? AND status = 'active'`,
            [chatId],
            io
        );

        // Get next user in waiting list
        const nextUser = await getNextInWaitingList();
        if (nextUser) {
            // Update next user status
            await updateDatabaseAndNotify(
                `UPDATE problems 
                 SET status = 'active' 
                 WHERE chatId = ?`,
                [nextUser.chatId],
                io
            );

            // Send message to next user
            await sendMessage(
                botConnection,
                nextUser.chatId,
                `Olá ${nextUser.name}! Um atendente está disponível agora para ajudá-lo.`
            );
            await sendProblemOptions(botConnection, nextUser.chatId);
        }

        // Update all waiting users positions
        await updateWaitingUsers(io);
        
        // Fetch and broadcast updated status to all clients
        await sendStatusUpdateToMainProcess(io);

    } catch (error) {
        console.error('Erro ao finalizar atendimento:', error);
    }
}

// Parse user information from the message
function parseUserInfo(messageText) {
  const info = {};
  const lines = messageText.split('\n');
  for (const line of lines) {
    const [key, ...value] = line.split(':');
    if (key && value.length) {
      info[key.trim().toLowerCase()] = value.join(':').trim();
    }
  }
  if (info.nome && info.cidade && info.cargo && info.escola) {
    return {
      name: capitalize(info.nome),
      city: capitalize(info.cidade),
      position: capitalize(info.cargo),
      school: capitalize(info.escola),
    };
  }
  return null;
}

// Capitalize the first letters of words
function capitalize(str) {
  return str.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
}

// Send a message to the user
async function sendMessage(conn, chatId, message) {
  await conn.client.sendMessage({ to: chatId, body: message, options: { type: 'sendText' } });
}

// Send problem options to the user
async function sendProblemOptions(conn, chatId) {
  const problemOptions = `Por favor, selecione o tipo de problema que você está enfrentando:

1️⃣ Falha no acesso ao sistema
2️⃣ Erro ao cadastrar aluno/funcionário
3️⃣ Problemas com o diário de classe
4️⃣ Falha no registro de notas
5️⃣ Outro problema`;

  await sendMessage(conn, chatId, problemOptions);
}

// Handle problem selection
async function handleProblemSelection(conn, chatId, messageText, io) {
  switch (messageText) {
    case '1':
      await sendSubProblemOptions(conn, chatId, 'Falha no acesso ao sistema');
      break;
    case '2':
      await sendSubProblemOptions(conn, chatId, 'Erro ao cadastrar aluno/funcionário');
      break;
    case '3':
      await sendSubProblemOptions(conn, chatId, 'Problemas com o diário de classe');
      break;
    case '4':
      await sendSubProblemOptions(conn, chatId, 'Falha no registro de notas');
      break;
    case '5':
      await sendMessage(conn, chatId, 'Por favor, descreva o problema que você está enfrentando:');
      userCurrentTopic[chatId] = 'descricaoProblema';
      break;
    case 'voltar':
      await sendProblemOptions(conn, chatId);
      break;
    default:
      await sendMessage(conn, chatId, 'Opção inválida. Por favor, selecione uma opção válida.');
  }
}

// Send sub-problem options to the user
async function sendSubProblemOptions(conn, chatId, problem) {
  const subProblemOptions = getSubProblemOptions(problem);
  userCurrentTopic[chatId] = { problem, stage: 'subproblema' }; 
  await sendMessage(conn, chatId, subProblemOptions);
}

// Get sub-problem options
function getSubProblemOptions(problem) {
  const options = {
    'Falha no acesso ao sistema': `Selecione o subtópico:

1️⃣ Não consigo acessar minha conta
2️⃣ Sistema não carrega
3️⃣ Outro problema relacionado ao acesso

Digite 'voltar' para retornar ao menu anterior.`,
    'Erro ao cadastrar aluno/funcionário': `Selecione o subtópico:

1️⃣ Erro ao inserir dados do aluno
2️⃣ Erro ao inserir dados do funcionário
3️⃣ Outro problema relacionado ao cadastro

Digite 'voltar' para retornar ao menu anterior.`,
    'Problemas com o diário de classe': `Selecione o subtópico:

1️⃣ Falha na inserção de notas
2️⃣ Falha na visualização de registros
3️⃣ Outro problema com o diário de classe

Digite 'voltar' para retornar ao menu anterior.`,
    'Falha no registro de notas': `Selecione o subtópico:

1️⃣ Não consigo registrar as notas
2️⃣ Notas não estão sendo salvas
3️⃣ Outro problema com o registro de notas

Digite 'voltar' para retornar ao menu anterior.`
  };
  return options[problem] || 'Opção inválida. Por favor, selecione uma opção válida.';
}

// Handle sub-problem selection
async function handleSubProblemSelection(conn, chatId, messageText, io) {
    if (messageText === 'voltar') {
        userCurrentTopic[chatId] = 'problema';
        await sendProblemOptions(conn, chatId);
        return;
    }

    const mainProblem = userCurrentTopic[chatId].problem;
    const subProblemText = getSubProblemText(mainProblem, messageText);
    const videoUrl = getVideoUrlForSubProblem(messageText);

    // Buscar informações do usuário
    getDatabase().get('SELECT name, city, position, school FROM problems WHERE chatId = ?', [chatId], 
        async (err, userInfo) => {
            if (err) {
                console.error('Erro ao buscar informações do usuário:', err);
                return;
            }

            // Criar novo registro de problema
            const problemDescription = `${mainProblem} - ${subProblemText}`;
            const date = new Date().toISOString();

            getDatabase().run(
                `INSERT INTO problems 
                (chatId, name, city, position, school, description, status, date) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    chatId,
                    userInfo.name,
                    userInfo.city,
                    userInfo.position,
                    userInfo.school,
                    problemDescription,
                    'pending',
                    date
                ],
                async function(err) {
                    if (err) {
                        console.error('Erro ao salvar problema:', err);
                        return;
                    }

                    await sendMessage(conn, chatId, `Aqui está um vídeo que pode ajudar a resolver seu problema: ${videoUrl}`);
                    await sendMessage(conn, chatId, 'O vídeo foi suficiente para resolver seu problema? (sim/não)');
                    userCurrentTopic[chatId] = 'videoFeedback';

                    // Emitir evento com o novo problema
                    io.emit('userProblem', problemDescription, chatId, userInfo.name);
                    sendStatusUpdateToMainProcess(io);
                }
            );
        }
    );
}

// Get sub-problem text
function getSubProblemText(problem, subProblem) {
  const subProblemTexts = {
    'Falha no acesso ao sistema': {
      '1': 'Não consigo acessar minha conta',
      '2': 'Sistema não carrega',
      '3': 'Outro problema relacionado ao acesso'
    },
    'Erro ao cadastrar aluno/funcionário': {
      '1': 'Erro ao inserir dados do aluno',
      '2': 'Erro ao inserir dados do funcionário',
      '3': 'Outro problema relacionado ao cadastro'
    },
    'Problemas com o diário de classe': {
      '1': 'Falha na inserção de notas',
      '2': 'Falha na visualização de registros',
      '3': 'Outro problema com o diário de classe'
    },
    'Falha no registro de notas': {
      '1': 'Não consigo registrar as notas',
      '2': 'Notas não estão sendo salvas',
      '3': 'Outro problema com o registro de notas'
    }
  };
  return subProblemTexts[problem] ? subProblemTexts[problem][subProblem] : 'Outro problema';
}

// Get video URL for sub-problem
function getVideoUrlForSubProblem(subProblem) {
  const videoUrls = {
    '1': 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    '2': 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    '3': 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  };
  return videoUrls[subProblem] || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
}

// Handle video feedback
async function handleVideoFeedback(conn, chatId, messageText, io) {
    if (messageText === 'sim') {
        await sendMessage(conn, chatId, 'Ficamos felizes em ajudar! Se precisar de mais alguma coisa, estamos à disposição.');
        userCurrentTopic[chatId] = 'problema';
        await closeChat(chatId, io);
    } else if (messageText === 'não') {
        await sendMessage(conn, chatId, 'Por favor, descreva o problema que você está enfrentando:');
        userCurrentTopic[chatId] = {
            state: 'descricaoProblema',
            previousState: 'videoFeedback'
        };
    } else {
        await sendMessage(conn, chatId, 'Resposta inválida. Por favor, responda com "sim" ou "não".');
    }
}

// Handle problem description
async function handleProblemDescription(conn, chatId, messageText, io) {
    const currentTopic = userCurrentTopic[chatId];
    const isFromVideoFeedback = currentTopic && 
                               currentTopic.state === 'descricaoProblema' && 
                               currentTopic.previousState === 'videoFeedback';

    // Buscar o problema mais recente do usuário
    getDatabase().get(
        `SELECT id, name, city, position, school FROM problems 
         WHERE chatId = ? AND status = 'pending' 
         ORDER BY date DESC LIMIT 1`,
        [chatId],
        async (err, userInfo) => {
            if (err) {
                console.error('Erro ao buscar informações do usuário:', err);
                return;
            }

            if (isFromVideoFeedback && userInfo) {
                // Atualizar o problema existente
                getDatabase().run(
                    `UPDATE problems 
                     SET description = ?, 
                         date = ?
                     WHERE id = ?`,
                    [messageText, new Date().toISOString(), userInfo.id],
                    async function(err) {
                        if (err) {
                            console.error('Erro ao atualizar problema:', err);
                            return;
                        }

                        io.emit('userProblem', messageText, chatId, userInfo.name);
                        await sendMessage(conn, chatId, 'Problema atualizado. Um atendente entrará em contato em breve.');
                        sendStatusUpdateToMainProcess(io);
                    }
                );
            } else {
                // Criar novo registro de problema
                const date = new Date().toISOString();
                getDatabase().run(
                    `INSERT INTO problems 
                    (chatId, name, city, position, school, description, status, date) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        chatId,
                        userInfo.name,
                        userInfo.city,
                        userInfo.position,
                        userInfo.school,
                        messageText,
                        'pending',
                        date
                    ],
                    async function(err) {
                        if (err) {
                            console.error('Erro ao salvar problema:', err);
                            return;
                        }

                        io.emit('userProblem', messageText, chatId, userInfo.name);
                        await sendMessage(conn, chatId, 'Problema registrado. Um atendente entrará em contato em breve.');
                        sendStatusUpdateToMainProcess(io);
                    }
                );
            }
        }
    );
}

// Save client information to the database
function saveClientInfoToDatabase(userInfo, chatId, status, io) {
  const date = new Date().toISOString();
  
  getDatabase().run(
    `INSERT INTO problems (chatId, name, position, city, school, status, date) 
     VALUES (?, ?, ?, ?, ?, ?, ?)`, 
    [chatId, userInfo.name, userInfo.position, userInfo.city, userInfo.school, status, date], 
    function(err) {
      if (err) {
        console.error('Erro ao salvar informações do cliente:', err.message);
        return;
      }
      console.log(`Cliente inserido com ID ${this.lastID}`);
      io.emit('statusUpdate');
    }
  );
}

// Save problem to the database
function saveProblemToDatabase(problemData, io) {
  getDatabase().run(`UPDATE problems SET description = ?, date = ? WHERE id = ?`, 
    [problemData.description, problemData.date, problemData.problemId], 
    function(err) {
      if (err) {
        console.error('Erro ao salvar problema:', err.message);
        return;
      }
      console.log(`Problem description updated for id ${problemData.problemId}`);
      io.emit('statusUpdate', { activeChats: activeChatsList, waitingList: getWaitingList(), problems: reportedProblems });
    });
}

// Mark problem as completed in the database
function markProblemAsCompleted(problemId, io) {
  getDatabase().run(`UPDATE problems SET status = 'completed' WHERE id = ?`, [problemId], function(err) {
    if (err) {
      console.error('Erro ao marcar problema como concluído:', err.message);
      return;
    }
    console.log(`Problem with id ${problemId} marked as completed.`);
    io.emit('statusUpdate', { activeChats: activeChatsList, waitingList: getWaitingList(), problems: reportedProblems });
  });
}

// Send status update to the main process
async function sendStatusUpdateToMainProcess(io) {
    try {
        const queries = {
            active: `SELECT * FROM problems 
                     WHERE status = 'active' 
                     ORDER BY date DESC`,
            waiting: `SELECT * FROM problems 
                      WHERE status = 'waiting' 
                      ORDER BY date ASC`,
            pending: `SELECT * FROM problems 
                      WHERE status = 'pending' 
                      ORDER BY date DESC`,
            completed: `SELECT * FROM problems 
                        WHERE status = 'completed' 
                        ORDER BY date_completed DESC 
                        LIMIT 10`
        };

        const [active, waiting, pending, completed] = await Promise.all([
            queryDatabase(queries.active),
            queryDatabase(queries.waiting),
            queryDatabase(queries.pending),
            queryDatabase(queries.completed)
        ]);

        const statusData = {
            activeChats: active,
            waitingList: waiting,
            problems: pending,
            completedChats: completed
        };

        // Emit update to all clients
        io.emit('statusUpdate', statusData);
        
        // Debug log
        console.log('Status atualizado:', {
            activeCount: active.length,
            waitingCount: waiting.length,
            pendingCount: pending.length,
            completedCount: completed.length
        });

    } catch (error) {
        console.error('Erro ao atualizar status:', error);
    }
}

// Send problem to the front-end
function sendProblemToFrontEnd(problemData) {
  if (problemData.description.startsWith('Subtópico:')) {
    return;
  }
  ipcMain.emit('userProblem', null, problemData.description, problemData.chatId, problemData.name);
}

// Close the chat
async function closeChat(chatId, io) {
    try {
        // Mark chat as completed
        await updateDatabaseAndNotify(
            `UPDATE problems 
             SET status = 'completed', 
             date_completed = datetime('now') 
             WHERE chatId = ?`,
            [chatId],
            io
        );

        // Get next user in waiting list
        const nextUser = await getNextInWaitingList();
        if (nextUser) {
            // Update next user status
            await updateDatabaseAndNotify(
                `UPDATE problems 
                 SET status = 'active' 
                 WHERE chatId = ?`,
                [nextUser.chatId],
                io
            );

            // Send message to next user
            await sendMessage(
                botConnection,
                nextUser.chatId,
                `Olá ${nextUser.name}! Sua vez chegou. Estamos iniciando seu atendimento.`
            );
            await sendProblemOptions(botConnection, nextUser.chatId);
        }

        // Update all waiting users positions
        await updateWaitingUsers(io);
        
        // Fetch and broadcast final status update
        await sendStatusUpdateToMainProcess(io);

    } catch (error) {
        console.error('Erro ao finalizar atendimento:', error);
    }
}

// Função para obter próximo da fila
async function getNextInWaitingList() {
    return new Promise((resolve, reject) => {
        getDatabase().get(
            `SELECT * FROM problems 
             WHERE status = 'waiting' 
             ORDER BY date ASC 
             LIMIT 1`,
            (err, row) => {
                if (err) reject(err);
                else resolve(row);
            }
        );
    });
}

// Attend the next user in the queue
async function attendNextUserInQueue(conn, io) {
  const nextUser = activeChatsList.find(chat => chat.isWaiting);
  if (nextUser) {
    nextUser.isWaiting = false;
    await sendMessage(conn, nextUser.chatId, `Obrigado por aguardar, ${nextUser.name}. Estamos iniciando seu atendimento.`);
    await sendProblemOptions(conn, nextUser.chatId);
    userCurrentTopic[nextUser.chatId] = 'problema';
    sendStatusUpdateToMainProcess(io);
  }
}

// Get the waiting list
function getWaitingList() {
  return activeChatsList.filter(chat => chat.isWaiting);
}

// Adicionar função para redirecionar para WhatsApp
function redirectToWhatsAppChat(chatId) {
    const sanitizedChatId = chatId.replace('@c.us', '');
    const whatsappUrl = `https://api.whatsapp.com/send?phone=${sanitizedChatId}`;
    require('electron').shell.openExternal(whatsappUrl);
}

// Add new function to update waiting users
async function updateWaitingUsers(io) {
    try {
        const waitingUsers = await new Promise((resolve, reject) => {
            getDatabase().all(
                'SELECT chatId, name FROM problems WHERE status = "waiting" ORDER BY date ASC',
                (err, rows) => err ? reject(err) : resolve(rows)
            );
        });

        // Update each waiting user with their new position
        for (let i = 0; i < waitingUsers.length; i++) {
            const position = i + 1;
            const user = waitingUsers[i];
            await sendMessage(
                botConnection,
                user.chatId,
                `Atualização: ${user.name}, sua posição atual na fila é ${position}º lugar.`
            );
        }
    } catch (error) {
        console.error('Erro ao atualizar usuários em espera:', error);
    }
}

// Add report generation endpoint
server.get('/generateReport', async (req, res) => {
    const { start, end } = req.query;
    
    try {
        const problems = await new Promise((resolve, reject) => {
            getDatabase().all(
                `SELECT * FROM problems 
                 WHERE date BETWEEN ? AND ?
                 ORDER BY date DESC`,
                [start, end],
                (err, rows) => err ? reject(err) : resolve(rows)
            );
        });

        // Calculate statistics
        const total = problems.length;
        const completedProblems = problems.filter(p => p.status === 'completed');
        
        const averageTime = completedProblems.reduce((acc, p) => {
            const start = new Date(p.date);
            const end = new Date(p.date_completed);
            return acc + (end - start);
        }, 0) / (completedProblems.length || 1);

        // Find most common problems
        const problemTypes = problems.reduce((acc, p) => {
            acc[p.description] = (acc[p.description] || 0) + 1;
            return acc;
        }, {});

        const commonProblems = Object.entries(problemTypes)
            .sort(([,a], [,b]) => b - a)
            .slice(0, 3)
            .map(([problem]) => problem);

        res.json({
            total,
            averageTime: Math.round(averageTime / (1000 * 60)), // Convert to minutes
            commonProblems,
            problems
        });
    } catch (error) {
        console.error('Erro ao gerar relatório:', error);
        res.status(500).json({ error: 'Erro ao gerar relatório' });
    }
});

// Atualizar o endpoint getChartData
server.get('/getChartData', async (req, res) => {
    try {
        const db = getDatabase();
        
        // Get weekly data (only workdays)
        const weeklyData = await new Promise((resolve, reject) => {
            const today = new Date();
            const sevenDaysAgo = new Date(today);
            sevenDaysAgo.setDate(today.getDate() - 6);
            
            db.all(
                `WITH RECURSIVE dates(date) AS (
                    SELECT date('now', '-6 days')
                    UNION ALL
                    SELECT date(date, '+1 day')
                    FROM dates
                    WHERE date < date('now')
                )
                SELECT dates.date, COALESCE(COUNT(problems.id), 0) as count
                FROM dates
                LEFT JOIN problems ON date(problems.date) = dates.date
                    AND strftime('%w', problems.date) NOT IN ('0', '6') -- Excluir sábado (6) e domingo (0)
                GROUP BY dates.date
                ORDER BY dates.date`,
                [],
                (err, rows) => {
                    if (err) {
                        console.error('Erro na query semanal:', err);
                        reject(err);
                    } else {
                        const weekDays = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
                        const labels = rows.map(row => {
                            const date = new Date(row.date);
                            return weekDays[date.getDay()];
                        });
                        const data = rows.map(row => row.count);
                        resolve({ labels, data });
                    }
                }
            );
        });

        // Get monthly data
        const monthlyData = await new Promise((resolve, reject) => {
            const currentYear = new Date().getFullYear();
            
            db.all(
                `WITH RECURSIVE months(month) AS (
                    SELECT '01' as month
                    UNION ALL
                    SELECT printf('%02d', CAST(month AS INTEGER) + 1)
                    FROM months
                    WHERE CAST(month AS INTEGER) < 12
                )
                SELECT months.month, COALESCE(COUNT(problems.id), 0) as count
                FROM months
                LEFT JOIN problems ON strftime('%m', problems.date) = months.month
                    AND strftime('%Y', problems.date) = ?
                GROUP BY months.month
                ORDER BY months.month`,
                [currentYear.toString()],
                (err, rows) => {
                    if (err) {
                        console.error('Erro na query mensal:', err);
                        reject(err);
                    } else {
                        const months = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 
                                      'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
                        const data = rows.map(row => row.count);
                        resolve({ labels: months, data });
                    }
                }
            );
        });

        console.log('Dados enviados:', { weekly: weeklyData, monthly: monthlyData }); // Debug
        res.json({ weekly: weeklyData, monthly: monthlyData });
        
    } catch (error) {
        console.error('Erro ao buscar dados dos gráficos:', error);
        res.status(500).json({ error: 'Erro ao buscar dados dos gráficos' });
    }
});

// Update the getCompletedAttendances endpoint
server.get('/getCompletedAttendances', async (req, res) => {
    try {
        const { date, position } = req.query;
        let query = `
            SELECT 
                id, 
                chatId, 
                name, 
                position, 
                city, 
                school, 
                description,
                strftime('%d/%m/%Y %H:%M', datetime(date, 'localtime')) as date,
                strftime('%d/%m/%Y %H:%M', datetime(date_completed, 'localtime')) as date_completed,
                status,
                CAST(
                    (julianday(date_completed) - julianday(date)) * 24 * 60 AS INTEGER
                ) as duration_minutes
            FROM problems 
            WHERE status = 'completed'`;
        
        const params = [];
        
        if (date) {
            query += ` AND DATE(date_completed) = DATE(?)`;
            params.push(date);
        }
        
        if (position) {
            query += ` AND position = ?`;
            params.push(position);
        }
        
        query += ` ORDER BY date_completed DESC`;

        const completedAttendances = await new Promise((resolve, reject) => {
            getDatabase().all(query, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });

        res.json(completedAttendances);
    } catch (error) {
        console.error('Erro ao buscar atendimentos concluídos:', error);
        res.status(500).json({ error: 'Erro ao buscar atendimentos concluídos' });
    }
});

// Add other necessary server routes
server.get('/getCompletedAttendances', (req, res) => {
    // ...existing code...
});

server.delete('/deleteCompletedAttendance/:id', (req, res) => {
    // ...existing code...
});

server.get('/getUserInfo/:chatId', (req, res) => {
    // ...existing code...
});

// Adicionar ao módulo exports
module.exports = {
    startHydraBot,
    redirectToWhatsAppChat,
    server
};

// Update the generateReport endpoint
server.get('/generateReport', async (req, res) => {
    try {
        const { start, end } = req.query;
        
        // Criar consulta SQL com formatação de data adequada
        const query = `
            SELECT 
                problems.*,
                strftime('%d/%m/%Y %H:%M', datetime(date, 'localtime')) as formatted_date,
                strftime('%d/%m/%Y %H:%M', datetime(date_completed, 'localtime')) as formatted_date_completed,
                CAST((julianday(date_completed) - julianday(date)) * 24 * 60 AS INTEGER) as duration_minutes
            FROM problems 
            WHERE date BETWEEN ? AND ?
            ORDER BY date DESC
        `;

        const problems = await new Promise((resolve, reject) => {
            getDatabase().all(query, [start, end], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });

        // Criar o PDF
        const doc = new PDFDocument({
            size: 'A4',
            margin: 50
        });

        // Configurar cabeçalho do response
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=relatorio-${start}-a-${end}.pdf`);

        // Pipe o PDF para o response
        doc.pipe(res);

        // Adicionar título
        doc.fontSize(20)
           .text('Relatório de Atendimentos', { align: 'center' })
           .moveDown(2);

        // Adicionar período do relatório
        doc.fontSize(12)
           .text(`Período: ${new Date(start).toLocaleDateString()} a ${new Date(end).toLocaleDateString()}`)
           .moveDown();

        // Estatísticas gerais
        const totalAtendimentos = problems.length;
        const concluidos = problems.filter(p => p.status === 'completed').length;
        const tempoMedioMinutos = Math.round(
            problems.reduce((acc, p) => acc + (p.duration_minutes || 0), 0) / concluidos
        );

        doc.fontSize(14)
           .text('Estatísticas Gerais', { underline: true })
           .moveDown()
           .fontSize(12)
           .text(`Total de Atendimentos: ${totalAtendimentos}`)
           .text(`Atendimentos Concluídos: ${concluidos}`)
           .text(`Tempo Médio de Atendimento: ${Math.floor(tempoMedioMinutos/60)}h ${tempoMedioMinutos%60}min`)
           .moveDown(2);

        // Problemas mais comuns
        const problemTypes = problems.reduce((acc, p) => {
            acc[p.description] = (acc[p.description] || 0) + 1;
            return acc;
        }, {});

        const topProblems = Object.entries(problemTypes)
            .sort(([,a], [,b]) => b - a)
            .slice(0, 5);

        doc.fontSize(14)
           .text('Problemas Mais Frequentes', { underline: true })
           .moveDown()
           .fontSize(12);

        topProblems.forEach(([problem, count], index) => {
            doc.text(`${index + 1}. ${problem} (${count} ocorrências)`);
        });
        doc.moveDown(2);

        // Lista detalhada de atendimentos
        doc.fontSize(14)
           .text('Detalhamento dos Atendimentos', { underline: true })
           .moveDown();

        problems.forEach((problem, index) => {
            const duracao = problem.duration_minutes
                ? `${Math.floor(problem.duration_minutes/60)}h ${problem.duration_minutes%60}min`
                : 'Em andamento';

            doc.fontSize(12)
               .text(`Atendimento ${index + 1}`, { underline: true })
               .text(`Usuário: ${problem.name}`)
               .text(`Cargo: ${problem.position}`)
               .text(`Escola: ${problem.school}`)
               .text(`Início: ${problem.formatted_date}`)
               .text(`Conclusão: ${problem.formatted_date_completed || 'Não concluído'}`)
               .text(`Duração: ${duracao}`)
               .text(`Problema: ${problem.description}`)
               .text(`Status: ${problem.status === 'completed' ? 'Concluído' : 'Em andamento'}`)
               .moveDown();
        });

        // Finalizar o PDF
        doc.end();

    } catch (error) {
        console.error('Erro ao gerar relatório:', error);
        res.status(500).json({ error: 'Erro ao gerar relatório' });
    }
});

// ...existing code...