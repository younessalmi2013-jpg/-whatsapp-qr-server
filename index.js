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

// ====== PERSISTENT SESSION DIR (Render Disk) ======
const SESSION_DIR = process.env.SESSION_DIR || path.join(process.cwd(), 'sessions');
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
    if (ws && ws.readyState === WS.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  } catch (_) {}
}

// ================================
// Helpers: wait open + retry (PROD)
// ================================
function waitForConnectionOpen(sock, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { sock.ev.off('connection.update', onUpdate); } catch {}
      reject(new Error('Timeout waiting for connection open'));
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

async function retry(fn, tries = 3, delayMs = 1500) {
  let lastError;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn(i + 1);
    } catch (e) {
      lastError = e;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

// ================================
// Session lifecycle
// ================================
async function createWhatsAppSession(sessionId, ws) {
  if (sessions.has(sessionId)) return sessions.get(sessionId);

  setStatus(sessionId, { phase: 'creating' });

  const sessionPath = path.join(SESSION_DIR, sessionId);
  fs.mkdirSync(sessionPath, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
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

  // store immediately so /pair works
  sessions.set(sessionId, sock);

  setStatus(sessionId, {
    registered: !!sock.authState?.creds?.registered,
    phase: 'created',
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update;

    setStatus(sessionId, {
      connection,
      hasQr: !!qr,
    });

    if (qr) {
      try {
        const qrDataUrl = await QRCode.toDataURL(qr);
        qrStore.set(sessionId, qrDataUrl);
        safeSend(ws, { type: 'qr', sessionId, qr: qrDataUrl });
      } catch (e) {
        setStatus(sessionId, { lastError: `QR build error: ${e?.message || e}` });
      }
    }

    if (connection === 'open') {
      setStatus(sessionId, { connected: true, phase: 'open' });
      safeSend(ws, { type: 'ready', sessionId });
    }

    if (connection === 'close') {
      const err = lastDisconnect?.error;
      const msg = err?.message || 'unknown';

      setStatus(sessionId, { connected: false, phase: 'closed', lastError: msg });

      // If logged out: cleanup memory (disk remains unless you /reset)
      const code = err?.output?.statusCode;
      const reason = err?.output?.payload?.message;
      if (reason === DisconnectReason.loggedOut || code === DisconnectReason.loggedOut) {
        sessions.delete(sessionId);
        qrStore.delete(sessionId);
        setStatus(sessionId, { loggedOut: true });
      }
    }
  });

  return sock;
}

async function destroySession(sessionId) {
  try {
    const sock = sessions.get(sessionId);
    if (sock) {
      try { await sock.logout(); } catch {}
      try { sock.end?.(); } catch {}
    }
  } catch {}
  sessions.delete(sessionId);
  qrStore.delete(sessionId);
  statusStore.delete(sessionId);

  // delete files on disk
  const sessionPath = path.join(SESSION_DIR, sessionId);
  try {
    fs.rmSync(sessionPath, { recursive: true, force: true });
  } catch {}
}

// ================================
// WS
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
        await destroySession(message.sessionId);
        ws.send(JSON.stringify({ ok: true, type: 'logged_out', sessionId: message.sessionId }));
        return;
      }

      ws.send(JSON.stringify({ ok: false, type: 'error', message: 'Unknown message type' }));
    } catch (error) {
      ws.send(JSON.stringify({ ok: false, type: 'error', message: error.message }));
    }
  });
});

// ================================
// HTTP endpoints
// ================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', sessions: sessions.size, sessionDir: SESSION_DIR });
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

// Create session
app.post('/session/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  try {
    await createWhatsAppSession(sessionId, null);
    res.json({ ok: true, sessionId });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Reset session (PROPRE) — supprime la session + fichiers
app.post('/reset/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  await destroySession(sessionId);
  res.json({ ok: true, sessionId, reset: true });
});

// QR PNG
app.get('/qr/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const qr = qrStore.get(sessionId);

  if (!qr) {
    return res.status(404).send('QR not ready. Trigger session first.');
  }

  const base64 = qr.split(',')[1];
  const img = Buffer.from(base64, 'base64');
  res.setHeader('Content-Type', 'image/png');
  res.send(img);
});

// Pairing code
app.post('/pair/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const phone = (req.body?.phone || '').replace(/\D/g, '');
  if (!phone) return res.status(400).json({ ok: false, error: 'Missing phone in body' });

  try {
    const pairingCode = await retry(async (attempt) => {
      setStatus(sessionId, { phase: `pair_attempt_${attempt}` });

      // on retry: recrée socket propre
      if (attempt > 1) {
        try {
          const old = sessions.get(sessionId);
          if (old) old.end?.();
        } catch {}
        sessions.delete(sessionId);
        qrStore.delete(sessionId);
      }

      const sock = await createWhatsAppSession(sessionId, null);
      await waitForConnectionOpen(sock, 25000);

      const code = await sock.requestPairingCode(phone);
      setStatus(sessionId, { phase: 'pairing_code_issued' });
      return code;
    }, 3, 2000);

    res.json({ ok: true, sessionId, pairingCode });
  } catch (e) {
    setStatus(sessionId, { phase: 'pairing_failed', lastError: e.message });
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/session/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const s = statusStore.get(sessionId) || {};
  res.json({
    sessionId,
    connected: !!s.connected,
    connection: s.connection || null,
    hasQr: !!s.hasQr,
    registered: s.registered ?? null,
    phase: s.phase || null,
    lastError: s.lastError || null,
    updatedAt: s.updatedAt || null,
  });
});

const PORT = Number(process.env.PORT) || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`SESSION_DIR=${SESSION_DIR}`);
});