const { getRedisClient } = require('./redisClient');
const LOG_KEY = 'qsv:debuglog';
const LOG_TTL_SEC = 1800;

async function logEvent(event) {
  const redis = getRedisClient();
  const entry = {
    ...event,
    ts: new Date().toISOString(),
  };
  await redis.rPush(LOG_KEY, JSON.stringify(entry));
  await redis.expire(LOG_KEY, LOG_TTL_SEC);
}

async function getLog() {
  const redis = getRedisClient();
  const entries = await redis.lRange(LOG_KEY, 0, -1);
  return entries.map(e => JSON.parse(e));
}

module.exports = { logEvent, getLog };