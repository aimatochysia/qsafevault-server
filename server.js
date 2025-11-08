const express = require('express');
const helmet = require('helmet');
const { pushChunk, nextChunk, cleanup } = require('./shared/sessionManager');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.set('etag', false);
app.set('query parser', 'simple');
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  hsts: false,
  referrerPolicy: { policy: 'no-referrer' }
}));
app.use((req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
});

app.post('/api/send', (req, res) => {
  const { pin, passwordHash, chunkIndex, totalChunks, data } = req.body || {};
  const r = pushChunk({ pin, passwordHash, chunkIndex, totalChunks, data });
  cleanup();
  if (!r.ok) return res.status(400).json({ status: r.error === 'expired' ? 'expired' : 'waiting', error: r.error });
  return res.status(200).json({ status: 'waiting' });
});

app.get('/api/receive', (req, res) => {
  const pin = (req.query.pin || '').toString();
  const passwordHash = (req.query.passwordHash || '').toString();
  const out = nextChunk({ pin, passwordHash });
  cleanup();
  if (out.status === 'chunkAvailable') return res.status(200).json({ status: out.status, chunk: out.chunk });
  return res.status(200).json({ status: out.status });
});

app.use((req, res) => res.status(404).json({ error: 'not_found' }));

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT);
server.headersTimeout = 10000;
server.requestTimeout = 10000;
server.keepAliveTimeout = 5000;
if (server.maxRequestsPerSocket !== undefined) server.maxRequestsPerSocket = 100;

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
