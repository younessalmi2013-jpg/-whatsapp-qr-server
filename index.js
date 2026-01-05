const express = require('express');
const { WebSocketServer } = require('ws');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const http = require('http');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Stockage des sessions actives
const sessions = new Map();

// Créer une session WhatsApp
async function createWhatsAppSession(sessionId, ws) {
  const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${sessionId}`);
  
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const qrDataUrl = await QRCode.toDataURL(qr);
      ws.send(JSON.stringify({
        type: 'qr',
        data: qrDataUrl,
        sessionId
      }));
    }

    if (connection === 'open') {
      ws.send(JSON.stringify({
        type: 'connected',
        sessionId,
        phone: sock.user?.id?.split(':')[0]
      }));
      sessions.set(sessionId, sock);
    }

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect) {
        createWhatsAppSession(sessionId, ws);
      } else {
        ws.send(JSON.stringify({ type: 'disconnected', sessionId }));
        sessions.delete(sessionId);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.key.fromMe && msg.message) {
        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          '';

        ws.send(JSON.stringify({
          type: 'message',
          sessionId,
          from: msg.key.remoteJid,
          text,
          timestamp: msg.messageTimestamp
        }));
      }
    }
  });

  return sock;
}

// WebSocket connection
wss.on('connection', (ws) => {
  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data);

      switch (message.type) {
        case 'init': {
          const sessionId = message.sessionId || `session_${Date.now()}`;
          await createWhatsAppSession(sessionId, ws);
          break;
        }

        case 'send': {
          const session = sessions.get(message.sessionId);
          if (session) {
            await session.sendMessage(message.to, { text: message.text });
            ws.send(JSON.stringify({ type: 'sent', success: true }));
          }
          break;
        }

        case 'logout': {
          const sock = sessions.get(message.sessionId);
          if (sock) {
            await sock.logout();
            sessions.delete(message.sessionId);
          }
          break;
        }
      }
    } catch (error) {
      ws.send(JSON.stringify({ type: 'error', message: error.message }));
    }
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', sessions: sessions.size });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
CTRL + O


