#!/usr/bin/env node
// Feature Scout-style summary of persisted runs, via GET /v1/admin/runs.
// Usage: ROVE_BASE_URL=https://<deployment> ROVE_ADMIN_KEY=... node scripts/runs-report.mjs [--since 2026-10-01] [--limit 1000] [--json]
// The key is read from the environment and never printed.
const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : undefined; };
const base = (process.env.ROVE_BASE_URL || '').replace(/\/$/, '');
const key = process.env.ROVE_ADMIN_KEY || process.env.ROVE_API_KEY;
if (!base || !key) { console.error('Set ROVE_BASE_URL and ROVE_ADMIN_KEY (or ROVE_API_KEY).'); process.exit(2); }
const q = new URLSearchParams({ limit: opt('limit') || '1000' });
if (opt('since')) q.set('since', opt('since'));
const res = await fetch(`${base}/v1/admin/runs?${q}`, { headers: { authorization: `Bearer ${key}` } });
if (!res.ok) { console.error(`Admin endpoint returned ${res.status}`); process.exit(1); }
const { runs } = await res.json();
const count = (xs, f) => Object.entries(xs.reduce((m, x) => { const k = f(x); if (k) m[k] = (m[k] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]);
const pct = (xs, p) => xs.length ? xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] : null;
const durs = runs.map(r => r.durationMs).filter(Number.isFinite).sort((a, b) => a - b);
const gateway = runs.filter(r => r.costSource === 'gateway').reduce((s, r) => s + r.costUsd, 0);
const est = runs.filter(r => r.costSource === 'estimate').reduce((s, r) => s + r.costUsd, 0);
const report = {
  runs: runs.length,
  byStatus: count(runs, r => r.status), byType: count(runs, r => r.requestType), byPlan: count(runs, r => r.plan),
  topRejectedHosts: count(runs, r => r.rejectedHost).slice(0, 20), errorCodes: count(runs, r => r.errorCode).slice(0, 20),
  topTargetHosts: count(runs, r => r.host).slice(0, 20), uniqueVisitors: new Set(runs.map(r => r.visitorHash).filter(Boolean)).size,
  tokens: { in: runs.reduce((s, r) => s + (r.tokensIn || 0), 0), out: runs.reduce((s, r) => s + (r.tokensOut || 0), 0) },
  costUsd: { gatewayReported: +gateway.toFixed(6), estimatedRoughOnly: +est.toFixed(6) },
  durationMs: { p50: pct(durs, 0.5), p95: pct(durs, 0.95) },
};
if (args.includes('--json')) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }
const tbl = (t, rows) => { console.log(`\n${t}`); if (!rows.length) console.log('  (none)'); for (const [k, v] of rows) console.log(`  ${String(v).padStart(5)}  ${k}`); };
console.log(`Runs: ${report.runs} · unique visitors: ${report.uniqueVisitors} · p50 ${report.durationMs.p50 ?? '-'}ms · p95 ${report.durationMs.p95 ?? '-'}ms`);
console.log(`Tokens in/out: ${report.tokens.in}/${report.tokens.out} · cost (gateway) $${report.costUsd.gatewayReported} · cost (rough estimate) $${report.costUsd.estimatedRoughOnly}`);
tbl('Status', report.byStatus); tbl('Plan', report.byPlan); tbl('Request type', report.byType);
tbl('Top rejected hosts (requests for sites not on the allowlist)', report.topRejectedHosts); tbl('Error codes', report.errorCodes); tbl('Top target hosts', report.topTargetHosts);
