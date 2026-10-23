import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateUrl, errorBody, HostNotAllowedError } from '../agent/lib/policy.ts';

// Exercise the exact client code shipped in public/index.html.
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const src = html.slice(html.indexOf('/*hints*/'), html.indexOf('/*/hints*/'));
const { typoFix, runError } = new Function(src + '\nreturn { typoFix, runError };')() as {
  typoFix: (h: string) => string | null; runError: (d: unknown) => string;
};

test('typo detector suggests the intended TLD', () => {
  const cases: Record<string, string> = {
    'example.con': 'example.com', 'example.cmo': 'example.com', 'example.ocm': 'example.com',
    'example.co.m': 'example.com', 'example.comm': 'example.com', 'Example.CON': 'example.com',
    'example.ner': 'example.net', 'example.og': 'example.org', 'example.orgg': 'example.org',
    'shop.example.con': 'shop.example.com',
  };
  for (const [typo, fix] of Object.entries(cases)) assert.equal(typoFix(typo), fix, typo);
  for (const ok of ['example.com', 'example.org', 'example.net', 'example.co.uk', 'example.io', 'localhost', 'example.constructor'])
    assert.equal(typoFix(ok), null, ok);
});

test('host_not_allowed maps to a calm message; other errors pass through', () => {
  assert.equal(runError({ code: 'host_not_allowed', host: 'example.con', error: 'x' }),
    "Rove can't open example.con yet. During the preview, it only works on a small set of approved sites — try example.com.");
  assert.equal(runError({ error: 'Boom' }), 'Boom');
  assert.equal(runError({}), 'Run failed');
});

test('server rejects non-allowlisted hosts with a structured code before any DNS/network', async () => {
  await assert.rejects(validateUrl('https://example.con/', 'example.com'), (e: unknown) => {
    assert.ok(e instanceof HostNotAllowedError);
    assert.deepEqual(errorBody(e, 'f'), { error: 'This hostname is outside the configured allowlist.', code: 'host_not_allowed', host: 'example.con' });
    return true;
  });
  assert.deepEqual(errorBody(new Error('Other'), 'f'), { error: 'Other' });
});
