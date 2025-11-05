const { error, sendJson } = require('../../_lib/utils');
const { listDevices } = require('../../_lib/store');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return error(res, 405, 'method_not_allowed');
  const { userId } = req.query || {};
  if (!userId || typeof userId !== 'string') return error(res, 400, 'invalid_params');
  try {
    const devices = await listDevices(userId);
    return sendJson(res, 200, { devices });
  } catch {
    return error(res, 500, 'internal_error');
  }
};
