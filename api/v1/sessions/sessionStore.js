/**
 * Session Store for WebRTC Sessions
 * 
 * Uses Vercel Blob for cross-instance persistence when available,
 * falls back to in-memory storage for local development/testing.
 * 
 * This enables horizontal scaling for 100s of concurrent users.
 */

const { randomUUID } = require('crypto');
const crypto = require('crypto');

const SESS_TTL_SEC = 180;
const SESS_TTL_MS = SESS_TTL_SEC * 1000;

function now() { return Date.now(); }

// ==================== Storage Backend ====================

// Check if Vercel Blob is available
const USE_BLOB_STORAGE = !!process.env.BLOB_READ_WRITE_TOKEN;

// In-memory fallback for local development/testing
const memoryStore = new Map();
const memoryPinIndex = new Map();

// Lazy-load Vercel Blob to avoid errors when not available
let blobModule = null;
function getBlobModule() {
  if (!blobModule && USE_BLOB_STORAGE) {
    blobModule = require('@vercel/blob');
  }
  return blobModule;
}

// Blob store prefix for namespacing
const BLOB_PREFIX = 'qsafevault-webrtc-sessions/';

/**
 * Generate a cryptographic hash for key derivation
 * This makes blob keys unpredictable
 */
function deriveSecureKey(...parts) {
  const combined = parts.join(':');
  return crypto.createHash('sha256').update(combined).digest('base64url').slice(0, 32);
}

// Generate a safe storage key from session parameters
function storageKey(prefix, ...parts) {
  const secureHash = deriveSecureKey(prefix, ...parts);
  return `${BLOB_PREFIX}${prefix}/${secureHash}`;
}

// ==================== Storage Operations ====================

// Read data from storage (returns null if not found or expired)
async function readStorage(key) {
  if (USE_BLOB_STORAGE) {
    try {
      const blob = getBlobModule();
      const metadata = await blob.head(key);
      if (!metadata) return null;
      
      const response = await fetch(metadata.url);
      if (!response.ok) return null;
      
      const data = await response.json();
      
      // Check if expired
      if (data.expires && data.expires < now()) {
        await blob.del(key).catch(() => {});
        return null;
      }
      
      return data;
    } catch (e) {
      return null;
    }
  } else {
    // In-memory fallback
    const data = memoryStore.get(key);
    if (!data) return null;
    
    if (data.expires && data.expires < now()) {
      memoryStore.delete(key);
      return null;
    }
    
    return data;
  }
}

// Write data to storage
async function writeStorage(key, data) {
  if (USE_BLOB_STORAGE) {
    const blob = getBlobModule();
    const json = JSON.stringify(data);
    await blob.put(key, json, {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/json',
    });
  } else {
    memoryStore.set(key, data);
  }
}

// Delete data from storage
async function deleteStorage(key) {
  if (USE_BLOB_STORAGE) {
    try {
      const blob = getBlobModule();
      await blob.del(key);
    } catch (e) {
      // Ignore deletion errors
    }
  } else {
    memoryStore.delete(key);
  }
}

// ==================== Session Management ====================

async function createSession(pin) {
  const sessionId = randomUUID();
  const created = now();
  const expires = created + SESS_TTL_MS;
  
  const sessionData = {
    sessionId,
    pin: pin || null,
    created,
    expires,
    offer: null,
    answer: null,
  };
  
  // Store session by sessionId
  const sessionKey = storageKey('session', sessionId);
  await writeStorage(sessionKey, sessionData);
  
  // If pin provided, create pin -> sessionId mapping
  if (pin) {
    const pinKey = storageKey('pin', pin);
    await writeStorage(pinKey, {
      sessionId,
      expires,
    });
  }
  
  return { sessionId, ttlSec: SESS_TTL_SEC };
}

async function getSessionIdByPin(pin) {
  const pinKey = storageKey('pin', pin);
  const pinData = await readStorage(pinKey);
  
  if (!pinData) {
    return { error: 'pin_not_found' };
  }
  
  if (pinData.expires < now()) {
    await deleteStorage(pinKey);
    return { error: 'session_expired' };
  }
  
  // Verify session still exists
  const sessionKey = storageKey('session', pinData.sessionId);
  const sess = await readStorage(sessionKey);
  
  if (!sess || sess.expires < now()) {
    await deleteStorage(pinKey);
    if (sess) await deleteStorage(sessionKey);
    return { error: 'session_expired' };
  }
  
  return { sessionId: pinData.sessionId };
}

async function getSession(sessionId) {
  const sessionKey = storageKey('session', sessionId);
  const sess = await readStorage(sessionKey);
  
  if (!sess) return null;
  
  if (sess.expires < now()) {
    await deleteStorage(sessionKey);
    if (sess.pin) {
      const pinKey = storageKey('pin', sess.pin);
      await deleteStorage(pinKey);
    }
    return null;
  }
  
  return sess;
}

async function saveSession(sessionId, data) {
  const sessionKey = storageKey('session', sessionId);
  const sess = await readStorage(sessionKey);
  
  if (!sess) return false;
  if (sess.expires < now()) {
    await deleteStorage(sessionKey);
    return false;
  }
  
  // Merge data and save
  const updatedSession = { ...sess, ...data };
  await writeStorage(sessionKey, updatedSession);
  return true;
}

async function deleteSession(sessionId) {
  const sessionKey = storageKey('session', sessionId);
  const sess = await readStorage(sessionKey);
  
  if (sess && sess.pin) {
    const pinKey = storageKey('pin', sess.pin);
    await deleteStorage(pinKey);
  }
  
  await deleteStorage(sessionKey);
}

async function purgeExpired() {
  if (USE_BLOB_STORAGE) {
    try {
      const blob = getBlobModule();
      const { blobs } = await blob.list({ prefix: BLOB_PREFIX });
      const cutoff = now();
      
      for (const b of blobs) {
        try {
          const response = await fetch(b.url);
          if (response.ok) {
            const data = await response.json();
            if (data.expires && data.expires < cutoff) {
              await blob.del(b.pathname);
            }
          }
        } catch (e) {
          // Skip blobs that can't be read
        }
      }
    } catch (e) {
      // Ignore purge errors
    }
  } else {
    const cutoff = now();
    for (const [key, data] of memoryStore.entries()) {
      if (data.expires && data.expires < cutoff) {
        memoryStore.delete(key);
      }
    }
  }
}

module.exports = {
  createSession,
  getSessionIdByPin,
  getSession,
  saveSession,
  deleteSession,
  purgeExpired,
  SESS_TTL_SEC,
  USE_BLOB_STORAGE,
};
