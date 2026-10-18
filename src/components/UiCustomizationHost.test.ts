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
    emits: ['ready', 'error', 'native', 'layout', 'recovery'],
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

it('宿主滚动高度随内容收缩，退出或失败恢复原滚动位置与真实控件', async () => {
  const root = document.querySelector<HTMLElement>('.app-shell')!
  const original = root.firstElementChild
  Object.defineProperty(root, 'clientHeight', { configurable: true, value: 844 })
  root.scrollTop = 9
  root.scrollLeft = 3
  const wrapper = mount(UiCustomizationHost, {
    attachTo: document.body,
    props: { views: { shell: { ...createUiView(), enabled: true } } },
  })
  await flushPromises()
  const frame = wrapper.getComponent(CustomUiFrame)
  frame.vm.$emit('ready')
  await flushPromises()
  frame.vm.$emit('layout', 1800)
  await flushPromises()
  expect(root.dataset.srlCustomScroll).toBe('host')
  expect(document.querySelector<HTMLElement>('.srl-custom-ui-surface')!.style.height).toBe('1800px')
  root.scrollTop = 400
  frame.vm.$emit('layout', 320)
  await flushPromises()
  expect(document.querySelector<HTMLElement>('.srl-custom-ui-surface')!.style.height).toBe('844px')
  frame.vm.$emit('layout', null)
  await flushPromises()
  expect(root.dataset.srlCustomScroll).toBeUndefined()
  expect(root.scrollTop).toBe(9)
  expect(root.scrollLeft).toBe(3)
  frame.vm.$emit('layout', 1200)
  root.scrollTop = 200
  frame.vm.$emit('error', '运行失败')
  await flushPromises()
  expect(root.dataset.srlCustomScroll).toBeUndefined()
  expect(root.scrollTop).toBe(9)
  expect(root.firstElementChild).toBe(original)
  wrapper.unmount()
})
it('旋转缩短视口时按作者自然高度重新计算表面，不保留旧视口的空白', async () => {
  let resized!: () => void
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resized = callback
      }
      observe() {}
      disconnect() {}
    },
  )
  const root = document.querySelector<HTMLElement>('.app-shell')!
  let height = 844
  Object.defineProperty(root, 'clientHeight', { configurable: true, get: () => height })
  const wrapper = mount(UiCustomizationHost, {
    attachTo: document.body,
    props: { views: { shell: { ...createUiView(), enabled: true } } },
  })
  await flushPromises()
  wrapper.getComponent(CustomUiFrame).vm.$emit('ready')
  wrapper.getComponent(CustomUiFrame).vm.$emit('layout', 800)
  await flushPromises()
  expect(document.querySelector<HTMLElement>('.srl-custom-ui-surface')!.style.height).toBe('844px')
  height = 430
  resized()
  await flushPromises()
  expect(document.querySelector<HTMLElement>('.srl-custom-ui-surface')!.style.height).toBe('800px')
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

it('可见矩形限制原控件的裁切/遮挡；旧协议、无效数据和卸载恢复原样式', async () => {
  const root = document.querySelector<HTMLElement>('.app-shell')!
  root.innerHTML = '<canvas style="clip-path: inset(2px); color: red"></canvas>'
  const node = root.querySelector('canvas')!
  const original = node.getAttribute('style')
  const wrapper = mount(UiCustomizationHost, {
    attachTo: document.body,
    props: { views: { shell: { ...createUiView(), enabled: true } } },
  })
  await flushPromises()
  const frame = wrapper.getComponent(CustomUiFrame)
  frame.vm.$emit('ready')
  await flushPromises()
  const snapshot = frame.props('snapshot')
  const placement = {
    id: snapshot.nativeRegions![0]!.id,
    top: 10,
    left: 20,
    width: 100,
    height: 80,
  }
  frame.vm.$emit('native', [
    { ...placement, visibleRects: [{ top: 0, left: 0, width: 100, height: 30 }] },
  ])
  expect(node.style.clipPath).toContain('M0 0h100v30h-100Z')
  expect(node.style.visibility).toBe('visible')
  frame.vm.$emit('native', [{ ...placement, visibleRects: [] }])
  expect(node.style.visibility).toBe('hidden')
  frame.vm.$emit('native', [placement])
  expect(node.style.visibility).toBe('visible')
  expect(node.style.clipPath).toBe('inset(2px)')
  frame.vm.$emit('native', [
    { ...placement, visibleRects: [{ top: NaN, left: 0, width: 5, height: 5 }] },
    null,
  ])
  expect(node.getAttribute('style')).toBe(original)
  frame.vm.$emit('native', [
    {
      ...placement,
      visibleRects: [
        { top: 0, left: 0, width: 30, height: 80 },
        { top: 0, left: 60, width: 40, height: 80 },
      ],
    },
  ])
  expect(node.style.clipPath).toContain('M60 0h40v80h-40Z')
  wrapper.unmount()
  expect(root.querySelector('canvas')).toBe(node)
  expect(node.getAttribute('style')).toBe(original)
  expect(root.querySelector('[data-srl-native-anchor]')).toBeNull()
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
