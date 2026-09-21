import { hashAdminPin } from '../server/admin-auth.mjs';

const pin = String(process.argv[2] || '').trim();
if (!/^\d{8}$/.test(pin)) {
  console.error('Usage: npm run admin:hash-pin -- 12345678');
  process.exit(1);
}

console.log(hashAdminPin(pin));
