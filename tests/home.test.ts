import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import home, { homeResponse } from '../agent/channels/home.ts';
import { HOME_PAGE_HTML } from '../agent/lib/home-page.ts';

const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('inlined home page matches public/index.html byte-for-byte', () => {
  assert.equal(Buffer.compare(Buffer.from(HOME_PAGE_HTML, 'utf8'), Buffer.from(indexHtml, 'utf8')), 0);
});

test('GET / returns the home page even when cwd has no public/ directory', async () => {
  const previous = process.cwd();
  const empty = mkdtempSync(join(tmpdir(), 'rove-home-'));
  try {
    process.chdir(empty);
    const route = home.routes.find(r => r.method === 'GET' && r.path === '/');
    assert.ok(route);
    const res: Response = await (route as any).handler(new Request('https://rove.test/'), {});
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
    assert.equal(await res.text(), indexHtml);
  } finally {
    process.chdir(previous);
    rmSync(empty, { recursive: true, force: true });
  }
});

test('home page falls back to a minimal 503 page if rendering fails', async () => {
  const original = console.error;
  console.error = () => {};
  try {
    const res = homeResponse(() => { throw new Error('boom'); });
    assert.equal(res.status, 503);
    assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
    assert.match(await res.text(), /temporarily unavailable/);
  } finally {
    console.error = original;
  }
});
