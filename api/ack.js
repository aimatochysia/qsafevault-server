const sessionManager = require('../sessionManager');

module.exports = async function ackHandler(req, res) {
  const { pin, passwordHash } = req.body;
  if (!pin || !passwordHash) return res.status(400).json({ error: 'missing_fields' });
  try {
    await sessionManager.setAcknowledged(pin, passwordHash);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'server_error', details: e+'' });
  }
};
