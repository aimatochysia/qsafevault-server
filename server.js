const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const helmet = require('helmet');
const cors = require('cors');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.set('trust proxy', process.env.TRUST_PROXY === '1');
app.set('etag', false);
app.set('query parser', 'simple');
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  hsts: process.env.ENABLE_HSTS === '1' ? undefined : false,
  referrerPolicy: { policy: 'no-referrer' }
}));
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
});

const LOGGING_ENABLED = true;

const LOG_RING_SIZE = Number(process.env.LOG_RING_SIZE || 500);
let __logSeq = 1;
const __logs = [];
const __origConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
  debug: console.debug
};
function __fmt(v) {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}
function __pushLog(level, args) {
  const msg = args.map(__fmt).join(' ');
  const item = { seq: __logSeq++, ts: new Date().toISOString(), level, msg };
  __logs.push(item);
  if (__logs.length > LOG_RING_SIZE) __logs.shift();
}
['log', 'info', 'warn', 'error', 'debug'].forEach(level => {
  console[level] = (...args) => {
    try { __pushLog(level, args); } catch {}
    try { __origConsole[level](...args); } catch {}
  };
});

process.on('uncaughtException', () => console.error('fatal_error'));
process.on('unhandledRejection', () => console.error('fatal_error'));

const SESS_TTL_SEC = 180;
const CLEANUP_INTERVAL_MS = 5000;
const RESOLVE_RATE_CAPACITY = 30;
const RESOLVE_RATE_REFILL_PER_SEC = 0.5;
const MAX_ENVELOPE_CT_LEN = 64 * 1024;

const sessions = new Map();
const pinToSession = new Map();
const resolveRate = new Map();

const now = () => new Date();
const ttlSecFrom = (expiresAt) => Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
const iso = (d) => d.toISOString();

function generatePin() {
  const n = crypto.randomInt(0, 1000000);
  return String(n).padStart(6, '0');
}

function generateUniquePin() {
  for (let i = 0; i < 10; i++) {
    const p = generatePin();
    if (!pinToSession.has(p)) return p;
  }
  throw new Error('pin_pool_exhausted');
}

function newSession() {
  const id = uuidv4();
  const salt = crypto.randomBytes(16);
  const createdAt = now();
  const expiresAt = new Date(createdAt.getTime() + SESS_TTL_SEC * 1000);
  const sess = {
    id,
    saltB64: salt.toString('base64'),
    createdAt,
    expiresAt,
    offerEnvelope: null,
    answerEnvelope: null,
    answerDelivered: false,
    pin: generateUniquePin()
  };
  sessions.set(id, sess);
  pinToSession.set(sess.pin, { sessionId: id, expiresAt: sess.expiresAt });
  return sess;
}

function sessionExpired(sess) {
  return sess.expiresAt.getTime() <= Date.now();
}

function error(res, status, code) {
  res.status(status).json({ error: code });
}

function isValidBase64(s) {
  if (typeof s !== 'string') return false;
  const noNewlines = s.replace(/\s+/g, '');
  if (noNewlines.length === 0 || noNewlines.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(noNewlines)) return false;
  return true;
}
function strictB64ToBuf(s) {
  if (!isValidBase64(s)) return null;
  try {
    return Buffer.from(s, 'base64');
  } catch {
    return null;
  }
}

function validateEnvelope(envelope, expectedSessionId) {
  if (!envelope || typeof envelope !== 'object') return 'invalid_envelope';
  const { v, sessionId, nonceB64, ctB64 } = envelope;
  if (v !== 1) return 'invalid_envelope';
  if (typeof sessionId !== 'string' || sessionId !== expectedSessionId) return 'invalid_envelope';
  if (typeof nonceB64 !== 'string' || typeof ctB64 !== 'string') return 'invalid_envelope';
  if (nonceB64.length !== 16) return 'invalid_envelope';
  const nonce = strictB64ToBuf(nonceB64);
  const ct = strictB64ToBuf(ctB64);
  if (!nonce || nonce.length !== 12) return 'invalid_envelope';
  if (!ct || ct.length < 16 || ct.length > MAX_ENVELOPE_CT_LEN) return 'invalid_envelope';
  return null;
}

function getClientIp(req) {
  const trustProxy = req.app.get('trust proxy');
  return trustProxy ? (req.ip || req.socket.remoteAddress || 'unknown') : (req.socket.remoteAddress || 'unknown');
}

if (LOGGING_ENABLED) {
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    const ip = getClientIp(req);
    console.log(`[req] ${req.method} ${req.originalUrl} ip=${ip}`);
    res.on('finish', () => {
      const durMs = Number(process.hrtime.bigint() - start) / 1e6;
      console.log(`[res] ${req.method} ${req.originalUrl} -> ${res.statusCode} ${durMs.toFixed(1)}ms`);
    });
    next();
  });
}

function rateLimitResolveMiddleware(req, res, next) {
  const ip = getClientIp(req);
  const nowMs = Date.now();
  let entry = resolveRate.get(ip);
  if (!entry) {
    entry = { tokens: RESOLVE_RATE_CAPACITY, last: nowMs };
    resolveRate.set(ip, entry);
  }
  const elapsedSec = (nowMs - entry.last) / 1000;
  entry.tokens = Math.min(RESOLVE_RATE_CAPACITY, entry.tokens + elapsedSec * RESOLVE_RATE_REFILL_PER_SEC);
  entry.last = nowMs;

  if (entry.tokens < 1) {
    if (LOGGING_ENABLED) console.log(`[rate-limit] resolve ip=${ip}`);
    return error(res, 429, 'rate_limited');
  }
  entry.tokens -= 1;
  next();
}

const CLEANER = setInterval(() => {
  const t = Date.now();
  for (const [pin, info] of pinToSession) {
    const s = sessions.get(info.sessionId);
    if (info.expiresAt.getTime() <= t || !s || s.expiresAt.getTime() <= t) {
      pinToSession.delete(pin);
    }
  }
  for (const [id, sess] of sessions) {
    if (sess.expiresAt.getTime() <= t) {
      sessions.delete(id);
    }
  }
  for (const [ip, entry] of resolveRate) {
    if (t - entry.last > 10 * 60 * 1000) {
      resolveRate.delete(ip);
    }
  }
}, CLEANUP_INTERVAL_MS);

app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') return error(res, 413, 'payload_too_large');
  if (err instanceof SyntaxError) return error(res, 400, 'bad_json');
  next();
});

app.post('/v1/sessions', (req, res) => {
  try {
    const sess = newSession();
    const pinOut = sess.pin;
    sess.pin = undefined;
    if (LOGGING_ENABLED) console.log(`[session] created id=${sess.id} pin=${pinOut}`);
    res.status(200).json({
      sessionId: sess.id,
      pin: pinOut,
      saltB64: sess.saltB64,
      ttlSec: SESS_TTL_SEC,
      createdAt: iso(sess.createdAt),
      expiresAt: iso(sess.expiresAt)
    });
  } catch {
    error(res, 500, 'internal_error');
  }
});

app.get('/v1/logs', (req, res) => {
  const after = Number.parseInt((req.query.after || '0').toString(), 10) || 0;
  const limit = Math.min(
    Math.max(1, Number.parseInt((req.query.limit || '200').toString(), 10) || 200),
    500
  );
  const items = __logs.filter(x => x.seq > after);
  const slice = items.length > limit ? items.slice(items.length - limit) : items;
  const lastSeq = __logs.length ? __logs[__logs.length - 1].seq : after;
  res.status(200).json({ items: slice, nextSeq: lastSeq + 1 });
});

app.get('/logs', (req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Server Logs</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html,body { height:100%; margin:0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background:#0b0e14; color:#e6e1cf; }
  #bar { position:sticky; top:0; background:#11151c; padding:8px; display:flex; gap:8px; align-items:center; border-bottom:1px solid #232936; }
  #logs { white-space:pre-wrap; padding:8px; overflow:auto; height:calc(100% - 44px); }
  .lvl-log { color:#a0c3ff; }
  .lvl-info { color:#8bd5ff; }
  .lvl-warn { color:#ffd580; }
  .lvl-error { color:#ff9e9e; }
  .lvl-debug { color:#b5bfe2; }
  .ts { color:#6b7280; }
  button, input { background:#1b2230; color:#e6e1cf; border:1px solid #2a3242; padding:4px 8px; border-radius:4px; }
  input[type="number"] { width:72px; }
</style>
</head>
<body>
  <div id="bar">
    <button id="clearBtn">Clear</button>
    <label><input type="checkbox" id="autoscroll" checked> Auto-scroll</label>
    <span>Poll(ms): <input type="number" id="interval" value="1000" min="250" step="250"></span>
    <span>Limit: <input type="number" id="limit" value="200" min="10" max="500" step="10"></span>
  </div>
  <div id="logs"></div>
<script>
  const logsEl = document.getElementById('logs');
  const clearBtn = document.getElementById('clearBtn');
  const autoscrollEl = document.getElementById('autoscroll');
  const intervalEl = document.getElementById('interval');
  const limitEl = document.getElementById('limit');
  let after = 0;
  let timer = null;

  function renderItem(it) {
    const div = document.createElement('div');
    div.className = 'lvl-' + (it.level || 'log');
    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = '[' + it.ts + '] ';
    const msg = document.createElement('span');
    msg.textContent = it.msg;
    div.appendChild(ts);
    div.appendChild(msg);
    return div;
  }

  async function tick() {
    try {
      const limit = Math.max(10, Math.min(500, parseInt(limitEl.value || '200', 10)));
      const res = await fetch('/v1/logs?after=' + after + '&limit=' + limit, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (Array.isArray(data.items) && data.items.length) {
        const shouldScroll = autoscrollEl.checked && (logsEl.scrollTop + logsEl.clientHeight >= logsEl.scrollHeight - 5);
        const frag = document.createDocumentFragment();
        for (const it of data.items) frag.appendChild(renderItem(it));
        logsEl.appendChild(frag);
        if (shouldScroll) logsEl.scrollTop = logsEl.scrollHeight;
      }
      if (typeof data.nextSeq === 'number') after = data.nextSeq - 1;
    } catch (e) {
      // best-effort; ignore
    } finally {
      const ms = Math.max(250, parseInt(intervalEl.value || '1000', 10));
      timer = setTimeout(tick, ms);
    }
  }

  clearBtn.addEventListener('click', () => { logsEl.textContent = ''; });
  intervalEl.addEventListener('change', () => { if (timer) { clearTimeout(timer); timer = null; } tick(); });

  tick();
</script>
</body>
</html>`);
});

app.get('/v1/sessions/resolve', rateLimitResolveMiddleware, (req, res) => {
  const pin = (req.query.pin || '').toString();
  if (!/^\d{6}$/.test(pin)) {
    if (LOGGING_ENABLED) console.log(`[resolve] invalid_pin pin=${pin}`);
    return error(res, 404, 'pin_not_found');
  }
  const map = pinToSession.get(pin);
  if (!map) {
    if (LOGGING_ENABLED) console.log(`[resolve] not_found pin=${pin}`);
    return error(res, 404, 'pin_not_found');
  }
  const sess = sessions.get(map.sessionId);
  pinToSession.delete(pin);
  if (!sess) {
    if (LOGGING_ENABLED) console.log(`[resolve] gone pin=${pin}`);
    return error(res, 410, 'pin_expired');
  }
  if (sessionExpired(sess)) {
    if (LOGGING_ENABLED) console.log(`[resolve] expired pin=${pin}`);
    return error(res, 410, 'pin_expired');
  }
  if (LOGGING_ENABLED) console.log(`[resolve] ok pin=${pin} sessionId=${sess.id}`);
  res.status(200).json({
    sessionId: sess.id,
    saltB64: sess.saltB64,
    ttlSec: ttlSecFrom(sess.expiresAt)
  });
});

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isUuidV4(s) { return UUID_V4_RE.test(s); }

function getAliveSessionOrError(req, res) {
  const { sessionId } = req.params;
  if (!isUuidV4(sessionId)) {
    error(res, 404, 'session_not_found');
    return null;
  }
  const sess = sessions.get(sessionId);
  if (!sess) {
    error(res, 404, 'session_not_found');
    return null;
  }
  if (sessionExpired(sess)) {
    error(res, 410, 'session_expired');
    return null;
  }
  return sess;
}

app.post('/v1/sessions/:sessionId/offer', (req, res) => {
  const sess = getAliveSessionOrError(req, res);
  if (!sess) return;
  if (!req.is('application/json') || !req.body || typeof req.body !== 'object') return error(res, 400, 'invalid_envelope');
  const { envelope } = req.body;
  const errCode = validateEnvelope(envelope, sess.id);
  if (errCode) return error(res, 400, errCode);
  if (sess.offerEnvelope) return error(res, 409, 'offer_already_set');
  sess.offerEnvelope = envelope;
  if (LOGGING_ENABLED) console.log(`[offer] set sessionId=${sess.id}`);
  res.status(200).json({});
});

app.post('/v1/sessions/:sessionId/answer', (req, res) => {
  const sess = getAliveSessionOrError(req, res);
  if (!sess) return;
  if (!req.is('application/json') || !req.body || typeof req.body !== 'object') {
    return error(res, 400, 'invalid_envelope');
  }
  const { envelope } = req.body;
  const errCode = validateEnvelope(envelope, sess.id);
  if (errCode) return error(res, 400, errCode);
  if (!sess.offerEnvelope) return error(res, 409, 'offer_not_set');
  if (sess.answerEnvelope) return error(res, 409, 'answer_already_set');

  sess.answerEnvelope = envelope;
  if (LOGGING_ENABLED) console.log(`[answer] set sessionId=${sess.id}`);
  res.status(200).json({});
});

app.get('/v1/sessions/:sessionId/offer', (req, res) => {
  const sess = getAliveSessionOrError(req, res);
  if (!sess) return;
  if (!sess.offerEnvelope) return res.status(404).json({ error: 'offer_not_set' });
  res.status(200).json({ envelope: sess.offerEnvelope });
});

app.get('/v1/sessions/:sessionId/answer', (req, res) => {
  const sess = getAliveSessionOrError(req, res);
  if (!sess) return;
  if (!sess.answerEnvelope) return error(res, 404, 'answer_not_set');

  if (!sess.answerDelivered) {
    sess.answerDelivered = true;
    sess.expiresAt = new Date(Date.now() - 1);
    if (LOGGING_ENABLED) console.log(`[answer] delivered sessionId=${sess.id}`);
  }
  res.status(200).json({ envelope: sess.answerEnvelope });
});

app.delete('/v1/sessions/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const sess = sessions.get(sessionId);
  if (!sess) return res.status(404).json({ error: 'session_not_found' });

  for (const [pin, info] of pinToSession) {
    if (info.sessionId === sessionId) {
      pinToSession.delete(pin);
      break;
    }
  }
  sessions.delete(sessionId);
  if (LOGGING_ENABLED) console.log(`[session] deleted id=${sessionId}`);
  res.status(204).end();
});

app.use((req, res) => {
  res.status(404).json({ error: 'not_found' });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  if (LOGGING_ENABLED) {
    console.log(`[startup] listening on port=${PORT} env=${process.env.NODE_ENV || 'N/A'} logging=on trustProxy=${app.get('trust proxy')} cors=${process.env.ENABLE_CORS === '1' ? 'on' : 'off'}`);
  }
});
server.headersTimeout = 10000;
server.requestTimeout = 10000;
server.keepAliveTimeout = 5000;
if (server.maxRequestsPerSocket !== undefined) server.maxRequestsPerSocket = 100;

function shutdown() {
  server.close(() => {
    clearInterval(CLEANER);
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
