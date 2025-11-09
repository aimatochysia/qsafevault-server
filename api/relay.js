
const sessionManager = require('../sessionManager');
const { Buffer } = require('buffer');

module.exports = async function relayHandler(req, res) {
  const action = req.method === 'GET' ? req.query.action : req.body.action;
  if (!action) return res.status(400).json({ error: 'missing_action' });

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
  return res.status(404).json({ error: 'unknown_action' });
};
