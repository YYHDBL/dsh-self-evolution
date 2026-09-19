#!/usr/bin/env node
// A2/P1: read-only migration check on an authorized copy of old-format session
// logs, through the official persistence backend at the pinned target commit.
//
// Reports TWO verdicts separately:
//   READONLY  — source tree byte-identical before/after (read-only proof)
//   MIGRATION — expected old-format samples exist (raw header version < 3),
//               official handle presents the migrated V3 view (header.version
//               === 3), and key events (turn/end) correspond old<->new
// Empty or short inputs FAIL migration instead of passing vacuously.
//
// Old-side references are read with the backend's own concatenated-frame zstd
// decoder (scanZstdFrames/decompressZstdFrame from the package source) — no
// self-parsed log format, no third-party zstd.
//
// Run with the vendored tsx (TS source import):
//   node vendor/dsh-0.1.6/node_modules/.bin/tsx scripts/probe/v3-migration.mjs \
//        <sessions-root> [--expect-old N] [--out mapping.json]
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.argv[2]
if (!root) throw new Error('usage: tsx v3-migration.mjs <sessions-root> [--expect-old N] [--out file.json]')
const argv = process.argv.slice(3)
const expectOld = Number(argv[argv.indexOf('--expect-old') + 1] ?? 1)
const outPath = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : undefined

const PKG = join(import.meta.dirname, '..', '..', 'vendor', 'dsh-0.1.6', 'packages', 'session', 'session-persistence-jsonl')
const require3 = createRequire(join(PKG, 'package.json'))
const { Context } = require3('@deepseek-ai/cordis')
const { scanZstdFrames, decompressZstdFrame } = await import(pathToFileURL(join(PKG, 'src', 'zstd.ts')).href)
const { default: JsonlSessionPersistence } = await import(pathToFileURL(join(PKG, 'lib', 'index.js')).href)

function hashTree(dir) {
  const out = {}
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else out[relative(dir, p)] = createHash('sha256').update(readFileSync(p)).digest('hex')
    }
  }
  walk(dir)
  return out
}

/** Old-side reference: decode the legacy flat session.jsonl.zstd with the official frame decoder. */
async function readRawOldEvents(sessionDir) {
  const file = join(sessionDir, 'session.jsonl.zstd')
  const buffer = readFileSync(file)
  const scan = scanZstdFrames(buffer)
  if (scan.frames.length === 0) throw new Error(`no complete zstd frames in ${file}`)
  const chunks = await Promise.all(scan.frames.map(f => decompressZstdFrame(buffer.subarray(f.start, f.end))))
  const text = chunks.reduce((acc, chunk) => Buffer.concat([acc, chunk]), Buffer.alloc(0)).toString('utf8')
  return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

const before = hashTree(root)
const ctx = new Context()
await ctx.plugin(JsonlSessionPersistence, { root })
const svc = ctx.sessionPersistence
if (!svc) throw new Error('service ctx.sessionPersistence not available after plugin load')

const listed = await svc.list()
const records = []
let migrationOk = listed.length >= expectOld

for (const meta of listed) {
  const id = String(meta.header.id)
  const sessionDir = join(root, meta.projectDir ?? '', id)
  let rawDir = null
  for (const candidate of readdirSync(root)) {
    const dir = join(root, candidate)
    if (statSync(dir).isDirectory() && statSync(join(dir, id)).isDirectory()) { rawDir = join(dir, id); break }
  }
  const rawEvents = await readRawOldEvents(rawDir ?? sessionDir)
  const rawHeader = rawEvents.find(e => e.type === 'session')
  const rawVersion = rawHeader?.version
  const rawTurnEnds = rawEvents.filter(e => e.type === 'turn/end')
  const rawSeqs = rawEvents.filter(e => typeof e.seq === 'number').map(e => e.seq)

  const h = await svc.open(id, 'read')
  const { events } = await h.read()
  await h.close()
  const newTurnEnds = events.filter(e => e.type === 'turn/end')
  const newSeqs = events.map(e => e.seq)

  const turnEndMap = rawTurnEnds.map((old, i) => ({
    oldSeq: old.seq,
    newSeq: newTurnEnds[i]?.seq ?? null,
    time: old.time ?? newTurnEnds[i]?.time ?? null,
  }))

  const checks = {
    rawIsOldFormat: typeof rawVersion === 'number' && rawVersion < 3,
    migratedVersion3: meta.header.version === 3,
    turnEndCountsMatch: rawTurnEnds.length === newTurnEnds.length && rawTurnEnds.length > 0,
    turnEndMapComplete: turnEndMap.every(m => m.newSeq !== null),
  }
  if (Object.values(checks).some(v => !v)) migrationOk = false

  records.push({
    id,
    old: { headerVersion: rawVersion, events: rawEvents.length, seqRange: rawSeqs.length ? [Math.min(...rawSeqs), Math.max(...rawSeqs)] : null, turnEndSeqs: rawTurnEnds.map(e => e.seq) },
    new: { headerVersion: meta.header.version, events: events.length, seqRange: newSeqs.length ? [Math.min(...newSeqs), Math.max(...newSeqs)] : null, turnEndSeqs: newTurnEnds.map(e => e.seq) },
    turnEndMap,
    checks,
  })
}

const after = hashTree(root)
const readonlyOk = JSON.stringify(before) === JSON.stringify(after)
const summary = {
  root,
  expectedOldSamples: expectOld,
  listedSessions: listed.length,
  sessions: records,
}
if (outPath) writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n')

for (const r of records) {
  console.log(`- ${r.id}`)
  console.log(`  old: v${r.old.headerVersion} events=${r.old.events} seq=${JSON.stringify(r.old.seqRange)} turn/end=${JSON.stringify(r.old.turnEndSeqs)}`)
  console.log(`  new: v${r.new.headerVersion} events=${r.new.events} seq=${JSON.stringify(r.new.seqRange)} turn/end=${JSON.stringify(r.new.turnEndSeqs)}`)
  console.log(`  checks: ${JSON.stringify(r.checks)}`)
}
console.log(`READONLY  : ${readonlyOk ? 'PASS' : 'FAIL'} (${Object.keys(before).length} files hashed, before==after: ${readonlyOk})`)
console.log(`MIGRATION : ${migrationOk ? 'PASS' : 'FAIL'} (listed ${listed.length} >= expected ${expectOld}; per-session checks above)`)
const ok = readonlyOk && migrationOk
console.log(`OVERALL   : ${ok ? 'PASS' : 'FAIL'}`)
if (outPath) console.log(`mapping   : ${outPath}`)
process.exit(ok ? 0 : 1)
