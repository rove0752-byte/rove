// Dynamic allowlist: effective hosts = configured (ROVE_ALLOWED_HOSTS) ∪ Redis set, exact host match only.
// Additive only: every fetch still goes through policy.validateUrl's DNS resolution + private-address check.
// Fail closed: any Redis error => configured hosts only. Approving hosts requires Jacko's explicit per-host
// approval while public-site testing is paused (see docs/allowlist-runbook.md).
import { isIP } from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';

export const PENDING_CAP = 500;
export const PENDING_TTL_MS = 30 * 24 * 3600 * 1000;
export const REQUEST_LIMIT_VISITOR = 5;
export const REQUEST_LIMIT_IP = 20;
export const ADMIN_LIMIT_PER_MIN = 30;
export const CACHE_MS = 60_000;

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home', '.corp', '.intranet', '.arpa'];
const BLOCKED_NAMES = new Set(['localhost', 'metadata', 'metadata.google.internal', 'instance-data', 'instance-data.ec2.internal']);

/** Normalise untrusted input to a bare hostname, or null if it can never be allowlisted. No network/DNS. */
export function normalizeHost(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let v = raw.trim();
  if (!v || v.length > 2048 || /[\s<>"'`\\]/.test(v)) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = 'http://' + v;
  let host: string;
  try {
    const u = new URL(v); // WHATWG URL: lowercases, IDNA→punycode, drops port/path
    if (u.username || u.password) return null;
    host = u.hostname;
  } catch { return null; }
  host = host.replace(/\.$/, '');
  if (host.startsWith('[') || isIP(host)) return null;           // IP literals (v4/v6)
  if (/^[0-9.]+$/.test(host) || /^0x/i.test(host)) return null;   // numeric/hex forms
  if (host.startsWith('www.')) host = host.slice(4);
  if (host.length > 253 || !host.includes('.')) return null;      // single-label names
  if (!/^[a-z0-9.-]+$/.test(host) || host.split('.').some(l => !l || l.length > 63 || l.startsWith('-') || l.endsWith('-'))) return null;
  if (BLOCKED_NAMES.has(host) || BLOCKED_SUFFIXES.some(s => host.endsWith(s))) return null;
  return host;
}

export function allowPrefix(env: NodeJS.ProcessEnv = process.env): string {
  return `rove:v1:${env.VERCEL_ENV === 'production' ? 'production' : 'nonproduction'}:allow`;
}
export function allowKeys(prefix = allowPrefix()) {
  return { hosts: `${prefix}:hosts`, pending: `${prefix}:pending`, counts: `${prefix}:pending:count`, audit: `${prefix}:audit` };
}

export type AuditEntry = { action: 'add' | 'remove' | 'request' | 'dismiss'; host: string; actor: string; at: string; reason?: string };
export type Pending = { host: string; count: number; firstSeen: string };
export type RequestOutcome = 'queued' | 'duplicate' | 'rate_limited' | 'queue_full';

export interface AllowStore {
  hosts(): Promise<string[]>;
  add(host: string, audit: AuditEntry): Promise<void>;
  remove(host: string, audit: AuditEntry): Promise<boolean>;
  pending(now: number): Promise<Pending[]>;
  dismiss(host: string, audit: AuditEntry): Promise<boolean>;
  request(host: string, visitorKey: string, ipKey: string, now: number, audit: AuditEntry): Promise<RequestOutcome>;
  hit(key: string, ttlSec: number): Promise<number>;
}

// ---------- effective allowlist with 60s cache, fail closed ----------
let cache: { at: number; hosts: Set<string> } | null = null;
export function resetAllowCache() { cache = null; }
export async function dynamicHosts(store: AllowStore | null, now = Date.now()): Promise<Set<string>> {
  if (!store) return new Set();
  if (cache && now - cache.at < CACHE_MS) return cache.hosts;
  try {
    const hosts = new Set((await store.hosts()).map(normalizeHost).filter((h): h is string => !!h));
    cache = { at: now, hosts };
    return hosts;
  } catch {
    cache = { at: now - CACHE_MS + 10_000, hosts: new Set() }; // fail closed, retry in ~10s
    return cache.hosts;
  }
}
/** True if hostname is allowed by config ∪ Redis (exact match after normalisation). */
export async function isHostAllowed(hostname: string, configured: string[], store: AllowStore | null, now = Date.now()): Promise<boolean> {
  if (configured.includes(hostname.toLowerCase())) return true;
  const h = normalizeHost(hostname);
  if (!h) return false;
  if (configured.map(normalizeHost).includes(h)) return true;
  return (await dynamicHosts(store, now)).has(h);
}

// ---------- admin auth ----------
export function adminKey(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.ROVE_ADMIN_KEY || env.ROVE_API_KEY || null; // prefer a dedicated admin key when configured
}
export function adminAuthorized(req: Request, env: NodeJS.ProcessEnv = process.env): boolean {
  const key = adminKey(env);
  if (!key) return false; // fail closed
  const a = createHash('sha256').update(req.headers.get('authorization') ?? '').digest();
  const b = createHash('sha256').update(`Bearer ${key}`).digest();
  return timingSafeEqual(a, b);
}

// ---------- stores ----------
const REQUEST_LUA = `
local v=redis.call('INCR',KEYS[3]) if v==1 then redis.call('EXPIRE',KEYS[3],ARGV[5]) end
local i=redis.call('INCR',KEYS[4]) if i==1 then redis.call('EXPIRE',KEYS[4],ARGV[5]) end
if v>tonumber(ARGV[6]) or i>tonumber(ARGV[7]) then return -1 end
local old=redis.call('ZRANGEBYSCORE',KEYS[1],'-inf',ARGV[3])
for _,h in ipairs(old) do redis.call('HDEL',KEYS[2],h) end
redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',ARGV[3])
if redis.call('ZSCORE',KEYS[1],ARGV[1]) then redis.call('HINCRBY',KEYS[2],ARGV[1],1) return 0 end
if redis.call('ZCARD',KEYS[1])>=tonumber(ARGV[4]) then return -2 end
redis.call('ZADD',KEYS[1],ARGV[2],ARGV[1])
redis.call('HSET',KEYS[2],ARGV[1],1)
redis.call('RPUSH',KEYS[5],ARGV[8])
return 1`;

export function redisAllowStore(url: string, token: string, prefix = allowPrefix(), fetchImpl: typeof fetch = fetch): AllowStore {
  if (!url.startsWith('https://')) throw new Error('KV REST URL must use HTTPS');
  const k = allowKeys(prefix);
  const pipe = async (cmds: (string | number)[][]): Promise<unknown[]> => {
    const r = await fetchImpl(url.replace(/\/$/, '') + '/pipeline', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds), signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error('Allowlist store unavailable');
    const out = await r.json() as { result?: unknown; error?: string }[];
    if (!Array.isArray(out) || out.some(x => x.error)) throw new Error('Allowlist store error');
    return out.map(x => x.result);
  };
  return {
    async hosts() { const [r] = await pipe([['SMEMBERS', k.hosts]]); if (!Array.isArray(r)) throw new Error('bad'); return r.map(String); },
    async add(host, audit) { await pipe([['SADD', k.hosts, host], ['ZREM', k.pending, host], ['HDEL', k.counts, host], ['RPUSH', k.audit, JSON.stringify(audit)]]); },
    async remove(host, audit) { const [n] = await pipe([['SREM', k.hosts, host], ['RPUSH', k.audit, JSON.stringify(audit)]]); return Number(n) > 0; },
    async dismiss(host, audit) { const [n] = await pipe([['ZREM', k.pending, host], ['HDEL', k.counts, host], ['RPUSH', k.audit, JSON.stringify(audit)]]); return Number(n) > 0; },
    async pending(now) {
      const [z, c] = await pipe([['ZRANGEBYSCORE', k.pending, now - PENDING_TTL_MS, '+inf', 'WITHSCORES'], ['HGETALL', k.counts]]);
      const counts = new Map<string, number>(); const ca = (c as string[]) ?? [];
      for (let i = 0; i < ca.length; i += 2) counts.set(ca[i], Number(ca[i + 1]));
      const za = (z as string[]) ?? []; const out: Pending[] = [];
      for (let i = 0; i < za.length; i += 2) out.push({ host: za[i], count: counts.get(za[i]) ?? 1, firstSeen: new Date(Number(za[i + 1])).toISOString() });
      return out;
    },
    async request(host, visitorKey, ipKey, now, audit) {
      const [r] = await pipe([['EVAL', REQUEST_LUA, 5, k.pending, k.counts, visitorKey, ipKey, k.audit,
        host, now, now - PENDING_TTL_MS, PENDING_CAP, 90000, REQUEST_LIMIT_VISITOR, REQUEST_LIMIT_IP, JSON.stringify(audit)]]);
      const n = Number(r);
      return n === -1 ? 'rate_limited' : n === -2 ? 'queue_full' : n === 0 ? 'duplicate' : 'queued';
    },
    async hit(key, ttl) { const [n] = await pipe([['INCR', key], ['EXPIRE', key, ttl, 'NX']]); return Number(n); },
  };
}

export function memoryAllowStore(): AllowStore & { auditLog: AuditEntry[] } {
  const hosts = new Set<string>(); const pend = new Map<string, { count: number; first: number }>();
  const counters = new Map<string, number>(); const auditLog: AuditEntry[] = [];
  const hit = async (key: string) => { const n = (counters.get(key) ?? 0) + 1; counters.set(key, n); return n; };
  return {
    auditLog, hit,
    async hosts() { return [...hosts]; },
    async add(h, a) { hosts.add(h); pend.delete(h); auditLog.push(a); },
    async remove(h, a) { auditLog.push(a); return hosts.delete(h); },
    async dismiss(h, a) { auditLog.push(a); return pend.delete(h); },
    async pending(now) { return [...pend].filter(([, p]) => p.first > now - PENDING_TTL_MS).map(([host, p]) => ({ host, count: p.count, firstSeen: new Date(p.first).toISOString() })); },
    async request(h, vk, ik, now, a) {
      const v = await hit(vk), i = await hit(ik);
      if (v > REQUEST_LIMIT_VISITOR || i > REQUEST_LIMIT_IP) return 'rate_limited';
      for (const [x, p] of pend) if (p.first <= now - PENDING_TTL_MS) pend.delete(x);
      const e = pend.get(h); if (e) { e.count++; return 'duplicate'; }
      if (pend.size >= PENDING_CAP) return 'queue_full';
      pend.set(h, { count: 1, first: now }); auditLog.push(a); return 'queued';
    },
  };
}

let shared: AllowStore | null | undefined;
export function defaultAllowStore(env: NodeJS.ProcessEnv = process.env): AllowStore | null {
  if (shared !== undefined) return shared;
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL, token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  try { shared = url && token ? redisAllowStore(url, token, allowPrefix(env)) : null; } catch { shared = null; }
  return shared;
}
