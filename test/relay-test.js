/**
 * Relay Sync Tests
 * 
 * Tests for bidirectional relay sync functionality including:
 * - Single-direction transfer
 * - Acknowledgment after completion
 * - Bidirectional reuse of the same invite code
 * - Session lifecycle with completed state
 * - Separate ack key persistence
 * - WebRTC signaling endpoints
 * - 8-character invite code validation
 */

const sessionManager = require('../sessionManager');

// Test utilities
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

function assertFalsy(value, message) {
  if (value) {
    throw new Error(`${message}\nExpected falsy value, got: ${value}`);
  }
}

// Tests
async function testSingleDirectionTransfer() {
  console.log('Test: Single-direction transfer');
  
  const pin = 'Ab3Xy9Zk'; // 8-char alphanumeric
  const passwordHash = 'hash123';
  const chunk0Data = 'chunk0data';
  const chunk1Data = 'chunk1data';
  
  // Push two chunks
  let result = await sessionManager.pushChunk({
    pin, passwordHash, chunkIndex: 0, totalChunks: 2, data: chunk0Data
  });
  assertEqual(result.status, 'waiting', 'First chunk should return waiting');
  
  result = await sessionManager.pushChunk({
    pin, passwordHash, chunkIndex: 1, totalChunks: 2, data: chunk1Data
  });
  assertEqual(result.status, 'waiting', 'Second chunk should return waiting');
  
  // Receive first chunk
  result = await sessionManager.nextChunk({ pin, passwordHash });
  assertEqual(result.status, 'chunkAvailable', 'First nextChunk should return chunkAvailable');
  assertEqual(result.chunk.chunkIndex, 0, 'Should receive chunk 0');
  assertEqual(result.chunk.data, chunk0Data, 'Chunk 0 data should match');
  
  // Receive second chunk
  result = await sessionManager.nextChunk({ pin, passwordHash });
  assertEqual(result.status, 'chunkAvailable', 'Second nextChunk should return chunkAvailable');
  assertEqual(result.chunk.chunkIndex, 1, 'Should receive chunk 1');
  assertEqual(result.chunk.data, chunk1Data, 'Chunk 1 data should match');
  
  // All chunks delivered, should return done
  result = await sessionManager.nextChunk({ pin, passwordHash });
  assertEqual(result.status, 'done', 'All chunks delivered should return done');
  
  console.log('✓ Single-direction transfer test passed');
}

async function testAcknowledgmentAfterCompletion() {
  console.log('Test: Acknowledgment after completion');
  
  const pin = 'xY7mNp2Q';
  const passwordHash = 'hash456';
  const chunkData = 'data';
  
  // Push and receive single chunk
  await sessionManager.pushChunk({
    pin, passwordHash, chunkIndex: 0, totalChunks: 1, data: chunkData
  });
  await sessionManager.nextChunk({ pin, passwordHash });
  
  // Complete the transfer
  let result = await sessionManager.nextChunk({ pin, passwordHash });
  assertEqual(result.status, 'done', 'Transfer should be done');
  
  // Acknowledge should not find the session initially
  let acked = await sessionManager.getAcknowledged(pin, passwordHash);
  assertFalsy(acked, 'Should not be acknowledged yet');
  
  // Set acknowledgment
  await sessionManager.setAcknowledged(pin, passwordHash);
  
  // Check acknowledgment using separate ack key
  acked = await sessionManager.getAcknowledged(pin, passwordHash);
  assertTruthy(acked, 'Should be acknowledged after setting');
  
  console.log('✓ Acknowledgment after completion test passed');
}

async function testBidirectionalTransfer() {
  console.log('Test: Bidirectional transfer with same invite code');
  
  const pin = 'Kj8Lm4Qn';
  const passwordHash1 = 'hashA';
  const passwordHash2 = 'hashB';
  
  // Direction A->B: push and receive
  await sessionManager.pushChunk({
    pin, passwordHash: passwordHash1, chunkIndex: 0, totalChunks: 1, data: 'dataA'
  });
  let result = await sessionManager.nextChunk({ pin, passwordHash: passwordHash1 });
  assertEqual(result.status, 'chunkAvailable', 'Should receive chunk A');
  
  result = await sessionManager.nextChunk({ pin, passwordHash: passwordHash1 });
  assertEqual(result.status, 'done', 'Direction A should be done');
  
  // Acknowledge direction A
  await sessionManager.setAcknowledged(pin, passwordHash1);
  let acked = await sessionManager.getAcknowledged(pin, passwordHash1);
  assertTruthy(acked, 'Direction A should be acknowledged');
  
  // Direction B->A: push and receive (using different passwordHash)
  await sessionManager.pushChunk({
    pin, passwordHash: passwordHash2, chunkIndex: 0, totalChunks: 1, data: 'dataB'
  });
  result = await sessionManager.nextChunk({ pin, passwordHash: passwordHash2 });
  assertEqual(result.status, 'chunkAvailable', 'Should receive chunk B');
  
  result = await sessionManager.nextChunk({ pin, passwordHash: passwordHash2 });
  assertEqual(result.status, 'done', 'Direction B should be done');
  
  // Acknowledge direction B
  await sessionManager.setAcknowledged(pin, passwordHash2);
  acked = await sessionManager.getAcknowledged(pin, passwordHash2);
  assertTruthy(acked, 'Direction B should be acknowledged');
  
  console.log('✓ Bidirectional transfer test passed');
}

async function testDuplicateChunkRejection() {
  console.log('Test: Duplicate chunk rejection');
  
  const pin = 'Wq5Rt8Yz';
  const passwordHash = 'hashY';
  
  // Push first chunk
  let result = await sessionManager.pushChunk({
    pin, passwordHash, chunkIndex: 0, totalChunks: 2, data: 'chunk0'
  });
  assertEqual(result.status, 'waiting', 'First chunk should succeed');
  
  // Try to push same chunk again
  result = await sessionManager.pushChunk({
    pin, passwordHash, chunkIndex: 0, totalChunks: 2, data: 'chunk0duplicate'
  });
  assertEqual(result.error, 'duplicate_chunk', 'Duplicate chunk should be rejected');
  
  console.log('✓ Duplicate chunk rejection test passed');
}

async function testTotalChunksMismatch() {
  console.log('Test: Total chunks mismatch');
  
  const pin = 'Bv6Cn3Dm';
  const passwordHash = 'hashZ';
  
  // Push first chunk with totalChunks=2
  await sessionManager.pushChunk({
    pin, passwordHash, chunkIndex: 0, totalChunks: 2, data: 'chunk0'
  });
  
  // Try to push with different totalChunks
  let result = await sessionManager.pushChunk({
    pin, passwordHash, chunkIndex: 1, totalChunks: 3, data: 'chunk1'
  });
  assertEqual(result.error, 'totalChunks_mismatch', 'Mismatched totalChunks should be rejected');
  
  console.log('✓ Total chunks mismatch test passed');
}

async function testInvalidChunkData() {
  console.log('Test: Invalid chunk data validation');
  
  const pin = 'Fs2Gh7Jk';
  const passwordHash = 'hashW';
  
  // Test missing fields
  let result = await sessionManager.pushChunk({
    pin: null, passwordHash, chunkIndex: 0, totalChunks: 1, data: 'test'
  });
  assertEqual(result.error, 'invalid_chunk', 'Null pin should be rejected');
  
  // Test invalid chunk index
  result = await sessionManager.pushChunk({
    pin, passwordHash, chunkIndex: -1, totalChunks: 1, data: 'test'
  });
  assertEqual(result.error, 'invalid_chunk', 'Negative chunk index should be rejected');
  
  // Test chunk index >= totalChunks
  result = await sessionManager.pushChunk({
    pin, passwordHash, chunkIndex: 2, totalChunks: 2, data: 'test'
  });
  assertEqual(result.error, 'invalid_chunk', 'Chunk index >= totalChunks should be rejected');
  
  console.log('✓ Invalid chunk data validation test passed');
}

// WebRTC Signaling Tests
async function testPeerRegistration() {
  console.log('Test: Peer registration with invite code');
  
  const inviteCode = 'Pq4Rs8Tu';
  const peerId = 'peer-uuid-12345';
  
  // Register peer
  let result = await sessionManager.registerPeer(inviteCode, peerId);
  assertEqual(result.status, 'registered', 'Registration should succeed');
  assertTruthy(result.ttlSec > 0, 'TTL should be returned');
  
  // Lookup peer
  result = await sessionManager.lookupPeer(inviteCode);
  assertEqual(result.peerId, peerId, 'Lookup should return peerId');
  
  console.log('✓ Peer registration test passed');
}

async function testInvalidInviteCodeFormat() {
  console.log('Test: Invalid invite code format rejection');
  
  const peerId = 'peer-uuid-12345';
  
  // Test too short
  let result = await sessionManager.registerPeer('abc', peerId);
  assertEqual(result.error, 'invalid_invite_code', 'Short code should be rejected');
  
  // Test too long
  result = await sessionManager.registerPeer('abcdefghi', peerId);
  assertEqual(result.error, 'invalid_invite_code', 'Long code should be rejected');
  
  // Test invalid characters
  result = await sessionManager.registerPeer('abc-efgh', peerId);
  assertEqual(result.error, 'invalid_invite_code', 'Special chars should be rejected');
  
  console.log('✓ Invalid invite code format test passed');
}

async function testSignalQueueing() {
  console.log('Test: Signal message queueing and polling');
  
  const fromPeer = 'peer-A';
  const toPeer = 'peer-B';
  
  // Queue signals
  let result = await sessionManager.queueSignal({
    from: fromPeer,
    to: toPeer,
    type: 'offer',
    payload: '{"sdp":"..."}',
  });
  assertEqual(result.status, 'queued', 'Signal should be queued');
  
  result = await sessionManager.queueSignal({
    from: fromPeer,
    to: toPeer,
    type: 'ice-candidate',
    payload: '{"candidate":"..."}',
  });
  assertEqual(result.status, 'queued', 'ICE candidate should be queued');
  
  // Poll signals
  result = await sessionManager.pollSignals(toPeer);
  assertEqual(result.messages.length, 2, 'Should receive 2 messages');
  assertEqual(result.messages[0].type, 'offer', 'First message should be offer');
  assertEqual(result.messages[1].type, 'ice-candidate', 'Second message should be ICE');
  
  // Poll again should be empty
  result = await sessionManager.pollSignals(toPeer);
  assertEqual(result.messages.length, 0, 'Queue should be empty after poll');
  
  console.log('✓ Signal queueing test passed');
}

async function testInviteCodeCollision() {
  console.log('Test: Invite code collision handling');
  
  const inviteCode = 'Uv9Wx1Yz';
  const peerId1 = 'peer-first';
  const peerId2 = 'peer-second';
  
  // Register first peer
  let result = await sessionManager.registerPeer(inviteCode, peerId1);
  assertEqual(result.status, 'registered', 'First registration should succeed');
  
  // Try to register different peer with same code
  result = await sessionManager.registerPeer(inviteCode, peerId2);
  assertEqual(result.error, 'invite_code_in_use', 'Second peer should be rejected');
  
  // Same peer re-registering should work
  result = await sessionManager.registerPeer(inviteCode, peerId1);
  assertEqual(result.status, 'registered', 'Same peer re-registration should succeed');
  
  console.log('✓ Invite code collision test passed');
}

// Run all tests
async function runTests() {
  console.log('=== Running Relay Sync Tests ===\n');
  
  try {
    await testSingleDirectionTransfer();
    await testAcknowledgmentAfterCompletion();
    await testBidirectionalTransfer();
    await testDuplicateChunkRejection();
    await testTotalChunksMismatch();
    await testInvalidChunkData();
    await testPeerRegistration();
    await testInvalidInviteCodeFormat();
    await testSignalQueueing();
    await testInviteCodeCollision();
    await testConcurrentChunkWrites();
    
    console.log('\n=== All Tests Passed! ===');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Test Failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

/**
 * Test concurrent chunk writes - simulates cross-device sync scenario
 * where multiple chunks are sent in parallel via Promise.all
 */
async function testConcurrentChunkWrites() {
  console.log('Test: Concurrent chunk writes (cross-device sync)');
  
  const pin = 'Cc8Dd9Ee';
  const passwordHash = `concurrent-${Date.now()}`;
  const numChunks = 3;
  
  // Push all chunks concurrently (simulates Promise.all in the test)
  const pushPromises = [];
  for (let i = 0; i < numChunks; i++) {
    pushPromises.push(
      sessionManager.pushChunk({
        pin,
        passwordHash,
        chunkIndex: i,
        totalChunks: numChunks,
        data: `chunk-data-${i}`,
      })
    );
  }
  
  const pushResults = await Promise.all(pushPromises);
  
  // All pushes should succeed (status: 'waiting')
  pushResults.forEach((result, i) => {
    assertEqual(result.status, 'waiting', `Chunk ${i} push should return waiting`);
    assertFalsy(result.error, `Chunk ${i} push should not have error`);
  });
  
  // Now receive all chunks
  const receivedChunks = [];
  for (let i = 0; i < numChunks; i++) {
    const result = await sessionManager.nextChunk({ pin, passwordHash });
    if (result.status === 'chunkAvailable') {
      receivedChunks.push(result.chunk.chunkIndex);
    }
  }
  
  // Sort and compare
  receivedChunks.sort((a, b) => a - b);
  assertEqual(receivedChunks, [0, 1, 2], 'All chunks should be received');
  
  console.log(`✓ Concurrent chunk writes test passed (${numChunks} chunks)`);
}

// Run tests if called directly
if (require.main === module) {
  runTests();
}

module.exports = { runTests };
