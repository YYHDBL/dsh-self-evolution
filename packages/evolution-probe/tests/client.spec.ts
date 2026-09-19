// @vitest-environment jsdom

import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/src/client/slots.ts'
import { describe, expect, it } from 'vitest'
import * as EvolutionProbeClient from '../src/client/index.ts'

describe('evolution probe client plugin', () => {
  it('shows and removes the persistent recording status with its plugin lifecycle', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({
      name: 'root',
      children: {
        'conversation.composer.dock': { kind: 'list', scope: 'session' },
      },
    } as never, () => null)

    const fiber = ctx.plugin(EvolutionProbeClient)
    await fiber.await()
    const entry = slots.entries('conversation.composer.dock').find(item => item.options.id === 'evolution-recording')
    expect(entry).toBeDefined()
    const element = (entry!.component as () => { type: unknown; props: Record<string, unknown> })()
    expect(element.type).toBe('strong')
    expect(element.props).toMatchObject({ role: 'status', children: '自进化：记录中' })

    await fiber.dispose()
    expect(slots.entries('conversation.composer.dock')).toHaveLength(0)
  })
})
