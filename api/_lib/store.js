const { generatePin } = require('./utils');

let upstash = null;
let redis = null;
try {
  const { Redis } = require('@upstash/redis');
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    upstash = new Redis({ url, token });
  }
} catch {
}
let ensureRedis = null;
try {
  const { createClient } = require('redis');
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    const client = createClient({ url: redisUrl });
    ensureRedis = async () => {
      if (!client.isOpen) await client.connect();
      return client;
    };
    redis = { client, ensure: ensureRedis };
  }
} catch {
}

const mem = {
  map: new Map(),
  ttl: new Map(),
  timers: new Map()
};
function memSet(key, val, ttlSec) {
  mem.map.set(key, val);
  const expAt = ttlSec ? Date.now() + ttlSec * 1000 : null;
  if (expAt) mem.ttl.set(key, expAt); else mem.ttl.delete(key);
  if (mem.timers.has(key)) clearTimeout(mem.timers.get(key));
  if (ttlSec) mem.timers.set(key, setTimeout(() => {
    mem.map.delete(key); mem.ttl.delete(key); mem.timers.delete(key);
  }, ttlSec * 1000));
}
function memGet(key) {
  const exp = mem.ttl.get(key);
  if (exp && exp <= Date.now()) { mem.map.delete(key); mem.ttl.delete(key); return null; }
  return mem.map.get(key) ?? null;
}
function memDel(key) {
  mem.map.delete(key); mem.ttl.delete(key);
  if (mem.timers.has(key)) { clearTimeout(mem.timers.get(key)); mem.timers.delete(key); }
}
function memTtl(key) {
  const exp = mem.ttl.get(key);
  if (!exp) return -2;
  const s = Math.floor((exp - Date.now()) / 1000);
  return s >= 0 ? s : -2;
}
function safeParse(s) { try { return JSON.parse(s); } catch { return s; } }

async function kvSet(key, val, ttlSec) {
  if (redis) {
    const c = await redis.ensure();
    const payload = JSON.stringify(val);
    if (ttlSec) return c.set(key, payload, { EX: ttlSec });
    return c.set(key, payload);
  }
  if (upstash) return upstash.set(key, JSON.stringify(val), { ex: ttlSec });
  return memSet(key, val, ttlSec);
}
async function kvGet(key) {
  if (redis) {
    const c = await redis.ensure();
    const out = await c.get(key);
    return out != null ? safeParse(out) : null;
  }
  if (upstash) {
    const out = await upstash.get(key);
    return out ?? null;
  }
  return memGet(key);
}
async function kvDel(key) {
  if (redis) { const c = await redis.ensure(); return c.del(key); }
  if (upstash) return upstash.del(key);
  return memDel(key);
}
async function kvTtl(key) {
  if (redis) { const c = await redis.ensure(); return c.ttl(key); }
  if (upstash) return upstash.ttl(key);
  return memTtl(key);
}
async function kvIncr(key, ttlSec) {
  if (redis) {
    const c = await redis.ensure();
    const v = await c.incr(key);
    if (v === 1 && ttlSec) await c.expire(key, ttlSec);
    return v;
  }
  if (upstash) {
    const v = await upstash.incr(key);
    if (v === 1 && ttlSec) await upstash.expire(key, ttlSec);
    return v;
  }
  const cur = memGet(key);
  const v = (typeof cur === 'number' ? cur : 0) + 1;
  memSet(key, v, ttlSec);
  return v;
}
async function kvSetNx(key, val, ttlSec) {
  if (redis) {
    const c = await redis.ensure();
    const ok = await c.set(key, JSON.stringify(val), { NX: true, EX: ttlSec });
    return ok === 'OK';
  }
  if (upstash) {
    const ok = await upstash.set(key, JSON.stringify(val), { nx: true, ex: ttlSec });
    return ok === 'OK';
  }
  if (mem.map.has(key)) return false;
  memSet(key, val, ttlSec);
  return true;
}
async function kvExpire(key, ttlSec) {
  if (redis) { const c = await redis.ensure(); return c.expire(key, ttlSec); }
  if (upstash) return upstash.expire(key, ttlSec);
  const v = memGet(key);
  if (v == null) return 0;
  memSet(key, v, ttlSec);
  return 1;
}

function sessionKey(id) { return `session:${id}`; }
function pinKey(pin) { return `pin:${pin}`; }
function rlKey(ip) { return `rl:resolve:${ip}`; }

async function createSession(id, saltB64, ttlSec) {
  let pin = null;
  for (let i = 0; i < 20; i++) {
    const p = generatePin();
    const ok = await kvSetNx(pinKey(p), id, ttlSec);
    if (ok) { pin = p; break; }
  }
  if (!pin) throw new Error('pin_pool_exhausted');

  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();
  const sess = {
    id,
    pin,
    saltB64,
    createdAt,
    expiresAt,
    offerEnvelope: null,
    answerEnvelope: null,
    answerDelivered: false
  };
  await kvSet(sessionKey(id), sess, ttlSec);
  return { session: sess, pin };
}

async function getSession(id) {
  return kvGet(sessionKey(id));
}
async function saveSession(sess, ttlOverrideSec) {
  const ttl = ttlOverrideSec ?? await kvTtl(sessionKey(sess.id));
  await kvSet(sessionKey(sess.id), sess, ttl > 0 ? ttl : 1);
}
async function deleteSession(id) {
  return kvDel(sessionKey(id));
}
async function resolvePinOnce(pin) {
  const k = pinKey(pin);
  const sessionId = await kvGet(k);
  await kvDel(k);
  return sessionId;
}

async function getSessionIdByPin(pin) {
  return kvGet(pinKey(pin));
}

async function getSessionTtlSec(id) {
  return kvTtl(sessionKey(id));
}
async function setSessionExpireSoon(id, seconds = 1) {
  return kvExpire(sessionKey(id), seconds);
}

async function rateAllowResolve(ip, max = 30, windowSec = 60) {
  const k = rlKey(ip);
  const v = await kvIncr(k, windowSec);
  return v <= max;
}

module.exports = {
  createSession,
  getSession,
  saveSession,
  deleteSession,
  resolvePinOnce,
  getSessionIdByPin,
  getSessionTtlSec,
  setSessionExpireSoon,
  rateAllowResolve
};
