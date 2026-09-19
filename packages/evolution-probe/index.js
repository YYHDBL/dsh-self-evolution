import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'

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
}
