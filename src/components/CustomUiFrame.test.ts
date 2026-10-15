/** @vitest-environment jsdom */
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BrowserStorageService } from '../services/BrowserStorageService'
import { createUiView } from '../core/UiCustomization'
import { customUiSourceKey, compileCustomUiView } from '../services/UiCustomizationService'

const { documentSource } = vi.hoisted(() => ({ documentSource: vi.fn(() => '') }))
vi.mock('../services/UiCustomizationService', async (load) => ({
  ...(await load<typeof import('../services/UiCustomizationService')>()),
  compileCustomUiView: vi.fn(async () => ''),
}))
vi.mock('../services/UiViewRuntime', () => ({ createUiViewDocument: documentSource }))
import CustomUiFrame from './CustomUiFrame.vue'

enableAutoUnmount(afterEach)
beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

it('只由全局设置授权联网，旧主题字段不能放行；开关变更重建运行容器', async () => {
  const view = { ...createUiView(), allowNetwork: true }
  mount(CustomUiFrame, { props: { view, snapshot: { html: '', controls: [], theme: 'light' } } })
  await flushPromises()
  expect(documentSource).toHaveBeenLastCalledWith('', false)
  const storage = new BrowserStorageService()
  storage.setPreviewPolicy({ allowScripts: false, allowRemoteResources: true })
  await flushPromises()
  expect(documentSource).toHaveBeenLastCalledWith('', true)
  storage.setPreviewPolicy({ allowScripts: false, allowRemoteResources: false })
  await flushPromises()
  expect(documentSource).toHaveBeenLastCalledWith('', false)
  expect(view.allowNetwork).toBe(true)
})
it('复用已核对编译结果；不匹配源码时重新编译，不因准备过旧代码误报成功', async () => {
  const view = createUiView()
  const wrapper = mount(CustomUiFrame, {
    props: {
      view,
      snapshot: { html: '', controls: [], theme: 'light' },
      prepared: { key: customUiSourceKey(view), source: 'PREPARED' },
    },
  })
  await flushPromises()
  expect(compileCustomUiView).not.toHaveBeenCalled()
  expect(documentSource).toHaveBeenLastCalledWith('PREPARED', false)
  await wrapper.setProps({
    view: { ...view, files: [{ ...view.files[0]!, contents: '<template>改动</template>' }] },
  })
  await flushPromises()
  expect(compileCustomUiView).toHaveBeenCalledOnce()
})
it.each([false, true])(
  '实际首帧才报告ready；恢复入口仅给正式宿主，迟到回执不复活（recovery=%s）',
  async (recovery) => {
    let port!: {
      onmessage?: (event: { data: object }) => void
      postMessage: ReturnType<typeof vi.fn>
      start: ReturnType<typeof vi.fn>
      close: ReturnType<typeof vi.fn>
    }
    vi.stubGlobal(
      'MessageChannel',
      class {
        port1 = (port = { postMessage: vi.fn(), start: vi.fn(), close: vi.fn() })
        port2 = {}
      },
    )
    const onReady = vi.fn()
    const onRecovery = vi.fn()
    const wrapper = mount(CustomUiFrame, {
      attachTo: document.body,
      props: {
        view: createUiView(),
        snapshot: { html: '', controls: [], theme: 'light' },
        onReady,
        recovery,
        onRecovery,
      },
    })
    await flushPromises()
    const frame = wrapper.get<HTMLIFrameElement>('iframe').element
    const post = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {})
    window.dispatchEvent(
      new MessageEvent('message', { source: frame.contentWindow, data: { type: 'srl:ui-ready' } }),
    )
    const nonce = (post.mock.calls[0]![0] as { nonce: string }).nonce
    port.onmessage!({ data: { type: 'ready', nonce } })
    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'recovery-gesture',
      nonce,
      enabled: recovery,
    })
    port.onmessage!({ data: { type: 'reveal-recovery', nonce } })
    expect(onRecovery).not.toHaveBeenCalled()
    expect(wrapper.emitted('ready')).toBeUndefined()
    port.onmessage!({ data: { type: 'rendered', nonce } })
    port.onmessage!({ data: { type: 'rendered', nonce } })
    expect(wrapper.emitted('ready')).toHaveLength(1)
    port.onmessage!({ data: { type: 'reveal-recovery', nonce: 'wrong' } })
    expect(onRecovery).not.toHaveBeenCalled()
    port.onmessage!({ data: { type: 'reveal-recovery', nonce } })
    expect(onRecovery).toHaveBeenCalledTimes(recovery ? 1 : 0)
    wrapper.unmount()
    port.onmessage!({ data: { type: 'rendered', nonce } })
    expect(onReady).toHaveBeenCalledOnce()
    port.onmessage!({ data: { type: 'reveal-recovery', nonce } })
    expect(onRecovery).toHaveBeenCalledTimes(recovery ? 1 : 0)
    vi.unstubAllGlobals()
  },
)
