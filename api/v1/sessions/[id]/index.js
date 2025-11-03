const { sendJson, error } = require('../../../_lib/utils');
const mem = require('../../../_lib/memstore');

module.exports = async function handler(req, res) {
  const { id } = req.query || {};
  if (!id) return error(res, 400, 'invalid_session');

  if (req.method === 'DELETE') {
    mem.deleteSession(id);
    return sendJson(res, 200, { ok: true });
  }

  return error(res, 405, 'method_not_allowed');
};
