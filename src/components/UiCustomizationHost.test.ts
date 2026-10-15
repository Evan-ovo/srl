/** @vitest-environment jsdom */
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { BrowserStorageService } from '../services/BrowserStorageService'
import { createUiView } from '../core/UiCustomization'
import { useCustomUiViews } from '../composables/UseCustomUiViews'
import CustomUiFrame from './CustomUiFrame.vue'
import UiCustomizationHost from './UiCustomizationHost.vue'

vi.mock('./CustomUiFrame.vue', () => ({
  default: defineComponent({
    props: {
      view: { type: Object, required: true },
      snapshot: { type: Object, required: true },
      css: { type: String, default: '' },
      invoke: { type: Function, required: true },
      recovery: Boolean,
    },
    emits: ['ready', 'error', 'native', 'recovery'],
    setup: () => () => h('div', { 'data-test-frame': '' }),
  }),
}))
enableAutoUnmount(afterEach)
beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = '<main class="app-shell"><button>原操作</button></main>'
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

it('运行失败后停用当前运行源码且保留全部文件，原预设可不改代码重新应用', async () => {
  const storage = new BrowserStorageService()
  const shell = { ...createUiView(), enabled: true }
  storage.setCustomUiViews({ shell })
  const wrapper = mount(
    defineComponent({
      setup() {
        const views = useCustomUiViews()
        return () => h(UiCustomizationHost, { views: views.value })
      },
    }),
    { attachTo: document.body },
  )
  await flushPromises()
  wrapper.getComponent(CustomUiFrame).vm.$emit('ready')
  await flushPromises()
  expect(document.querySelector('.app-shell')!.classList.contains('srl-ui-controller-hidden')).toBe(
    true,
  )
  const before = storage.getCustomUiViews()
  wrapper.getComponent(CustomUiFrame).vm.$emit('recovery')
  await flushPromises()
  expect(
    document
      .querySelector('#srl-custom-ui-rescue')!
      .shadowRoot!.querySelector('.ui-recovery-button')!.textContent,
  ).toBe('恢复原界面')
  expect(storage.getCustomUiViews()).toEqual(before)
  wrapper.getComponent(CustomUiFrame).vm.$emit('error', '运行失败')
  await flushPromises()
  expect(document.querySelector('.app-shell')!.classList.contains('srl-ui-controller-hidden')).toBe(
    false,
  )
  expect(storage.getCustomUiViews().shell).toEqual({ ...shell, enabled: false })
  storage.setCustomUiViews({ shell })
  await flushPromises()
  expect(wrapper.findComponent(CustomUiFrame).exists()).toBe(true)
  wrapper.getComponent(CustomUiFrame).vm.$emit('ready')
  await flushPromises()
  expect(document.querySelector('.srl-custom-ui-surface.is-ready')).not.toBeNull()
  wrapper.unmount()
})
