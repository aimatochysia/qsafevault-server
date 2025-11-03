const { sendJson, error } = require('../../_lib/utils');
const mem = require('../../_lib/memstore');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return error(res, 405, 'method_not_allowed');

  const pin = (req.query && (req.query.pin || req.query.PIN)) || '';
  if (!pin || typeof pin !== 'string' || !/^\d{6,8}$/.test(pin)) {
    return error(res, 404, 'pin_not_found');
  }

  mem.cleanupExpired();

  const s = mem.getSessionByPin(pin);
  if (!s) return error(res, 404, 'pin_not_found');
  if (mem._expired(s)) return error(res, 410, 'session_expired');

  mem.markResolved(s);
  const ttlSec = mem.ttlRemainingSec(s);
  return sendJson(res, 200, {
    sessionId: s.id,
    saltB64: s.saltB64,
    ttlSec,
  });
};
