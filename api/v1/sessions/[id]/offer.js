const { sendJson, error } = require('../../../_lib/utils');
const mem = require('../../../_lib/memstore');

module.exports = async function handler(req, res) {
  const { id } = req.query || {};
  if (!id) return error(res, 400, 'invalid_session');

  mem.cleanupExpired();
  const s = mem.getSessionById(id);
  if (!s) return error(res, 404, 'session_not_found');
  if (mem._expired(s)) return error(res, 410, 'session_expired');

  if (req.method === 'POST') {
    try {
      const body = req.body || {};
      const env = body.envelope;
      if (!env || typeof env !== 'object' || !env.ctB64 || !env.nonceB64) {
        return error(res, 400, 'invalid_envelope');
      }
      mem.setOffer(id, env);
      return sendJson(res, 200, { ok: true });
    } catch {
      return error(res, 400, 'bad_request');
    }
  }

  if (req.method === 'GET') {
    const env = mem.getOffer(id);
    if (!env) return error(res, 404, 'offer_not_set');
    return sendJson(res, 200, { envelope: env });
  }

  return error(res, 405, 'method_not_allowed');
};
