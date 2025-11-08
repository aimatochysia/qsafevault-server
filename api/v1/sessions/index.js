const { createSession } = require('./sessionStore');

module.exports = function sessionsIndex(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end();
    return;
  }
  let body = '';
  req.on('data', chunk => {
    body += chunk;
    if (body.length > 4096) req.destroy();
  });
  req.on('end', () => {
    let pin;
    try {
      if (body) pin = JSON.parse(body).pin;
    } catch {}
    const result = createSession(pin);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(result));
  });
};
