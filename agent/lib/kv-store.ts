import { createHash } from 'node:crypto';

const FREE_MONTHLY_LIMIT = 50;

const CLAIM_SLOT_SCRIPT = `
local paid = redis.call('GET', KEYS[1]) == '1'
local count = tonumber(redis.call('GET', KEYS[2]) or '0')
if not paid and count >= tonumber(ARGV[1]) then return 0 end
redis.call('INCR', KEYS[2])
redis.call('EXPIREAT', KEYS[2], tonumber(ARGV[2]))
return 1
`;

const REFUND_SLOT_SCRIPT = `
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
if count > 0 then redis.call('DECR', KEYS[1]) end
return 1
`;

const COMPLETE_CHECKOUT_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('SET', KEYS[2], '1')
redis.call('SET', KEYS[1], '1')
if KEYS[3] then redis.call('SET', KEYS[3], ARGV[1]) end
return 1
`;

// KEYS[1]=event dedupe key, KEYS[2]=paid key; ARGV[1]='1' grants, '0' revokes.
const SUBSCRIPTION_STATUS_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
if ARGV[1] == '1' then redis.call('SET', KEYS[2], '1') else redis.call('DEL', KEYS[2]) end
redis.call('SET', KEYS[1], '1')
return 1
`;

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing']);
const REVOKED_SUBSCRIPTION_STATUSES = new Set(['canceled', 'unpaid', 'incomplete_expired']);

/** Maps a Stripe subscription status to grant / revoke / no change (e.g. past_due keeps access during dunning). */
export function entitlementForStatus(status: string): 'grant' | 'revoke' | null {
  if (ACTIVE_SUBSCRIPTION_STATUSES.has(status)) return 'grant';
  if (REVOKED_SUBSCRIPTION_STATUSES.has(status)) return 'revoke';
  return null;
}

export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

/** Entitlement hash for a website visitor (signed trial cookie id); same paid/usage scheme as API keys. */
export function visitorEntitlementHash(visitorId: string): string {
  return hashApiKey(`visitor:${visitorId}`);
}

export async function isPaidHash(hash: string): Promise<boolean> {
  if (!HASH_RE.test(hash)) return false;
  return (await redis(['GET', `${namespace()}:paid:${hash}`])) === '1';
}

export function isKvConfigured(): boolean {
  return !!(
    (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL) &&
    (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN)
  );
}

function namespace(): string {
  const environment = process.env.VERCEL_ENV === 'production' ? 'production' : 'nonproduction';
  const mode = /^sk_live_/.test(process.env.STRIPE_SECRET_KEY ?? '') ? 'live' : 'test';
  return `rove:v1:${environment}:${mode}`;
}

function period(now: Date): { name: string; expireAt: number } {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    name: `${year}-${String(month + 1).padStart(2, '0')}`,
    expireAt: Math.floor(Date.UTC(year, month + 1, 8) / 1000),
  };
}

async function redis(command: Array<string | number>): Promise<unknown> {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('KV is not configured');
  if (!url.startsWith('https://')) throw new Error('KV REST URL must use HTTPS');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`KV request failed (${response.status})`);
  const data: { result?: unknown; error?: string } = await response.json();
  if (data.error) throw new Error('KV returned an invalid response');
  return data.result;
}

async function evalRedis(script: string, keys: string[], args: Array<string | number>): Promise<number> {
  const result = await redis(['EVAL', script, keys.length, ...keys, ...args]);
  if (typeof result !== 'number') throw new Error('KV returned an invalid response');
  return result;
}

const HASH_RE = /^[a-f0-9]{64}$/;
const SUBSCRIPTION_RE = /^sub_[A-Za-z0-9]+$/;

export async function claimExtractSlot(apiKey: string, now = new Date()): Promise<string | null> {
  const digest = hashApiKey(apiKey);
  const { name, expireAt } = period(now);
  const prefix = namespace();
  const usageKey = `${prefix}:usage:${name}:${digest}`;
  const paidKey = `${prefix}:paid:${digest}`;
  const claimed = await evalRedis(CLAIM_SLOT_SCRIPT, [paidKey, usageKey], [FREE_MONTHLY_LIMIT, expireAt]);
  return claimed === 1 ? usageKey : null;
}

export async function refundExtractSlot(usageKey: string): Promise<void> {
  await evalRedis(REFUND_SLOT_SCRIPT, [usageKey], []);
}

export async function recordCompletedCheckout(
  eventId: string,
  apiKeyHash: string,
  subscriptionId?: string | null,
): Promise<boolean> {
  if (!HASH_RE.test(apiKeyHash)) throw new Error('Invalid API key hash');
  const prefix = namespace();
  const eventKey = `${prefix}:stripe:event:${eventId}`;
  const paidKey = `${prefix}:paid:${apiKeyHash}`;
  const keys = [eventKey, paidKey];
  if (subscriptionId && SUBSCRIPTION_RE.test(subscriptionId)) keys.push(`${prefix}:subscription:${subscriptionId}`);
  return (await evalRedis(COMPLETE_CHECKOUT_SCRIPT, keys, [apiKeyHash])) === 1;
}

export type SubscriptionUpdateResult = 'applied' | 'duplicate' | 'unknown_subscription' | 'ignored';

/**
 * Applies a subscription lifecycle event. The API key hash comes from the subscription's own
 * metadata (set at checkout) or, for older subscriptions, the mapping stored at checkout completion.
 */
export async function applySubscriptionStatus(
  eventId: string,
  subscriptionId: string,
  status: string,
  metadataHash?: string | null,
): Promise<SubscriptionUpdateResult> {
  const action = entitlementForStatus(status);
  if (!action) return 'ignored';
  const prefix = namespace();
  let apiKeyHash = metadataHash && HASH_RE.test(metadataHash) ? metadataHash : null;
  if (!apiKeyHash && SUBSCRIPTION_RE.test(subscriptionId)) {
    const stored = await redis(['GET', `${prefix}:subscription:${subscriptionId}`]);
    apiKeyHash = typeof stored === 'string' && HASH_RE.test(stored) ? stored : null;
  }
  if (!apiKeyHash) return 'unknown_subscription';
  const eventKey = `${prefix}:stripe:event:${eventId}`;
  const paidKey = `${prefix}:paid:${apiKeyHash}`;
  const applied = await evalRedis(SUBSCRIPTION_STATUS_SCRIPT, [eventKey, paidKey], [action === 'grant' ? '1' : '0']);
  return applied === 1 ? 'applied' : 'duplicate';
}
