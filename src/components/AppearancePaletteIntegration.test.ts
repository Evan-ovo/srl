// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import AppearanceStudio from './AppearanceStudio.vue'
import AppearancePalette from './AppearancePalette.vue'
import { BrowserStorageService } from '../services/BrowserStorageService'
import type { AppearancePreviewRequest } from '../types/UiCustomization'

vi.mock('../core/OfficialAppRuntime', () => ({ officialAppService: { list: async () => [] } }))
vi.mock('../composables/UseConfirmDialog', () => ({ confirmAction: vi.fn(async () => true) }))
vi.mock('html-to-image', () => ({
  toBlob: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
}))
const wrappers: VueWrapper[] = []
beforeEach(() => {
  localStorage.clear()
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value() {
      this.open = true
    },
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value() {
      this.open = false
    },
  })
})
afterEach(() => wrappers.splice(0).forEach((wrapper) => wrapper.unmount()))
async function open() {
  const wrapper = mount(AppearanceStudio, {
    attachTo: document.body,
    props: { theme: 'light', layoutMode: 'grid', uiFontScale: 'standard', customCss: '' },
  })
  wrappers.push(wrapper)
  await wrapper.get('.appearance-palette-entry').trigger('click')
  await vi.waitFor(() => expect(wrapper.findComponent(AppearancePalette).exists()).toBe(true))
  await flushPromises()
  return wrapper
}
it('restores colors after reopening an unsaved initial preset without a stable preset UUID', async () => {
  const first = await open()
  await first.get('#e-hex').setValue('#54bcce')
  first.unmount()
  const second = await open()
  expect(second.get<HTMLInputElement>('#e-hex').element.value.toLowerCase()).toBe('#54bcce')
  expect(new BrowserStorageService().getAppearancePaletteDraft()?.sourceId).toBe('current')
})
it('imports a CSS file into the existing preset owner without applying it, then preserves imported layout when coloring and reopening', async () => {
  const wrapper = await open()
  const source =
    ':root { --color-canvas: #fff8fb; --button-primary-background: linear-gradient(135deg, #ac5278, #a14f76); --button-radius: .9rem; } .resource-card { padding: 3px; }'
  const file = new File([source], '粉樱.css', { type: 'text/css' })
  Object.defineProperty(file, 'text', { value: async () => source })
  Object.defineProperty(wrapper.get('#e-import-file').element, 'files', { value: [file] })
  await wrapper.get('#e-import-file').trigger('change')
  await flushPromises()
  const storage = new BrowserStorageService()
  expect(storage.getCustomUiPresets()).toHaveLength(1)
  expect(storage.getCustomUiPresets()[0]?.name).toBe('粉樱')
  expect(storage.getCustomUiPresets()[0]?.globalCss).toBe(source)
  expect(wrapper.emitted('save-css')).toBeUndefined()
  expect(wrapper.get<HTMLInputElement>('#e-hex').element.value.toLowerCase()).toBe('#fff8fb')
  expect(wrapper.get('#e-status').text()).toContain('2 项配色、1 类圆角')
  await wrapper.get('#e-group').setValue('形状')
  expect(wrapper.get<HTMLInputElement>('#e-radius').element.value).toBe('14.4')
  await wrapper.get('#e-group').setValue('按钮')
  expect(wrapper.get<HTMLInputElement>('#e-hex').element.value.toLowerCase()).toBe('#ac5278')
  await wrapper.get('#e-hex').setValue('#bb6699')
  await wrapper.get('#e-live-preview').trigger('click')
  await flushPromises()
  const request = wrapper.emitted('preview-css')?.at(-1)?.[0] as AppearancePreviewRequest
  expect(request.css).toContain(source)
  expect(request.css).toContain('rgba(187,102,153,1)')
  wrapper.unmount()
  const reopened = await open()
  expect(reopened.get<HTMLInputElement>('#e-hex').element.value.toLowerCase()).toBe('#bb6699')
})
it('adds generated CSS to the real preset library without overwriting old presets, and requests the original application path', async () => {
  const storage = new BrowserStorageService()
  const existing = {
    id: 'old',
    name: '原预设',
    globalCss: '',
    scopedCss: {},
    createdAt: '',
    updatedAt: '',
  }
  storage.setCustomUiPresets([existing])
  const wrapper = await open()
  await wrapper.get('#e-hex').setValue('#123456')
  await wrapper.get('#e-done').trigger('click')
  await wrapper.get('#e-save-preset').trigger('click')
  await wrapper.get('#e-preset-name').setValue('新配色')
  await wrapper.get('#e-preset-commit').trigger('click')
  await flushPromises()
  const presets = storage.getCustomUiPresets()
  expect(presets).toHaveLength(2)
  expect(presets[0]).toEqual(existing)
  expect(presets[1]?.globalCss).toContain('--page-background: rgba(18,52,86,1)')
  expect(wrapper.emitted('save-css')?.at(-1)?.[0]).toBe(presets[1]?.globalCss.trim())
  expect(storage.exportAppearanceSettings().presets).toEqual(presets)
})
it('places the entry directly before custom CSS and previews/saves colors with the original layout and scoped CSS', async () => {
  const source =
    ':root { --button-radius: 22px; } .resource-card { padding: 3px; font-size: 13px; }'
  const storage = new BrowserStorageService()
  storage.setCustomUiPresets([
    {
      id: 'layout',
      name: '小控件',
      globalCss: source,
      scopedCss: { library: '.resource-card { margin: 7px; }' },
      createdAt: '',
      updatedAt: '',
    },
  ])
  const wrapper = await open()
  expect(
    wrapper.get('.appearance-palette-entry').element.nextElementSibling?.textContent,
  ).toContain('自定义 CSS')
  expect(
    wrapper
      .get('.appearance-palette-entry')
      .element.parentElement?.classList.contains('appearance-panel--code'),
  ).toBe(true)
  await wrapper.get('#e-group').setValue('控件')
  await wrapper.get('#e-hex').setValue('#123456')
  await wrapper.get('#e-more').trigger('toggle')
  wrapper.get('#e-editor-scroll').element.scrollTop = 57
  await wrapper.get('#e-editor-scroll').trigger('scroll')
  await wrapper.get('#e-live-preview').trigger('click')
  await flushPromises()
  const request = wrapper.emitted('preview-css')?.at(-1)?.[0] as AppearancePreviewRequest
  expect(request.scope).toBeUndefined()
  expect(request.css).toContain(source)
  expect(request.css).toContain('margin: 7px')
  expect(request.css).toContain('rgba(18,52,86,0.62)')
  expect(wrapper.emitted('save-css')).toBeUndefined()
  expect(storage.getCustomUiPresets()).toHaveLength(1)
  await wrapper.setProps({ active: false })
  await wrapper.setProps({ active: true })
  request.onExit()
  await flushPromises()
  expect(wrapper.get<HTMLSelectElement>('#e-group').element.value).toBe('控件')
  expect(wrapper.get('#e-editor-scroll').element.scrollTop).toBe(57)
  await wrapper.get('#e-done').trigger('click')
  await wrapper.get('#e-save-preset').trigger('click')
  await wrapper.get('#e-preset-name').setValue('小控件调色')
  await wrapper.get('#e-preset-commit').trigger('click')
  await flushPromises()
  const saved = storage.getCustomUiPresets().at(-1)
  expect(saved?.globalCss).toContain(source)
  expect(saved?.scopedCss.library).toBe('.resource-card { margin: 7px; }')
})
