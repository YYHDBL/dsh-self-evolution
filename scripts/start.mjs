#!/usr/bin/env node
// B4 external launcher (audit-round-2 revision).
//
// Recovery now ENFORCES the running environment, not just the ledger: revoked
// trial candidates and quarantined baseline artifacts are disabled through an
// official `--patch` overlay (stateDir/recovery-disable.yml) before the retry
// boot, so the bad plugin really stops loading. Child env is an ALLOWLIST (no
// wholesale process.env inheritance). Hold mode monitors the health heartbeat
// at runtime; a stale heartbeat stops the child with an unattributed record.
// On launcher shutdown the worker (worker.lock pid) is cleaned up too.
//
// Usage (vendored tsx): tsx scripts/start.mjs --home <DSH_HOME> --state <STATE_DIR>
//   [--port P] [--profile NAME] [--hold]
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
const HEALTH_TIMEOUT = Number(arg('--health-timeout-ms', 45000))
const HOLD = process.argv.includes('--hold')

mkdirSync(STATE, { recursive: true })
const log = (line) => console.log(`[start.mjs] ${line}`)
const fail = (code, line) => { log(`FATAL: ${line}`); process.exit(code) }
const dump = (name, data) => { try { writeFileSync(join(STATE, name), JSON.stringify(data, null, 2)) } catch { /* best effort */ } }

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
const killWorkerByLock = () => {
  const lock = join(STATE, 'worker.lock')
  if (!existsSync(lock)) return
  try {
    const { pid } = JSON.parse(readFileSync(lock, 'utf8'))
    if (Number.isFinite(pid) && pidAlive(pid)) {
      process.kill(pid, 'SIGTERM')
      log(`worker cleanup: SIGTERM to worker pid ${pid}`)
    }
  } catch { /* unreadable lock: leave to pre-spawn recovery */ }
}

// ── 2. Control file ────────────────────────────────────────────────────────
const require3 = createRequire(join(ROOT, 'package.json'))
const { readControl, writeControl, ControlCorruptError } =
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
  log('control.json CORRUPT: empty managed set claimed; profile boots as-is (safety config preserved). LIMITATION: with an unparseable file the managed ids are unknowable, so previously managed plugins are NOT force-disabled — recorded, not hidden.')
}
const expectedTrialCandidate = control.activeTrial?.status === 'active' ? control.activeTrial.candidateId : null
log(`control: seq=${control.seq} baseline=${control.baseline.hash} entries=${control.baseline.entries.length} trial=${expectedTrialCandidate ?? 'none'}${emptySetMode ? ' [EMPTY-SET MODE]' : ''}`)

// ── 3. Recovery enforcement overlay (official --patch mechanism) ───────────
const disableIds = new Set()
const recoveryPatchPath = join(STATE, 'recovery-disable.yml')
function writeRecoveryPatch() {
  const rows = [...disableIds].filter(Boolean).map(id => `- id: ${id}\n  disabled: true\n`).join('')
  writeFileSync(recoveryPatchPath, rows)
  log(`recovery overlay: ${[...disableIds].join(', ') || '(none)'}`)
}
writeRecoveryPatch()

// ── 4. Boot attempt (max 2, env ALLOWLIST) ─────────────────────────────────
function childEnv(bootId) {
  // Allowlist only: no wholesale process.env, no stray credentials. The model
  // credential is picked explicitly from the project .env by the caller when
  // real calls are intended; launcher boots make no model calls themselves.
  const env = {
    PATH: `/tmp/pnpm-shim:${process.env.PATH ?? ''}`,
    HOME: process.env.HOME,
    LANG: process.env.LANG ?? 'C.UTF-8',
    DSH_HOME: HOME,
    DSH_BOOT_ID: bootId,
    EVO_STATE_DIR: STATE,
  }
  if (process.env.TZ) env.TZ = process.env.TZ
  return env
}
async function bootOnce(attempt) {
  const bootId = randomUUID()
  const healthPath = join(STATE, 'launcher-health.json')
  // No pre-delete: stale or forged health files are ignored by the bootId match below.
  const args = [BIN, PROFILE, '--no-open', '--port', String(PORT)]
  if (disableIds.size > 0) args.push('--patch', recoveryPatchPath)
  const child = spawn(process.execPath, args, { cwd: HOME, env: childEnv(bootId), stdio: ['ignore', 'pipe', 'pipe'] })
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
      if (!HOLD) {
        log('non-hold mode: verified healthy boot, shutting down cleanly')
        result.child.kill('SIGTERM')
        await result.dead
        process.exit(0)
      }
      log(`holding: web on port ${PORT}; Ctrl-C to stop`)
      // Runtime heartbeat monitor: a stale heartbeat stops the child with an
      // UNATTRIBUTED record (cause diagnosis stays with the human).
      const healthPath = join(STATE, 'launcher-health.json')
      const monitor = setInterval(() => {
        try {
          const h = JSON.parse(readFileSync(healthPath, 'utf8'))
          if (h.bootId === result.bootId && Date.now() - Date.parse(h.atUtc) > 25000) {
            dump('launcher-runtime-fault.json', { atUtc: new Date().toISOString(), reason: 'health-heartbeat-stale', autoAttributed: false, note: 'runtime stop; cause not auto-attributed' })
            log('RUNTIME FAULT: health heartbeat stale — stopping child (record kept, not attributed)')
            result.child.kill('SIGKILL')
          }
        } catch { /* unreadable heartbeat: the dead-handler below covers process death */ }
      }, 5000)
      const stop = () => { log('stopping: child + worker'); clearInterval(monitor); killWorkerByLock(); result.child.kill('SIGTERM') }
      process.on('SIGINT', stop)
      process.on('SIGTERM', stop)
      result.dead.then(exit => {
        clearInterval(monitor)
        killWorkerByLock()
        dump('launcher-exit.json', { atUtc: new Date().toISOString(), exit, autoAttributed: false, note: 'exit after healthy start; cause not auto-attributed' })
        log(`child exited: ${JSON.stringify(exit)} — diagnostics kept, NOT auto-attributed`)
        process.exit(exit.code === 0 ? 0 : 7)
      })
      return
    }
    lastFailure = result
    log(`attempt ${attempt} FAILED: ${result.why}`)
    if (attempt === 1) {
      if (expectedTrialCandidate !== null) {
        writeControl(STATE, { type: 'revoke-trial', reason: `launcher: candidate failed health — ${result.why}` })
        disableIds.add(expectedTrialCandidate)
        writeRecoveryPatch()
        log(`action: TRIAL REVOKED → candidate '${expectedTrialCandidate}' DISABLED via recovery overlay; retrying once`)
      } else if (control.baseline.entries.length > 0 && control.previous !== null) {
        const failingIds = control.baseline.entries.map(e => e.id)
        try {
          writeControl(STATE, { type: 'recover-baseline', reason: `launcher: baseline failed health — ${result.why}` })
          for (const id of failingIds) disableIds.add(id)
          writeRecoveryPatch()
          control = readControl(STATE)
          log(`action: BASELINE RECOVERED → quarantined artifacts [${failingIds.join(', ')}] DISABLED via overlay; retrying once`)
        } catch (error) {
          fail(1, `recover-baseline refused: ${error.message}; not retrying`)
        }
      } else {
        dump('launcher-last-failure.json', { atUtc: new Date().toISOString(), why: result.why, childLog: (result.log ?? '').slice(-4000) })
        fail(1, 'no safe recovery target (empty or absent previous baseline; fault likely in the profile itself); keeping diagnostics, not retrying')
      }
    }
  }
  dump('launcher-last-failure.json', { atUtc: new Date().toISOString(), why: lastFailure?.why, childLog: (lastFailure?.log ?? '').slice(-4000) })
  fail(1, `second attempt failed: ${lastFailure?.why} — diagnostics in ${join(STATE, 'launcher-last-failure.json')}`)
}
main()
