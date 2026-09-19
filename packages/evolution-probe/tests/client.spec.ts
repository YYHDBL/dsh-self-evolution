// @vitest-environment jsdom

import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/src/client/registry.ts'
import { describe, expect, it } from 'vitest'
import * as React from 'react'

describe('evolution probe client module (shipped artifact)', () => {
  it('registers and removes the persistent recording status with its plugin lifecycle', async () => {
    const loader = (window as unknown as { __ModuleLoader__?: { load: (m: unknown) => void } })
    let loaded: { id: string; factory: (require: (name: string) => unknown) => unknown } | undefined
    loader.__ModuleLoader__ = { load: (m) => { loaded = m as typeof loaded } }
    await import('../client.js')
    expect(loaded).toBeDefined()
    expect(loaded!.id).toBe('@self-evolving/evolution-probe')

    const moduleTable = (name: string) => {
      if (name === 'react') return React
      throw new Error(`test module table: unexpected require '${name}'`)
    }
    const clientPlugin = loaded!.factory(moduleTable) as { inject: string[]; apply: (ctx: Context) => void }

    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({
      name: 'root',
      children: {
        'conversation.composer.dock': { kind: 'list', scope: 'session' },
      },
    } as never, () => null)

    const fiber = ctx.plugin(clientPlugin)
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
