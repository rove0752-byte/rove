import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consumeTrial, deriveSecret, signVisitor, verifyVisitor, memoryStore, redisStore, peekTrial, trialKeys, nextResetUtc, cookieHeader, IP_DAILY_LIMIT, VISITOR_DAILY_LIMIT, MEMORY_FALLBACK_LIMIT, type TrialStore } from '../agent/lib/trial.ts';
import { HOME_PAGE_HTML } from '../agent/lib/home-page.ts';

const secret = deriveSecret('test-root-key')!;
const now = new Date('2026-10-23T05:00:00Z');
// A "redis"-kind store backed by memory so production limits apply.
const fakeRedis = (): TrialStore => ({ ...memoryStore(), kind: 'redis' });
const req = (ip: string, cookie?: string, auth?: string) => new Request('https://rove.test/v1/agent/run', { method: 'POST', headers: { 'x-forwarded-for': ip, ...(cookie ? { cookie } : {}), ...(auth ? { authorization: auth } : {}) } });
const cookieOf = (sc?: string) => sc!.split(';')[0];

test('cookie signing round-trips and rejects tampering', () => {
  const v = signVisitor(secret, 'abcdefghijklmnop');
  assert.equal(verifyVisitor(secret, v), 'abcdefghijklmnop');
  assert.equal(verifyVisitor(secret, v.replace('abc', 'abd')), null);
  assert.equal(verifyVisitor(secret, v + 'x'), null);
  assert.equal(verifyVisitor(deriveSecret('other')!, v), null);
  assert.equal(verifyVisitor(secret, 'abcdefghijklmnop'), null);
  assert.equal(deriveSecret(undefined), null);
  assert.match(cookieHeader(v), /HttpOnly; Secure; SameSite=Lax/);
});

test('visitor gets VISITOR_DAILY_LIMIT runs, then trial_exhausted, with remaining decrementing', async () => {
  const store = fakeRedis();
  const first = await consumeTrial(store, secret, req('1.2.3.4'), now);
  assert.ok(first.ok && first.setCookie);
  assert.equal(first.remaining, VISITOR_DAILY_LIMIT - 1);
  const c = cookieOf(first.setCookie);
  for (let i = 2; i <= VISITOR_DAILY_LIMIT; i++) {
    const t = await consumeTrial(store, secret, req('1.2.3.4', c), now);
    assert.ok(t.ok); assert.equal(t.remaining, VISITOR_DAILY_LIMIT - i); assert.equal(t.setCookie, undefined);
  }
  const over = await consumeTrial(store, secret, req('1.2.3.4', c), now);
  assert.equal(over.ok, false); assert.equal(over.remaining, 0);
  assert.equal(over.resetsAt, '2026-10-24T00:00:00.000Z');
  // refunded: counter stays at the limit
  assert.equal((await peekTrial(store, secret, req('1.2.3.4', c), now)).remaining, 0);
  // next UTC day resets
  assert.ok((await consumeTrial(store, secret, req('1.2.3.4', c), new Date('2026-10-24T00:00:01Z'))).ok);
});

test('per-IP backstop limits cookie-clearing visitors', async () => {
  const store = fakeRedis();
  let ok = 0;
  for (let i = 0; i < IP_DAILY_LIMIT + 5; i++) if ((await consumeTrial(store, secret, req('9.9.9.9'), now)).ok) ok++;
  assert.equal(ok, IP_DAILY_LIMIT);
  assert.ok((await consumeTrial(store, secret, req('8.8.8.8'), now)).ok);
});

test('refund returns a run (used for failed/invalid requests)', async () => {
  const store = fakeRedis();
  const t = await consumeTrial(store, secret, req('5.5.5.5'), now);
  await t.refund();
  assert.equal((await peekTrial(store, secret, req('5.5.5.5', cookieOf(t.setCookie)), now)).remaining, VISITOR_DAILY_LIMIT);
});

test('memory fallback fails closed to a small limit', async () => {
  const store = memoryStore();
  let ok = 0;
  for (let i = 0; i < 10; i++) if ((await consumeTrial(store, secret, req('7.7.7.7'), now)).ok) ok++;
  assert.equal(ok, MEMORY_FALLBACK_LIMIT);
});

test('keys are env-scoped, day-scoped and never contain the raw IP', () => {
  const k = trialKeys(secret, 'visitor123456789', '203.0.113.7', now, 'rove:v1:nonproduction:trial');
  assert.match(k.visitor, /^rove:v1:nonproduction:trial:visitor:2026-10-23:[0-9a-f]{32}$/);
  assert.match(k.ip, /^rove:v1:nonproduction:trial:ip:2026-10-23:[0-9a-f]{32}$/);
  assert.ok(!k.ip.includes('203.0.113.7'));
  assert.equal(nextResetUtc(now).toISOString(), '2026-10-24T00:00:00.000Z');
});

test('redis store sends INCR + EXPIRE NX pipeline', async () => {
  let sent: unknown;
  const fake = (async (_u: string, init: RequestInit) => { sent = JSON.parse(String(init.body)); return new Response(JSON.stringify([{ result: 3 }, { result: 1 }, { result: 4 }, { result: 0 }])); }) as unknown as typeof fetch;
  const out = await redisStore('https://kv.test', 't', fake).incr(['a', 'b'], 100);
  assert.deepEqual(out, [3, 4]);
  assert.deepEqual(sent, [['INCR', 'a'], ['EXPIRE', 'a', 100, 'NX'], ['INCR', 'b'], ['EXPIRE', 'b', 100, 'NX']]);
});

test('home page has no API key UI and never sends Authorization', () => {
  assert.doesNotMatch(HOME_PAGE_HTML, /id="key"|API key|Authorization|Settings/);
});
