const devices = new Map();
const { randomUUID } = require('crypto');

function now() { return Date.now(); }

function purgeExpired(userId) {
  if (!devices.has(userId)) return;
  const arr = devices.get(userId).filter(d => !d.expires || d.expires > now());
  if (arr.length) devices.set(userId, arr);
  else devices.delete(userId);
}

function validateOnion(onion) {
  return typeof onion === 'string' && /^[a-z2-7]{16,56}\.onion$/.test(onion);
}

function registerDevice(req, res) {
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
    let input;
    try {
      input = JSON.parse(body);
    } catch {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'invalid_json' }));
      return;
    }
    const { userId, deviceId, onion, port, ttlSec } = input || {};
    if (!userId || !deviceId || !validateOnion(onion)) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'invalid_input' }));
      return;
    }
    const expires = ttlSec ? now() + Math.min(86400, Math.max(30, ttlSec)) * 1000 : now() + 180 * 1000;
    const entry = { deviceId, onion, port, expires };
    purgeExpired(userId);
    if (!devices.has(userId)) devices.set(userId, []);
    const arr = devices.get(userId);
    const idx = arr.findIndex(d => d.deviceId === deviceId);
    if (idx >= 0) arr[idx] = entry;
    else arr.push(entry);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ status: 'ok' }));
  });
}

module.exports = { registerDevice, devices };
