import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const src = html.slice(html.indexOf('/*chat*/'), html.indexOf('/*/chat*/'));
type St = { site: string; steps: { k: string; s: string }[]; pages: { url: string }[]; answer: any; error: string | null; done: boolean };
const C = new Function(src + '\nreturn { esc, md, safeUrl, newRun, reduceRun, stepsHtml, answerHtml, inspectHtml, parseAnswer };')() as {
  esc(v: unknown): string; md(s: string): string; safeUrl(u: string): string | null; newRun(u: string): St;
  reduceRun(st: St, ev: unknown): St; stepsHtml(st: St): string; answerHtml(st: St, ms: number | null): string;
  inspectHtml(d: unknown): string; parseAnswer(t: string): any;
};
const states = (st: St) => st.steps.map(s => s.s).join(',');
const finalMsg = JSON.stringify({ status: 'completed', summary: 'Example Domain is for **documentation**.', data: { title: 'Example Domain', url: 'https://example.com/' },
  evidence: [{ URL: 'https://example.com/', 'relevant excerpt': 'This domain is for use in documentation examples.' }], limitations: [] });

test('event → step mapping follows the run', () => {
  const st = C.newRun('https://www.example.com/');
  assert.equal(st.site, 'example.com');
  C.reduceRun(st, { type: 'session.started', data: {} }); assert.equal(states(st), 'active,pending,pending,pending');
  C.reduceRun(st, { type: 'actions.requested', data: { actions: [{ toolName: 'inspect_page', input: { url: 'https://example.com' } }] } });
  assert.equal(states(st), 'active,pending,pending,pending');
  C.reduceRun(st, { type: 'action.result', data: { result: { output: { url: 'https://example.com/', title: 'Example Domain' } } } });
  assert.equal(states(st), 'done,active,pending,pending');
  C.reduceRun(st, { type: 'step.started', data: { stepIndex: 1 } }); assert.equal(states(st), 'done,done,active,pending');
  C.reduceRun(st, { type: 'message.completed', data: { message: finalMsg } });
  assert.equal(st.answer.sources.length, 1);
  C.reduceRun(st, { type: 'session.waiting', data: {} }); assert.equal(states(st), 'done,done,done,done'); assert.equal(st.done, true);
  assert.equal(st.pages.length, 1);
  const h = C.stepsHtml(st);
  assert.match(h, /Opening example\.com/); assert.match(h, /Reading the page/); assert.match(h, /Writing your answer/); assert.match(h, /Done/);
  assert.doesNotMatch(h, /[{}]/);
});

test('failure events mark the active step and capture a readable error', () => {
  const st = C.newRun('https://example.com');
  C.reduceRun(st, { type: 'session.started' });
  C.reduceRun(st, { type: 'turn.failed', data: { error: { message: 'Gateway timeout' } } });
  assert.equal(st.steps[0].s, 'error'); assert.equal(st.error, 'Gateway timeout'); assert.equal(st.done, true);
});

test('answer renders formatted text, sources and summary — never raw JSON', () => {
  const st = C.newRun('https://example.com');
  for (const ev of [{ type: 'action.result', data: { result: { output: { url: 'https://example.com/' } } } }, { type: 'message.completed', data: { message: finalMsg } }, { type: 'turn.completed' }]) C.reduceRun(st, ev);
  const h = C.answerHtml(st, 8400);
  assert.match(h, /<strong>documentation<\/strong>/);
  assert.match(h, /Sources/); assert.match(h, /<blockquote>This domain is for use in documentation examples\.<\/blockquote>/);
  assert.match(h, /Visited 1 page on example\.com · 8s/);
  assert.doesNotMatch(h, /"status"|evidence|\{"/);
});

test('safe rendering: HTML in answers, sources and page data is escaped; only http(s) links', () => {
  const x = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  assert.equal(C.md(x).includes('<img'), false); assert.equal(C.md(x).includes('<script'), false);
  assert.equal(/href/.test(C.md('[click](javascript:alert(1))')), false);
  assert.match(C.md('[ok](https://example.com/?a=1&b=2)'), /href="https:\/\/example\.com\/\?a=1&amp;b=2"/);
  assert.match(C.md('[q](https://e.com/"onmouseover="x)'), /href="https:\/\/e\.com\/%22onmouseover=%22x"/);
  assert.match(C.md('- one\n- two\n# Head'), /<ul><li>one<\/li><li>two<\/li><\/ul><h4>Head<\/h4>/);
  assert.equal(C.esc(`"'&<>`), '&quot;&#39;&amp;&lt;&gt;');
  const st = C.newRun('https://example.com');
  C.reduceRun(st, { type: 'message.completed', data: { message: JSON.stringify({ summary: x, evidence: [{ URL: 'javascript:alert(1)', 'relevant excerpt': x }] }) } });
  const h = C.answerHtml(st, null);
  assert.equal(/<img|<script|javascript:/.test(h), false);
  const ih = C.inspectHtml({ title: x, url: 'https://example.com/', httpStatus: 200, text: x, links: [{ text: x, url: 'javascript:alert(1)' }, { text: 'More', url: 'https://iana.org/' }] });
  assert.equal(/<img|<script|javascript:/.test(ih), false);
  assert.match(ih, /2 links/); assert.match(ih, /href="https:\/\/iana\.org\/"/);
  assert.equal(C.parseAnswer('plain text answer').text, 'plain text answer');
});

test('page has chat view, docked follow-up, New chat, no raw stream dump', () => {
  assert.match(html, /id="thread"/); assert.match(html, /id="followform"/); assert.match(html, /id="newchat"/);
  assert.match(html, /history\.pushState/);
  assert.doesNotMatch(html, /Inspect the events for the final answer/);
  assert.doesNotMatch(html, /api[ -]?key/i);
});
