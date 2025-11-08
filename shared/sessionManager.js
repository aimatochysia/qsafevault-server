const TTL_MS = Math.max(30000, Math.min(60000, Number(process.env.RELAY_TTL_MS || 60000)));
const sessions = new Map();

function _key(pin, passwordHash) {
  return `${pin}:${passwordHash}`;
}
function _now() { return Date.now(); }
function _expired(s) { return s.expiresAt <= _now(); }

function cleanup() {
  const t = _now();
  for (const [k, s] of sessions) {
    if (s.expiresAt <= t || (s.totalChunks > 0 && s.deliveredCount >= s.totalChunks)) {
      sessions.delete(k);
    }
  }
}

function pushChunk({ pin, passwordHash, chunkIndex, totalChunks, data }) {
  cleanup();
  if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) return { ok: false, error: 'invalid_pin' };
  if (typeof passwordHash !== 'string' || passwordHash.length < 8) return { ok: false, error: 'invalid_password_hash' };
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) return { ok: false, error: 'invalid_chunk_index' };
  if (!Number.isInteger(totalChunks) || totalChunks <= 0 || totalChunks > 10000) return { ok: false, error: 'invalid_total_chunks' };
  if (typeof data !== 'string' || data.length === 0) return { ok: false, error: 'invalid_data' };

  const k = _key(pin, passwordHash);
  let s = sessions.get(k);
  const now = _now();
  if (!s) {
    s = {
      createdAt: now,
      updatedAt: now,
      expiresAt: now + TTL_MS,
      totalChunks,
      receivedCount: 0,
      deliveredCount: 0,
      chunks: new Map()
    };
    sessions.set(k, s);
  }
  if (_expired(s)) return { ok: false, error: 'expired' };

  s.totalChunks = totalChunks;
  if (!s.chunks.has(chunkIndex)) {
    s.chunks.set(chunkIndex, data);
    s.receivedCount += 1;
  }
  s.updatedAt = now;
  s.expiresAt = now + TTL_MS;
  const remaining = Math.max(0, totalChunks - s.receivedCount);
  return { ok: true, remaining, ttlMs: s.expiresAt - now };
}

function nextChunk({ pin, passwordHash }) {
  cleanup();
  const s = sessions.get(_key(pin, passwordHash));
  if (!s) return { status: 'waiting' };
  if (_expired(s)) {
    sessions.delete(_key(pin, passwordHash));
    return { status: 'expired' };
  }
  const indices = Array.from(s.chunks.keys()).sort((a, b) => a - b);
  if (indices.length === 0) {
    if (s.totalChunks > 0 && s.deliveredCount >= s.totalChunks) {
      sessions.delete(_key(pin, passwordHash));
      return { status: 'done' };
    }
    return { status: 'waiting' };
  }
  const idx = indices[0];
  const data = s.chunks.get(idx);
  s.chunks.delete(idx);
  s.deliveredCount += 1;
  s.updatedAt = _now();
  s.expiresAt = s.updatedAt + TTL_MS;

  return {
    status: 'chunkAvailable',
    chunk: {
      chunkIndex: idx,
      totalChunks: s.totalChunks,
      data
    }
  };
}

module.exports = {
  pushChunk,
  nextChunk,
  cleanup,
  TTL_MS
};
