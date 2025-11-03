const { isUuidV4, sendJson, error } = require('../../../_lib/utils');
const mem = require('../../../_lib/memstore');

module.exports = async function handler(req, res) {
  if (req.method !== 'DELETE') return error(res, 405, 'method_not_allowed');

  const { sessionId } = req.query;
  if (!isUuidV4(sessionId)) return error(res, 404, 'session_not_found');

  mem.deleteSession(sessionId);
  res.statusCode = 204;
  res.end();
};
