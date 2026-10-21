// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import AppearancePalette from './AppearancePalette.vue'
import { BrowserStorageService } from '../services/BrowserStorageService'
import type { PalettePorts } from '../composables/AppearancePaletteController.js'
import { SRL_BACK_REQUEST_EVENT } from '../composables/UseBackStack'

const wrappers: VueWrapper[] = []
let storage: BrowserStorageService
let ports: PalettePorts
beforeEach(() => {
  localStorage.clear()
  storage = new BrowserStorageService()
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
  ports = {
    theme: 'light',
    initialCss: '',
    readDraft: () => storage.getAppearancePaletteDraft(),
    writeDraft: (value) => storage.setAppearancePaletteDraft(value),
    savePreset: vi.fn(async () => true),
    importCss: vi.fn(async () => true),
    download: vi.fn(async () => {}),
    preview: vi.fn(async () => {}),
    confirm: vi.fn(async () => true),
    notice: vi.fn(),
    back: vi.fn(),
  }
})
afterEach(() => wrappers.splice(0).forEach((wrapper) => wrapper.unmount()))
function page() {
  const wrapper = mount(AppearancePalette, { props: { ports }, attachTo: document.body })
  wrappers.push(wrapper)
  return wrapper
}
const css = (wrapper: VueWrapper) => {
  wrapper.get<HTMLButtonElement>('#e-done').element.click()
  const value = wrapper.get<HTMLTextAreaElement>('#e-css').element.value
  wrapper.get<HTMLButtonElement>('#e-continue').element.click()
  return value
}

describe('production palette page', () => {
  it('keeps the current draft when CSS import is cancelled or invalid', async () => {
    const wrapper = page()
    await wrapper.get('#e-hex').setValue('#123456')
    let source = ':root { --color-ink: #574650; }'
    const file = new File([], '粉樱.css', { type: 'text/css' })
    Object.defineProperty(file, 'text', { value: async () => source })
    Object.defineProperty(wrapper.get('#e-import-file').element, 'files', { value: [file] })
    vi.mocked(ports.confirm).mockResolvedValueOnce(false)
    await wrapper.get('#e-import-file').trigger('change')
    await flushPromises()
    expect(ports.importCss).not.toHaveBeenCalled()
    expect(wrapper.get<HTMLInputElement>('#e-hex').element.value.toLowerCase()).toBe('#123456')
    source = ':root {'
    await wrapper.get('#e-import-file').trigger('change')
    await flushPromises()
    expect(ports.importCss).not.toHaveBeenCalled()
    expect(wrapper.get('#e-error').text()).toContain('CSS 格式不完整')
    expect(css(wrapper)).toContain('rgba(18,52,86,1)')
  })
  it('ignores a late CSS file read after leaving the palette', async () => {
    const wrapper = page()
    let finish!: (value: string) => void
    const file = new File([], '粉樱.css')
    Object.defineProperty(file, 'text', {
      value: () =>
        new Promise<string>((resolve) => {
          finish = resolve
        }),
    })
    Object.defineProperty(wrapper.get('#e-import-file').element, 'files', { value: [file] })
    await wrapper.get('#e-import-file').trigger('change')
    await wrapper.setProps({ active: false })
    finish(':root { --color-ink: #574650; }')
    await flushPromises()
    expect(ports.importCss).not.toHaveBeenCalled()
  })
  it('routes system back through the draft confirmation and ignores it while inactive', async () => {
    const wrapper = page()
    await wrapper.get('#e-hex').setValue('#123456')
    vi.mocked(ports.confirm).mockResolvedValueOnce(false)
    const detail = { handled: false }
    window.dispatchEvent(new CustomEvent(SRL_BACK_REQUEST_EVENT, { detail }))
    await flushPromises()
    expect(detail.handled).toBe(true)
    expect(ports.back).not.toHaveBeenCalled()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(ports.back).toHaveBeenCalledOnce()
    await wrapper.setProps({ active: false })
    const hiddenDetail = { handled: false }
    window.dispatchEvent(new CustomEvent(SRL_BACK_REQUEST_EVENT, { detail: hiddenDetail }))
    expect(hiddenDetail.handled).toBe(false)
  })
  it('does not delete before confirmation, preserves cancellation and allows two-to-one with undo', async () => {
    const wrapper = page()
    await wrapper.get('[data-type="gradient"]').trigger('click')
    await wrapper.get('[data-picker="color-1"]').trigger('click')
    await wrapper.get('#e-hex').setValue('#123456')
    const before = css(wrapper)
    let resolve!: (value: boolean) => void
    vi.mocked(ports.confirm).mockImplementationOnce(
      () =>
        new Promise<boolean>((done) => {
          resolve = done
        }),
    )
    await wrapper.get('#e-remove').trigger('click')
    expect(css(wrapper)).toBe(before)
    resolve(false)
    await flushPromises()
    expect(css(wrapper)).toBe(before)
    await wrapper.get('#e-remove').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-type="solid"]').attributes('aria-pressed')).toBe('true')
    expect(css(wrapper)).not.toContain('rgba(18,52,86,1)')
    await wrapper.get('#e-undo').trigger('click')
    expect(css(wrapper)).toBe(before)
  })

  it('persists the chosen part, color, details and scroll through unmount/remount without applying CSS', async () => {
    let wrapper = page()
    await wrapper.get('#e-group').setValue('控件')
    await wrapper.get('#e-hex').setValue('#6A8CAF')
    const details = wrapper.get<HTMLDetailsElement>('#e-more').element
    details.open = true
    await wrapper.get('#e-more').trigger('toggle')
    wrapper.get('#e-editor-scroll').element.scrollTop = 123
    await wrapper.get('#e-editor-scroll').trigger('scroll')
    wrapper.unmount()
    wrappers.pop()
    wrapper = page()
    expect(wrapper.get<HTMLSelectElement>('#e-group').element.value).toBe('控件')
    expect(wrapper.get<HTMLInputElement>('#e-hex').element.value).toBe('#6A8CAF')
    expect(wrapper.get<HTMLDetailsElement>('#e-more').element.open).toBe(true)
    expect(wrapper.get('#e-editor-scroll').element.scrollTop).toBe(123)
    expect(storage.getCustomUiCss()).toBe('')
    expect(ports.savePreset).not.toHaveBeenCalled()
    await wrapper.get('.feature-app-header__back').trigger('click')
    await flushPromises()
    expect(ports.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ confirmLabel: '保存草稿并退出' }),
      expect.any(AbortSignal),
    )
    expect(ports.back).toHaveBeenCalledOnce()
    expect(storage.getAppearancePaletteDraft()?.page).toBe('home')
  })

  it('saves and exports through the existing owners', async () => {
    const wrapper = page()
    await wrapper.get('#e-done').trigger('click')
    const expectedActions = ['保存为预设', '下载 CSS', '继续调整']
    expect(
      wrapper
        .findAll('.e-finish-actions > button')
        .filter((button) => !(button.element as HTMLButtonElement).hidden)
        .map((button) => button.text()),
    ).toEqual(expectedActions)
    await wrapper.get('#e-save-preset').trigger('click')
    await wrapper.get('#e-preset-name').setValue('海盐')
    await wrapper.get('#e-preset-commit').trigger('click')
    await flushPromises()
    expect(ports.savePreset).toHaveBeenCalledWith('海盐', css(wrapper))
    await wrapper.get('#e-export').trigger('click')
    expect(ports.download).toHaveBeenCalledWith(css(wrapper), '海盐')
  })

  it('rejects late deletion after leaving the page and keeps failed storage visible', async () => {
    const wrapper = page()
    await wrapper.get('[data-type="gradient"]').trigger('click')
    const before = css(wrapper)
    let resolve!: (value: boolean) => void
    vi.mocked(ports.confirm).mockImplementationOnce(
      () =>
        new Promise<boolean>((done) => {
          resolve = done
        }),
    )
    await wrapper.get('#e-remove').trigger('click')
    await wrapper.setProps({ active: false })
    resolve(true)
    await flushPromises()
    expect(css(wrapper)).toBe(before)
    ports.writeDraft = () => {
      throw new Error('full')
    }
    await wrapper.get('#e-hex').setValue('#112233')
    expect(wrapper.get('#e-error').text()).toContain('草稿未能保存')
  })
})
