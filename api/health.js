// Standalone zero-overhead health check for Vercel Serverless Function
export default function handler(req, res) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.statusCode = 200;
  res.end(JSON.stringify({ status: 'ok', service: 'niac-live-authority' }));
}
