/**
 * Unified relay handler for both chunk-based transfer and WebRTC signaling.
 * 
 * Chunk-based actions (legacy compatibility):
 * - send: Upload encrypted chunk
 * - receive: Poll for next chunk
 * - ack: Acknowledge receipt
 * - ack-status: Check acknowledgment status
 * 
 * WebRTC signaling actions (new):
 * - register: Register peer with invite code
 * - lookup: Look up peer by invite code
 * - signal: Send signaling message (offer/answer/ICE)
 * - poll: Poll for signaling messages
 * 
 * All data is ephemeral - stored in memory only with short TTL.
 * Server cannot read encrypted payloads (zero-trust).
 */

const sessionManager = require('../sessionManager');

module.exports = async function relayHandler(req, res) {
  const action = req.method === 'GET' ? req.query.action : req.body.action;
  if (!action) return res.status(400).json({ error: 'missing_action' });

  // ==================== Chunk-based Relay (legacy) ====================
  
  if (action === 'send') {
    const { pin, passwordHash, chunkIndex, totalChunks, data } = req.body;
    if (!pin || !passwordHash || typeof chunkIndex !== 'number' || typeof totalChunks !== 'number' || !data) {
      return res.status(400).json({ error: 'missing_fields', status: 'waiting' });
    }
    try {
      const result = await sessionManager.pushChunk({
        pin,
        passwordHash,
        chunkIndex,
        totalChunks,
        data,
      });
      return res.status(200).json(result);
    } catch (e) {
      return res.status(500).json({ error: 'server_error', details: e+'' });
    }
  }
  
  if (action === 'receive') {
    const { pin, passwordHash } = req.body;
    if (!pin || !passwordHash) {
      return res.status(400).json({ status: 'waiting', error: 'missing_pin_or_passwordHash' });
    }
    try {
      const result = await sessionManager.nextChunk({ pin, passwordHash });
      if (result.status === 'chunkAvailable') {
        return res.status(200).json({
          status: 'chunkAvailable',
          chunk: {
            chunkIndex: result.chunk.chunkIndex,
            totalChunks: result.chunk.totalChunks,
            data: result.chunk.data,
          },
        });
      }
      return res.status(200).json(result);
    } catch (e) {
      return res.status(500).json({ error: 'server_error', details: e+'' });
    }
  }
  
  if (action === 'ack') {
    const { pin, passwordHash } = req.body;
    if (!pin || !passwordHash) return res.status(400).json({ error: 'missing_fields' });
    try {
      await sessionManager.setAcknowledged(pin, passwordHash);
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: 'server_error', details: e+'' });
    }
  }
  
  if (action === 'ack-status') {
    const { pin, passwordHash } = req.body;
    if (!pin || !passwordHash) return res.status(400).json({ error: 'missing_fields' });
    try {
      const ack = await sessionManager.getAcknowledged(pin, passwordHash);
      return res.json({ acknowledged: !!ack });
    } catch (e) {
      return res.status(500).json({ error: 'server_error', details: e+'' });
    }
  }

  // ==================== WebRTC Signaling ====================
  
  /**
   * Register a peer with an 8-character invite code.
   * Invite code format: case-sensitive alphanumeric (A-Za-z0-9), 8 characters.
   */
  if (action === 'register') {
    const { inviteCode, peerId } = req.body;
    if (!inviteCode || !peerId) {
      return res.status(400).json({ error: 'missing_fields' });
    }
    try {
      const result = sessionManager.registerPeer(inviteCode, peerId);
      if (result.error) {
        return res.status(400).json(result);
      }
      return res.status(200).json(result);
    } catch (e) {
      return res.status(500).json({ error: 'server_error', details: e+'' });
    }
  }
  
  /**
   * Look up a peer by invite code.
   */
  if (action === 'lookup') {
    const { inviteCode } = req.body;
    if (!inviteCode) {
      return res.status(400).json({ error: 'missing_invite_code' });
    }
    try {
      const result = sessionManager.lookupPeer(inviteCode);
      if (result.error) {
        return res.status(404).json(result);
      }
      return res.status(200).json(result);
    } catch (e) {
      return res.status(500).json({ error: 'server_error', details: e+'' });
    }
  }
  
  /**
   * Send a signaling message to another peer.
   * Message types: offer, answer, ice-candidate
   * Payload is opaque to the server (encrypted by clients).
   */
  if (action === 'signal') {
    const { from, to, type, payload } = req.body;
    if (!from || !to || !type || !payload) {
      return res.status(400).json({ error: 'missing_fields' });
    }
    try {
      const result = sessionManager.queueSignal({ from, to, type, payload });
      if (result.error) {
        return res.status(400).json(result);
      }
      return res.status(200).json(result);
    } catch (e) {
      return res.status(500).json({ error: 'server_error', details: e+'' });
    }
  }
  
  /**
   * Poll for signaling messages addressed to a peer.
   * Returns all queued messages and clears the queue.
   */
  if (action === 'poll') {
    const { peerId } = req.body;
    if (!peerId) {
      return res.status(400).json({ error: 'missing_peer_id' });
    }
    try {
      const result = sessionManager.pollSignals(peerId);
      return res.status(200).json(result);
    } catch (e) {
      return res.status(500).json({ error: 'server_error', details: e+'' });
    }
  }

  return res.status(404).json({ error: 'unknown_action' });
};
