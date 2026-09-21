import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import healthHandler from '../api/health.js';
import catchAllHandler from '../api/[...path].js';
import { handler as authorityHandler, handleNodeRequest } from '../server/api.mjs';
import { buildStatic } from '../scripts/build-static.mjs';
import { createGatewayServer } from '../gateway/server.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.resolve(ROOT_DIR, 'dist');

// Mock Node HTTP response helper for testing serverless functions
function createMockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(key, val) {
      this.headers[key.toLowerCase()] = val;
    },
    writeHead(status, headers = {}) {
      this.statusCode = status;
      for (const [k, v] of Object.entries(headers)) {
        this.headers[k.toLowerCase()] = v;
      }
    },
    end(data) {
      if (data) this.body += data;
      this.finished = true;
    }
  };
  return res;
}

test('Vercel api/health.js returns 200 with service health status', async () => {
  const req = { method: 'GET', url: '/api/health', headers: {} };
  const res = createMockRes();

  healthHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-store');

  const body = JSON.parse(res.body);
  assert.equal(body.status, 'ok');
  assert.equal(body.service, 'niac-live-authority');
});

test('Authority server/api.mjs handles health endpoint in handler and handleNodeRequest', async () => {
  // 1. Direct event handler
  const event = { httpMethod: 'GET', path: '/api/health', headers: {} };
  const eventRes = await authorityHandler(event);
  assert.equal(eventRes.statusCode, 200);
  const eventBody = JSON.parse(eventRes.body);
  assert.equal(eventBody.status, 'ok');
  assert.equal(eventBody.service, 'niac-live-authority');

  // 2. Node adapter handleNodeRequest
  const req = { method: 'GET', url: '/api/health', headers: { host: 'localhost' } };
  const res = createMockRes();
  await handleNodeRequest(req, res);
  assert.equal(res.statusCode, 200);
  const nodeBody = JSON.parse(res.body);
  assert.equal(nodeBody.status, 'ok');
  assert.equal(nodeBody.service, 'niac-live-authority');
});

test('Vercel catch-all api/[...path].js routes through handleNodeRequest', async () => {
  const req = {
    method: 'GET',
    url: '/api/health',
    headers: { host: 'niac-live.vercel.app' },
    query: { path: ['health'] }
  };
  const res = createMockRes();

  await catchAllHandler(req, res);

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.status, 'ok');
  assert.equal(body.service, 'niac-live-authority');
});

test('Static build isolates public frontend assets into dist/ and strictly omits private files', async () => {
  buildStatic(ROOT_DIR, DIST_DIR);

  // Assert expected public files exist
  const expectedPublicFiles = [
    'index.html',
    'activities.html',
    'play.html',
    'display.html',
    'admin.html',
    'admin-content.html',
    'lens.html',
    'lens-live.html',
    'passport.html',
    'credits.html',
    'submit.html',
    '404.html',
    'config.js',
    'favicon.svg',
    'lib/d3.v7.min.js',
    'lib/d3.layout.cloud.js',
    'lib/supabase.min.js'
  ];

  for (const file of expectedPublicFiles) {
    const fullPath = path.join(DIST_DIR, file);
    assert.ok(fs.existsSync(fullPath), `Public file ${file} should exist in dist/`);
  }

  // Assert public directories exist and have contents
  assert.ok(fs.readdirSync(path.join(DIST_DIR, 'css')).length > 0, 'dist/css must contain stylesheets');
  assert.ok(fs.readdirSync(path.join(DIST_DIR, 'js')).length > 0, 'dist/js must contain client scripts');
  assert.ok(fs.readdirSync(path.join(DIST_DIR, 'assets')).length > 0, 'dist/assets must contain media');
  assert.ok(fs.readdirSync(path.join(DIST_DIR, 'data')).length > 0, 'dist/data must contain map data');

  // Assert private / server-side files are ABSENT from dist/
  const forbiddenFiles = [
    'content',
    'review',
    'docs',
    'gateway',
    'server',
    'scripts',
    'tests',
    'load',
    'supabase',
    'package.json',
    'schema.sql',
    '.env',
    '.env.example',
    'lib/credentials.mjs',
    'lib/snapshot-scoring.mjs',
    'lib/state-envelope.mjs',
    'lib/telemetry.mjs',
    'lib/question-media.mjs'
  ];

  for (const forbidden of forbiddenFiles) {
    const checkPath = path.join(DIST_DIR, forbidden);
    assert.ok(!fs.existsSync(checkPath), `Forbidden path ${forbidden} MUST NOT exist in dist/`);
  }
});

test('vercel.json configuration satisfies architecture rules', async () => {
  const vercelConfig = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'vercel.json'), 'utf8'));

  // Build and output directory
  assert.equal(vercelConfig.outputDirectory, 'dist');
  assert.equal(vercelConfig.buildCommand, 'node scripts/build-static.mjs');
  assert.equal(vercelConfig.cleanUrls, true);

  // Rewrites: minimal, only where URL differs from filename
  assert.ok(Array.isArray(vercelConfig.rewrites));
  const rewrites = vercelConfig.rewrites;

  // Must NOT contain redundant /api/(.*) rewrite
  const apiRewrite = rewrites.find(r => r.source && r.source.startsWith('/api'));
  assert.equal(apiRewrite, undefined, 'vercel.json must NOT contain redundant /api rewrites');

  // Must contain mapping for differing paths
  const lensLive = rewrites.find(r => r.source === '/lens/live');
  assert.ok(lensLive, 'Rewrite for /lens/live must exist');
  assert.equal(lensLive.destination, '/lens-live.html');

  const adminContent = rewrites.find(r => r.source === '/admin/content');
  assert.ok(adminContent, 'Rewrite for /admin/content must exist');
  assert.equal(adminContent.destination, '/admin-content.html');

  // Security and caching headers
  assert.ok(Array.isArray(vercelConfig.headers));
  const globalHeader = vercelConfig.headers.find(h => h.source === '/(.*)');
  assert.ok(globalHeader, 'Global header block must exist');

  const headerKeys = globalHeader.headers.map(h => h.key);
  assert.ok(headerKeys.includes('X-Frame-Options'));
  assert.ok(headerKeys.includes('X-Content-Type-Options'));
  assert.ok(headerKeys.includes('Referrer-Policy'));
  assert.ok(headerKeys.includes('Permissions-Policy'));
  assert.ok(headerKeys.includes('Content-Security-Policy'));
});

test('Gateway CORS supports multiple explicit allowed origins and rejects untrusted origins', async () => {
  const mockQueue = {
    getQueueDepth: () => 0,
    getTotalCount: () => 0
  };

  const allowedOrigins = 'https://niac-live.vercel.app, https://niac-live-staging.vercel.app';
  const server = createGatewayServer(mockQueue, {
    allowedOrigin: allowedOrigins,
    startFlusher: false,
    sink: null
  });

  // Test 1: Authorized production origin
  {
    const req = {
      method: 'GET',
      url: '/gateway/health',
      headers: { host: 'localhost', origin: 'https://niac-live.vercel.app' }
    };
    const res = createMockRes();
    await server.emit('request', req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['access-control-allow-origin'], 'https://niac-live.vercel.app');
  }

  // Test 2: Authorized staging origin
  {
    const req = {
      method: 'GET',
      url: '/gateway/health',
      headers: { host: 'localhost', origin: 'https://niac-live-staging.vercel.app' }
    };
    const res = createMockRes();
    await server.emit('request', req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['access-control-allow-origin'], 'https://niac-live-staging.vercel.app');
  }

  // Test 3: Unauthorized origin (arbitrary preview)
  {
    const req = {
      method: 'GET',
      url: '/gateway/health',
      headers: { host: 'localhost', origin: 'https://niac-live-preview-pr-99.vercel.app' }
    };
    const res = createMockRes();
    await server.emit('request', req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  }
});
