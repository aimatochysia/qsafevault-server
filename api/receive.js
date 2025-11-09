const { nextChunk, purgeExpired } = require('../sessionManager');
const { logEvent } = require('../debugLogger');

module.exports = async function receiveHandler(req, res) {
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
    await logEvent({ type: 'receive', error: 'missing_pin_or_passwordHash', query: req.query });
    return;
  }
  const result = await nextChunk({ pin, passwordHash });
  await logEvent({ type: 'receive', query: req.query, result });
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(result));
};
