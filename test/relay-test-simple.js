/**
 * Simplified tests for unidirectional relay sync (no password, no bidirectional)
 */

const sessionManager = require('../sessionManager');

async function testSingleDirectionTransfer() {
  console.log('Test: Unidirectional A→B transfer');
  const pin = 'ABC123xyz';
  const data1 = 'chunk-data-0';
  const data2 = 'chunk-data-1';
  
  // Push chunks
  const r1 = await sessionManager.pushChunk({ pin, chunkIndex: 0, totalChunks: 2, data: data1 });
  if (r1.error) throw new Error(`Push chunk 0 failed: ${JSON.stringify(r1)}`);
  
  const r2 = await sessionManager.pushChunk({ pin, chunkIndex: 1, totalChunks: 2, data: data2 });
  if (r2.error) throw new Error(`Push chunk 1 failed: ${JSON.stringify(r2)}`);
  
  // Poll chunks
  const p1 = await sessionManager.nextChunk({ pin });
  if (p1.status !== 'chunkAvailable' || p1.chunk.chunkIndex !== 0 || p1.chunk.data !== data1) {
    throw new Error(`Poll chunk 0 failed: ${JSON.stringify(p1)}`);
  }
  
  const p2 = await sessionManager.nextChunk({ pin });
  if (p2.status !== 'chunkAvailable' || p2.chunk.chunkIndex !== 1 || p2.chunk.data !== data2) {
    throw new Error(`Poll chunk 1 failed: ${JSON.stringify(p2)}`);
  }
  
  const p3 = await sessionManager.nextChunk({ pin });
  if (p3.status !== 'done') {
    throw new Error(`Expected 'done', got: ${JSON.stringify(p3)}`);
  }
  
  console.log('✓ Unidirectional transfer test passed');
}

async function testReceiverPollsFirst() {
  console.log('Test: Receiver polls before sender pushes');
  const pin = 'XYZ789abc';
  
  // Receiver polls first (should create placeholder session)
  const p1 = await sessionManager.nextChunk({ pin });
  if (p1.status !== 'waiting') {
    throw new Error(`Expected 'waiting', got: ${JSON.stringify(p1)}`);
  }
  
  // Sender pushes chunk
  const r1 = await sessionManager.pushChunk({ pin, chunkIndex: 0, totalChunks: 1, data: 'hello' });
  if (r1.error) throw new Error(`Push failed: ${JSON.stringify(r1)}`);
  
  // Receiver polls again (should get chunk)
  const p2 = await sessionManager.nextChunk({ pin });
  if (p2.status !== 'chunkAvailable' || p2.chunk.data !== 'hello') {
    throw new Error(`Poll failed: ${JSON.stringify(p2)}`);
  }
  
  console.log('✓ Receiver polls first test passed');
}

async function testSessionDelete() {
  console.log('Test: Session deletion');
  const pin = 'DEL456test';
  
  // Create session
  await sessionManager.pushChunk({ pin, chunkIndex: 0, totalChunks: 1, data: 'test' });
  
  // Delete session
  const result = await sessionManager.deleteSession(pin);
  if (result.status !== 'deleted') {
    throw new Error(`Delete failed: ${JSON.stringify(result)}`);
  }
  
  // Poll should return waiting (new placeholder)
  const p1 = await sessionManager.nextChunk({ pin });
  if (p1.status !== 'waiting') {
    throw new Error(`Expected 'waiting' after delete, got: ${JSON.stringify(p1)}`);
  }
  
  console.log('✓ Session deletion test passed');
}

async function testDynamicTTL() {
  console.log('Test: Dynamic TTL calculation');
  
  // Test base TTL (no chunks)
  const ttl0 = sessionManager.getChunkTTL(null);
  if (ttl0 !== 30000) {
    throw new Error(`Expected 30000ms base TTL, got: ${ttl0}`);
  }
  
  // Test with 10 chunks: 30s + (10 * 500ms) = 35s
  const ttl10 = sessionManager.getChunkTTL(10);
  if (ttl10 !== 35000) {
    throw new Error(`Expected 35000ms for 10 chunks, got: ${ttl10}`);
  }
  
  // Test with 100 chunks: 30s + (100 * 500ms) = 80s
  const ttl100 = sessionManager.getChunkTTL(100);
  if (ttl100 !== 80000) {
    throw new Error(`Expected 80000ms for 100 chunks, got: ${ttl100}`);
  }
  
  console.log('✓ Dynamic TTL test passed');
}

async function runTests() {
  const tests = [
    testSingleDirectionTransfer,
    testReceiverPollsFirst,
    testSessionDelete,
    testDynamicTTL,
  ];
  
  let passed = 0;
  let failed = 0;
  
  for (const test of tests) {
    try {
      await test();
      passed++;
    } catch (e) {
      console.error(`\n❌ Test Failed: ${e.message}`);
      console.error(e.stack);
      failed++;
    }
  }
  
  console.log(`\n=== Test Summary ===`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  
  process.exit(failed > 0 ? 1 : 0);
}

console.log('=== Running Simplified Relay Tests ===\n');
runTests().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
