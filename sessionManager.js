
const TTL_MS = 45000;
const CLEANUP_INTERVAL = 10000;

const sessions = new Map();

function sessionKey(pin, passwordHash) {
  return `${pin}:${passwordHash}`;
}

function now() {
  return Date.now();
}

function purgeExpired() {
  const cutoff = now() - TTL_MS;
  for (const [key, sess] of sessions.entries()) {
    if (sess.lastTouched < cutoff) {
      sessions.delete(key);
    }
  }
}

setInterval(purgeExpired, CLEANUP_INTERVAL);

function pushChunk({ pin, passwordHash, chunkIndex, totalChunks, data }) {
  if (
    typeof pin !== 'string' ||
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
  const key = sessionKey(pin, passwordHash);
  let sess = sessions.get(key);
  if (!sess) {
    sess = {
      created: now(),
      lastTouched: now(),
      totalChunks,
      chunks: new Map(),
      delivered: new Set(),
    };
    sessions.set(key, sess);
  } else {
    if (sess.totalChunks !== totalChunks) {
      return { error: 'totalChunks_mismatch', status: 'waiting' };
    }
    if (sess.chunks.has(chunkIndex) || sess.delivered.has(chunkIndex)) {
      return { error: 'duplicate_chunk', status: 'waiting' };
    }
  }
  sess.chunks.set(chunkIndex, data);
  sess.lastTouched = now();
  purgeExpired();
  return { status: 'waiting' };
}

function nextChunk({ pin, passwordHash }) {
  const key = sessionKey(pin, passwordHash);
  const sess = sessions.get(key);
  if (!sess) {
    return { status: 'expired' };
  }
  if (now() - sess.lastTouched > TTL_MS) {
    sessions.delete(key);
    return { status: 'expired' };
  }
  const pending = Array.from(sess.chunks.keys()).sort((a, b) => a - b);
  if (pending.length > 0) {
    const chunkIndex = pending[0];
    const data = sess.chunks.get(chunkIndex);
    sess.chunks.delete(chunkIndex);
    sess.delivered.add(chunkIndex);
    sess.lastTouched = now();
    purgeExpired();
    return {
      status: 'chunkAvailable',
      chunk: {
        chunkIndex,
        totalChunks: sess.totalChunks,
        data,
      },
    };
  }
  if (sess.delivered.size === sess.totalChunks) {
    sessions.delete(key);
    return { status: 'done' };
  }
  return { status: 'waiting' };
}

module.exports = { pushChunk, nextChunk, purgeExpired, TTL_MS };
