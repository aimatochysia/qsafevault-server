const { isUuidV4, validateEnvelope, parseJson, sendJson, error } = require('../../../_lib/utils');
const mem = require('../../../_lib/memstore');

function getAlive(sessionId, res) {
  if (!isUuidV4(sessionId)) { error(res, 404, 'session_not_found'); return null; }
  const sess = mem.getSessionById(sessionId);
  if (!sess) { error(res, 404, 'session_not_found'); return null; }
  if (mem._expired(sess)) { error(res, 410, 'session_expired'); return null; }
  return sess;
}

module.exports = async function handler(req, res) {
  const { sessionId } = req.query;

  if (req.method === 'GET') {
    const sess = getAlive(sessionId, res);
    if (!sess) return;
    const env = mem.getOffer(sessionId);
    if (!env) return error(res, 404, 'offer_not_set');
    return sendJson(res, 200, { envelope: env });
  }

  if (req.method === 'POST') {
    const sess = getAlive(sessionId, res);
    if (!sess) return;
    let body;
    try { body = await parseJson(req); } catch (e) {
      return error(res, e.code === 'too_large' ? 413 : 400, e.code === 'too_large' ? 'payload_too_large' : 'bad_json');
    }
    if (!body || typeof body !== 'object') return error(res, 400, 'invalid_envelope');
    const { envelope } = body;
    const err = validateEnvelope(envelope, sess.id);
    if (err) return error(res, 400, err);
    if (mem.getOffer(sessionId)) return error(res, 409, 'offer_already_set');
    mem.setOffer(sessionId, envelope);
    return sendJson(res, 200, {});
  }

  return error(res, 405, 'method_not_allowed');
};
