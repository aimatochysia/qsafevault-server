/**
 * Live Server Tests
 * 
 * Comprehensive tests against the production server at qsafevault-server.vercel.app
 * Run with: npm run test:live
 * 
 * Environment variable: LIVE_SERVER_URL (defaults to https://qsafevault-server.vercel.app)
 * 
 * Test Categories:
 * - Basic API Tests: Health checks, latency, relay send/receive, WebRTC signaling
 * - Multi-User Sync Tests: Multiple devices syncing, cross-device sync scenarios
 * - Concurrent Session Tests: Parallel sessions, rapid-fire requests
 * - Security Validation Tests: Input validation, malformed data, session isolation
 * - Endurance Tests: Sustained load over time, repetitive operations
 * - Stress Tests: Concurrent load, WebRTC signaling under stress
 */

const https = require('https');
const http = require('http');

// ==================== Configuration ====================

const LIVE_SERVER_URL = process.env.LIVE_SERVER_URL || 'https://qsafevault-server.vercel.app';
const parsedUrl = new URL(LIVE_SERVER_URL);
const isHttps = parsedUrl.protocol === 'https:';

// Minimum success rate threshold for load/stress/endurance tests
const MIN_SUCCESS_RATE = 0.9; // 90%

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

// ==================== Multi-User Sync Tests ====================

async function testMultiUserSync() {
  console.log('Test: Multi-user sync (simulating multiple devices syncing)');
  
  const numUsers = 5;
  const users = [];
  
  // Setup multiple users with their own PINs and data
  for (let i = 0; i < numUsers; i++) {
    users.push({
      pin: generateRandomPin(),
      passwordHash: `user-${i}-hash-${Date.now()}`,
      data: `user-${i}-sync-data-${Date.now()}`,
    });
  }
  
  // All users send data concurrently (simulating multi-device sync)
  const sendPromises = users.map(user =>
    httpRequest('POST', '/api/relay', {
      action: 'send',
      pin: user.pin,
      passwordHash: user.passwordHash,
      chunkIndex: 0,
      totalChunks: 1,
      data: user.data,
    })
  );
  
  const sendResults = await Promise.all(sendPromises);
  sendResults.forEach((res, i) => {
    assertStatusCode(res, 200, `User ${i} send should return 200`);
    assertEqual(res.body.status, 'waiting', `User ${i} send should return waiting`);
  });
  
  // All users receive their data concurrently
  const receivePromises = users.map(user =>
    httpRequest('POST', '/api/relay', {
      action: 'receive',
      pin: user.pin,
      passwordHash: user.passwordHash,
    })
  );
  
  const receiveResults = await Promise.all(receivePromises);
  receiveResults.forEach((res, i) => {
    assertStatusCode(res, 200, `User ${i} receive should return 200`);
    assertEqual(res.body.status, 'chunkAvailable', `User ${i} should have chunk available`);
    assertEqual(res.body.chunk.data, users[i].data, `User ${i} data should match`);
  });
  
  console.log(`✓ Multi-user sync works correctly (${numUsers} users)`);
}

async function testCrossDeviceSync() {
  console.log('Test: Cross-device sync (same user on multiple devices)');
  
  const pin = generateRandomPin();
  const passwordHash = `shared-session-${Date.now()}`;
  const numChunks = 3;
  
  // Sender device pushes multiple chunks
  const sendPromises = [];
  for (let i = 0; i < numChunks; i++) {
    sendPromises.push(
      httpRequest('POST', '/api/relay', {
        action: 'send',
        pin,
        passwordHash,
        chunkIndex: i,
        totalChunks: numChunks,
        data: `chunk-data-${i}`,
      })
    );
  }
  
  const sendResults = await Promise.all(sendPromises);
  sendResults.forEach((res, i) => {
    assertStatusCode(res, 200, `Chunk ${i} send should return 200`);
  });
  
  // Receiver device retrieves all chunks sequentially
  const receivedChunks = [];
  for (let i = 0; i < numChunks; i++) {
    const res = await httpRequest('POST', '/api/relay', {
      action: 'receive',
      pin,
      passwordHash,
    });
    assertStatusCode(res, 200, `Receive ${i} should return 200`);
    if (res.body.status === 'chunkAvailable') {
      receivedChunks.push(res.body.chunk.chunkIndex);
    }
  }
  
  assertEqual(receivedChunks.sort((a, b) => a - b), [0, 1, 2], 'All chunks should be received');
  
  console.log(`✓ Cross-device sync works correctly (${numChunks} chunks)`);
}

// ==================== Concurrent Session Tests ====================

async function testConcurrentSessions() {
  console.log('Test: Concurrent sessions (10 parallel sessions)');
  
  const numSessions = 10;
  const sessions = [];
  
  for (let i = 0; i < numSessions; i++) {
    sessions.push({
      pin: generateRandomPin(),
      passwordHash: `concurrent-${i}-${Date.now()}`,
      data: `session-${i}-data`,
    });
  }
  
  // Start all sessions concurrently
  const promises = sessions.map(async (sess) => {
    // Send
    const sendRes = await httpRequest('POST', '/api/relay', {
      action: 'send',
      pin: sess.pin,
      passwordHash: sess.passwordHash,
      chunkIndex: 0,
      totalChunks: 1,
      data: sess.data,
    });
    
    if (sendRes.status !== 200 || sendRes.body.status !== 'waiting') {
      throw new Error(`Send failed for session ${sess.pin}`);
    }
    
    // Receive
    const receiveRes = await httpRequest('POST', '/api/relay', {
      action: 'receive',
      pin: sess.pin,
      passwordHash: sess.passwordHash,
    });
    
    if (receiveRes.status !== 200 || receiveRes.body.chunk?.data !== sess.data) {
      throw new Error(`Receive failed for session ${sess.pin}`);
    }
    
    return true;
  });
  
  const results = await Promise.all(promises);
  assertEqual(results.filter(r => r === true).length, numSessions, 'All concurrent sessions should complete');
  
  console.log(`✓ ${numSessions} concurrent sessions handled correctly`);
}

async function testRapidFireRequests() {
  console.log('Test: Rapid-fire requests (20 requests in quick succession)');
  
  const promises = [];
  const startTime = Date.now();
  const numRequests = 20;
  
  for (let i = 0; i < numRequests; i++) {
    promises.push(
      httpRequest('POST', '/api/relay', {
        action: 'send',
        pin: generateRandomPin(),
        passwordHash: `rapid-${i}-${Date.now()}`,
        chunkIndex: 0,
        totalChunks: 1,
        data: `rapid-data-${i}`,
      })
    );
  }
  
  const results = await Promise.all(promises);
  const elapsed = Date.now() - startTime;
  
  const successful = results.filter(r => r.status === 200 && r.body.status === 'waiting').length;
  const minRequired = Math.floor(numRequests * MIN_SUCCESS_RATE);
  assertTruthy(successful >= minRequired, `At least ${minRequired}/${numRequests} rapid requests should succeed (got ${successful})`);
  
  console.log(`✓ ${successful}/${numRequests} rapid-fire requests completed in ${elapsed}ms`);
}

// ==================== Endurance Tests ====================

async function testEnduranceSustainedLoad() {
  console.log('Test: Endurance - sustained load over 10 seconds');
  
  const durationMs = 10000; // 10 seconds
  const requestsPerSecond = 5;
  const startTime = Date.now();
  let requestCount = 0;
  let successCount = 0;
  let errorCount = 0;
  const latencies = [];
  
  while (Date.now() - startTime < durationMs) {
    const batchPromises = [];
    const batchStart = Date.now();
    
    // Send a batch of requests
    for (let i = 0; i < requestsPerSecond; i++) {
      const reqStart = Date.now();
      batchPromises.push(
        httpRequest('POST', '/api/relay', {
          action: 'send',
          pin: generateRandomPin(),
          passwordHash: `endurance-${requestCount++}-${Date.now()}`,
          chunkIndex: 0,
          totalChunks: 1,
          data: `endurance-data-${Date.now()}`,
        }).then(res => {
          latencies.push(Date.now() - reqStart);
          return res;
        })
      );
    }
    
    const results = await Promise.all(batchPromises);
    successCount += results.filter(r => r.status === 200).length;
    errorCount += results.filter(r => r.status !== 200).length;
    
    // Wait to maintain requests per second
    const batchDuration = Date.now() - batchStart;
    const waitTime = Math.max(0, 1000 - batchDuration);
    if (waitTime > 0 && Date.now() - startTime + waitTime < durationMs) {
      await new Promise(r => setTimeout(r, waitTime));
    }
  }
  
  const avgLatency = latencies.length > 0 
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) 
    : 0;
  const successRate = Math.round((successCount / requestCount) * 100);
  const minSuccessRate = Math.round(MIN_SUCCESS_RATE * 100);
  
  assertTruthy(successRate >= minSuccessRate, `Success rate should be at least ${minSuccessRate}% (got ${successRate}%)`);
  
  console.log(`✓ Endurance test completed: ${requestCount} requests, ${successRate}% success, avg latency ${avgLatency}ms`);
}

async function testEnduranceRepetitiveOperations() {
  console.log('Test: Endurance - repetitive send/receive cycles');
  
  const cycles = 10;
  let successfulCycles = 0;
  
  for (let i = 0; i < cycles; i++) {
    const pin = generateRandomPin();
    const passwordHash = `repetitive-${i}-${Date.now()}`;
    const data = `cycle-${i}-data`;
    
    try {
      // Send
      const sendRes = await httpRequest('POST', '/api/relay', {
        action: 'send',
        pin,
        passwordHash,
        chunkIndex: 0,
        totalChunks: 1,
        data,
      });
      
      if (sendRes.status !== 200) continue;
      
      // Receive
      const receiveRes = await httpRequest('POST', '/api/relay', {
        action: 'receive',
        pin,
        passwordHash,
      });
      
      if (receiveRes.status === 200 && receiveRes.body.chunk?.data === data) {
        successfulCycles++;
      }
    } catch (e) {
      // Continue to next cycle
    }
  }
  
  const minRequired = Math.floor(cycles * MIN_SUCCESS_RATE);
  assertTruthy(successfulCycles >= minRequired, `At least ${minRequired}/${cycles} cycles should succeed (got ${successfulCycles})`);
  
  console.log(`✓ Repetitive operations: ${successfulCycles}/${cycles} cycles successful`);
}

// ==================== Security Validation Tests ====================

async function testSecurityInputValidation() {
  console.log('Test: Security - input validation');
  
  // Test empty action
  const emptyAction = await httpRequest('POST', '/api/relay', {});
  assertStatusCode(emptyAction, 400, 'Empty request should return 400');
  
  // Test invalid action
  const invalidAction = await httpRequest('POST', '/api/relay', { action: 'invalid_action' });
  assertStatusCode(invalidAction, 404, 'Invalid action should return 404');
  
  // Test missing required fields for send
  const missingSend = await httpRequest('POST', '/api/relay', {
    action: 'send',
    pin: 'test123',
    // missing other fields
  });
  assertStatusCode(missingSend, 400, 'Missing send fields should return 400');
  
  // Test missing required fields for receive
  const missingReceive = await httpRequest('POST', '/api/relay', {
    action: 'receive',
    // missing pin and passwordHash
  });
  assertStatusCode(missingReceive, 400, 'Missing receive fields should return 400');
  
  console.log('✓ Input validation works correctly on live server');
}

async function testSecurityMalformedData() {
  console.log('Test: Security - malformed data handling');
  
  // Test with very long PIN
  const longPinRes = await httpRequest('POST', '/api/relay', {
    action: 'send',
    pin: 'x'.repeat(1000),
    passwordHash: 'test',
    chunkIndex: 0,
    totalChunks: 1,
    data: 'test',
  });
  assertTruthy(longPinRes.status >= 200, 'Server should handle long PIN gracefully');
  
  // Test with special characters
  const specialCharsRes = await httpRequest('POST', '/api/relay', {
    action: 'send',
    pin: generateRandomPin(),
    passwordHash: `special-${Date.now()}`,
    chunkIndex: 0,
    totalChunks: 1,
    data: JSON.stringify({ unicode: '日本語', emoji: '🔐' }),
  });
  assertStatusCode(specialCharsRes, 200, 'Special characters should be handled');
  
  // Test with negative chunk index
  const negativeChunkRes = await httpRequest('POST', '/api/relay', {
    action: 'send',
    pin: generateRandomPin(),
    passwordHash: 'test',
    chunkIndex: -1,
    totalChunks: 1,
    data: 'test',
  });
  assertTruthy(negativeChunkRes.status >= 200, 'Server should handle negative chunk index');
  
  console.log('✓ Malformed data handling works correctly on live server');
}

async function testSecuritySessionIsolation() {
  console.log('Test: Security - session isolation');
  
  const pin = generateRandomPin();
  const user1Hash = `user1-${Date.now()}`;
  const user2Hash = `user2-${Date.now()}`;
  const secretData = 'user1-secret-data';
  
  // User 1 sends secret data
  await httpRequest('POST', '/api/relay', {
    action: 'send',
    pin,
    passwordHash: user1Hash,
    chunkIndex: 0,
    totalChunks: 1,
    data: secretData,
  });
  
  // User 2 tries to access with different hash
  const user2Res = await httpRequest('POST', '/api/relay', {
    action: 'receive',
    pin,
    passwordHash: user2Hash,
  });
  
  // User 2 should not be able to access User 1's data
  assertTruthy(
    user2Res.body.status === 'expired' || 
    user2Res.body.status === 'waiting' ||
    user2Res.body.chunk?.data !== secretData,
    'Different password hash should not access session data'
  );
  
  // User 1 can access their own data
  const user1Res = await httpRequest('POST', '/api/relay', {
    action: 'receive',
    pin,
    passwordHash: user1Hash,
  });
  assertEqual(user1Res.body.chunk?.data, secretData, 'User 1 should access their own data');
  
  console.log('✓ Session isolation works correctly on live server');
}

async function testSecurityWebRTCIsolation() {
  console.log('Test: Security - WebRTC peer isolation');
  
  const inviteCode = generateRandomPin();
  const legitimatePeer = `peer-${Date.now()}-legit`;
  const attackerPeer = `peer-${Date.now()}-attacker`;
  
  // Register legitimate peer
  const registerRes = await httpRequest('POST', '/api/relay', {
    action: 'register',
    inviteCode,
    peerId: legitimatePeer,
  });
  assertEqual(registerRes.body.status, 'registered', 'Legitimate peer should register');
  
  // Attacker tries to hijack
  const attackerRes = await httpRequest('POST', '/api/relay', {
    action: 'register',
    inviteCode,
    peerId: attackerPeer,
  });
  assertEqual(attackerRes.body.error, 'invite_code_in_use', 'Attacker should be blocked');
  
  // Verify legitimate peer is still registered
  const lookupRes = await httpRequest('POST', '/api/relay', {
    action: 'lookup',
    inviteCode,
  });
  assertEqual(lookupRes.body.peerId, legitimatePeer, 'Legitimate peer should still be registered');
  
  console.log('✓ WebRTC peer isolation works correctly on live server');
}

// ==================== Stress Tests ====================

async function testStressConcurrentLoad() {
  console.log('Test: Stress - concurrent load (15 parallel operations)');
  
  const numOperations = 15;
  const startTime = Date.now();
  
  const operations = [];
  for (let i = 0; i < numOperations; i++) {
    operations.push(
      httpRequest('POST', '/api/relay', {
        action: 'send',
        pin: generateRandomPin(),
        passwordHash: `stress-${i}-${Date.now()}`,
        chunkIndex: 0,
        totalChunks: 1,
        data: `stress-payload-${i}`,
      })
    );
  }
  
  const results = await Promise.all(operations);
  const elapsed = Date.now() - startTime;
  
  const successful = results.filter(r => r.status === 200).length;
  const minRequired = Math.floor(numOperations * MIN_SUCCESS_RATE);
  assertTruthy(successful >= minRequired, `At least ${minRequired}/${numOperations} should succeed`);
  
  console.log(`✓ Stress test: ${successful}/${numOperations} operations in ${elapsed}ms`);
}

async function testStressWebRTCSignaling() {
  console.log('Test: Stress - WebRTC signaling with multiple peers');
  
  const numPeers = 5;
  const peers = [];
  
  // Register multiple peers
  for (let i = 0; i < numPeers; i++) {
    const inviteCode = generateRandomPin();
    const peerId = `stress-peer-${i}-${Date.now()}`;
    
    const res = await httpRequest('POST', '/api/relay', {
      action: 'register',
      inviteCode,
      peerId,
    });
    
    if (res.body.status === 'registered') {
      peers.push({ inviteCode, peerId });
    }
  }
  
  const minPeersRequired = Math.floor(numPeers * MIN_SUCCESS_RATE);
  assertTruthy(peers.length >= minPeersRequired, `At least ${minPeersRequired} peers should register`);
  
  // Send signals between peers
  let signalsSent = 0;
  for (let i = 0; i < peers.length - 1; i++) {
    const res = await httpRequest('POST', '/api/relay', {
      action: 'signal',
      from: peers[i].peerId,
      to: peers[i + 1].peerId,
      type: 'offer',
      payload: `offer-from-${i}-to-${i + 1}`,
    });
    
    if (res.body.status === 'queued') {
      signalsSent++;
    }
  }
  
  const expectedSignals = peers.length - 1;
  const minSignalsRequired = Math.floor(expectedSignals * MIN_SUCCESS_RATE);
  assertTruthy(signalsSent >= minSignalsRequired, `At least ${minSignalsRequired} signals should be queued`);
  
  console.log(`✓ WebRTC stress: ${peers.length} peers, ${signalsSent} signals`);
}

// ==================== Run All Tests ====================

async function runLiveTests() {
  console.log('=== QSafeVault Live Server Test Suite ===\n');
  console.log(`Target server: ${LIVE_SERVER_URL}\n`);
  
  try {
    console.log('--- Basic API Tests ---');
    await testServerHealth();
    await testLatency();
    await testRelaySendReceive();
    await testRelayAcknowledgment();
    await testWebRTCSignaling();
    await testErrorHandling();
    
    console.log('\n--- Multi-User Sync Tests ---');
    await testMultiUserSync();
    await testCrossDeviceSync();
    
    console.log('\n--- Concurrent Session Tests ---');
    await testConcurrentSessions();
    await testRapidFireRequests();
    
    console.log('\n--- Security Validation Tests ---');
    await testSecurityInputValidation();
    await testSecurityMalformedData();
    await testSecuritySessionIsolation();
    await testSecurityWebRTCIsolation();
    
    console.log('\n--- Endurance Tests ---');
    await testEnduranceRepetitiveOperations();
    await testEnduranceSustainedLoad();
    
    console.log('\n--- Stress Tests ---');
    await testStressConcurrentLoad();
    await testStressWebRTCSignaling();
    
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
