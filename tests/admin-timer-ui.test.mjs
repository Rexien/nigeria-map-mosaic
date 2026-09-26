import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../js/admin-console.js', import.meta.url), 'utf8');
const serverBase = 1_700_000_000_000;

function status(state, { openedAt = null, deadlineAt = null, serverNow = serverBase } = {}) {
  return {
    admin: { displayName: 'Operator' },
    settings: { active_activity: 'passport', screen_mode: 'activity', rehearsal_mode: false },
    session: {
      state, version: state === 'open' ? 2 : 1, current_question_id: state === 'open' ? 'q1' : null,
      opened_at: openedAt && new Date(openedAt).toISOString(),
      deadline_at: deadlineAt && new Date(deadlineAt).toISOString()
    },
    metrics: { participants: 0, responseCount: 0 },
    questions: [{ id: 'q1', activity: 'passport', category: 'Test', question: 'Which?' }],
    serverNow: new Date(serverNow).toISOString()
  };
}

function createAdminPage(request) {
  const clock = { now: serverBase + 20_000 };
  const intervals = new Map();
  const elements = new Map();
  const classList = () => ({ add() {}, remove() {}, toggle() {} });
  const element = () => ({ textContent: '', innerHTML: '', value: '', checked: false, disabled: false,
    dataset: {}, classList: classList(), setAttribute() {}, addEventListener() {} });
  const select = element();
  select.options = [];
  Object.defineProperty(select, 'innerHTML', {
    get() { return this._html; },
    set(value) { this._html = value; this.options = [{ value: '' }]; }
  });
  select.add = option => select.options.push(option);
  elements.set('#question-select', select);
  const document = {
    body: { dataset: { page: 'admin-console' } },
    querySelector(selector) {
      if (selector === '#moderation-body') return null;
      if (!elements.has(selector)) elements.set(selector, element());
      return elements.get(selector);
    },
    querySelectorAll() { return []; },
    addEventListener(type, callback) { if (type === 'DOMContentLoaded') this.ready = callback; }
  };
  class LocalDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  runInNewContext(source, {
    Date: LocalDate,
    document,
    location: { hostname: 'event.example' },
    window: { NIACApi: { hasAdmin: () => true, request } },
    Option: function Option(label, value) { this.label = label; this.value = value; },
    setInterval(callback, delay) { intervals.set(delay, callback); }
  });
  return { clock, intervals, elements, ready: () => document.ready() };
}

test('admin cue uses server time and moves from get ready to live to revealing locally', async () => {
  const page = createAdminPage(() => Promise.resolve(status('open', {
    openedAt: serverBase + 5_000, deadlineAt: serverBase + 25_000
  })));
  await page.ready();
  const guidance = page.elements.get('#operator-guidance');
  assert.match(guidance.textContent, /Get ready · answers open in 5s/);
  assert.equal(page.intervals.has(250), true);

  page.clock.now += 5_000;
  page.intervals.get(250)();
  assert.match(guidance.textContent, /Question live · 20s remaining/);

  page.clock.now += 19_001;
  page.intervals.get(250)();
  assert.match(guidance.textContent, /Question live · 1s remaining/);

  page.clock.now += 999;
  page.intervals.get(250)();
  assert.match(guidance.textContent, /closing answers and revealing/);
  assert.doesNotMatch(guidance.textContent, /0s remaining/);
});

test('a stale status poll cannot replace the post-action state', async () => {
  let statusCalls = 0;
  let releaseOldPoll;
  const page = createAdminPage((path) => {
    if (path === '/admin/action') return Promise.resolve({});
    assert.equal(path, '/admin/status');
    statusCalls += 1;
    if (statusCalls === 1) return Promise.resolve(status('lobby'));
    if (statusCalls === 2) return new Promise(resolve => { releaseOldPoll = resolve; });
    return Promise.resolve(status('open', {
      openedAt: serverBase + 5_000, deadlineAt: serverBase + 25_000
    }));
  });
  await page.ready();
  page.intervals.get(2500)();
  assert.equal(statusCalls, 2);

  page.elements.get('#question-select').value = 'q1';
  const open = page.elements.get('#open-question');
  open.onclick({ currentTarget: open });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(statusCalls, 3, 'the action must request fresh status while polling is in flight');
  assert.match(page.elements.get('#operator-guidance').textContent, /Get ready/);

  releaseOldPoll(status('lobby'));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(page.elements.get('#operator-guidance').textContent, /Get ready/);
  assert.equal(page.elements.get('#live-state').textContent, 'Answers are open');
});
