/** @vitest-environment jsdom */
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import ActionSheet from './ActionSheet.vue'

describe('ActionSheet', () => {
  it('traps keyboard focus and consumes Escape before outer page navigation', async () => {
    const wrapper = mount(ActionSheet, {
      attachTo: document.body,
      props: { open: true, title: '添加 APP', actions: [{ id: 'file', label: '导入文件' }] },
      global: { stubs: { Teleport: true, Transition: false } },
    })
    const outerBack = vi.fn()
    window.addEventListener('keydown', outerBack)
    try {
      await flushPromises()
      const first = wrapper.get('button[aria-label="关闭操作面板"]').element as HTMLButtonElement
      const last = wrapper.get('.action-sheet__actions button').element
      first.focus()
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true }),
      )
      expect(document.activeElement).toBe(last)
      outerBack.mockClear()
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
      expect(wrapper.emitted('update:open')?.[0]).toEqual([false])
      expect(outerBack).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', outerBack)
      wrapper.unmount()
    }
  })
  it('identifies the current selection without marking ordinary actions as toggles', () => {
    const wrapper = mount(ActionSheet, {
      props: {
        open: true,
        title: '图片分类',
        actions: [
          { id: 'all', label: '全部分类', selected: true },
          { id: 'art', label: '同人图', selected: false },
          { id: 'manage', label: '管理分类' },
        ],
      },
      global: { stubs: { Teleport: true, Transition: false } },
    })
    const buttons = wrapper.findAll('.action-sheet__actions button')
    expect(buttons[0]!.attributes('aria-pressed')).toBe('true')
    expect(buttons[0]!.text()).toContain('✓')
    expect(buttons[1]!.attributes('aria-pressed')).toBe('false')
    expect(buttons[2]!.attributes('aria-pressed')).toBeUndefined()
    wrapper.unmount()
  })
  it('emits the selected action and closes', async () => {
    const wrapper = mount(ActionSheet, {
      props: {
        open: true,
        title: '更多操作',
        actions: [{ id: 'download', label: '下载' }],
      },
      global: { stubs: { Teleport: true, Transition: false } },
    })
    await wrapper.get('.action-sheet__actions button').trigger('click')
    expect(wrapper.emitted('select')?.[0]?.[0]).toMatchObject({ id: 'download' })
    expect(wrapper.emitted('update:open')?.[0]).toEqual([false])
    wrapper.unmount()
  })

  it('provides a separate dismissible full-screen backdrop', async () => {
    const wrapper = mount(ActionSheet, {
      props: { open: true, title: '人设操作', actions: [{ id: 'import', label: '导入人设 JSON' }] },
      global: { stubs: { Teleport: true, Transition: false } },
    })
    expect(wrapper.get('.action-sheet__backdrop').attributes('aria-hidden')).toBe('true')
    await wrapper.get('.action-sheet__backdrop').trigger('click')
    expect(wrapper.emitted('update:open')?.[0]).toEqual([false])
    wrapper.unmount()
  })

  it('consumes the shared Android back request while open', async () => {
    const wrapper = mount(ActionSheet, {
      props: { open: true, title: '操作', actions: [] },
      global: { stubs: { Teleport: true, Transition: false } },
    })
    const detail = { handled: false }
    window.dispatchEvent(new CustomEvent('srl:back-request', { detail }))
    expect(detail.handled).toBe(true)
    expect(wrapper.emitted('update:open')?.[0]).toEqual([false])
    wrapper.unmount()
  })
})
