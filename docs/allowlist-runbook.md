# Rove allowlist runbook

## Policy (read first)
**While A3 public-site testing is paused, approving any host requires Jacko's explicit, per-host approval.**
No agent or automation may call `POST /v1/admin/allowlist` or run `scripts/allowlist.mjs add` without it.
There is no auto-approval rule. Record the approval reference in `reason` (required).

## How it works
- Effective allowlist = `ROVE_ALLOWED_HOSTS` (configured) ∪ Redis set `rove:v1:<env>:allow:hosts`,
  where `<env>` is `production` (VERCEL_ENV=production) or `nonproduction` (Preview/dev). Preview and
  Production never share entries.
- Exact host match only (after normalisation: lowercase, IDNA→punycode, port/path stripped, leading `www.` dropped).
  No wildcards and no subdomain inheritance: approving `example.org` does not allow `docs.example.org`.
- Never allowlistable: IP literals, `localhost`, `*.localhost`, `.local`, `.internal`, `.lan`, `.home`, `.corp`,
  `.arpa`, single-label names, metadata hostnames.
- Additive only: every fetch still resolves DNS and blocks private/link-local/metadata addresses
  (anti-rebinding), including for allowlisted hosts.
- Fail closed: if Redis is unreachable or errors, only the configured hosts are allowed.
- Cached in-process for 60s, so approvals and removals take effect within about a minute.

## Request queue
Visitors who hit `host_not_allowed` can click **Request this site**. That sends `POST /v1/allowlist/request {host}`
with their trial cookie. It never fetches or resolves the host.
- Stored in sorted set `rove:v1:<env>:allow:pending` (score = firstSeen ms) and hash `...:pending:count`.
- Limits: 5 requests per visitor per day and 20 per IP per day. The queue is capped at 500 entries, and entries expire after 30 days.
- Hosts are untrusted text. Admin output is JSON, and the site renders hosts with `textContent` only.

## Admin API (bearer = `ROVE_ADMIN_KEY` if set, else `ROVE_API_KEY`; 30 req/min/IP)
```
GET    /v1/admin/allowlist                                   # configured, hosts, pending
POST   /v1/admin/allowlist          {"host","reason","actor"?} # approve (also clears pending)
DELETE /v1/admin/allowlist          {"host","reason"?}         # remove (kill switch)
DELETE /v1/admin/allowlist/pending  {"host"}                   # dismiss a request
```
Example (only with Jacko's approval for this exact host):
```
curl -X POST https://<deployment>/v1/admin/allowlist -H "Authorization: Bearer $ROVE_ADMIN_KEY" \
  -H 'content-type: application/json' -d '{"host":"example.org","reason":"Jacko approved in #rove 2026-10-23","actor":"jacko"}'
```
CLI equivalent: `node scripts/allowlist.mjs add example.org --reason "Jacko approved ..." --env nonproduction`.

## Kill switch
To revoke a host immediately, run `DELETE /v1/admin/allowlist {"host":"x","reason":"..."}` or `node scripts/allowlist.mjs remove x`.
It takes effect within 60s. In an emergency, also remove the host from `ROVE_ALLOWED_HOSTS` if it is configured there.

## Audit log
`rove:v1:<env>:allow:audit` is an append-only Redis list of JSON entries
`{action: add|remove|request|dismiss, host, actor, at, reason?}`. Only the first request for a host is logged, so
the log stays bounded. Read it with `node scripts/allowlist.mjs audit`. Don't trim or edit it.

## Admin key
The code prefers `ROVE_ADMIN_KEY` and falls back to `ROVE_API_KEY`. Setting a separate admin key per environment
(Preview ≠ Production) is recommended, but it needs an env var change and Jacko's approval. The key is server-only
and is never sent to the client.
