/**
 * Ephemeral in-memory session manager for serverless signaling.
 * No Redis/database dependency - all data is stored in memory with TTL.
 * Supports both chunk-based relay and WebRTC signaling.
 * 
 * Invite codes are 8-character case-sensitive alphanumeric strings.
 */

// TTL for sessions (30s for signaling, 60s for chunk relay)
const SIGNAL_TTL_MS = 30000;
const CHUNK_TTL_MS = 60000;

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
  
  if (!sess) {
    sess = {
      created: now(),
      lastTouched: now(),
      expires: now() + CHUNK_TTL_MS,
      totalChunks,
      chunks: new Map(),
      delivered: new Set(),
      completed: false,
    };
    sessions.set(key, sess);
  } else {
    if (sess.totalChunks !== totalChunks) {
      return { error: 'totalChunks_mismatch', status: 'waiting' };
    }
    if (sess.delivered.has(chunkIndex) || sess.chunks.has(chunkIndex)) {
      return { error: 'duplicate_chunk', status: 'waiting' };
    }
  }
  
  sess.chunks.set(chunkIndex, data);
  sess.lastTouched = now();
  sess.expires = now() + CHUNK_TTL_MS;
  
  return { status: 'waiting' };
}

async function nextChunk({ pin, passwordHash }) {
  const inviteCode = pin;
  purgeExpired();
  
  const key = sessionKey(inviteCode, passwordHash);
  const sess = sessions.get(key);
  
  if (!sess) {
    return { status: 'expired' };
  }
  
  if (now() - sess.lastTouched > CHUNK_TTL_MS) {
    sessions.delete(key);
    return { status: 'expired' };
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
      sess.expires = now() + CHUNK_TTL_MS;
      
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
  
  return { status: 'waiting' };
}

async function setAcknowledged(pin, passwordHash) {
  const inviteCode = pin;
  purgeExpired();
  
  const key = sessionKey(inviteCode, passwordHash);
  ackStore.set(key, {
    acknowledged: true,
    expires: now() + CHUNK_TTL_MS,
  });
  
  // Update session if exists
  const sess = sessions.get(key);
  if (sess) {
    sess.acknowledged = true;
    sess.lastTouched = now();
    sess.expires = now() + CHUNK_TTL_MS;
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
};
