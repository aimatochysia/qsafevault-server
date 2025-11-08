const { devices } = require('./index');

function now() { return Date.now(); }

module.exports = function listDevices(req, res) {
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
  const arr = devices.get(userId) || [];
  const nowVal = now();
  const filtered = arr.filter(d => !d.expires || d.expires > nowVal);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ devices: filtered }));
};
