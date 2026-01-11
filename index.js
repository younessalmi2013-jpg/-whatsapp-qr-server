const { webcrypto } = require('crypto');
if (!global.crypto) global.crypto = webcrypto;

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

async function createWhatsAppSession(sessionId, ws) {
  if (sessions.has(sessionId)) return sessions.get(sessionId);

  setStatus(sessionId, { phase: 'creating' });

  const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${sessionId}`);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: true,
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

  // IMPORTANT: stocker direct pour /pair même avant open
  sessions.set(sessionId, sock);

  if (!sock.authState?.creds?.registered) {
    setStatus(sessionId, { registered: false });
  } else {
    setStatus(sessionId, { registered: true });
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update;

    setStatus(sessionId, {
      connection,
      hasQr: !!qr,
    });

    logger.info({ sessionId, connection, hasQr: !!qr }, '[WA] connection.update');

    if (qr) {
      try {
        const qrDataUrl = await QRCode.toDataURL(qr);
        qrStore.set(sessionId, qrDataUrl);
        safeSend(ws, { type: 'qr', sessionId, qr: qrDataUrl });
      } catch (e) {
        logger.error({ sessionId, err: e?.message || e }, '[WA] QR build error');
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

      // si logout, on nettoie
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

// ================================
// WS server
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
        const sock = sessions.get(message.sessionId);
        if (sock) await sock.logout();
        sessions.delete(message.sessionId);
        qrStore.delete(message.sessionId);
        setStatus(message.sessionId, { loggedOut: true });
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

// Health (inclut preuve version/commit => plus jamais “déploiement fantôme”)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    sessions: sessions.size,
    node: process.version,
    commit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    service: process.env.RAILWAY_SERVICE_NAME || null,
    ts: new Date().toISOString(),
  });
});

// Version proof (debug deploy)
app.get('/version', (req, res) => {
  res.json({
    ok: true,
    node: process.version,
    envPort: process.env.PORT || null,
    railwayCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    railwayService: process.env.RAILWAY_SERVICE_NAME || null,
    ts: new Date().toISOString(),
  });
});

// Debug status
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

// Pairing code (wait open + retry)
app.post('/pair/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const phone = (req.body?.phone || '').replace(/\D/g, '');
  if (!phone) return res.status(400).json({ ok: false, error: 'Missing phone in body' });

  try {
    const code = await retry(async (attempt) => {
      logger.info({ attempt, sessionId }, '[PAIR] attempt');

      // recreate on retry
      if (attempt > 1) {
        try {
          const old = sessions.get(sessionId);
          if (old) old.end?.();
        } catch (_) {}
        sessions.delete(sessionId);
        qrStore.delete(sessionId);
        setStatus(sessionId, { phase: 'retry_recreate' });
      }

      const sock = await createWhatsAppSession(sessionId, null);

      // wait open
      await waitForConnectionOpen(sock, 25000);

      const pairingCode = await sock.requestPairingCode(phone);
      setStatus(sessionId, { phase: 'pairing_code_issued' });
      return pairingCode;
    }, 3, 2000);

    res.json({ ok: true, sessionId, pairingCode: code });
  } catch (e) {
    setStatus(sessionId, { phase: 'pairing_failed', lastError: e.message });
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Session status
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
});

