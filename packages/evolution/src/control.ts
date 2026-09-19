/**
 * Control state: ONE file `state/control.json` carrying seq, baseline,
 * previous, quarantine, activeTrial and a capped audit trail. Publishing and
 * trialing never live in separate files, so cross-file mismatch states cannot
 * exist. All writes go through writeControl/bindForTask under one O_EXCL lock
 * with tmp+fsync+rename atomic replace.
 *
 * Two distinct failure recoveries (never interchangeable):
 *  - revoke-trial: the TRIAL candidate is faulty — stop it, baseline untouched
 *  - recover-baseline: a FORMAL baseline artifact is faulty — quarantine it,
 *    fall back to previous, previous becomes null (a quarantined or absent
 *    previous makes a second recovery fail with NoSafeBaseline instead of
 *    ever swapping the bad version back in)
 */
import { existsSync, openSync, closeSync, readFileSync, renameSync, writeFileSync, fsyncSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { acquireLock, StaleLockError } from './lock.ts'

export interface ArtifactRef {
  kind: 'plugin' | 'memory' | 'skill' | 'config'
  id: string
  digest: string
  path: string
}
export interface ArtifactSet { entries: ArtifactRef[]; hash: string }
export interface EnrollEntry {
  taskId: string
  sessionId: string
  boundVersion: 'baseline' | 'candidate'
  enrolledAtUtc: string
  reason?: string
}
export interface Trial {
  trialId: string
  candidateId: string
  releaseSeq: number
  candidateDigest: string
  condition: { preset?: string; workspacePrefix?: string }
  startedAtUtc: string
  deadlineUtc: string
  status: 'active' | 'expired' | 'invalidated'
  enrolled: EnrollEntry[]
}
export interface QuarantineEntry { hash: string; reason: string; atUtc: string }
export interface ControlRecord { atUtc: string; kind: string; summary: string }
export interface ControlFile {
  schemaVersion: 1
  seq: number
  baseline: ArtifactSet
  previous: ArtifactSet | null
  quarantine: QuarantineEntry[]
  activeTrial: Trial | null
  records: ControlRecord[]
}

export const MAX_ENROLLED = 5
export const MAX_RECORDS = 200
export const EMPTY_SET: ArtifactSet = { entries: [], hash: 'empty' }

export class ControlCorruptError extends Error { readonly code = 'CONTROL_CORRUPT' }
export class NoSafeBaseline extends Error { readonly code = 'NO_SAFE_BASELINE' }
export class InvalidAction extends Error { readonly code = 'INVALID_ACTION' }

export type ControlAction =
  | { type: 'publish'; baseline: ArtifactSet; approvalRef: string }
  | { type: 'enable-trial'; trial: Omit<Trial, 'status' | 'enrolled'> }
  | { type: 'revoke-trial'; reason: string }
  | { type: 'recover-baseline'; reason: string }
  | { type: 'mark-trial'; status: 'expired' | 'invalidated'; reason: string }

function freshControl(): ControlFile {
  return { schemaVersion: 1, seq: 0, baseline: EMPTY_SET, previous: null, quarantine: [], activeTrial: null, records: [] }
}

function record(c: ControlFile, kind: string, summary: string): void {
  c.records.push({ atUtc: new Date().toISOString(), kind, summary })
  if (c.records.length > MAX_RECORDS) c.records.splice(0, c.records.length - MAX_RECORDS)
}

export function readControl(stateDir: string): ControlFile {
  const file = join(stateDir, 'control.json')
  if (!existsSync(file)) return freshControl()
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as ControlFile
    if (parsed.schemaVersion !== 1 || typeof parsed.seq !== 'number' || !parsed.baseline) {
      throw new Error('shape mismatch')
    }
    return parsed
  } catch {
    throw new ControlCorruptError(`control.json at ${file} is not a valid control file`)
  }
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp`
  const fd = openSync(tmp, 'w')
  try { writeFileSync(fd, text); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(tmp, file)
}

function applyAction(current: ControlFile, action: ControlAction): ControlFile {
  const c: ControlFile = structuredClone(current)
  switch (action.type) {
    case 'publish': {
      if (!action.approvalRef) throw new InvalidAction('publish requires approvalRef')
      c.seq += 1
      c.previous = c.baseline
      c.baseline = action.baseline
      c.activeTrial = null
      record(c, 'publish', `seq ${c.seq}; ${action.baseline.entries.length} entries; approval ${action.approvalRef}`)
      return c
    }
    case 'enable-trial': {
      if (!action.trial.candidateDigest) throw new InvalidAction('enable-trial requires candidateDigest')
      c.seq += 1
      c.activeTrial = { ...action.trial, status: 'active', enrolled: [] }
      c.activeTrial.releaseSeq = c.seq
      record(c, 'enable-trial', `seq ${c.seq}; trial ${action.trial.trialId}; candidate ${action.trial.candidateId}`)
      return c
    }
    case 'revoke-trial': {
      if (!c.activeTrial) throw new InvalidAction('revoke-trial with no active trial')
      c.seq += 1
      c.activeTrial.status = 'invalidated'
      record(c, 'revoke-trial', `seq ${c.seq}; ${action.reason}; baseline untouched`)
      return c
    }
    case 'recover-baseline': {
      if (c.previous === null) throw new NoSafeBaseline('no previous baseline to fall back to')
      if (c.quarantine.some(q => q.hash === c.previous!.hash)) {
        throw new NoSafeBaseline('previous baseline is quarantined; no safe fallback')
      }
      c.seq += 1
      c.quarantine.push({ hash: c.baseline.hash, reason: action.reason, atUtc: new Date().toISOString() })
      c.baseline = c.previous
      c.previous = null
      c.activeTrial = null
      record(c, 'recover-baseline', `seq ${c.seq}; ${action.reason}; quarantined ${c.quarantine.at(-1)!.hash}`)
      return c
    }
    case 'mark-trial': {
      if (!c.activeTrial) throw new InvalidAction('mark-trial with no active trial')
      c.activeTrial.status = action.status
      record(c, 'mark-trial', `${action.status}; ${action.reason}`)
      return c
    }
  }
}

export function writeControl(stateDir: string, action: ControlAction): ControlFile {
  mkdirSync(stateDir, { recursive: true })
  const lock = acquireLock(stateDir, 'control')
  try {
    const next = applyAction(readControl(stateDir), action)
    writeAtomic(join(stateDir, 'control.json'), `${JSON.stringify(next, null, 2)}\n`)
    return next
  } finally { lock.release() }
}

/** A trial is effective only when releaseSeq matches the current seq, the
 * on-disk candidate digest matches, and status is active. */
export function trialEffective(c: ControlFile, actualCandidateDigest: string | null): Trial | null {
  const t = c.activeTrial
  if (!t || t.status !== 'active') return null
  if (t.releaseSeq !== c.seq) return null
  if (actualCandidateDigest === null || actualCandidateDigest !== t.candidateDigest) return null
  return t
}

export interface BindInput {
  taskId: string
  sessionId: string
  candidateDigestOnDisk: string | null
  conditionCtx: { preset?: string; workspacePrefix?: string }
}
export type BindResult =
  | { bound: 'candidate'; trialId: string; reused: boolean }
  | { bound: 'baseline'; reused: boolean; reason: 'no-trial' | 'trial-invalid' | 'digest-mismatch' | 'expired' | 'quota-full' | 'condition-mismatch' | 'lock-timeout' | 'control-corrupt' }

function conditionMatches(trial: Trial, ctx: BindInput['conditionCtx']): boolean {
  const c = trial.condition
  // A defined condition requires the caller to actually provide that dimension;
  // a missing ctx value is NOT an implicit pass.
  if (c.preset !== undefined && ctx.preset !== undefined && c.preset !== ctx.preset) return false
  if (c.preset !== undefined && ctx.preset === undefined) return false
  if (c.workspacePrefix !== undefined && ctx.workspacePrefix !== undefined && !ctx.workspacePrefix.startsWith(c.workspacePrefix)) return false
  if (c.workspacePrefix !== undefined && ctx.workspacePrefix === undefined) return false
  return true
}

/** The single binding entry point: effectiveness FIRST (a revoked/digest-changed
 * trial can never serve a candidate binding, even to an already-enrolled task),
 * then existing-binding reuse, then deadline/quota/enroll — all inside one lock. */
export function bindForTask(stateDir: string, input: BindInput): BindResult {
  mkdirSync(stateDir, { recursive: true })
  const lock = acquireLock(stateDir, 'control')
  try {
    const c = readControl(stateDir)
    const trial = c.activeTrial
    if (!trial) return { bound: 'baseline', reused: false, reason: 'no-trial' }

    // Effectiveness gate before any reuse (5.4 invariant):
    const seqOk = trial.releaseSeq === c.seq
    const digestOk = input.candidateDigestOnDisk !== null && input.candidateDigestOnDisk === trial.candidateDigest
    if (trial.status === 'invalidated' || !seqOk || !digestOk) {
      return { bound: 'baseline', reused: false, reason: !seqOk || trial.status === 'invalidated' ? 'trial-invalid' : 'digest-mismatch' }
    }
    if (trial.status === 'expired') {
      // Normal expiry: already-enrolled tasks keep their bound version; new tasks fall back.
      if (trial.enrolled.some(e => e.taskId === input.taskId)) return { bound: 'candidate', trialId: trial.trialId, reused: true }
      return { bound: 'baseline', reused: false, reason: 'expired' }
    }

    // Effective active trial → existing binding reuse (same task never re-books a slot).
    if (trial.enrolled.some(e => e.taskId === input.taskId)) return { bound: 'candidate', trialId: trial.trialId, reused: true }

    if (Date.now() >= Date.parse(trial.deadlineUtc)) {
      trial.status = 'expired'
      writeAtomic(join(stateDir, 'control.json'), `${JSON.stringify(c, null, 2)}\n`)
      return { bound: 'baseline', reused: false, reason: 'expired' }
    }
    if (!conditionMatches(trial, input.conditionCtx)) {
      return { bound: 'baseline', reused: false, reason: 'condition-mismatch' }
    }
    if (trial.enrolled.length >= MAX_ENROLLED) {
      return { bound: 'baseline', reused: false, reason: 'quota-full' }
    }
    // Reservation and binding are the SAME atomic write (no in-between).
    trial.enrolled.push({
      taskId: input.taskId,
      sessionId: input.sessionId,
      boundVersion: 'candidate',
      enrolledAtUtc: new Date().toISOString(),
    })
    writeAtomic(join(stateDir, 'control.json'), `${JSON.stringify(c, null, 2)}\n`)
    return { bound: 'candidate', trialId: trial.trialId, reused: false }
  } finally { lock.release() }
}

export { StaleLockError }
