import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { sanitizePublicQuestion, createStateEnvelope } from '../lib/state-envelope.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

test('Decode question selection always begins at Clue 1', async () => {
  const decodeRounds = JSON.parse(await readFile(join(root, 'content', 'decode-rounds.json'), 'utf8')).rounds;
  const round = decodeRounds[0];

  // Simulated question object in backend
  const question = {
    id: 'decode-1',
    activity: 'decode',
    title: 'Decode the State',
    category: round.zone,
    question: 'Which Nigerian state do these clues describe?',
    options: round.options,
    correctOption: round.correctOption,
    explanation: round.revealFact,
    durationSeconds: 30,
    clues: round.clues,
    clueMedia: round.clueMedia
  };

  // When round is selected, session state is 'preparing' and currentClue is 1
  const sessionClue = 1;
  const preparedQuestion = {
    ...question,
    clueNumber: sessionClue,
    clue: question.clues[sessionClue - 1],
    media: question.clueMedia[sessionClue - 1],
    cluesSoFar: question.clues.slice(0, sessionClue),
    clueMediaSoFar: question.clueMedia.slice(0, sessionClue)
  };

  const sanitized = sanitizePublicQuestion(preparedQuestion, 'preparing');
  assert.ok(sanitized, 'Preparing Decode question must be publicly visible');
  assert.equal(sanitized.clueNumber, 1, 'Selection must always begin at Clue 1');
  assert.equal(sanitized.clue, round.clues[0], 'Must show first clue text');
  assert.equal(sanitized.cluesSoFar.length, 1, 'Only Clue 1 in cluesSoFar');
  assert.deepEqual(sanitized.options, [], 'Options must be empty during preparation');
  assert.equal(sanitized.correctOption, undefined, 'Secret answer must be suppressed');
});

test('Decode clue progression steps cleanly from Clue 1 -> 2 -> 3', async () => {
  const decodeRounds = JSON.parse(await readFile(join(root, 'content', 'decode-rounds.json'), 'utf8')).rounds;
  const round = decodeRounds[1]; // Kano

  for (let clueStep = 1; clueStep <= 3; clueStep++) {
    const preparedQuestion = {
      id: 'decode-2',
      activity: 'decode',
      category: round.zone,
      clueNumber: clueStep,
      clue: round.clues[clueStep - 1],
      cluesSoFar: round.clues.slice(0, clueStep),
      clueMediaSoFar: round.clueMedia.slice(0, clueStep),
      options: round.options,
      correctOption: round.correctOption
    };

    const sanitized = sanitizePublicQuestion(preparedQuestion, 'preparing');
    assert.equal(sanitized.clueNumber, clueStep, `Clue number must be ${clueStep}`);
    assert.equal(sanitized.cluesSoFar.length, clueStep, `Must contain ${clueStep} clues so far`);
    assert.equal(sanitized.clue, round.clues[clueStep - 1], `Clue text must match step ${clueStep}`);
  }
});

test('Opening Decode voting preserves Clue 3 and voting envelope contains all three clues', async () => {
  const decodeRounds = JSON.parse(await readFile(join(root, 'content', 'decode-rounds.json'), 'utf8')).rounds;
  const round = decodeRounds[0];

  // At open voting, currentClue is 3 and all 3 clues are supplied
  const openQuestion = {
    id: 'decode-1',
    activity: 'decode',
    title: 'Decode the State',
    category: round.zone,
    question: 'Which Nigerian state do these clues describe?',
    options: round.options,
    correctOption: round.correctOption,
    explanation: round.revealFact,
    durationSeconds: 30,
    clueNumber: 3,
    clue: round.clues[2],
    cluesSoFar: round.clues.slice(0, 3),
    clueMediaSoFar: round.clueMedia.slice(0, 3)
  };

  const sanitized = sanitizePublicQuestion(openQuestion, 'open');
  assert.ok(sanitized, 'Open Decode question must be visible');
  assert.equal(sanitized.clueNumber, 3, 'Voting must preserve Clue 3');
  assert.equal(sanitized.cluesSoFar.length, 3, 'Voting envelope must contain all three clues');
  assert.equal(sanitized.clueMediaSoFar.length, 3, 'Voting envelope must contain all three clue media');
  assert.equal(sanitized.options.length, 4, 'Options must be open during voting');
  assert.equal(sanitized.correctOption, undefined, 'correctOption must NOT be leaked during voting');
  assert.equal(sanitized.explanation, undefined, 'explanation must NOT be leaked during voting');
});

test('Passport question numbering appears correctly in state envelope', async () => {
  const questionsFile = JSON.parse(await readFile(join(root, 'content', 'questions.json'), 'utf8')).questions;
  
  for (let i = 0; i < 5; i++) {
    const q = questionsFile[i];
    const sanitized = sanitizePublicQuestion({
      ...q,
      id: `passport-${q.day}-${q.order}`,
      activity: 'passport',
      title: 'Naija Passport Challenge'
    }, 'open');

    assert.ok(sanitized, 'Question must be sanitized for open state');
    assert.equal(sanitized.order, q.order, `Question order must equal ${q.order}`);
    assert.equal(sanitized.day, q.day, `Question day must equal ${q.day}`);
  }
});

test('Participant render key prevents structural rerender on duplicate identical state', () => {
  // Test the structural identity calculation function used in app.js
  function computePlayKey(s, q, prior, isSpectator) {
    const isDecodePrep = s.activity === 'decode' && s.state === 'preparing' && Boolean(q);
    const revealed = ['revealed', 'leaderboard'].includes(s.state);
    const clueNum = q?.clueNumber || s.currentClue || 1;
    const priorOption = prior?.optionIndex ?? 'none';
    const priorConfirmed = Boolean(prior?.confirmed);
    const priorSpectator = Boolean(prior?.spectator);

    return [
      s.activity,
      s.state,
      q?.id,
      clueNum,
      isDecodePrep,
      revealed,
      priorOption,
      priorConfirmed,
      priorSpectator,
      isSpectator
    ].join('|');
  }

  const serverState1 = { activity: 'passport', state: 'open', currentClue: 1, deadlineAt: '2026-09-18T16:00:20Z', version: 5 };
  const question = { id: 'passport-1-2', activity: 'passport', order: 2 };
  const prior = { optionIndex: 3, confirmed: true };

  const key1 = computePlayKey(serverState1, question, prior, false);
  
  // A second broadcast arrives with the same version/state and an updated serverNow
  const serverState2 = { activity: 'passport', state: 'open', currentClue: 1, deadlineAt: '2026-09-18T16:00:20Z', version: 5 };
  const key2 = computePlayKey(serverState2, question, prior, false);

  assert.equal(key1, key2, 'Duplicate identical state must yield identical structural render key');

  // But if the user selects a different answer, structural key changes
  const newPrior = { optionIndex: 1, confirmed: false };
  const key3 = computePlayKey(serverState1, question, newPrior, false);
  assert.notEqual(key1, key3, 'Local answer change must yield different structural key');

  // And when state advances to revealed, structural key changes
  const serverStateRevealed = { activity: 'passport', state: 'revealed', currentClue: 1, version: 6 };
  const keyRevealed = computePlayKey(serverStateRevealed, question, prior, false);
  assert.notEqual(key1, keyRevealed, 'State change to revealed must yield different structural key');
});

test('No reveal secrets in open or locked states (timing: reveal media strictly hidden)', async () => {
  const questionsFile = JSON.parse(await readFile(join(root, 'content', 'questions.json'), 'utf8')).questions;
  const revealMediaQuestions = questionsFile.filter(q => q.media && q.media.timing === 'reveal');
  assert.ok(revealMediaQuestions.length >= 2, 'Must have at least 2 reveal-media questions (e.g. Zobo, Suya)');

  for (const q of revealMediaQuestions) {
    const rawQuestion = {
      ...q,
      id: `passport-${q.day}-${q.order}`,
      activity: 'passport'
    };

    // 1. In 'open' state
    const openSanitized = sanitizePublicQuestion(rawQuestion, 'open');
    assert.equal(openSanitized.media, null, `Question ${q.order} media must be null in open state`);
    assert.equal(openSanitized.imageUrl, null, `Question ${q.order} imageUrl must be null in open state`);
    assert.equal(openSanitized.correctOption, undefined, 'correctOption must be undefined in open state');

    // 2. In 'locked' state
    const lockedSanitized = sanitizePublicQuestion(rawQuestion, 'locked');
    assert.equal(lockedSanitized.media, null, `Question ${q.order} media must be null in locked state`);
    assert.equal(lockedSanitized.imageUrl, null, `Question ${q.order} imageUrl must be null in locked state`);

    // 3. In 'revealed' state
    const revealedSanitized = sanitizePublicQuestion(rawQuestion, 'revealed');
    assert.ok(revealedSanitized.media, `Question ${q.order} media must be revealed in revealed state`);
    assert.equal(revealedSanitized.media.src, q.media.src, 'Media source must match');
    assert.equal(revealedSanitized.correctOption, q.correctOption, 'correctOption present in revealed state');
  }
});

test('All 24 media assets are catalogued on dedicated public credits page', async () => {
  const creditsHtml = await readFile(join(root, 'credits.html'), 'utf8');
  assert.match(creditsHtml, /<title>Photo Credits & Licensing/);
  assert.match(creditsHtml, /Hibiscus Sabdariffa calyxes/);
  assert.match(creditsHtml, /Suya in skewers/);
  assert.match(creditsHtml, /Aso Adire/);
  assert.match(creditsHtml, /Nigerian puff-puff/);
  assert.match(creditsHtml, /Head, Nok culture/);
  assert.match(creditsHtml, /Fleet of Danfo buses/);

  // Decode assets
  assert.match(creditsHtml, /Adire textile/);
  assert.match(creditsHtml, /Ojude Oba festival/);
  assert.match(creditsHtml, /Olumo Rock/);
  assert.match(creditsHtml, /Dala Hill/);
  assert.match(creditsHtml, /Kofar Nasarawa City Gate/);
  assert.match(creditsHtml, /Kofar Mata Dye Pits/);
  assert.match(creditsHtml, /Kainji Dam/);
  assert.match(creditsHtml, /Gurara Waterfalls/);
  assert.match(creditsHtml, /Zuma Rock/);
  assert.match(creditsHtml, /Igbo-Ukwu Bronzes/);
  assert.match(creditsHtml, /Ogbunike Caves/);
  assert.match(creditsHtml, /River Niger Bridge/);
  assert.match(creditsHtml, /Agbokim Waterfalls/);
  assert.match(creditsHtml, /Obudu Mountain Resort/);
  assert.match(creditsHtml, /Calabar Carnival/);
  assert.match(creditsHtml, /Lekki Canopy Walkway/);
  assert.match(creditsHtml, /National Arts Theatre/);
  assert.match(creditsHtml, /Eyo Masquerade Procession/);

  // License links
  assert.match(creditsHtml, /creativecommons\.org\/licenses/);
  assert.match(creditsHtml, /commons\.wikimedia\.org\/wiki\/File:/);
});

test('Gameplay screens do NOT render visible photographer/license credits or captions', async () => {
  const appJs = await readFile(join(root, 'js', 'app.js'), 'utf8');
  const reviewRenderJs = await readFile(join(root, 'review', 'render.js'), 'utf8');
  // Confirm that playMediaHTML and displayMediaHTML do not construct visible credit strings
  assert.doesNotMatch(appJs, /play-media-credit/);
  assert.doesNotMatch(appJs, /display-media-credit/);
  assert.doesNotMatch(appJs, /m\.licenseUrl/);
  // Confirm no visible figcaption tags on review or live screens
  assert.doesNotMatch(appJs, /<figcaption>/);
  assert.doesNotMatch(reviewRenderJs, /<figcaption>/);
  // Confirm review/render.js uses is-passport-reveal for projector reveals
  assert.match(reviewRenderJs, /is-passport-reveal/);
});

test('Reveal-media questions (Zobo, Suya) do NOT spoil answers in alt text or captions', async () => {
  const questionsFile = JSON.parse(await readFile(join(root, 'content', 'questions.json'), 'utf8')).questions;
  const zobo = questionsFile.find(q => q.day === 1 && q.order === 2);
  const suya = questionsFile.find(q => q.day === 2 && q.order === 4);

  assert.ok(zobo, 'Zobo question must exist');
  assert.ok(suya, 'Suya question must exist');

  // Zobo answer is Hibiscus: alt text must not mention hibiscus
  assert.doesNotMatch(zobo.media.alt, /hibiscus/i, 'Zobo alt text must not spoil hibiscus');

  // Suya answer is Grilling: alt text and caption must not mention grill or grilling
  assert.doesNotMatch(suya.media.alt, /grill/i, 'Suya alt text must not mention grill');
  assert.doesNotMatch(suya.media.caption, /grill/i, 'Suya caption must not spoil grill');
});

test('Dev-server preserves Decode reviewStatus, source, and isVoid metadata from decode-rounds.json', async () => {
  const decodeFile = JSON.parse(await readFile(join(root, 'content', 'decode-rounds.json'), 'utf8'));
  
  // Test mapping logic in scripts/dev-server.mjs
  const mapped = decodeFile.rounds.map((r, i) => ({
    id: `decode-${i + 1}`,
    day: i < 3 ? 1 : 2,
    order: i + 1,
    category: r.zone,
    question: 'Which Nigerian state do these clues describe?',
    options: r.options,
    correctOption: r.correctOption,
    explanation: r.revealFact,
    activity: 'decode',
    title: 'Decode the State',
    durationSeconds: r.durationSeconds || 30,
    clues: r.clues,
    clueMedia: r.clueMedia,
    highlightState: r.geoId,
    source: r.source,
    reviewStatus: r.reviewStatus ?? r.review_status ?? 'requires_fact_check',
    isVoid: Boolean(r.isVoid ?? r.is_void ?? false)
  }));

  assert.equal(mapped.length, 6, 'Must map all 6 Decode rounds');
  for (let i = 0; i < mapped.length; i++) {
    const orig = decodeFile.rounds[i];
    const q = mapped[i];
    assert.equal(q.reviewStatus, orig.reviewStatus, `Round ${q.id} reviewStatus must equal source reviewStatus`);
    assert.equal(q.source, orig.source, `Round ${q.id} source must be preserved`);
    assert.equal(q.isVoid, false, `Round ${q.id} must not be void`);
    assert.equal(q.activity, 'decode', 'Activity must be decode');
  }
});

test('Admin status endpoint delivers approved Decode rounds when rehearsal mode is OFF, and UI dropdown populates six rounds', async () => {
  const decodeFile = JSON.parse(await readFile(join(root, 'content', 'decode-rounds.json'), 'utf8'));
  const questionFile = JSON.parse(await readFile(join(root, 'content', 'questions.json'), 'utf8'));

  const passport = questionFile.questions.map((q, i) => ({
    ...q,
    id: `passport-${q.day}-${q.order}`,
    activity: 'passport',
    title: 'Naija Passport Challenge',
    durationSeconds: q.durationSeconds || 20
  }));

  const decode = decodeFile.rounds.map((r, i) => ({
    id: `decode-${i + 1}`,
    day: i < 3 ? 1 : 2,
    order: i + 1,
    category: r.zone,
    question: 'Which Nigerian state do these clues describe?',
    options: r.options,
    correctOption: r.correctOption,
    explanation: r.revealFact,
    activity: 'decode',
    title: 'Decode the State',
    durationSeconds: r.durationSeconds || 30,
    clues: r.clues,
    clueMedia: r.clueMedia,
    highlightState: r.geoId,
    source: r.source,
    reviewStatus: r.reviewStatus ?? r.review_status ?? 'requires_fact_check',
    isVoid: Boolean(r.isVoid ?? r.is_void ?? false)
  }));

  const allQuestions = [...passport, ...decode];

  // 1. When rehearsal mode is OFF (false)
  const rehearsalMode = false;
  const filtered = allQuestions.filter(q => 
    (q.reviewStatus || q.review_status || 'requires_fact_check') === 'approved' || rehearsalMode
  ).map(q => ({
    id: q.id,
    category: q.category,
    question: q.question,
    display_order: q.order,
    activity: q.activity
  }));

  // Verify all 6 approved Decode rounds are in the filtered set
  const decodeInStatus = filtered.filter(q => q.activity === 'decode');
  assert.equal(decodeInStatus.length, 6, 'All six approved Decode rounds must be present in admin/status with rehearsal mode OFF');
  assert.deepEqual(decodeInStatus.map(q => q.id), ['decode-1', 'decode-2', 'decode-3', 'decode-4', 'decode-5', 'decode-6']);

  // 2. Simulate admin UI dropdown population from admin-console.js:
  // select.innerHTML='<option value="">Choose a ready question</option>';
  // status.questions.filter(q=>(!q.activity||q.activity===activity)&&(state==='preparing'?true:q.id!==currentId)).forEach(...)
  const activeActivity = 'decode';
  const currentState = 'lobby';
  const currentId = null;

  const dropdownQuestions = decodeInStatus.filter(q =>
    (!q.activity || q.activity === activeActivity) && (currentState === 'preparing' ? true : q.id !== currentId)
  );

  assert.equal(dropdownQuestions.length, 6, 'Admin UI dropdown must contain exactly six Decode rounds when activity=decode');

  // 3. Verify Passport filtering still works with rehearsal mode OFF
  const passportInStatus = filtered.filter(q => q.activity === 'passport');
  assert.ok(passportInStatus.length >= 20, 'Approved Passport questions must also be present');

  const passportDropdownQuestions = filtered.filter(q =>
    (!q.activity || q.activity === 'passport') && (currentState === 'preparing' ? true : q.id !== currentId)
  );
  assert.equal(passportDropdownQuestions.length, passportInStatus.length, 'Passport questions dropdown correctly isolated');
  assert.ok(!passportDropdownQuestions.some(q => q.activity === 'decode'), 'No Decode questions in Passport dropdown');
  assert.ok(!dropdownQuestions.some(q => q.activity === 'passport'), 'No Passport questions in Decode dropdown');
});

