/** @vitest-environment jsdom */
import { DOMWrapper, enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BrowserStorageService } from '../services/BrowserStorageService'
import { createUiView } from '../core/UiCustomization'
import { compileAppearancePreset } from '../core/AppearanceScopes'
import { useConfirmDialogState } from '../composables/UseConfirmDialog'
import { SRL_BACK_REQUEST_EVENT } from '../composables/UseBackStack'
import type { CustomCssPreset } from '../types/BrowserPreferences'
import type { CustomUiViews } from '../types/UiCustomization'
import AppearanceQuickMenu from './AppearanceQuickMenu.vue'

enableAutoUnmount(afterEach)
const storage = new BrowserStorageService()
const consent = useConfirmDialogState()
const cssPreset: CustomCssPreset = {
  id: 'css',
  name: '库里的CSS',
  globalCss: ':root{--quick-menu-probe:yes}',
  scopedCss: {},
  createdAt: '2026-10-15T00:00:00Z',
  updatedAt: '2026-10-15T00:00:00Z',
}
const vuePreset: CustomCssPreset = {
  ...cssPreset,
  id: 'vue',
  name: '库里的Vue',
  views: { shell: { ...createUiView(), enabled: true } },
}
beforeEach(() => {
  localStorage.clear()
  storage.setCustomUiPresets([cssPreset, vuePreset])
  storage.setActiveCustomUiPresetId('vue')
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.open = true
      },
    },
    close: {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.open = false
      },
    },
  })
})
afterEach(() => {
  consent.respond('cancel')
  vi.restoreAllMocks()
})
async function open(views: CustomUiViews = {}) {
  const wrapper = mount(AppearanceQuickMenu, { props: { views } })
  await flushPromises()
  const dialog = new DOMWrapper(
    document.getElementById('srl-appearance-quick-menu')!.shadowRoot!.querySelector('dialog')!,
  )
  return { wrapper, dialog }
}

it('即使Vue关闭也展示实际预设库与当前选项，切换CSS关闭菜单再交给原试用Owner', async () => {
  const { wrapper, dialog } = await open()
  expect(dialog.element.open).toBe(true)
  expect(dialog.findAll('option').map((option) => option.text())).toContain(cssPreset.name)
  expect(dialog.get('select').element.value).toBe('vue')
  expect(dialog.get('footer button').attributes('disabled')).toBeDefined()
  const before = storage.getCustomUiPresets()
  await dialog.get('select').setValue('css')
  await dialog.get('[data-apply-preset]').trigger('click')
  await flushPromises()
  expect(consent.activeDialog.value).toBeUndefined()
  expect(dialog.element.open).toBe(false)
  expect(wrapper.emitted('close')).toHaveLength(1)
  expect(wrapper.emitted('save-css')).toEqual([
    [compileAppearancePreset(cssPreset), { presetId: 'css', views: {} }],
  ])
  expect(storage.getCustomUiPresets()).toEqual(before)
})

it.each(['cancel', 'confirm'] as const)('含Vue的库预设先确认：%s', async (response) => {
  const { wrapper, dialog } = await open()
  await dialog.get('[data-apply-preset]').trigger('click')
  expect(consent.activeDialog.value?.title).toBe('应用自定义界面')
  expect(wrapper.emitted('save-css')).toBeUndefined()
  consent.respond(response)
  await flushPromises()
  if (response === 'confirm') {
    expect(wrapper.emitted('save-css')).toEqual([
      [compileAppearancePreset(vuePreset), { presetId: 'vue', views: vuePreset.views }],
    ])
  } else {
    expect(wrapper.emitted('save-css')).toBeUndefined()
    expect(dialog.element.open).toBe(true)
    expect(storage.getActiveCustomUiPresetId()).toBe('vue')
  }
})

it('关闭或卸载菜单取消待决脚本确认，迟到同意不应用', async () => {
  const { wrapper, dialog } = await open()
  await dialog.get('[data-apply-preset]').trigger('click')
  expect(consent.activeDialog.value).toBeDefined()
  wrapper.unmount()
  consent.respond('confirm')
  await flushPromises()
  expect(wrapper.emitted('save-css')).toBeUndefined()
  expect(document.getElementById('srl-appearance-quick-menu')).toBeNull()
  expect(consent.activeDialog.value).toBeUndefined()
})

it.each([
  ['vue', 0],
  ['default', 1],
] as const)('安全退出%s仅交给既有Owner，不改写预设库', async (mode, index) => {
  const { wrapper, dialog } = await open(vuePreset.views)
  await dialog.findAll('footer button')[index]!.trigger('click')
  expect(wrapper.emitted('save-css')).toEqual([['', { recovery: mode }]])
  expect(storage.getCustomUiPresets()).toHaveLength(2)
})

it('选中项已被删除时刷新库并提示，不应用旧快照', async () => {
  const { wrapper, dialog } = await open()
  storage.setCustomUiPresets([cssPreset])
  await dialog.get('[data-apply-preset]').trigger('click')
  await flushPromises()
  expect(dialog.get('[role="alert"]').text()).toContain('已不存在')
  expect(wrapper.emitted('save-css')).toBeUndefined()
  expect(dialog.findAll('option').some((option) => option.text() === vuePreset.name)).toBe(false)
})

it('空库仍可恢复默认，返回键只关闭菜单且不改外观', async () => {
  storage.setCustomUiPresets([])
  storage.setActiveCustomUiPresetId('')
  const { wrapper, dialog } = await open()
  expect(dialog.get('select').attributes('disabled')).toBeDefined()
  expect(dialog.get('[data-apply-preset]').attributes('disabled')).toBeDefined()
  expect(dialog.findAll('footer button')[1]!.attributes('disabled')).toBeUndefined()
  const detail = { handled: false }
  window.dispatchEvent(new CustomEvent(SRL_BACK_REQUEST_EVENT, { detail }))
  expect(detail.handled).toBe(true)
  expect(wrapper.emitted('close')).toHaveLength(1)
  expect(wrapper.emitted('save-css')).toBeUndefined()
})
