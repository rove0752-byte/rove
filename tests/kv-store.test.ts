import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { hashApiKey, isKvConfigured, claimExtractSlot, refundExtractSlot, recordCompletedCheckout } from '../agent/lib/kv-store.ts';

const kv = new Map<string, number | string>();
const oldFetch = globalThis.fetch;
const envNames = ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'VERCEL_ENV', 'STRIPE_SECRET_KEY'] as const;
const oldEnv = Object.fromEntries(envNames.map(key => [key, process.env[key]]));

before(() => {
  process.env.KV_REST_API_URL = 'https://sample.upstash.io';
  process.env.KV_REST_API_TOKEN = 'fake-unit-test-token';
  process.env.VERCEL_ENV = 'production';
  process.env.STRIPE_SECRET_KEY = 'sk_test_example';
  globalThis.fetch = (async (_url, options) => {
    const [command, script, keyCount, ...data] = JSON.parse(String(options?.body));
    assert.equal(command, 'EVAL');
    const keys: string[] = data.slice(0, keyCount);
    const args = data.slice(keyCount);
    let result: number;
    if (script.includes('EXPIREAT')) {
      const count = Number(kv.get(keys[1]) ?? 0);
      result = kv.get(keys[0]) !== '1' && count >= Number(args[0]) ? 0 : 1;
      if (result) kv.set(keys[1], count + 1);
    } else if (script.includes('DECR')) {
      kv.set(keys[0], Math.max(0, Number(kv.get(keys[0]) ?? 0) - 1));
      result = 1;
    } else {
      result = kv.has(keys[0]) ? 0 : 1;
      if (result) {
        kv.set(keys[1], '1');
        kv.set(keys[0], '1');
      }
    }
    return new Response(JSON.stringify({ result }), { status: 200 });
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = oldFetch;
  for (const key of envNames) {
    const value = oldEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('KV configured, API key stored by digest', () => {
  assert.ok(isKvConfigured());
  assert.match(hashApiKey('secret'), /^[a-f0-9]{64}$/);
  assert.notEqual(hashApiKey('secret'), hashApiKey('other'));
});

test('51st free extract is rejected', async () => {
  for (let i = 0; i < 50; i++) assert.ok(await claimExtractSlot('free', new Date('2026-10-20')));
  assert.equal(await claimExtractSlot('free', new Date('2026-10-20')), null);
});

test('new month resets quota', async () => {
  assert.ok(await claimExtractSlot('free', new Date('2026-11-01')));
});

test('failed extraction refunds reserved quota', async () => {
  const key = await claimExtractSlot('refundable');
  assert.ok(key);
  await refundExtractSlot(key);
  assert.equal(kv.get(key), 0);
});

test('duplicate webhook event does not reapply entitlement', async () => {
  const digest = hashApiKey('free');
  assert.equal(await recordCompletedCheckout('evt_test_123', digest), true);
  assert.equal(await recordCompletedCheckout('evt_test_123', digest), false);
  assert.ok(await claimExtractSlot('free', new Date('2026-10-20')));
});

test('invalid entitlement hash is rejected', async () => {
  await assert.rejects(recordCompletedCheckout('evt_invalid', 'plain'), /Invalid API key hash/);
});
