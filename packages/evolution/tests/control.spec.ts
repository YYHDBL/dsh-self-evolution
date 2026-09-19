import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ArtifactSet, BindResult, ControlFile, MAX_ENROLLED,
  bindForTask, readControl, trialEffective, writeControl,
} from '../src/control.ts'
import { acquireLock, StaleLockError } from '../src/lock.ts'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'evo-control-')); dirs.push(d); return d }
const set = (hash: string): ArtifactSet => ({ entries: [{ kind: 'plugin', id: `p-${hash}`, digest: hash, path: `/tmp/${hash}` }], hash })

describe('control state actions', () => {
  it('seq is monotonic and publish moves baseline with previous retained', () => {
    const d = dir()
    const a = writeControl(d, { type: 'publish', baseline: set('A'), approvalRef: 'human-1' })
    expect(a.seq).toBe(1); expect(a.baseline.hash).toBe('A'); expect(a.previous!.hash).toBe('empty')
    const b = writeControl(d, { type: 'publish', baseline: set('B'), approvalRef: 'human-2' })
    expect(b.seq).toBe(2); expect(b.baseline.hash).toBe('B'); expect(b.previous!.hash).toBe('A')
    expect(readControl(d).seq).toBe(2)
  })

  it('revoke-trial leaves the baseline untouched', () => {
    const d = dir()
    writeControl(d, { type: 'publish', baseline: set('B'), approvalRef: 'h' })
    writeControl(d, {
      type: 'enable-trial',
      trial: { trialId: 't1', candidateId: 'c1', releaseSeq: 0, candidateDigest: 'dg', condition: {}, startedAtUtc: new Date().toISOString(), deadlineUtc: new Date(Date.now() + 3600e3).toISOString() },
    })
    const after = writeControl(d, { type: 'revoke-trial', reason: 'candidate crashed' })
    expect(after.baseline.hash).toBe('B')
    expect(after.activeTrial!.status).toBe('invalidated')
  })

  it('recover-baseline quarantines the bad version, clears previous, never swaps it back', () => {
    const d = dir()
    writeControl(d, { type: 'publish', baseline: set('A'), approvalRef: 'h1' })
    writeControl(d, { type: 'publish', baseline: set('B'), approvalRef: 'h2' })
    const r = writeControl(d, { type: 'recover-baseline', reason: 'B crashes on boot' })
    expect(r.baseline.hash).toBe('A'); expect(r.previous).toBeNull()
    expect(r.quarantine.map(q => q.hash)).toEqual(['B'])
    expect(() => writeControl(d, { type: 'recover-baseline', reason: 'again' }))
      .toThrow(/NoSafeBaseline|no previous baseline/i)
  })

  it('a quarantined previous is refused as fallback', () => {
    const d = dir()
    writeControl(d, { type: 'publish', baseline: set('A'), approvalRef: 'h1' })
    writeControl(d, { type: 'publish', baseline: set('B'), approvalRef: 'h2' })
    writeControl(d, { type: 'recover-baseline', reason: 'x' })
    writeControl(d, { type: 'publish', baseline: set('C'), approvalRef: 'h3' })
    // previous is now null; publish C set previous = A (safe). Quarantine A manually via path:
    const c = readControl(d)
    c.quarantine.push({ hash: 'A', reason: 'manual', atUtc: new Date().toISOString() })
    writeFileSync(join(d, 'control.json'), JSON.stringify(c))
    expect(() => writeControl(d, { type: 'recover-baseline', reason: 'y' })).toThrow(/NoSafeBaseline|quarantined/i)
  })

  it('any publish invalidates an active trial via seq mismatch (trialEffective)', () => {
    const d = dir()
    writeControl(d, { type: 'publish', baseline: set('B'), approvalRef: 'h' })
    writeControl(d, {
      type: 'enable-trial',
      trial: { trialId: 't1', candidateId: 'c1', releaseSeq: 0, candidateDigest: 'dg', condition: {}, startedAtUtc: new Date().toISOString(), deadlineUtc: new Date(Date.now() + 3600e3).toISOString() },
    })
    let c: ControlFile = readControl(d)
    expect(trialEffective(c, 'dg')!.trialId).toBe('t1')
    writeControl(d, { type: 'publish', baseline: set('B2'), approvalRef: 'h2' })
    c = readControl(d)
    expect(trialEffective(c, 'dg')).toBeNull() // seq moved
    expect(trialEffective(c, 'wrong')).toBeNull()
  })
})

describe('bindForTask', () => {
  const openTrial = (d: string, deadline = new Date(Date.now() + 3600e3).toISOString()) =>
    writeControl(d, {
      type: 'enable-trial',
      trial: { trialId: 't1', candidateId: 'c1', releaseSeq: 0, candidateDigest: 'dg', condition: {}, startedAtUtc: new Date().toISOString(), deadlineUtc: deadline },
    })
  const bind = (d: string, taskId: string, digest: string | null = 'dg'): BindResult =>
    bindForTask(d, { taskId, sessionId: `s-${taskId}`, candidateDigestOnDisk: digest, conditionCtx: {} })

  it('enrolls up to MAX_ENROLLED tasks, then falls to baseline with reason', () => {
    const d = dir(); openTrial(d)
    for (let i = 1; i <= MAX_ENROLLED; i++) expect(bind(d, `task${i}`).bound).toBe('candidate')
    const r = bind(d, 'task6')
    expect(r).toMatchObject({ bound: 'baseline', reason: 'quota-full' })
  })

  it('same task rebinds with reuse and no new slot; quota stays for others', () => {
    const d = dir(); openTrial(d)
    expect(bind(d, 'task1')).toMatchObject({ bound: 'candidate', reused: false })
    expect(bind(d, 'task1')).toMatchObject({ bound: 'candidate', reused: true })
    expect(readControl(d).activeTrial!.enrolled).toHaveLength(1)
  })

  it('digest mismatch and expiry fall to baseline with explicit reasons; expiry marks the trial', () => {
    const d = dir(); openTrial(d)
    expect(bind(d, 't-x', 'tampered')).toMatchObject({ bound: 'baseline', reason: 'digest-mismatch' })
    const d2 = dir(); openTrial(d2, new Date(Date.now() - 1000).toISOString())
    expect(bind(d2, 't-y')).toMatchObject({ bound: 'baseline', reason: 'expired' })
    expect(readControl(d2).activeTrial!.status).toBe('expired')
    expect(bind(d2, 't-z')).toMatchObject({ bound: 'baseline', reason: 'expired' })
  })

  it('a REVOKED or digest-changed trial never serves a candidate binding, even to an already-enrolled task', () => {
    const d = dir(); openTrial(d)
    expect(bind(d, 'task1')).toMatchObject({ bound: 'candidate' })
    // revoked after enrollment
    writeControl(d, { type: 'revoke-trial', reason: 'candidate crashed' })
    expect(bind(d, 'task1')).toMatchObject({ bound: 'baseline', reason: 'trial-invalid' })
    expect(bind(d, 'task2')).toMatchObject({ bound: 'baseline', reason: 'trial-invalid' })
    // fresh trial, digest changed on disk after enrollment
    const d2 = dir(); openTrial(d2)
    expect(bind(d2, 'task1')).toMatchObject({ bound: 'candidate' })
    expect(bind(d2, 'task1', 'tampered-digest')).toMatchObject({ bound: 'baseline', reason: 'digest-mismatch' })
    expect(bind(d2, 'task1')).toMatchObject({ bound: 'candidate', reused: true }) // digest ok again → reuse
  })

  it('normal expiry lets an enrolled task continue, but blocks new tasks', () => {
    const d = dir(); openTrial(d)
    expect(bind(d, 'task1')).toMatchObject({ bound: 'candidate' })
    const d2 = dir(); openTrial(d2, new Date(Date.now() - 1000).toISOString())
    // expire it first via a new-task bind (writes status=expired)
    expect(bind(d2, 't-new')).toMatchObject({ bound: 'baseline', reason: 'expired' })
    // enrolled task on the SAME expired trial keeps its bound version
    const c2 = readControl(d2)
    c2.activeTrial!.enrolled.push({ taskId: 'old-task', sessionId: 's', boundVersion: 'candidate', enrolledAtUtc: new Date().toISOString() })
    writeFileSync(join(d2, 'control.json'), JSON.stringify(c2))
    expect(bind(d2, 'old-task')).toMatchObject({ bound: 'candidate', reused: true })
    expect(bind(d2, 'another-new')).toMatchObject({ bound: 'baseline', reason: 'expired' })
  })

  it('a defined condition does NOT default-satisfy when the caller omits the dimension', () => {
    const d = dir()
    writeControl(d, {
      type: 'enable-trial',
      trial: { trialId: 't1', candidateId: 'c1', releaseSeq: 0, candidateDigest: 'dg', condition: { preset: 'ptc' }, startedAtUtc: new Date().toISOString(), deadlineUtc: new Date(Date.now() + 3600e3).toISOString() },
    })
    expect(bindForTask(d, { taskId: 'x', sessionId: 's', candidateDigestOnDisk: 'dg', conditionCtx: {} }))
      .toMatchObject({ bound: 'baseline', reason: 'condition-mismatch' })
    expect(bindForTask(d, { taskId: 'y', sessionId: 's', candidateDigestOnDisk: 'dg', conditionCtx: { preset: 'standard' } }))
      .toMatchObject({ bound: 'baseline', reason: 'condition-mismatch' })
    expect(bindForTask(d, { taskId: 'z', sessionId: 's', candidateDigestOnDisk: 'dg', conditionCtx: { preset: 'ptc' } }))
      .toMatchObject({ bound: 'candidate' })
  })

  it('same-process interleaved binds stay correct; cross-process mutual exclusion is the O_EXCL lock (see lock drills)', async () => {
    const d = dir(); openTrial(d)
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() => bind(d, `conc${i}`))),
    )
    const candidates = results.filter(r => r.bound === 'candidate')
    const quotaFull = results.filter(r => r.bound === 'baseline' && r.reason === 'quota-full')
    expect(candidates).toHaveLength(MAX_ENROLLED)
    expect(quotaFull).toHaveLength(20 - MAX_ENROLLED)
    expect(readControl(d).activeTrial!.enrolled).toHaveLength(MAX_ENROLLED)
  })

  it('reuse-path binds perform no file write (the enroll write IS the binding; no crash injection claimed)', () => {
    const d = dir(); openTrial(d)
    bind(d, 'a')
    const before = readFileSync(join(d, 'control.json'), 'utf8')
    bind(d, 'a') // reuse path performs no write
    expect(readFileSync(join(d, 'control.json'), 'utf8')).toBe(before)
  })
})

describe('lock semantics', () => {
  it('stale lock throws StaleLockError and is NOT auto-deleted', () => {
    const d = dir()
    writeFileSync(join(d, 'control.lock'), JSON.stringify({ pid: 999999999, createdAtUtc: new Date().toISOString() }))
    expect(() => acquireLock(d, 'control', { timeoutMs: 300 })).toThrow(StaleLockError)
    expect(() => writeControl(d, { type: 'publish', baseline: set('A'), approvalRef: 'h' })).toThrow(StaleLockError)
    expect(existsSync(join(d, 'control.lock'))).toBe(true)
  })

  it('same-process interleaved writers serialize without losing updates (cross-process mutual exclusion is O_EXCL, see lock drills)', async () => {
    const d = dir()
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        Promise.resolve().then(() => writeControl(d, { type: 'publish', baseline: set(`S${i}`), approvalRef: `h${i}` }))),
    )
    const c = readControl(d)
    expect(c.seq).toBe(20)
    expect(c.records).toHaveLength(20)
  })
})
