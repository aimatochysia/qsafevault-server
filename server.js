const http = require('http');
const url = require('url');

// Handlers
const sendHandler = require('./api/send');
const receiveHandler = require('./api/receive');
const sessionsIndex = require('./api/v1/sessions/index');
const sessionsResolve = require('./api/v1/sessions/resolve');
const sessionOffer = require('./api/v1/sessions/[sessionId]/offer');
const sessionAnswer = require('./api/v1/sessions/[sessionId]/answer');
const sessionDelete = require('./api/v1/sessions/[sessionId]/index');

// Helper to attach query and params like Vercel
function attachQuery(req, parsed) {
  req.query = parsed.query || {};
}
function route(req, res) {
  const parsed = url.parse(req.url, true);
  let path = parsed.pathname || '/';

  if (path.startsWith('/v1/')) path = path.replace(/^\/v1\//, '/api/v1/');

  attachQuery(req, parsed);

  if (path === '/api/send') return sendHandler(req, res);
  if (path === '/api/receive') return receiveHandler(req, res);

  if (path === '/api/v1/sessions' && req.method === 'POST') return sessionsIndex(req, res);
  if (path === '/api/v1/sessions/resolve') return sessionsResolve(req, res);

  const offerMatch = path.match(/^\/api\/v1\/sessions\/([0-9a-f-]{36})\/offer$/i);
  if (offerMatch) {
    req.query = Object.assign({}, req.query, { sessionId: offerMatch[1] });
    return sessionOffer(req, res);
  }
  const answerMatch = path.match(/^\/api\/v1\/sessions\/([0-9a-f-]{36})\/answer$/i);
  if (answerMatch) {
    req.query = Object.assign({}, req.query, { sessionId: answerMatch[1] });
    return sessionAnswer(req, res);
  }
  const delMatch = path.match(/^\/api\/v1\/sessions\/([0-9a-f-]{36})$/i);
  if (delMatch) {
    req.query = Object.assign({}, req.query, { sessionId: delMatch[1] });
    return sessionDelete(req, res);
  }

  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ error: 'not_found' }));
}

const port = process.env.PORT || 3000;
if (require.main === module) {
  http.createServer(route).listen(port, () => {
    console.log(`qsafevault-server listening on http://localhost:${port}`);
  });
}

module.exports = { route };
