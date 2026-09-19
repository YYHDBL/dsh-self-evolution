# A2/V3 (+P1) — read-only migration of old-format logs @ ddefc45

Date: 2026-09-19 (revised same day after review). Script: `scripts/probe/v3-migration.mjs` (run with the vendored tsx: `./vendor/dsh-0.1.6/node_modules/.bin/tsx …`, because the old-side reference decodes through the backend's own TS frame decoder). Material: authorized copies of the two August sessions (old-baseline `47f9438` **V0 format**) under `state/runtime/migration-check/` (project/session hierarchy preserved).

## Review fix (2026-09-19 evening)

The first version judged PASS purely by "source tree unchanged" and passed vacuously on an empty directory. The rewrite reports **two separate verdicts** and fails empty inputs:

- **MIGRATION** — asserts listed sessions ≥ `--expect-old N` (default 1); per session: raw header version < 3 (actually old format), migrated `header.version === 3`, and `turn/end` events correspond one-to-one old↔new. Empty/short input → FAIL, exit 1.
- **READONLY** — full-tree sha256 before/after identical.
- Old-side references are decoded with the backend's own concatenated-frame zstd decoder (`scanZstdFrames`/`decompressZstdFrame` from `packages/session/session-persistence-jsonl/src/zstd.ts`) — the flat legacy file is a 15-frame zstd container that Node's single-frame `zstdDecompressSync` cannot read whole; no self-parsed format.

## Results — PASS (both verdicts)

```text
- session-41e35adb-…: old v0 49 events seq[0..57] turn/end=[17,41,56]
                     new v3 40 events seq[0..39] turn/end=[19,28,38]   (3↔3, mapped)
- session-59135bb7-…: old v0 83 events seq[0..726] turn/end=[725]
                     new v3 32 events seq[0..31] turn/end=[30]          (1↔1, mapped)
READONLY  : PASS (2 files hashed, before==after: true)
MIGRATION : PASS (listed 2 >= expected 2)
OVERALL   : PASS  (exit 0)
Empty-directory control run: MIGRATION FAIL, OVERALL FAIL, exit 1  (vacuous pass eliminated)
```

Key old↔new reference material (seq/time only, no message content) is committed at [A2-v3-mapping.json](./A2-v3-mapping.json). The mapping is direct quantitative evidence that migration renumbers seq (event consolidation: 49→40, 83→32; turn/end 725→30, 56→38) — old `sessionId+seq` cannot be reused across generations, supporting the `(sessionId, generation, seq)` dedupe key in the plan.

## P1 conclusions (interface facts for task C1) — unchanged

- Backend boots standalone in a bare Cordis `Context`: `ctx.plugin(JsonlSessionPersistence, { root })` (default export; `Config.root` required, no default); accessor `ctx.sessionPersistence`; session id at `meta.header.id`; `open(id,'read')` → `handle.read()` → `close()`.
- Root layout `<root>/<project-dir>/<session-dir>/…`; flat session-dir copies are rejected with an explicit error (kept as first-run evidence). `EVO_SESSIONS_ROOT` must point at the sessions root containing project directories.
