#!/usr/bin/env node
// Rove allowlist admin CLI (talks to Redis directly via KV_REST_API_URL / KV_REST_API_TOKEN).
// POLICY: while public-site testing is paused, `add` requires Jacko's explicit per-host approval.
// No agent may run `add` (or call POST /v1/admin/allowlist) without it. See docs/allowlist-runbook.md.
//
//   node scripts/allowlist.mjs list               [--env production|nonproduction]
//   node scripts/allowlist.mjs pending            [--env ...]
//   node scripts/allowlist.mjs add <host> --reason "Jacko approved <ref>" [--actor name] [--env ...]
//   node scripts/allowlist.mjs remove <host> [--reason "..."]     # kill switch
//   node scripts/allowlist.mjs dismiss <host>                       # drop from pending
//   node scripts/allowlist.mjs audit [--limit 50]
// Requires Node >= 23.6 (imports the TypeScript module directly).
import { normalizeHost, redisAllowStore, allowKeys, allowPrefix } from '../agent/lib/allowlist.ts';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); if (i < 0) return d; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const env = flag('env', 'nonproduction'), reason = flag('reason', ''), actor = flag('actor', process.env.USER || 'cli'), limit = Number(flag('limit', '50'));
if (!['production', 'nonproduction'].includes(env)) { console.error('--env must be production or nonproduction'); process.exit(2); }
const [cmd, rawHost] = argv;
const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL, token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
if (!url || !token) { console.error('Set KV_REST_API_URL and KV_REST_API_TOKEN'); process.exit(2); }
const prefix = allowPrefix({ VERCEL_ENV: env === 'production' ? 'production' : 'preview' });
const store = redisAllowStore(url, token, prefix);
const now = Date.now(), at = new Date(now).toISOString();
const needHost = () => { const h = normalizeHost(rawHost); if (!h) { console.error('Invalid host (public DNS names only; no IPs/localhost/.local/.internal)'); process.exit(2); } return h; };

if (cmd === 'list') console.log(JSON.stringify({ prefix, hosts: (await store.hosts()).sort() }, null, 2));
else if (cmd === 'pending') console.log(JSON.stringify(await store.pending(now), null, 2));
else if (cmd === 'add') {
  const host = needHost();
  if (reason.trim().length < 3) { console.error('--reason "<Jacko approval reference>" is required'); process.exit(2); }
  await store.add(host, { action: 'add', host, actor, at, reason }); console.log(`added ${host} to ${prefix}:hosts (in-process caches refresh within 60s)`);
} else if (cmd === 'remove') { const host = needHost(); await store.remove(host, { action: 'remove', host, actor, at, ...(reason ? { reason } : {}) }); console.log(`removed ${host}`); }
else if (cmd === 'dismiss') { const host = needHost(); await store.dismiss(host, { action: 'dismiss', host, actor, at, ...(reason ? { reason } : {}) }); console.log(`dismissed ${host}`); }
else if (cmd === 'audit') {
  const r = await fetch(url.replace(/\/$/, '') + '/pipeline', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify([['LRANGE', allowKeys(prefix).audit, -limit, -1]]) });
  for (const line of (await r.json())[0].result ?? []) console.log(line);
} else { console.error('usage: list | pending | add <host> --reason ... | remove <host> | dismiss <host> | audit'); process.exit(2); }
