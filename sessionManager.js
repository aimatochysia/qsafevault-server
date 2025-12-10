/**
 * Ephemeral in-memory session manager for serverless signaling.
 * No Redis/database dependency - all data is stored in memory with TTL.
 * Supports both chunk-based relay and WebRTC signaling.
 * 
 * Invite codes are 8-character case-sensitive alphanumeric strings.
 */

// TTL for sessions (30s for signaling, base 60s for chunk relay)
const SIGNAL_TTL_MS = 30000;
const CHUNK_TTL_BASE_MS = 60000;
const CHUNK_TTL_PER_CHUNK_MS = 500; // Add 500ms per chunk for large transfers

/**
 * Calculate dynamic TTL based on total chunks.
 * Larger transfers get more time to complete.
 * @param {number|null} totalChunks - Number of chunks, or null for base TTL
 * @returns {number} TTL in milliseconds
 */
function getChunkTTL(totalChunks) {
  if (!totalChunks || totalChunks <= 0) {
    return CHUNK_TTL_BASE_MS;
  }
  // Base 60s + 500ms per chunk, max 180s
  const dynamic = CHUNK_TTL_BASE_MS + (totalChunks * CHUNK_TTL_PER_CHUNK_MS);
  return Math.min(dynamic, 180000); // Cap at 3 minutes
}

// In-memory stores (ephemeral, cleared on function cold start)
const sessions = new Map();        // inviteCode -> SessionData
const signalQueues = new Map();    // peerId -> [SignalMessage]
const ackStore = new Map();        // inviteCode:passwordHash -> { acknowledged, expires }

function now() { return Date.now(); }

// Purge expired entries from all stores
function purgeExpired() {
  const cutoff = now();
  
  // Purge expired sessions
  for (const [key, sess] of sessions.entries()) {
    if (sess.expires < cutoff) {
      sessions.delete(key);
    }
  }
  
  // Purge expired signal queues
  for (const [peerId, queue] of signalQueues.entries()) {
    const filtered = queue.filter(msg => msg.expires > cutoff);
    if (filtered.length === 0) {
      signalQueues.delete(peerId);
    } else {
      signalQueues.set(peerId, filtered);
    }
  }
  
  // Purge expired ack entries
  for (const [key, ack] of ackStore.entries()) {
    if (ack.expires < cutoff) {
      ackStore.delete(key);
    }
  }
}

// Use a separator that cannot appear in base64-encoded passwordHash or alphanumeric invite codes
function sessionKey(inviteCode, passwordHash) {
  // Both inviteCode (alphanumeric) and passwordHash (base64) are URL-safe
  // Using a null character as separator to avoid any possible collision
  return `sess\x00${inviteCode}\x00${passwordHash}`;
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
  
  purgeExpired();
  
  const key = sessionKey(inviteCode, passwordHash);
  let sess = sessions.get(key);
  const ttl = getChunkTTL(totalChunks);
  
  if (!sess) {
    sess = {
      created: now(),
      lastTouched: now(),
      expires: now() + ttl,
      totalChunks,
      chunks: new Map(),
      delivered: new Set(),
      completed: false,
      ttl, // Store TTL for future refreshes
    };
    sessions.set(key, sess);
  } else {
    // If session was created by receiver waiting for sender, set totalChunks now
    if (sess.waitingForSender && sess.totalChunks === null) {
      sess.totalChunks = totalChunks;
      sess.waitingForSender = false;
      sess.ttl = ttl;
    } else if (sess.totalChunks !== totalChunks) {
      return { error: 'totalChunks_mismatch', status: 'waiting' };
    }
    if (sess.delivered.has(chunkIndex) || sess.chunks.has(chunkIndex)) {
      return { error: 'duplicate_chunk', status: 'waiting' };
    }
  }
  
  sess.chunks.set(chunkIndex, data);
  sess.lastTouched = now();
  sess.expires = now() + (sess.ttl || ttl);
  
  return { status: 'waiting' };
}

async function nextChunk({ pin, passwordHash }) {
  const inviteCode = pin;
  purgeExpired();
  
  const key = sessionKey(inviteCode, passwordHash);
  let sess = sessions.get(key);
  
  if (!sess) {
    // Create a placeholder session so the receiver can start waiting
    // before the sender pushes chunks. This supports bidirectional sync
    // where the original sender becomes receiver and starts polling
    // before the original receiver starts pushing return data.
    const ttl = getChunkTTL(null); // Use base TTL for placeholder
    sess = {
      created: now(),
      lastTouched: now(),
      expires: now() + ttl,
      totalChunks: null, // Will be set when first chunk arrives
      chunks: new Map(),
      delivered: new Set(),
      completed: false,
      waitingForSender: true, // Mark as waiting for sender to push chunks
      ttl,
    };
    sessions.set(key, sess);
    return { status: 'waiting' };
  }
  
  const sessionTTL = sess.ttl || getChunkTTL(sess.totalChunks);
  
  if (now() - sess.lastTouched > sessionTTL) {
    sessions.delete(key);
    return { status: 'expired' };
  }
  
  // If still waiting for sender to push first chunk
  if (sess.waitingForSender && sess.totalChunks === null) {
    sess.lastTouched = now();
    sess.expires = now() + sessionTTL;
    return { status: 'waiting' };
  }
  
  // If already completed
  if (sess.completed) {
    const ackKey = sessionKey(inviteCode, passwordHash);
    const ack = ackStore.get(ackKey);
    if (ack && ack.acknowledged) {
      sessions.delete(key);
      ackStore.delete(ackKey);
    }
    return { status: 'done' };
  }
  
  // Find next available chunk
  for (let i = 0; i < sess.totalChunks; i++) {
    if (sess.chunks.has(i) && !sess.delivered.has(i)) {
      const data = sess.chunks.get(i);
      sess.chunks.delete(i);
      sess.delivered.add(i);
      sess.lastTouched = now();
      sess.expires = now() + sessionTTL;
      
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
  if (sess.delivered.size === sess.totalChunks) {
    sess.completed = true;
    sess.chunks.clear();
    return { status: 'done' };
  }
  
  // Keep session alive while actively polling
  sess.lastTouched = now();
  sess.expires = now() + sessionTTL;
  
  return { status: 'waiting' };
}

async function setAcknowledged(pin, passwordHash) {
  const inviteCode = pin;
  purgeExpired();
  
  const key = sessionKey(inviteCode, passwordHash);
  const ttl = getChunkTTL(null); // Use base TTL for acks
  ackStore.set(key, {
    acknowledged: true,
    expires: now() + ttl,
  });
  
  // Update session if exists
  const sess = sessions.get(key);
  if (sess) {
    sess.acknowledged = true;
    sess.lastTouched = now();
    sess.expires = now() + (sess.ttl || ttl);
  }
}

async function getAcknowledged(pin, passwordHash) {
  const inviteCode = pin;
  purgeExpired();
  
  const key = sessionKey(inviteCode, passwordHash);
  const ack = ackStore.get(key);
  if (ack && ack.acknowledged) {
    return true;
  }
  
  const sess = sessions.get(key);
  return sess && sess.acknowledged === true;
}

/**
 * Mark a session as complete and schedule it for cleanup.
 * This is called by clients when they've successfully completed
 * a bidirectional sync and want to clean up resources.
 */
async function markComplete(pin, passwordHash) {
  const inviteCode = pin;
  purgeExpired();
  
  const key = sessionKey(inviteCode, passwordHash);
  const sess = sessions.get(key);
  
  if (sess) {
    sess.completed = true;
    sess.chunks.clear();
    // Set short expiry (10s) for completed sessions
    sess.expires = now() + 10000;
    return { status: 'marked_complete' };
  }
  
  return { status: 'not_found' };
}

/**
 * Delete a session immediately.
 * This is called by clients when they want to forcefully clean up.
 */
async function deleteSession(pin, passwordHash) {
  const inviteCode = pin;
  purgeExpired();
  
  const key = sessionKey(inviteCode, passwordHash);
  const deleted = sessions.delete(key);
  ackStore.delete(key);
  
  return { status: deleted ? 'deleted' : 'not_found' };
}

// ==================== WebRTC Signaling ====================

/**
 * Queue a signaling message for a peer.
 * Messages are ephemeral and expire after SIGNAL_TTL_MS.
 */
function queueSignal({ from, to, type, payload }) {
  purgeExpired();
  
  if (!from || !to || !type || !payload) {
    return { error: 'missing_fields' };
  }
  
  let queue = signalQueues.get(to);
  if (!queue) {
    queue = [];
    signalQueues.set(to, queue);
  }
  
  queue.push({
    from,
    type,
    payload,
    timestamp: now(),
    expires: now() + SIGNAL_TTL_MS,
  });
  
  return { status: 'queued' };
}

/**
 * Poll for signaling messages addressed to a peer.
 * Returns and removes messages from the queue.
 */
function pollSignals(peerId) {
  purgeExpired();
  
  const queue = signalQueues.get(peerId);
  if (!queue || queue.length === 0) {
    return { messages: [] };
  }
  
  const messages = queue.splice(0, queue.length);
  signalQueues.delete(peerId);
  
  return {
    messages: messages.map(m => ({
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
function registerPeer(inviteCode, peerId) {
  purgeExpired();
  
  if (!inviteCode || !peerId) {
    return { error: 'missing_fields' };
  }
  
  // Validate invite code format: 8 chars, alphanumeric case-sensitive
  if (!/^[A-Za-z0-9]{8}$/.test(inviteCode)) {
    return { error: 'invalid_invite_code' };
  }
  
  const existing = sessions.get(`peer:${inviteCode}`);
  if (existing && existing.expires > now()) {
    // Check if this is the same peer re-registering
    if (existing.peerId !== peerId) {
      return { error: 'invite_code_in_use' };
    }
  }
  
  sessions.set(`peer:${inviteCode}`, {
    peerId,
    created: now(),
    expires: now() + SIGNAL_TTL_MS,
  });
  
  return { status: 'registered', ttlSec: Math.floor(SIGNAL_TTL_MS / 1000) };
}

/**
 * Look up a peer by invite code.
 */
function lookupPeer(inviteCode) {
  purgeExpired();
  
  if (!inviteCode) {
    return { error: 'missing_invite_code' };
  }
  
  const sess = sessions.get(`peer:${inviteCode}`);
  if (!sess || sess.expires < now()) {
    return { error: 'peer_not_found' };
  }
  
  return { peerId: sess.peerId };
}

const TTL_MS = CHUNK_TTL_BASE_MS; // Backward compatibility

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
  
  // Completion and cleanup
  markComplete,
  deleteSession,
  
  // Constants
  SIGNAL_TTL_MS,
  CHUNK_TTL_BASE_MS,
  getChunkTTL,
};
