const { error, sendJson } = require('../../_lib/utils');
const { registerDevice } = require('../../_lib/store');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return error(res, 405, 'method_not_allowed');
  try {
    let body = '';
    await new Promise((resolve) => {
      req.on('data', (c) => (body += c.toString()));
      req.on('end', resolve);
    });
    let obj = {};
    try { obj = JSON.parse(body || '{}'); } catch { return error(res, 400, 'bad_json'); }
    const userId = (obj.userId || '').toString().trim();
    const deviceId = (obj.deviceId || '').toString().trim();
    const onion = (obj.onion || '').toString().trim();
    const port = Number.isFinite(obj.port) ? obj.port : 5000;
    const ttlSec = Number.isFinite(obj.ttlSec) ? obj.ttlSec : 604800;
    if (!userId || !deviceId || !onion || !/^[a-z2-7]{16,56}\.onion$/i.test(onion)) {
      return error(res, 400, 'invalid_params');
    }
    await registerDevice(userId, deviceId, onion, port, ttlSec);
    return sendJson(res, 200, { ok: true });
  } catch {
    return error(res, 500, 'internal_error');
  }
};
