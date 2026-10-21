/** @vitest-environment jsdom */
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useProductAssistantChatLayout } from './UseProductAssistantChatLayout'

describe('assistant chat layout', () => {
  const observers: Array<{ notify: () => void; disconnect: ReturnType<typeof vi.fn> }> = []
  beforeEach(() => {
    observers.length = 0
    vi.stubGlobal(
      'ResizeObserver',
      class {
        disconnect = vi.fn()
        observe = vi.fn()
        constructor(notify: () => void) {
          observers.push({ notify, disconnect: this.disconnect })
        }
      },
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  async function render() {
    const messages = ref<HTMLElement>()
    const textarea = ref<HTMLTextAreaElement>()
    const input = ref('')
    const hidden = ref(false)
    let latest!: () => Promise<void>
    const wrapper = mount(
      defineComponent({
        setup() {
          latest = useProductAssistantChatLayout(messages, textarea, input, () => hidden.value)
          return () => h('div', [h('section', { ref: messages }), h('textarea', { ref: textarea })])
        },
      }),
    )
    await nextTick()
    let height = 600
    let top = 0
    Object.defineProperties(messages.value!, {
      scrollHeight: { get: () => 2000 },
      clientHeight: { get: () => height },
      scrollTop: {
        get: () => top,
        set: (value: number) => {
          top = Math.max(0, Math.min(value, 2000 - height))
        },
      },
    })
    observers[0]!.notify()
    const resize = (value: number) => {
      height = value
      observers[0]!.notify()
    }
    return { wrapper, messages, textarea, input, hidden, latest, resize }
  }

  it('keeps the latest message visible through shrinking, multiline input and keyboard dismissal', async () => {
    const f = await render()
    try {
      await f.latest()
      expect(f.messages.value!.scrollTop).toBe(1400)
      for (const height of [480, 300, 210, 300, 600]) {
        f.resize(height)
        expect(f.messages.value!.scrollTop).toBe(2000 - height)
      }
    } finally {
      f.wrapper.unmount()
    }
  })

  it('preserves a manually scrolled history until an explicit jump to latest', async () => {
    const f = await render()
    try {
      await f.latest()
      f.messages.value!.scrollTop = 120
      f.messages.value!.dispatchEvent(new Event('scroll'))
      for (const height of [480, 300, 600]) {
        f.resize(height)
        expect(f.messages.value!.scrollTop).toBe(120)
      }
      await f.latest()
      f.resize(300)
      expect(f.messages.value!.scrollTop).toBe(1700)
    } finally {
      f.wrapper.unmount()
    }
  })

  it('sizes input only while visible and retains the existing 44–112px limits', async () => {
    const f = await render()
    try {
      Object.defineProperty(f.textarea.value!, 'scrollHeight', { get: () => 180 })
      f.input.value = '多行草稿'
      await nextTick()
      await nextTick()
      expect(f.textarea.value!.style.height).toBe('112px')
      f.hidden.value = true
      f.textarea.value!.style.height = '44px'
      f.input.value += '继续'
      await nextTick()
      await nextTick()
      expect(f.textarea.value!.style.height).toBe('44px')
      f.hidden.value = false
      await nextTick()
      await nextTick()
      expect(f.textarea.value!.style.height).toBe('112px')
    } finally {
      f.wrapper.unmount()
    }
  })

  it('releases the observer and ignores a resize delivered after unmount', async () => {
    const f = await render()
    await f.latest()
    const element = f.messages.value!
    f.wrapper.unmount()
    expect(observers[0]!.disconnect).toHaveBeenCalledOnce()
    f.resize(300)
    expect(element.scrollTop).toBe(1400)
  })
})
