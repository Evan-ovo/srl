/** @vitest-environment jsdom */
import { mount } from '@vue/test-utils'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import NativeExportDialog from './NativeExportDialog.vue'

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open')
  })
})
afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})
it.each(['supported', 'unavailable'])(
  'uses the top layer or the existing fallback when %s',
  async (mode) => {
    const showModal = vi
      .spyOn(HTMLDialogElement.prototype, 'showModal')
      .mockImplementation(function (this: HTMLDialogElement) {
        if (mode === 'unavailable') throw new Error('not supported')
        this.setAttribute('open', '')
      })
    const wrapper = mount(NativeExportDialog, {
      props: { fileName: 'fixture.txt', isImage: false, busy: false },
      attachTo: document.body,
    })
    try {
      const modal = document.querySelector('dialog')!
      expect(showModal).toHaveBeenCalledOnce()
      expect(modal.open).toBe(true)
      expect(modal.classList.contains('confirm-dialog__overlay--fallback')).toBe(
        mode === 'unavailable',
      )
      modal.dispatchEvent(new Event('cancel', { cancelable: true }))
      expect(wrapper.emitted('close')).toHaveLength(1)
    } finally {
      wrapper.unmount()
    }
  },
)
it('keeps saving and sharing disabled during an active save', () => {
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '')
  })
  const wrapper = mount(NativeExportDialog, {
    props: { fileName: 'fixture.txt', isImage: false, busy: true },
    attachTo: document.body,
  })
  try {
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('footer button')]
    expect(buttons).toHaveLength(2)
    expect(buttons.every((button) => button.disabled)).toBe(true)
  } finally {
    wrapper.unmount()
  }
})
