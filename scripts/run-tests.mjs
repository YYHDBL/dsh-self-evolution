#!/usr/bin/env node
// Sequential per-file test runner. Rationale (2026-09-19): vitest 4.1.8's fork
// pool intermittently deadlocks on this machine when one invocation covers all
// spec files (mixed node+jsdom environments, vendored install); single-file
// invocations have never hung. Each file gets its own vitest process, results
// are printed per file, and any failure fails the run. If the pool flakiness
// is ever fixed upstream, `npx vitest run packages` remains the fast path.
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const specs = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue // contains a pnpm link: symlink cycle that defeats tree walkers
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (name.endsWith('.spec.ts')) specs.push(p)
  }
}
walk(join(root, 'packages'))
specs.sort()

let failed = 0
for (const spec of specs) {
  const rel = spec.slice(root.length + 1)
  try {
    const out = execFileSync('npx', ['vitest', 'run', rel], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const line = out.trim().split('\n').find(l => /Tests\s+\d+/.test(l)) ?? 'Tests (see above)'
    console.log(`PASS  ${rel}  (${line.trim()})`)
  } catch (error) {
    failed += 1
    console.log(`FAIL  ${rel}`)
    console.log(String(error.stdout ?? error.message).trim().split('\n').slice(-12).join('\n'))
  }
}
console.log(failed === 0 ? `\nALL PASS (${specs.length} files)` : `\n${failed}/${specs.length} FILES FAILED`)
process.exit(failed === 0 ? 0 : 1)
