import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyUndo, hashFile, journalRead, journalWrite, planUndo } from '../src/undo.ts'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'evo-undo-')); dirs.push(d); return d }
const SOURCE = 'faulty-plugin'

function change(priv: string, file: string, before: string | null, after: string) {
  if (before !== null) writeFileSync(file, before)
  const beforeContent = before !== null ? readFileSync(file) : null
  writeFileSync(file, after)
  journalWrite(priv, {
    file,
    beforeHash: before !== null ? hashFile(file) === hashFile(file) ? hashOf(before) : null : null,
    beforeRef: before !== null ? `undo/${SOURCE}/mat-${file.split('/').pop()}` : '',
    afterHash: hashOf(after),
    source: SOURCE,
    ts: new Date().toISOString(),
  }, beforeContent)
  // fix beforeHash properly (hashOf(before) computed above may race with write order)
  const entries = journalRead(priv, SOURCE)
  entries[entries.length - 1].beforeHash = before !== null ? hashOf(before) : null
  writeFileSync(join(priv, 'undo', `${SOURCE}.jsonl`), entries.map(e => JSON.stringify(e)).join('\n') + '\n')
}
import { createHash } from 'node:crypto'
const hashOf = (text: string) => createHash('sha256').update(text).digest('hex')

describe('restricted file undo', () => {
  it('reverts an owned, unmodified file; keeps user-modified and unowned files', () => {
    const priv = dir()
    const ws = dir()
    const owned = join(ws, 'owned.txt')
    const userTouched = join(ws, 'user.txt')
    const created = join(ws, 'created.txt')
    change(priv, owned, 'original-content\n', 'plugin-content\n')
    change(priv, userTouched, 'user-original\n', 'plugin-content\n')
    change(priv, created, null, 'plugin-created\n')
    // user modifies userTouched AFTER the plugin change
    writeFileSync(userTouched, 'user-edited-again\n')

    const plan = planUndo(priv, SOURCE)
    const ids = plan.revert.map(e => e.file)
    expect(ids).toContain(owned)
    expect(ids).toContain(created)
    expect(plan.skipped).toContainEqual({ file: userTouched, reason: 'later-modified' })

    const report = applyUndo(priv, plan)
    expect(readFileSync(owned, 'utf8')).toBe('original-content\n')   // restored
    expect(existsSync(created)).toBe(false)                          // deleted (backup kept)
    expect(readFileSync(userTouched, 'utf8')).toBe('user-edited-again\n') // untouched
    expect(report.reverted).toHaveLength(2)
    expect(report.failed).toHaveLength(0)
  })

  it('skips when recovery material is missing or altered', () => {
    const priv = dir()
    const ws = dir()
    const f = join(ws, 'nomat.txt')
    change(priv, f, 'before\n', 'after\n')
    // destroy the material copy
    const mat = join(priv, 'undo', SOURCE, 'mat-nomat.txt')
    writeFileSync(mat, 'tampered-material\n')
    const plan = planUndo(priv, SOURCE)
    expect(plan.revert).toHaveLength(0)
    expect(plan.skipped).toContainEqual({ file: f, reason: 'missing-material' })
    expect(readFileSync(f, 'utf8')).toBe('after\n') // preserved as-is for the human
  })

  it('skips a vanished file and re-checks current hash right before restore', () => {
    const priv = dir()
    const ws = dir()
    const gone = join(ws, 'gone.txt')
    const raced = join(ws, 'raced.txt')
    change(priv, gone, 'a\n', 'b\n')
    change(priv, raced, 'a\n', 'b\n')
    rmSync(gone)
    // simulate a late write between plan and apply
    const plan = planUndo(priv, SOURCE)
    writeFileSync(raced, 'late-write\n')
    const report = applyUndo(priv, plan)
    expect(report.skipped).toContainEqual({ file: gone, reason: 'missing-file' })
    expect(report.skipped).toContainEqual({ file: raced, reason: 'later-modified' })
    expect(report.reverted).toHaveLength(0)
    expect(readFileSync(raced, 'utf8')).toBe('late-write\n')
  })

  it('never touches files owned by other sources (whole-workspace restore is out of scope)', () => {
    const priv = dir()
    const ws = dir()
    const mine = join(ws, 'mine.txt')
    const other = join(ws, 'other.txt')
    change(priv, mine, 'm0\n', 'm1\n')
    journalWrite(priv, { file: other, beforeHash: hashOf('o0\n'), beforeRef: 'undo/other-source/mat', afterHash: hashOf('o1\n'), source: 'other-source', ts: new Date().toISOString() }, Buffer.from('o0\n'))
    writeFileSync(other, 'o1\n')
    const report = applyUndo(priv, planUndo(priv, SOURCE))
    expect(report.reverted).toHaveLength(1)
    expect(readFileSync(other, 'utf8')).toBe('o1\n') // other source's journal is not our business
  })
})
