const http = require('http');
const { pushChunk, nextChunk, cleanup } = require('./shared/sessionManager');

const PORT = process.env.PORT || 3000;
const MAX_BODY = 64 * 1024;

function send(res, code, obj) {
  const json = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Pragma': 'no-cache'
  });
  res.end(json);
}

function parseQuery(url) {
  const q = {};
  const i = url.indexOf('?');
  if (i === -1) return q;
  const parts = url.substring(i + 1).split('&');
  for (const p of parts) {
    if (!p) continue;
    const [k, v] = p.split('=');
    q[decodeURIComponent(k)] = decodeURIComponent(v || '');
  }
  return q;
}

const server = http.createServer((req, res) => {
  try {
    if (req.method === 'POST' && req.url.startsWith('/api/send')) {
      let size = 0;
      let body = '';
      req.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BODY) {
          send(res, 413, { error: 'payload_too_large' });
          req.destroy();
        } else {
          body += chunk.toString();
        }
      });
      req.on('end', () => {
        let obj = {};
        try { obj = JSON.parse(body || '{}'); } catch {}
        const { pin, passwordHash, chunkIndex, totalChunks, data } = obj || {};
        const r = pushChunk({ pin, passwordHash, chunkIndex, totalChunks, data });
        cleanup();
        if (!r.ok) return send(res, 400, { status: r.error === 'expired' ? 'expired' : 'waiting', error: r.error });
        return send(res, 200, { status: 'waiting' });
      });
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/api/receive')) {
      const q = parseQuery(req.url);
      const pin = (q.pin || '').toString();
      const passwordHash = (q.passwordHash || '').toString();
      const out = nextChunk({ pin, passwordHash });
      cleanup();
      if (out.status === 'chunkAvailable') return send(res, 200, { status: out.status, chunk: out.chunk });
      return send(res, 200, { status: out.status });
    }
    send(res, 404, { error: 'not_found' });
  } catch (e) {
    send(res, 500, { status: 'expired', error: 'internal_error' });
  }
});

server.headersTimeout = 10000;
server.requestTimeout = 10000;
server.keepAliveTimeout = 5000;
if (server.maxRequestsPerSocket !== undefined) server.maxRequestsPerSocket = 100;

server.listen(PORT, () => {
  console.log(`Legacy server listening on ${PORT} (no-express)`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
