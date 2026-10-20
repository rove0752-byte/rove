# Redis-backed usage and Checkout entitlements

This change replaces process-local `Map`/`Set` with Upstash Redis REST requests. Vercel KV was sunset; no new dependency is required.

## Vercel configuration

Provision Upstash Redis (Vercel Marketplace) and connect the **rove** project for Production and Preview. In Vercel project settings, verify these exist:

- `KV_REST_API_URL` — HTTPS REST URL
- `KV_REST_API_TOKEN` — **write-enabled** REST token, never read-only

`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are supported fallbacks. Do not commit credential values.

## Behavioral guarantees

- Each API key is referenced by SHA-256 digest in Redis. Monthly quota keys use UTC `YYYY-MM` and expire in the following month.
- Atomic Lua `EVAL` enforces a 50-extract-per-month free limit across Vercel instances.
- Checkout embeds a digest in Stripe metadata rather than a raw bearer credential; previously created Checkout Sessions using `apiKey` metadata remain supported.
- Signed `checkout.session.completed` events atomically record event ID and grant entitlement. Duplicate event IDs return successful acknowledgment without reapplying the change.
- Redis failures fail closed for extraction and return 503 for webhook writes so Stripe can retry.
- Test/live and Production/Preview states have separate key namespaces.

## Verification before merge

```sh
npm run typecheck
npm run build
node --experimental-strip-types --test tests/kv-store.test.ts
```

After a Preview deployment, validate a signed Stripe test event, resend the event to check idempotency, verify 50/51 free requests, verify entitlement bypass, then check persistence after redeploy. Do not test production payments before preview review.

## Known limitations

- A hard process crash after reserving an extract can leave a counted slot.
- A completed subscription Checkout currently grants a permanent flag. Cancellations, unpaid renewals and refunds **do not revoke access**. Add Stripe subscription lifecycle handling before taking live subscription payments.
- For correct paid-key identity, the existing single `ROVE_API_KEY` authentication scheme remains unchanged; multi-key authentication is outside this PR.
