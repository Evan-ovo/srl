/** @vitest-environment jsdom */
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const api = vi.hoisted(() => ({ begin: vi.fn(), native: vi.fn(), android: false, running: false }))
vi.mock('../core/LocalDataReset', () => ({
  beginLocalDataReset: api.begin,
  LOCAL_DATA_RESET_PHRASE: '我已了解到该操作会清除srl的数据，并确保我的确想这么做。',
}))
vi.mock('../core/PlatformService', () => ({
  platform: {
    update: { isAndroidApk: () => api.android },
    maintenance: { clearLocalData: api.native },
  },
}))
vi.mock('../core/TaskCenter', () => ({
  taskCenter: { list: () => (api.running ? [{ status: 'running' }] : []) },
}))
import LocalDataResetControls from './LocalDataResetControls.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import { useConfirmDialogState } from '../composables/UseConfirmDialog'
const phrase = '我已了解到该操作会清除srl的数据，并确保我的确想这么做。'
const state = useConfirmDialogState()
beforeEach(() => {
  vi.clearAllMocks()
  api.android = false
  api.running = false
})
afterEach(() => {
  while (state.activeDialog.value) state.respond('cancel')
})
describe('factory reset settings control', () => {
  it('makes neither destructive call after either cancelled confirmation or incomplete text', async () => {
    const view = mount(LocalDataResetControls)
    await view.get('button').trigger('click')
    state.respond('cancel')
    await flushPromises()
    expect(api.begin).not.toHaveBeenCalled()
    await view.get('button').trigger('click')
    state.respond('confirm')
    await flushPromises()
    expect(state.activeDialog.value?.requiredText).toBe(phrase)
    state.respond('confirm', '我已了解')
    await flushPromises()
    expect(api.begin).not.toHaveBeenCalled()
    state.respond('cancel')
    await flushPromises()
    expect(api.native).not.toHaveBeenCalled()
    view.unmount()
  })
  it.each([false, true])('starts only after both confirmations (Android: %s)', async (android) => {
    api.android = android
    const view = mount(LocalDataResetControls)
    await view.get('button').trigger('click')
    state.respond('confirm')
    await flushPromises()
    state.respond('confirm', phrase.toUpperCase())
    await flushPromises()
    expect(android ? api.native : api.begin).toHaveBeenCalledWith(phrase)
    expect(android ? api.begin : api.native).not.toHaveBeenCalled()
    view.unmount()
  })
  it('checks running tasks again before deleting and does not leave an unmounted confirmation live', async () => {
    const view = mount(LocalDataResetControls)
    await view.get('button').trigger('click')
    state.respond('confirm')
    await flushPromises()
    api.running = true
    state.respond('confirm', phrase)
    await flushPromises()
    expect(view.text()).toContain('请先在“任务与通知”')
    expect(api.begin).not.toHaveBeenCalled()
    api.running = false
    await view.get('button').trigger('click')
    view.unmount()
    await flushPromises()
    expect(state.activeDialog.value).toBeUndefined()
  })
  it('renders the actual manual entry dialog without authorizing a pasted incomplete value', async () => {
    const controls = mount(LocalDataResetControls),
      dialog = mount(ConfirmDialog, { attachTo: document.body })
    await controls.get('button').trigger('click')
    state.respond('confirm')
    await flushPromises()
    const input = document.querySelector<HTMLTextAreaElement>('textarea')!
    expect(input).toBeTruthy()
    expect(document.querySelector<HTMLButtonElement>('.confirm-dialog__confirm')!.disabled).toBe(
      true,
    )
    controls.unmount()
    dialog.unmount()
    await flushPromises()
  })
})
