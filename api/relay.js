const sendHandler = require('./send');
const receiveHandler = require('./receive');
const sessionManager = require('../sessionManager');

module.exports = async function relayHandler(req, res) {
  const action = req.method === 'GET' ? req.query.action : req.body.action;
  if (!action) return res.status(400).json({ error: 'missing_action' });

  if (action === 'send') {
    return sendHandler(req, res);
  }
  if (action === 'receive') {
    return receiveHandler(req, res);
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
