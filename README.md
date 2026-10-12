# Rove v0.1

The web, at your command.

An early developer prototype for a public-web research API, built with eve and Playwright. This is source code, not a deployed commercial service.

## Start locally

Requires Node.js 24.

```sh
npm ci
npm run preview
```

Open http://127.0.0.1:4310. The preview supports page inspection and screenshot evidence without a model. Linux uses packaged Chromium; on macOS or Windows install a browser first:

```sh
npx playwright install chromium
```

The preview runs only on loopback. Do not expose it publicly.

## AI agent runtime

Configure AI_GATEWAY_API_KEY privately in the server environment, then use `npm run dev` (or `npm exec -- eve dev --no-ui`). The gateway credential belongs to the service operator. No secret is included in this project. The model uses the scaffold's default openai/gpt-6-luna-fast.

The approved framework build now passes. Added the required just-bash dependency and kept browser packages external so their runtime assets are preserved. The built server starts and serves the homepage and health endpoint. Live AI tasks still require a model credential and have not been verified.

## API

- GET /v1/health — setup status
- POST /v1/extract — public page text, title, links, timestamp, PNG screenshot and screenshot SHA-256
- POST /v1/agent/run — URL, task and optional outputFormat; returns HTTP 202 with runId, sessionId and streamUrl
- GET /v1/agent/runs/:id/stream — NDJSON events, including the answer or failure

```sh
curl http://localhost:3000/v1/agent/run \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","task":"Summarise the page with sources","outputFormat":"JSON"}'
```

Use the port printed by eve. The plain preview responds 503 to AI tasks because it does not run the agent runtime.

## Current boundaries

- Browser contexts are fresh per page. No authentication or cookies are imported.
- JavaScript, service workers, submissions, non-GET/HEAD requests and downloads are disabled. JavaScript-heavy sites will be incomplete.
- DNS is checked against private/reserved ranges for each requested URL; redirects are rechecked. This is an application guard, not a network sandbox. DNS rebinding and hostile browser exploits require infrastructure-level egress enforcement and container isolation before public service.
- Production requires ROVE_API_KEY and an exact-host ROVE_ALLOWED_HOSTS allowlist. All callers currently share one operator key. This is not multi-tenant authentication.
- Page capture is limited to 30 seconds, 80 requests and 18,000 text characters. Bodies/resources are not byte-capped at the browser layer.
- The agent is instructed to inspect at most three pages. That is not yet an enforced task counter. Optional framework tools are disabled.
- Model token budget: US$0.25 per session, 30,000 input tokens and 4,000 output tokens. Framework limits check accumulated usage before further model calls; a crossing call may exceed the configured limit. These are not hard prepaid spending caps. Browser and infrastructure costs are additional.
- Agent JSON is requested through instructions but not schema-enforced. The interface shows raw stream events. A parsed results view and validated output schema remain future work.
- No billing, background worker pool, scheduling, customer accounts or production deployment.

## Verified

`npm run typecheck` passes. `npm test` passes private-address and URL-policy tests. The local UI check validates Chromium launch, screenshot capture, desktop page controls, mobile overflow, blocked private targets and the AI configuration error.

```sh
node --experimental-strip-types scripts/verify-preview.mjs
```

Public website extraction and credentialed AI runs are not verified in this environment. The production build and server startup pass; homepage and health endpoint both return HTTP 200. No money has been spent or domain purchased. Rove is a working name; brand availability has not been checked.

## Next milestone

Configure a model credential in the intended runtime, then complete one public-website task end to end. Before offering customer access, enforce per-run page/cost limits, output schemas, tenant isolation, infrastructure egress policy and ownership of run streams.

For an API with `ROVE_API_KEY` configured, include an Authorization header using the configured key. The example above assumes local development without an API key.
