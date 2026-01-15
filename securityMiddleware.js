/**
 * Security Middleware for QSafeVault Server
 * 
 * Implements:
 * - Rate limiting (prevents abuse, supports concurrency)
 * - CORS hardening (restrict origins)
 * - Security headers (via Helmet)
 * - Request size validation (per-endpoint limits)
 * - Audit logging (for Enterprise mode)
 */

const helmet = require('helmet');
const crypto = require('crypto');

// ==================== Constants ====================

// String truncation limits for sanitization
const MAX_LOG_STRING_LENGTH = 100;
const TRUNCATED_STRING_PREFIX_LENGTH = 50;

// Password hash validation bounds
const MIN_HASH_LENGTH = 16;
const MAX_HASH_LENGTH = 256;

// ==================== Rate Limiting ====================

// In-memory rate limit store (per IP)
// For production with multiple instances, consider using Vercel KV or similar
const rateLimitStore = new Map();

// Rate limit configuration
const RATE_LIMIT_CONFIG = {
  windowMs: 60000,        // 1 minute window
  maxRequests: 100,       // 100 requests per window per IP
  cleanupInterval: 300000, // Clean up old entries every 5 minutes
};

// Periodic cleanup of expired rate limit entries
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of rateLimitStore.entries()) {
    if (now - data.windowStart > RATE_LIMIT_CONFIG.windowMs * 2) {
      rateLimitStore.delete(ip);
    }
  }
}, RATE_LIMIT_CONFIG.cleanupInterval);

/**
 * Rate limiting middleware
 * Limits requests per IP to prevent abuse while allowing concurrent operations
 */
function rateLimiter(req, res, next) {
  // Get client IP (handle proxies)
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
             req.headers['x-real-ip'] || 
             req.socket?.remoteAddress || 
             'unknown';
  
  const now = Date.now();
  let entry = rateLimitStore.get(ip);
  
  if (!entry || now - entry.windowStart > RATE_LIMIT_CONFIG.windowMs) {
    // New window
    entry = {
      windowStart: now,
      count: 1,
    };
    rateLimitStore.set(ip, entry);
  } else {
    entry.count++;
  }
  
  // Set rate limit headers
  const remaining = Math.max(0, RATE_LIMIT_CONFIG.maxRequests - entry.count);
  const resetTime = Math.ceil((entry.windowStart + RATE_LIMIT_CONFIG.windowMs - now) / 1000);
  
  res.setHeader('X-RateLimit-Limit', RATE_LIMIT_CONFIG.maxRequests);
  res.setHeader('X-RateLimit-Remaining', remaining);
  res.setHeader('X-RateLimit-Reset', resetTime);
  
  if (entry.count > RATE_LIMIT_CONFIG.maxRequests) {
    return res.status(429).json({
      error: 'rate_limit_exceeded',
      message: 'Too many requests. Please try again later.',
      retryAfter: resetTime,
    });
  }
  
  next();
}

// ==================== CORS Hardening ====================

// Allowed origins (configure via environment variable)
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['*']; // Default to all for development

/**
 * CORS middleware with origin validation
 */
function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  
  // Check if origin is allowed
  const isAllowed = ALLOWED_ORIGINS.includes('*') || 
                    (origin && ALLOWED_ORIGINS.includes(origin));
  
  if (origin && isAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (ALLOWED_ORIGINS.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-ID');
  res.setHeader('Access-Control-Max-Age', '86400'); // 24 hours
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  
  // Block requests from disallowed origins (if origin header is present and not allowed)
  if (origin && !isAllowed) {
    return res.status(403).json({
      error: 'origin_not_allowed',
      message: 'Request origin is not in the allowed list.',
    });
  }
  
  next();
}

// ==================== Security Headers (Helmet) ====================

/**
 * Helmet configuration for security headers
 */
const helmetMiddleware = helmet({
  // Content Security Policy
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  // Prevent clickjacking
  frameguard: { action: 'deny' },
  // Hide X-Powered-By header
  hidePoweredBy: true,
  // Enable HSTS
  hsts: {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true,
  },
  // Prevent MIME type sniffing
  noSniff: true,
  // XSS Protection
  xssFilter: true,
  // Referrer Policy
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  // Cross-Origin policies
  crossOriginEmbedderPolicy: false, // Disable for API server
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // Allow cross-origin API access
});

// ==================== Request Size Validation ====================

// Per-endpoint size limits (in bytes)
const ENDPOINT_SIZE_LIMITS = {
  '/api/relay': 50 * 1024,          // 50KB for relay (chunks up to 48KB + overhead)
  '/api/v1/sessions': 10 * 1024,    // 10KB for sessions
  '/api/v1/devices': 5 * 1024,      // 5KB for device registration
  default: 70 * 1024,               // 70KB default
};

/**
 * Request size validation middleware
 */
function requestSizeValidator(req, res, next) {
  const contentLength = parseInt(req.headers['content-length'] || '0', 10);
  
  // Determine limit for this endpoint
  let limit = ENDPOINT_SIZE_LIMITS.default;
  for (const [path, pathLimit] of Object.entries(ENDPOINT_SIZE_LIMITS)) {
    if (path !== 'default' && req.path.startsWith(path)) {
      limit = pathLimit;
      break;
    }
  }
  
  if (contentLength > limit) {
    return res.status(413).json({
      error: 'payload_too_large',
      message: `Request body exceeds ${Math.round(limit / 1024)}KB limit for this endpoint.`,
      limit: limit,
    });
  }
  
  next();
}

// ==================== Blob Name Randomization ====================

/**
 * Generate a random suffix for blob keys to prevent enumeration
 * @param {number} length - Length of random suffix (in output characters)
 * @returns {string} Random alphanumeric string
 */
function generateRandomSuffix(length = 8) {
  // Calculate bytes needed for desired output length (base64url: 4 chars per 3 bytes)
  const bytesNeeded = Math.ceil(length * 3 / 4);
  return crypto.randomBytes(bytesNeeded).toString('base64url').slice(0, length);
}

// ==================== Audit Logging ====================

// Audit log configuration
const AUDIT_CONFIG = {
  enabled: process.env.QSAFEVAULT_EDITION === 'enterprise',
  logLevel: process.env.AUDIT_LOG_LEVEL || 'info', // 'debug', 'info', 'warn', 'error'
};

// Audit log levels
const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Audit logging function (for Enterprise mode)
 * Logs access patterns WITHOUT logging encrypted content
 */
function auditLog(level, event, metadata = {}) {
  if (!AUDIT_CONFIG.enabled) return;
  if (LOG_LEVELS[level] < LOG_LEVELS[AUDIT_CONFIG.logLevel]) return;
  
  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    // Never log encrypted content or sensitive data
    ...sanitizeMetadata(metadata),
  };
  
  // In production, this could be sent to a log aggregation service
  console.log(JSON.stringify(logEntry));
}

/**
 * Sanitize metadata for audit logging
 * Removes or masks sensitive fields
 */
function sanitizeMetadata(metadata) {
  const sanitized = { ...metadata };
  
  // Fields to completely remove
  const removeFields = ['passwordHash', 'data', 'payload', 'chunk', 'chunks'];
  for (const field of removeFields) {
    if (field in sanitized) {
      sanitized[field] = '[REDACTED]';
    }
  }
  
  // Truncate long string fields
  for (const [key, value] of Object.entries(sanitized)) {
    if (typeof value === 'string' && value.length > MAX_LOG_STRING_LENGTH) {
      sanitized[key] = value.slice(0, TRUNCATED_STRING_PREFIX_LENGTH) + '...[truncated]';
    }
  }
  
  return sanitized;
}

/**
 * Audit logging middleware
 * Logs request metadata for Enterprise mode
 */
function auditMiddleware(req, res, next) {
  if (!AUDIT_CONFIG.enabled) {
    return next();
  }
  
  const startTime = Date.now();
  const requestId = req.headers['x-request-id'] || generateRandomSuffix(16);
  
  // Add request ID to response headers for tracing
  res.setHeader('X-Request-ID', requestId);
  
  // Log request start
  auditLog('debug', 'request_start', {
    requestId,
    method: req.method,
    path: req.path,
    ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress,
    userAgent: req.headers['user-agent'],
  });
  
  // Log response on finish
  res.on('finish', () => {
    auditLog('info', 'request_complete', {
      requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Date.now() - startTime,
    });
  });
  
  next();
}

// ==================== Security Validation Utilities ====================

/**
 * Validate invite code format
 * @param {string} inviteCode 
 * @returns {boolean}
 */
function isValidInviteCode(inviteCode) {
  return typeof inviteCode === 'string' && /^[A-Za-z0-9]{8}$/.test(inviteCode);
}

/**
 * Validate password hash format
 * Accepts:
 * - Base64 standard: A-Za-z0-9+/=
 * - Base64url: A-Za-z0-9_-
 * - Hex: 0-9a-fA-F
 * @param {string} hash 
 * @returns {boolean}
 */
function isValidPasswordHash(hash) {
  if (typeof hash !== 'string') return false;
  if (hash.length < MIN_HASH_LENGTH || hash.length > MAX_HASH_LENGTH) return false;
  
  // Check if it's valid base64 (standard or URL-safe)
  const isBase64 = /^[A-Za-z0-9+/=]+$/.test(hash);
  const isBase64Url = /^[A-Za-z0-9_-]+$/.test(hash);
  // Check if it's valid hex
  const isHex = /^[0-9a-fA-F]+$/.test(hash);
  
  return isBase64 || isBase64Url || isHex;
}

// ==================== Exports ====================

module.exports = {
  // Middleware
  rateLimiter,
  corsMiddleware,
  helmetMiddleware,
  requestSizeValidator,
  auditMiddleware,
  
  // Utilities
  generateRandomSuffix,
  auditLog,
  isValidInviteCode,
  isValidPasswordHash,
  
  // Configuration
  RATE_LIMIT_CONFIG,
  ENDPOINT_SIZE_LIMITS,
  AUDIT_CONFIG,
};
