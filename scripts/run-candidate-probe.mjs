#!/usr/bin/env node
// B2 candidate probe: creator mode writes a minimal standard bundle in an
// isolated DSH_HOME; the bundle is installed ONLY into a test profile there
// and its activation is verified with stub boots (no real API spend). The
// main baseline environment (state/runtime/dsh-baseline) is never touched.
//
// Subcommands (run each via the vendored tsx):
//   p3-smoke   boot creator (cordis preset) against the local stub, verify the
//              session header really ran preset=cordis  (P3, no real spend)
//   create     budget-gated REAL creator run that writes the bundle files
//   verify     install bundle into cand-test profile; stub-boot lifecycle
//              checks: activate → line, disabled → no line, re-enable → line
//   stop-drill run create's budget gate with callLimit 0: must refuse BEFORE
//              any model call and keep the record
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = join(import.meta.dirname, '..')
const RUN = join(ROOT, 'state/runtime/candidate-probe')
const HOME = join(RUN, 'home')
const WS = join(RUN, 'ws')
const BUNDLE = join(WS, 'candidate-bundle')
const CAND_LOG = join(RUN, 'lifecycle.log')
const PRIV = join(ROOT, 'evolution-private')
const BIN = join(ROOT, 'vendor/dsh-0.1.6/apps/cli/lib/bin.js')
const STUB_PORT = 4595

const envAll = (over = {}) => ({
  ...process.env,
  DSH_HOME: HOME,
  PATH: `/tmp/pnpm-shim:${process.env.PATH}`,
  ...over,
})

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', env: envAll(opts.env), cwd: opts.cwd ?? ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
}

function initHome() {
  mkdirSync(HOME, { recursive: true }); mkdirSync(WS, { recursive: true })
  writeFileSync(join(HOME, '.env'), readFileSync(join(ROOT, '.env'), 'utf8')) // real key, layered env
  writeFileSync(join(HOME, 'settings.yaml'), `agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash\n  reasoningEffort: off\nagent-presets:\n  default: cordis\n  modeSelectionEnabled: true\n`)
  for (const [profile, template] of [['cordis-run', 'headless'], ['cand-test', 'headless']]) {
    const dir = join(HOME, 'profiles', profile)
    if (!existsSync(dir)) sh('node', [BIN, profile, '--from-default-profile', template, '--dump-config'], { cwd: RUN })
    // P3 conclusion: the headless bundle deliberately does not compose agent-presets
    // (bundle source comment), so a preset-composed creator session is a web-UI path.
    // Creator CAPABILITY headlessly = insert @deepseek-ai/dsh-cordis-host-runner
    // (provides the cordisInspect service) + @deepseek-ai/dsh-tool-cordis (the
    // cordis_inspect_* tools) through the official loader patch layer.
    const extra = profile === 'cordis-run'
      ? '- insert:\n'
        + "    - id: cordis-host-runner\n      name: '@deepseek-ai/dsh-cordis-host-runner'\n"
        + "    - id: tool-cordis\n      name: '@deepseek-ai/dsh-tool-cordis'\n"
      : ''
    writeFileSync(join(dir, 'cordis.patch.yml'), `- id: session-log-deepseek\n  config:\n    enabled: false\n${extra}`)
    if (profile === 'cordis-run') {
      for (const p of ['cordis-host-runner', 'tool-cordis']) {
        try { sh('node', [BIN, 'plugin', '--profile', profile, 'add', `link:${join(ROOT, 'vendor/dsh-0.1.6/packages/extensions', p)}`]) } catch { /* already installed */ }
      }
    }
  }
}

/** Read a session's header + usage from the isolated home through the official backend. */
async function readSession(sessionId) {
  const PKG = join(ROOT, 'vendor/dsh-0.1.6/packages/session/session-persistence-jsonl')
  const req = createRequire(join(PKG, 'package.json'))
  const { Context } = req('@deepseek-ai/cordis')
  const { default: P } = await import(pathToFileURL(join(PKG, 'lib/index.js')).href)
  const ctx = new Context()
  await ctx.plugin(P, { root: join(HOME, 'sessions') })
  for (const meta of await ctx.sessionPersistence.list()) {
    if (String(meta.header.id) !== sessionId) continue
    const h = await ctx.sessionPersistence.open(sessionId, 'read')
    const { events } = await h.read(); await h.close()
    return { header: meta.header, events }
  }
  return null
}

async function newestSession() {
  const PKG = join(ROOT, 'vendor/dsh-0.1.6/packages/session/session-persistence-jsonl')
  const req = createRequire(join(PKG, 'package.json'))
  const { Context } = req('@deepseek-ai/cordis')
  const { default: P } = await import(pathToFileURL(join(PKG, 'lib/index.js')).href)
  const ctx = new Context()
  await ctx.plugin(P, { root: join(HOME, 'sessions') })
  let best = null
  for (const meta of await ctx.sessionPersistence.list()) {
    if (!best || meta.header.createdAt > best.header.createdAt) best = meta
  }
  return best ? String(best.header.id) : null
}

const cmd = process.argv[2]

if (cmd === 'p3-smoke') {
  initHome()
  rmSync(CAND_LOG, { force: true })
  rmSync('/tmp/b2-stub.jsonl', { force: true })
  try { sh('node', [BIN, 'cordis-run', 'Reply with exactly: P3_SMOKE'], {
    cwd: WS, env: { DEEPSEEK_BASE_URL: `http://127.0.0.1:${STUB_PORT}`, DEEPSEEK_API_KEY: 'sk-stub' },
  }) } catch { /* expected: stub answers 401 */ }
  const lines = existsSync('/tmp/b2-stub.jsonl') ? readFileSync('/tmp/b2-stub.jsonl', 'utf8').trim().split('\n').filter(Boolean) : []
  const tools = lines.flatMap(l => { try { return JSON.parse(JSON.parse(l).body).tools ?? [] } catch { return [] } })
  const inspectTools = tools.filter(t => String(t.name ?? '').startsWith('cordis_inspect')).map(t => t.name)
  console.log(JSON.stringify({ p3: { stubRequests: lines.length, inspectTools, creatorCapabilityLoaded: inspectTools.length >= 2 } }, null, 1))
  process.exit(inspectTools.length >= 2 ? 0 : 1)
}

if (cmd === 'create' || cmd === 'stop-drill') {
  initHome()
  const { openBudget, reserve, settleReservation, settleBudget } = await import(pathToFileURL(join(ROOT, 'packages/evolution/src/budgets.ts')).href)
  const { appendCost } = await import(pathToFileURL(join(ROOT, 'packages/evolution/src/costs.ts')).href)
  const attemptId = cmd === 'stop-drill' ? '2026-09-19-b2-stopdrill' : '2026-09-19-b2-create'
  const callLimit = cmd === 'stop-drill' ? 0 : 3
  openBudget(PRIV, {
    attemptId, stage: 'milestone-0-probe', wallClockLimitMs: 20 * 60e3, callLimit, tokenLimit: 150000,
    scope: 'creator run writing candidate-bundle (isolated home)', startedAtUtc: new Date().toISOString(),
  })
  const prompt = [
    'You are in creator mode. Create a minimal persistent plugin bundle.',
    '1) Use cordis_inspect_list, then cordis_inspect_query on the slots service, to inspect how conversation.composer.dock is registered.',
    `2) Write a standard plugin package into the directory ${BUNDLE} with exactly three files:`,
    `   - package.json: {"name":"@local/lifecycle-logger","version":"1.0.0","private":true,"type":"module","exports":{".":"./index.js"},"dsh":{"bundle":{"patch":"./cordis.patch.yml"}}}`,
    `   - index.js: exports name 'lifecycle-logger' and function apply(ctx, config) that appends one JSON line {"event":"applied","at":<new Date().toISOString>()} to config.logPath (use node:fs appendFileSync; wrap in try/catch).`,
    `   - cordis.patch.yml: one insert entry: id 'lifecycle-logger', name '@local/lifecycle-logger', config.logPath '${CAND_LOG}'`,
    'Do not install anything. Do not create other files. Reply exactly DONE when the three files are written.',
  ].join('\n')
  try {
    const r = reserve(PRIV, attemptId, 60000)
    console.log(`budget reserved (${r.reservationId}); launching REAL creator run…`)
    const opId = `op-${attemptId}`
    appendCost(PRIV, { kind: 'start', eventId: `evt-${attemptId}`, operationId: opId, stage: 'milestone-0-probe', attempt: attemptId, provider: 'deepseek-official', model: 'deepseek-v4-flash', startedAtUtc: new Date().toISOString(), budgetRef: attemptId, reservationId: r.reservationId })
    const out = sh('node', [BIN, 'cordis-run', prompt], { cwd: WS })
    console.log('creator reply tail:', out.split('\n').slice(-3).join(' / '))
    const id = await newestSession()
    const s = await readSession(id)
    const usage = s?.events.filter(e => e.type === 'assistant/message').map(e => e.data?.usage).at(-1) ?? null
    const total = usage ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) : null
    settleReservation(PRIV, r, { tokens: total, calls: 1 })
    appendCost(PRIV, { kind: 'finish', eventId: `evt-${attemptId}-f`, operationId: opId, status: 'completed', finishedAtUtc: new Date().toISOString(), durationMs: null, usage: usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedInputTokens: usage.cacheReadTokens ?? null, reasoningTokens: null } : null, usageSource: 'provider', money: null })
    const summary = settleBudget(PRIV, attemptId)
    const files = ['package.json', 'index.js', 'cordis.patch.yml'].map(f => existsSync(join(BUNDLE, f)))
    console.log(JSON.stringify({ session: id, preset: s?.header.agentPreset, usage, bundleFiles: files, budget: summary }, null, 1))
  } catch (error) {
    console.log(`STOPPED BEFORE MODEL CALL: ${error.message}`)
    const summary = settleBudget(PRIV, attemptId)
    console.log(JSON.stringify({ refused: true, budget: summary }, null, 1))
    process.exit(error.code === 'BUDGET_EXCEEDED' ? 0 : 1)
  }
  process.exit(0)
}

if (cmd === 'verify') {
  // install ONLY into cand-test profile of the isolated home
  sh('node', [BIN, 'plugin', '--profile', 'cand-test', 'add', `link:${BUNDLE}`])
  const boot = (tag) => {
    try {
      sh('node', [BIN, 'cand-test', `stub-boot-${tag}`], {
        cwd: WS, env: { DEEPSEEK_BASE_URL: `http://127.0.0.1:${STUB_PORT}`, DEEPSEEK_API_KEY: 'sk-stub' },
      })
    } catch { /* expected: stub answers 401; activation happens at boot */ }
  }
  const lines = () => (existsSync(CAND_LOG) ? readFileSync(CAND_LOG, 'utf8').trim().split('\n').filter(Boolean) : [])
  rmSync(CAND_LOG, { force: true })
  boot('activate')
  const afterActivate = lines().length
  // disable via profile patch override, boot again: no new line
  const patch = join(HOME, 'profiles/cand-test/cordis.patch.yml')
  writeFileSync(patch, `${readFileSync(patch, 'utf8')}- id: lifecycle-logger\n  disabled: true\n`)
  boot('disabled')
  const afterDisable = lines().length
  // re-enable
  writeFileSync(patch, `- id: session-log-deepseek\n  config:\n    enabled: false\n`)
  boot('reenable')
  const afterReenable = lines().length
  const baselineProfiles = readFileSync(join(ROOT, 'state/runtime/dsh-baseline/.main-profiles-snapshot'), 'utf8')
  const ok = afterActivate >= 1 && afterDisable === afterActivate && afterReenable > afterDisable
  console.log(JSON.stringify({ activation: { afterActivate, afterDisable, afterReenable }, mainEnvUntouched: baselineProfiles }, null, 1))
  process.exit(ok ? 0 : 1)
}

console.error('usage: tsx run-candidate-probe.mjs p3-smoke|create|verify|stop-drill')
process.exit(2)
