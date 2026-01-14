/**
 * Live Server Tests
 * 
 * Tests against the production server at qsafevault-server.vercel.app
 * Run with: npm run test:live
 * 
 * Environment variable: LIVE_SERVER_URL (defaults to https://qsafevault-server.vercel.app)
 */

const https = require('https');
const http = require('http');

// ==================== Configuration ====================

const LIVE_SERVER_URL = process.env.LIVE_SERVER_URL || 'https://qsafevault-server.vercel.app';
const parsedUrl = new URL(LIVE_SERVER_URL);
const isHttps = parsedUrl.protocol === 'https:';

// ==================== Test Utilities ====================

async function httpRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const protocol = isHttps ? https : http;
    const req = protocol.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: data ? JSON.parse(data) : null,
          });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy(new Error('Request timeout'));
    });
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`);
  }
}

function assertTruthy(value, message) {
  if (!value) {
    throw new Error(`${message}\nExpected truthy value, got: ${value}`);
  }
}

function assertStatusCode(response, expected, message) {
  if (response.status !== expected) {
    throw new Error(`${message}\nExpected status ${expected}, got ${response.status}\nBody: ${JSON.stringify(response.body)}`);
  }
}

function generateRandomPin() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let result = '';
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// ==================== Live Server API Tests ====================

async function testServerHealth() {
  console.log('Test: Server health check');
  
  const response = await httpRequest('GET', '/api/v1/edition');
  
  assertStatusCode(response, 200, 'Edition endpoint should return 200');
  assertTruthy(response.body.edition, 'Should have edition field');
  assertTruthy(response.body.features, 'Should have features field');
  
  console.log(`✓ Server is healthy (edition: ${response.body.edition})`);
}

async function testRelaySendReceive() {
  console.log('Test: Relay send and receive via API');
  
  const pin = generateRandomPin();
  const passwordHash = 'live-test-hash';
  const testData = 'live-server-test-data-' + Date.now();
  
  // Send a chunk
  const sendResponse = await httpRequest('POST', '/api/relay', {
    action: 'send',
    pin,
    passwordHash,
    chunkIndex: 0,
    totalChunks: 1,
    data: testData,
  });
  
  assertStatusCode(sendResponse, 200, 'Send should return 200');
  assertEqual(sendResponse.body.status, 'waiting', 'Send should return waiting status');
  
  // Receive the chunk
  const receiveResponse = await httpRequest('POST', '/api/relay', {
    action: 'receive',
    pin,
    passwordHash,
  });
  
  assertStatusCode(receiveResponse, 200, 'Receive should return 200');
  assertEqual(receiveResponse.body.status, 'chunkAvailable', 'Should have chunk available');
  assertEqual(receiveResponse.body.chunk.data, testData, 'Data should match');
  
  console.log('✓ Relay send/receive works on live server');
}

async function testRelayAcknowledgment() {
  console.log('Test: Relay acknowledgment via API');
  
  const pin = generateRandomPin();
  const passwordHash = 'live-ack-test';
  
  // Set acknowledgment
  const ackResponse = await httpRequest('POST', '/api/relay', {
    action: 'ack',
    pin,
    passwordHash,
  });
  
  assertStatusCode(ackResponse, 200, 'Ack should return 200');
  assertEqual(ackResponse.body.ok, true, 'Ack should return ok: true');
  
  // Check acknowledgment status
  const statusResponse = await httpRequest('POST', '/api/relay', {
    action: 'ack-status',
    pin,
    passwordHash,
  });
  
  assertStatusCode(statusResponse, 200, 'Ack-status should return 200');
  assertEqual(statusResponse.body.acknowledged, true, 'Should be acknowledged');
  
  console.log('✓ Relay acknowledgment works on live server');
}

async function testWebRTCSignaling() {
  console.log('Test: WebRTC signaling via API');
  
  const inviteCode = generateRandomPin();
  const peerId = 'live-test-peer-' + Date.now();
  
  // Register peer
  const registerResponse = await httpRequest('POST', '/api/relay', {
    action: 'register',
    inviteCode,
    peerId,
  });
  
  assertStatusCode(registerResponse, 200, 'Register should return 200');
  assertEqual(registerResponse.body.status, 'registered', 'Should be registered');
  
  // Lookup peer
  const lookupResponse = await httpRequest('POST', '/api/relay', {
    action: 'lookup',
    inviteCode,
  });
  
  assertStatusCode(lookupResponse, 200, 'Lookup should return 200');
  assertEqual(lookupResponse.body.peerId, peerId, 'PeerId should match');
  
  console.log('✓ WebRTC signaling works on live server');
}

async function testErrorHandling() {
  console.log('Test: API error handling');
  
  // Missing action
  const noAction = await httpRequest('POST', '/api/relay', {});
  assertStatusCode(noAction, 400, 'Missing action should return 400');
  
  // Unknown action
  const unknownAction = await httpRequest('POST', '/api/relay', { action: 'unknown' });
  assertStatusCode(unknownAction, 404, 'Unknown action should return 404');
  
  // 404 for unknown routes
  const notFound = await httpRequest('GET', '/api/unknown/route');
  assertStatusCode(notFound, 404, 'Unknown route should return 404');
  
  console.log('✓ Error handling works on live server');
}

async function testLatency() {
  console.log('Test: API latency measurement');
  
  const start = Date.now();
  const response = await httpRequest('GET', '/api/v1/edition');
  const latency = Date.now() - start;
  
  assertStatusCode(response, 200, 'Edition endpoint should return 200');
  console.log(`✓ API latency: ${latency}ms`);
}

// ==================== Run All Tests ====================

async function runLiveTests() {
  console.log('=== QSafeVault Live Server Test Suite ===\n');
  console.log(`Target server: ${LIVE_SERVER_URL}\n`);
  
  try {
    await testServerHealth();
    await testLatency();
    await testRelaySendReceive();
    await testRelayAcknowledgment();
    await testWebRTCSignaling();
    await testErrorHandling();
    
    console.log('\n=== All Live Server Tests Passed! ===');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Test Failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run tests if called directly
if (require.main === module) {
  runLiveTests();
}

module.exports = { runLiveTests };
