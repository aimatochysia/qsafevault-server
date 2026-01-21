/**
 * Device Registry for Enterprise Edition
 * 
 * Uses Vercel Blob for cross-instance persistence when available,
 * falls back to in-memory storage for local development/testing.
 * 
 * ENTERPRISE ONLY: This endpoint requires Enterprise mode.
 */

const crypto = require('crypto');

// ==================== Storage Backend ====================

const USE_BLOB_STORAGE = !!process.env.BLOB_READ_WRITE_TOKEN;

// In-memory fallback for local development/testing
const memoryStore = new Map();

// Lazy-load Vercel Blob
let blobModule = null;
function getBlobModule() {
  if (!blobModule && USE_BLOB_STORAGE) {
    blobModule = require('@vercel/blob');
  }
  return blobModule;
}

const BLOB_PREFIX = 'qsafevault-devices/';

function deriveSecureKey(...parts) {
  const combined = parts.join(':');
  return crypto.createHash('sha256').update(combined).digest('base64url').slice(0, 32);
}

function storageKey(userId) {
  const secureHash = deriveSecureKey('devices', userId);
  return `${BLOB_PREFIX}${secureHash}`;
}

function now() { return Date.now(); }

// ==================== Storage Operations ====================

async function readStorage(key) {
  if (USE_BLOB_STORAGE) {
    try {
      const blob = getBlobModule();
      const metadata = await blob.head(key);
      if (!metadata) return null;
      
      const response = await fetch(metadata.url);
      if (!response.ok) return null;
      
      return await response.json();
    } catch (e) {
      return null;
    }
  } else {
    return memoryStore.get(key) || null;
  }
}

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

// ==================== Validation ====================

function validateOnion(onion) {
  return typeof onion === 'string' && /^[a-z2-7]{16,56}\.onion$/.test(onion);
}

// ==================== Device Management ====================

async function getDevices(userId) {
  const key = storageKey(userId);
  const data = await readStorage(key);
  if (!data || !data.devices) return [];
  
  // Filter expired devices
  const nowVal = now();
  return data.devices.filter(d => !d.expires || d.expires > nowVal);
}

async function saveDevices(userId, devices) {
  const key = storageKey(userId);
  await writeStorage(key, { devices, updated: now() });
}

// ==================== HTTP Handlers ====================

async function registerDevice(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end();
    return;
  }
  
  try {
    // Validate req.body exists (Express should have parsed it)
    if (!req.body || typeof req.body !== 'object') {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'invalid_json' }));
      return;
    }
    
    const input = req.body;
    
    const { userId, deviceId, onion, port, ttlSec } = input;
    if (!userId || !deviceId || !validateOnion(onion)) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'invalid_input' }));
      return;
    }
    
    const expires = ttlSec 
      ? now() + Math.min(86400, Math.max(30, ttlSec)) * 1000 
      : now() + 180 * 1000;
    
    const entry = { deviceId, onion, port, expires };
    
    // Get existing devices and filter expired
    const devices = await getDevices(userId);
    
    // Update or add device
    const idx = devices.findIndex(d => d.deviceId === deviceId);
    if (idx >= 0) {
      devices[idx] = entry;
    } else {
      devices.push(entry);
    }
    
    await saveDevices(userId, devices);
    
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ status: 'ok' }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'server_error' }));
  }
}

module.exports = { registerDevice, getDevices };
