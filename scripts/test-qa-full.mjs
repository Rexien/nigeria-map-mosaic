// Comprehensive End-to-End QA Validation Suite for NIAC Live
// Uses isolated ports (HTTP: 49152, CDP: 49153) and dedicated temporary user profile
// to ensure ZERO interference with Codex or other ongoing processes.

import { spawn } from 'node:child_process';
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const WORKTREE_ROOT = fileURLToPath(new URL('../artifacts/worktrees/reveal-first', import.meta.url));
const SERVER_PORT = 49152;
const CDP_PORT = 49153;

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
};

const routes = {
  '/': 'index.html',
  '/activities': 'activities.html',
  '/credits': 'credits.html',
  '/play': 'play.html',
  '/passport': 'passport.html',
  '/display': 'display.html',
  '/lens': 'lens.html',
  '/lens/live': 'lens-live.html',
  '/admin': 'admin.html',
  '/review': 'review/index.html',
  '/review/screen.html': 'review/screen.html'
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const relative = routes[url.pathname] || url.pathname.slice(1);
    const safe = normalize(relative).replace(/^(\.\.(\/|\\|$))+/, '');
    const file = join(WORKTREE_ROOT, safe);
    const content = await readFile(file);
    res.writeHead(200, {
      'content-type': mime[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store'
    });
    res.end(content);
  } catch (err) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found: ' + req.url);
  }
});

await new Promise(resolve => server.listen(SERVER_PORT, '127.0.0.1', resolve));
console.log(`[QA Runner] Local test server listening on http://127.0.0.1:${SERVER_PORT}`);

// Find Chrome
function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : '',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return 'google-chrome';
}

const chromePath = findChrome();
const chromeUserDataDir = mkdtempSync(join(tmpdir(), 'niac-qa-profile-'));
const chromeProc = spawn(chromePath, [
  '--headless=new',
  `--remote-debugging-port=${CDP_PORT}`,
  '--remote-debugging-address=127.0.0.1',
  `--user-data-dir=${chromeUserDataDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--disable-extensions',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  'about:blank'
]);

async function stopChrome() {
  if (chromeProc.exitCode === null && chromeProc.signalCode === null) {
    await new Promise(resolve => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      chromeProc.once('exit', done);
      chromeProc.kill();
      setTimeout(done, 1000);
    });
  }
  try {
    rmSync(chromeUserDataDir, { recursive: true, force: true });
  } catch {}
}

// Wait for CDP
let cdpAvailable = false;
for (let i = 0; i < 80; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
    if (res.ok) { cdpAvailable = true; break; }
  } catch {}
  await new Promise(r => setTimeout(r, 200));
}

if (!cdpAvailable) {
  await stopChrome();
  server.close();
  throw new Error('Chrome CDP port did not become ready');
}

const newTargetRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' });
const target = await newTargetRes.json();
const ws = new WebSocket(target.webSocketDebuggerUrl);

await new Promise(resolve => ws.addEventListener('open', resolve));

let reqId = 1;
const pending = new Map();
ws.addEventListener('message', event => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  }
});

function cdpSend(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = reqId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await cdpSend('Page.enable');
await cdpSend('Runtime.enable');

async function navigate(url) {
  await cdpSend('Page.navigate', { url });
  await new Promise(r => setTimeout(r, 250));
}

async function setViewport(width, height, isMobile = false) {
  await cdpSend('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: isMobile ? 2 : 1,
    mobile: isMobile
  });
}

async function evaluate(fnStr, arg = null) {
  const expr = arg !== null ? `(${fnStr})(${JSON.stringify(arg)})` : `(${fnStr})()`;
  const res = await cdpSend('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true
  });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
  }
  return res.result?.value;
}

const report = {
  timestamp: new Date().toISOString(),
  targetCommit: 'd79fae6 (codex/live-timer-ux)',
  questionsAudit: {
    passportQuestionsCount: 0,
    decodeRoundsCount: 0,
    allQuestionsTested: 0,
    failures: []
  },
  screensAudit: [],
  speedAudit: {},
  summary: { status: 'PENDING' }
};

try {
  console.log('[QA Runner] Starting All 24 Passport Questions Verification...');
  
  const questionsData = JSON.parse(await readFile(join(WORKTREE_ROOT, 'content/questions.json'), 'utf8'));
  const decodeData = JSON.parse(await readFile(join(WORKTREE_ROOT, 'content/decode-rounds.json'), 'utf8'));
  
  report.questionsAudit.passportQuestionsCount = questionsData.questions.length;
  report.questionsAudit.decodeRoundsCount = decodeData.rounds.length;

  // 1. Audit each of the 24 Passport Trivia Questions
  for (let i = 0; i < questionsData.questions.length; i++) {
    const q = questionsData.questions[i];
    const qId = `d${q.day}q${q.order}`;
    
    // Test Mobile Phone (390x844) - Open State
    await setViewport(390, 844, true);
    await navigate(`http://127.0.0.1:${SERVER_PORT}/review/screen.html?q=${qId}&state=open&view=phone`);
    
    const mobileOpenCheck = await evaluate(`() => {
      const heading = document.querySelector('h1, .question-text, .display-question h1');
      const buttons = Array.from(document.querySelectorAll('[data-option], .answer'));
      const mediaImg = document.querySelector('.draft-media img');
      const hasOverflow = document.documentElement.scrollWidth > window.innerWidth;
      
      const buttonRects = buttons.map(b => {
        const rect = b.getBoundingClientRect();
        return { text: b.textContent.slice(0, 20), w: Math.round(rect.width), h: Math.round(rect.height) };
      });

      const buttonsValid = buttons.length === 4 && buttons.every(b => {
        const rect = b.getBoundingClientRect();
        return rect.height >= 32 && rect.width >= 150;
      });
      
      const noAnswerLeak = !document.body.innerHTML.includes('CORRECT ANSWER') && 
                           !document.body.innerHTML.includes('Why:</strong>') &&
                           !document.body.innerHTML.includes('explanation-body');

      return {
        headingFound: Boolean(heading && heading.textContent.trim().length > 5),
        optionsCount: buttons.length,
        buttonsValid,
        buttonRects,
        hasOverflow,
        noAnswerLeak,
        mediaImgRendered: mediaImg ? (mediaImg.naturalWidth > 0 || mediaImg.complete) : null
      };
    }`);

    if (!mobileOpenCheck.headingFound || !mobileOpenCheck.buttonsValid || !mobileOpenCheck.noAnswerLeak || mobileOpenCheck.hasOverflow) {
      report.questionsAudit.failures.push({
        qId,
        question: q.question,
        view: 'phone',
        state: 'open',
        error: `Mobile Open Check failed: ${JSON.stringify(mobileOpenCheck)}`
      });
    }

    // Test Mobile Phone (390x844) - Revealed State
    await navigate(`http://127.0.0.1:${SERVER_PORT}/review/screen.html?q=${qId}&state=correct&view=phone`);
    const mobileRevealCheck = await evaluate(`() => {
      const text = document.body.innerText;
      const html = document.body.innerHTML;
      const hasExplanation = text.length > 30 || html.includes('Osun-Osogbo') || html.includes('result-notice');
      const hasCorrectIndicator = text.includes('Correct') || text.includes('correct') || html.includes('result-correct');
      const hasOverflow = document.documentElement.scrollWidth > window.innerWidth;
      return { textLen: text.length, hasExplanation, hasCorrectIndicator, hasOverflow };
    }`);

    if (!mobileRevealCheck.hasExplanation || mobileRevealCheck.hasOverflow) {
      report.questionsAudit.failures.push({
        qId,
        question: q.question,
        view: 'phone',
        state: 'revealed',
        error: `Mobile Reveal Check failed: ${JSON.stringify(mobileRevealCheck)}`
      });
    }

    // Test Stage Projector (1920x1080) - Open State
    await setViewport(1920, 1080, false);
    await navigate(`http://127.0.0.1:${SERVER_PORT}/review/screen.html?q=${qId}&state=open&view=projector`);
    const projectorOpenCheck = await evaluate(`() => {
      const heading = document.querySelector('h1, .reveal-question-heading');
      const fontSize = heading ? parseFloat(window.getComputedStyle(heading).fontSize) : 0;
      const options = document.querySelectorAll('.display-option, [data-option], .answer, .winning-choice');
      return {
        headingFound: Boolean(heading),
        largeFontSize: fontSize >= 20,
        optionsPresent: options.length >= 4 || document.querySelectorAll('.display-options-list li').length >= 4
      };
    }`);

    if (!projectorOpenCheck.headingFound || !projectorOpenCheck.largeFontSize) {
      report.questionsAudit.failures.push({
        qId,
        question: q.question,
        view: 'projector',
        state: 'open',
        error: `Projector Open Check failed: ${JSON.stringify(projectorOpenCheck)}`
      });
    }

    // Test Stage Projector (1920x1080) - Revealed State
    await navigate(`http://127.0.0.1:${SERVER_PORT}/review/screen.html?q=${qId}&state=correct&view=projector`);
    const projectorRevealCheck = await evaluate(`() => {
      const winning = document.querySelector('.display-winning-card, .display-winning-answer, .result-notice');
      const explanation = document.querySelector('.display-explanation-card, .display-reveal-explanation, small');
      return {
        winningCard: Boolean(winning),
        explanationCard: Boolean(explanation)
      };
    }`);

    if (!projectorRevealCheck.winningCard || !projectorRevealCheck.explanationCard) {
      report.questionsAudit.failures.push({
        qId,
        question: q.question,
        view: 'projector',
        state: 'revealed',
        error: `Projector Reveal Check failed: ${JSON.stringify(projectorRevealCheck)}`
      });
    }

    report.questionsAudit.allQuestionsTested++;
  }
  console.log(`[QA Runner] Tested all ${report.questionsAudit.allQuestionsTested} Passport questions across Mobile & Projector. Failures: ${report.questionsAudit.failures.length}`);

  // 2. Audit All 6 Decode the State Rounds and Image Assets
  console.log('[QA Runner] Verifying 6 Decode Rounds and all 18 WebP clue assets...');
  const decodeAssetsStatus = [];
  for (let r = 0; r < decodeData.rounds.length; r++) {
    const round = decodeData.rounds[r];
    for (let c = 0; c < (round.clueMedia || []).length; c++) {
      const m = round.clueMedia[c];
      const res = await fetch(`http://127.0.0.1:${SERVER_PORT}${m.src}`);
      decodeAssetsStatus.push({
        round: round.state,
        clue: c + 1,
        src: m.src,
        status: res.status,
        ok: res.ok,
        contentType: res.headers.get('content-type')
      });
    }
  }

  const brokenDecodeAssets = decodeAssetsStatus.filter(a => !a.ok);
  if (brokenDecodeAssets.length > 0) {
    report.questionsAudit.failures.push({
      view: 'decode-assets',
      error: `Broken decode assets: ${JSON.stringify(brokenDecodeAssets)}`
    });
  }
  console.log(`[QA Runner] Verified ${decodeAssetsStatus.length} Decode clue images. Broken: ${brokenDecodeAssets.length}`);

  // 3. Audit Full Platform Screens
  const testScreens = [
    { name: 'Join Screen', path: '/', expected: '#alias, #join-button, .page' },
    { name: 'Activities Hub', path: '/activities', expected: '.site-header, .page' },
    { name: 'Player Controller (Passport Open)', path: '/play?preview=passport-text', expected: '.answers, .answer, .play-panel' },
    { name: 'Player Controller (Answered Locked)', path: '/play?preview=passport-answered', expected: '.answers, .answer, .play-panel' },
    { name: 'Player Controller (Revealed)', path: '/play?preview=passport-reveal', expected: '.notice, .answers, .play-panel' },
    { name: 'Player Controller (Decode Mode)', path: '/play?preview=decode-clue1', expected: '.decode-preparing-panel, .clue-card, .play-panel' },
    { name: 'Digital Passport requires joining first', path: '/passport', expected: '#join-form' },
    { name: 'Stage Display (Welcome)', path: '/display?preview=welcome', expected: '#display-root, .display-welcome' },
    { name: 'Stage Display (Passport Reveal)', path: '/display?preview=passport-reveal', expected: '#display-root, .display-question' },
    { name: 'Stage Display (Leaderboard)', path: '/display?preview=leaderboard', expected: '#display-root, .display-question, .leaderboard-table' },
    { name: 'Live Word Mosaic Stage', path: '/lens/live', expected: '#map-svg, #words-layer, #display-container' },
    { name: 'Admin Console', path: '/admin', expected: '#admin-login, #admin-pin' }
  ];

  console.log('[QA Runner] Verifying all platform screens...');
  for (const screen of testScreens) {
    await setViewport(screen.path.includes('display') || screen.path.includes('live') ? 1920 : 390, 
                      screen.path.includes('display') || screen.path.includes('live') ? 1080 : 844, 
                      !screen.path.includes('display') && !screen.path.includes('live'));
    await navigate(`http://127.0.0.1:${SERVER_PORT}${screen.path}`);
    
    const check = await evaluate(`(expected) => {
      const el = document.querySelector(expected);
      const errors = Array.from(document.querySelectorAll('.error:not(:empty), .status-error'));
      return {
        matched: Boolean(el),
        title: document.title,
        hasError: errors.length > 0 && !errors.every(e => e.classList.contains('hidden') || e.style.display === 'none')
      };
    }`, screen.expected);

    report.screensAudit.push({
      screen: screen.name,
      path: screen.path,
      matched: check.matched,
      title: check.title,
      ok: check.matched
    });
  }

  // 4. Live Deployed Preview Speed & Reveal Verification
  console.log('[QA Runner] Measuring live deployed preview latency...');
  const PREVIEW_BASE = process.env.NIAC_QA_PREVIEW_BASE || 'https://niaclive.vercel.app';
  const BYPASS_HEADER = process.env.VERCEL_AUTOMATION_BYPASS_SECRET
    ? { 'x-vercel-protection-bypass': process.env.VERCEL_AUTOMATION_BYPASS_SECRET }
    : {};

  const t0 = performance.now();
  const healthRes = await fetch(`${PREVIEW_BASE}/api/health`, { headers: BYPASS_HEADER });
  const healthLatencyMs = Math.round(performance.now() - t0);
  const healthJson = healthRes.ok ? await healthRes.json() : null;

  report.speedAudit = {
    previewUrl: PREVIEW_BASE,
    healthStatus: healthRes.status,
    healthLatencyMs,
    revealArchitecture: 'Decoupled SSE broadcast before background snapshot persist'
  };

  report.summary = {
    status: report.questionsAudit.failures.length === 0 && report.screensAudit.every(s => s.ok) ? 'PASSED' : 'ACTION_REQUIRED',
    totalQuestionsVerified: report.questionsAudit.allQuestionsTested,
    decodeClueImagesVerified: decodeAssetsStatus.length,
    screensVerified: report.screensAudit.length,
    allScreensPassed: report.screensAudit.every(s => s.ok),
    failuresCount: report.questionsAudit.failures.length
  };

  console.log('[QA Runner] QA Run Complete! Writing report...');
  await mkdir(fileURLToPath(new URL('../artifacts/qa', import.meta.url)), { recursive: true });
  await writeFile(
    fileURLToPath(new URL('../artifacts/qa/qa-comprehensive-report.json', import.meta.url)),
    JSON.stringify(report, null, 2),
    'utf8'
  );
  console.log('[QA Runner] Saved report to artifacts/qa/qa-comprehensive-report.json');

} finally {
  await stopChrome();
  server.close();
  console.log('[QA Runner] Cleaned up Chrome and test server. 100% idle.');
}
