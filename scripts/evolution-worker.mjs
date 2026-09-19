#!/usr/bin/env node
// B3 worker skeleton: single instance (O_EXCL lock), real status heartbeat,
// request-file consumption. Heavy work arrives in later stages; this skeleton
// proves lifecycle discipline: interrupted marking on signals, NO auto-retry
// after abnormal death (stale lock refuses until --recover-lock confirms the
// pid is dead), pre-spawn recovery as the only lock-cleanup path.
//
// Usage (plain node works — lock logic is inlined to avoid a TS dependency):
//   node evolution-worker.mjs run [--state-dir DIR] [--once]
//   node evolution-worker.mjs request <kind> [--state-dir DIR]   # operator trigger
//   node evolution-worker.mjs recover-lock [--state-dir DIR]     # pre-spawn recovery
//   node evolution-worker.mjs selftest [--state-dir DIR]
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, statSync, writeFileSync, writeSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const ROOT = join(import.meta.dirname, '..')
const args = process.argv.slice(2)
const cmd = args[0] ?? 'run'
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const STATE_DIR = opt('--state-dir', join(ROOT, 'state'))
const LOCK = join(STATE_DIR, 'worker.lock')
const STATUS = join(STATE_DIR, 'worker-status.json')
const REQUEST = join(STATE_DIR, 'worker-request.json')
const HEARTBEAT_MS = 5000
const STALE_MS = 120_000

function pidAlive(pid) {
  try { process.kill(pid, 0); return true }
  catch (e) { return e.code === 'EPERM' }
}
function readLock() {
  try { return JSON.parse(readFileSync(LOCK, 'utf8')) } catch { return null }
}
function acquireWorkerLock(reason) {
  if (existsSync(LOCK)) {
    const info = readLock()
    const pid = info?.pid
    if (typeof pid !== 'number' || !pidAlive(pid)) {
      console.error(`worker.lock is STALE (holder ${pid}); refusing to auto-takeover. Run: node evolution-worker.mjs recover-lock`)
      process.exit(3)
    }
    console.error(`worker already running (pid ${pid}, reason ${info.reason})`)
    process.exit(4)
  }
  const fd = openSync(LOCK, 'wx')
  try { writeSync(fd, JSON.stringify({ pid: process.pid, reason, createdAtUtc: new Date().toISOString() })) }
  finally { closeSync(fd) }
}
function writeStatus(state, extra = {}) {
  const prev = existsSync(STATUS) ? JSON.parse(readFileSync(STATUS, 'utf8')) : {}
  writeFileSync(STATUS, JSON.stringify({ ...prev, ...extra, state, pid: process.pid, updatedAtUtc: new Date().toISOString() }, null, 2))
}
/** Consumers treat a stale heartbeat as interrupted (a SIGKILLed worker cannot write anything). */
export function effectiveStatus() {
  if (!existsSync(STATUS)) return { state: 'none' }
  const s = JSON.parse(readFileSync(STATUS, 'utf8'))
  if (s.state === 'running' || s.state === 'starting') {
    if (!pidAlive(s.pid) || Date.now() - Date.parse(s.updatedAtUtc) > STALE_MS) return { ...s, state: 'interrupted', staleDetected: true }
  }
  return s
}

if (cmd === 'recover-lock') {
  if (!existsSync(LOCK)) { console.log('no lock present'); process.exit(0) }
  const info = readLock()
  if (typeof info?.pid === 'number' && pidAlive(info.pid)) {
    console.error(`holder pid ${info.pid} is ALIVE; recovery refused`)
    process.exit(5)
  }
  rmSync(LOCK)
  console.log(`stale lock removed (holder ${info?.pid} confirmed dead)`)
  process.exit(0)
}

if (cmd === 'request') {
  const kind = args[1] ?? 'analysis'
  mkdirState()
  writeFileSync(REQUEST, JSON.stringify({ requestId: randomUUID(), kind, requestedAtUtc: new Date().toISOString() }))
  console.log(`request written: ${kind}`)
  process.exit(0)
}

if (cmd === 'status') { console.log(JSON.stringify(effectiveStatus())); process.exit(0) }

if (cmd === 'run' || cmd === 'selftest') {
  mkdirState()
  acquireWorkerLock(cmd === 'selftest' ? 'selftest' : 'on-demand')
  writeStatus('starting', { startedAtUtc: new Date().toISOString() })
  let interrupted = false
  const markInterrupted = (why) => {
    interrupted = true
    try { writeStatus('interrupted', { lastError: why }) } catch { /* best effort */ }
    try { rmSync(LOCK) } catch { /* best effort */ }
    process.exit(6)
  }
  process.on('SIGTERM', () => markInterrupted('SIGTERM'))
  process.on('SIGINT', () => markInterrupted('SIGINT'))
  process.on('uncaughtException', (error) => markInterrupted(`uncaught: ${error.message}`))

  writeStatus('running')
  const deadline = cmd === 'selftest' ? Date.now() + 3000 : Infinity
  for (;;) {
    if (existsSync(REQUEST)) {
      const request = JSON.parse(readFileSync(REQUEST, 'utf8'))
      unlinkSync(REQUEST)
      writeStatus('running', { processing: request.kind, requestId: request.requestId })
      // Skeleton: heavy analysis arrives in stage D; the request cycle itself is the proof.
      writeStatus('running', { lastCompleted: request.requestId })
    }
    writeStatus('running')
    if (Date.now() > deadline) break
    await new Promise(resolve => setTimeout(resolve, HEARTBEAT_MS))
  }
  writeStatus('idle')
  rmSync(LOCK)
  process.exit(0)
}

function mkdirState() { mkdirSync(STATE_DIR, { recursive: true }) }
