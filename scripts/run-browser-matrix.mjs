// Automated Browser Viewport Matrix Validation for NIAC Live
// Uses Chrome DevTools Protocol (CDP) to exercise real rendered views in Chrome/Edge

import { spawn } from 'node:child_process';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const SERVER_PORT = 4191;
const CDP_PORT = 9226;

// Minimal static file server for tests
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png'
};

const routes = {
  '/': 'index.html',
  '/activities': 'activities.html',
  '/credits': 'credits.html',
  '/play': 'play.html',
  '/passport': 'passport.html',
  '/display': 'display.html',
  '/admin': 'admin.html'
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const relative = routes[url.pathname] || url.pathname.slice(1);
    const safe = normalize(relative).replace(/^(\.\.(\/|\\|$))+/, '');
    const file = join(root, safe);
    const content = await readFile(file);
    res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' });
    res.end(content);
  } catch (err) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
});

await new Promise(resolve => server.listen(SERVER_PORT, '127.0.0.1', resolve));
console.log(`Local test server listening on http://127.0.0.1:${SERVER_PORT}`);

// Launch Headless Chrome (Cross-platform discovery for Windows and Linux/CI)
import { existsSync } from 'node:fs';

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
  return 'google-chrome'; // fallback to PATH
}

const chromePath = findChrome();
const chromeProc = spawn(chromePath, [
  '--headless=new',
  `--remote-debugging-port=${CDP_PORT}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--disable-extensions',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  'about:blank'
]);

// Wait for CDP to respond
let cdpAvailable = false;
for (let i = 0; i < 20; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
    if (res.ok) { cdpAvailable = true; break; }
  } catch {}
  await new Promise(r => setTimeout(r, 250));
}

if (!cdpAvailable) {
  chromeProc.kill();
  server.close();
  throw new Error('Chrome CDP port did not become ready');
}

// Create new page target
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
  // Wait for DOM to stabilize
  await new Promise(r => setTimeout(r, 400));
}

async function setViewport(width, height, isMobile = false) {
  await cdpSend('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: isMobile ? 2 : 1,
    mobile: isMobile
  });
}

async function evaluate(fnStr) {
  const res = await cdpSend('Runtime.evaluate', {
    expression: `(${fnStr})()`,
    returnByValue: true
  });
  return res.result?.value;
}

const matrix = [
  // Phones
  { name: 'Phone Compact', width: 360, height: 640, isMobile: true },
  { name: 'Phone Standard', width: 390, height: 844, isMobile: true },
  // Projectors
  { name: 'Projector 720p', width: 1280, height: 720, isMobile: false },
  { name: 'Projector WXGA', width: 1366, height: 768, isMobile: false },
  { name: 'Projector 1080p', width: 1920, height: 1080, isMobile: false }
];

let allPassed = true;
const results = [];

console.log('\n--- EXERCISING REAL BROWSER VIEWPORT MATRIX ---');

for (const vp of matrix) {
  await setViewport(vp.width, vp.height, vp.isMobile);

  if (vp.isMobile) {
    await navigate(`http://127.0.0.1:${SERVER_PORT}/play?preview=decode-voting`);
    const decodeMetrics = await evaluate(`() => {
      const header = document.querySelector('.site-header');
      const main = document.querySelector('main');
      const panel = document.querySelector('.play-panel');
      const meta = document.querySelector('.question-meta');
      const h1 = document.querySelector('h1');
      const clues = document.querySelector('.decode-voting-clues');
      const answers = document.querySelector('.answers');
      const buttons = document.querySelectorAll('.answer');
      const firstBtn = buttons[0];
      const lastBtn = buttons[buttons.length - 1];
      const firstRect = firstBtn ? firstBtn.getBoundingClientRect() : null;
      const lastRect = lastBtn ? lastBtn.getBoundingClientRect() : null;
      const scrollWidth = document.documentElement.scrollWidth;
      const clientWidth = document.documentElement.clientWidth;
      const hScroll = scrollWidth > clientWidth;
      return {
        headerH: header ? header.offsetHeight : 0,
        mainPadTop: main ? window.getComputedStyle(main).paddingTop : 0,
        panelPadTop: panel ? window.getComputedStyle(panel).paddingTop : 0,
        metaH: meta ? meta.offsetHeight : 0,
        h1H: h1 ? h1.offsetHeight : 0,
        cluesH: clues ? clues.offsetHeight : 0,
        firstBtnTop: firstRect ? Math.round(firstRect.top) : null,
        firstBtnVisible: firstRect ? (firstRect.top >= 0 && firstRect.top < window.innerHeight) : false,
        allButtonsAboveTheFold: lastRect ? (lastRect.bottom <= window.innerHeight) : false,
        lastBtnBottom: lastRect ? Math.round(lastRect.bottom) : null,
        innerHeight: window.innerHeight,
        btnCount: buttons.length,
        hasHorizontalScroll: hScroll,
        scrollWidth,
        clientWidth
      };
    }`);

    // All answer options A-D must be immediately usable above the fold without any scrolling
    const ok = decodeMetrics.firstBtnVisible && decodeMetrics.allButtonsAboveTheFold && !decodeMetrics.hasHorizontalScroll && decodeMetrics.btnCount === 4;
    results.push({
      viewport: `${vp.name} (${vp.width}×${vp.height})`,
      test: 'Decode Voting (Mobile)',
      pass: ok,
      details: `First btn: ${decodeMetrics.firstBtnTop}px, All 4 btns above fold: ${decodeMetrics.allButtonsAboveTheFold} (ends at ${decodeMetrics.lastBtnBottom}px / ${decodeMetrics.innerHeight}px), H-scroll: ${decodeMetrics.hasHorizontalScroll}`
    });
    if (!ok) allPassed = false;

    // 1b. Mobile Phone Test: Decode Map Component (Drawer & Styling)
    const phoneMapMetrics = await evaluate(`() => {
      const drawer = document.querySelector('.decode-map-drawer');
      if (drawer) drawer.open = true;
      const candidatePaths = Array.from(document.querySelectorAll('.state-polygon.is-candidate'));
      const neutralPaths = Array.from(document.querySelectorAll('.state-polygon.is-neutral'));
      const badges = Array.from(document.querySelectorAll('.state-badge'));
      const firstCandidate = candidatePaths[0];
      const firstNeutral = neutralPaths[0];
      const candidateFill = firstCandidate ? window.getComputedStyle(firstCandidate).fill : '';
      const neutralFill = firstNeutral ? window.getComputedStyle(firstNeutral).fill : '';
      return {
        candidateCount: candidatePaths.length,
        neutralCount: neutralPaths.length,
        badgeCount: badges.length,
        candidateFill,
        neutralFill,
        isNotBlack: candidateFill !== 'rgb(0, 0, 0)' && neutralFill !== 'rgb(0, 0, 0)' && candidateFill !== '' && neutralFill !== '',
        hasDrawer: Boolean(drawer)
      };
    }`);
    const phoneMapOk = phoneMapMetrics.hasDrawer &&
      phoneMapMetrics.candidateCount === 4 &&
      phoneMapMetrics.badgeCount === 4 &&
      phoneMapMetrics.isNotBlack;
    results.push({
      viewport: `${vp.name} (${vp.width}×${vp.height})`,
      test: 'Decode Map Component (Mobile)',
      pass: phoneMapOk,
      details: `Candidates: ${phoneMapMetrics.candidateCount}, Badges: ${phoneMapMetrics.badgeCount}, Candidate fill: ${phoneMapMetrics.candidateFill}, Neutral fill: ${phoneMapMetrics.neutralFill}, Not black: ${phoneMapMetrics.isNotBlack}`
    });
    if (!phoneMapOk) allPassed = false;

    // 2. Mobile Phone Test: Passport Reveal Screen
    await navigate(`http://127.0.0.1:${SERVER_PORT}/play?preview=passport-reveal`);
    const revealMetrics = await evaluate(`() => {
      const notice = document.querySelector('.result-notice');
      const buttons = document.querySelectorAll('.answer');
      const scrollWidth = document.documentElement.scrollWidth;
      const clientWidth = document.documentElement.clientWidth;
      return {
        hasNotice: Boolean(notice),
        isCorrectNotice: notice ? notice.classList.contains('result-correct') : false,
        hasHorizontalScroll: scrollWidth > clientWidth
      };
    }`);
    const revOk = revealMetrics.hasNotice && !revealMetrics.hasHorizontalScroll;
    results.push({
      viewport: `${vp.name} (${vp.width}×${vp.height})`,
      test: 'Passport Reveal (Mobile)',
      pass: revOk,
      details: `Notice visible: ${revealMetrics.hasNotice}, H-scroll: ${revealMetrics.hasHorizontalScroll}`
    });
    if (!revOk) allPassed = false;

    // 3. Mobile Phone Test: Passport Question with Image
    await navigate(`http://127.0.0.1:${SERVER_PORT}/play?preview=passport-image`);
    const imgMetrics = await evaluate(`() => {
      const img = document.querySelector('.question-image');
      const card = document.querySelector('.play-media-card');
      const scrollWidth = document.documentElement.scrollWidth;
      const clientWidth = document.documentElement.clientWidth;
      return {
        hasImg: Boolean(img),
        imgSrc: img ? img.src : null,
        hasHorizontalScroll: scrollWidth > clientWidth
      };
    }`);
    const imgOk = imgMetrics.hasImg && !imgMetrics.hasHorizontalScroll;
    results.push({
      viewport: `${vp.name} (${vp.width}×${vp.height})`,
      test: 'Passport Question Image (Mobile)',
      pass: imgOk,
      details: `Image loaded: ${imgMetrics.hasImg}, H-scroll: ${imgMetrics.hasHorizontalScroll}`
    });
    if (!imgOk) allPassed = false;

    // 4. Mobile Phone Test: Decode Clue 1, 2, 3 progression states
    for (const clueStep of [1, 2, 3]) {
      await navigate(`http://127.0.0.1:${SERVER_PORT}/play?preview=decode-clue${clueStep}`);
      const stepMetrics = await evaluate(`() => {
        const panel = document.querySelector('.decode-preparing-panel');
        const badge = document.querySelector('.decode-clue-stepper');
        const scrollWidth = document.documentElement.scrollWidth;
        const clientWidth = document.documentElement.clientWidth;
        return {
          hasPanel: Boolean(panel),
          hasStepper: Boolean(badge),
          hasHorizontalScroll: scrollWidth > clientWidth
        };
      }`);
      const stepOk = stepMetrics.hasPanel && stepMetrics.hasStepper && !stepMetrics.hasHorizontalScroll;
      results.push({
        viewport: `${vp.name} (${vp.width}×${vp.height})`,
        test: `Decode Clue ${clueStep} (Mobile)`,
        pass: stepOk,
        details: `Preparing panel: ${stepMetrics.hasPanel}, H-scroll: ${stepMetrics.hasHorizontalScroll}`
      });
      if (!stepOk) allPassed = false;
    }

    // 5. Mobile Phone Test: Structural Rerender Deduplication
    await navigate(`http://127.0.0.1:${SERVER_PORT}/play?preview=passport-text`);
    const dedupMetrics = await evaluate(`() => {
      const root = document.querySelector('#play-root');
      const initialPanel = root.firstElementChild;
      // Trigger local state re-render with identical state
      window.dispatchEvent(new Event('online'));
      const secondPanel = root.firstElementChild;
      return {
        sameDOMNode: initialPanel === secondPanel,
        hasPanel: Boolean(initialPanel)
      };
    }`);
    const dedupOk = dedupMetrics.sameDOMNode;
    results.push({
      viewport: `${vp.name} (${vp.width}×${vp.height})`,
      test: 'Render Deduplication (Mobile)',
      pass: dedupOk,
      details: `Identical state preserved DOM node: ${dedupMetrics.sameDOMNode} (0 destructive replacements)`
    });
    if (!dedupOk) allPassed = false;

  } else {
    // Projector Test: Passport Reveal room-scale layout (must fit within 100vh)
    await navigate(`http://127.0.0.1:${SERVER_PORT}/display?preview=passport-reveal`);
    const displayMetrics = await evaluate(`() => {
      const section = document.querySelector('.display-question');
      const rect = section ? section.getBoundingClientRect() : null;
      const winningAnswer = document.querySelector('.display-winning-answer');
      const explanation = document.querySelector('.display-reveal-explanation');
      const scrollHeight = document.documentElement.scrollHeight;
      const innerHeight = window.innerHeight;
      const vOverflow = scrollHeight > innerHeight + 2;
      return {
        fitsInViewport: !vOverflow,
        scrollHeight,
        innerHeight,
        hasWinningAnswer: Boolean(winningAnswer),
        hasExplanation: Boolean(explanation),
        bottom: rect ? Math.round(rect.bottom) : null
      };
    }`);

    const dispOk = displayMetrics.fitsInViewport && displayMetrics.hasWinningAnswer && displayMetrics.hasExplanation;
    results.push({
      viewport: `${vp.name} (${vp.width}×${vp.height})`,
      test: 'Passport Reveal Showcase (Projector)',
      pass: dispOk,
      details: `Fits in viewport: ${displayMetrics.fitsInViewport} (${displayMetrics.scrollHeight}px / ${displayMetrics.innerHeight}px), Winning answer visible: ${displayMetrics.hasWinningAnswer}`
    });
    if (!dispOk) allPassed = false;

    // Projector Test: Decode Question display & Nigeria Map SVG Rendering
    await navigate(`http://127.0.0.1:${SERVER_PORT}/display?preview=decode-voting`);
    const decodeProjMetrics = await evaluate(`() => {
      const section = document.querySelector('.display-question');
      const options = document.querySelectorAll('.display-option');
      const mapContainer = document.querySelector('#display-map-container');
      const mapWrapper = document.querySelector('.nigeria-map-wrapper');
      const svg = document.querySelector('.nigeria-states-svg');
      const candidatePaths = Array.from(document.querySelectorAll('.state-polygon.is-candidate'));
      const neutralPaths = Array.from(document.querySelectorAll('.state-polygon.is-neutral'));
      const badges = Array.from(document.querySelectorAll('.state-badge'));
      const badgeTexts = badges.map(b => b.querySelector('.badge-text')?.textContent?.trim()).sort();
      const firstCandidate = candidatePaths[0];
      const firstNeutral = neutralPaths[0];
      const candidateFill = firstCandidate ? window.getComputedStyle(firstCandidate).fill : '';
      const neutralFill = firstNeutral ? window.getComputedStyle(firstNeutral).fill : '';
      const scrollHeight = document.documentElement.scrollHeight;
      const innerHeight = window.innerHeight;
      const rect = mapContainer ? mapContainer.getBoundingClientRect() : null;

      return {
        fitsInViewport: scrollHeight <= innerHeight + 2,
        scrollHeight,
        innerHeight,
        optionsCount: options.length,
        hasMap: Boolean(mapContainer && svg),
        mapInsideViewport: rect ? (rect.top >= 0 && rect.bottom <= innerHeight + 2 && rect.left >= 0 && rect.right <= window.innerWidth) : false,
        candidateCount: candidatePaths.length,
        neutralCount: neutralPaths.length,
        badgeCount: badges.length,
        badgeTexts,
        candidateFill,
        neutralFill,
        isNotBlack: candidateFill !== 'rgb(0, 0, 0)' && neutralFill !== 'rgb(0, 0, 0)' && candidateFill !== '' && neutralFill !== ''
      };
    }`);
    const decodeProjOk = decodeProjMetrics.fitsInViewport &&
      decodeProjMetrics.optionsCount === 4 &&
      decodeProjMetrics.hasMap &&
      decodeProjMetrics.candidateCount === 4 &&
      decodeProjMetrics.badgeCount === 4 &&
      decodeProjMetrics.badgeTexts.join('') === 'ABCD' &&
      decodeProjMetrics.isNotBlack &&
      decodeProjMetrics.mapInsideViewport;

    results.push({
      viewport: `${vp.name} (${vp.width}×${vp.height})`,
      test: 'Decode Voting Display & Map (Projector)',
      pass: decodeProjOk,
      details: `Fits in viewport: ${decodeProjMetrics.fitsInViewport}, 4 candidates: ${decodeProjMetrics.candidateCount}, 4 badges: ${decodeProjMetrics.badgeCount} (${decodeProjMetrics.badgeTexts.join(',')}), Candidate fill: ${decodeProjMetrics.candidateFill}, Neutral fill: ${decodeProjMetrics.neutralFill}, Not black: ${decodeProjMetrics.isNotBlack}, Map in viewport: ${decodeProjMetrics.mapInsideViewport}`
    });
    if (!decodeProjOk) allPassed = false;

    // Projector Test: Decode Reveal display & Winning State Highlighting
    await navigate(`http://127.0.0.1:${SERVER_PORT}/display?preview=decode-reveal`);
    const decodeRevProjMetrics = await evaluate(`() => {
      const section = document.querySelector('.display-question.is-revealed');
      const correctOption = document.querySelector('.display-option.correct');
      const correctPath = document.querySelector('.state-polygon.is-correct');
      const correctBadge = document.querySelector('.state-badge.badge-correct');
      const correctFill = correctPath ? window.getComputedStyle(correctPath).fill : '';
      const candidatePaths = document.querySelectorAll('.state-polygon.is-candidate');
      const scrollHeight = document.documentElement.scrollHeight;
      const innerHeight = window.innerHeight;
      return {
        fitsInViewport: scrollHeight <= innerHeight + 2,
        scrollHeight,
        innerHeight,
        hasCorrect: Boolean(correctOption),
        hasCorrectPath: Boolean(correctPath),
        hasCorrectBadge: Boolean(correctBadge),
        correctBadgeText: correctBadge?.querySelector('.badge-text')?.textContent?.trim(),
        correctFill,
        isEmerald: correctFill === 'rgb(16, 185, 129)',
        candidateCount: candidatePaths.length
      };
    }`);
    const decodeRevOk = decodeRevProjMetrics.fitsInViewport &&
      decodeRevProjMetrics.hasCorrect &&
      decodeRevProjMetrics.hasCorrectPath &&
      decodeRevProjMetrics.isEmerald &&
      decodeRevProjMetrics.hasCorrectBadge &&
      decodeRevProjMetrics.candidateCount === 4;

    results.push({
      viewport: `${vp.name} (${vp.width}×${vp.height})`,
      test: 'Decode Reveal Display & Map (Projector)',
      pass: decodeRevOk,
      details: `Fits in viewport: ${decodeRevProjMetrics.fitsInViewport}, Correct path: ${decodeRevProjMetrics.hasCorrectPath} (${decodeRevProjMetrics.correctFill}), Badge text: ${decodeRevProjMetrics.correctBadgeText}, Candidates remaining: ${decodeRevProjMetrics.candidateCount}`
    });
    if (!decodeRevOk) allPassed = false;

    // Projector Test: Leaderboard display
    await navigate(`http://127.0.0.1:${SERVER_PORT}/display?preview=leaderboard`);
    const lbMetrics = await evaluate(`() => {
      const section = document.querySelector('.display-question');
      const scrollHeight = document.documentElement.scrollHeight;
      const innerHeight = window.innerHeight;
      return {
        fitsInViewport: scrollHeight <= innerHeight + 2,
        scrollHeight,
        innerHeight
      };
    }`);
    const lbOk = lbMetrics.fitsInViewport;
    results.push({
      viewport: `${vp.name} (${vp.width}×${vp.height})`,
      test: 'Leaderboard Display (Projector)',
      pass: lbOk,
      details: `Fits in viewport: ${lbMetrics.fitsInViewport} (${lbMetrics.scrollHeight}px / ${lbMetrics.innerHeight}px)`
    });
    if (!lbOk) allPassed = false;
  }
}

// Close browser and server
ws.close();
chromeProc.kill();
server.close();

console.log('\n--- VIEWPORT MATRIX RESULTS ---');
for (const r of results) {
  console.log(`${r.pass ? '✔ PASS' : '✖ FAIL'} | ${r.viewport} | ${r.test} | ${r.details}`);
}

if (!allPassed) {
  console.error('\nOne or more browser viewport matrix assertions failed.');
  process.exit(1);
}

console.log('\nAll browser viewport matrix assertions passed cleanly.');
process.exit(0);
