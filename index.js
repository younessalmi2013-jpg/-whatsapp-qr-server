const { webcrypto } = require('crypto');
if (!global.crypto) global.crypto = webcrypto;

const fs = require('fs');
const path = require('path');

const express = require('express');
const http = require('http');
const cors = require('cors');
const pino = require('pino');
const QRCode = require('qrcode');

const WS = require('ws');
const { WebSocketServer } = WS;

const {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
} = require('baileys');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/**
 * PERSISTENCE DIR
 * Render disk: /data  (tu as déjà /data/sessions OK)
 */
const SESSION_DIR = process.env.SESSION_DIR || path.join(__dirname, 'sessions');
fs.mkdirSync(SESSION_DIR, { recursive: true });

// sessionId => sock
const sessions = new Map();
// sessionId => dataURL QR
const qrStore = new Map();
// sessionId => debug/status
const statusStore = new Map();

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

function setStatus(sessionId, patch) {
  const prev = statusStore.get(sessionId) || {};
  statusStore.set(sessionId, {
    ...prev,
    ...patch,
    updatedAt: new Date().toISOString(),
  });
}

function safeSend(ws, payload) {
  try {
    if (ws && ws.readyState === WS.OPEN) ws.send(JSON.stringify(payload));
  } catch (_) {}
}

function sessionPath(sessionId) {
  return path.join(SESSION_DIR, sessionId);
}

function rmrfSafe(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch (_) {}
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ================================
// WAIT OPEN (avoid "open before listener")
// ================================
function waitForConnectionOpen(sessionId, sock, timeoutMs = 90000) {
  const s = statusStore.get(sessionId);
  if (s?.connection === 'open' || s?.connected === true) return Promise.resolve(true);

  return new Promise((resolve, reject) => {
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { sock.ev.off('connection.update', onUpdate); } catch {}
      reject(new Error(`Timeout waiting for connection open (${timeoutMs}ms)`));
    }, timeoutMs);

    const onUpdate = (update) => {
      const c = update?.connection;

      if (c === 'open') {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { sock.ev.off('connection.update', onUpdate); } catch {}
        resolve(true);
      }

      if (c === 'close') {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { sock.ev.off('connection.update', onUpdate); } catch {}
        reject(new Error('Connection closed before open'));
      }
    };

    sock.ev.on('connection.update', onUpdate);
  });
}

async function retry(fn, tries = 3, delayMs = 2500) {
  let lastError;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn(i + 1);
    } catch (e) {
      lastError = e;
      await delay(delayMs);
    }
  }
  throw lastError;
}

function destroySocket(sessionId) {
  try {
    const sock = sessions.get(sessionId);
    if (sock) {
      // best-effort close
      sock.end?.();
      sock.ws?.close?.();
    }
  } catch (_) {}
  sessions.delete(sessionId);
  qrStore.delete(sessionId);
}

async function hardResetSession(sessionId) {
  destroySocket(sessionId);
  rmrfSafe(sessionPath(sessionId)); // delete creds
  setStatus(sessionId, { phase: 'reset', registered: false, hasQr: false, connected: false });
}

// ================================
// CREATE SESSION
// ================================
async function createWhatsAppSession(sessionId, ws) {
  if (sessions.has(sessionId)) return sessions.get(sessionId);

  setStatus(sessionId, { phase: 'creating' });

  const authDir = sessionPath(sessionId);
  fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false, // on gère nous-mêmes via connection.update
    browser: ['Chrome', 'Linux', '1.0'],
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 20_000,
    defaultQueryTimeoutMs: 60_000,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  });

  sessions.set(sessionId, sock);

  setStatus(sessionId, {
    phase: 'created',
    registered: !!sock.authState?.creds?.registered,
    hasQr: false,
    connected: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update;

    setStatus(sessionId, { connection });

    if (qr) {
      try {
        const qrDataUrl = await QRCode.toDataURL(qr);
        qrStore.set(sessionId, qrDataUrl);
        setStatus(sessionId, { hasQr: true, phase: 'qr_ready' });
        safeSend(ws, { type: 'qr', sessionId, qr: qrDataUrl });
      } catch (e) {
        setStatus(sessionId, { phase: 'qr_error', lastError: e?.message || String(e) });
      }
    }

    if (connection === 'open') {
      setStatus(sessionId, { connected: true, phase: 'open', hasQr: false });
      safeSend(ws, { type: 'ready', sessionId });
    }

    if (connection === 'close') {
      const err = lastDisconnect?.error;
      const msg = err?.message || 'unknown';
      setStatus(sessionId, { connected: false, phase: 'closed', lastError: msg, hasQr: false });

      // 1) logout => reset in-memory
      const code = err?.output?.statusCode;
      const reason = err?.output?.payload?.message;

      if (reason === DisconnectReason.loggedOut || code === DisconnectReason.loggedOut) {
        destroySocket(sessionId);
        return;
      }

      // 2) IMPORTANT: AUTO-HEAL on "QR refs attempts ended"
      // C'est EXACTEMENT ton problème.
      if ((msg || '').toLowerCase().includes('qr refs attempts ended')) {
        // on recrée automatiquement un nouveau socket propre
        destroySocket(sessionId);
        setStatus(sessionId, { phase: 'auto_recreate_after_qr_end' });
        await delay(1500);
        await createWhatsAppSession(sessionId, ws);
        return;
      }

      // 3) other failures: keep sock map cleaned
      // (on laisse la session existante si tu veux, mais c'est plus safe de recréer au prochain /session)
      destroySocket(sessionId);
    }
  });

  return sock;
}

// ================================
// WS SERVER (optional)
// ================================
wss.on('connection', (ws) => {
  ws.on('message', async (data) => {
    try {
      const raw = data.toString().trim();
      if (!raw) return;
      const message = JSON.parse(raw);

      if (message.type === 'create') {
        await createWhatsAppSession(message.sessionId, ws);
        ws.send(JSON.stringify({ ok: true, type: 'created', sessionId: message.sessionId }));
        return;
      }

      if (message.type === 'logout') {
        await hardResetSession(message.sessionId);
        ws.send(JSON.stringify({ ok: true, type: 'logged_out', sessionId: message.sessionId }));
        return;
      }

      ws.send(JSON.stringify({ ok: false, type: 'error', message: 'Unknown message type' }));
    } catch (e) {
      ws.send(JSON.stringify({ ok: false, type: 'error', message: e.message }));
    }
  });
});

// ================================
// HTTP ENDPOINTS
// ================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', sessions: sessions.size });
});

app.get('/version', (req, res) => {
  res.json({
    ok: true,
    node: process.version,
    sessionDir: SESSION_DIR,
    ts: new Date().toISOString(),
  });
});

app.get('/debug/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  res.json({
    sessionId,
    hasSock: sessions.has(sessionId),
    hasQr: qrStore.has(sessionId),
    sessionsSize: sessions.size,
    qrStoreSize: qrStore.size,
    status: statusStore.get(sessionId) || null,
  });
});

// Reset HARD (delete creds on disk)
app.post('/reset/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  await hardResetSession(sessionId);
  res.json({ ok: true, sessionId, reset: true });
});

// Create session (start WA)
app.post('/session/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  try {
    await createWhatsAppSession(sessionId, null);
    res.json({ ok: true, sessionId });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// QR PNG
app.get('/qr/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const qr = qrStore.get(sessionId);

  if (!qr) return res.status(404).send('QR not ready. Trigger session first.');

  const base64 = qr.split(',')[1];
  const img = Buffer.from(base64, 'base64');
  res.setHeader('Content-Type', 'image/png');
  res.send(img);
});

// Pairing code (more stable than QR in datacenter)
// POST /pair/test1  { "phone":"336XXXXXXXX" }
app.post('/pair/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const phone = (req.body?.phone || '').replace(/\D/g, '');
  if (!phone) return res.status(400).json({ ok: false, error: 'Missing phone in body' });

  try {
    const pairingCode = await retry(async (attempt) => {
      setStatus(sessionId, { phase: `pair_attempt_${attempt}` });

      // recreate each attempt (avoid dead socket)
      destroySocket(sessionId);

      const sock = await createWhatsAppSession(sessionId, null);

      // wait open (Render can be slow)
      await waitForConnectionOpen(sessionId, sock, 90000);

      const code = await sock.requestPairingCode(phone);
      setStatus(sessionId, { phase: 'pairing_code_issued' });

      return code;
    }, 3, 3000);

    res.json({ ok: true, sessionId, pairingCode });
  } catch (e) {
    setStatus(sessionId, { phase: 'pairing_failed', lastError: e.message });
    res.status(500).json({ ok: false, error: e.message });
  }
});

const PORT = Number(process.env.PORT) || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
