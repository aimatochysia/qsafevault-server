const { sendJson, error } = require('../../_lib/utils');
const { getSessionIdByPin, getSession, getSessionTtlSec } = require('../../_lib/store');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return error(res, 405, 'method_not_allowed');

  const pin = (req.query && (req.query.pin || req.query.PIN)) || '';
  if (!pin || typeof pin !== 'string' || !/^\d{6,8}$/.test(pin)) {
    return error(res, 404, 'pin_not_found');
  }
  try {
    const sessionId = await getSessionIdByPin(pin);
    if (!sessionId) return error(res, 404, 'pin_not_found');

    const sess = await getSession(sessionId);
    if (!sess) return error(res, 410, 'session_expired');

    const ttl = await getSessionTtlSec(sessionId);
    const ttlSec = ttl > 0 ? ttl : 0;
    return sendJson(res, 200, {
      sessionId: sess.id,
      saltB64: sess.saltB64,
      ttlSec
    });
  } catch {
    return error(res, 500, 'internal_error');
  }
};
