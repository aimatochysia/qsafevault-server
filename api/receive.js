const { nextChunk, purgeExpired } = require('../sessionManager');

module.exports = function receiveHandler(req, res) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.end();
    return;
  }
  purgeExpired();
  const { pin, passwordHash } = req.query || {};
  if (typeof pin !== 'string' || typeof passwordHash !== 'string') {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ status: 'waiting', error: 'missing_pin_or_passwordHash' }));
    return;
  }
  const result = nextChunk({ pin, passwordHash });
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(result));
};
