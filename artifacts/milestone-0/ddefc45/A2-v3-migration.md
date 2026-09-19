# A2/V3 (+P1) — read-only migration of old-format logs @ ddefc45

Date: 2026-09-19. Script: `scripts/probe/v3-migration.mjs`. Material: authorized copies of the two August sessions (old baseline `47f9438` format) under `state/runtime/migration-check/` (project/session hierarchy preserved). Result: **PASS**.

## P1 conclusions (interface facts for task C1)

- The official backend boots standalone in a bare Cordis `Context`: `ctx.plugin(JsonlSessionPersistence, { root })` (default export of `@deepseek-ai/dsh-session-persistence-jsonl`; `Config.root` required, no default), service accessor `ctx.sessionPersistence` available after load.
- **Root layout**: `<root>/<project-dir>/<session-dir>/…`. A flat copy (session dirs directly under root) is rejected with an explicit error ("unsupported flat-file layout; use a separate root or move it into a project/session directory") — first-run error kept as evidence. Therefore `EVO_SESSIONS_ROOT` must point at the sessions root that contains project directories (e.g. `$DSH_HOME/sessions`).
- `list()` returns storage metadata; the session id lives at `meta.header.id` (pass that string to `open`). `open(id, 'read')` → `handle.read()` (no args = all events) → `close()`.

## V3 migration evidence

Both old-format sessions open read-only and present the **V3 in-memory view**:

```text
listed sessions: 2
- session-41e35adb-…: events=40 seq=[0..39] system/message=true
- session-59135bb7-…: events=32 seq=[0..31] system/message=true
```

- `header.version = 3` on the migrated view; `system/message` events are present — the V2→V3 migration (system-prompt insertion, seq renumbering) ran in memory, exactly the upstream-documented behavior.
- Renumbered seq ranges recorded; old raw seq from the August evidence (e.g. turn/end at seq 56 in the old view) does not map 1:1 to the migrated view — concrete support for the `(sessionId, generation, seq)` dedupe key.

## Read-only proof

- `sha256` of both source files hashed before and after the full read pass: identical (`source files unchanged: true`, 2 files).
- No write handle was opened; script only calls `open(id, 'read')`.

## Reuse

The failed-turn stub sessions from A2/P6 also created real V3 logs under the isolated `DSH_HOME` (workspace `ws-a`/`ws-b`) — reused by A3 for probe verification.
