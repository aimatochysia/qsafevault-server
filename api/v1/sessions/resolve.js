const { getSessionIdByPin } = require('./sessionStore');

module.exports = async function sessionsResolve(req, res) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.end();
    return;
  }
  const { pin } = req.query || {};
  if (!pin) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'missing_pin' }));
    return;
  }
  
  try {
    const result = await getSessionIdByPin(pin);
    res.statusCode = result.error ? 404 : 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(result));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'server_error' }));
  }
};
