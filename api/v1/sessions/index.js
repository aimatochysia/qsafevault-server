const { createSession } = require('./sessionStore');

module.exports = async function sessionsIndex(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end();
    return;
  }
  
  // Use req.body if already parsed by Express, otherwise parse manually
  let pin;
  if (req.body && typeof req.body === 'object') {
    pin = req.body.pin;
  } else {
    let body = '';
    await new Promise((resolve, reject) => {
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 4096) {
          req.destroy();
          reject(new Error('body_too_large'));
        }
      });
      req.on('end', resolve);
      req.on('error', reject);
    });
    try {
      if (body) pin = JSON.parse(body).pin;
    } catch {}
  }
  
  try {
    const result = await createSession(pin);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(result));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'server_error' }));
  }
};
