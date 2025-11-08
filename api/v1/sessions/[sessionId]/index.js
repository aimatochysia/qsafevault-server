// DELETE /api/v1/sessions/[sessionId]
const { getSession, saveSession } = require('../sessionStore');

module.exports = function sessionDelete(req, res) {
  if (req.method !== 'DELETE') {
    res.statusCode = 405;
    res.end();
    return;
  }
  const sessionId = req.query.sessionId;
  const sess = getSession(sessionId);
  if (!sess) {
    res.statusCode = 410;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'session_expired' }));
    return;
  }
  // Mark as deleted (ephemeral, just remove from store)
  saveSession(sessionId, { offer: null, answer: null });
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ status: 'deleted' }));
};
