import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

export const name = 'evolution-probe'
export const inject = ['sessions']

export function apply(ctx, config) {
  if (!isAbsolute(config.path)) throw new Error('evolution-probe: path must be absolute')
  mkdirSync(dirname(config.path), { recursive: true })
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    // Record-write failures must never break the observed session (采集失败不影响正常任务).
    try {
      appendFileSync(config.path, `${JSON.stringify({
        sessionId: session.id,
        event: event.type,
        seq: event.seq,
        time: event.time,
      })}\n`)
    } catch (error) {
      console.error(`evolution-probe: record write failed (session ${session.id}, seq ${event.seq}): ${error.code ?? error.message}`)
    }
  })

  const stateDir = process.env.EVO_STATE_DIR
  const bootId = process.env.DSH_BOOT_ID

  // B4: launcher health record — per-instance expected artifacts; the probe itself
  // proves its own activation; managed plugin entries are checked against the
  // control file; memory/skill/config artifacts compare on-disk sha256 vs digest.
  if (stateDir && bootId) {
    const healthPath = join(stateDir, 'launcher-health.json')
    let healthDeferredCount = 0
    // Upstream PluginInfo: { entryId, moduleName, enabled, fiberPhase:
    // 'pending'|'loading'|'active'|'failed'|'unloading'|null } — no id/name/status fields.
    const pluginStatus = async (id) => {
      try {
        const pm = ctx.get('pluginManager')
        if (!pm?.listPlugins) return { activated: false, evidence: 'pluginManager-unavailable' }
        const plugins = await pm.listPlugins()
        const found = plugins.find(p => p.entryId === id || p.moduleName === id || p.moduleName?.endsWith(`/${id}`) || p.moduleName?.startsWith(`${id}/`))
        if (!found) return { activated: false, evidence: 'not-listed' }
        const activated = found.enabled === true && found.fiberPhase === 'active'
        return { activated, evidence: `pluginManager:enabled=${found.enabled},fiberPhase=${String(found.fiberPhase)}` }
      } catch { return { activated: false, evidence: 'pluginManager-unavailable' } }
    }
    const writeHealth = async () => {
      try {
        const artifacts = [{ id: 'evolution-probe', kind: 'plugin', expected: true, activated: true, evidence: 'self-active' }]
        const control = join(stateDir, 'control.json')
        let parsed = null
        try { parsed = JSON.parse(readFileSync(control, 'utf8')) }
        catch (error) {
          if (existsSync(control)) {
            // Corrupt control file: the launcher started an empty managed set;
            // health must reflect that (empty expected set), not abort entirely.
            artifacts.push({ id: '(control-file)', kind: 'config', expected: false, activated: false, evidence: `control-corrupt: ${error.message}` })
          }
        }
        if (parsed) {
          for (const entry of parsed.baseline?.entries ?? []) {
            if (entry.kind === 'plugin') {
              const { activated, evidence } = await pluginStatus(entry.id)
              artifacts.push({ id: entry.id, kind: entry.kind, expected: true, activated, evidence })
            } else {
              let activated = false
              let evidence = 'missing'
              try {
                activated = createHash('sha256').update(readFileSync(entry.path)).digest('hex') === entry.digest
                evidence = activated ? 'digest-matched' : 'digest-mismatch'
              } catch { /* missing */ }
              artifacts.push({ id: entry.id, kind: entry.kind, expected: true, activated, evidence })
            }
          }
          // An active trial candidate is part of THIS instance's expected set.
          const trial = parsed.activeTrial
          if (trial && trial.status === 'active') {
            const { activated, evidence } = await pluginStatus(trial.candidateId)
            artifacts.push({ id: trial.candidateId, kind: 'plugin', expected: true, activated, evidence, trial: true })
          }
        }
        // Readiness gate: a plugin-kind check that could not even reach
        // pluginManager is a TRANSIENT (services still starting), not an
        // activation failure. Publishing it would make the launcher wrongly
        // quarantine healthy artifacts — so this round writes nothing and the
        // next heartbeat retries. If the service never comes up, the
        // launcher's health timeout (not a false verdict) is the honest result.
        if (artifacts.some(a => a.evidence === 'pluginManager-unavailable')) {
          healthDeferredCount += 1
          if (healthDeferredCount <= 6) { // ~30s at 5s heartbeats: startup transients resolve well within this
            console.error(`evolution-probe: health not ready (pluginManager unavailable, try ${healthDeferredCount}); deferring write`)
            return
          }
          console.error('evolution-probe: pluginManager unavailable beyond transient window — publishing with unavailable evidence (real absence, not silence)')
        } else {
          healthDeferredCount = 0
        }
        writeFileSync(healthPath, JSON.stringify({ bootId, atUtc: new Date().toISOString(), artifacts }))
      } catch (error) {
        console.error(`evolution-probe: health write failed: ${error.message}`)
      }
    }
    void writeHealth()
    const timer = setInterval(() => { void writeHealth() }, 5000)
    ctx.on('dispose', () => clearInterval(timer))
  }

  // B3: on-demand worker spawn via the request file (web-command channel noted
  // as UNVERIFIED; the file channel is the operator/CLI path).
  if (stateDir) {
    const requestPath = join(stateDir, 'worker-request.json')
    let spawning = false
    let lastRequestId = null
    const tick = async () => {
      if (spawning) return
      let request
      try { request = JSON.parse(readFileSync(requestPath, 'utf8')) } catch { return } // absent/torn: nothing to do
      if (!request?.requestId || request.requestId === lastRequestId) return // only NEW requests; the WORKER consumes the file
      spawning = true
      lastRequestId = request.requestId
      try {
        // packages/evolution-probe/index.js → three dirnames reach the project root
        const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
        const worker = join(root, 'scripts', 'evolution-worker.mjs')
        if (!existsSync(worker)) {
          console.error(`evolution-probe: worker script missing at ${worker} — request ${request.requestId} NOT served`)
          return
        }
        const child = spawn(process.execPath, [worker, 'run', '--state-dir', stateDir], { stdio: 'ignore' })
        child.unref()
        const lockPath = join(stateDir, 'worker.lock')
        try { writeFileSync(lockPath + '.spawn', JSON.stringify({ pid: child.pid, requestId: request.requestId, spawnedBy: 'evolution-probe', atUtc: new Date().toISOString() })) } catch { /* informational */ }
      } catch (error) {
        console.error(`evolution-probe: worker spawn failed: ${error.message}`)
      } finally { spawning = false }
    }
    const timer = setInterval(tick, 2000)
    ctx.on('dispose', () => clearInterval(timer))
  }
}

