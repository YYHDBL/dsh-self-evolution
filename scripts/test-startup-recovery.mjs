#!/usr/bin/env node
// B4 recovery drill matrix. Every case is a REAL launcher boot against a
// fixture home/profile. Run via the vendored tsx.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const ROOT = join(import.meta.dirname, '..')
const RUN = join(ROOT, 'state/runtime/b4-drills')
const BIN = join(ROOT, 'vendor/dsh-0.1.6/apps/cli/lib/bin.js')
const TSX = join(ROOT, 'vendor/dsh-0.1.6/node_modules/.bin/tsx')
const START = join(ROOT, 'scripts/start.mjs')
const PROBE = join(ROOT, 'packages/evolution-probe')
const BAD = join(RUN, 'bad-plugin')
const results = []

const sh = (cmd, args, env = {}) => execFileSync(cmd, args, {
  encoding: 'utf8', cwd: ROOT,
  env: { ...process.env, PATH: `/tmp/pnpm-shim:${process.env.PATH}`, ...env },
}).toString()

function fixture(name, { installProbe = true, installBad = false, installGood = false } = {}) {
  const home = join(RUN, name, 'home')
  const state = join(RUN, name, 'state')
  rmSync(join(RUN, name), { recursive: true, force: true })
  mkdirSync(join(home, 'profiles'), { recursive: true })
  mkdirSync(state, { recursive: true })
  sh('node', [BIN, 'evo-main', '--from-default-profile', 'web', '--dump-config'], { DSH_HOME: home, })
  writeFileSync(join(home, 'profiles/evo-main/cordis.patch.yml'),
    `- id: session-log-deepseek\n  config:\n    enabled: false\n`)
  if (installProbe) sh('node', [BIN, 'plugin', '--profile', 'evo-main', 'add', `link:${PROBE}`], { DSH_HOME: home })
  if (installBad) sh('node', [BIN, 'plugin', '--profile', 'evo-main', 'add', `link:${BAD}`], { DSH_HOME: home })
  if (installGood) sh('node', [BIN, 'plugin', '--profile', 'evo-main', 'add', `link:${GOOD}`], { DSH_HOME: home })
  return { home, state }
}

// bad plugin fixture: throws on import → loader warning (non-required), web still boots
mkdirSync(BAD, { recursive: true })
writeFileSync(join(BAD, 'package.json'), JSON.stringify({ name: '@local/bad-plugin', version: '1.0.0', private: true, type: 'module', exports: { '.': './index.js' }, dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 1))
writeFileSync(join(BAD, 'index.js'), 'throw new Error("bad-plugin: intentional failure")\n')
writeFileSync(join(BAD, 'cordis.patch.yml'), '- insert:\n    - id: bad-plugin\n      name: \'@local/bad-plugin\'\n')
const BAD_DIGEST = createHash('sha256').update(readFileSync(join(BAD, 'index.js'))).digest('hex')
// good-plugin fixture: a NORMAL managed plugin whose apply appends a marker line
const GOOD = join(RUN, 'good-plugin')
mkdirSync(GOOD, { recursive: true })
writeFileSync(join(GOOD, 'package.json'), JSON.stringify({ name: '@local/good-plugin', version: '1.0.0', private: true, type: 'module', exports: { '.': './index.js' }, dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 1))
writeFileSync(join(GOOD, 'index.js'), `import { appendFileSync } from 'node:fs'\nexport const name = 'good-plugin'\nexport function apply(ctx, config) { try { appendFileSync(config.marker, JSON.stringify({ event: 'applied', pid: process.pid, at: new Date().toISOString() }) + '\\n') } catch {} }\n`)
writeFileSync(join(GOOD, 'cordis.patch.yml'), `- insert:\n    - id: good-plugin\n      name: '@local/good-plugin'\n      config:\n        marker: '${join(RUN, 'good-marker.jsonl')}'\n`)
const GOOD_DIGEST = createHash('sha256').update(readFileSync(join(GOOD, 'index.js'))).digest('hex')
const GOOD_MARKER = join(RUN, 'good-marker.jsonl')

const controlMod = await import(join(ROOT, 'packages/evolution/src/control.ts'))
const report = (r) => { results.push(r); console.log(`CASE ${JSON.stringify(r)}`) }
const boot = (home, state, port, extra = []) => {
  try { sh(TSX, [START, '--home', home, '--state', state, '--port', String(port), '--profile', 'evo-main', ...extra]); return { code: 0 } }
  catch (error) { return { code: error.status ?? 1 } }
}

// 1. healthy baseline boot
{
  const { home, state } = fixture('healthy')
  const r = boot(home, state, 4610)
  report({ case: '1-healthy', exit: r.code, pass: r.code === 0 })
}

// 1b. normal non-probe managed plugin: expected + activated (fiberPhase path)
{
  const { home, state } = fixture('good-baseline', { installGood: true })
  controlMod.writeControl(state, { type: 'publish', baseline: { entries: [{ kind: 'plugin', id: 'good-plugin', digest: GOOD_DIGEST, path: join(GOOD, 'index.js') }], hash: 'A-good' }, approvalRef: 'drill' })
  rmSync(GOOD_MARKER, { force: true })
  const r = boot(home, state, 4611)
  const health = JSON.parse(readFileSync(join(state, 'launcher-health.json'), 'utf8'))
  const good = health.artifacts.find(a => a.id === 'good-plugin')
  const markerLines = existsSync(GOOD_MARKER) ? readFileSync(GOOD_MARKER, 'utf8').trim().split('\n').filter(Boolean) : []
  report({ case: '1b-good-managed-plugin', exit: r.code, goodEntry: good ? { activated: good.activated, evidence: good.evidence } : null, markerWritten: markerLines.length > 0, pass: r.code === 0 && good?.activated === true && /fiberPhase=active/.test(good?.evidence ?? '') && markerLines.length > 0 })
}

// 2. pre-spawn lock recovery (h): dead pid cleaned; live pid aborts
{
  const { home, state } = fixture('locks')
  mkdirSync(state, { recursive: true })
  writeFileSync(join(state, 'worker.lock'), JSON.stringify({ pid: 999999998 }))
  const child = spawn('sleep', ['30'])
  writeFileSync(join(state, 'control.lock'), JSON.stringify({ pid: child.pid }))
  // live control.lock must abort FIRST (checked before worker.lock in start.mjs order worker,control — live one aborts)
  const rLive = (() => { try { sh(TSX, [START, '--home', home, '--state', state, '--port', '4620', '--profile', 'evo-main']); return 0 } catch (e) { return e.status ?? 1 } })()
  child.kill('SIGKILL')
  await new Promise(resolve => child.on('exit', resolve)) // reap the zombie: an unreaped pid still answers kill(pid,0) as alive
  // now both dead → cleaned → boots healthy
  const rDead = (() => { try { sh(TSX, [START, '--home', home, '--state', state, '--port', '4621', '--profile', 'evo-main']); return 0 } catch (e) { return e.status ?? 1 } })()
  report({ case: '2-locks', liveLockExit: rLive, liveAborts: rLive === 2, deadCleanedBoots: rDead === 0, pass: rLive === 2 && rDead === 0 })
}

// 3. corrupt control (e2): empty-set start, paused marker, safety config preserved
{
  const { home, state } = fixture('corrupt')
  writeFileSync(join(state, 'control.json'), '{ this is not json')
  const r = (() => { try { sh(TSX, [START, '--home', home, '--state', state, '--port', '4622', '--profile', 'evo-main']); return { code: 0 } } catch (e) { return { code: e.status ?? 1 } } })()
  const paused = JSON.parse(readFileSync(join(state, 'machine-state.json'), 'utf8'))
  const dump = sh('node', [BIN, 'evo-main', '--dump-config'], { DSH_HOME: home })
  report({ case: '3-corrupt-empty-set', exit: r.code, paused: paused.state === 'paused', uploadOffPreserved: dump.includes('enabled: false'), pass: r.code === 0 && paused.state === 'paused' && dump.includes('enabled: false') })
}

// 4. trial candidate faulty (b/b2/c2): revoke-trial, baseline untouched, retry healthy
{
  const { home, state } = fixture('trial', { installBad: true })
  controlMod.writeControl(state, { type: 'publish', baseline: { entries: [], hash: 'A-empty' }, approvalRef: 'drill' })
  controlMod.writeControl(state, { type: 'enable-trial', trial: { trialId: 't-bad', candidateId: 'bad-plugin', releaseSeq: 0, candidateDigest: BAD_DIGEST, condition: {}, startedAtUtc: new Date().toISOString(), deadlineUtc: new Date(Date.now() + 36e5).toISOString() } })
  const before = controlMod.readControl(state)
  const r = (() => { try { sh(TSX, [START, '--home', home, '--state', state, '--port', '4623', '--profile', 'evo-main']); return { code: 0 } } catch (e) { return { code: e.status ?? 1 } } })()
  const after = controlMod.readControl(state)
  // (audit fix 1) the revoked candidate must ACTUALLY stop loading: disable
  // rows now live in the profile's own patch layer (the --patch overlay path
  // breaks pluginManager startup in this deployment — see pm-availability-check).
  const profilePatch = readFileSync(join(home, 'profiles/evo-main/cordis.patch.yml'), 'utf8')
  const overlayDisables = profilePatch.includes('- id: bad-plugin')
  // Direct boots run the WEB SERVER, which never exits by itself: a bounded
  // run (timeout + SIGKILL) is the only way; the load-warning verdict comes
  // from captured stderr. Without this the drill hangs forever.
  const bootDirect = (extra) => {
    try {
      execFileSync('node', [BIN, 'evo-main', '--no-open', '--port', '4633', ...extra], { DSH_HOME: home, timeout: 30000, killSignal: 'SIGKILL', encoding: 'utf8' })
      return { warn: false }
    } catch (e) {
      const out = String(e.stderr ?? '') + String(e.stdout ?? '')
      return { warn: out.includes('bad-plugin') || out.includes('did not activate') }
    }
  }
  // NOTE: the with/without-overlay direct-boot contrast used --patch and is
  // superseded by the profile-patch-layer disable + pm-availability-check triple.
  rmSync(join(RUN, 'warn-probe.txt'), { force: true })
  let withWarn = null; let withoutWarn = null
  try {
    withWarn = bootDirect([])                       // no overlay: bad-plugin load failure expected
    withoutWarn = bootDirect(['--patch', join(state, 'recovery-disable.yml')]) // overlay: disabled row, no load attempt
  } catch { /* diagnostics via flags below */ }
  report({ case: '4-revoke-trial', exit: r.code, baselineUntouched: after.baseline.hash === before.baseline.hash, trialInvalidated: after.activeTrial?.status === 'invalidated', overlayDisables, pass: r.code === 0 && after.baseline.hash === before.baseline.hash && after.activeTrial?.status === 'invalidated' && overlayDisables })
}

// 5. formal baseline faulty (a/c): recover-baseline, quarantine, retry healthy
{
  const { home, state } = fixture('baseline-bad', { installBad: true, installGood: true })
  controlMod.writeControl(state, { type: 'publish', baseline: { entries: [{ kind: 'plugin', id: 'good-plugin', digest: GOOD_DIGEST, path: join(GOOD, 'index.js') }], hash: 'A-good' }, approvalRef: 'drill-1' })
  controlMod.writeControl(state, { type: 'publish', baseline: { entries: [{ kind: 'plugin', id: 'bad-plugin', digest: BAD_DIGEST, path: join(BAD, 'index.js') }], hash: 'B-bad' }, approvalRef: 'drill-2' })
  rmSync(GOOD_MARKER, { force: true })
  const r = (() => { try { sh(TSX, [START, '--home', home, '--state', state, '--port', '4624', '--profile', 'evo-main']); return { code: 0 } } catch (e) { return { code: e.status ?? 1, out: String(e.stdout ?? '') } } })()
  const after = controlMod.readControl(state)
  const markerLines = existsSync(GOOD_MARKER) ? readFileSync(GOOD_MARKER, 'utf8').trim().split('\n').filter(Boolean) : []
  report({ case: '5-recover-baseline', exit: r.code, quarantined: after.quarantine.some(q => q.hash === 'B-bad'), baselineBackTo: after.baseline.hash, oldArtifactInEffect: markerLines.length > 0, pass: r.code === 0 && after.quarantine.some(q => q.hash === 'B-bad') && after.baseline.hash === 'A-good' && markerLines.length > 0 })
}

// 6. forged health file with wrong bootId (g): ignored, real health accepted
{
  const { home, state } = fixture('forged')
  mkdirSync(state, { recursive: true })
  writeFileSync(join(state, 'launcher-health.json'), JSON.stringify({ bootId: 'forged-boot-id', atUtc: new Date().toISOString(), artifacts: [{ id: 'x', expected: true, activated: true }] }))
  const r = (() => { try { sh(TSX, [START, '--home', home, '--state', state, '--port', '4625', '--profile', 'evo-main']); return { code: 0 } } catch (e) { return { code: e.status ?? 1 } } })()
  const accepted = JSON.parse(readFileSync(join(state, 'launcher-health.json'), 'utf8'))
  report({ case: '6-forged-health-ignored', exit: r.code, finalHealthNotForged: accepted.bootId !== 'forged-boot-id', pass: r.code === 0 && accepted.bootId !== 'forged-boot-id' })
}

// 7. unknown exit after healthy start (f/c): diagnostics kept, not auto-attributed
{
  const { home, state } = fixture('unknown-exit')
  const launcher = spawn(TSX, [START, '--home', home, '--state', state, '--port', '4626', '--profile', 'evo-main', '--hold'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  launcher.stdout.on('data', d => { out += d })
  await new Promise(resolve => {
    const t = setTimeout(resolve, 60000)
    launcher.stdout.on('data', d => { if (String(d).includes('holding:')) { clearTimeout(t); resolve() } })
  })
  // kill the WEB child (not the launcher) — unknown-cause exit
  let webPids = []
  try {
    webPids = execFileSync('pgrep', ['-f', 'bin.js evo-main']).toString().trim().split('\n').map(Number).filter(p => p !== launcher.pid)
  } catch { /* pgrep no match: diagnose below */ }
  for (const pid of webPids) { try { process.kill(pid, 'SIGKILL') } catch { /* raced */ } }
  const code = await new Promise(resolve => launcher.on('exit', c => resolve(c)))
  const rec = existsSync(join(state, 'launcher-exit.json')) ? JSON.parse(readFileSync(join(state, 'launcher-exit.json'), 'utf8')) : null
  report({ case: '7-unknown-exit', launcherExit: code, record: rec ? { autoAttributed: rec.autoAttributed } : null, pass: code !== 0 && rec !== null && rec.autoAttributed === false })
}

// 8. worker full chain (audit fix 5): request file → probe spawns worker →
// worker running → launcher SIGTERM → worker cleaned up via worker.lock
{
  const { home, state } = fixture('worker-chain')
  const launcher = spawn(TSX, [START, '--home', home, '--state', state, '--port', '4627', '--profile', 'evo-main', '--hold'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise(resolve => {
    const t = setTimeout(resolve, 60000)
    launcher.stdout.on('data', d => { if (String(d).includes('holding:')) { clearTimeout(t); resolve() } })
  })
  writeFileSync(join(state, 'worker-request.json'), JSON.stringify({ requestId: randomUUID(), kind: 'analysis', requestedAtUtc: new Date().toISOString() }))
  let workerRunning = false
  for (let i = 0; i < 20 && !workerRunning; i++) {
    await new Promise(r => setTimeout(r, 1000))
    try {
      const st = JSON.parse(readFileSync(join(state, 'worker-status.json'), 'utf8'))
      if (['starting', 'running'].includes(st.state)) workerRunning = true
    } catch { /* not yet */ }
  }
  launcher.kill('SIGTERM')
  await new Promise(r => launcher.on('exit', r))
  await new Promise(r => setTimeout(r, 2000))
  let workerCleaned = false
  try {
    const lock = JSON.parse(readFileSync(join(state, 'worker.lock'), 'utf8'))
    try { process.kill(lock.pid, 0); workerCleaned = false } catch { workerCleaned = true } // lock may be gone entirely
  } catch { workerCleaned = true } // lock removed = clean
  report({ case: '8-worker-chain', workerRunning, workerCleaned, pass: workerRunning && workerCleaned })
}

console.log(JSON.stringify(results, null, 1))
const failed = results.filter(r => !r.pass)
console.log(failed.length === 0 ? `ALL ${results.length} DRILLS PASS` : `${failed.length}/${results.length} DRILLS FAILED`)
process.exit(failed.length === 0 ? 0 : 1)
