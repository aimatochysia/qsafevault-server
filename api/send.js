const { pushChunk, cleanup } = require('../shared/sessionManager');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'method_not_allowed' }));
  }
  try {
    let body = '';
    await new Promise((resolve) => {
      req.on('data', (c) => (body += c.toString()));
      req.on('end', resolve);
    });
    let obj = {};
    try { obj = JSON.parse(body || '{}'); } catch { obj = {}; }

    const { pin, passwordHash, chunkIndex, totalChunks, data } = obj || {};
    const r = pushChunk({ pin, passwordHash, chunkIndex, totalChunks, data });
    cleanup();
    if (!r.ok) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ status: r.error === 'expired' ? 'expired' : 'waiting', error: r.error }));
    }
    res.statusCode = 200;
    res.end(JSON.stringify({ status: 'waiting' }));
  } catch {
    res.statusCode = 500;
    res.end(JSON.stringify({ status: 'expired', error: 'internal_error' }));
  }
};
