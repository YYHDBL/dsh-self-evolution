import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session'

export interface Config {
  path: string
}

export const name = 'evolution-probe'
export const inject = ['sessions']

export function apply(ctx: Context, config: Config): void {
  if (!isAbsolute(config.path)) throw new Error('evolution-probe: path must be absolute')
  mkdirSync(dirname(config.path), { recursive: true })
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    appendFileSync(config.path, `${JSON.stringify({
      sessionId: session.id,
      event: event.type,
      seq: event.seq,
      time: event.time,
    })}\n`)
  })
}
