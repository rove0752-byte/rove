// Turns browser tool results in the run event stream into small "frame" events for the chat's
// browser view. Rove's browser is a short-lived headless Chromium per tool call, so these are
// per-page snapshots, not a continuous video feed. Image bytes are removed from the original
// event so the stream never carries them twice.
export const FRAME_EVENT = 'rove.frame';
const MAX_FRAME_BASE64 = 700_000;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

function safeHttpUrl(u: unknown): string {
  try { const x = new URL(String(u)); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch { return ''; }
}

type Frame = { type: string; data: { url: string; title: string; mime: 'image/jpeg' | 'image/png'; base64: string } };

export function splitFrames(ev: unknown): unknown[] {
  if (!ev || typeof ev !== 'object') return [ev];
  const e = ev as { type?: unknown; data?: any };
  if (e.type !== 'action.result') return [ev];
  const output = e.data?.result?.output;
  if (!output || typeof output !== 'object') return [ev];
  const { previewJpegBase64, screenshotBase64, ...rest } = output as Record<string, unknown>;
  if (previewJpegBase64 === undefined && screenshotBase64 === undefined) return [ev];
  const clean = { ...e, data: { ...e.data, result: { ...e.data.result, output: rest } } };
  const pick = typeof previewJpegBase64 === 'string' ? { b: previewJpegBase64, mime: 'image/jpeg' as const }
    : typeof screenshotBase64 === 'string' ? { b: screenshotBase64, mime: 'image/png' as const } : null;
  if (!pick || pick.b.length > MAX_FRAME_BASE64 || !B64.test(pick.b)) return [clean];
  const frame: Frame = { type: FRAME_EVENT, data: { url: safeHttpUrl(rest.url), title: String(rest.title ?? '').slice(0, 200),
    mime: pick.mime, base64: pick.b } };
  return [frame, clean];
}

/** Parses string/object events; raw bytes pass through untouched. */
export function frameTransform(ev: unknown): unknown[] {
  if (typeof ev === 'string') {
    try { const parsed = JSON.parse(ev); const out = splitFrames(parsed); return out.length === 1 && out[0] === parsed ? [ev] : out; }
    catch { return [ev]; }
  }
  return splitFrames(ev);
}
