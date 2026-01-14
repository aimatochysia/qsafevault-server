/**
 * QSafeVault Server
 * 
 * Zero-knowledge signaling server for P2P sync
 * 
 * SECURITY PRINCIPLES:
 * - No account database
 * - No vault data storage beyond encrypted blobs
 * - Server never decrypts vault data
 * - Server never generates cryptographic keys
 * - All secrets live on user devices
 * 
 * EDITION SYSTEM:
 * - Consumer: Stateless relay, ephemeral storage, public deployment allowed
 * - Enterprise: Device registry, audit logging, self-hosted only
 */

const express = require('express');
const { getEditionConfig } = require('./editionConfig');

// Initialize edition configuration first (will fail fast on misconfiguration)
let editionConfig;
try {
  editionConfig = getEditionConfig();
} catch (error) {
  console.error('FATAL: Server configuration error');
  console.error(error.message);
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '70kb' }));

// Make edition config available to routes
app.use((req, res, next) => {
  req.editionConfig = editionConfig;
  next();
});

const relayHandler = require('./api/relay');
const sessionsIndex = require('./api/v1/sessions/index');
const sessionsResolve = require('./api/v1/sessions/resolve');
const sessionOffer = require('./api/v1/sessions/[sessionId]/offer');
const sessionAnswer = require('./api/v1/sessions/[sessionId]/answer');
const sessionDelete = require('./api/v1/sessions/[sessionId]/index');
const registerDevice = require('./api/v1/devices/index').registerDevice;
const listDevices = require('./api/v1/devices/[userId]');

// Edition handshake endpoint - clients use this to verify server edition
app.get('/api/v1/edition', (req, res) => {
  res.json(editionConfig.getEditionInfo());
});

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
