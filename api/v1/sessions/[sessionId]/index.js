const { isUuidV4, sendJson, error } = require('../../../_lib/utils');
const { getSession, deleteSession } = require('../../../_lib/store');

module.exports = async function handler(req, res) {
  if (req.method !== 'DELETE') return error(res, 405, 'method_not_allowed');

  const { sessionId } = req.query;
  if (!isUuidV4(sessionId)) return error(res, 404, 'session_not_found');

  // DELETE is idempotent - even if session doesn't exist, return 204
  await deleteSession(sessionId);
  res.statusCode = 204;
  res.end();
};
