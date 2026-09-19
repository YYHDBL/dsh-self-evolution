/**
 * B5 restricted file undo. Journal-first: an operation records {file,
 * beforeHash, beforeRef, afterHash, source, ts} BEFORE the change survives;
 * undo only ever reverts files whose CURRENT hash still equals afterHash
 * (proving no later modification) and whose ownership is clear. Everything
 * else is skipped with a reason and handed to the human. No merging, no
 * whole-workspace restore, no concurrent-write races.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface JournalEntry {
  file: string            // absolute path of the modified file
  beforeHash: string | null  // null = file did not exist
  beforeRef: string       // path to the minimal recovery material copy ("" = nothing to restore → deletion)
  afterHash: string
  source: string          // operation source id (e.g. plugin id)
  ts: string
}
export type SkipReason = 'later-modified' | 'unclear-owner' | 'missing-material' | 'missing-file'
export interface UndoPlan {
  revert: JournalEntry[]
  skipped: { file: string; reason: SkipReason }[]
  failed: { file: string; error: string }[]
}

export function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Append one journal entry; the material copy is written first (journal-after-material). */
export function journalWrite(dir: string, entry: JournalEntry, beforeContent: Buffer | null): void {
  mkdirSync(join(dir, 'undo', entry.source), { recursive: true })
  if (entry.beforeRef) writeFileSync(join(dir, entry.beforeRef), beforeContent ?? Buffer.alloc(0))
  // append-only journal per source
  const journal = join(dir, 'undo', `${entry.source}.jsonl`)
  const prev = existsSync(journal) ? readFileSync(journal, 'utf8') : ''
  writeFileSync(journal, `${prev}${JSON.stringify(entry)}\n`)
}

export function journalRead(dir: string, source: string): JournalEntry[] {
  const journal = join(dir, 'undo', `${source}.jsonl`)
  if (!existsSync(journal)) return []
  return readFileSync(journal, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
}

/**
 * Plan an undo for one source. Concurrency guard: a file is only revertible
 * when its current hash equals the journal's afterHash — any later change
 * (user or another task) forces a skip, never a merge.
 */
export function planUndo(dir: string, source: string): UndoPlan {
  const plan: UndoPlan = { revert: [], skipped: [], failed: [] }
  for (const entry of journalRead(dir, source)) {
    if (!existsSync(entry.file)) { plan.skipped.push({ file: entry.file, reason: 'missing-file' }); continue }
    let current: string
    try { current = hashFile(entry.file) }
    catch (error) { plan.failed.push({ file: entry.file, error: String(error) }); continue }
    if (current !== entry.afterHash) { plan.skipped.push({ file: entry.file, reason: 'later-modified' }); continue }
    if (entry.beforeHash === null && entry.beforeRef === '') {
      // file was created by the source and untouched since → revert = delete
      plan.revert.push(entry)
      continue
    }
    if (!entry.beforeRef || !existsSync(join(dir, entry.beforeRef))) {
      plan.skipped.push({ file: entry.file, reason: 'missing-material' })
      continue
    }
    const material = join(dir, entry.beforeRef)
    if (hashFile(material) !== entry.beforeHash) {
      plan.skipped.push({ file: entry.file, reason: 'missing-material' }) // material itself altered
      continue
    }
    plan.revert.push(entry)
  }
  return plan
}

export interface UndoReport { reverted: string[]; skipped: { file: string; reason: SkipReason }[]; failed: { file: string; error: string }[] }

/** Execute a plan: re-verify current hash immediately before each restore (narrow the race window). */
export function applyUndo(dir: string, plan: UndoPlan): UndoReport {
  const report: UndoReport = { reverted: [], skipped: [...plan.skipped], failed: [...plan.failed] }
  for (const entry of plan.revert) {
    try {
      if (hashFile(entry.file) !== entry.afterHash) {
        // changed between plan and apply → skip, do not merge
        report.skipped.push({ file: entry.file, reason: 'later-modified' })
        continue
      }
      if (entry.beforeHash === null && entry.beforeRef === '') {
        const backup = `${entry.file}.evo-undo-deleted`
        renameSync(entry.file, backup)
        report.reverted.push(`${entry.file} (deleted; kept ${backup})`)
      } else {
        const tmp = `${entry.file}.evo-restore`
        writeFileSync(tmp, readFileSync(join(dir, entry.beforeRef)))
        renameSync(tmp, entry.file)
        report.reverted.push(`${entry.file} (restored ${entry.beforeHash.slice(0, 8)}…)`)
      }
    } catch (error) {
      report.failed.push({ file: entry.file, error: String(error) })
    }
  }
  return report
}
