/**
 * Relay Sync Tests
 * 
 * Tests for bidirectional relay sync functionality including:
 * - Single-direction transfer
 * - Acknowledgment after completion
 * - Bidirectional reuse of the same PIN
 * - Session lifecycle with completed state
 * - Separate ack key persistence
 */

// Mock Redis client must be set up BEFORE requiring sessionManager
let mockRedis = null;

// Helper to create a mock Redis client
function createMockRedis() {
  const storage = new Map();
  const expirations = new Map();
  
  return {
    storage,
    expirations,
    
    async hSet(key, obj) {
      if (!storage.has(key)) {
        storage.set(key, {});
      }
      Object.assign(storage.get(key), obj);
      return 1;
    },
    
    async hGetAll(key) {
      return storage.get(key) || {};
    },
    
    async set(key, value, options) {
      storage.set(key, value);
      if (options && options.EX) {
        expirations.set(key, Date.now() + options.EX * 1000);
      }
      return 'OK';
    },
    
    async get(key) {
      // Check if expired
      if (expirations.has(key) && Date.now() > expirations.get(key)) {
        storage.delete(key);
        expirations.delete(key);
        return null;
      }
      return storage.get(key) || null;
    },
    
    async del(...keys) {
      let count = 0;
      for (const key of keys) {
        if (storage.delete(key)) count++;
        expirations.delete(key);
      }
      return count;
    },
    
    async expire(key, seconds) {
      if (storage.has(key)) {
        expirations.set(key, Date.now() + seconds * 1000);
        return 1;
      }
      return 0;
    },
    
    async exists(key) {
      return storage.has(key) ? 1 : 0;
    },
    
    // Test helper to simulate time passing
    simulateExpiration(key) {
      if (expirations.has(key)) {
        expirations.set(key, Date.now() - 1000);
      }
    },
    
    // Test helper to clear all data
    reset() {
      storage.clear();
      expirations.clear();
    }
  };
}

// Setup mock before requiring modules
mockRedis = createMockRedis();

// Mock the redisClient module
const Module = require('module');
const originalRequire = Module.prototype.require;

Module.prototype.require = function(id) {
  if (id === './redisClient' || id === '../redisClient') {
    return {
      getRedisClient: () => mockRedis
    };
  }
  return originalRequire.apply(this, arguments);
};

// NOW we can require sessionManager
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
  mockRedis.reset();
  
  const pin = '123456';
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
  
  // All chunks delivered, should return done but session should still exist
  result = await sessionManager.nextChunk({ pin, passwordHash });
  assertEqual(result.status, 'done', 'All chunks delivered should return done');
  
  // Session should still exist (marked as completed)
  const sKey = `qsv:session:${pin}:${passwordHash}`;
  const sess = mockRedis.storage.get(sKey);
  assertTruthy(sess, 'Session should still exist after completion');
  assertEqual(sess.completed, '1', 'Session should be marked as completed');
  
  console.log('✓ Single-direction transfer test passed');
}

async function testAcknowledgmentAfterCompletion() {
  console.log('Test: Acknowledgment after completion');
  mockRedis.reset();
  
  const pin = '789012';
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
  
  // Verify ack key exists separately
  const aKey = `qsv:ack:${pin}:${passwordHash}`;
  const ackValue = mockRedis.storage.get(aKey);
  assertEqual(ackValue, '1', 'Separate ack key should exist');
  
  console.log('✓ Acknowledgment after completion test passed');
}

async function testBidirectionalTransfer() {
  console.log('Test: Bidirectional transfer with same PIN');
  mockRedis.reset();
  
  const pin = '345678';
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
  
  // Verify both ack keys exist
  const aKeyA = `qsv:ack:${pin}:${passwordHash1}`;
  const aKeyB = `qsv:ack:${pin}:${passwordHash2}`;
  assertTruthy(mockRedis.storage.get(aKeyA), 'Ack key A should exist');
  assertTruthy(mockRedis.storage.get(aKeyB), 'Ack key B should exist');
  
  console.log('✓ Bidirectional transfer test passed');
}

async function testSessionCleanupAfterAck() {
  console.log('Test: Session cleanup after acknowledgment');
  mockRedis.reset();
  
  const pin = '111111';
  const passwordHash = 'hashX';
  
  // Complete transfer
  await sessionManager.pushChunk({
    pin, passwordHash, chunkIndex: 0, totalChunks: 1, data: 'testdata'
  });
  await sessionManager.nextChunk({ pin, passwordHash });
  await sessionManager.nextChunk({ pin, passwordHash }); // Mark as done
  
  // Set acknowledgment
  await sessionManager.setAcknowledged(pin, passwordHash);
  
  // Next call to nextChunk should clean up
  let result = await sessionManager.nextChunk({ pin, passwordHash });
  assertEqual(result.status, 'done', 'Should return done');
  
  // Verify session is cleaned up
  const sKey = `qsv:session:${pin}:${passwordHash}`;
  const sess = mockRedis.storage.get(sKey);
  assertFalsy(sess && sess.totalChunks, 'Session should be cleaned up after ack');
  
  console.log('✓ Session cleanup after acknowledgment test passed');
}

async function testDuplicateChunkRejection() {
  console.log('Test: Duplicate chunk rejection');
  mockRedis.reset();
  
  const pin = '222222';
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
  mockRedis.reset();
  
  const pin = '333333';
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
  mockRedis.reset();
  
  const pin = '444444';
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

async function testSessionExpiry() {
  console.log('Test: Session expiry after TTL');
  mockRedis.reset();
  
  const pin = '555555';
  const passwordHash = 'hashV';
  
  // Create session
  await sessionManager.pushChunk({
    pin, passwordHash, chunkIndex: 0, totalChunks: 1, data: 'data'
  });
  
  // Simulate TTL expiration by manipulating lastTouched
  const sKey = `qsv:session:${pin}:${passwordHash}`;
  const sess = mockRedis.storage.get(sKey);
  sess.lastTouched = Date.now() - (sessionManager.TTL_MS + 1000);
  
  // Next chunk should return expired
  let result = await sessionManager.nextChunk({ pin, passwordHash });
  assertEqual(result.status, 'expired', 'Session should be expired');
  
  // Session should be cleaned up
  const sessAfter = mockRedis.storage.get(sKey);
  assertFalsy(sessAfter && sessAfter.totalChunks, 'Session should be deleted after expiry');
  
  console.log('✓ Session expiry test passed');
}

// Run all tests
async function runTests() {
  console.log('=== Running Relay Sync Tests ===\n');
  
  try {
    await testSingleDirectionTransfer();
    await testAcknowledgmentAfterCompletion();
    await testBidirectionalTransfer();
    await testSessionCleanupAfterAck();
    await testDuplicateChunkRejection();
    await testTotalChunksMismatch();
    await testInvalidChunkData();
    await testSessionExpiry();
    
    console.log('\n=== All Tests Passed! ===');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Test Failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run tests if called directly
if (require.main === module) {
  runTests();
}

module.exports = { runTests };
