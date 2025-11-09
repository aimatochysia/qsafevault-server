const { createClient } = require('redis');

let client;

function getRedisClient() {
  if (!client) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error('REDIS_URL not set in environment');
    client = createClient({ url });
    client.connect().catch(console.error);
  }
  return client;
}

module.exports = { getRedisClient };