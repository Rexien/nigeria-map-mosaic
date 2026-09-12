(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof root !== 'undefined') root.NIACCore = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const GAME_STATES = Object.freeze([
    'lobby', 'preparing', 'open', 'submitted', 'locked', 'revealed',
    'leaderboard', 'round_complete', 'paused', 'ended'
  ]);
  const TRANSITIONS = Object.freeze({
    lobby: ['preparing', 'paused', 'ended'],
    preparing: ['open', 'paused', 'ended'],
    open: ['locked', 'paused'],
    submitted: ['locked', 'paused'],
    locked: ['revealed', 'paused'],
    revealed: ['leaderboard', 'preparing', 'round_complete', 'paused'],
    leaderboard: ['preparing', 'round_complete', 'paused'],
    round_complete: ['lobby', 'ended'],
    paused: ['lobby', 'preparing', 'open', 'locked', 'revealed', 'leaderboard', 'ended'],
    ended: ['lobby']
  });

  function normalizeSpaces(value) {
    return String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
  }

  function sanitizeText(value) {
    return normalizeSpaces(value)
      .replace(/[<>]/g, '')
      .replace(/[\u0000-\u001F\u007F]/g, '');
  }

  function validateAlias(value) {
    const alias = sanitizeText(value);
    if (alias.length < 2) return { valid: false, error: 'Use at least 2 characters.' };
    if (alias.length > 30) return { valid: false, error: 'Use 30 characters or fewer.' };
    if (!/[\p{L}\p{N}]/u.test(alias)) return { valid: false, error: 'Include a letter or number.' };
    return { valid: true, value: alias };
  }

  function normalizeRecoveryCode(value) {
    const code = String(value ?? '').trim().toUpperCase();
    return /^[A-Z0-9_-]{3,6}-[A-Z0-9_-]{3,6}$/.test(code) ? code : null;
  }

  function validateLensPhrase(value, maxLength = 72) {
    const phrase = sanitizeText(value);
    if (!phrase) return { valid: false, error: 'Enter one word or a short phrase.' };
    if (phrase.length > maxLength) return { valid: false, error: `Use ${maxLength} characters or fewer.` };
    if (!/[\p{L}\p{N}]/u.test(phrase)) return { valid: false, error: 'Include a letter or number.' };
    return { valid: true, value: phrase };
  }

  function quizPoints({ activity, correct, clueNumber = 1, voided = false }) {
    if (voided || !correct) return 0;
    return activity === 'decode' ? Math.max(0, 4 - Number(clueNumber || 1)) : 1000;
  }

  function compareRank(a, b) {
    return (b.totalScore - a.totalScore) ||
      (b.correctAnswers - a.correctAnswers) ||
      (a.correctResponseMs - b.correctResponseMs) ||
      (new Date(a.registeredAt) - new Date(b.registeredAt));
  }

  function accumulateDays(answers) {
    return answers.reduce((totals, answer) => {
      if (answer.voided || answer.activity === 'decode') return totals;
      const key = Number(answer.day) === 2 ? 'day2' : 'day1';
      totals[key] += Number(answer.points || 0);
      totals.combined += Number(answer.points || 0);
      return totals;
    }, { day1: 0, day2: 0, combined: 0 });
  }

  function stampProgress(answers, thresholds = { food: 1, language: 1, entertainment: 1, geography: 1, everyday: 1 }) {
    const correct = new Map();
    answers.filter(a => a.correct && !a.voided && a.activity === 'passport')
      .forEach(a => correct.set(a.category, (correct.get(a.category) || 0) + 1));
    return Object.entries(thresholds).map(([category, required]) => ({
      category, earned: (correct.get(category) || 0) >= required,
      correct: correct.get(category) || 0, required
    }));
  }

  function canTransition(from, to) {
    return GAME_STATES.includes(to) && Boolean(TRANSITIONS[from]?.includes(to));
  }

  function isLate(deadline, receivedAt) {
    return new Date(receivedAt).getTime() > new Date(deadline).getTime();
  }

  function evaluateAttempt({ existingAnswer, state, deadline, receivedAt, activity, correct, clueNumber, voided }) {
    if (existingAnswer) return { accepted: true, duplicate: true, points: existingAnswer.points };
    if (state !== 'open') return { accepted: false, reason: 'QUESTION_NOT_OPEN', points: 0 };
    if (isLate(deadline, receivedAt)) return { accepted: false, reason: 'ANSWER_LATE', points: 0 };
    return { accepted: true, duplicate: false, points: quizPoints({ activity, correct, clueNumber, voided }) };
  }

  function reconcileSubmission(local, server) {
    if (server?.confirmed) return { ...local, confirmed: true, optionIndex: server.optionIndex };
    if (local?.confirmed) return local;
    return local ? { ...local, confirmed: false } : null;
  }

  function publicQuestion(question, state) {
    if (!question) return null;
    const safe = {
      id: question.id, activity: question.activity, day: question.day,
      category: question.category, question: question.question,
      options: question.options, durationSeconds: question.durationSeconds,
      imageUrl: question.imageUrl || null, altText: question.altText || null
    };
    if (state === 'revealed' || state === 'leaderboard' || state === 'round_complete') {
      safe.correctOption = question.correctOption;
      safe.explanation = question.explanation;
    }
    return safe;
  }

  return { GAME_STATES, TRANSITIONS, normalizeSpaces, sanitizeText, validateAlias, normalizeRecoveryCode,
    validateLensPhrase, quizPoints, compareRank, accumulateDays, stampProgress,
    canTransition, isLate, evaluateAttempt, reconcileSubmission, publicQuestion };
});
