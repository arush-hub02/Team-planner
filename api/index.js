const { handleRequest } = require('../sync_server');
const { Readable } = require('stream');

module.exports = async (req, res) => {
  // If Vercel serverless runtime pre-consumed or parsed req.body, re-create readable stream
  if (req.body !== undefined && req.body !== null && !req.readableEnded) {
    const bodyStr = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const stream = Readable.from(Buffer.from(bodyStr));
    stream.headers = req.headers;
    stream.method = req.method;
    stream.url = req.url;
    stream.query = req.query;
    return handleRequest(stream, res);
  }
  return handleRequest(req, res);
};
