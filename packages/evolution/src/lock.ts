/**
 * O_EXCL lock file (no `flock` dependency). Auto acquire/release only; a stale
 * lock is NEVER auto-removed at runtime — two processes handling the same
 * stale lock could delete a freshly acquired one. Cleanup belongs to the
 * launcher's pre-spawn recovery step, which runs before any writer exists.
 */
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs'
import { join } from 'node:path'

export interface LockHandle { release(): void }
export class ControlLockTimeout extends Error {
  readonly code = 'CONTROL_LOCK_TIMEOUT'
  constructor(lockPath: string, pid: number) { super(`lock ${lockPath} held by live pid ${pid}`) }
}
export class StaleLockError extends Error {
  readonly code = 'STALE_LOCK'
  constructor(lockPath: string, detail: string) {
    super(`stale lock ${lockPath}: ${detail}; no auto-takeover — cleanup only in the pre-spawn recovery step`)
  }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

/** A lock file that fails to parse counts as contention for 2s, stale after that. */
function diagnose(lockPath: string): { live: boolean; detail: string } {
  let text: string
  try { text = readFileSync(lockPath, 'utf8') } catch { return { live: false, detail: 'unreadable' } }
  let pid: number | undefined
  try { pid = JSON.parse(text).pid } catch { /* malformed */ }
  if (typeof pid !== 'number' || !Number.isFinite(pid)) {
    const ageMs = Date.now() - statSync(lockPath).mtimeMs
    if (ageMs < 2000) return { live: true, detail: 'malformed but younger than 2s' }
    return { live: false, detail: 'malformed holder record' }
  }
  return pidAlive(pid) ? { live: true, detail: `holder pid ${pid} alive` } : { live: false, detail: `holder pid ${pid} dead` }
}

export function acquireLock(stateDir: string, name: string, opts: { timeoutMs?: number } = {}): LockHandle {
  const lockPath = join(stateDir, `${name}.lock`)
  const deadline = Date.now() + (opts.timeoutMs ?? 5000)
  for (;;) {
    let fd: number | undefined
    try {
      fd = openSync(lockPath, 'wx')
      try { writeSync(fd, JSON.stringify({ pid: process.pid, createdAtUtc: new Date().toISOString() })) }
      finally { closeSync(fd) }
      return { release: () => { try { rmSync(lockPath) } catch { /* best effort */ } } }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const { live, detail } = diagnose(lockPath)
      if (!live) throw new StaleLockError(lockPath, detail)
      if (Date.now() > deadline) throw new ControlLockTimeout(lockPath, process.pid)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
}
