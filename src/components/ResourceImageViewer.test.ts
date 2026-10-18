/** @vitest-environment jsdom */
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ResourceImageViewer from './ResourceImageViewer.vue'

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
})
afterEach(() => {
  document.dispatchEvent(new Event('pointerdown'))
  vi.unstubAllGlobals()
})

async function pointer(
  target: { element: Element },
  type: string,
  values: Record<string, unknown>,
) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  // Match test-utils.trigger: events created in the mounting millisecond must
  // reach Vue's capture and bubble handlers, rather than its stale-event guard.
  Object.defineProperty(event, '_vts', { value: Date.now() + 1 })
  for (const [key, value] of Object.entries(values)) Object.defineProperty(event, key, { value })
  target.element.dispatchEvent(event)
  await nextTick()
}

describe('image viewer touch controls', () => {
  it('consumes Escape default so a native parent dialog stays open', () => {
    const wrapper = mount(ResourceImageViewer, {
      props: { src: '/image.png', name: '图片' },
      global: { stubs: { teleport: true } },
    })
    const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    window.dispatchEvent(escape)
    expect(escape.defaultPrevented).toBe(true)
    expect(wrapper.emitted('close')).toHaveLength(1)
    wrapper.unmount()
  })
  it.each(['compatibility click', 'omitted click', 'keyboard click'])(
    'keeps closing touches from clicking through while preserving the next input: %s',
    async (mode) => {
      const underlying = document.createElement('button')
      document.body.append(underlying)
      const reopen = vi.fn()
      underlying.addEventListener('click', reopen)
      const wrapper = mount(ResourceImageViewer, {
        props: { src: '/image.png', name: '图片', onClose: () => wrapper.unmount() },
        attachTo: document.body,
        global: { stubs: { teleport: true } },
      })
      const close = wrapper.get('[data-viewer-action="close"]')
      const touch = {
        pointerType: 'touch',
        isPrimary: true,
        pointerId: 1,
        clientX: 20,
        clientY: 20,
      }
      await pointer(close, 'pointerdown', touch)
      await pointer(close, 'pointerup', touch)
      if (mode === 'compatibility click') {
        await pointer({ element: underlying }, 'click', { detail: 1 })
        expect(reopen).not.toHaveBeenCalled()
      } else if (mode === 'keyboard click') {
        await pointer({ element: underlying }, 'click', { detail: 0 })
        expect(reopen).toHaveBeenCalledOnce()
        reopen.mockClear()
      }
      await pointer({ element: underlying }, 'pointerdown', { ...touch, pointerId: 2 })
      await pointer({ element: underlying }, 'click', { detail: 1 })
      expect(reopen).toHaveBeenCalledOnce()
      underlying.remove()
    },
  )
  it('keeps a loading preview closable but prevents zooming before the full source arrives', async () => {
    const wrapper = mount(ResourceImageViewer, {
      props: { src: '/small.png', name: '图片', cover: true, loading: true },
      global: { stubs: { teleport: true } },
    })
    const stage = wrapper.get('.resource-image-viewer__canvas')
    const capture = vi.fn()
    Object.defineProperty(stage.element, 'setPointerCapture', { value: capture })
    const touch = { pointerType: 'touch', isPrimary: true, pointerId: 1, clientX: 20, clientY: 20 }
    await pointer(stage, 'pointerdown', touch)
    await pointer(stage, 'wheel', { deltaY: -100, clientX: 20, clientY: 20 })
    expect(capture).not.toHaveBeenCalled()
    expect(wrapper.get('img').attributes('style')).toContain('scale(1)')
    expect(wrapper.get('[role=status]').text()).toBe('正在读取原图…')
    await wrapper.setProps({ src: '/full.png', loading: false })
    const fullStage = wrapper.get('.resource-image-viewer__canvas')
    Object.defineProperty(fullStage.element, 'setPointerCapture', {
      value: capture,
      configurable: true,
    })
    await pointer(fullStage, 'pointerdown', touch)
    await pointer(fullStage, 'wheel', { deltaY: -100, clientX: 20, clientY: 20 })
    expect(capture).toHaveBeenCalledWith(1)
    expect(wrapper.get('img').attributes('style')).not.toContain('scale(1)')
    await wrapper.get('[data-viewer-action="close"]').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
    wrapper.unmount()
  })
  it('shows only a close icon for minimal tutorial previews', () => {
    const wrapper = mount(ResourceImageViewer, {
      props: { src: '/image.png', name: '教程截图', cover: true, minimal: true },
      global: { stubs: { teleport: true } },
    })
    expect(wrapper.get('.resource-image-viewer').classes()).toContain(
      'resource-image-viewer--minimal',
    )
    expect(wrapper.find('.resource-image-viewer__title').exists()).toBe(false)
    expect(wrapper.find('[data-viewer-action="fit"]').exists()).toBe(false)
    expect(wrapper.get('[data-viewer-action="close"]').text()).toBe('×')
    expect(wrapper.get('[data-viewer-action="close"]').attributes('aria-label')).toBe('关闭图片')
    wrapper.unmount()
  })

  it('closes once on touch release even without a compatibility click, while preserving keyboard clicks', async () => {
    const wrapper = mount(ResourceImageViewer, {
      props: { src: '/image.png', name: '图片', hasNext: true },
      global: { stubs: { teleport: true } },
    })
    const next = wrapper.get('[data-viewer-action="close"]')
    const touch = { pointerType: 'touch', isPrimary: true, pointerId: 1, clientX: 20, clientY: 20 }
    await pointer(next, 'pointerdown', touch)
    await pointer(next, 'pointerup', touch)
    expect(wrapper.emitted('close')).toHaveLength(1)
    await pointer(next, 'click', { detail: 1 })
    expect(wrapper.emitted('close')).toHaveLength(1)
    await pointer(next, 'click', { detail: 0 })
    expect(wrapper.emitted('close')).toHaveLength(2)
    wrapper.unmount()
  })
  it('does not close on a dragged/cancelled touch', async () => {
    const wrapper = mount(ResourceImageViewer, {
      props: { src: '/image.png', name: '图片', hasNext: true },
      global: { stubs: { teleport: true } },
    })
    const next = wrapper.get('[data-viewer-action="close"]')
    const touch = { pointerType: 'touch', isPrimary: true, pointerId: 1, clientX: 20, clientY: 20 }
    await pointer(next, 'pointerdown', touch)
    await pointer(next, 'pointermove', { ...touch, clientX: 40 })
    await pointer(next, 'pointerup', touch)
    await pointer(next, 'pointerdown', touch)
    await pointer(next, 'pointercancel', touch)
    await pointer(next, 'pointerup', touch)
    expect(wrapper.emitted('close')).toBeUndefined()
    wrapper.unmount()
  })
})
