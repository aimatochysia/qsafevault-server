/**
 * Ephemeral session manager for serverless signaling.
 * Uses Vercel Blob for cross-instance persistence when available,
 * falls back to in-memory storage for local development/testing.
 * Data is automatically deleted after use (single-read) or on expiration.
 * Supports both chunk-based relay and WebRTC signaling.
 * 
 * Invite codes are 8-character case-sensitive alphanumeric strings.
 */

// TTL for sessions (30s for signaling, 60s for chunk relay)
const SIGNAL_TTL_MS = 30000;
const CHUNK_TTL_MS = 60000;

function now() { return Date.now(); }

// ==================== Storage Backend ====================

// Check if Vercel Blob is available
const USE_BLOB_STORAGE = !!process.env.BLOB_READ_WRITE_TOKEN;

// In-memory fallback for local development/testing
const memoryStore = new Map();

// Lazy-load Vercel Blob to avoid errors when not available
let blobModule = null;
function getBlobModule() {
  if (!blobModule && USE_BLOB_STORAGE) {
    blobModule = require('@vercel/blob');
  }
  return blobModule;
}

// Blob store prefix for namespacing
const BLOB_PREFIX = 'qsafevault-sessions/';

// Cryptographic randomization for blob keys (prevents enumeration attacks)
const crypto = require('crypto');

/**
 * Generate a cryptographic hash for key derivation
 * This makes blob keys unpredictable even if invite code is known
 */
function deriveSecureKey(...parts) {
  const combined = parts.join(':');
  return crypto.createHash('sha256').update(combined).digest('base64url').slice(0, 32);
}

// Generate a safe storage key from session parameters
function storageKey(prefix, ...parts) {
  // Use SHA-256 hash of combined parts for secure, unpredictable keys
  const secureHash = deriveSecureKey(prefix, ...parts);
  return `${BLOB_PREFIX}${prefix}/${secureHash}`;
}

// Session key for chunk relay sessions
function sessionKey(inviteCode, passwordHash) {
  return storageKey('sess', inviteCode, passwordHash);
}

// ==================== Storage Operations ====================

// Read data from storage (returns null if not found or expired)
async function readStorage(key) {
  if (USE_BLOB_STORAGE) {
    try {
      const blob = getBlobModule();
      const metadata = await blob.head(key);
      if (!metadata) return null;
      
      // Fetch the actual content
      const response = await fetch(metadata.url);
      if (!response.ok) return null;
      
      const data = await response.json();
      
      // Check if expired
      if (data.expires && data.expires < now()) {
        // Delete expired blob
        await blob.del(key).catch(() => {});
        return null;
      }
      
      return data;
    } catch (e) {
      // Blob not found or error
      return null;
    }
  } else {
    // In-memory fallback
    const data = memoryStore.get(key);
    if (!data) return null;
    
    // Check if expired
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
      addRandomSuffix: false,
      contentType: 'application/json',
    });
  } else {
    // In-memory fallback
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
    // In-memory fallback
    memoryStore.delete(key);
  }
}

// Purge expired entries
async function purgeExpired() {
  const cutoff = now();
  
  if (USE_BLOB_STORAGE) {
    try {
      const blob = getBlobModule();
      const { blobs } = await blob.list({ prefix: BLOB_PREFIX });
      
      for (const b of blobs) {
        try {
          const response = await fetch(b.url);
          if (response.ok) {
            const data = await response.json();
            if (data.expires && data.expires < cutoff) {
              // Use pathname for deletion, not the full URL
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
    // In-memory fallback
    for (const [key, data] of memoryStore.entries()) {
      if (data.expires && data.expires < cutoff) {
        memoryStore.delete(key);
      }
    }
  }
}

// ==================== Chunk-based Relay (legacy compatibility) ====================

async function pushChunk({ pin, passwordHash, chunkIndex, totalChunks, data }) {
  // 'pin' is now an 8-character invite code
  const inviteCode = pin;
  
  if (
    typeof inviteCode !== 'string' ||
    typeof passwordHash !== 'string' ||
    typeof chunkIndex !== 'number' ||
    typeof totalChunks !== 'number' ||
    typeof data !== 'string' ||
    chunkIndex < 0 ||
    chunkIndex >= totalChunks ||
    totalChunks < 1 ||
    totalChunks > 2048 ||
    data.length > 48 * 1024
  ) {
    return { error: 'invalid_chunk', status: 'waiting' };
  }
  
  const key = sessionKey(inviteCode, passwordHash);
  let sess = await readStorage(key);
  
  if (!sess) {
    sess = {
      created: now(),
      lastTouched: now(),
      expires: now() + CHUNK_TTL_MS,
      totalChunks,
      chunks: {},        // Object instead of Map for JSON serialization
      delivered: [],     // Array instead of Set for JSON serialization
      completed: false,
    };
  } else {
    if (sess.totalChunks !== totalChunks) {
      return { error: 'totalChunks_mismatch', status: 'waiting' };
    }
    if (sess.delivered.includes(chunkIndex) || sess.chunks[chunkIndex] !== undefined) {
      return { error: 'duplicate_chunk', status: 'waiting' };
    }
  }
  
  sess.chunks[chunkIndex] = data;
  sess.lastTouched = now();
  sess.expires = now() + CHUNK_TTL_MS;
  
  await writeStorage(key, sess);
  
  return { status: 'waiting' };
}

async function nextChunk({ pin, passwordHash }) {
  const inviteCode = pin;
  
  const key = sessionKey(inviteCode, passwordHash);
  const sess = await readStorage(key);
  
  if (!sess) {
    return { status: 'expired' };
  }
  
  if (now() - sess.lastTouched > CHUNK_TTL_MS) {
    await deleteStorage(key);
    return { status: 'expired' };
  }
  
  // If already completed
  if (sess.completed) {
    const ackKey = storageKey('ack', inviteCode, passwordHash);
    const ack = await readStorage(ackKey);
    if (ack && ack.acknowledged) {
      await deleteStorage(key);
      await deleteStorage(ackKey);
    }
    return { status: 'done' };
  }
  
  // Find next available chunk
  for (let i = 0; i < sess.totalChunks; i++) {
    if (sess.chunks[i] !== undefined && !sess.delivered.includes(i)) {
      const data = sess.chunks[i];
      delete sess.chunks[i];
      sess.delivered.push(i);
      sess.lastTouched = now();
      sess.expires = now() + CHUNK_TTL_MS;
      
      await writeStorage(key, sess);
      
      return {
        status: 'chunkAvailable',
        chunk: {
          chunkIndex: i,
          totalChunks: sess.totalChunks,
          data,
        },
      };
    }
  }
  
  // Check if all chunks delivered
  if (sess.delivered.length === sess.totalChunks) {
    sess.completed = true;
    sess.chunks = {};
    await writeStorage(key, sess);
    return { status: 'done' };
  }
  
  return { status: 'waiting' };
}

async function setAcknowledged(pin, passwordHash) {
  const inviteCode = pin;
  
  const ackKey = storageKey('ack', inviteCode, passwordHash);
  await writeStorage(ackKey, {
    acknowledged: true,
    expires: now() + CHUNK_TTL_MS,
  });
  
  // Update session if exists
  const key = sessionKey(inviteCode, passwordHash);
  const sess = await readStorage(key);
  if (sess) {
    sess.acknowledged = true;
    sess.lastTouched = now();
    sess.expires = now() + CHUNK_TTL_MS;
    await writeStorage(key, sess);
  }
}

async function getAcknowledged(pin, passwordHash) {
  const inviteCode = pin;
  
  const ackKey = storageKey('ack', inviteCode, passwordHash);
  const ack = await readStorage(ackKey);
  if (ack && ack.acknowledged) {
    return true;
  }
  
  const key = sessionKey(inviteCode, passwordHash);
  const sess = await readStorage(key);
  return sess && sess.acknowledged === true;
}

// ==================== WebRTC Signaling ====================

/**
 * Queue a signaling message for a peer.
 * Messages are ephemeral and expire after SIGNAL_TTL_MS.
 */
async function queueSignal({ from, to, type, payload }) {
  if (!from || !to || !type || !payload) {
    return { error: 'missing_fields' };
  }
  
  const queueKey = storageKey('signal', to);
  let queue = await readStorage(queueKey);
  
  if (!queue) {
    queue = {
      messages: [],
      expires: now() + SIGNAL_TTL_MS,
    };
  }
  
  // Filter out expired messages
  queue.messages = queue.messages.filter(m => m.expires > now());
  
  queue.messages.push({
    from,
    type,
    payload,
    timestamp: now(),
    expires: now() + SIGNAL_TTL_MS,
  });
  
  queue.expires = now() + SIGNAL_TTL_MS;
  
  await writeStorage(queueKey, queue);
  
  return { status: 'queued' };
}

/**
 * Poll for signaling messages addressed to a peer.
 * Returns and removes messages from the queue.
 */
async function pollSignals(peerId) {
  const queueKey = storageKey('signal', peerId);
  const queue = await readStorage(queueKey);
  
  if (!queue || queue.messages.length === 0) {
    return { messages: [] };
  }
  
  // Filter out expired messages
  const validMessages = queue.messages.filter(m => m.expires > now());
  
  // Delete the queue after reading (single-use)
  await deleteStorage(queueKey);
  
  return {
    messages: validMessages.map(m => ({
      from: m.from,
      type: m.type,
      payload: m.payload,
      timestamp: m.timestamp,
    })),
  };
}

/**
 * Register a peer with an invite code for discovery.
 * Creates a session that maps inviteCode -> peerId.
 */
async function registerPeer(inviteCode, peerId) {
  if (!inviteCode || !peerId) {
    return { error: 'missing_fields' };
  }
  
  // Validate invite code format: 8 chars, alphanumeric case-sensitive
  if (!/^[A-Za-z0-9]{8}$/.test(inviteCode)) {
    return { error: 'invalid_invite_code' };
  }
  
  const peerKey = storageKey('peer', inviteCode);
  const existing = await readStorage(peerKey);
  
  if (existing && existing.expires > now()) {
    // Check if this is the same peer re-registering
    if (existing.peerId !== peerId) {
      return { error: 'invite_code_in_use' };
    }
  }
  
  await writeStorage(peerKey, {
    peerId,
    created: now(),
    expires: now() + SIGNAL_TTL_MS,
  });
  
  return { status: 'registered', ttlSec: Math.floor(SIGNAL_TTL_MS / 1000) };
}

/**
 * Look up a peer by invite code.
 */
async function lookupPeer(inviteCode) {
  if (!inviteCode) {
    return { error: 'missing_invite_code' };
  }
  
  const peerKey = storageKey('peer', inviteCode);
  const sess = await readStorage(peerKey);
  
  if (!sess || sess.expires < now()) {
    return { error: 'peer_not_found' };
  }
  
  return { peerId: sess.peerId };
}

const TTL_MS = CHUNK_TTL_MS;

module.exports = {
  // Chunk relay (legacy)
  pushChunk,
  nextChunk,
  setAcknowledged,
  getAcknowledged,
  purgeExpired,
  TTL_MS,
  
  // WebRTC signaling
  queueSignal,
  pollSignals,
  registerPeer,
  lookupPeer,
  
  // Constants
  SIGNAL_TTL_MS,
  CHUNK_TTL_MS,
  
  // For debugging
  USE_BLOB_STORAGE,
};
