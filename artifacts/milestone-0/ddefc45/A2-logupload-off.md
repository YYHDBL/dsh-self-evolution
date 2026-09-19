# A2/P6 — companion session-log upload disabled and verified @ ddefc45

Date: 2026-09-19. Requirement D-053: the target profile must not attach `dsh_session_log` to requests; verified at config level and request level, without contacting any real endpoint.

## Config level — PASS

Profile `state/runtime/dsh-baseline/profiles/baseline-web/cordis.patch.yml`:

```yaml
- id: session-log-deepseek
  config:
    enabled: false
```

`dsh baseline-web --dump-config` (excerpt):

```text
- id: session-log-deepseek
  name: '@deepseek-ai/dsh-session-log-deepseek'
  config:
    enabled: false
```

(Default is `enabled: true` — `packages/session/session-log-deepseek/src/index.ts:45`.)

## Request level (local stub) — PASS, both directions

Stub: `scripts/probe/p6-logupload-stub.mjs` — local HTTP server recording full request bodies, always answering 401. Provider pointed at the stub via `DEEPSEEK_BASE_URL=http://127.0.0.1:4571` (override confirmed at `packages/llm/llm-deepseek/src/config.ts:110,292`) with a dummy `DEEPSEEK_API_KEY`. Each run is a real harness boot that composes and sends actual requests; turns fail at the stub's 401 by design.

| Run | Profile | Upload setting | Requests captured | containing `dsh_session_log` |
|---|---|---|---|---|
| verification | `baseline-headless` | patched `enabled: false` | 2 | **0** |
| positive control | `baseline-headless-ctrl` | default `enabled: true` | 2 | **2** |

The positive control proves the stub does capture the field when upload is on, so the absence in the verification run is meaningful, not a stub blind spot. Observed request shape (verification run): `POST /v1/messages`, fields `model,stream,messages,max_tokens,thinking,output_config,system,tools,dsh_plugin_packages`, model `deepseek-flash`.

Observations (not blockers, recorded): requests also carry `dsh_plugin_packages` (a plugin-package inventory field, not session log — out of D-053 scope, flagged for review); no real API endpoint was contacted; failed turns are expected outcomes and their session logs are real artifacts reused by A3.

## Budget note

No real API spend: both runs terminated at the local stub (401). No budget reservation required; nothing to book in `costs.jsonl` beyond future B1 tooling.
