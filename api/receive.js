const { nextChunk, cleanup } = require('../shared/sessionManager');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'method_not_allowed' }));
  }
  try {
    const pin = (req.query && (req.query.pin || '')).toString();
    const passwordHash = (req.query && (req.query.passwordHash || '')).toString();

    const out = await nextChunk({ pin, passwordHash });
    cleanup();

    res.statusCode = 200;
    if (out.status === 'chunkAvailable') {
      return res.end(JSON.stringify({ status: out.status, chunk: out.chunk }));
    }
    return res.end(JSON.stringify({ status: out.status }));
  } catch {
    res.statusCode = 500;
    res.end(JSON.stringify({ status: 'expired', error: 'internal_error' }));
  }
};
