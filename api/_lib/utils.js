const crypto = require('crypto');

const SESS_TTL_SEC = 180;
const MAX_ENVELOPE_CT_LEN = 64 * 1024;

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isUuidV4(s) { return UUID_V4_RE.test(s); }

function isValidBase64(s) {
  if (typeof s !== 'string') return false;
  const noNewlines = s.replace(/\s+/g, '');
  if (noNewlines.length === 0 || noNewlines.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(noNewlines)) return false;
  return true;
}
function strictB64ToBuf(s) {
  if (!isValidBase64(s)) return null;
  try { return Buffer.from(s, 'base64'); } catch { return null; }
}

function validateEnvelope(envelope, expectedSessionId) {
  if (!envelope || typeof envelope !== 'object') return 'invalid_envelope';
  const { v, sessionId, nonceB64, ctB64 } = envelope;
  if (v !== 1) return 'invalid_envelope';
  if (typeof sessionId !== 'string' || sessionId !== expectedSessionId) return 'invalid_envelope';
  if (typeof nonceB64 !== 'string' || typeof ctB64 !== 'string') return 'invalid_envelope';
  if (nonceB64.length !== 16) return 'invalid_envelope';
  const nonce = strictB64ToBuf(nonceB64);
  const ct = strictB64ToBuf(ctB64);
  if (!nonce || nonce.length !== 12) return 'invalid_envelope';
  if (!ct || ct.length < 16 || ct.length > MAX_ENVELOPE_CT_LEN) return 'invalid_envelope';
  return null;
}

function nowIso() { return new Date().toISOString(); }

function securityHeaders(res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function sendJson(res, status, body) {
  securityHeaders(res);
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

function error(res, status, code) {
  sendJson(res, status, { error: code });
}

async function parseJson(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        req.destroy();
        reject(Object.assign(new Error('too_large'), { code: 'too_large' }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const s = Buffer.concat(chunks).toString('utf8');
        resolve(s ? JSON.parse(s) : {});
      } catch {
        reject(Object.assign(new Error('bad_json'), { code: 'bad_json' }));
      }
    });
    req.on('error', reject);
  });
}

function generatePin() {
  const n = crypto.randomInt(0, 1000000);
  return String(n).padStart(6, '0');
}

module.exports = {
  SESS_TTL_SEC,
  MAX_ENVELOPE_CT_LEN,
  isUuidV4,
  validateEnvelope,
  sendJson,
  error,
  parseJson,
  nowIso,
  generatePin
};
