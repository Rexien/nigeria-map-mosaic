// Provider-neutral Supabase database connection and admin verification
import { createReadCache } from './traffic.mjs';

const eventReads = createReadCache();
const base = () => process.env.SUPABASE_URL;
const key = () => process.env.SUPABASE_SERVICE_ROLE_KEY;

export function configured() { return Boolean(base() && key()); }

export async function db(path, options = {}) {
  if (!configured()) throw Object.assign(new Error('Server database is not configured'), { status: 503 });
  const response = await fetch(`${base()}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: key(),
      Authorization: `Bearer ${key()}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=representation',
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw Object.assign(new Error(body?.message || body?.hint || 'Database request failed'), { status: response.status, detail: body });
  return body;
}

async function loadEvent() {
  const rows = await db('events?slug=eq.niac-2026&select=*');
  if (!rows[0]) throw Object.assign(new Error('Event is not configured'), { status: 503 });
  return rows[0];
}

export function event() { return eventReads.get('event', 30000, loadEvent); }

export async function verifyAdmin(authHeader) {
  const token = String(authHeader || '').replace(/^Bearer\s+/i, '');
  if (!token) throw Object.assign(new Error('Admin sign-in required'), { status: 401 });
  const response = await fetch(`${base()}/auth/v1/user`, {
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY || key(),
      Authorization: `Bearer ${token}`
    }
  });
  if (!response.ok) throw Object.assign(new Error('Admin session expired'), { status: 401 });
  const user = await response.json();
  const allowed = await db(`admin_users?user_id=eq.${encodeURIComponent(user.id)}&select=*`);
  if (!allowed[0]) throw Object.assign(new Error('This account is not an event administrator'), { status: 403 });
  return { ...user, admin: allowed[0] };
}
