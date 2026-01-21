// GET/POST /api/v1/sessions/[sessionId]/offer
const { getSession, saveSession, SESS_TTL_SEC } = require('../sessionStore');

function validateEnvelope(envelope, sessionId) {
  if (!envelope || typeof envelope !== 'object') return false;
  if (envelope.version !== 1) return false;
  if (envelope.sessionId !== sessionId) return false;
  if (typeof envelope.nonce !== 'string' || envelope.nonce.length < 12 || envelope.nonce.length > 32) return false;
  if (typeof envelope.ct !== 'string' || envelope.ct.length < 16 || envelope.ct.length > 64 * 1024) return false;
  return true;
}

module.exports = async function sessionOffer(req, res) {
  const sessionId = req.query.sessionId;
  
  try {
    const sess = await getSession(sessionId);
    if (!sess) {
      res.statusCode = 410;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'session_expired' }));
      return;
    }
    
    if (req.method === 'POST') {
      // Validate req.body exists (Express should have parsed it)
      if (!req.body || typeof req.body !== 'object') {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'invalid_json' }));
        return;
      }
      
      const envelope = req.body;
      
      if (!validateEnvelope(envelope, sessionId)) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'invalid_envelope' }));
        return;
      }
      
      await saveSession(sessionId, { offer: envelope });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ status: 'ok', ttlSec: SESS_TTL_SEC }));
      return;
    }
    
    if (req.method === 'GET') {
      if (!sess.offer) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ envelope: sess.offer }));
      return;
    }
    
    res.statusCode = 405;
    res.end();
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'server_error' }));
  }
};
