# A2 — build & boot baseline @ ddefc45

Date: 2026-09-19 (Asia/Shanghai). Target: `ddefc45fbc7f8e46dd73185e68295696d1297887` (`0.1.6-alpha.2`), checkout `vendor/dsh-0.1.6` (clean, no local changes).

## Build idempotency — PASS

- `corepack pnpm install --frozen-lockfile`: `Already up to date`, `Done in 1.5s using pnpm v11.7.0` (the tree had been installed and built at 15:08–15:13 this day; this run re-verifies).
- `corepack pnpm build`: exit 0; final web stage `✓ built in 16.71s`, `build: recorded 248 client artifact(s) with 2 public value(s)`.

## P5 CLI probe — conclusions (measured, not assumed)

- `node apps/cli/lib/bin.js --help`:
  - `dsh web` / `dsh --profile <name>` boots a profile from `$DSH_HOME/profiles`.
  - `dsh <name> --from-default-profile <template>` initializes a new profile from a shipped template.
  - `dsh plugin --profile <name> <pnpm-args...>` manages profile packages (e.g. `add link:<path>`).
  - `--dump-config` / `--dump-default-config` print the composed profile tree and exit.
  - `dsh headless "…"` runs a one-shot headless task.
- Web app flags (`dsh --profile web --help`): `--host`, `--port` (0 = pick free), `--no-open`, `--trusted-host`.

## Isolated environment — created

`DSH_HOME=state/runtime/dsh-baseline` (inside project, gitignored). Profiles created from templates: `baseline-web` (web), `baseline-headless`, `baseline-headless-ctrl` (headless; ctrl has no upload-off patch, see A2-logupload-off.md). The old baseline home `~/.dsh` was not modified.

## Web boot smoke — PASS (no credentials required)

`dsh baseline-web --no-open --port 4580`:

```text
dsh web: http://127.0.0.1:4580/?token=…
process listening (lsof: node … TCP 127.0.0.1:4580 LISTEN)
curl /            → 401   (browser-trust auth fence, expected without token)
curl /?token=…    → 303   (redirect to app shell)
process stopped after check
```

## NOT done this round (honest gaps)

- **Minimal real PTC session with DeepSeek-V4-Flash: PENDING.** No `DEEPSEEK_API_KEY` is present on this machine (env empty; `~/.dsh` settings/storages contain no key; provider resolves keys via `apiKeyEnv`, default `DEEPSEEK_API_KEY` — `packages/llm/llm-deepseek/src/config.ts:13`). The stub-based request checks below are real request-level evidence for the upload-off requirement but are **not** a successful model session. Per instructions, no simulated result is recorded as passed acceptance.
