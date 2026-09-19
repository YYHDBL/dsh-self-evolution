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
    const writeHealth = () => {
      try {
        const artifacts = [{ id: 'evolution-probe', kind: 'plugin', expected: true, activated: true, evidence: 'self-active' }]
        const control = join(stateDir, 'control.json')
        if (existsSync(control)) {
          const parsed = JSON.parse(readFileSync(control, 'utf8'))
          for (const entry of parsed.baseline?.entries ?? []) {
            if (entry.kind === 'plugin') {
              let activated = false
              let evidence = 'activation-unknown'
              try {
                const pm = ctx.get('pluginManager')
                const found = pm ? (pm.listPlugins?.() ?? []).find(p => p.id === entry.id || p.name === entry.id) : undefined
                activated = Boolean(found && found.status !== 'failed')
                evidence = found ? `pluginManager:${found.status ?? 'loaded'}` : 'not-listed'
              } catch { evidence = 'pluginManager-unavailable' }
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
            let activated = false
            let evidence = 'activation-unknown'
            try {
              const pm = ctx.get('pluginManager')
              const found = pm ? (pm.listPlugins?.() ?? []).find(p => p.id === trial.candidateId || p.name === trial.candidateId) : undefined
              activated = Boolean(found && found.status !== 'failed')
              evidence = found ? `pluginManager:${found.status ?? 'loaded'}` : 'not-listed'
            } catch { evidence = 'pluginManager-unavailable' }
            artifacts.push({ id: trial.candidateId, kind: 'plugin', expected: true, activated, evidence, trial: true })
          }
        }
        writeFileSync(healthPath, JSON.stringify({ bootId, atUtc: new Date().toISOString(), artifacts }))
      } catch (error) {
        console.error(`evolution-probe: health write failed: ${error.message}`)
      }
    }
    writeHealth()
    const timer = setInterval(writeHealth, 5000)
    ctx.on('dispose', () => clearInterval(timer))
  }

  // B3: on-demand worker spawn via the request file (web-command channel noted
  // as UNVERIFIED; the file channel is the operator/CLI path).
  if (stateDir) {
    const requestPath = join(stateDir, 'worker-request.json')
    let spawning = false
    const tick = async () => {
      if (spawning || !existsSync(requestPath)) return
      spawning = true
      try {
        const worker = join(dirname(dirname(fileURLToPath(import.meta.url))), 'scripts', 'evolution-worker.mjs')
        if (!existsSync(worker)) return
        rmSync(requestPath)
        const child = spawn(process.execPath, [worker, 'run', '--state-dir', stateDir], { stdio: 'ignore' })
        child.unref()
        const lockPath = join(stateDir, 'worker.lock')
        try { writeFileSync(lockPath + '.spawn', JSON.stringify({ pid: child.pid, spawnedBy: 'evolution-probe', atUtc: new Date().toISOString() })) } catch { /* informational */ }
      } catch (error) {
        console.error(`evolution-probe: worker spawn failed: ${error.message}`)
      } finally { spawning = false }
    }
    const timer = setInterval(tick, 2000)
    ctx.on('dispose', () => clearInterval(timer))
  }
}

