// HTTP handlers for the allowlist admin API and the visitor request-access queue.
// No handler here performs any outbound fetch or DNS lookup on the requested host.
import { createHash } from 'node:crypto';
import { ADMIN_LIMIT_PER_MIN, adminAuthorized, allowPrefix, normalizeHost, resetAllowCache, type AllowStore } from './allowlist.ts';
import { clientIp, hashId, readCookie, utcDay, verifyVisitor } from './trial.ts';

export type Deps = { store: AllowStore | null; secret: Buffer | null; env?: NodeJS.ProcessEnv; now?: () => number; configured?: () => string[] };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const h = (secret: Buffer | null, kind: string, v: string) => secret ? hashId(secret, kind, v) : createHash('sha256').update(kind + ':' + v).digest('hex').slice(0, 32);

async function input(req: Request): Promise<Record<string, unknown>> {
  const q = Object.fromEntries(new URL(req.url).searchParams);
  if (req.method === 'GET') return q;
  try { const b = await req.json(); return b && typeof b === 'object' ? { ...q, ...b } : q; } catch { return q; }
}

export async function adminHandler(req: Request, action: 'list' | 'add' | 'remove' | 'dismiss', d: Deps): Promise<Response> {
  const env = d.env ?? process.env, now = d.now?.() ?? Date.now();
  if (d.store) {
    try {
      const n = await d.store.hit(`${allowPrefix(env)}:adminrl:${h(d.secret, 'ip', clientIp(req))}:${Math.floor(now / 60000)}`, 120);
      if (n > ADMIN_LIMIT_PER_MIN) { const r = json({ code: 'rate_limited', error: 'Too many admin requests' }, 429); r.headers.set('retry-after', String(Math.max(1, 60 - Math.floor((now % 60000) / 1000)))); return r; }
    } catch { return json({ code: 'store_unavailable' }, 503); }
  }
  if (!adminAuthorized(req, env)) return json({ error: 'Admin key required' }, 401);
  if (!d.store) return json({ code: 'store_unavailable', error: 'KV is not configured' }, 503);
  const body = await input(req);
  try {
    if (action === 'list') {
      return json({ configured: d.configured?.() ?? [], hosts: (await d.store.hosts()).sort(), pending: await d.store.pending(now) });
    }
    const host = normalizeHost(body.host);
    if (!host) return json({ code: 'invalid_host', error: 'Host must be a public DNS name (no IPs, localhost, .local, .internal, ports or paths).' }, 400);
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
    const actor = typeof body.actor === 'string' && body.actor.trim() ? body.actor.trim().slice(0, 100) : 'admin-api';
    const audit = { host, actor, at: new Date(now).toISOString(), ...(reason ? { reason } : {}) };
    if (action === 'add') {
      if (reason.length < 3) return json({ code: 'reason_required', error: 'Approving a host requires a reason / approval reference.' }, 400);
      await d.store.add(host, { action: 'add', ...audit }); resetAllowCache();
      return json({ ok: true, added: host });
    }
    if (action === 'remove') { const removed = await d.store.remove(host, { action: 'remove', ...audit }); resetAllowCache(); return json({ ok: true, removed, host }); }
    const dismissed = await d.store.dismiss(host, { action: 'dismiss', ...audit });
    return json({ ok: true, dismissed, host });
  } catch { return json({ code: 'store_unavailable' }, 503); }
}

export async function requestAccessHandler(req: Request, d: Deps): Promise<Response> {
  const now = d.now?.() ?? Date.now();
  const visitor = d.secret ? verifyVisitor(d.secret, readCookie(req)) : null;
  if (!visitor) return json({ error: 'Visit the home page first' }, 401);
  const host = normalizeHost((await input(req)).host); // pure string parsing; never fetched or resolved
  if (!host) return json({ code: 'invalid_host', error: 'That doesn’t look like a public website address.' }, 400);
  if (!d.store) return json({ code: 'store_unavailable' }, 503);
  const p = `${allowPrefix(d.env ?? process.env)}:reqrl`, day = utcDay(new Date(now));
  try {
    const out = await d.store.request(host, `${p}:v:${day}:${h(d.secret, 'v', visitor)}`, `${p}:ip:${day}:${h(d.secret, 'ip', clientIp(req))}`, now,
      { action: 'request', host, actor: `visitor:${h(d.secret, 'v', visitor).slice(0, 12)}`, at: new Date(now).toISOString() });
    if (out === 'rate_limited') return json({ code: 'rate_limited', error: 'You’ve sent a lot of requests today — try again tomorrow.' }, 429);
    if (out === 'queue_full') return json({ code: 'queue_full', error: 'The review queue is full right now — try again later.' }, 429);
    return json({ ok: true, host, status: out }, 202);
  } catch { return json({ code: 'store_unavailable' }, 503); }
}
