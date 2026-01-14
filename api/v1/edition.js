/**
 * Edition endpoint for Vercel serverless deployment.
 * Returns server edition information for client handshake.
 */

const { getEditionConfig } = require('../../editionConfig');

module.exports = function editionHandler(req, res) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'method_not_allowed' }));
    return;
  }

  try {
    const editionConfig = getEditionConfig();
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(editionConfig.getEditionInfo()));
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'configuration_error' }));
  }
};
