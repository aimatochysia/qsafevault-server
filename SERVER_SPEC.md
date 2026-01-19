# QSafeVault Server Specification

This document provides a complete specification for implementing a QSafeVault-compatible sync server. By following this specification, developers can build their own server that works with the QSafeVault Flutter application.

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Security Principles](#security-principles)
4. [Storage Backend](#storage-backend)
5. [API Endpoints](#api-endpoints)
6. [Concurrency Handling](#concurrency-handling)
7. [Data Formats](#data-formats)
8. [Error Handling](#error-handling)
9. [Edition System](#edition-system)

---

## Overview

QSafeVault Server is a **zero-knowledge signaling server** that facilitates secure peer-to-peer synchronization between devices. The server never has access to unencrypted vault data—all cryptographic operations occur client-side using FIPS-certified post-quantum algorithms.

### Key Characteristics

- **Stateless relay**: Server acts as a temporary mailbox for encrypted data
- **Ephemeral storage**: All data expires automatically (30-60 seconds TTL)
- **Zero-knowledge**: Server cannot decrypt any payload
- **Multi-tenant**: Supports unlimited concurrent sync sessions
- **Serverless-compatible**: Designed for Vercel/AWS Lambda deployment

---

## Architecture

```
┌─────────────────┐         ┌─────────────────┐
│   Device A      │         │   Device B      │
│  (Flutter App)  │         │  (Flutter App)  │
└────────┬────────┘         └────────┬────────┘
         │                           │
         │  HTTPS (TLS 1.3)          │
         ▼                           ▼
┌─────────────────────────────────────────────┐
│            QSafeVault Server                │
│  ┌───────────────────────────────────────┐  │
│  │         API Layer (Express.js)        │  │
│  │  • Rate limiting (100 req/min/IP)     │  │
│  │  • CORS hardening                     │  │
│  │  • Request size validation            │  │
│  │  • Security headers (Helmet.js)       │  │
│  └───────────────────────────────────────┘  │
│                      │                      │
│  ┌───────────────────────────────────────┐  │
│  │         Session Manager               │  │
│  │  • Chunk-based relay                  │  │
│  │  • WebRTC signaling                   │  │
│  │  • Optimistic concurrency control     │  │
│  └───────────────────────────────────────┘  │
│                      │                      │
│  ┌───────────────────────────────────────┐  │
│  │         Storage Backend               │  │
│  │  • Vercel Blob (production)           │  │
│  │  • In-memory Map (development)        │  │
│  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

### Sync Flow (Device A → Device B)

```
Device A (Sender)              Server                    Device B (Receiver)
     │                           │                              │
     │  1. Generate invite code  │                              │
     │  (8-char alphanumeric)    │                              │
     │                           │                              │
     │  2. POST /api/relay       │                              │
     │     action: "send"        │                              │
     │     chunk[0]              │                              │
     │  ─────────────────────────>                              │
     │                           │                              │
     │  3. POST /api/relay       │                              │
     │     action: "send"        │                              │
     │     chunk[1]              │                              │
     │  ─────────────────────────>                              │
     │                           │                              │
     │  (chunks stored in Blob)  │                              │
     │                           │                              │
     │                           │  4. POST /api/relay          │
     │                           │     action: "receive"        │
     │                           <──────────────────────────────│
     │                           │                              │
     │                           │  5. Return chunk[0]          │
     │                           │──────────────────────────────>
     │                           │                              │
     │                           │  6. POST /api/relay          │
     │                           │     action: "receive"        │
     │                           <──────────────────────────────│
     │                           │                              │
     │                           │  7. Return chunk[1]          │
     │                           │──────────────────────────────>
     │                           │                              │
     │                           │  8. POST /api/relay          │
     │                           │     action: "ack"            │
     │                           <──────────────────────────────│
     │                           │                              │
     │  9. POST /api/relay       │                              │
     │     action: "ack-status"  │                              │
     │  ─────────────────────────>                              │
     │                           │                              │
     │  10. acknowledged: true   │                              │
     │  <─────────────────────────                              │
     │                           │                              │
     │  (Session cleaned up)     │                              │
```

---

## Security Principles

### Zero-Knowledge Design

1. **No account database**: Server does not store user accounts or credentials
2. **No vault data storage**: Only ephemeral encrypted blobs with short TTL
3. **No key generation**: Server never generates cryptographic keys
4. **No decryption capability**: All payloads are opaque to the server
5. **All secrets on devices**: Master keys, encryption keys live only on user devices

### Security Middleware Stack (Applied in Order)

1. **Helmet.js**: Security headers (CSP, HSTS, X-Frame-Options, etc.)
2. **CORS**: Configurable allowed origins
3. **Rate Limiting**: 100 requests/minute per IP address
4. **Request Size Validation**: Per-endpoint size limits
5. **Audit Logging**: Enterprise mode only

### Transport Security

- **TLS 1.3** required for all connections
- **Certificate pinning** recommended for mobile apps
- All payloads are **end-to-end encrypted** before transmission

---

## Storage Backend

### Vercel Blob (Production)

When `BLOB_READ_WRITE_TOKEN` environment variable is set, the server uses Vercel Blob for cross-instance persistence.

```javascript
// Check if Vercel Blob is available
const USE_BLOB_STORAGE = !!process.env.BLOB_READ_WRITE_TOKEN;
```

#### Blob Configuration

```javascript
await blob.put(key, jsonData, {
  access: 'public',
  addRandomSuffix: false,
  allowOverwrite: true,
  contentType: 'application/json',
});
```

#### Key Derivation

Storage keys are derived using SHA-256 to prevent enumeration attacks:

```javascript
function deriveSecureKey(...parts) {
  const combined = parts.join(':');
  return crypto.createHash('sha256')
    .update(combined)
    .digest('base64url')
    .slice(0, 32);
}

function storageKey(prefix, ...parts) {
  const secureHash = deriveSecureKey(prefix, ...parts);
  return `qsafevault-sessions/${prefix}/${secureHash}`;
}
```

### In-Memory Fallback (Development)

When `BLOB_READ_WRITE_TOKEN` is not set, the server uses an in-memory `Map` for storage. This is suitable for local development and testing but **not for production** (data is lost on restart, not shared across instances).

### TTL Configuration

| Data Type | TTL | Purpose |
|-----------|-----|---------|
| Signaling messages | 30 seconds | WebRTC offer/answer/ICE |
| Chunk relay data | 60 seconds | Encrypted vault chunks |
| WebRTC sessions | 180 seconds | Session lifecycle |

---

## API Endpoints

### Base URL

Production: `https://qsafevault-server.vercel.app`  
Local: `http://localhost:3000`

---

### 1. Edition Handshake

**Purpose**: Verify server edition and capabilities before sync.

```
GET /api/v1/edition
```

**Response**:
```json
{
  "edition": "consumer",
  "version": "1.0.0",
  "features": ["chunk_relay", "webrtc_signaling"]
}
```

| Edition | Features |
|---------|----------|
| `consumer` | Stateless relay, ephemeral storage, public deployment |
| `enterprise` | Device registry, audit logging, self-hosted only |

---

### 2. Unified Relay Endpoint

**Purpose**: All chunk-based transfer and WebRTC signaling operations.

```
POST /api/relay
Content-Type: application/json
```

#### Action: `send` (Upload Encrypted Chunk)

**Request**:
```json
{
  "action": "send",
  "pin": "Ab3Cd5Ef",
  "passwordHash": "sha256_of_transfer_password_base64",
  "chunkIndex": 0,
  "totalChunks": 3,
  "data": "base64_encrypted_chunk_data"
}
```

**Response (Success)**:
```json
{
  "status": "waiting"
}
```

**Response (Error)**:
```json
{
  "error": "invalid_chunk",
  "status": "waiting"
}
```

| Field | Type | Constraints |
|-------|------|-------------|
| `pin` | string | 8-char alphanumeric (A-Za-z0-9), case-sensitive |
| `passwordHash` | string | SHA-256 hash of transfer password |
| `chunkIndex` | number | 0 ≤ chunkIndex < totalChunks |
| `totalChunks` | number | 1 ≤ totalChunks ≤ 2048 |
| `data` | string | Base64, max 48KB |

#### Action: `receive` (Poll for Next Chunk)

**Request**:
```json
{
  "action": "receive",
  "pin": "Ab3Cd5Ef",
  "passwordHash": "sha256_of_transfer_password_base64"
}
```

**Response (Chunk Available)**:
```json
{
  "status": "chunkAvailable",
  "chunk": {
    "chunkIndex": 0,
    "totalChunks": 3,
    "data": "base64_encrypted_chunk_data"
  }
}
```

**Response (Waiting)**:
```json
{
  "status": "waiting"
}
```

**Response (All Chunks Delivered)**:
```json
{
  "status": "done"
}
```

**Response (Session Expired)**:
```json
{
  "status": "expired"
}
```

#### Action: `ack` (Acknowledge Receipt)

**Request**:
```json
{
  "action": "ack",
  "pin": "Ab3Cd5Ef",
  "passwordHash": "sha256_of_transfer_password_base64"
}
```

**Response**:
```json
{
  "ok": true
}
```

#### Action: `ack-status` (Check Acknowledgment)

**Request**:
```json
{
  "action": "ack-status",
  "pin": "Ab3Cd5Ef",
  "passwordHash": "sha256_of_transfer_password_base64"
}
```

**Response**:
```json
{
  "acknowledged": true
}
```

#### Action: `register` (Register Peer for WebRTC)

**Request**:
```json
{
  "action": "register",
  "inviteCode": "Ab3Cd5Ef",
  "peerId": "uuid-v4-peer-identifier"
}
```

**Response**:
```json
{
  "status": "registered",
  "ttlSec": 30
}
```

#### Action: `lookup` (Find Peer by Invite Code)

**Request**:
```json
{
  "action": "lookup",
  "inviteCode": "Ab3Cd5Ef"
}
```

**Response (Found)**:
```json
{
  "peerId": "uuid-v4-peer-identifier"
}
```

**Response (Not Found)**:
```json
{
  "error": "peer_not_found"
}
```

#### Action: `signal` (Send WebRTC Signal)

**Request**:
```json
{
  "action": "signal",
  "from": "sender-peer-id",
  "to": "receiver-peer-id",
  "type": "offer",
  "payload": "encrypted_sdp_or_ice_candidate"
}
```

**Response**:
```json
{
  "status": "queued"
}
```

| Signal Type | Description |
|-------------|-------------|
| `offer` | WebRTC SDP offer |
| `answer` | WebRTC SDP answer |
| `ice-candidate` | ICE candidate for NAT traversal |

#### Action: `poll` (Poll for WebRTC Signals)

**Request**:
```json
{
  "action": "poll",
  "peerId": "my-peer-id"
}
```

**Response**:
```json
{
  "messages": [
    {
      "from": "sender-peer-id",
      "type": "offer",
      "payload": "encrypted_sdp",
      "timestamp": 1705123456789
    }
  ]
}
```

---

### 3. WebRTC Session Endpoints

#### Create Session

```
POST /api/v1/sessions
Content-Type: application/json
```

**Request**:
```json
{
  "pin": "optional-8-char-pin"
}
```

**Response**:
```json
{
  "sessionId": "uuid-v4",
  "ttlSec": 180
}
```

#### Resolve Session by PIN

```
GET /api/v1/sessions/resolve?pin=Ab3Cd5Ef
```

**Response (Found)**:
```json
{
  "sessionId": "uuid-v4"
}
```

**Response (Not Found)**:
```json
{
  "error": "pin_not_found"
}
```

#### Post Offer

```
POST /api/v1/sessions/{sessionId}/offer
Content-Type: application/json
```

**Request**:
```json
{
  "version": 1,
  "sessionId": "uuid-v4",
  "nonce": "base64_12-32_chars",
  "ct": "base64_ciphertext_16-65536_chars"
}
```

**Response**:
```json
{
  "status": "ok",
  "ttlSec": 180
}
```

#### Get Offer

```
GET /api/v1/sessions/{sessionId}/offer
```

**Response (Found)**:
```json
{
  "envelope": {
    "version": 1,
    "sessionId": "uuid-v4",
    "nonce": "base64_nonce",
    "ct": "base64_ciphertext"
  }
}
```

**Response (Not Found)**:
```json
{
  "error": "not_found"
}
```

#### Post Answer

```
POST /api/v1/sessions/{sessionId}/answer
Content-Type: application/json
```

Same format as offer endpoint.

#### Get Answer

```
GET /api/v1/sessions/{sessionId}/answer
```

Same format as offer endpoint.

#### Delete Session

```
DELETE /api/v1/sessions/{sessionId}
```

**Response**:
```json
{
  "status": "deleted"
}
```

---

### 4. Device Registry (Enterprise Only)

#### Register Device

```
POST /api/v1/devices
Content-Type: application/json
```

**Request**:
```json
{
  "userId": "user-identifier",
  "deviceId": "device-uuid",
  "onion": "abcdefghijklmnop.onion",
  "port": 8080,
  "ttlSec": 3600
}
```

**Response**:
```json
{
  "status": "ok"
}
```

#### List User Devices

```
GET /api/v1/devices/{userId}
```

**Response**:
```json
{
  "devices": [
    {
      "deviceId": "device-uuid",
      "onion": "abcdefghijklmnop.onion",
      "port": 8080,
      "expires": 1705123456789
    }
  ]
}
```

---

## Concurrency Handling

### Problem: Concurrent Chunk Uploads

When the Flutter app sends multiple chunks in parallel (using `Promise.all` / `Future.wait`), a race condition can occur:

```
Time    Device A (Sender)           Vercel Blob
─────   ─────────────────           ───────────
T1      Send chunk[0] ─────────────> Read session (empty)
T2      Send chunk[1] ─────────────> Read session (empty)
T3      Send chunk[2] ─────────────> Read session (empty)
T4      ◄───────────────────────────  Write {chunks: {0: data}}
T5      ◄───────────────────────────  Write {chunks: {1: data}} ← Overwrites!
T6      ◄───────────────────────────  Write {chunks: {2: data}} ← Overwrites!

Result: Only chunk[2] survives (last write wins)
```

### Solution: Optimistic Concurrency Control

The server implements a retry loop with version-based conflict detection:

```javascript
// Constants for retry behavior
const MAX_PUSH_RETRIES = 5;
const INITIAL_BACKOFF_MS = 50;
const MAX_BACKOFF_MS = 500;
const JITTER_MS = 50;

async function pushChunk({ pin, passwordHash, chunkIndex, totalChunks, data }) {
  const key = sessionKey(pin, passwordHash);
  
  for (let attempt = 0; attempt < MAX_PUSH_RETRIES; attempt++) {
    // 1. Read current session state
    let sess = await readStorage(key);
    
    if (!sess) {
      sess = {
        created: Date.now(),
        expires: Date.now() + 60000,
        totalChunks,
        chunks: {},
        delivered: [],
        version: 0,
      };
    }
    
    // 2. Add chunk and increment version
    const expectedVersion = (sess.version || 0) + 1;
    sess.chunks[chunkIndex] = data;
    sess.version = expectedVersion;
    
    // 3. Write to storage
    await writeStorage(key, sess);
    
    // 4. Verify write succeeded
    const verifySession = await readStorage(key);
    if (verifySession?.chunks[chunkIndex] === data && 
        verifySession.version >= expectedVersion) {
      return { status: 'waiting' };  // Success!
    }
    
    // 5. Conflict detected - retry with exponential backoff
    const backoffMs = Math.min(
      INITIAL_BACKOFF_MS * Math.pow(2, attempt), 
      MAX_BACKOFF_MS
    ) + Math.random() * JITTER_MS;
    
    await new Promise(r => setTimeout(r, backoffMs));
  }
  
  return { error: 'concurrency_conflict', status: 'waiting' };
}
```

### Multi-User Concurrent Sync

The server supports unlimited concurrent sync sessions. Each session is isolated by a unique key derived from `(inviteCode, passwordHash)`:

```
User Pair        Invite Code    Storage Key (SHA-256 hash)
──────────────   ───────────    ──────────────────────────
Alice ↔ Bob      "Xy7Zw9Pq"     sess/a3f8c9d2e1b4...
Carol ↔ Dave     "Mn2Kj5Lp"     sess/7b2e4f1c8a9d...
Eve ↔ Frank      "Qr8St4Uv"     sess/c5d9e3f2a1b6...
```

Since each session has a unique key, there is **no interference** between different sync sessions, even when they occur simultaneously.

### Atomic Read-and-Delete for Signal Polling

To prevent duplicate reads of signaling messages:

```javascript
async function atomicReadAndDelete(key) {
  // 1. Read the data
  const data = await readStorage(key);
  if (!data) return null;
  
  // 2. Delete BEFORE returning
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await blob.del(key);
      return data;  // Only return after successful deletion
    } catch (error) {
      await new Promise(r => setTimeout(r, 50 * (attempt + 1)));
    }
  }
  
  // Delete failed - return null to prevent duplicate reads
  return null;
}
```

---

## Data Formats

### Encrypted Envelope (WebRTC Sessions)

```json
{
  "version": 1,
  "sessionId": "uuid-v4",
  "nonce": "base64_encoded_12-32_bytes",
  "ct": "base64_encoded_aes256gcm_ciphertext"
}
```

| Field | Description |
|-------|-------------|
| `version` | Protocol version (currently 1) |
| `sessionId` | Must match the session being used |
| `nonce` | AES-256-GCM nonce (12-32 bytes, base64) |
| `ct` | Ciphertext (16 bytes - 64KB, base64) |

### Chunk Session Structure (Internal)

```json
{
  "created": 1705123456789,
  "lastTouched": 1705123456789,
  "expires": 1705123516789,
  "totalChunks": 3,
  "chunks": {
    "0": "base64_encrypted_data",
    "1": "base64_encrypted_data"
  },
  "delivered": [0],
  "completed": false,
  "acknowledged": false,
  "version": 5
}
```

### Invite Code Format

- **Length**: 8 characters
- **Character set**: `A-Za-z0-9` (62 possible characters per position)
- **Entropy**: 8 × log₂(62) ≈ 47.6 bits
- **Case-sensitive**: Yes
- **Examples**: `Ab3Cd5Ef`, `Xy7Zw9Pq`, `Mn2Kj5Lp`

---

## Error Handling

### HTTP Status Codes

| Code | Meaning |
|------|---------|
| `200` | Success |
| `400` | Bad request (missing/invalid fields) |
| `404` | Resource not found |
| `405` | Method not allowed |
| `410` | Session expired |
| `429` | Rate limit exceeded |
| `500` | Server error |

### Error Response Format

```json
{
  "error": "error_code",
  "details": "optional_details_string"
}
```

### Common Error Codes

| Code | Description |
|------|-------------|
| `missing_action` | No action specified in request |
| `missing_fields` | Required fields not provided |
| `invalid_chunk` | Chunk validation failed |
| `invalid_envelope` | Envelope format invalid |
| `invalid_invite_code` | Invite code format invalid |
| `invalid_json` | JSON parsing failed |
| `body_too_large` | Request body exceeds limit |
| `session_expired` | Session no longer exists |
| `pin_not_found` | PIN not associated with any session |
| `peer_not_found` | Peer not registered with invite code |
| `invite_code_in_use` | Invite code already registered by another peer |
| `totalChunks_mismatch` | totalChunks changed between requests |
| `duplicate_chunk` | Chunk already uploaded |
| `concurrency_conflict` | All retry attempts failed |
| `unknown_action` | Action not recognized |

---

## Edition System

### Consumer Edition (Default)

- Public deployment allowed (Vercel, Cloudflare, etc.)
- Stateless relay only
- Ephemeral storage (Vercel Blob)
- No device registry
- No audit logging

### Enterprise Edition

Requires `QSAFEVAULT_EDITION=enterprise` environment variable.

- Self-hosted only
- Device registry with Tor onion routing
- Audit logging for compliance
- Extended session TTL options

### Configuration

```bash
# Required for Vercel Blob storage
BLOB_READ_WRITE_TOKEN=vercel_blob_rw_xxx

# Optional: Set to "enterprise" for Enterprise features
QSAFEVAULT_EDITION=consumer

# Optional: Custom allowed origins for CORS
ALLOWED_ORIGINS=https://myapp.com,https://app.mycompany.com
```

---

## Implementation Checklist

To build a QSafeVault-compatible server:

- [ ] Implement `/api/v1/edition` endpoint
- [ ] Implement `/api/relay` with all 8 actions
- [ ] Implement `/api/v1/sessions/*` endpoints
- [ ] Implement storage backend (Vercel Blob or equivalent)
- [ ] Implement optimistic concurrency control for `pushChunk`
- [ ] Implement atomic read-and-delete for signal polling
- [ ] Add rate limiting (100 req/min/IP recommended)
- [ ] Add request size validation
- [ ] Add security headers (Helmet.js or equivalent)
- [ ] Add CORS handling
- [ ] Implement TTL-based expiration (30s signals, 60s chunks)
- [ ] Derive storage keys using SHA-256 for security

---

## Testing

### Recommended Test Scenarios

1. **Basic connectivity**: Health check and edition handshake
2. **Single chunk transfer**: Send one chunk, receive it
3. **Multi-chunk transfer**: Send 3+ chunks, receive all in order
4. **Concurrent chunk upload**: Send 10 chunks via Promise.all
5. **Acknowledgment flow**: Sender waits for receiver ack
6. **Session expiration**: Verify data deleted after TTL
7. **WebRTC signaling**: Register, lookup, signal, poll cycle
8. **Multi-user concurrent sync**: 5+ simultaneous sync sessions
9. **Cross-device sync**: Same user on 3+ devices syncing

### Test Command

```bash
cd qsafevault-server
npm install
npm test           # Unit tests
npm run test:live  # Live server tests
```

---

## License

This specification is part of the QSafeVault project. See the repository LICENSE file for terms.
