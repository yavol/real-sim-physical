import { createHash, createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

const COOKIE = 'real_sim_demo';
const hash = value => createHash('sha256').update(String(value)).digest();
const signature = (value, secret) => createHmac('sha256', secret).update(value).digest('hex');

export function accessMatches(code, expected) {
  return Boolean(expected) && timingSafeEqual(hash(code), hash(expected));
}

export function authenticated(req, env, now = Date.now()) {
  if (!env.DEMO_SESSION_SECRET || !env.DEMO_ACCESS_CODE) return false;
  const value = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
  if (!value) return false;
  const [expiry, nonce, digest, extra] = value.split('.');
  if (extra || !/^\d+$/.test(expiry || '') || !/^[a-f0-9]{24}$/.test(nonce || '') || !/^[a-f0-9]{64}$/.test(digest || '')) return false;
  if (Number(expiry) <= now || Number(expiry) > now + 86_400_000) return false;
  return timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(signature(expiry + '.' + nonce, env.DEMO_SESSION_SECRET), 'hex'));
}

export function sessionCookie(env, { secure = true, now = Date.now() } = {}) {
  const payload = `${now + 43_200_000}.${randomBytes(12).toString('hex')}`;
  return `${COOKIE}=${payload}.${signature(payload, env.DEMO_SESSION_SECRET)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secure ? '; Secure' : ''}`;
}
