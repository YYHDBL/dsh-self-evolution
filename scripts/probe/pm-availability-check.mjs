#!/usr/bin/env node
// One clean controlled comparison: in the good-baseline fixture home (probe +
// good-plugin installed + bad-plugin INSTALLED in variant), boot the web app
// twice — (A) with an overlay disabling bad-plugin, (B) with bad-plugin active —
// each with a control baseline expecting good-plugin. Reports what the probe's
// health saw for pluginManager in each.
// Usage: tsx scripts/probe/pm-availability-check.mjs
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const ROOT = join(import.meta.dirname, '..', '..')
const HOME = join(ROOT, 'state/runtime/b4-drills/good-baseline/home')
const GOOD = join(ROOT, 'state/runtime/b4-drills/good-plugin')
const BIN = join(ROOT, 'vendor/dsh-0.1.6/apps/cli/lib/bin.js')
const digest = createHash('sha256').update(readFileSync(join(GOOD, 'index.js'))).digest('hex')
const control = { schemaVersion: 1, seq: 1,
  baseline: { entries: [{ kind: 'plugin', id: 'good-plugin', digest, path: join(GOOD, 'index.js') }], hash: 'A-good' },
  previous: { entries: [], hash: 'empty' }, quarantine: [], activeTrial: null,
  records: [{ atUtc: new Date().toISOString(), kind: 'publish', summary: 'pm-check' }] }
const overlay = '/tmp/pm-check-overlay.yml'
writeFileSync(overlay, '- id: bad-plugin\n  disabled: true\n')

async function boot(tag, port, withOverlay) {
  const state = `/tmp/pm-check-${tag}`
  rmSync(state, { recursive: true, force: true })
  mkdirSync(state, { recursive: true })
  writeFileSync(join(state, 'control.json'), JSON.stringify(control, null, 2))
  const args = [BIN, 'evo-main', '--no-open', '--port', String(port)]
  if (withOverlay) args.push('--patch', overlay)
  const child = spawn(process.execPath, args, {
    cwd: HOME,
    env: { PATH: `/tmp/pnpm-shim:${process.env.PATH}`, HOME: process.env.HOME, LANG: 'C.UTF-8', DSH_HOME: HOME, DSH_BOOT_ID: `pm-${tag}`, EVO_STATE_DIR: state },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const log = []
  child.stdout.on('data', d => log.push(String(d)))
  child.stderr.on('data', d => log.push(String(d)))
  await new Promise(r => setTimeout(r, 32000))
  child.kill('SIGKILL')
  await new Promise(r => child.on('exit', r))
  let health = null
  try { health = JSON.parse(readFileSync(join(state, 'launcher-health.json'), 'utf8')) } catch { /* none */ }
  const badWarning = log.join('').includes('bad-plugin')
  return { healthBootId: health?.bootId ?? null, artifacts: (health?.artifacts ?? []).map(a => [a.id, a.activated, a.evidence]), badWarning, probeLines: log.join('').split('\n').filter(l => l.includes('evolution-probe')).length }
}

const disabled = await boot('disabled', 4670, true)
const enabled = await boot('enabled', 4671, false)
// Variant C: the recovery path actually used now — disable row in the PROFILE's
// own patch layer, no --patch flag.
const profilePatch = join(HOME, 'profiles/evo-main/cordis.patch.yml')
const original = readFileSync(profilePatch, 'utf8')
writeFileSync(profilePatch, `${original.replace(/\n+$/, '')}\n- id: bad-plugin\n  disabled: true\n`)
const profileLayer = await boot('profile-layer', 4672, false)
writeFileSync(profilePatch, original) // restore
console.log(JSON.stringify({ overlayDisabledBadPlugin: disabled, badPluginActive: enabled, profileLayerDisabledBadPlugin: profileLayer }, null, 1))
const fmt = (r) => r.artifacts.find(([id]) => id === 'good-plugin')?.[2] ?? 'no-health'
console.log(`VERDICT: --patch-overlay → ${fmt(disabled)}; bad-active → ${fmt(enabled)}; profile-layer-disable → ${fmt(profileLayer)}`)
