import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiConfigured } from '../agent/lib/ai-config.ts';
test('AI is configured via gateway key, env OIDC token, or the per-request OIDC header', () => {
  assert.equal(aiConfigured(undefined, {}), false);
  assert.equal(aiConfigured(new Request('https://r.test/'), {}), false);
  assert.equal(aiConfigured(undefined, { AI_GATEWAY_API_KEY: 'k' }), true);
  assert.equal(aiConfigured(undefined, { VERCEL_OIDC_TOKEN: 't' }), true);
  const env: NodeJS.ProcessEnv = {};
  assert.equal(aiConfigured(new Request('https://r.test/', { headers: { 'x-vercel-oidc-token': 'hdr' } }), env), true);
  assert.equal(env.VERCEL_OIDC_TOKEN, 'hdr');
});
