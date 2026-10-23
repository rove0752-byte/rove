// Anonymous free trial for website visitors (no API key).
// Identity: a signed, httpOnly visitor cookie plus a per-IP backstop (IP is HMAC-hashed, never stored or logged in plain text).
// Signing secret: no dedicated env var exists, so it is derived from ROVE_API_KEY via HMAC-SHA256 with a fixed label.
// Rotating ROVE_API_KEY therefore invalidates all trial cookies (visitors simply get a new one).
// TODO(accounts): signup/pay should provision a per-account API key + quota (ties to PR #1 Stripe Checkout/webhooks).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const VISITOR_DAILY_LIMIT = 5;
export const IP_DAILY_LIMIT = 20;
/** Used when Redis is not configured: fail closed to a small per-instance limit. */
export const MEMORY_FALLBACK_LIMIT = 2;
export const COOKIE_NAME = 'rove_trial';

export interface TrialStore {
  kind: 'redis' | 'memory';
  /** Increment each key, set TTL if new, return new values. */
  incr(keys: string[], ttlSeconds: number): Promise<number[]>;
  decr(keys: string[]): Promise<void>;
  get(keys: string[]): Promise<number[]>;
}

export function deriveSecret(rootKey: string | undefined): Buffer | null {
  if (!rootKey) return null;
  return createHmac('sha256', rootKey).update('rove-trial-cookie-v1').digest();
}

const b64 = (b: Buffer) => b.toString('base64url');
const mac = (secret: Buffer, v: string) => b64(createHmac('sha256', secret).update(v).digest());

export function signVisitor(secret: Buffer, id: string): string { return `${id}.${mac(secret, 'v:' + id)}`; }

export function verifyVisitor(secret: Buffer, cookie: string | undefined | null): string | null {
  if (!cookie) return null;
  const [id, sig, extra] = cookie.split('.');
  if (!id || !sig || extra !== undefined || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) return null;
  const a = Buffer.from(sig), b = Buffer.from(mac(secret, 'v:' + id));
  return a.length === b.length && timingSafeEqual(a, b) ? id : null;
}

export function newVisitorId(): string { return b64(randomBytes(16)); }

export function readCookie(req: Request, name = COOKIE_NAME): string | null {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

export function cookieHeader(value: string): string {
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}`;
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  return (fwd?.split(',')[0] || req.headers.get('x-real-ip') || 'unknown').trim();
}

export function hashId(secret: Buffer, kind: string, v: string): string {
  return createHmac('sha256', secret).update(kind + ':' + v).digest('hex').slice(0, 32);
}

export function utcDay(now: Date): string { return now.toISOString().slice(0, 10); }
export function nextResetUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

export function keyPrefix(env = process.env): string {
  const scope = env.VERCEL_ENV === 'production' ? 'production' : 'nonproduction';
  return `rove:v1:${scope}:trial`;
}

export function trialKeys(secret: Buffer, visitorId: string, ip: string, now: Date, prefix = keyPrefix()) {
  const day = utcDay(now);
  return { visitor: `${prefix}:visitor:${day}:${hashId(secret, 'v', visitorId)}`, ip: `${prefix}:ip:${day}:${hashId(secret, 'ip', ip)}` };
}

export function limitsFor(store: TrialStore) {
  return store.kind === 'redis'
    ? { visitor: VISITOR_DAILY_LIMIT, ip: IP_DAILY_LIMIT }
    : { visitor: Math.min(MEMORY_FALLBACK_LIMIT, VISITOR_DAILY_LIMIT), ip: Math.min(MEMORY_FALLBACK_LIMIT, IP_DAILY_LIMIT) };
}

export type TrialResult = { ok: boolean; remaining: number; limit: number; resetsAt: string; setCookie?: string };

/** Resolve (or mint) the visitor identity. */
export function identify(secret: Buffer, req: Request): { id: string; setCookie?: string } {
  const id = verifyVisitor(secret, readCookie(req));
  if (id) return { id };
  const fresh = newVisitorId();
  return { id: fresh, setCookie: cookieHeader(signVisitor(secret, fresh)) };
}

function result(ok: boolean, used: number[], lim: { visitor: number; ip: number }, now: Date, setCookie?: string): TrialResult {
  const remaining = Math.max(0, Math.min(lim.visitor - used[0], lim.ip - used[1]));
  return { ok, remaining, limit: lim.visitor, resetsAt: nextResetUtc(now).toISOString(), setCookie };
}

export async function peekTrial(store: TrialStore, secret: Buffer, req: Request, now = new Date()): Promise<TrialResult> {
  const who = identify(secret, req);
  const k = trialKeys(secret, who.id, clientIp(req), now);
  const used = await store.get([k.visitor, k.ip]);
  return result(true, used, limitsFor(store), now, who.setCookie);
}

/** Atomically-ish consume one trial run; refunds if over either limit. */
export async function consumeTrial(store: TrialStore, secret: Buffer, req: Request, now = new Date()): Promise<TrialResult & { refund: () => Promise<void> }> {
  const who = identify(secret, req);
  const k = trialKeys(secret, who.id, clientIp(req), now);
  const lim = limitsFor(store);
  const ttl = Math.ceil((nextResetUtc(now).getTime() - now.getTime()) / 1000) + 3600;
  const used = await store.incr([k.visitor, k.ip], ttl);
  const refund = () => store.decr([k.visitor, k.ip]);
  if (used[0] > lim.visitor || used[1] > lim.ip) {
    await refund();
    return { ...result(false, [lim.visitor, lim.ip], lim, now, who.setCookie), refund: async () => {} };
  }
  return { ...result(true, used, lim, now, who.setCookie), refund };
}

export function memoryStore(): TrialStore {
  const m = new Map<string, { n: number; exp: number }>();
  const val = (k: string) => { const e = m.get(k); return e && e.exp > Date.now() ? e.n : 0; };
  return {
    kind: 'memory',
    async incr(keys, ttl) { return keys.map(k => { const e = m.get(k); const live = e && e.exp > Date.now(); const n = (live ? e!.n : 0) + 1; m.set(k, { n, exp: live ? e!.exp : Date.now() + ttl * 1000 }); return n; }); },
    async decr(keys) { for (const k of keys) { const e = m.get(k); if (e) e.n = Math.max(0, e.n - 1); } },
    async get(keys) { return keys.map(val); },
  };
}

export function redisStore(url: string, token: string, fetchImpl: typeof fetch = fetch): TrialStore {
  const pipe = async (cmds: (string | number)[][]) => {
    const r = await fetchImpl(url.replace(/\/$/, '') + '/pipeline', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds) });
    if (!r.ok) throw new Error('Trial store unavailable');
    return (await r.json() as { result: unknown }[]).map(x => Number(x.result ?? 0));
  };
  return {
    kind: 'redis',
    async incr(keys, ttl) { const out = await pipe(keys.flatMap(k => [['INCR', k], ['EXPIRE', k, ttl, 'NX']])); return keys.map((_, i) => out[i * 2]); },
    async decr(keys) { await pipe(keys.map(k => ['DECR', k])); },
    async get(keys) { return pipe(keys.map(k => ['GET', k])); },
  };
}

let shared: TrialStore | null = null;
export function defaultStore(env = process.env): TrialStore {
  if (!shared) shared = env.KV_REST_API_URL && env.KV_REST_API_TOKEN ? redisStore(env.KV_REST_API_URL, env.KV_REST_API_TOKEN) : memoryStore();
  return shared;
}

/** Return URL for visitor checkout: the requesting deployment if it is ours, else the canonical site. */
export function returnOrigin(req: Request): string {
  const host = (req.headers.get('x-forwarded-host') || new URL(req.url).host).toLowerCase();
  const ok = /^(www\.)?rovezi\.com$/.test(host) || /^rove-[a-z0-9-]+-budsatwork0-ais-projects\.vercel\.app$/.test(host);
  return ok ? `https://${host}` : 'https://rovezi.com';
}
