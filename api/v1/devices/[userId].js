const { getDevices } = require('./index');

module.exports = async function listDevices(req, res) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.end();
    return;
  }
  
  const userId = req.query.userId || req.url.split('/').pop();
  if (!userId) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'missing_userId' }));
    return;
  }
  
  try {
    const devices = await getDevices(userId);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ devices }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'server_error' }));
  }
};
