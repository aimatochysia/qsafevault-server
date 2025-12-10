/**
 * Ephemeral in-memory session manager for serverless signaling.
 * No Redis/database dependency - all data is stored in memory with TTL.
 * Simplified to unidirectional transfers only (A→B, no bidirectional sync).
 * 
 * Invite codes are 8-character case-sensitive alphanumeric strings.
 * No password required - just the invite code.
 */

// TTL formula: 30s (user input time) + (chunks * 500ms per chunk)
const USER_INPUT_TIME_MS = 30000; // 30s for user to enter invite code
const CHUNK_TTL_PER_CHUNK_MS = 500; // 500ms per chunk for transfer
const SIGNAL_TTL_MS = 30000; // For WebRTC signaling

/**
 * Calculate dynamic TTL based on total chunks.
 * Formula: 30s (user input) + (chunks * 500ms)
 * @param {number|null} totalChunks - Number of chunks, or null for base TTL
 * @returns {number} TTL in milliseconds
 */
function getChunkTTL(totalChunks) {
  if (!totalChunks || totalChunks <= 0) {
    return USER_INPUT_TIME_MS;
  }
  // 30s for user input + 500ms per chunk
  return USER_INPUT_TIME_MS + (totalChunks * CHUNK_TTL_PER_CHUNK_MS);
}

// In-memory stores (ephemeral, cleared on function cold start)
const sessions = new Map();        // inviteCode -> SessionData
const signalQueues = new Map();    // peerId -> [SignalMessage]

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
}

// ==================== Unidirectional Chunk Relay ====================

async function pushChunk({ pin, chunkIndex, totalChunks, data }) {
  // 'pin' is an 8-character invite code (no password needed)
  const inviteCode = pin;
  
  if (
    typeof inviteCode !== 'string' ||
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
  
  let sess = sessions.get(inviteCode);
  const ttl = getChunkTTL(totalChunks);
  
  if (!sess) {
    // Create new session (unidirectional)
    sess = {
      created: now(),
      lastTouched: now(),
      expires: now() + ttl,
      totalChunks: totalChunks,
      chunks: new Map(),
      delivered: new Set(),
      completed: false,
      ttl, // Store TTL for future refreshes
    };
    sessions.set(inviteCode, sess);
  } else if (sess.totalChunks === null) {
    // Upgrade placeholder session created by receiver
    sess.totalChunks = totalChunks;
    sess.ttl = ttl;
    sess.expires = now() + ttl;
    sess.waitingForSender = false;
  } else if (sess.totalChunks !== totalChunks) {
    // Validate totalChunks matches
    return { error: 'totalChunks_mismatch', status: 'waiting' };
  }
  
  // Check for duplicate
  if (sess.delivered.has(chunkIndex) || sess.chunks.has(chunkIndex)) {
    return { error: 'duplicate_chunk', status: 'waiting' };
  }
  
  sess.chunks.set(chunkIndex, data);
  sess.lastTouched = now();
  sess.expires = now() + (sess.ttl || ttl);
  
  return { status: 'waiting' };
}

async function nextChunk({ pin }) {
  const inviteCode = pin;
  purgeExpired();
  
  let sess = sessions.get(inviteCode);
  
  if (!sess) {
    // Create a placeholder session so the receiver can start waiting
    const ttl = getChunkTTL(null); // Use base TTL for placeholder
    sess = {
      created: now(),
      lastTouched: now(),
      expires: now() + ttl,
      totalChunks: null,
      chunks: new Map(),
      delivered: new Set(),
      completed: false,
      waitingForSender: true,
      ttl,
    };
    sessions.set(inviteCode, sess);
    return { status: 'waiting' };
  }
  
  const sessionTTL = sess.ttl || getChunkTTL(sess.totalChunks);
  
  if (now() - sess.lastTouched > sessionTTL * 2) {
    sessions.delete(inviteCode);
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
    return { status: 'done' };
  }
  
  // Find next available chunk
  if (sess.totalChunks) {
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
  }
  
  // Keep session alive while actively polling
  sess.lastTouched = now();
  sess.expires = now() + sessionTTL;
  
  return { status: 'waiting' };
}

/**
 * Delete a session immediately.
 */
async function deleteSession(pin) {
  const inviteCode = pin;
  purgeExpired();
  
  const deleted = sessions.delete(inviteCode);
  
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

module.exports = {
  // Chunk relay (unidirectional)
  pushChunk,
  nextChunk,
  deleteSession,
  purgeExpired,
  
  // WebRTC signaling
  queueSignal,
  pollSignals,
  registerPeer,
  lookupPeer,
  
  // Constants
  SIGNAL_TTL_MS,
  USER_INPUT_TIME_MS,
  CHUNK_TTL_PER_CHUNK_MS,
  getChunkTTL,
};
