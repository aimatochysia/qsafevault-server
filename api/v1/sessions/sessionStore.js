const SESS_TTL_SEC = 180;
const SESS_TTL_MS = SESS_TTL_SEC * 1000;
const sessions = new Map();
const pinToSessionId = new Map();
const { randomUUID } = require('crypto');

function now() { return Date.now(); }

function purgeExpired() {
  const cutoff = now();
  for (const [sessionId, sess] of sessions.entries()) {
    if (sess.expires < cutoff) {
      sessions.delete(sessionId);
      if (sess.pin) pinToSessionId.delete(sess.pin);
    }
  }
}

function createSession(pin) {
  purgeExpired();
  const sessionId = randomUUID();
  const created = now();
  const expires = created + SESS_TTL_MS;
  sessions.set(sessionId, { pin, created, expires, offer: null, answer: null });
  if (pin) pinToSessionId.set(pin, sessionId);
  return { sessionId, ttlSec: SESS_TTL_SEC };
}

function getSessionIdByPin(pin) {
  purgeExpired();
  const sessionId = pinToSessionId.get(pin);
  if (!sessionId) return { error: 'pin_not_found' };
  const sess = sessions.get(sessionId);
  if (!sess || sess.expires < now()) {
    sessions.delete(sessionId);
    pinToSessionId.delete(pin);
    return { error: 'session_expired' };
  }
  return { sessionId };
}

function getSession(sessionId) {
  purgeExpired();
  const sess = sessions.get(sessionId);
  if (!sess) return null;
  if (sess.expires < now()) {
    sessions.delete(sessionId);
    if (sess.pin) pinToSessionId.delete(sess.pin);
    return null;
  }
  return sess;
}

function saveSession(sessionId, data) {
  const sess = getSession(sessionId);
  if (!sess) return false;
  Object.assign(sess, data);
  return true;
}

module.exports = {
  createSession,
  getSessionIdByPin,
  getSession,
  saveSession,
  purgeExpired,
  SESS_TTL_SEC,
};
