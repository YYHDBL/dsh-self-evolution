# A3 — probe adapted to ddefc45

Date: 2026-09-19. Result: **PASS on all credential-free acceptance items**; the one real-model-session gap is inherited from A2 (no `DEEPSEEK_API_KEY` on this machine) and is listed as pending, not simulated.

## Adaptation decisions (measured, with sources)

1. **Package shape switched to the official no-build minimal form.** The new `clientBundle` tsdown preset (`packages/client/tsdown.client.ts:83,361-372`) resolves plugin manifests only inside the vendor repository (`REPOSITORY_ROOT` derived from its own file URL, glob `packages/*/*/package.json`) — an external package cannot use it. The official Creator skill (`packages/preset/agent-presets/presets/cordis/skills/cordis-plugin-development/SKILL.md`) documents the sanctioned external path: plain `index.js` with named `apply`/`inject`, a hand-authored `client.js` registering a `window.__ModuleLoader__.load` factory (React via the browser module table), no build tool. The probe now ships exactly that form:
   - `packages/evolution-probe/index.js` — host plugin (unchanged logic: `session/event` → append one `turn/end` record)
   - `packages/evolution-probe/client.js` — client factory, `conversation.composer.dock`, `<strong role="status">自进化：记录中</strong>`
   - removed: `src/`, `lib/`, `tsdown.config.ts`, build script
   - deps: peer `@deepseek-ai/cordis 4.0.2`, `@deepseek-ai/dsh-session 0.1.6-alpha.2`; devDeps (tests only) link into `vendor/dsh-0.1.6`
   - root `package.json` vitest link now points at `vendor/dsh-0.1.6`
2. Client registration API is unchanged from the old probe's shape (`ctx.slots.inject` + `ctx.slots.register`), confirmed against `ui-conversation/src/client/skeleton/TodoPanel.tsx:133-139` and `ui-renderer/src/client/registry.ts:209`.

## Tests — PASS (3/3)

`npm test` → `Test Files 2 passed; Tests 3 passed`. Tests exercise the **shipped artifacts** (not sources): host append-exactly-one-record; a failing probe (relative config path) rejects without taking down the session context; client factory registers, renders the expected element, and unregisters on dispose.

## Real-session record + official handle read-back — PASS (no credentials needed)

Probe installed into isolated profile `baseline-headless` (`dsh plugin --profile baseline-headless add link:…`; pnpm provided via a temporary `corepack enable --install-directory /tmp/pnpm-shim` shim because pnpm is not on PATH). A real harness boot (headless, provider pointed at the local stub, dummy key — the turn fails at the stub's 401 by design) produced:

```text
state/turns.jsonl +1 record:
{"sessionId":"session-c7bc1c3f-…","event":"turn/end","seq":17,"time":1789809503508}
```

Official read-only handle comparison (`scripts/probe/v3-migration.mjs` against the isolated sessions root): same session = 18 events, seq `[0..17]`, exactly 1 `turn/end` — the probe's `seq 17` matches the official handle's last event position. The plugin did not prevent the (failing) turn from ending, and the app booted with the plugin loaded.

## Persistent status marker lifecycle — PASS (real browser DOM evidence)

Probe installed into `baseline-web`; verification through the real web UI in a browser (dismissed the first-run notice and the "Add an API key" dialog that appears because no key is configured):

| Step | Port | Evidence |
|---|---|---|
| installed + fresh boot | 4581 | client module served by the official roster (`/plugins/??…,@self-evolving/evolution-probe/client.js,…`); in the session view `getByText('自进化：记录中')` count=1 visible |
| removed + fresh boot | 4582 | marker count=0; served roster no longer contains the probe |
| reinstalled + fresh boot | 4583 | marker count=1 visible again |

Note: `conversation.composer.dock` renders in the session view (scope=session), not on the "New Session" preview — checked and recorded. An operator mistake during this sequence (one boot without `DSH_HOME` exported) failed fast against the default home and touched nothing there — kept as a process lesson, not an environment change.

## Gaps / carried items

- Real web-UI PTC session with a successful model turn: pending `DEEPSEEK_API_KEY` (same as A2). The record/handle verification above used a real boot whose turn failed at the local stub — honest, but not a successful model session.
- `dsh_plugin_packages` companion field observed in requests (A2) — flagged for owner decision on D-053 scope.
- pnpm PATH: temporary shim used; a durable arrangement (global `corepack enable` or wrapper in scripts) to be decided at ✦B.
