const { pushChunk, purgeExpired } = require('../sessionManager');

function parseJson(req, maxSize = 70 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > maxSize) {
        req.destroy();
        reject({ error: 'body_too_large', status: 'waiting' });
      }
    });
    req.on('end', () => {
      try {
        const json = JSON.parse(body);
        resolve(json);
      } catch (e) {
        reject({ error: 'invalid_json', status: 'waiting' });
      }
    });
  });
}

module.exports = async function sendHandler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end();
    return;
  }
  purgeExpired();
  let input;
  try {
    input = await parseJson(req);
  } catch (err) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(err));
    return;
  }
  const result = pushChunk(input);
  if (result.error) {
    res.statusCode = 400;
  } else {
    res.statusCode = 200;
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(result));
};
