// NIAC Live State Envelope Module (Phase 2)
// Generates versioned public state envelopes with SHA-256 checksums and secret suppression.

import crypto from 'node:crypto';

export function sanitizePublicQuestion(question, state) {
  if (!question) return null;
  // In lobby or preparing states, completely suppress question content from public clients
  if (['lobby', 'preparing', 'ended'].includes(state)) {
    return null;
  }

  const safe = {
    id: question.id,
    activity: question.activity || 'passport',
    day: question.day,
    category: question.category,
    question: question.question,
    options: question.options,
    durationSeconds: question.durationSeconds,
    imageUrl: question.imageUrl || null,
    altText: question.altText || null
  };

  if (question.clue) safe.clue = question.clue;
  if (question.clueNumber) safe.clueNumber = question.clueNumber;

  // Only expose correctOption, explanation and highlightState in reveal states
  if (['revealed', 'leaderboard', 'round_complete'].includes(state)) {
    safe.correctOption = question.correctOption;
    safe.explanation = question.explanation;
    if (question.highlightState) safe.highlightState = question.highlightState;
  }

  return safe;
}

export function computeStateChecksum(payload) {
  const canonicalize=value=>{
    if(Array.isArray(value))return value.map(canonicalize);
    if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonicalize(value[key])]));
    return value;
  };
  const canonical = JSON.stringify(canonicalize(payload));
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export function createStateEnvelope(sessionData, questionData = null) {
  const state = sessionData.state || 'lobby';
  const rawQuestion = questionData || sessionData.question || null;
  const safeQuestion = sanitizePublicQuestion(rawQuestion, state);

  const payload = {
    event: sessionData.event || null,
    eventId: sessionData.eventId || 'niac-2026',
    sessionId: sessionData.sessionId || sessionData.id || 'default-session',
    version: Number(sessionData.version || 1),
    state,
    activity: sessionData.activity || safeQuestion?.activity || 'lens',
    currentClue: sessionData.currentClue || 1,
    openedAt: sessionData.openedAt || sessionData.opened_at || null,
    deadlineAt: sessionData.deadlineAt || sessionData.deadline_at || null,
    responseCount: Number(sessionData.responseCount || sessionData.response_count || 0),
    question: safeQuestion,
    serverNow: sessionData.serverNow || new Date().toISOString()
  };

  const checksum = computeStateChecksum(payload);
  return {
    ...payload,
    checksum
  };
}

export function verifyStateEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || !envelope.checksum) return false;
  const { checksum, ...payload } = envelope;
  return checksum === computeStateChecksum(payload);
}
