const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { SESS_TTL_SEC, sendJson, error } = require('../../_lib/utils');
const mem = require('../../_lib/memstore');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return error(res, 405, 'method_not_allowed');

  try {
    const id = uuidv4();
    const saltB64 = crypto.randomBytes(16).toString('base64');
    const { session, pin } = mem.createSession(id, saltB64, SESS_TTL_SEC);
    sendJson(res, 200, {
      sessionId: session.id,
      pin,
      saltB64: session.saltB64,
      ttlSec: SESS_TTL_SEC,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    });
  } catch {
    error(res, 500, 'internal_error');
  }
};
