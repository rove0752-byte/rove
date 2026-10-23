import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { frameTransform, splitFrames, FRAME_EVENT } from '../agent/lib/frames.ts';

const jpeg = Buffer.from('fake-jpeg-bytes').toString('base64');
const result = (output: unknown) => ({ type: 'action.result', data: { result: { output } } });

test('browser results become a frame event plus a result without image bytes', () => {
  const out = splitFrames(result({ url: 'https://example.com/', title: 'Example Domain', previewJpegBase64: jpeg, screenshotBase64: 'AAAA' })) as any[];
  assert.equal(out.length, 2);
  assert.equal(out[0].type, FRAME_EVENT);
  assert.deepEqual(out[0].data, { url: 'https://example.com/', title: 'Example Domain', mime: 'image/jpeg', base64: jpeg });
  const clean = JSON.stringify(out[1]);
  assert.doesNotMatch(clean, /previewJpegBase64|screenshotBase64/);
  assert.equal(out[1].data.result.output.title, 'Example Domain');
});

test('falls back to PNG screenshot; unrelated events pass through unchanged', () => {
  const out = splitFrames(result({ url: 'https://example.com/', screenshotBase64: jpeg })) as any[];
  assert.equal(out[0].data.mime, 'image/png');
  const ev = { type: 'step.started', data: {} };
  assert.deepEqual(splitFrames(ev), [ev]);
  assert.deepEqual(frameTransform('not json'), ['not json']);
  const s = JSON.stringify(ev); assert.deepEqual(frameTransform(s), [s]);
});

test('frames reject unsafe urls, non-base64 payloads and oversized images', () => {
  const bad = splitFrames(result({ url: 'javascript:alert(1)', previewJpegBase64: jpeg })) as any[];
  assert.equal(bad[0].data.url, '');
  const inj = splitFrames(result({ url: 'https://example.com/', previewJpegBase64: '"><script>' })) as any[];
  assert.equal(inj.length, 1); assert.doesNotMatch(JSON.stringify(inj), /script/);
  const big = splitFrames(result({ url: 'https://example.com/', previewJpegBase64: 'A'.repeat(800_000) })) as any[];
  assert.equal(big.length, 1);
});

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const src = html.slice(html.indexOf('/*chat*/'), html.indexOf('/*/chat*/'));
const C = new Function(src + '\nreturn { newRun, reduceRun, liveHtml };')() as any;

test('chat shows a live browser card, then collapses to the final view', () => {
  const st = C.newRun('https://example.com/');
  C.reduceRun(st, { type: 'session.started' });
  assert.match(C.liveHtml(st), /live on/); assert.match(C.liveHtml(st), /Starting a private browser/);
  C.reduceRun(st, { type: FRAME_EVENT, data: { url: 'https://example.com/', title: 'Example Domain', mime: 'image/jpeg', base64: jpeg } });
  const h = C.liveHtml(st);
  assert.match(h, /Viewing/); assert.doesNotMatch(h, />Live</); assert.match(h, /src="data:image\/jpeg;base64,/);
  C.reduceRun(st, { type: 'session.waiting' });
  assert.match(C.liveHtml(st), /live off/); assert.match(C.liveHtml(st), /Final view/);
});

test('chat ignores malformed frames and hides the card when nothing was captured', () => {
  const st = C.newRun('https://example.com/');
  C.reduceRun(st, { type: FRAME_EVENT, data: { base64: '"><img onerror=x>' } });
  assert.equal(st.shots.length, 0);
  C.reduceRun(st, { type: 'turn.failed', data: { error: 'x' } });
  assert.equal(C.liveHtml(st), '');
});

test('one card per page visited; earlier pages settle while the newest is viewing', () => {
  const st = C.newRun('https://example.com/');
  const fr = (url: string) => ({ type: FRAME_EVENT, data: { url, title: 't', mime: 'image/jpeg', base64: jpeg } });
  C.reduceRun(st, fr('https://example.com/')); C.reduceRun(st, fr('https://example.com/')); C.reduceRun(st, fr('https://example.com/a'));
  assert.equal(st.shots.length, 2);
  let h = C.liveHtml(st);
  assert.equal((h.match(/<figure/g) || []).length, 2); assert.equal((h.match(/Viewing/g) || []).length, 1);
  C.reduceRun(st, { type: 'session.waiting' });
  h = C.liveHtml(st);
  assert.match(h, /Page 1 of 2/); assert.match(h, /Page 2 of 2/); assert.match(h, /shots row/);
});
