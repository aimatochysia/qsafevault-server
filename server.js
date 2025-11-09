
const express = require('express');
const app = express();
app.use(express.json({ limit: '70kb' }));

const relayHandler = require('./api/relay');
const sessionsIndex = require('./api/v1/sessions/index');
const sessionsResolve = require('./api/v1/sessions/resolve');
const sessionOffer = require('./api/v1/sessions/[sessionId]/offer');
const sessionAnswer = require('./api/v1/sessions/[sessionId]/answer');
const sessionDelete = require('./api/v1/sessions/[sessionId]/index');
const registerDevice = require('./api/v1/devices/index').registerDevice;
const listDevices = require('./api/v1/devices/[userId]');

app.all('/api/relay', relayHandler);

app.post('/api/v1/sessions', sessionsIndex);
app.get('/api/v1/sessions/resolve', sessionsResolve);
app.post('/api/v1/sessions/:sessionId/offer', (req, res) => {
  req.query = { ...req.query, sessionId: req.params.sessionId };
  sessionOffer(req, res);
});
app.get('/api/v1/sessions/:sessionId/offer', (req, res) => {
  req.query = { ...req.query, sessionId: req.params.sessionId };
  sessionOffer(req, res);
});
app.post('/api/v1/sessions/:sessionId/answer', (req, res) => {
  req.query = { ...req.query, sessionId: req.params.sessionId };
  sessionAnswer(req, res);
});
app.get('/api/v1/sessions/:sessionId/answer', (req, res) => {
  req.query = { ...req.query, sessionId: req.params.sessionId };
  sessionAnswer(req, res);
});
app.delete('/api/v1/sessions/:sessionId', (req, res) => {
  req.query = { ...req.query, sessionId: req.params.sessionId };
  sessionDelete(req, res);
});

app.post('/api/v1/devices', registerDevice);
app.get('/api/v1/devices/:userId', (req, res) => {
  req.query = { ...req.query, userId: req.params.userId };
  listDevices(req, res);
});

app.use((req, res) => {
  res.status(404).json({ error: 'not_found' });
});

const port = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(port, () => {
    console.log(`qsafevault-server listening on http://localhost:${port}`);
  });
}

module.exports = app;
