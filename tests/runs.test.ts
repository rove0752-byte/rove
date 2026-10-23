import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterRuns, finishPatch, finishRun, logRun, memoryRunStore, redisRunStore, runPrefix, usageFields, visitorHashFor, withEffectiveStatus, RUN_TTL_SECONDS, type RunRecord } from '../agent/lib/runs.ts';
import { deriveSecret, signVisitor } from '../agent/lib/trial.ts';

const base = (o: Partial<RunRecord> = {}): RunRecord => ({ id: 'run_abcdefgh1', requestType: 'agent_run', plan: 'trial', createdAt: new Date(Date.now() - 4000).toISOString(), status: 'accepted', ...o });

test('prefix separates production from previews', () => {
  assert.equal(runPrefix({ VERCEL_ENV: 'production' }), 'rove:v1:production:runs');
  assert.equal(runPrefix({ VERCEL_ENV: 'preview' }), 'rove:v1:nonproduction:runs');
});

test('accepted run is finished once by the terminal stream event with gateway usage', async () => {
  const s = memoryRunStore();
  await logRun(base({ sessionId: 'sess_abcdefgh' }), s);
  const patch = finishPatch({ type: 'session.waiting', data: { usage: { inputTokens: 1200, outputTokens: 300, costUsd: 0.0042, cacheReadTokens: 0, cacheWriteTokens: 0 } } })!;
  await finishRun('sess_abcdefgh', patch, s);
  await finishRun('sess_abcdefgh', { status: 'failed' }, s);
  const r = (await s.get('run_abcdefgh1'))!;
  assert.equal(r.status, 'completed'); assert.equal(r.tokensIn, 1200); assert.equal(r.tokensOut, 300);
  assert.equal(r.costUsd, 0.0042); assert.equal(r.costSource, 'gateway'); assert.ok(r.durationMs! >= 3000);
  assert.equal((await s.recent(10)).length, 1);
});

test('failures carry code/message; missing cost is estimated and labelled', () => {
  const p = finishPatch({ type: 'session.failed', data: { code: 'budget_exceeded', message: 'Too many tokens', usage: { inputTokens: 1e6, outputTokens: 0 } } })!;
  assert.equal(p.status, 'failed'); assert.equal(p.errorCode, 'budget_exceeded'); assert.equal(p.costSource, 'estimate'); assert.ok(p.costUsd! > 0);
  assert.equal(finishPatch({ type: 'step.started' }), null);
  assert.deepEqual(usageFields(undefined), {});
});

test('persistence failures never throw', async () => {
  const broken = { ...memoryRunStore(), put: async () => { throw new Error('down'); } };
  const orig = console.error; console.error = () => {};
  try { await logRun(base(), broken); await finishRun('sess_x1234567', { status: 'completed' }, broken); } finally { console.error = orig; }
});

test('redis store uses TTL and capped, env-prefixed keys', async () => {
  const calls: unknown[] = [];
  const f = (async (_u: string, init: RequestInit) => { calls.push(JSON.parse(String(init.body))); return new Response(JSON.stringify([{ result: 'OK' }])); }) as typeof fetch;
  const s = redisRunStore('https://kv.test', 't', 'rove:v1:nonproduction:runs', f);
  await s.put(base());
  assert.deepEqual((calls[0] as any)[0].slice(0, 2), ['SET', 'rove:v1:nonproduction:runs:rec:run_abcdefgh1']);
  assert.equal((calls[0] as any)[0][4], RUN_TTL_SECONDS);
  await assert.rejects(s.put(base({ id: '../x' })));
});

test('visitor hash is HMAC-derived, short, and never the raw id or IP', () => {
  const secret = deriveSecret('k')!;
  const id = 'abcdefghijklmnopqrstuv';
  const req = new Request('https://r.test/', { headers: { cookie: 'rove_trial=' + signVisitor(secret, id), 'x-forwarded-for': '203.0.113.9' } });
  const h = visitorHashFor(secret, req)!;
  assert.match(h, /^[a-f0-9]{16}$/); assert.ok(!h.includes(id));
  assert.equal(visitorHashFor(secret, new Request('https://r.test/')), undefined);
});

test('filters and stale accepted runs report as incomplete', () => {
  const runs = [base({ id: 'a1234567', status: 'rejected', errorCode: 'host_not_allowed', rejectedHost: 'news.test' }),
    base({ id: 'b1234567', createdAt: new Date(Date.now() - 3600_000).toISOString() }), base({ id: 'c1234567', requestType: 'extract', status: 'completed' })];
  assert.deepEqual(filterRuns(runs, { host: 'news.test' }).map(r => r.id), ['a1234567']);
  assert.deepEqual(filterRuns(runs, { type: 'extract' }).map(r => r.id), ['c1234567']);
  assert.equal(withEffectiveStatus(runs[1]).status, 'incomplete');
  assert.deepEqual(filterRuns(runs, { status: 'incomplete' }).map(r => r.id), ['b1234567']);
});
