import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import {
  applySubscriptionStatus,
  claimExtractSlot,
  entitlementForStatus,
  hashApiKey,
  recordCompletedCheckout,
} from '../agent/lib/kv-store.ts';

// Minimal Upstash REST emulator for the scripts kv-store sends.
const kv = new Map<string, string>();
const oldFetch = globalThis.fetch;
const envNames = ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'VERCEL_ENV', 'STRIPE_SECRET_KEY'] as const;
const oldEnv = Object.fromEntries(envNames.map(key => [key, process.env[key]]));

before(() => {
  process.env.KV_REST_API_URL = 'https://sample.upstash.io';
  process.env.KV_REST_API_TOKEN = 'fake-unit-test-token';
  delete process.env.VERCEL_ENV;
  process.env.STRIPE_SECRET_KEY = 'sk_test_example';
  globalThis.fetch = (async (_url, options) => {
    const [command, ...rest] = JSON.parse(String(options?.body));
    let result: unknown;
    if (command === 'GET') {
      result = kv.get(rest[0]) ?? null;
    } else {
      const [script, keyCount, ...data] = rest;
      const keys: string[] = data.slice(0, keyCount);
      const args = data.slice(keyCount);
      if (script.includes('EXPIREAT')) {
        const count = Number(kv.get(keys[1]) ?? 0);
        result = kv.get(keys[0]) !== '1' && count >= Number(args[0]) ? 0 : 1;
        if (result) kv.set(keys[1], String(count + 1));
      } else if (kv.has(keys[0])) {
        result = 0;
      } else if (script.includes("ARGV[1] == '1'")) {
        if (args[0] === '1') kv.set(keys[1], '1');
        else kv.delete(keys[1]);
        kv.set(keys[0], '1');
        result = 1;
      } else {
        kv.set(keys[1], '1');
        kv.set(keys[0], '1');
        if (keys[2]) kv.set(keys[2], String(args[0]));
        result = 1;
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

const paidKey = (apiKey: string) => `rove:v1:nonproduction:test:paid:${hashApiKey(apiKey)}`;
const exhaust = async (apiKey: string) => {
  kv.set(`rove:v1:nonproduction:test:usage:2026-10:${hashApiKey(apiKey)}`, '50');
  return claimExtractSlot(apiKey, new Date('2026-10-20T00:00:00Z'));
};

test('status mapping: active/trialing grant, canceled/unpaid/incomplete_expired revoke, past_due unchanged', () => {
  assert.equal(entitlementForStatus('active'), 'grant');
  assert.equal(entitlementForStatus('trialing'), 'grant');
  for (const s of ['canceled', 'unpaid', 'incomplete_expired']) assert.equal(entitlementForStatus(s), 'revoke');
  for (const s of ['past_due', 'incomplete', 'paused']) assert.equal(entitlementForStatus(s), null);
});

test('checkout stores subscription mapping; cancellation via mapping revokes paid access', async () => {
  const digest = hashApiKey('cust-a');
  assert.equal(await recordCompletedCheckout('evt_co_a', digest, 'sub_A1'), true);
  assert.equal(kv.get('rove:v1:nonproduction:test:subscription:sub_A1'), digest);
  assert.ok(await exhaust('cust-a'), 'paid key passes the limit');

  assert.equal(await applySubscriptionStatus('evt_del_a', 'sub_A1', 'canceled'), 'applied');
  assert.equal(kv.has(paidKey('cust-a')), false);
  assert.equal(await exhaust('cust-a'), null, 'revoked key is back on the free limit');
});

test('reactivation restores paid access; metadata hash works without mapping', async () => {
  const digest = hashApiKey('cust-b');
  assert.equal(await applySubscriptionStatus('evt_upd_b1', 'sub_B1', 'unpaid', digest), 'applied');
  assert.equal(kv.has(paidKey('cust-b')), false);
  assert.equal(await applySubscriptionStatus('evt_upd_b2', 'sub_B1', 'active', digest), 'applied');
  assert.equal(kv.get(paidKey('cust-b')), '1');
});

test('duplicate subscription events are ignored', async () => {
  const digest = hashApiKey('cust-c');
  await recordCompletedCheckout('evt_co_c', digest, 'sub_C1');
  assert.equal(await applySubscriptionStatus('evt_del_c', 'sub_C1', 'canceled'), 'applied');
  // A later reactivation, then a redelivery of the old cancel must not revoke again.
  assert.equal(await applySubscriptionStatus('evt_upd_c', 'sub_C1', 'active'), 'applied');
  assert.equal(await applySubscriptionStatus('evt_del_c', 'sub_C1', 'canceled'), 'duplicate');
  assert.equal(kv.get(paidKey('cust-c')), '1');
});

test('unknown subscriptions and non-terminal statuses change nothing', async () => {
  const before = new Map(kv);
  assert.equal(await applySubscriptionStatus('evt_x', 'sub_UNKNOWN', 'canceled'), 'unknown_subscription');
  assert.equal(await applySubscriptionStatus('evt_y', 'sub_C1', 'past_due'), 'ignored');
  assert.equal(await applySubscriptionStatus('evt_z', 'sub_C1', 'canceled', 'not-a-hash'), 'applied');
  assert.equal(kv.has(paidKey('cust-c')), false, 'invalid metadata falls back to stored mapping');
  kv.clear();
  for (const [k, v] of before) kv.set(k, v);
});
