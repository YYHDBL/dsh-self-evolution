# Milestone zero — stage B summary @ ddefc45 (B1–B5)

> **Status after audit round 2 (2026-09-20): CONDITIONAL PASS.** The first
> version of this summary overstated completion; the audit found eight real
> gaps (recovery not enforced at runtime, wrong health-check fields, revoked
> candidates reusable by old tasks, budget overruns unbooked, worker spawn
> broken, env allowlist violated, undo concurrency window, overstated test
> names). All eight are fixed; the drill matrix was upgraded to prove ENFORCEMENT
> (bad plugin actually stops loading; old artifact actually takes effect).
> Stage-B requirements still not exercised end-to-end remain in UNVERIFIED.

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

## Audit round 2 — fixes and what they changed (2026-09-20)

1. **Recovery now ENFORCES the runtime.** `start.mjs` writes an official `--patch` overlay (`recovery-disable.yml`): a revoked trial candidate and quarantined baseline artifacts are disabled rows at the retry boot — the bad plugin genuinely stops loading, not merely leaving the checklist. Drill 4 asserts the overlay contains the candidate; drill 5 asserts the recovered OLD artifact actually runs (its marker file gains a line from the retry boot). Corrupt-control empty-set limitation recorded honestly: with an unparseable file the managed ids are unknowable, so nothing is force-disabled.
2. **Health check uses the real `PluginInfo` fields** (`entryId`/`moduleName`/`enabled`/`fiberPhase`). A readiness gate defers the first health publish while `pluginManager` is still starting — before this fix the launcher could wrongly quarantine a healthy plugin on a transient (reproduced standalone, then fixed and re-verified: `pluginManager:enabled=true,fiberPhase=active`).
3. **`bindForTask` checks effectiveness BEFORE reuse**: a revoked or digest-changed trial never serves a candidate binding, even to an already-enrolled task (the audit's reproduction now returns baseline). Normal expiry still lets enrolled tasks finish their bound version. A defined condition (e.g. `preset`) no longer defaults-satisfies when the caller omits the dimension.
4. **Budget overruns are booked** (estimate 100 / actual 900 → ledger 900, not 100); breaching the token limit closes the hard gate. The B2 creator run now SUMS usage over all assistant messages (tool-loop rounds) and counts messages+attempts as calls; a wall-clock timeout SIGKILLs the child — proven by a REAL slow-stub drill (killed at 8006 ms against a 30 s stub, budget stopped as timeout).
5. **Worker spawn chain fixed and integrated**: correct path (three dirnames), the request file is consumed by the WORKER (not pre-deleted by the probe), new-requestId dedup, a missing script logs loudly, and the launcher SIGTERMs the worker on shutdown. Drill 8 runs the whole chain: web hold → request file → worker running → launcher stop → worker cleaned.
6. **Env allowlists everywhere**: the candidate probe and launcher children no longer inherit `process.env`; the isolated home's `.env` carries ONLY the model credential. (No container claimed — same-host limits still apply.)
7. **Undo requires `writersStopped`**: without the confirmed-stopped precondition every entry goes to the human (refusal tested and drilled); hash re-checks narrow the window but concurrent-write safety is NOT claimed.
8. **Test names de-overstated** (same-process interleaving vs cross-process O_EXCL; no "crash injection" claims).

## Final drill matrix result (audit round 2 close-out, 2026-09-20)

ALL 9 DRILLS PASS: 1 healthy boot · 1b good managed plugin (`fiberPhase=active` + marker) · 2 locks (live abort / dead clean) · 3 corrupt-control empty-set (paused, upload-off preserved) · 4 revoke-trial (baseline untouched, disable row in profile patch) · 5 recover-baseline (**exit 0**: quarantined, old artifact actually in effect, marker×2 from the retry boot) · 6 forged health ignored · 7 unknown exit unattributed · 8 worker full chain (probe-spawned, launcher-cleaned).

**Upstream fact worth reporting (pm-availability-check triple)**: booting the web profile with a `--patch` overlay containing a `disabled: true` row prevents the `pluginManager` service from starting in this deployment (ddefc45), while the same disable row in the profile's own patch layer does not. Recovery therefore writes disable rows into the profile patch layer (the launcher-owned profile), never via `--patch`.

## Stage B engineering facts discovered (rounds 1+2)

- vitest 4 fork pool hangs on multi-file runs here; root suspect: infinite pnpm `link:` symlink cycle under `packages/evolution-probe/node_modules`. Mitigation: `npm test` = sequential per-file runner (`scripts/run-tests.mjs`).
- Probe health treated async `pluginManager.listPlugins()` synchronously → plugins always judged inactive.
- Probe health aborted entirely on a corrupt control.json instead of reporting an empty expected set.
- Unreaped zombie pids answer `kill(pid,0)` as alive → lock "liveness" needs reaped processes (drill now awaits child exit).
- tsx runs scripts through a wrapper process chain: `pgrep` by port pattern kills the launcher itself; match the real child cmdline.

## UNVERIFIED (explicitly not passed, carried forward after round 2)

- Web-UI command channel to trigger the worker (the file/CLI request channel IS implemented, spawned from inside the live probe and cleaned by the launcher — drill 8; only the in-page command surface is missing).
- Worker child-process subtree cleanup (the worker skeleton spawns no children; the launcher→worker SIGTERM path is drilled, deeper subtrees are not).
- "Process alive but plugin faulty → pause affected tasks then prompt" — the runtime heartbeat monitor now STOPS the child on a stale heartbeat (unattributed record), but the in-process task-pause interaction is not exercised.
- Trial binding driven by LIVE web sessions end-to-end — unit-level semantics verified (revocation blocks reuse; same-process interleaving books exactly 5; cross-process exclusion is O_EXCL); a real session-driven trial run is stage F work.
- Preset-composed creator session (cordis agent preset) — headless cannot compose presets (source-confirmed); capability path used instead; web-UI creator session remains for stage E.
- Recovery drills 4/4b/5/8 of the upgraded matrix — see the drill log for the authoritative per-case verdicts of the latest run.

## Cost summary (from evolution-private/costs.jsonl, provider-usage booked)

| Attempt | Calls | Total tokens | Notes |
|---|---|---|---|
| 2026-09-19 a2-real-ptc | 2 | 21,205 | A2 BASELINE_PTC_OK + A3 A3_REAL_OK |
| 2026-09-19 a3-web-e2e | 1 | 11,719 | web E2E WEB_E2E_OK |
| 2026-09-19 b2-create | 1 | 20,028 | REAL creator run (budget 3/150k, settled in limits) |
| b2-stopdrill | 0 | 0 | refused pre-call (by design) |
| **Total stage A+B real model spend** | **4** | **52,952** | all budget-gated, all booked |
