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
return 1
`;

export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
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

async function evalRedis(script: string, keys: string[], args: Array<string | number>): Promise<number> {
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
    body: JSON.stringify(['EVAL', script, keys.length, ...keys, ...args]),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`KV request failed (${response.status})`);
  const data: { result?: unknown; error?: string } = await response.json();
  if (data.error || typeof data.result !== 'number') {
    throw new Error('KV returned an invalid response');
  }
  return data.result;
}

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

export async function recordCompletedCheckout(eventId: string, apiKeyHash: string): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(apiKeyHash)) throw new Error('Invalid API key hash');
  const prefix = namespace();
  const eventKey = `${prefix}:stripe:event:${eventId}`;
  const paidKey = `${prefix}:paid:${apiKeyHash}`;
  return (await evalRedis(COMPLETE_CHECKOUT_SCRIPT, [eventKey, paidKey], [])) === 1;
}
