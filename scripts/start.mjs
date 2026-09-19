#!/usr/bin/env node
// B4 external launcher. Owns: pre-spawn stale-lock recovery (the ONLY place
// locks are cleaned), control-file reading (corrupt → empty managed set with
// safety config preserved, never a guessed baseline), bootId-scoped health
// wait over per-instance expected artifacts, and the two distinct failure
// actions — revoke-trial (candidate faulty, baseline untouched) vs
// recover-baseline (formal artifact faulty, bad version quarantined) — with a
// single retry; unknown exits keep diagnostics and are never auto-attributed.
//
// Usage (vendored tsx, because the control module is TS):
//   ./vendor/dsh-0.1.6/node_modules/.bin/tsx scripts/start.mjs --home <DSH_HOME>
//   --state <STATE_DIR> [--port P] [--profile NAME] [--hold]
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const ROOT = join(import.meta.dirname, '..')
const BIN = join(ROOT, 'vendor/dsh-0.1.6/apps/cli/lib/bin.js')
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const HOME = arg('--home', join(ROOT, 'state/runtime/dsh-baseline'))
const STATE = arg('--state', join(ROOT, 'state'))
const PROFILE = arg('--profile', 'baseline-web')
const PORT = Number(arg('--port', 4600))
const BOOT_TIMEOUT = Number(arg('--boot-timeout-ms', 60000))
const HEALTH_TIMEOUT = Number(arg('--health-timeout-ms', 45000))
const HOLD = process.argv.includes('--hold')

mkdirSync(STATE, { recursive: true })
const log = (line) => console.log(`[start.mjs] ${line}`)
const fail = (code, line) => { log(`FATAL: ${line}`); process.exit(code) }

function pidAlive(pid) {
  try { process.kill(pid, 0); return true }
  catch (e) { return e.code === 'EPERM' }
}

// ── 1. Pre-spawn recovery: the only sanctioned lock cleanup ────────────────
for (const name of ['worker', 'control']) {
  const lock = join(STATE, `${name}.lock`)
  if (!existsSync(lock)) continue
  let pid
  try { pid = JSON.parse(readFileSync(lock, 'utf8')).pid } catch { pid = NaN }
  if (Number.isFinite(pid) && pidAlive(pid)) fail(2, `${name}.lock held by LIVE pid ${pid}; aborting (orphan suspected — resolve manually)`)
  rmSync(lock)
  log(`pre-spawn: removed stale ${name}.lock (holder ${pid} confirmed dead)`)
}

// ── 2. Control file ────────────────────────────────────────────────────────
const require3 = createRequire(join(ROOT, 'package.json'))
const { readControl, writeControl, ControlCorruptError, NoSafeBaseline } =
  await import(pathToFileURL(join(ROOT, 'packages/evolution/src/control.ts')).href)

let control
let emptySetMode = false
try {
  control = readControl(STATE)
} catch (error) {
  if (!(error instanceof ControlCorruptError) && error.code !== 'CONTROL_CORRUPT') throw error
  emptySetMode = true
  control = { schemaVersion: 1, seq: 0, baseline: { entries: [], hash: 'empty-corrupt-fallback' }, previous: null, quarantine: [], activeTrial: null, records: [] }
  writeFileSync(join(STATE, 'machine-state.json'), JSON.stringify({ state: 'paused', since: new Date().toISOString(), reason: 'control-corrupt-empty-set-start' }, null, 2))
  log('control.json CORRUPT: starting with EMPTY managed set (safety config preserved in profile), status paused — no baseline claimed')
}
const expectedTrialCandidate = control.activeTrial?.status === 'active' ? control.activeTrial.candidateId : null
log(`control: seq=${control.seq} baseline=${control.baseline.hash} entries=${control.baseline.entries.length} trial=${expectedTrialCandidate ?? 'none'}${emptySetMode ? ' [EMPTY-SET MODE]' : ''}`)

// ── 3. Boot attempt (max 2, with failure action in between) ────────────────
async function bootOnce(attempt) {
  const bootId = randomUUID()
  const healthPath = join(STATE, 'launcher-health.json')
  // No pre-delete: stale or forged health files are ignored by the bootId
  // match below — deletion would hide whether matching actually works.
  const child = spawn(process.execPath, [BIN, PROFILE, '--no-open', '--port', String(PORT)], {
    cwd: HOME,
    env: { ...process.env, DSH_HOME: HOME, DSH_BOOT_ID: bootId, EVO_STATE_DIR: STATE, PATH: `/tmp/pnpm-shim:${process.env.PATH}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const childLog = []
  child.stdout.on('data', d => childLog.push(String(d)))
  child.stderr.on('data', d => childLog.push(String(d)))
  const dead = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })))
  const deadline = Date.now() + HEALTH_TIMEOUT
  let health = null
  while (Date.now() < deadline) {
    if (health === null && existsSync(healthPath)) {
      try {
        const parsed = JSON.parse(readFileSync(healthPath, 'utf8'))
        if (parsed.bootId === bootId && Date.now() - Date.parse(parsed.atUtc) < 20000) health = parsed
      } catch { /* torn read, retry */ }
    }
    if (health !== null) break
    if (await Promise.race([dead.then(e => e), new Promise(r => setTimeout(() => r(null), 250))])) break
  }
  if (health === null) {
    const exit = await Promise.race([dead, new Promise(r => setTimeout(() => r(null), 1000))])
    child.kill('SIGKILL')
    return { ok: false, why: exit ? `child exited before health (code=${exit.code} signal=${exit.signal})` : 'health timeout', log: childLog.join('') }
  }
  const bad = health.artifacts.filter(a => a.expected && !a.activated)
  if (bad.length > 0) {
    child.kill('SIGKILL')
    return { ok: false, why: `artifacts failed to activate: ${bad.map(a => `${a.id}(${a.evidence})`).join(', ')}`, log: childLog.join(''), health }
  }
  log(`attempt ${attempt}: HEALTHY (bootId ${bootId.slice(0, 8)}…, artifacts ${health.artifacts.length}/${health.artifacts.length} activated)`)
  return { ok: true, child, bootId, dead, log: () => childLog.join('') }
}

async function main() {
let lastFailure = null
for (let attempt = 1; attempt <= 2; attempt++) {
  const result = await bootOnce(attempt)
  if (result.ok) {
    if (!HOLD) { log('non-hold mode: verified healthy boot, shutting down cleanly'); result.child.kill('SIGTERM'); await result.dead; process.exit(0) }
    log(`holding: web on port ${PORT}; Ctrl-C to stop`)
    process.on('SIGINT', () => { log('SIGINT: stopping child'); result.child.kill('SIGTERM') })
    result.dead.then(exit => {
      const record = { atUtc: new Date().toISOString(), exit, autoAttributed: false, note: 'exit after healthy start; cause not auto-attributed' }
      try { writeFileSync(join(STATE, 'launcher-exit.json'), JSON.stringify(record, null, 2)) } catch { /* best effort */ }
      log(`child exited: ${JSON.stringify(exit)} — diagnostics kept, NOT auto-attributed`)
      process.exit(exit.code === 0 ? 0 : 7)
    })
    return
  }
  lastFailure = result
  log(`attempt ${attempt} FAILED: ${result.why}`)
  // Failure action by fault target (only one retry):
  if (attempt === 1) {
    if (expectedTrialCandidate !== null) {
      writeControl(STATE, { type: 'revoke-trial', reason: `launcher: candidate failed health — ${result.why}` })
      log('action: TRIAL REVOKED (baseline untouched); retrying once')
    } else if (control.baseline.entries.length > 0 && control.previous !== null) {
      try {
        writeControl(STATE, { type: 'recover-baseline', reason: `launcher: baseline failed health — ${result.why}` })
        control = readControl(STATE)
        log('action: BASELINE RECOVERED (bad version quarantined); retrying once')
      } catch (error) {
        fail(1, `recover-baseline refused: ${error.message}; not retrying`)
      }
    } else {
      try { writeFileSync(join(STATE, 'launcher-last-failure.json'), JSON.stringify({ atUtc: new Date().toISOString(), why: result.why, childLog: (result.log ?? '').slice(-4000) }, null, 2)) } catch { /* best effort */ }
      fail(1, 'no safe recovery target (empty or absent previous baseline; fault likely in the profile itself); keeping diagnostics, not retrying')
    }
  }
}
try { writeFileSync(join(STATE, 'launcher-last-failure.json'), JSON.stringify({ atUtc: new Date().toISOString(), why: lastFailure?.why, childLog: (lastFailure?.log ?? '').slice(-4000) }, null, 2)) } catch { /* best effort */ }
fail(1, `second attempt failed: ${lastFailure?.why} — diagnostics in ${join(STATE, 'launcher-last-failure.json')}`)
}
main()
