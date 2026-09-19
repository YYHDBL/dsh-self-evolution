# Milestone Zero evidence

## Baseline session — passed after quota recovery

- Date: 2026-08-21 (Asia/Shanghai)
- Official Harness commit: `47f943859bef60e4160492346772ded9b24f765a`
- Workspace: `/Users/yyhdbl/Desktop/自进化harness项目`
- Web UI: `http://127.0.0.1:3080/`
- Agent preset: PTC
- Provider/model: `deepseek-official` / `deepseek-v4-flash`
- Session: `session-41e35adb-4e63-4602-b315-36a8be87bdf3`
- Session record: `/Users/yyhdbl/.dsh/sessions/--Users-yyhdbl-Desktop-~81EA~8FDB~5316harness~9879~76EE--/session-41e35adb-4e63-4602-b315-36a8be87bdf3/session.jsonl.zstd`

Observed record events:

```text
request/context  provider=deepseek-official model=deepseek-v4-flash
assistant/finish status=402 code=QUOTA message="Insufficient Balance"
turn/end        status=402 code=QUOTA message="Insufficient Balance"
```

The first turn proved that the Web UI created and persisted a real session but
was blocked by account quota. After the account balance was restored, the same
session was retried with reasoning disabled and the shortest useful prompt.

```text
request/context  provider=deepseek-official model=deepseek-v4-flash
assistant/message text="MILESTONE_ZERO_BASELINE_OK"
usage            input=12315 output=11 cache_read=0
turn/end         turn=2 reason=completed event_seq=41
```

Result: PASS. The fixed official Harness started independently, the official
Web UI used the selected workspace, DeepSeek-V4-Flash completed a real PTC turn,
and the compressed session record was readable from disk.

## Standard control plugin and real turn record — passed

Test-first evidence:

```text
RED   Cannot find module '../src/index.ts'
GREEN Test Files 1 passed; Tests 1 passed
```

The official `dsh plugin --profile web add link:...` command installed
`@self-evolving/evolution-probe`. The official configuration dump then
contained:

```text
id: evolution-probe
name: '@self-evolving/evolution-probe'
path: /Users/yyhdbl/Desktop/自进化harness项目/state/turns.jsonl
```

After a Web restart, a real PTC turn on the existing session completed with
DeepSeek-V4-Flash and reasoning disabled. The probe output contained exactly
one line:

```json
{"sessionId":"session-41e35adb-4e63-4602-b315-36a8be87bdf3","event":"turn/end","seq":56,"time":1787243355785}
```

The canonical compressed session log contains the matching `turn/end` at
sequence 56 and an `assistant/message` containing `OK`. Usage for this turn was
43 uncached input tokens, 12,288 cached input tokens, and 1 output token.

Result: PASS. The external standard plugin loaded without core changes,
observed the committed session event, wrote the required minimal identity and
position fields, and did not prevent the real session from completing.

## Persistent Web status — passed

A real DeepSeek-V4-Flash Creative-mode session used Client Inspect only. It
queried the live provider catalog and selected:

```text
conversation.composer.dock
kind=list scope=session replaceRisk=none
purpose=ambient readout about the conversation
```

The session did not define or run a dynamic plugin and did not modify files.
Its UI-reported usage was 54.8K total input tokens with 59% cache hits and 759
output tokens.

Test-first evidence for the standard client entry:

```text
RED   Failed to resolve ../src/client/index.ts
GREEN Test Files 2 passed; Tests 2 passed
```

The package reuses the official `clientBundle` build preset. The generated
artifact is 883 bytes and begins with the required
`window.__ModuleLoader__.load` registration. The official Web manifest served
the package with revision `235d0223eb4a` and both declared dependency edges.

Actual lifecycle checks:

```text
installed + refresh #1  role=status text="自进化：记录中"
installed + refresh #2  role=status text="自进化：记录中"
removed + restart       statusCount=0 textCount=0
reinstalled + restart   textCount=1
```

Result: PASS. The official page persistently shows text plus native semantic
emphasis while the plugin is loaded, and removes the marker with the plugin
lifecycle without replacing core UI.
