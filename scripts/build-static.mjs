// Static asset build script for Vercel deployment
// Creates an isolated dist/ directory containing only approved client assets.
// Prevents server code, question authoring drafts, docs, and secrets from being served publicly.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.resolve(ROOT_DIR, 'dist');

const ALLOWED_ROOT_FILES = [
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
  'favicon.svg'
];

const ALLOWED_DIRS = [
  'css',
  'js',
  'assets',
  'data'
];

const ALLOWED_LIB_FILES = [
  'd3.v7.min.js',
  'd3.layout.cloud.js',
  'supabase.min.js'
];

const FORBIDDEN_PATHS = [
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

export function buildStatic(rootDir = ROOT_DIR, distDir = DIST_DIR) {
  console.log(`[build-static] Building public static bundle into: ${distDir}`);

  // 1. Clean dist directory
  if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true, force: true });
  }
  fs.mkdirSync(distDir, { recursive: true });

  let fileCount = 0;

  // 2. Copy allowed root files
  for (const file of ALLOWED_ROOT_FILES) {
    const src = path.join(rootDir, file);
    if (fs.existsSync(src)) {
      const dest = path.join(distDir, file);
      fs.copyFileSync(src, dest);
      fileCount++;
    } else {
      console.warn(`[build-static] Warning: Optional root file ${file} does not exist in root.`);
    }
  }

  // 3. Copy allowed directories recursively
  for (const dir of ALLOWED_DIRS) {
    const src = path.join(rootDir, dir);
    if (fs.existsSync(src)) {
      const dest = path.join(distDir, dir);
      fs.cpSync(src, dest, { recursive: true });
      fileCount++;
    }
  }

  // 4. Copy allowed client lib files only
  const libDist = path.join(distDir, 'lib');
  fs.mkdirSync(libDist, { recursive: true });
  for (const libFile of ALLOWED_LIB_FILES) {
    const src = path.join(rootDir, 'lib', libFile);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(libDist, libFile));
      fileCount++;
    }
  }

  // 5. Verification / Isolation assertion
  for (const forbidden of FORBIDDEN_PATHS) {
    const checkPath = path.join(distDir, forbidden);
    if (fs.existsSync(checkPath)) {
      throw new Error(`[build-static] Security violation: Forbidden path "${forbidden}" exists in static dist output!`);
    }
  }

  console.log(`[build-static] Successfully isolated ${fileCount} public assets into dist/. Verification passed.`);
}

// Auto-run if executed directly
if (process.argv[1] === __filename) {
  buildStatic();
}
