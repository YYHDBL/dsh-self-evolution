# Milestone zero — stage B summary @ ddefc45 (B1–B5)

Date: 2026-09-19/20. All items below ran for real; per-item evidence is linked. UNVERIFIED items are listed explicitly and are not counted as passed.

## Completion definition vs. evidence (five milestone-zero items)

1. **Official web boots via the project launcher with the minimal control plugin loaded** — PASS.
   `scripts/start.mjs` boots the profile, health = bootId-scoped record with per-instance expected artifacts (drill 1: healthy boot, probe self-active, clean shutdown).
2. **A real session leaves a probe record verified through the official read-only handle** — PASS (stage A evidence: web E2E `WEB_E2E_OK`, probe seq 19 == handle).
3. **Persistent status marker; disappears when the plugin stops** — PASS (stage A: installed/removed/reinstalled browser-verified; refresh-survives in session view).
4. **Independent Harness process lets Flash in creator mode produce a standard candidate bundle, installed/run/stopped via Plugin Manager ONLY in a test profile** — PASS.
   B2: REAL creator run (budget-gated, session d226b497, reply DONE, 3/3 files, 20028 tokens); P3 conclusion: headless cannot compose agent presets, creator capability = `cordis-host-runner` + `tool-cordis` via the official patch layer (stub-captured request proves `cordis_inspect_list/query` present); installed only into `cand-test` in the isolated home; activation → line, disabled → no line, re-enabled → line; main baseline home snapshot unchanged. Budget stop-drill refused BEFORE any model call with the record kept.
5. **Frozen candidate re-verified in a clean instance across restart; startup and run failures recover via the external launcher** — PASS at the mechanism level.
   B4 drill matrix ALL 7: healthy boot; live-lock abort / dead-lock pre-spawn cleanup; corrupt control → empty managed set (paused, upload-off preserved); faulty TRIAL candidate → revoked (baseline untouched) → retry healthy; faulty FORMAL baseline → recovered (bad version quarantined) → retry healthy; forged old-bootId health ignored; unknown exit keeps unattributed diagnostics (exit 7).

Drills additionally proved: **attempt-limit stop** (budget stop-drill above) and **restricted file undo** (B5: owned file restored, user's later edit preserved, plugin-created file removed, missing-material/mixed-ownership skipped to human; unit tests cover vanished-file and plan-vs-apply race re-check; whole-workspace restore out of scope by design).

## Stage B engineering facts discovered (real defects found and fixed)

- vitest 4 fork pool hangs on multi-file runs here; root suspect: infinite pnpm `link:` symlink cycle under `packages/evolution-probe/node_modules`. Mitigation: `npm test` = sequential per-file runner (`scripts/run-tests.mjs`).
- Probe health treated async `pluginManager.listPlugins()` synchronously → plugins always judged inactive.
- Probe health aborted entirely on a corrupt control.json instead of reporting an empty expected set.
- Unreaped zombie pids answer `kill(pid,0)` as alive → lock "liveness" needs reaped processes (drill now awaits child exit).
- tsx runs scripts through a wrapper process chain: `pgrep` by port pattern kills the launcher itself; match the real child cmdline.

## UNVERIFIED (explicitly not passed, carried forward)

- Web-UI command channel to trigger the worker (file/CLI request channel implemented and drilled; the in-page command is not).
- Worker child-process subtree cleanup (skeleton spawns no children; recorded as design intent only).
- "Process alive but plugin faulty → pause affected tasks then prompt" (drill d) — partially covered by health-failure recovery; the in-process task-pause interaction is not exercised.
- Trial control (bindForTask) against LIVE sessions end-to-end — unit-tested (20-concurrent books exactly 5), not yet driven by a real web session (stage F work).
- Preset-composed creator session (cordis agent preset) — headless cannot compose presets (source-confirmed); capability path used instead; web-UI creator session remains for stage E.

## Cost summary (from evolution-private/costs.jsonl, provider-usage booked)

| Attempt | Calls | Total tokens | Notes |
|---|---|---|---|
| 2026-09-19 a2-real-ptc | 2 | 21,205 | A2 BASELINE_PTC_OK + A3 A3_REAL_OK |
| 2026-09-19 a3-web-e2e | 1 | 11,719 | web E2E WEB_E2E_OK |
| 2026-09-19 b2-create | 1 | 20,028 | REAL creator run (budget 3/150k, settled in limits) |
| b2-stopdrill | 0 | 0 | refused pre-call (by design) |
| **Total stage A+B real model spend** | **4** | **52,952** | all budget-gated, all booked |
