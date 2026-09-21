import crypto from 'node:crypto';

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const PIN_PATTERN = /^\d{8}$/;
const HASH_PATTERN = /^scrypt\$([0-9a-f]{32})\$([0-9a-f]{64})$/i;

function configuredSecret() {
  const secret = String(process.env.ADMIN_SESSION_SECRET || '');
  if (secret.length < 32) {
    throw Object.assign(new Error('Admin access is not configured'), { status: 503 });
  }
  return secret;
}

function configuredPinHash() {
  const value = String(process.env.ADMIN_PIN_HASH || '');
  const match = value.match(HASH_PATTERN);
  if (!match) {
    throw Object.assign(new Error('Admin access is not configured'), { status: 503 });
  }
  return { salt: Buffer.from(match[1], 'hex'), digest: Buffer.from(match[2], 'hex') };
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function safeEqualText(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function verifyAdminPin(pin) {
  const normalized = String(pin || '').trim();
  if (!PIN_PATTERN.test(normalized)) return false;

  const { salt, digest } = configuredPinHash();
  const candidate = crypto.scryptSync(normalized, salt, digest.length);
  return candidate.length === digest.length && crypto.timingSafeEqual(candidate, digest);
}

export function createAdminSession(now = Date.now()) {
  const secret = configuredSecret();
  const issuedAt = Math.floor(now / 1000);
  const payload = {
    v: 1,
    role: 'event_operator',
    iat: issuedAt,
    exp: issuedAt + Math.floor(SESSION_TTL_MS / 1000),
    nonce: crypto.randomBytes(12).toString('base64url')
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${sign(encoded, secret)}`;
}

export function verifyAdminSession(authHeader, now = Date.now()) {
  const token = String(authHeader || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) throw Object.assign(new Error('Admin sign-in required'), { status: 401 });

  const [encoded, signature, extra] = token.split('.');
  if (!encoded || !signature || extra) {
    throw Object.assign(new Error('Admin session expired'), { status: 401 });
  }

  const secret = configuredSecret();
  if (!safeEqualText(signature, sign(encoded, secret))) {
    throw Object.assign(new Error('Admin session expired'), { status: 401 });
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw Object.assign(new Error('Admin session expired'), { status: 401 });
  }

  const nowSeconds = Math.floor(now / 1000);
  if (payload?.v !== 1 || payload?.role !== 'event_operator' || !Number.isInteger(payload.exp) || payload.exp <= nowSeconds) {
    throw Object.assign(new Error('Admin session expired'), { status: 401 });
  }

  return {
    id: null,
    role: 'operator',
    admin: {
      display_name: 'Event Team',
      role: 'operator'
    },
    session: payload
  };
}

export function hashAdminPin(pin, salt = crypto.randomBytes(16)) {
  const normalized = String(pin || '').trim();
  if (!PIN_PATTERN.test(normalized)) {
    throw new Error('Admin PIN must be exactly 8 digits.');
  }
  const digest = crypto.scryptSync(normalized, salt, 32);
  return `scrypt$${salt.toString('hex')}$${digest.toString('hex')}`;
}
