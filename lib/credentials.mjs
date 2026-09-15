// NIAC Live Server-Side Participant Credentials (Phase 3)
// Generates and verifies short-lived HMAC-SHA256 signed participant tokens.
// Keys and verification exist exclusively in server environments (Gateway & Netlify Functions).

import crypto from 'node:crypto';

const DEFAULT_SECRET = process.env.CREDENTIAL_SECRET_ACTIVE || (process.env.NODE_ENV==='production' ? null : 'dev-credential-secret-2026');
const PREVIOUS_SECRET = process.env.CREDENTIAL_SECRET_PREVIOUS || null;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const ISSUER='niac-live';
const AUDIENCE='niac-participant';

function toBase64Url(str) {
  return Buffer.from(str)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromBase64Url(str) {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  return Buffer.from(base64, 'base64').toString('utf8');
}

function computeHmac(payloadB64, secret) {
  if(!secret)throw new Error('CREDENTIAL_SECRET_ACTIVE is required');
  return crypto
    .createHmac('sha256', secret)
    .update(payloadB64)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function signParticipantCredential(data, secret = DEFAULT_SECRET, ttlMs = DEFAULT_TTL_MS) {
  if (!data.participantId) {
    throw new Error('participantId is required to sign credential');
  }

  const now = Date.now();
  const payload = {
    version: 1,
    issuer: ISSUER,
    audience: AUDIENCE,
    keyId: data.keyId || 'active',
    participantId: data.participantId,
    eventId: data.eventId || 'niac-2026',
    isRehearsal: Boolean(data.isRehearsal),
    isSpectator: Boolean(data.isSpectator),
    issuedAt: now,
    expiresAt: now + ttlMs
  };

  const payloadB64 = toBase64Url(JSON.stringify(payload));
  const sigB64 = computeHmac(payloadB64, secret);
  return `${payloadB64}.${sigB64}`;
}

export function verifyParticipantCredential(token, secret = DEFAULT_SECRET, previousSecret = PREVIOUS_SECRET) {
  if (!token || typeof token !== 'string') {
    return { valid: false, error: 'MISSING_TOKEN' };
  }

  const parts = token.split('.');
  if (parts.length !== 2) {
    return { valid: false, error: 'MALFORMED_TOKEN' };
  }

  const [payloadB64, sigB64] = parts;

  if(!secret)return {valid:false,error:'CREDENTIAL_SECRET_NOT_CONFIGURED'};

  // Try verifying with active secret key
  const expectedSig = computeHmac(payloadB64, secret);
  const sigBuf = Buffer.from(sigB64);
  const expectedBuf = Buffer.from(expectedSig);

  let verified = sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);

  // Key rotation support: try previous secret key if active key fails
  if (!verified && previousSecret) {
    const prevExpectedSig = computeHmac(payloadB64, previousSecret);
    const prevExpectedBuf = Buffer.from(prevExpectedSig);
    verified = sigBuf.length === prevExpectedBuf.length && crypto.timingSafeEqual(sigBuf, prevExpectedBuf);
  }

  if (!verified) {
    return { valid: false, error: 'INVALID_SIGNATURE' };
  }

  let payload;
  try {
    payload = JSON.parse(fromBase64Url(payloadB64));
  } catch {
    return { valid: false, error: 'INVALID_PAYLOAD_JSON' };
  }

  if (Date.now() > payload.expiresAt) {
    return { valid: false, error: 'EXPIRED', payload };
  }

  if(payload.version!==1||payload.issuer!==ISSUER||payload.audience!==AUDIENCE){
    return {valid:false,error:'INVALID_CLAIMS'};
  }

  return { valid: true, payload };
}
