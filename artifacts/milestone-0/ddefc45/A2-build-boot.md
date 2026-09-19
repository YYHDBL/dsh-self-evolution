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

## Minimal real PTC session — PASS (completed after credentials were provided)

The user provided `DEEPSEEK_API_KEY` on 2026-09-19; it is configured through the official layered-env mechanism (`.env` in the project root and in the isolated `$DSH_HOME`, both gitignored, mode 600; `packages/boot/app-boot/src/index.ts:167-233` reads a project and a user `.env` layer). A budget was registered before the calls (`evolution-private/budgets/2026-09-19-a2-real-ptc.json`: callLimit 2, tokenLimit 80000) and settled after (2 calls, 21205 tokens total, within limits; costs booked in `evolution-private/costs.jsonl`).

- **A2 item** — profile `baseline-ptc` (headless template + upload-off patch, no self-evolution plugin), fresh workspace, real endpoint (no `DEEPSEEK_BASE_URL` override): model replied exactly `BASELINE_PTC_OK`.
  Session `session-db24a365-05a5-4110-a8f0-00c305b6c84d`, usage from the session log (`assistant/message.data.usage`): input 10583 / output 7 / cacheRead 0.
- **A3 completion** — profile `baseline-headless` (upload off + probe loaded), real endpoint: model replied exactly `A3_REAL_OK`; the probe appended `{"sessionId":"session-f05343c0-…","event":"turn/end","seq":17,…}` and the official read-only handle shows the same session at 18 events, seq `[0..17]`, exactly one `turn/end` — record and handle agree on a successful real turn.

Money is booked as `null` (no price version pinned yet; tokens recorded with `usageSource: provider`).
