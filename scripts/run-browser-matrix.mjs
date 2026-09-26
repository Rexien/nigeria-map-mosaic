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
  '/lens/live': 'lens-live.html',
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
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

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
// Chrome 136+ ignores remote-debugging flags against its default profile.
// A disposable non-default profile keeps CDP available in CI without touching user data.
const chromeUserDataDir = mkdtempSync(join(tmpdir(), 'niac-browser-matrix-'));
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
  } catch {
    // Best-effort cleanup only. CI runners and OS temp cleanup will remove leftovers.
  }
}

// Wait for CDP to respond
let cdpAvailable = false;
for (let i = 0; i < 80; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
    if (res.ok) { cdpAvailable = true; break; }
  } catch {}
  await new Promise(r => setTimeout(r, 250));
}

if (!cdpAvailable) {
  await stopChrome();
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
  { name: 'Projector XGA', width: 1024, height: 768, isMobile: false },
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
    await navigate(`http://127.0.0.1:${SERVER_PORT}/play?preview=passport-starting`);
    const beforeStart = await evaluate(`() => ({
      timer: Number(document.querySelector('#timer')?.textContent),
      label: document.querySelector('#timer')?.getAttribute('aria-label'),
      disabled: [...document.querySelectorAll('.answer')].every(button => button.disabled),
      note: document.querySelector('#answer-message')?.textContent || ''
    })`);
    await new Promise(resolve => setTimeout(resolve, 2000));
    const afterStart = await evaluate(`() => ({
      timer: Number(document.querySelector('#timer')?.textContent),
      label: document.querySelector('#timer')?.getAttribute('aria-label'),
      enabled: [...document.querySelectorAll('.answer')].every(button => !button.disabled),
      note: document.querySelector('#answer-message')?.textContent || ''
    })`);
    const countdownOk = beforeStart.disabled && beforeStart.label === 'Seconds until answers open' &&
      beforeStart.note.includes('Answers open in') && afterStart.enabled &&
      afterStart.label === 'Seconds remaining' && afterStart.timer >= 18 && afterStart.timer <= 20;
    results.push({
      viewport: `${vp.name} (${vp.width}×${vp.height})`,
      test: 'Scheduled Question Start (Mobile)',
      pass: countdownOk,
      details: `Before: ${beforeStart.timer}s, disabled: ${beforeStart.disabled}; after: ${afterStart.timer}s, enabled: ${afterStart.enabled}`
    });
    if (!countdownOk) allPassed = false;

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
        allButtonsReachable: Boolean(lastRect && lastRect.bottom <= document.documentElement.scrollHeight + 2),
        lastBtnBottom: lastRect ? Math.round(lastRect.bottom) : null,
        innerHeight: window.innerHeight,
        btnCount: buttons.length,
        hasHorizontalScroll: hScroll,
        scrollWidth,
        clientWidth
      };
    }`);

    // The first answer is immediately visible; all four remain reachable by normal vertical scrolling.
    const ok = decodeMetrics.firstBtnVisible && decodeMetrics.allButtonsReachable && !decodeMetrics.hasHorizontalScroll && decodeMetrics.btnCount === 4;
    results.push({
      viewport: `${vp.name} (${vp.width}×${vp.height})`,
      test: 'Decode Voting (Mobile)',
      pass: ok,
      details: `First option: ${decodeMetrics.firstBtnTop}px, all options scroll-reachable: ${decodeMetrics.allButtonsReachable} (last ends at ${decodeMetrics.lastBtnBottom}px / viewport ${decodeMetrics.innerHeight}px), H-scroll: ${decodeMetrics.hasHorizontalScroll}`
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

    // 4. Mobile Phone Test: every Decode preparing state shows all three clues and photos
    for (const clueStep of [1, 2, 3]) {
      await navigate(`http://127.0.0.1:${SERVER_PORT}/play?preview=decode-clue${clueStep}`);
      const stepMetrics = await evaluate(`() => {
        const panel = document.querySelector('.decode-preparing-panel');
        const cards = [...document.querySelectorAll('.decode-preparing-panel .decode-clue-item')];
        const images = cards.map(card => card.querySelector('img'));
        const imageWidths = images.map(img => Math.round(img.getBoundingClientRect().width));
        const scrollWidth = document.documentElement.scrollWidth;
        const clientWidth = document.documentElement.clientWidth;
        return {
          hasPanel: Boolean(panel),
          clueCount: cards.length,
          loadedPhotos: images.filter(img => img?.complete && img.naturalWidth > 0).length,
          imageWidths,
          hasHorizontalScroll: scrollWidth > clientWidth
        };
      }`);
      const stepOk = stepMetrics.hasPanel && stepMetrics.clueCount === 3 && stepMetrics.loadedPhotos === 3 && stepMetrics.imageWidths.every(width => width >= 80) && !stepMetrics.hasHorizontalScroll;
      results.push({
        viewport: `${vp.name} (${vp.width}×${vp.height})`,
        test: `Decode all clues/photos (legacy preview ${clueStep})`,
        pass: stepOk,
        details: `Clue cards: ${stepMetrics.clueCount}, photos loaded: ${stepMetrics.loadedPhotos}, photo widths: ${stepMetrics.imageWidths.join(', ')}, H-scroll: ${stepMetrics.hasHorizontalScroll}`
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
    // Projector composition audit: every display state must respect the fixed
    // parent status safe-area and the decorative edge bands.
    const projectorStates = [
      ['Welcome', 'welcome'],
      ['Lens', 'lens'],
      ['Passport Standby', 'passport-standby'],
      ['Passport Question Open', 'passport-text'],
      ['Passport Reveal', 'passport-reveal'],
      ['Leaderboard', 'leaderboard'],
      ['Decode All Clues (legacy preview 1)', 'decode-clue1'],
      ['Decode All Clues (legacy preview 2)', 'decode-clue2'],
      ['Decode All Clues (legacy preview 3)', 'decode-clue3'],
      ['Decode Voting', 'decode-voting'],
      ['Decode Reveal', 'decode-reveal']
    ];

    for (const [label, preview] of projectorStates) {
      await navigate(`http://127.0.0.1:${SERVER_PORT}/display?preview=${preview}`);
      if (preview === 'lens') {
        // The first cold Lens load parses the local D3/cloud bundles before the
        // final controller runs; wait for the ownership state, not merely HTML.
        for (let attempt = 0; attempt < 75; attempt++) {
          const embedReady = await evaluate(`() => {
            const doc = document.querySelector('#lens-projector-frame')?.contentDocument;
            const live = doc?.querySelector('.live-pulse-container');
            return Boolean(doc?.documentElement?.classList.contains('is-embedded') && live && getComputedStyle(live).display === 'none');
          }`);
          if (embedReady) break;
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }
      const composition = await evaluate(`() => {
        const visible = el => {
          if (!el) return false;
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        const status = document.querySelector('.screen-status');
        const statusRect = status?.getBoundingClientRect();
        const decodeCards = Array.from(document.querySelectorAll('.display-decode-clues .decode-clue-item'));
        const decodeImages = decodeCards.map(card => card.querySelector('img'));
        const decodePhotosLoaded = decodeImages.filter(img => img?.complete && img.naturalWidth > 0).length;
        const protectedContent = Array.from(document.querySelectorAll('.display-question footer > *, .join-box, .standby-content, .display-option, .display-winning-card, .display-explanation-card, .display-map-card, .display-clue-card, .display-timer')).filter(visible);
        const collisions = statusRect ? protectedContent.filter(el => overlaps(statusRect, el.getBoundingClientRect())).map(el => el.className || el.tagName) : [];
        const edgeHeight = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--edge-height')) || 0;
        const footers = Array.from(document.querySelectorAll('.display-question footer')).filter(visible);
        const footerBehindBand = footers.some(el => el.getBoundingClientRect().bottom > innerHeight - edgeHeight + 1);
        const footerBottom = footers.length ? Math.round(footers[0].getBoundingClientRect().bottom) : null;
        const section = document.querySelector('.display-question');
        const sectionBottom = section ? Math.round(section.getBoundingClientRect().bottom) : null;
        const textNodes = Array.from(document.querySelectorAll('.display-question h1, .display-option, .display-question footer, .display-decode-clues .decode-clue-item p, .join-url, .standby-content')).filter(visible);
        const clippedText = textNodes.filter(el => {
          const style = getComputedStyle(el);
          const clipsOverflow = ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowX) || ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowY);
          return clipsOverflow && (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2);
        }).map(el => el.className || el.tagName);
        return {
          hasHorizontalScroll: document.documentElement.scrollWidth > innerWidth + 2,
          hasVerticalScroll: document.documentElement.scrollHeight > innerHeight + 2,
          statusInsideViewport: Boolean(statusRect && statusRect.left >= 0 && statusRect.right <= innerWidth + 1 && statusRect.top >= 0 && statusRect.bottom <= innerHeight - edgeHeight + 1),
          collisions,
          footerBehindBand,
          footerBottom,
          sectionBottom,
          decodeCardCount: decodeCards.length,
          decodePhotosLoaded,
          clippedText
        };
      }`);
      const isDecodePreparingPreview = preview.startsWith('decode-clue');
      const decodePhotosOk = !isDecodePreparingPreview || (composition.decodeCardCount === 3 && composition.decodePhotosLoaded === 3);
      const compositionOk = !composition.hasHorizontalScroll && !composition.hasVerticalScroll && composition.statusInsideViewport && composition.collisions.length === 0 && !composition.footerBehindBand && composition.clippedText.length === 0 && decodePhotosOk;
      results.push({
        viewport: `${vp.name} (${vp.width}×${vp.height})`,
        test: `${label} Composition (Projector)`,
        pass: compositionOk,
        details: `H-scroll: ${composition.hasHorizontalScroll}, V-scroll: ${composition.hasVerticalScroll}, status safe: ${composition.statusInsideViewport}, collisions: ${composition.collisions.length}, clipped text: ${composition.clippedText.length}, footer behind band: ${composition.footerBehindBand} (footer ${composition.footerBottom}px, section ${composition.sectionBottom}px), clue photos: ${composition.decodePhotosLoaded}/${composition.decodeCardCount}`
      });
      if (!compositionOk) allPassed = false;

      if (preview === 'lens') {
        const lensMetrics = await evaluate(`() => {
          const frame = document.querySelector('#lens-projector-frame');
          const doc = frame?.contentDocument;
          const status = document.querySelector('.screen-status');
          const childLive = doc?.querySelector('.live-pulse-container');
          const badge = doc?.querySelector('.event-badge');
          const url = doc?.querySelector('#submit-url-badge');
          if (url) url.textContent = 'niaclive-git-feature-admin-pin-auth-zamijudes-projects.vercel.app';
          const statusRect = status?.getBoundingClientRect();
          const frameRect = frame?.getBoundingClientRect();
          const urlRect = url?.getBoundingClientRect();
          const translatedUrlRect = urlRect && frameRect ? {
            left: frameRect.left + urlRect.left,
            right: frameRect.left + urlRect.right,
            top: frameRect.top + urlRect.top,
            bottom: frameRect.top + urlRect.bottom
          } : null;
          const overlaps = (a, b) => a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
          return {
            iframeReady: Boolean(doc && url),
            childLiveHidden: childLive ? getComputedStyle(childLive).display === 'none' : false,
            childBadgeHasLiveText: /live|realtime/i.test(badge?.textContent || ''),
            childHorizontalScroll: doc ? doc.documentElement.scrollWidth > doc.documentElement.clientWidth + 2 : true,
            urlInsideChild: Boolean(urlRect && urlRect.left >= 0 && urlRect.right <= doc.documentElement.clientWidth + 1 && urlRect.bottom <= doc.documentElement.clientHeight + 1),
            urlClipped: Boolean(url && (url.scrollWidth > url.clientWidth + 2 || url.scrollHeight > url.clientHeight + 2)),
            urlOverlapsParentStatus: overlaps(translatedUrlRect, statusRect)
          };
        }`);
        const lensOk = lensMetrics.iframeReady && lensMetrics.childLiveHidden && !lensMetrics.childBadgeHasLiveText && !lensMetrics.childHorizontalScroll && lensMetrics.urlInsideChild && !lensMetrics.urlClipped && !lensMetrics.urlOverlapsParentStatus;
        results.push({
          viewport: `${vp.name} (${vp.width}×${vp.height})`,
          test: 'Embedded Lens Chrome Ownership (Projector)',
          pass: lensOk,
          details: `iframe ready: ${lensMetrics.iframeReady}, child live hidden: ${lensMetrics.childLiveHidden}, duplicate live text: ${lensMetrics.childBadgeHasLiveText}, H-scroll: ${lensMetrics.childHorizontalScroll}, long URL inside: ${lensMetrics.urlInsideChild}, clipped: ${lensMetrics.urlClipped}, status overlap: ${lensMetrics.urlOverlapsParentStatus}`
        });
        if (!lensOk) allPassed = false;
      }
    }

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
await stopChrome();
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
