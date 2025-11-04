const { isUuidV4, validateEnvelope, parseJson, sendJson, error } = require('../../../_lib/utils');
const { getSession, saveSession, getSessionTtlSec } = require('../../../_lib/store');

async function getAlive(sessionId, res) {
  if (!isUuidV4(sessionId)) { error(res, 404, 'session_not_found'); return null; }
  const sess = await getSession(sessionId);
  if (!sess) { error(res, 404, 'session_not_found'); return null; }
  const ttl = await getSessionTtlSec(sessionId);
  if (ttl <= 0) { error(res, 410, 'session_expired'); return null; }
  return sess;
}

module.exports = async function handler(req, res) {
  const { sessionId } = req.query;

  if (req.method === 'GET') {
    const sess = await getAlive(sessionId, res);
    if (!sess) return;
    if (!sess.offerEnvelope) return error(res, 404, 'offer_not_set');
    return sendJson(res, 200, { envelope: sess.offerEnvelope });
  }

  if (req.method === 'POST') {
    const sess = await getAlive(sessionId, res);
    if (!sess) return;
    let body;
    try { body = await parseJson(req); } catch (e) {
      return error(res, e.code === 'too_large' ? 413 : 400, e.code === 'too_large' ? 'payload_too_large' : 'bad_json');
    }
    if (!body || typeof body !== 'object') return error(res, 400, 'invalid_envelope');
    const { envelope } = body;
    const err = validateEnvelope(envelope, sess.id);
    if (err) return error(res, 400, err);
    if (sess.offerEnvelope) return error(res, 409, 'offer_already_set');
    sess.offerEnvelope = envelope;
    await saveSession(sess);
    return sendJson(res, 200, {});
  }

  return error(res, 405, 'method_not_allowed');
};
