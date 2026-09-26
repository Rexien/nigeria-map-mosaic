// NIAC Live State Envelope Module (Phase 2)
// Generates versioned public state envelopes with SHA-256 checksums and secret suppression.

import crypto from 'node:crypto';
import { optimizedDecodeAsset, publicQuestionMedia } from './question-media.mjs';

export function sanitizePublicQuestion(question, state) {
  if (!question) return null;
  const isDecodePreparing = question.activity === 'decode' && state === 'preparing';
  // In lobby or preparing states, completely suppress question content from public clients
  // except for Decode the State clues showing during preparation before voting opens
  if (!isDecodePreparing && !['open', 'locked', 'revealed', 'leaderboard', 'round_complete'].includes(state)) {
    return null;
  }

  const media = publicQuestionMedia(question, state);
  const isRevealed = ['revealed', 'leaderboard', 'round_complete'].includes(state);

  const safe = {
    id: question.id,
    activity: question.activity || 'passport',
    title: question.title,
    day: question.day,
    order: question.order || question.display_order || null,
    category: question.category,
    question: question.question,
    options: isDecodePreparing ? [] : question.options,
    durationSeconds: question.durationSeconds,
    imageUrl: media?.src || null,
    altText: media?.alt || null,
    media,
    fallback: question.fallback || null
  };

  if (question.clue) safe.clue = question.clue;
  if (question.clueNumber) safe.clueNumber = question.clueNumber;
  if (question.activity === 'decode' && (question.clues || question.cluesSoFar)) {
    safe.cluesSoFar = Array.isArray(question.clues) && question.clues.length ? question.clues : question.cluesSoFar;
  } else if (question.cluesSoFar) safe.cluesSoFar = question.cluesSoFar;
  const clueMediaSoFar = question.activity === 'decode' && Array.isArray(question.clueMedia) && question.clueMedia.length
    ? question.clueMedia : question.clueMediaSoFar;
  if (clueMediaSoFar) {
    safe.clueMediaSoFar = clueMediaSoFar.map(m => {
      if (!m) return null;
      return {
        src: optimizedDecodeAsset(m.src, question.activity),
        alt: m.alt || '',
        timing: m.timing || 'question',
        fallback: m.fallback || null,
        caption: isRevealed ? (m.caption || '') : '',
        author: isRevealed ? (m.author || '') : '',
        license: isRevealed ? (m.license || '') : '',
        licenseUrl: isRevealed ? (m.licenseUrl || '') : ''
      };
    }).filter(Boolean);
  }
  if (question.activity === 'decode' && Array.isArray(question.clueMedia)) {
    safe.clueMedia = question.clueMedia.map(m => m && ({
      src: optimizedDecodeAsset(m.src, question.activity),
      alt: m.alt || '',
      timing: m.timing || 'question',
      fallback: m.fallback || null
    })).filter(m => m?.src);
  }

  // Only expose correctOption, explanation and highlightState in reveal states
  if (isRevealed) {
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
    screenMode: sessionData.screenMode || 'welcome',
    currentClue: sessionData.currentClue || 1,
    openedAt: sessionData.openedAt || sessionData.opened_at || null,
    deadlineAt: sessionData.deadlineAt || sessionData.deadline_at || null,
    scoreReady: Boolean(sessionData.scoreReady),
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
