// Isolated Eve HTTP/session integration: real project tools and browser, deterministic model.
// No project agent, production policy, dependencies or existing Eve state are modified.
import { mkdtemp, mkdir, readFile, writeFile, copyFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixture = await mkdtemp(join(tmpdir(), 'rove-eve-browser-'));
console.log(`Isolated fixture: ${fixture}`);
for (const dir of ['agent/lib', 'agent/tools', 'agent/channels', 'evals']) {
  await mkdir(join(fixture, dir), { recursive: true });
}
await symlink(join(root, 'node_modules'), join(fixture, 'node_modules'), 'dir');
await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: 'rove-eve-browser-fixture', type: 'module', dependencies: { eve: '^0.75.1' } }));
for (const name of ['browser__navigate', 'browser__snapshot', 'inspect_page']) {
  await copyFile(join(root, `agent/tools/${name}.ts`), join(fixture, `agent/tools/${name}.ts`));
}
await copyFile(join(root, 'agent/lib/browser.ts'), join(fixture, 'agent/lib/browser.ts'));
// Only this disposable copy substitutes URL validation, denying everything except the
// exact ephemeral local fixture origin. The browser helper and tool definitions are unchanged.
await writeFile(join(fixture, 'agent/lib/policy.ts'), `
import { readFile } from 'node:fs/promises';
export async function validateUrl(raw: string) {
  const origin = JSON.parse(await readFile(${JSON.stringify(join(fixture, 'fixture-origin.json'))}, 'utf8'));
  const url = new URL(raw);
  if (url.origin !== origin || url.username || url.password || url.hostname !== '127.0.0.1') {
    throw new Error('Isolated fixture only: target blocked');
  }
  return url;
}
`);
await writeFile(join(fixture, 'agent/instructions.md'), 'Exercise only the requested read-only fixture tool.');
await writeFile(join(fixture, 'agent/channels/eve.ts'), `
import { eveChannel } from 'eve/channels/eve';
import { localDev } from 'eve/channels/auth';
export default eveChannel({ auth: [localDev()] });
`);
for (const [source, target] of [['agent.ts', 'agent/agent.ts'], ['evals.config.ts', 'evals/evals.config.ts'], ['browser.eval.ts', 'evals/browser.eval.ts']]) {
  await copyFile(join(root, 'tests/fixtures/eve-browser', source), join(fixture, target));
}
const cli = join(root, 'node_modules/eve/bin/eve.js');
// Do not inherit provider credentials, proxy settings or deployment identities.
const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'SYSTEMROOT'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
const run = args => spawnSync(process.execPath, [cli, ...args], { cwd: fixture, env,
  encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
const production = spawnSync(process.execPath, [cli, 'info', '--json'], {
  cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
});
await writeFile(join(fixture, 'production-discovery.json'), production.stdout);
if (production.status !== 0) throw new Error(production.stderr || 'Production discovery failed');
const productionInfo = JSON.parse(production.stdout);
assert.equal(productionInfo.status, 'ready');
assert.deepEqual(productionInfo.tools, ['browser__navigate', 'browser__snapshot', 'inspect_page']);
const manifest = JSON.parse(await readFile(productionInfo.artifacts.compiledManifest, 'utf8'));
for (const name of productionInfo.tools) {
  const binding = manifest.bindings[`tools/${name}.ts`];
  assert.equal(binding.owner.kind, 'application');
  assert.equal(binding.backing.sourcePath, join(root, `agent/tools/${name}.ts`));
  const schema = productionInfo.toolInputSchemas.root[name];
  assert.deepEqual(Object.keys(schema.properties), ['url']);
  assert.equal(schema.additionalProperties, false);
}
console.log('Production discovery: all three tools are application-owned and URL-only.');
const discovery = run(['info', '--json']);
await writeFile(join(fixture, 'discovery.json'), discovery.stdout);
if (discovery.status !== 0) throw new Error(discovery.stderr || discovery.error?.message || 'Discovery failed');
const info = JSON.parse(discovery.stdout);
assert.equal(info.status, 'ready');
assert.deepEqual(info.tools, ['browser__navigate', 'browser__snapshot', 'inspect_page']);
console.log(JSON.stringify({ status: info.status, tools: info.tools, diagnostics: info.diagnostics }));
const result = run(['eval', 'browser', '--json', '--timeout', '90000', '--max-concurrency', '1', '--skip-report']);
await writeFile(join(fixture, 'eval-output.log'), result.stdout + result.stderr);
console.log(result.stdout);
console.error(result.stderr);
if (result.error) console.error(result.error.message);
console.log(`Evidence retained at ${fixture}`);
process.exitCode = result.status ?? 1;
