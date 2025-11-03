const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const helmet = require('helmet');

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

// Silence fatal error handlers (no stdout/stderr leakage)
process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});

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

app.get('/v1/sessions/resolve', rateLimitResolveMiddleware, (req, res) => {
  const pin = (req.query.pin || '').toString();
  if (!/^\d{6}$/.test(pin)) {
    return error(res, 404, 'pin_not_found');
  }
  const map = pinToSession.get(pin);
  if (!map) {
    return error(res, 404, 'pin_not_found');
  }
  const sess = sessions.get(map.sessionId);
  pinToSession.delete(pin);
  if (!sess) {
    return error(res, 410, 'pin_expired');
  }
  if (sessionExpired(sess)) {
    return error(res, 410, 'pin_expired');
  }
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
  }
  res.status(200).json({ envelope: sess.answerEnvelope });
});

app.delete('/v1/sessions/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  if (!isUuidV4(sessionId)) return error(res, 404, 'session_not_found');
  
  // DELETE is idempotent - clean up any associated data regardless of whether session exists
  for (const [pin, info] of pinToSession) {
    if (info.sessionId === sessionId) {
      pinToSession.delete(pin);
      break;
    }
  }
  sessions.delete(sessionId);
  res.status(204).end();
});

app.use((req, res) => {
  res.status(404).json({ error: 'not_found' });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT);
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
