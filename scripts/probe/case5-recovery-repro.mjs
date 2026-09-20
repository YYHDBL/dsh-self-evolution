#!/usr/bin/env node
// Rebuild the case-5 fixture and run the launcher's full recovery flow once.
// Usage: tsx scripts/probe/case5-recovery-repro.mjs
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const ROOT = join(import.meta.dirname, '..', '..')
const RUN = join(ROOT, 'state/runtime/b4-drills')
const BIN = join(ROOT, 'vendor/dsh-0.1.6/apps/cli/lib/bin.js')
const TSX = join(ROOT, 'vendor/dsh-0.1.6/node_modules/.bin/tsx')
const START = join(ROOT, 'scripts/start.mjs')
const PROBE = join(ROOT, 'packages/evolution-probe')
const BAD = join(RUN, 'bad-plugin')
const GOOD = join(RUN, 'good-plugin')

const home = join(RUN, 'baseline-bad', 'home')
const state = join(RUN, 'baseline-bad', 'state')
rmSync(join(RUN, 'baseline-bad'), { recursive: true, force: true })
mkdirSync(join(home, 'profiles'), { recursive: true })
mkdirSync(state, { recursive: true })
const sh = (cmd, args, env = {}) => execFileSync(cmd, args, {
  encoding: 'utf8', cwd: ROOT,
  env: { ...process.env, PATH: `/tmp/pnpm-shim:${process.env.PATH}`, ...env },
}).toString()

sh('node', [BIN, 'evo-main', '--from-default-profile', 'web', '--dump-config'], { DSH_HOME: home })
writeFileSync(join(home, 'profiles/evo-main/cordis.patch.yml'), `- id: session-log-deepseek\n  config:\n    enabled: false\n`)
sh('node', [BIN, 'plugin', '--profile', 'evo-main', 'add', `link:${PROBE}`], { DSH_HOME: home })
sh('node', [BIN, 'plugin', '--profile', 'evo-main', 'add', `link:${BAD}`], { DSH_HOME: home })
sh('node', [BIN, 'plugin', '--profile', 'evo-main', 'add', `link:${GOOD}`], { DSH_HOME: home })

const control = await import(join(ROOT, 'packages/evolution/src/control.ts'))
const GD = createHash('sha256').update(readFileSync(join(GOOD, 'index.js'))).digest('hex')
const BD = createHash('sha256').update(readFileSync(join(BAD, 'index.js'))).digest('hex')
control.writeControl(state, { type: 'publish', baseline: { entries: [{ kind: 'plugin', id: 'good-plugin', digest: GD, path: join(GOOD, 'index.js') }], hash: 'A-good' }, approvalRef: 'd1' })
control.writeControl(state, { type: 'publish', baseline: { entries: [{ kind: 'plugin', id: 'bad-plugin', digest: BD, path: join(BAD, 'index.js') }], hash: 'B-bad' }, approvalRef: 'd2' })
rmSync(join(RUN, 'good-marker.jsonl'), { force: true })

let out = ''
try {
  out = sh(TSX, [START, '--home', home, '--state', state, '--port', '4680', '--profile', 'evo-main'])
} catch (error) {
  out = String(error.stdout ?? '') + String(error.message)
}
console.log(out.trim())

const c = control.readControl(state)
const marker = existsSync(join(RUN, 'good-marker.jsonl'))
  ? readFileSync(join(RUN, 'good-marker.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
  : []
const profilePatch = readFileSync(join(home, 'profiles/evo-main/cordis.patch.yml'), 'utf8')
const pass = c.baseline.hash === 'A-good' && c.quarantine.some(q => q.hash === 'B-bad') && marker.length > 0 && profilePatch.includes('- id: bad-plugin')
console.log(JSON.stringify({
  verdict: pass ? 'CASE5 PASS' : 'CASE5 FAIL',
  baseline: c.baseline.hash,
  quarantined: c.quarantine.map(q => q.hash),
  oldArtifactMarkers: marker.length,
  profilePatchDisablesBad: profilePatch.includes('- id: bad-plugin'),
}, null, 1))
process.exit(pass ? 0 : 1)
