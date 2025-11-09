

const { getRedisClient } = require('./redisClient');
const TTL_MS = 45000;
const TTL_SEC = Math.ceil(TTL_MS / 1000);

function sessionKey(pin, passwordHash) {
  return `qsv:session:${pin}:${passwordHash}`;
}

function chunkKey(pin, passwordHash, chunkIndex) {
  return `qsv:chunk:${pin}:${passwordHash}:${chunkIndex}`;
}

async function purgeExpired() {
}

async function pushChunk({ pin, passwordHash, chunkIndex, totalChunks, data }) {
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
  const redis = getRedisClient();
  const sKey = sessionKey(pin, passwordHash);
  const cKey = chunkKey(pin, passwordHash, chunkIndex);
  let sess = await redis.hGetAll(sKey);
  if (!sess || !sess.totalChunks) {
    await redis.hSet(sKey, {
      created: Date.now(),
      lastTouched: Date.now(),
      totalChunks,
      delivered: JSON.stringify([]),
    });
    await redis.expire(sKey, TTL_SEC);
  } else {
    if (parseInt(sess.totalChunks) !== totalChunks) {
      return { error: 'totalChunks_mismatch', status: 'waiting' };
    }
    const delivered = JSON.parse(sess.delivered || '[]');
    if (delivered.includes(chunkIndex)) {
      return { error: 'duplicate_chunk', status: 'waiting' };
    }
    if (await redis.exists(cKey)) {
      return { error: 'duplicate_chunk', status: 'waiting' };
    }
  }
  await redis.set(cKey, data, { EX: TTL_SEC });
  await redis.hSet(sKey, { lastTouched: Date.now() });
  await redis.expire(sKey, TTL_SEC);
  return { status: 'waiting' };
}

async function nextChunk({ pin, passwordHash }) {
  const redis = getRedisClient();
  const sKey = sessionKey(pin, passwordHash);
  const sess = await redis.hGetAll(sKey);
  if (!sess || !sess.totalChunks) {
    return { status: 'expired' };
  }
  const lastTouched = parseInt(sess.lastTouched || '0');
  if (Date.now() - lastTouched > TTL_MS) {
    await redis.del(sKey);
    for (let i = 0; i < parseInt(sess.totalChunks); ++i) {
      await redis.del(chunkKey(pin, passwordHash, i));
    }
    return { status: 'expired' };
  }
  let found = null;
  for (let i = 0; i < parseInt(sess.totalChunks); ++i) {
    const cKey = chunkKey(pin, passwordHash, i);
    const data = await redis.get(cKey);
    if (data) {
      found = { chunkIndex: i, data };
      await redis.del(cKey);
      let delivered = JSON.parse(sess.delivered || '[]');
      delivered.push(i);
      await redis.hSet(sKey, { delivered: JSON.stringify(delivered), lastTouched: Date.now() });
      await redis.expire(sKey, TTL_SEC);
      return {
        status: 'chunkAvailable',
        chunk: {
          chunkIndex: i,
          totalChunks: parseInt(sess.totalChunks),
          data,
        },
      };
    }
  }
  let delivered = JSON.parse(sess.delivered || '[]');
  if (delivered.length === parseInt(sess.totalChunks)) {
    await redis.del(sKey);
    for (let i = 0; i < parseInt(sess.totalChunks); ++i) {
      await redis.del(chunkKey(pin, passwordHash, i));
    }
    return { status: 'done' };
  }
  return { status: 'waiting' };
}

async function setAcknowledged(pin, passwordHash) {
  const redis = getRedisClient();
  const sKey = sessionKey(pin, passwordHash);
  await redis.hSet(sKey, { acknowledged: '1', lastTouched: Date.now() });
  await redis.expire(sKey, TTL_SEC);
}

async function getAcknowledged(pin, passwordHash) {
  const redis = getRedisClient();
  const sKey = sessionKey(pin, passwordHash);
  const sess = await redis.hGetAll(sKey);
  return sess && sess.acknowledged === '1';
}

module.exports = { pushChunk, nextChunk, purgeExpired, TTL_MS, setAcknowledged, getAcknowledged };
