#!/usr/bin/env node
// A2/P1: read-only migration check on an authorized copy of old-format session
// logs, through the official persistence backend at the pinned target commit.
// Proves: (a) the backend boots standalone in a bare Cordis Context,
// (b) old-format sessions open read-only with in-memory migration,
// (c) source files are not modified (tree hashes before/after must match).
// Usage: node v3-migration.mjs <sessions-root>
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.argv[2]
if (!root) throw new Error('usage: node v3-migration.mjs <sessions-root>')

const PKG = join(import.meta.dirname, '..', '..', 'vendor', 'dsh-0.1.6', 'packages', 'session', 'session-persistence-jsonl')
const require3 = createRequire(join(PKG, 'package.json'))
const { Context } = require3('@deepseek-ai/cordis')
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

const before = hashTree(root)
const ctx = new Context()
await ctx.plugin(JsonlSessionPersistence, { root })
const svc = ctx.sessionPersistence
if (!svc) throw new Error('service ctx.sessionPersistence not available after plugin load')

const listed = await svc.list()
console.log(`listed sessions: ${listed.length}`)

const summary = []
for (const meta of listed) {
  const id = String(meta.header?.id ?? meta.id ?? meta)
  const h = await svc.open(id, 'read')
  try {
    const { events } = await h.read()
    const seqs = events.map((e) => e.seq)
    const types = {}
    for (const e of events) types[e.type] = (types[e.type] ?? 0) + 1
    summary.push({
      id,
      events: events.length,
      minSeq: seqs.length ? Math.min(...seqs) : null,
      maxSeq: seqs.length ? Math.max(...seqs) : null,
      types,
      hasSystemMessage: (types['system/message'] ?? 0) > 0,
    })
  } finally {
    await h.close()
  }
}
// Read-only probe: no pending writes, plain exit instead of a formal teardown.

const after = hashTree(root)
const unchanged = JSON.stringify(before) === JSON.stringify(after)
for (const s of summary) {
  console.log(`- ${s.id}: events=${s.events} seq=[${s.minSeq}..${s.maxSeq}] system/message=${s.hasSystemMessage}`)
  console.log(`  types: ${JSON.stringify(s.types)}`)
}
console.log(`source files unchanged: ${unchanged} (${Object.keys(before).length} files hashed)`)
console.log(unchanged ? 'P1/V3 RESULT: PASS' : 'P1/V3 RESULT: FAIL — source tree modified')
process.exit(unchanged ? 0 : 1)
