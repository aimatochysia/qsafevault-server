// DELETE /api/v1/sessions/[sessionId]
const { getSession, deleteSession } = require('../sessionStore');

module.exports = async function sessionDelete(req, res) {
  if (req.method !== 'DELETE') {
    res.statusCode = 405;
    res.end();
    return;
  }
  
  const sessionId = req.query.sessionId;
  
  try {
    const sess = await getSession(sessionId);
    if (!sess) {
      res.statusCode = 410;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'session_expired' }));
      return;
    }
    
    await deleteSession(sessionId);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ status: 'deleted' }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'server_error' }));
  }
};
