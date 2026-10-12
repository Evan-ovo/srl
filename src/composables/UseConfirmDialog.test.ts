import { describe, expect, it } from 'vitest'
import { chooseAction, confirmAction, useConfirmDialogState } from './UseConfirmDialog'
describe('cancellable confirmations', () => {
  it('cancels active and queued choices without closing unrelated dialogs or retaining listeners', async () => {
    const state = useConfirmDialogState()
    const active = new AbortController(),
      queued = new AbortController(),
      completed = new AbortController()
    const options = {
      message: 'existing connection',
      alternativeLabel: 'new connection',
      centered: true,
    }
    const a = chooseAction({ ...options, title: 'active' }, active.signal)
    const b = chooseAction({ ...options, title: 'queued' }, queued.signal)
    const c = chooseAction({ ...options, title: 'completed' }, completed.signal)
    queued.abort()
    await expect(b).resolves.toBe('cancel')
    expect(state.activeDialog.value?.title).toBe('active')
    active.abort()
    await expect(a).resolves.toBe('cancel')
    expect(state.activeDialog.value?.title).toBe('completed')
    state.respond('alternative')
    await expect(c).resolves.toBe('alternative')
    const unrelated = confirmAction({ title: 'unrelated', message: 'other' })
    completed.abort()
    expect(state.activeDialog.value?.title).toBe('unrelated')
    state.respond('cancel')
    await unrelated
    await expect(chooseAction(options, active.signal)).resolves.toBe('cancel')
    expect(state.activeDialog.value).toBeUndefined()
  })
  it('cancels only its own active/queued dialog and removes completed abort listeners', async () => {
    const state = useConfirmDialogState()
    const first = new AbortController(),
      queued = new AbortController()
    const a = confirmAction({ title: 'first', message: 'a' }, first.signal)
    const b = confirmAction({ title: 'queued', message: 'b' }, queued.signal)
    const c = confirmAction({ title: 'last', message: 'c' })
    queued.abort()
    await expect(b).resolves.toBe(false)
    expect(state.activeDialog.value?.title).toBe('first')
    first.abort()
    await expect(a).resolves.toBe(false)
    expect(state.activeDialog.value?.title).toBe('last')
    state.respond('confirm')
    await expect(c).resolves.toBe(true)
    const completed = new AbortController()
    const d = confirmAction({ message: 'd' }, completed.signal)
    state.respond('confirm')
    await expect(d).resolves.toBe(true)
    const e = confirmAction({ title: 'unrelated', message: 'e' })
    completed.abort()
    expect(state.activeDialog.value?.title).toBe('unrelated')
    state.respond('cancel')
    await expect(e).resolves.toBe(false)
    await expect(confirmAction({ message: 'never' }, first.signal)).resolves.toBe(false)
    expect(state.activeDialog.value).toBeUndefined()
  })
})
