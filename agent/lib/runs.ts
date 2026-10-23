// Durable, bounded run log in Redis (Upstash REST). Keys: rove:v1:<production|nonproduction>:runs:...
// Records expire after RUN_TTL_SECONDS; the recent-runs index is capped at RUN_INDEX_CAP entries.
// Writes are best-effort: callers hand them to waitUntil and failures are only logged.
import { hashId, readCookie, verifyVisitor } from './trial.ts';

export const RUN_TTL_SECONDS = 90 * 24 * 3600;
export const RUN_INDEX_CAP = 5000;
const WRITE_TIMEOUT_MS = 2500;
// Labelled rough estimate, used only when the AI Gateway reports tokens but no cost. Not a billing figure.
export const ESTIMATE_RATES_USD_PER_MTOK = { input: 1.25, output: 10 } as const;

export type RunStatus = 'accepted' | 'completed' | 'failed' | 'rejected' | 'abandoned' | 'incomplete';
export type RunRecord = {
  id: string; sessionId?: string; requestType: 'agent_run' | 'extract';
  plan: 'trial' | 'paid' | 'api_key'; visitorHash?: string; host?: string;
  createdAt: string; finishedAt?: string; durationMs?: number; status: RunStatus;
  errorCode?: string; errorMessage?: string; rejectedHost?: string; clientDisconnectedAt?: string;
  tokensIn?: number; tokensOut?: number; costUsd?: number; costSource?: 'gateway' | 'estimate' | 'none';
};

export type RunStore = {
  put(rec: RunRecord): Promise<void>;
  get(id: string): Promise<RunRecord | null>;
  linkSession(sessionId: string, runId: string): Promise<void>;
  bySession(sessionId: string): Promise<string | null>;
  recent(limit: number): Promise<RunRecord[]>;
};

export function runPrefix(env: NodeJS.ProcessEnv = process.env): string {
  return `rove:v1:${env.VERCEL_ENV === 'production' ? 'production' : 'nonproduction'}:runs`;
}
const ID = /^[A-Za-z0-9_-]{8,80}$/;

export function redisRunStore(url: string, token: string, prefix = runPrefix(), fetchImpl: typeof fetch = fetch): RunStore {
  const pipe = async (cmds: (string | number)[][]): Promise<unknown[]> => {
    const r = await fetchImpl(url.replace(/\/$/, '') + '/pipeline', { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds),
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS) });
    if (!r.ok) throw new Error(`Run store unavailable (${r.status})`);
    return (await r.json() as { result?: unknown; error?: string }[]).map(x => { if (x.error) throw new Error('Run store error'); return x.result; });
  };
  const rec = (id: string) => `${prefix}:rec:${id}`;
  const parse = (v: unknown) => { try { return typeof v === 'string' ? JSON.parse(v) as RunRecord : null; } catch { return null; } };
  return {
    async put(r) {
      if (!ID.test(r.id)) throw new Error('bad run id');
      const cmds: (string | number)[][] = [['SET', rec(r.id), JSON.stringify(r), 'EX', RUN_TTL_SECONDS]];
      await pipe(cmds);
    },
    async get(id) { if (!ID.test(id)) return null; return parse((await pipe([['GET', rec(id)]]))[0]); },
    async linkSession(sid, id) {
      if (!ID.test(sid) || !ID.test(id)) return;
      await pipe([['SET', `${prefix}:sess:${sid}`, id, 'EX', RUN_TTL_SECONDS]]);
    },
    async bySession(sid) { if (!ID.test(sid)) return null; const v = (await pipe([['GET', `${prefix}:sess:${sid}`]]))[0]; return typeof v === 'string' ? v : null; },
    async recent(limit) {
      const ids = (await pipe([['LRANGE', `${prefix}:idx`, 0, Math.max(0, Math.min(limit, RUN_INDEX_CAP) - 1)]]))[0];
      if (!Array.isArray(ids) || !ids.length) return [];
      const vals = (await pipe([['MGET', ...ids.map(i => rec(String(i)))]]))[0];
      return (Array.isArray(vals) ? vals : []).map(parse).filter((x): x is RunRecord => !!x);
    },
  };
}


export function memoryRunStore(): RunStore & { index(id: string): Promise<void>; recs: Map<string, RunRecord> } {
  const recs = new Map<string, RunRecord>(), sess = new Map<string, string>(); let idx: string[] = [];
  return { recs,
    async put(r) { recs.set(r.id, structuredClone(r)); },
    async get(id) { return recs.has(id) ? structuredClone(recs.get(id)!) : null; },
    async linkSession(s, id) { sess.set(s, id); },
    async bySession(s) { return sess.get(s) ?? null; },
    async index(id) { idx = [id, ...idx].slice(0, RUN_INDEX_CAP); },
    async recent(limit) { return idx.slice(0, limit).map(i => recs.get(i)).filter((x): x is RunRecord => !!x); },
  };
}

function withIndex(store: RunStore, url: string, token: string, prefix: string) {
  return Object.assign(store, { async index(id: string) {
    if (!ID.test(id)) return;
    const r = await fetch(url.replace(/\/$/, '') + '/pipeline', { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['LPUSH', `${prefix}:idx`, id], ['LTRIM', `${prefix}:idx`, 0, RUN_INDEX_CAP - 1], ['EXPIRE', `${prefix}:idx`, RUN_TTL_SECONDS]]),
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS) });
    if (!r.ok) throw new Error(`Run index unavailable (${r.status})`);
  } });
}

let shared: (RunStore & { index?: (id: string) => Promise<void> }) | null | undefined;
export function defaultRunStore(env: NodeJS.ProcessEnv = process.env) {
  if (shared === undefined) {
    const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL, token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
    shared = url && token && url.startsWith('https://') ? withIndex(redisRunStore(url, token, runPrefix(env)), url, token, runPrefix(env)) : null;
  }
  return shared;
}
export function setRunStoreForTests(s: (RunStore & { index?: (id: string) => Promise<void> }) | null) { shared = s; }

/** HMAC'd visitor id (truncated); never raw IP or raw cookie. */
export function visitorHashFor(secret: Buffer | null, req: Request, setCookie?: string): string | undefined {
  if (!secret) return undefined;
  const fromSet = setCookie?.match(/^[^=]+=([^;]+)/)?.[1];
  const id = verifyVisitor(secret, readCookie(req)) ?? verifyVisitor(secret, fromSet ?? null);
  return id ? hashId(secret, 'runlog-v', id).slice(0, 16) : undefined;
}

export function hostOf(u: string): string | undefined { try { return new URL(u).hostname.toLowerCase(); } catch { return undefined; } }

type Usage = { inputTokens?: number; outputTokens?: number; costUsd?: number } | undefined;
export function usageFields(u: Usage): Pick<RunRecord, 'tokensIn' | 'tokensOut' | 'costUsd' | 'costSource'> {
  if (!u || typeof u !== 'object') return {};
  const tokensIn = Number.isFinite(u.inputTokens) ? u.inputTokens : undefined;
  const tokensOut = Number.isFinite(u.outputTokens) ? u.outputTokens : undefined;
  if (Number.isFinite(u.costUsd)) return { tokensIn, tokensOut, costUsd: u.costUsd, costSource: 'gateway' };
  if (tokensIn === undefined && tokensOut === undefined) return {};
  const est = ((tokensIn ?? 0) * ESTIMATE_RATES_USD_PER_MTOK.input + (tokensOut ?? 0) * ESTIMATE_RATES_USD_PER_MTOK.output) / 1e6;
  return { tokensIn, tokensOut, costUsd: Math.round(est * 1e6) / 1e6, costSource: 'estimate' };
}

const TERMINAL: Record<string, RunStatus> = { 'session.waiting': 'completed', 'session.completed': 'completed', 'session.failed': 'failed', 'turn.failed': 'failed' };
/** Completion patch for a terminal stream event, or null. */
export function finishPatch(ev: unknown, now = Date.now()): Partial<RunRecord> | null {
  if (!ev || typeof ev !== 'object') return null;
  const e = ev as { type?: string; data?: any };
  const status = e.type ? TERMINAL[e.type] : undefined;
  if (!status) return null;
  const d = e.data ?? {};
  const err = status === 'failed' ? { errorCode: String(d.code ?? d.error?.code ?? 'run_failed').slice(0, 80),
    errorMessage: String(d.message ?? d.error?.message ?? (typeof d.error === 'string' ? d.error : '') ?? '').slice(0, 300) } : {};
  return { status, finishedAt: new Date(now).toISOString(), ...err, ...usageFields(d.usage) };
}

const log = (what: string, e: unknown) => console.error(`run log ${what} failed:`, e instanceof Error ? e.message : 'error');

/** Create a run record (and index it). Never throws. */
export async function logRun(rec: RunRecord, store = defaultRunStore()): Promise<void> {
  if (!store) return;
  try {
    if (rec.status !== 'accepted' && rec.finishedAt && !rec.durationMs) rec.durationMs = Date.parse(rec.finishedAt) - Date.parse(rec.createdAt);
    await store.put(rec); await store.index?.(rec.id);
    if (rec.sessionId) await store.linkSession(rec.sessionId, rec.id);
  } catch (e) { log('write', e); }
}

/** Apply a terminal stream event to the run behind a session; first finish wins. Never throws. */
export async function finishRun(sessionId: string, patch: Partial<RunRecord>, store = defaultRunStore()): Promise<void> {
  if (!store) return;
  try {
    const id = await store.bySession(sessionId); if (!id) return;
    const rec = await store.get(id); if (!rec || rec.finishedAt) return;
    const next = { ...rec, ...patch } as RunRecord;
    if (next.finishedAt) next.durationMs = Math.max(0, Date.parse(next.finishedAt) - Date.parse(rec.createdAt));
    await store.put(next);
  } catch (e) { log('finish', e); }
}

/** A run with no terminal event after 10 minutes is reported as incomplete (last-resort sweep; normally the server-side watcher finalizes runs). */
export function withEffectiveStatus(r: RunRecord, now = Date.now()): RunRecord {
  return r.status === 'accepted' && now - Date.parse(r.createdAt) > 10 * 60_000 ? { ...r, status: 'incomplete' } : r;
}

export type RunFilter = { status?: string; type?: string; plan?: string; errorCode?: string; host?: string; since?: string; limit?: number };
export function filterRuns(runs: RunRecord[], f: RunFilter): RunRecord[] {
  const since = f.since ? Date.parse(f.since) : NaN;
  return runs.map(r => withEffectiveStatus(r)).filter(r => (!f.status || r.status === f.status) && (!f.type || r.requestType === f.type) && (!f.plan || r.plan === f.plan)
    && (!f.errorCode || r.errorCode === f.errorCode) && (!f.host || r.host === f.host || r.rejectedHost === f.host)
    && (Number.isNaN(since) || Date.parse(r.createdAt) >= since)).slice(0, f.limit ?? 100);
}

/** Record a non-terminal note (e.g. the client hung up) unless the run already finished. Never throws. */
export async function annotateRun(sessionId: string, patch: Partial<RunRecord>, store = defaultRunStore()): Promise<void> {
  if (!store) return;
  try {
    const id = await store.bySession(sessionId); if (!id) return;
    const rec = await store.get(id); if (!rec || rec.finishedAt) return;
    await store.put({ ...rec, ...patch });
  } catch (e) { log('annotate', e); }
}

/**
 * Server-side watcher: reads the session's own event stream (independent of any client) and finalizes
 * the run on its terminal event. If the stream ends or the deadline passes first, the run is finalized
 * as 'abandoned' with whatever usage was seen. Never throws.
 */
export async function watchRun(sessionId: string, open: () => Promise<ReadableStream<unknown>>,
  opts: { deadlineMs?: number; store?: ReturnType<typeof defaultRunStore> | RunStore; now?: () => number } = {}): Promise<void> {
  const store = opts.store === undefined ? defaultRunStore() : opts.store;
  if (!store) return;
  const now = opts.now ?? Date.now;
  let usage: Partial<RunRecord> = {};
  let reader: ReadableStreamDefaultReader<unknown> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>(r => { timer = setTimeout(() => r('timeout'), opts.deadlineMs ?? 170_000); });
  let reason = 'stream_ended';
  try {
    reader = (await open()).getReader();
    for (;;) {
      const next = await Promise.race([reader.read(), timeout]);
      if (next === 'timeout') { reason = 'watch_timeout'; break; }
      if (next.done) break;
      let ev: unknown = next.value;
      if (ev instanceof Uint8Array) continue;
      if (typeof ev === 'string') { try { ev = JSON.parse(ev); } catch { continue; } }
      const u = (ev as { data?: { usage?: unknown } } | null)?.data?.usage;
      if (u && typeof u === 'object') usage = usageFields(u as never);
      const patch = finishPatch(ev, now());
      if (patch) { await finishRun(sessionId, patch, store); return; }
    }
  } catch (e) { reason = 'watch_error'; log('watch', e); }
  finally { clearTimeout(timer); reader?.cancel().catch(() => {}); }
  await finishRun(sessionId, { status: 'abandoned', finishedAt: new Date(now()).toISOString(), errorCode: reason,
    errorMessage: 'Run ended without a final event; recorded with partial data.', ...usage }, store);
}
