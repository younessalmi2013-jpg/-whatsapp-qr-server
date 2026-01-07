const { webcrypto } = require('crypto');
global.crypto = webcrypto;
const express = require('express');
const http = require('http');
const cors = require('cors');
const pino = require('pino');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');
const { makeWASocket, useMultiFileAuthState } = require('baileys');


const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Stockage des sessions actives
const sessions = new Map();
const qrStore = new Map(); // sessionId => QR base64

// Safe WS sender (évite crash si ws = null)
function safeSend(ws, payload) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}


async function createWhatsAppSession(sessionId, ws) {
  const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${sessionId}`);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'debug' }),
  });

  // Sauvegarde creds
  sock.ev.on('creds.update', saveCreds);

  // QR / ready / close
sock.ev.on('connection.update', async (update) => {
  const { connection, qr, lastDisconnect } = update;

  if (qr) {
    const qrDataUrl = await QRCode.toDataURL(qr);

    // stocke le QR pour affichage HTTP
    qrStore.set(sessionId, qrDataUrl);

    // envoie au client WS (si ws existe)
    safeSend(ws, { type: 'qr', sessionId, qr: qrDataUrl });
  }

  if (connection === 'open') {
    sessions.set(sessionId, sock);
    safeSend(ws, { type: 'ready', sessionId });
  }

  if (connection === 'close') {
    sessions.delete(sessionId);
    safeSend(ws, {
      type: 'closed',
      sessionId,
      reason: lastDisconnect?.error?.message || 'unknown',
    });
  }
});


  return sock;
}

  
// WebSocket server
wss.on('connection', (ws) => {
  ws.on('message', async (data) => {
    try {
      const raw = data.toString().trim();
      if (!raw) return; // ignore empty lines from wscat

      const message = JSON.parse(raw);

      switch (message.type) {
        case 'create': {
          await createWhatsAppSession(message.sessionId, ws);
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
        default: {
          ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
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
// --- QR HTTP endpoint ---
app.get('/qr/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const qr = qrStore.get(sessionId);

  if (!qr) {
    return res.status(404).send('QR not ready. Trigger session first.');
  }

  // qr = "data:image/png;base64,...."
  const base64 = qr.split(',')[1];
  const img = Buffer.from(base64, 'base64');

  res.setHeader('Content-Type', 'image/png');
  res.send(img);
});
// --- Create session via HTTP (Lovable) ---
app.post('/session/:sessionId', async (req, res) => {
  const { sessionId } = req.params;

  try {
    if (!sessions.has(sessionId)) {
      await createWhatsAppSession(sessionId, null);
    }
    res.json({ ok: true, sessionId });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
// --- Session status ---
app.get('/session/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const connected = sessions.has(sessionId);
  res.json({ sessionId, connected });
});

const PORT = Number(process.env.PORT) || 8080;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

