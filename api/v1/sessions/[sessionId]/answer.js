// GET/POST /api/v1/sessions/[sessionId]/answer
const { getSession, saveSession, SESS_TTL_SEC } = require('../sessionStore');

function validateEnvelope(envelope, sessionId) {
  if (!envelope || typeof envelope !== 'object') return false;
  if (envelope.version !== 1) return false;
  if (envelope.sessionId !== sessionId) return false;
  if (typeof envelope.nonce !== 'string' || envelope.nonce.length < 12 || envelope.nonce.length > 32) return false;
  if (typeof envelope.ct !== 'string' || envelope.ct.length < 16 || envelope.ct.length > 64 * 1024) return false;
  return true;
}

function parseJson(req, maxSize = 70 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > maxSize) {
        req.destroy();
        reject({ error: 'body_too_large' });
      }
    });
    req.on('end', () => {
      try {
        const json = JSON.parse(body);
        resolve(json);
      } catch (e) {
        reject({ error: 'invalid_json' });
      }
    });
  });
}

module.exports = async function sessionAnswer(req, res) {
  const sessionId = req.query.sessionId;
  const sess = getSession(sessionId);
  if (!sess) {
    res.statusCode = 410;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'session_expired' }));
    return;
  }
  if (req.method === 'POST') {
    let envelope;
    try {
      envelope = await parseJson(req);
    } catch (err) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(err));
      return;
    }
    if (!validateEnvelope(envelope, sessionId)) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'invalid_envelope' }));
      return;
    }
    saveSession(sessionId, { answer: envelope });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ status: 'ok', ttlSec: SESS_TTL_SEC }));
    return;
  }
  if (req.method === 'GET') {
    if (!sess.answer) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ envelope: sess.answer }));
    return;
  }
  res.statusCode = 405;
  res.end();
};
