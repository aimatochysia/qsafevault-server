const crypto = require('crypto');

const byId = new Map();
const byPinHash = new Map();

const HMAC_KEY = process.env.QSV_HMAC_SECRET
  ? Buffer.from(process.env.QSV_HMAC_SECRET, 'utf8')
  : crypto.randomBytes(32);

function _pinHash(pin) {
  return crypto.createHmac('sha256', HMAC_KEY).update(pin, 'utf8').digest('hex');
}

function _now() { return Date.now(); }

function _genPin() {
  for (let i = 0; i < 5; i++) {
    const n = (Math.floor(Math.random() * 900000) + 100000).toString();
    if (!byPinHash.has(n)) return n;
  }
  return (Math.floor(Math.random() * 900000) + 100000).toString();
}

function createSession(id, saltB64, ttlSec) {
  const pin = _genPin();
  const now = _now();
  const createdAt = new Date(now).toISOString();
  const expiresAtMs = now + ttlSec * 1000;
  const expiresAt = new Date(expiresAtMs).toISOString();
  const session = {
    id,
    pinHash: _pinHash(pin),
    saltB64,
    createdAt,
    expiresAt,
    expiresAtMs,
    offerEnvelope: null,
    answerEnvelope: null,
    resolvedAt: null,
  };
  byId.set(id, session);
  byPinHash.set(session.pinHash, id);
  return { session, pin };
}

function _getById(id) {
  const s = byId.get(id);
  if (!s) return null;
  return s;
}

function _expired(s) {
  return _now() >= (s.expiresAtMs || 0);
}

function ttlRemainingSec(s) {
  const rem = Math.max(0, Math.floor((s.expiresAtMs - _now()) / 1000));
  return rem;
}

function getSessionByPin(pin) {
  const h = _pinHash(pin);
  const id = byPinHash.get(h);
  if (!id) return null;
  const s = _getById(id);
  if (!s) return null;
  return s;
}

function getSessionById(id) {
  return _getById(id);
}

function markResolved(s) {
  if (!s.resolvedAt) s.resolvedAt = new Date().toISOString();
}

function setOffer(id, envelope) {
  const s = _getById(id);
  if (!s) return false;
  s.offerEnvelope = envelope;
  return true;
}

function getOffer(id) {
  const s = _getById(id);
  if (!s) return null;
  return s.offerEnvelope;
}

function setAnswer(id, envelope) {
  const s = _getById(id);
  if (!s) return false;
  s.answerEnvelope = envelope;
  return true;
}

function getAnswer(id) {
  const s = _getById(id);
  if (!s) return null;
  return s.answerEnvelope;
}

function deleteSession(id) {
  const s = _getById(id);
  if (s) {
    byId.delete(id);
    if (s.pinHash) byPinHash.delete(s.pinHash);
    return true;
  }
  return false;
}

function cleanupExpired() {
  const now = _now();
  for (const [id, s] of byId.entries()) {
    if (now >= (s.expiresAtMs || 0)) {
      byId.delete(id);
      if (s.pinHash) byPinHash.delete(s.pinHash);
    }
  }
}

module.exports = {
  createSession,
  getSessionByPin,
  getSessionById,
  markResolved,
  setOffer,
  getOffer,
  setAnswer,
  getAnswer,
  deleteSession,
  ttlRemainingSec,
  cleanupExpired,
  _expired,
};
