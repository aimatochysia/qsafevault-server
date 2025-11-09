const sessionManager = require('../sessionManager');

module.exports = async function ackStatusHandler(req, res) {
  const { pin, passwordHash } = req.body;
  if (!pin || !passwordHash) return res.status(400).json({ error: 'missing_fields' });
  try {
    const ack = await sessionManager.getAcknowledged(pin, passwordHash);
    res.json({ acknowledged: !!ack });
  } catch (e) {
    res.status(500).json({ error: 'server_error', details: e+'' });
  }
};
