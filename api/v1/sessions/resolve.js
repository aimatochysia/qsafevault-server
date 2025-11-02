const { sendJson, error } = require('../../_lib/utils');
const { resolvePinOnce, getSession, getSessionTtlSec, rateAllowResolve } = require('../../_lib/store');

function getIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return error(res, 405, 'method_not_allowed');

  const pin = (req.query.pin || '').toString();
  if (!/^\d{6}$/.test(pin)) return error(res, 404, 'pin_not_found');

  const ip = getIp(req);
  const allowed = await rateAllowResolve(ip);
  if (!allowed) return error(res, 429, 'rate_limited');

  const sessionId = await resolvePinOnce(pin);
  if (!sessionId) return error(res, 404, 'pin_not_found');

  const sess = await getSession(sessionId);
  if (!sess) return error(res, 410, 'pin_expired');

  const ttlSec = await getSessionTtlSec(sessionId);
  if (ttlSec <= 0) return error(res, 410, 'pin_expired');

  sendJson(res, 200, {
    sessionId: sess.id,
    saltB64: sess.saltB64,
    ttlSec
  });
};
