import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { sanitizePublicQuestion, createStateEnvelope } from '../lib/state-envelope.mjs';
import { optimizedDecodeAsset } from '../lib/question-media.mjs';
import { generateSnapshots } from '../lib/snapshot-scoring.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

test('decode rounds bank has 6 vetted candidate rounds with 3 clues and 4 balanced options', async () => {
  const content = JSON.parse(await readFile(join(root, 'content', 'decode-rounds.json'), 'utf8'));
  assert.equal(content.rounds.length, 6, 'Must contain 6 vetted candidate rounds');

  const expectedStates = ['Ogun', 'Kano', 'Niger', 'Anambra', 'Cross River', 'Lagos'];
  const optionCounts = [0, 0, 0, 0];

  for (let i = 0; i < content.rounds.length; i++) {
    const round = content.rounds[i];
    assert.ok(expectedStates.includes(round.state), `Round ${i + 1} state ${round.state} must be in vetted candidate set`);
    assert.equal(round.clues.length, 3, `Round ${round.state} must have 3 clues`);
    assert.equal(round.clueMedia.length, 3, `Round ${round.state} must have 3 clueMedia items`);
    assert.equal(round.options.length, 4, `Round ${round.state} must have 4 candidate state options`);
    assert.ok(round.options.includes(round.state), `Round ${round.state} options must include the correct state`);
    assert.equal(round.options[round.correctOption], round.state, `correctOption must point to the correct state`);
    assert.ok(round.revealFact && round.revealFact.length > 20, `Round ${round.state} must have detailed revealFact`);
    assert.equal(round.durationSeconds, 30, `Round ${round.state} must have 30s voting duration`);

    optionCounts[round.correctOption]++;

    // Verify media files exist on disk
    for (const media of round.clueMedia) {
      assert.ok(media.src.startsWith('/assets/decode/'), `Media ${media.src} must reside in /assets/decode/`);
      const filePath = join(root, media.src.slice(1));
      const s = await stat(filePath);
      assert.ok(s.size > 20000, `Media ${media.src} must be valid downloaded asset (> 20KB)`);
      const optimizedPath = filePath.replace(/\.jpe?g$/i, '.webp');
      const optimized = await stat(optimizedPath);
      assert.ok(optimized.size < s.size, `Optimized Decode media ${optimizedPath} must be smaller than its JPEG`);
      assert.equal(optimizedDecodeAsset(media.src, 'decode'), media.src.replace(/\.jpe?g$/i, '.webp'));
      assert.ok(media.alt && media.alt.length > 10, `Media ${media.src} must have descriptive alt text`);
      // Ensure alt text does not give away the state name before reveal!
      assert.ok(
        !media.alt.toLowerCase().includes(round.state.toLowerCase()),
        `Alt text "${media.alt}" must NOT reveal state name "${round.state}" early`
      );
    }
  }

  // Check balanced distribution of correct options
  for (let idx = 0; idx < 4; idx++) {
    assert.ok(optionCounts[idx] >= 1, `Option ${String.fromCharCode(65 + idx)} must be represented as correct option`);
  }
});

test('Decode preparation publishes all three safe clues and compressed photos without answer choices', () => {
  const question = {
    id: 'decode-ready', activity: 'decode', title: 'Decode the State',
    question: 'Which Nigerian state do these clues describe?',
    options: ['Ogun', 'Kano', 'Niger', 'Anambra'], correctOption: 0,
    clues: ['Clue one is ready.', 'Clue two is ready.', 'Clue three is ready.'],
    clueMedia: [1, 2, 3].map(i => ({ src: `/assets/decode/0${i}.jpg`, alt: `Photo ${i}` }))
  };
  const ready = createStateEnvelope({ state: 'preparing', activity: 'decode', sessionId: 'decode-session', version: 1 }, question);
  assert.equal(ready.question.cluesSoFar.length, 3);
  assert.deepEqual(ready.question.clueMediaSoFar.map(item => item.src), [
    '/assets/decode/01.webp', '/assets/decode/02.webp', '/assets/decode/03.webp'
  ]);
  assert.deepEqual(ready.question.options, []);
  assert.equal(ready.question.correctOption, undefined);
});

test('nigeria states map paths dataset covers 36 states and FCT without labeling FCT as a state', async () => {
  const mapFile = await readFile(join(root, 'data', 'nigeria-states-paths.js'), 'utf8');
  assert.ok(mapFile.includes('NIGERIA_STATES_MAP'), 'Must export NIGERIA_STATES_MAP');

  const context = {};
  const fn = new Function('window', 'globalThis', mapFile);
  fn(context, context);

  const statesMap = context.NIGERIA_STATES_MAP;
  assert.ok(statesMap, 'statesMap must be defined');

  const keys = Object.keys(statesMap);
  assert.equal(keys.length, 37, 'Must cover 36 states + 1 FCT = 37 regions');

  // Verify FCT specifically
  const fct = statesMap['Federal Capital Territory'] || statesMap['FCT'];
  assert.ok(fct, 'FCT must exist in dataset');
  assert.equal(fct.isFCT, true, 'FCT must have isFCT: true');
  assert.ok(!fct.name.includes('State'), 'FCT name must not say "State"');

  // Verify centroids and paths
  for (const [name, data] of Object.entries(statesMap)) {
    assert.ok(data.path && data.path.startsWith('M'), `State ${name} must have valid SVG path`);
    assert.ok(Array.isArray(data.center) && data.center.length === 2, `State ${name} must have center [x, y]`);
    assert.ok(data.center[0] >= 0 && data.center[0] <= 800, `State ${name} cx within viewBox`);
    assert.ok(data.center[1] >= 0 && data.center[1] <= 680, `State ${name} cy within viewBox`);
  }
});

test('decode state progression and secret suppression in state envelopes', () => {
  const rawDecodeQuestion = {
    id: 'decode-1',
    activity: 'decode',
    title: 'Decode the State',
    category: 'South West',
    question: 'Which Nigerian state do these clues describe?',
    options: ['Ogun', 'Kano', 'Niger', 'Anambra'],
    correctOption: 0,
    explanation: 'Olumo Rock is iconic to Ogun State.',
    durationSeconds: 30,
    clueNumber: 1,
    clue: 'Clue 1: Famous for its sacred indigo dye tradition',
    cluesSoFar: ['Clue 1: Famous for its sacred indigo dye tradition'],
    clueMediaSoFar: [{
      src: '/assets/decode/01.jpg',
      alt: 'Indigo fabric',
      timing: 'question',
      caption: 'Secret caption in Ogun',
      author: 'Photographer',
      license: 'CC BY-SA 4.0'
    }],
    media: {
      src: '/assets/decode/01.jpg',
      alt: 'Indigo fabric',
      timing: 'question',
      caption: 'Secret caption in Ogun',
      author: 'Photographer',
      license: 'CC BY-SA 4.0'
    },
    highlightState: 'Ogun'
  };

  // State 1: preparing (Clue 1 is showing on screen, no voting yet)
  const preparingSafe = sanitizePublicQuestion(rawDecodeQuestion, 'preparing');
  assert.ok(preparingSafe !== null, 'Decode question MUST be visible in preparing state for clue progression');
  assert.equal(preparingSafe.clueNumber, 1);
  assert.equal(preparingSafe.clue, 'Clue 1: Famous for its sacred indigo dye tradition');
  assert.deepEqual(preparingSafe.options, [], 'Options must be empty array during preparing state to prevent early leak');
  assert.equal(preparingSafe.correctOption, undefined, 'correctOption must be suppressed');
  assert.equal(preparingSafe.explanation, undefined, 'explanation must be suppressed');
  assert.equal(preparingSafe.highlightState, undefined, 'highlightState must be suppressed');
  assert.equal(preparingSafe.media.caption, undefined, 'media caption must be suppressed before reveal');

  // State 2: open (Voting opens with 30s countdown and candidate state options A-D)
  const openSafe = sanitizePublicQuestion(rawDecodeQuestion, 'open');
  assert.ok(openSafe !== null);
  assert.deepEqual(openSafe.options, ['Ogun', 'Kano', 'Niger', 'Anambra'], 'Options A-D must be exposed when voting opens');
  assert.equal(openSafe.correctOption, undefined, 'correctOption must remain suppressed while voting is open');
  assert.equal(openSafe.explanation, undefined, 'explanation must remain suppressed while voting is open');
  assert.equal(openSafe.highlightState, undefined, 'highlightState must remain suppressed while voting is open');
  assert.equal(openSafe.media.caption, undefined, 'media caption must remain suppressed while voting is open');

  // State 3: revealed (Answer revealed, winning state pulses on map, educational facts and credits displayed)
  const revealedSafe = sanitizePublicQuestion(rawDecodeQuestion, 'revealed');
  assert.ok(revealedSafe !== null);
  assert.equal(revealedSafe.correctOption, 0, 'correctOption must be revealed');
  assert.equal(revealedSafe.explanation, 'Olumo Rock is iconic to Ogun State.', 'explanation must be revealed');
  assert.equal(revealedSafe.highlightState, 'Ogun', 'highlightState must be revealed');
  assert.equal(revealedSafe.media.caption, 'Secret caption in Ogun', 'media caption must be revealed');
  assert.equal(revealedSafe.clueMediaSoFar[0].caption, 'Secret caption in Ogun', 'clueMediaSoFar caption revealed');
});

test('decode scoring awards 1,000 points and calculates separate decode leaderboard', () => {
  const participants = [
    { id: 'p1', alias: 'Adaeze', registeredAt: '2026-09-01T10:00:00Z', isSpectator: false },
    { id: 'p2', alias: 'Emeka', registeredAt: '2026-09-01T10:01:00Z', isSpectator: false },
    { id: 'p3', alias: 'Babajide', registeredAt: '2026-09-01T10:02:00Z', isSpectator: false }
  ];

  const answers = [
    // Adaeze answered decode-1 correctly in 4.5 seconds
    {
      participantId: 'p1',
      questionId: 'decode-1',
      activity: 'decode',
      correct: true,
      points: 1000,
      responseMs: 4500,
      voided: false
    },
    // Emeka answered decode-1 correctly in 8.2 seconds
    {
      participantId: 'p2',
      questionId: 'decode-1',
      activity: 'decode',
      correct: true,
      points: 1000,
      responseMs: 8200,
      voided: false
    },
    // Babajide answered decode-1 incorrectly
    {
      participantId: 'p3',
      questionId: 'decode-1',
      activity: 'decode',
      correct: false,
      points: 0,
      responseMs: 2100,
      voided: false
    }
  ];

  const { leaderboards, participantSnapshotsMap } = generateSnapshots({
    sessionId: 'test-session',
    snapshotVersion: 1,
    participants,
    answers,
    questions: [{ id: 'decode-1', activity: 'decode', points: 1000 }]
  });

  assert.equal(participantSnapshotsMap.get('p1').scores.decode, 1000, 'Adaeze receives 1,000 points');
  assert.equal(participantSnapshotsMap.get('p2').scores.decode, 1000, 'Emeka receives 1,000 points');
  assert.equal(participantSnapshotsMap.get('p3').scores.decode, 0, 'Babajide receives 0 points');

  // Leaderboard tie-breaking: Adaeze was faster (4500ms vs 8200ms)
  const decodeLeaders = leaderboards.decode.leaders;
  assert.equal(decodeLeaders[0].alias, 'Adaeze', 'Faster correct answer ranks #1');
  assert.equal(decodeLeaders[1].alias, 'Emeka', 'Slower correct answer ranks #2');
  assert.equal(decodeLeaders[2].alias, 'Babajide', 'Wrong answer ranks #3');
});

test('nigeria states map css architecture: shared stylesheet loaded on display.html and play.html, app.css not loaded on display', async () => {
  const [mapCss, displayHtml, playHtml, appCss] = await Promise.all([
    readFile(join(root, 'css', 'nigeria-states-map.css'), 'utf8'),
    readFile(join(root, 'display.html'), 'utf8'),
    readFile(join(root, 'play.html'), 'utf8'),
    readFile(join(root, 'css', 'app.css'), 'utf8')
  ]);

  // Shared map stylesheet must define component primitives
  assert.ok(mapCss.includes('.state-polygon.is-neutral'), 'Must define neutral states');
  assert.ok(mapCss.includes('.state-polygon.is-candidate'), 'Must define candidate states');
  assert.ok(mapCss.includes('.state-polygon.is-correct'), 'Must define correct state reveal');
  assert.ok(mapCss.includes('.state-badge'), 'Must define state badges');
  assert.ok(mapCss.includes('.badge-circle'), 'Must define badge circles');
  assert.ok(mapCss.includes('.badge-text'), 'Must define badge letters');

  // Neutral states must use light cream-green fill (#dbe8df) and legible stroke (#6f8578)
  assert.ok(mapCss.includes('#dbe8df'), 'Neutral fill must be light green (#dbe8df)');
  assert.ok(mapCss.includes('#6f8578'), 'Neutral stroke must be visible (#6f8578)');

  // Candidate states must use stronger green fill (#6fa98a) and gold stroke (#e9ad16)
  assert.ok(mapCss.includes('#6fa98a'), 'Candidate fill must be prominent green (#6fa98a)');
  assert.ok(mapCss.includes('#e9ad16'), 'Candidate stroke must be gold (#e9ad16)');

  // Badges must use gold circle (#e9ad16) and dark text (#063f2a)
  assert.ok(mapCss.includes('#063f2a'), 'Badge text/stroke must be dark forest green');

  // display.html must link nigeria-states-map.css, but MUST NOT link app.css
  assert.ok(displayHtml.includes('/css/nigeria-states-map.css'), 'display.html must link /css/nigeria-states-map.css');
  assert.ok(!displayHtml.includes('/css/app.css'), 'display.html MUST NOT load /css/app.css to avoid contaminating layout');

  // play.html must link both nigeria-states-map.css and app.css
  assert.ok(playHtml.includes('/css/nigeria-states-map.css'), 'play.html must link /css/nigeria-states-map.css');
  assert.ok(playHtml.includes('/css/app.css'), 'play.html must link /css/app.css');

  // app.css must have had duplicated component primitives removed
  assert.ok(!appCss.includes('.state-polygon.is-neutral'), 'app.css must not duplicate .state-polygon.is-neutral');
  assert.ok(!appCss.includes('.state-polygon.is-candidate{'), 'app.css must not duplicate .state-polygon.is-candidate');
  assert.ok(!appCss.includes('.state-badge .badge-circle'), 'app.css must not duplicate badge circle styles');
});

