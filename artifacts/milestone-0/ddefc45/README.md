# Milestone Zero evidence — target baseline ddefc45

Index of acceptance evidence for target commit `ddefc45fbc7f8e46dd73185e68295696d1297887`
(`0.1.6-alpha.2`). The August records in [../README.md](../README.md) remain the
historical evidence for the old baseline `47f9438` and are not reused here.

Status legend: **PASS** = verified by actual runs recorded in the linked evidence;
**UNVERIFIED** = explicitly not yet tested (never recorded as passed).

| Task | Evidence | Status |
|---|---|---|
| A1 repo baseline | commit history of this repository | PASS (a2ce83d) |
| A2 build & boot baseline | `A2-build-boot.md` | PASS — build idempotency, CLI probe, web boot smoke, real minimal session `BASELINE_PTC_OK` |
| A2/P6 upload-off | `A2-logupload-off.md` | PASS — config level + request level (verification 0/2, positive control 2/2) |
| A2/V3 migration + P1 | `A2-v3-migration.md`, `A2-v3-mapping.json` | PASS — old V0 samples asserted (49/83 events), migrated view v3, turn/end mapped old↔new (17/41/56→19/28/38; 725→30), readonly tree-hash proof; empty-dir control FAILs as required |
| A3 probe adaptation | `A3-probe-adaptation.md` | PASS — tests 4/4 (incl. record-write-failure isolation), real headless turn record matches handle (seq 17), marker lifecycle installed/removed/reinstalled, **web E2E**: real task `WEB_E2E_OK` + probe record seq 19 == official handle turn/end + marker survives reload |
| B1 control state / lock / costs / budgets | commit b56af8e + 18 tests | PASS — incl. 20-concurrent bind books exactly 5; recover-baseline quarantine; stale-lock refusal |
| Candidate probe via creator mode (milestone-zero item 4) | `B1-B5-summary.md` §4; commit 2c02129 | PASS — REAL creator run (budget-gated), isolated install/lifecycle verified, main env untouched, stop-drill refuses pre-call |
| Frozen-candidate re-verification + launcher recovery (item 5) | `B1-B5-summary.md` §5; commit 786d735 | PASS (mechanism level) — B4 drill matrix ALL 7 |
| Budget-stop and file-undo drills | `B5-undo-drill.json`; commits 2c02129/786d735 | PASS — budget stop refuses pre-call; undo restores owned files, preserves user edits, skips unclear ones |
| Milestone-zero stage summary | `B1-B5-summary.md` | compiled — with explicit UNVERIFIED list (web-command channel, worker subtree cleanup, in-process task pause, live-session trial binding, preset-composed creator) |

Carried items: `dsh_plugin_packages` companion field scope (owner decision); durable pnpm PATH arrangement (✦B).

Rules: every record states what actually ran and what did not; simulated or
partial results are never recorded as passed acceptance.
