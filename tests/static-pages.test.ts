import { test } from 'node:test';
import assert from 'node:assert/strict';
import home from '../agent/channels/home.ts';
import { HOME_PAGE_HTML } from '../agent/lib/home-page.ts';

const PATHS = ['/privacy', '/terms', '/pricing', '/support', '/status', '/refund'];

async function get(path: string): Promise<Response> {
  const route = home.routes.find(r => r.method === 'GET' && r.path === path);
  assert.ok(route, `route ${path} exists`);
  return (route as any).handler(new Request(`https://rove.test${path}`), {});
}

for (const path of PATHS) {
  test(`GET ${path} returns 200 HTML with draft placeholders and footer`, async () => {
    const res = await get(path);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
    const html = await res.text();
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /\[PLACEHOLDER: [^\]]+\]/);
    for (const link of PATHS) assert.ok(html.includes(`href="${link}"`), `${path} links to ${link}`);
  });
}

test('legal pages flag the required placeholders', async () => {
  const text = (await Promise.all(PATHS.map(async p => (await get(p)).text()))).join('\n');
  for (const needle of ['price', 'refund policy', 'support email', 'data retention', 'legal entity name', 'jurisdiction']) {
    assert.ok(text.includes(`[PLACEHOLDER: ${needle}`) || new RegExp(`\\[PLACEHOLDER: [^\\]]*${needle}`).test(text), needle);
  }
});

test('home page has footer links and checkout success/cancelled banner', () => {
  for (const link of PATHS) assert.ok(HOME_PAGE_HTML.includes(`href="${link}"`), link);
  assert.match(HOME_PAGE_HTML, /id="checkout-banner"/);
  assert.match(HOME_PAGE_HTML, /q\.get\('success'\)==='true'/);
  assert.match(HOME_PAGE_HTML, /q\.get\('canceled'\)==='true'/);
});
