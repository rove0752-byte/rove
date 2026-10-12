# Isolated Eve browser integration

Run from the repository root:

```sh
node scripts/verify-eve-browser.mjs
```

The runner verifies production `eve info --json` discovery, source ownership and
URL-only model schemas. It then creates a fresh temporary Eve project, copies
the three project-owned tool definitions and browser helper unchanged, and runs
an Eve eval through the HTTP/session runtime. All evidence and temporary Eve
state are retained at the printed path. No existing Eve state is removed.

Only the disposable fixture's policy module is replaced: it accepts exactly the
loopback origin chosen by the fixture server and rejects every other origin and
credential-bearing URL. Production policy is untouched. A deterministic Eve
mock model requests each real tool; tool results are not stubbed. An explicit
model context window avoids a Gateway metadata lookup. The fixture process does
not inherit provider credentials or deployment identities.

The eval requires completed calls to `browser__navigate`, `browser__snapshot`
and `inspect_page`; named accessible elements, disabled/hidden element behavior,
read-only mode and inspect evidence; and only GET requests to the fixture root.
No interactions are performed. Passing this fixture verifies deterministic Eve
dispatch, not a live provider model's tool selection or Rove's custom API channel.

The environment must permit loopback HTTP listeners and the already-installed
Chromium browser. A discovery-only pass or startup failure is not an invocation
pass. The runner exits nonzero on a failed eval and retains its output.
