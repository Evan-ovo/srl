/** @vitest-environment jsdom */
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref, type Component } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import type { Resource } from '../types/Resource'

type PanelModule = { default: Component; __esModule?: boolean }
const deferred = vi.hoisted(() => ({
  resolve: undefined as undefined | ((value: PanelModule) => void),
}))
vi.mock('../core/AppContainer', () => ({
  resourceAttachmentService: { list: vi.fn(async () => []) },
}))
vi.mock('../core/AsyncPanel', async (original) => {
  const { createAsyncPanel } = await original<typeof import('../core/AsyncPanel')>()
  return {
    createAsyncPanel: (label: string, _loader: unknown, options: { modal?: boolean }) =>
      createAsyncPanel(
        label,
        () => new Promise<PanelModule>((resolve) => (deferred.resolve = resolve)),
        options,
      ),
  }
})
import ResourceAttachmentEntry from './ResourceAttachmentEntry.vue'

const resource = { id: 'owner' } as Resource
afterEach(() => {
  document.body.innerHTML = ''
})

it('keeps attachment loading visible above the hidden detail and cancellation restores the entry', async () => {
  const opened = ref(false)
  const wrapper = mount(
    defineComponent({
      setup: () => () =>
        h('div', { style: { display: opened.value ? 'none' : '' } }, [
          h(ResourceAttachmentEntry, {
            resource,
            open: opened.value,
            'onUpdate:open': (value: boolean) => (opened.value = value),
          }),
        ]),
    }),
    { attachTo: document.body },
  )
  try {
    await flushPromises()
    await wrapper.get('[aria-label="查看附件列表"]').trigger('click')
    await nextTick()
    expect(opened.value).toBe(true)
    const dialog = document.body.querySelector('[role="dialog"]')!
    expect(dialog?.textContent).toContain('正在打开资源附件')
    expect(dialog.closest('.editor-overlay')?.parentElement).toBe(document.body)
    ;(dialog.querySelector('button') as HTMLButtonElement).click()
    await nextTick()
    expect(opened.value).toBe(false)
    expect(wrapper.get('[aria-label="查看附件列表"]').isVisible()).toBe(true)
    deferred.resolve!({
      __esModule: true,
      default: defineComponent({ render: () => h('p', '附件面板') }),
    })
    await flushPromises()
    expect(document.body.textContent).not.toContain('附件面板')
  } finally {
    wrapper.unmount()
  }
})

it('allows the parent back action to cancel while the attachment module is still downloading', async () => {
  const wrapper = mount(ResourceAttachmentEntry, { props: { resource }, attachTo: document.body })
  try {
    await flushPromises()
    await wrapper.get('[aria-label="查看附件列表"]').trigger('click')
    await nextTick()
    expect(() => wrapper.vm.requestBack()).not.toThrow()
    await nextTick()
    expect(document.body.querySelector('[role="status"]')).toBeNull()
    expect(wrapper.vm.open).toBe(false)
  } finally {
    wrapper.unmount()
  }
})

it('delegates back to a loaded panel so its unsaved-edit guard can keep the attachment open', async () => {
  const requestBack = vi.fn(async () => {})
  const wrapper = mount(ResourceAttachmentEntry, { props: { resource }, attachTo: document.body })
  try {
    await flushPromises()
    await wrapper.get('[aria-label="查看附件列表"]').trigger('click')
    deferred.resolve!({
      __esModule: true,
      default: defineComponent({
        setup(_props, { expose }) {
          expose({ requestBack })
          return () => h('p', '附件编辑')
        },
      }),
    })
    await flushPromises()
    await wrapper.vm.requestBack()
    expect(requestBack).toHaveBeenCalledOnce()
    expect(wrapper.vm.open).toBe(true)
  } finally {
    wrapper.unmount()
  }
})
