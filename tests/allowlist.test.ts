import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeHost, isHostAllowed, dynamicHosts, resetAllowCache, memoryAllowStore, adminAuthorized, adminKey, allowKeys, allowPrefix, REQUEST_LIMIT_VISITOR, PENDING_CAP, PENDING_TTL_MS, type AllowStore } from '../agent/lib/allowlist.ts';
import { adminHandler, requestAccessHandler } from '../agent/lib/allowlist-routes.ts';
import { validateUrl, HostNotAllowedError } from '../agent/lib/policy.ts';
import { deriveSecret, signVisitor } from '../agent/lib/trial.ts';

test('normalizeHost: lowercase, punycode, strip www/port/path; rejects unsafe forms', () => {
  assert.equal(normalizeHost('Example.COM'), 'example.com');
  assert.equal(normalizeHost('https://www.Example.com:8443/a?b#c'), 'example.com');
  assert.equal(normalizeHost('example.com.'), 'example.com');
  assert.equal(normalizeHost('bücher.example'), 'xn--bcher-kva.example');
  assert.equal(normalizeHost('shop.example.com'), 'shop.example.com');
  for (const bad of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '[::1]', 'http://[fd00::1]/', '0x7f000001', '2130706433',
    'localhost', 'foo.localhost', 'printer.local', 'db.internal', 'metadata.google.internal', 'metadata', 'intranet',
    '*.example.com', 'user:pw@example.com', 'exa mple.com', '<script>.com', '', 42, null])
    assert.equal(normalizeHost(bad as string), null, String(bad));
});

test('union: configured ∪ Redis, exact host only (no subdomain inheritance)', async () => {
  resetAllowCache();
  const s = memoryAllowStore(); await s.add('docs.example.org', { action: 'add', host: 'docs.example.org', actor: 't', at: '' });
  assert.equal(await isHostAllowed('example.com', ['example.com'], s), true);
  assert.equal(await isHostAllowed('docs.example.org', ['example.com'], s), true);
  assert.equal(await isHostAllowed('www.docs.example.org', ['example.com'], s), true); // www. normalised
  assert.equal(await isHostAllowed('a.docs.example.org', ['example.com'], s), false);
  assert.equal(await isHostAllowed('example.org', ['example.com'], s), false);
  assert.equal(await isHostAllowed('evil.com', ['example.com'], null), false);
});

test('cache: Redis read at most once per 60s', async () => {
  resetAllowCache(); let reads = 0;
  const s = { ...memoryAllowStore(), hosts: async () => { reads++; return ['a.example']; } } as AllowStore;
  await dynamicHosts(s, 1000); await dynamicHosts(s, 30_000); assert.equal(reads, 1);
  await dynamicHosts(s, 62_000); assert.equal(reads, 2);
});

test('fail closed: Redis error => configured allowlist only', async () => {
  resetAllowCache();
  const broken = { ...memoryAllowStore(), hosts: async () => { throw new Error('down'); } } as AllowStore;
  assert.equal(await isHostAllowed('docs.example.org', ['example.com'], broken), false);
  assert.equal(await isHostAllowed('example.com', ['example.com'], broken), true);
  await assert.rejects(validateUrl('https://docs.example.org/', 'example.com', broken), HostNotAllowedError);
});

test('safety: IPs/private/metadata in the Redis set are still rejected; DNS private check still runs', async () => {
  resetAllowCache();
  const s = { ...memoryAllowStore(), hosts: async () => ['127.0.0.1', '169.254.169.254', 'localhost', 'db.internal', 'localtest.me'] } as AllowStore;
  for (const u of ['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data', 'http://localhost/', 'http://db.internal/'])
    await assert.rejects(validateUrl(u, 'example.com', s), HostNotAllowedError, u);
  // Allowlisted by Redis but resolves to loopback => blocked by the fetch-time DNS/private-address check (anti-rebinding).
  const rebinding = async () => [{ address: '127.0.0.1' }]; // fake resolver: no real DNS in tests
  await assert.rejects(validateUrl('http://localtest.me/', 'example.com', s, rebinding), /Private and reserved/);
  await assert.rejects(validateUrl('http://localtest.me/', 'example.com', s, async () => [{ address: '169.254.169.254' }]), /Private and reserved/);
  assert.equal((await validateUrl('http://localtest.me/', 'example.com', s, async () => [{ address: '93.184.215.14' }])).hostname, 'localtest.me');
});

const secret = deriveSecret('test-root-key')!;
const env = { ROVE_API_KEY: 'k-api', VERCEL_ENV: 'preview' } as NodeJS.ProcessEnv;
const visitorReq = (host: string, ip = '203.0.113.9', id = 'visitor-0000000001') => new Request('https://r.test/v1/allowlist/request', {
  method: 'POST', body: JSON.stringify({ host }), headers: { cookie: `rove_trial=${signVisitor(secret, id)}`, 'x-forwarded-for': ip, 'content-type': 'application/json' } });

test('request queue: dedupe, per-visitor + per-IP limits, cap, expiry, no cookie => 401, audit', async () => {
  const s = memoryAllowStore(); let t = Date.UTC(2026, 9, 23);
  const d = { store: s, secret, env, now: () => t };
  assert.equal((await requestAccessHandler(new Request('https://r.test/', { method: 'POST', body: '{"host":"a.example"}' }), d)).status, 401);
  assert.equal((await requestAccessHandler(visitorReq('10.0.0.1'), d)).status, 400);
  const r1 = await requestAccessHandler(visitorReq('Example.CON'), d);
  assert.equal(r1.status, 202); assert.deepEqual(await r1.json(), { ok: true, host: 'example.con', status: 'queued' });
  assert.equal((await (await requestAccessHandler(visitorReq('example.con'), d)).json()).status, 'duplicate');
  assert.deepEqual((await s.pending(t)).map(p => [p.host, p.count]), [['example.con', 2]]);
  assert.equal(s.auditLog.filter(a => a.action === 'request').length, 1);
  for (let i = 2; i < REQUEST_LIMIT_VISITOR; i++) await requestAccessHandler(visitorReq(`x${i}.example`), d);
  assert.equal((await requestAccessHandler(visitorReq('y.example'), d)).status, 429); // 6th for this visitor
  let ipLimited = false; // many visitors behind one IP
  for (let i = 0; i < 30 && !ipLimited; i++) ipLimited = (await requestAccessHandler(visitorReq(`z${i}.example`, '198.51.100.1', `visitor-ip-${String(i).padStart(6, '0')}`), d)).status === 429;
  assert.ok(ipLimited);
  t += PENDING_TTL_MS + 1;
  assert.equal((await s.pending(t)).length, 0); // expired
  const full = memoryAllowStore();
  for (let i = 0; i < PENDING_CAP; i++) await full.request(`h${i}.example`, `v${i}`, `i${i}`, t, { action: 'request', host: '', actor: '', at: '' });
  assert.equal(await full.request('one-more.example', 'vx', 'ix', t, { action: 'request', host: '', actor: '', at: '' }), 'queue_full');
});

test('admin: bearer required (401), prefers ROVE_ADMIN_KEY, reason required, approve clears pending, audit', async () => {
  const s = memoryAllowStore(); const d = { store: s, secret, env };
  const req = (method: string, body?: object, key = 'k-api', path = '') => new Request('https://r.test/v1/admin/allowlist' + path,
    { method, body: body ? JSON.stringify(body) : undefined, headers: key ? { authorization: `Bearer ${key}` } : {} });
  assert.equal((await adminHandler(req('GET', undefined, ''), 'list', d)).status, 401);
  assert.equal((await adminHandler(req('GET', undefined, 'wrong'), 'list', d)).status, 401);
  assert.equal(adminKey({ ROVE_API_KEY: 'a', ROVE_ADMIN_KEY: 'b' } as NodeJS.ProcessEnv), 'b');
  assert.equal(adminAuthorized(req('GET', undefined, 'k-api'), { ROVE_API_KEY: 'k-api', ROVE_ADMIN_KEY: 'k-admin' } as NodeJS.ProcessEnv), false);
  assert.equal(adminAuthorized(req('GET'), {} as NodeJS.ProcessEnv), false); // no key configured => closed
  await s.request('pending.example', 'v', 'i', Date.now(), { action: 'request', host: 'pending.example', actor: 'x', at: '' });
  assert.equal((await adminHandler(req('POST', { host: 'pending.example' }), 'add', d)).status, 400); // no reason
  assert.equal((await adminHandler(req('POST', { host: '127.0.0.1', reason: 'x approved' }), 'add', d)).status, 400);
  assert.equal((await adminHandler(req('POST', { host: 'https://Pending.example/x', reason: 'Jacko approved 2026-10-23' }), 'add', d)).status, 200);
  const list = await (await adminHandler(req('GET'), 'list', d)).json();
  assert.deepEqual(list.hosts, ['pending.example']); assert.deepEqual(list.pending, []);
  assert.equal((await adminHandler(req('DELETE', { host: 'pending.example', reason: 'kill' }), 'remove', d)).status, 200);
  assert.deepEqual(await s.hosts(), []);
  assert.deepEqual(s.auditLog.map(a => a.action), ['request', 'add', 'remove']);
  assert.equal(s.auditLog[1].reason, 'Jacko approved 2026-10-23');
});

test('admin rate limit returns 429', async () => {
  const s = memoryAllowStore(); const d = { store: s, secret, env, now: () => 0 };
  let last = 0;
  for (let i = 0; i < 40; i++) last = (await adminHandler(new Request('https://r.test/', { headers: { authorization: 'Bearer nope' } }), 'list', d)).status;
  assert.equal(last, 429);
});

test('preview and production use separate key prefixes', () => {
  assert.equal(allowPrefix({ VERCEL_ENV: 'preview' } as NodeJS.ProcessEnv), 'rove:v1:nonproduction:allow');
  assert.equal(allowPrefix({ VERCEL_ENV: 'production' } as NodeJS.ProcessEnv), 'rove:v1:production:allow');
  assert.equal(allowKeys('p').hosts, 'p:hosts');
});

test('client: thanks message rendered via textContent; request button wired', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const src = html.slice(html.indexOf('/*hints*/'), html.indexOf('/*/hints*/'));
  const { thanks } = new Function(src + '\nreturn { thanks };')() as { thanks: (h: string) => string };
  assert.equal(thanks('example.con'), "Thanks — we'll review example.con.");
  assert.match(html, /n\.textContent=r\.ok\?thanks\(/);
  assert.match(html, /b\.textContent='Request this site'/);
});
