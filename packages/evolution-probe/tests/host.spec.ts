import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as EvolutionProbe from '../index.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true })
})

describe('evolution probe host plugin (shipped artifact)', () => {
  it('appends one minimal record for turn/end only', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'evolution-probe-'))
    temporaryDirectories.push(directory)
    const output = join(directory, 'turns.jsonl')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(EvolutionProbe, { path: output })

    const session = ctx.sessions.create(SessionId('probe-session'))
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    expect(readFileSync(output, 'utf8').trim().split('\n').map(JSON.parse)).toEqual([{
      sessionId: 'probe-session',
      event: 'turn/end',
      seq: 1,
      time: expect.any(Number),
    }])
  })

  it('a failing probe does not take down the session context', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = ctx.plugin(EvolutionProbe, { path: 'relative/path/turns.jsonl' })
    await expect(fiber.await()).rejects.toThrow(/absolute/)
    const session = ctx.sessions.create(SessionId('still-alive'))
    expect(() => session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })).not.toThrow()
  })
})
