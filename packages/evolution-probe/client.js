window.__ModuleLoader__.load({
  id: '@self-evolving/evolution-probe',
  factory(require) {
    const React = require('react')

    function RecordingStatus() {
      return React.createElement('strong', { role: 'status' }, '自进化：记录中')
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'evolution-recording',
          order: 100,
        }, RecordingStatus))
      },
    }
  },
})
