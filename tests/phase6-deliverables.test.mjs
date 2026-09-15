import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('architecture decision record (ADR) documents full live capacity gateway design', () => {
  const adrPath = path.resolve(process.cwd(), 'docs/ADR_LIVE_CAPACITY_GATEWAY.md');
  assert.ok(fs.existsSync(adrPath), 'ADR_LIVE_CAPACITY_GATEWAY.md must exist');

  const content = fs.readFileSync(adrPath, 'utf8');
  assert.match(content, /Broadcast once, Ingest once, Compute once/i);
  assert.match(content, /SQLite WAL/i);
  assert.match(content, /Transactional Group Commits/i);
  assert.match(content, /HMAC-SHA256/i);
  assert.match(content, /Dual-Key Rotation/i);
  assert.match(content, /executeRevealBarrier|Reveal Barrier/i);
  assert.match(content, /leaderboard_snapshots|participant_score_snapshots/i);
  assert.match(content, /Circuit-Breaker Fallback|Netlify/i);
  assert.match(content, /Spectator/i);
});

test('event-day runbook provides comprehensive operator checklists and incident playbooks', () => {
  const runbookPath = path.resolve(process.cwd(), 'docs/EVENT_DAY_CAPACITY_RUNBOOK.md');
  assert.ok(fs.existsSync(runbookPath), 'EVENT_DAY_CAPACITY_RUNBOOK.md must exist');

  const content = fs.readFileSync(runbookPath, 'utf8');
  assert.match(content, /MC \/ Host/i);
  assert.match(content, /Backstage Operator/i);
  assert.match(content, /Technical Lead \/ DevOps/i);
  assert.match(content, /T-60 Minutes/i);
  assert.match(content, /T-15 Minutes/i);
  assert.match(content, /GREEN · Healthy/i);
  assert.match(content, /AMBER · Degraded/i);
  assert.match(content, /RED · Overloaded/i);
  assert.match(content, /Freeze roster/i);
  assert.match(content, /Playbook A: Projector Screen Disconnects/i);
  assert.match(content, /Playbook B: Gateway Process Restarts/i);
  assert.match(content, /Playbook C: Total Gateway Outage/i);
  assert.match(content, /Playbook D: Emergency Secret Key Rotation/i);
});

test('multi-tier rehearsal ladder k6 script defines calibrated testing tiers and SLAs', () => {
  const k6Path = path.resolve(process.cwd(), 'load/rehearsal-ladder.js');
  assert.ok(fs.existsSync(k6Path), 'load/rehearsal-ladder.js must exist');

  const content = fs.readFileSync(k6Path, 'utf8');
  assert.match(content, /'100':/);
  assert.match(content, /'500':/);
  assert.match(content, /'1000':/);
  assert.match(content, /'2500':/);
  assert.match(content, /answer_ack_latency_ms/);
  assert.match(content, /dropped_answers_total/);
  assert.match(content, /snapshot_lookup_latency_ms/);
});

test('native rehearsal ladder executes 100-player rehearsal tier cleanly within SLA', async () => {
  const scriptPath = path.resolve(process.cwd(), 'scripts/rehearsal-ladder.mjs');
  assert.ok(fs.existsSync(scriptPath), 'scripts/rehearsal-ladder.mjs must exist');

  const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, '100'], {
    cwd: process.cwd()
  });

  assert.match(stdout, /REHEARSAL LADDER RESULT FOR 100 PLAYERS: PASSED/);
  assert.match(stdout, /Registered 100 participants/);
  assert.match(stdout, /Reveal barrier finished/);
  assert.match(stdout, /100\/100 snapshot reads resolved/);
});

test('production deployment assets contain required limits, health checks, and proxy rules', () => {
  // 1. Dockerfile
  const dockerfilePath = path.resolve(process.cwd(), 'gateway/Dockerfile');
  assert.ok(fs.existsSync(dockerfilePath), 'gateway/Dockerfile must exist');
  const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
  assert.match(dockerfile, /node:24/);
  assert.match(dockerfile, /VOLUME \["\/app\/data"\]/);
  assert.match(dockerfile, /HEALTHCHECK/);

  // 2. docker-compose.yml
  const composePath = path.resolve(process.cwd(), 'gateway/docker-compose.yml');
  assert.ok(fs.existsSync(composePath), 'gateway/docker-compose.yml must exist');
  const compose = fs.readFileSync(composePath, 'utf8');
  assert.match(compose, /cpus:\s*"?1\.5"?/);
  assert.match(compose, /memory:\s*1024M/);
  assert.match(compose, /gateway-data:\/app\/data/);
  assert.match(compose, /caddy:2-alpine/);

  // 3. Caddyfile
  const caddyfilePath = path.resolve(process.cwd(), 'gateway/Caddyfile');
  assert.ok(fs.existsSync(caddyfilePath), 'gateway/Caddyfile must exist');
  const caddyfile = fs.readFileSync(caddyfilePath, 'utf8');
  assert.match(caddyfile, /flush_interval -1/);
  assert.match(caddyfile, /\/gateway\/health/);
  assert.match(caddyfile, /\/gateway\/stream/);

  // 4. systemd service
  const systemdPath = path.resolve(process.cwd(), 'gateway/systemd/niac-gateway.service');
  assert.ok(fs.existsSync(systemdPath), 'gateway/systemd/niac-gateway.service must exist');
  const systemd = fs.readFileSync(systemdPath, 'utf8');
  assert.match(systemd, /Restart=always/);
  assert.match(systemd, /LimitNOFILE=65536/);
  assert.match(systemd, /ProtectSystem=full/);
});
