import { createElement } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

export const inject = ['slots']

export function RecordingStatus() {
  return createElement('strong', { role: 'status' }, '自进化：记录中')
}

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'evolution-recording',
    order: 100,
    label: '自进化记录状态',
  }, RecordingStatus))
}
