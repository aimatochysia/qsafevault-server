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
 * SECURITY FEATURES:
 * - Rate limiting (100 req/min per IP)
 * - CORS hardening (configurable allowed origins)
 * - Security headers (Helmet.js)
 * - Request size validation (per-endpoint limits)
 * - Audit logging (Enterprise mode)
 * 
 * EDITION SYSTEM:
 * - Consumer: Stateless relay, ephemeral storage, public deployment allowed
 * - Enterprise: Device registry, audit logging, self-hosted only
 */

const express = require('express');
const { getEditionConfig } = require('./editionConfig');
const {
  rateLimiter,
  corsMiddleware,
  helmetMiddleware,
  requestSizeValidator,
  auditMiddleware,
} = require('./securityMiddleware');

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

// ==================== Security Middleware Stack ====================
// Order matters: security headers first, then CORS, rate limiting, size validation

// 1. Security headers (Helmet)
app.use(helmetMiddleware);

// 2. CORS handling
app.use(corsMiddleware);

// 3. Rate limiting
app.use(rateLimiter);

// 4. Request size validation (before body parsing)
app.use(requestSizeValidator);

// 5. Body parsing with default limit
app.use(express.json({ limit: '70kb' }));

// 6. Audit logging (Enterprise mode)
app.use(auditMiddleware);

// 7. Make edition config available to routes
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
