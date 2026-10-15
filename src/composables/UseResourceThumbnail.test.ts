/** @vitest-environment jsdom */
import { defineComponent, h, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import type { ResourceReference } from '../types/Resource'

const { getBlob } = vi.hoisted(() => ({ getBlob: vi.fn() }))
vi.mock('../core/AppContainer', () => ({ assetStore: { getBlob } }))
import { useResourceThumbnail } from './UseResourceThumbnail'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})
it('只读取接近视口的封面，最多并发四个；卸载后取消尚未开始的读取', async () => {
  let visible!: IntersectionObserverCallback
  const elements: Element[] = []
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        visible = callback
      }
      observe(element: Element) {
        elements.push(element)
      }
      unobserve() {}
      disconnect() {}
    },
  )
  const pending: Array<(value: Blob) => void> = []
  getBlob.mockImplementation(() => new Promise((resolve) => pending.push(resolve)))
  const card = defineComponent({
    props: { id: { type: String, required: true } },
    setup(props) {
      const host = ref<Element | null>(null)
      const blob = useResourceThumbnail(
        () => ({ id: props.id, thumbnailAssetId: props.id }) as ResourceReference,
        host,
      )
      return () => h('div', { ref: host }, String(Boolean(blob.value)))
    },
  })
  const wrappers = Array.from({ length: 100 }, (_, id) =>
    mount(card, { props: { id: String(id) } }),
  )
  expect(getBlob).not.toHaveBeenCalled()
  visible(
    elements
      .slice(0, 8)
      .map((target) => ({ target, isIntersecting: true })) as IntersectionObserverEntry[],
    {} as IntersectionObserver,
  )
  await flushPromises()
  expect(getBlob).toHaveBeenCalledTimes(4)
  wrappers.forEach((wrapper) => wrapper.unmount())
  pending.forEach((resolve) => resolve(new Blob(['cover'])))
  await flushPromises()
  expect(getBlob).toHaveBeenCalledTimes(4)
})

it('无观察器时正常加载；缺失封面不抛未处理异常', async () => {
  vi.stubGlobal('IntersectionObserver', undefined)
  getBlob.mockRejectedValue(new Error('missing asset'))
  const wrapper = mount(
    defineComponent({
      setup() {
        const blob = useResourceThumbnail(
          () => ({ thumbnailAssetId: 'missing' }) as ResourceReference,
        )
        return () => h('div', String(Boolean(blob.value)))
      },
    }),
  )
  await flushPromises()
  expect(getBlob).toHaveBeenCalledWith('missing')
  expect(wrapper.text()).toBe('false')
  wrapper.unmount()
})

it('retains the loaded image for metadata-only replacement and reloads a changed image identity', async () => {
  vi.stubGlobal('IntersectionObserver', undefined)
  getBlob.mockResolvedValue(new Blob(['thumbnail']))
  const source = ref({
    id: 'card',
    name: 'before',
    contentHash: 'hash',
    thumbnailAssetId: 'image',
  } as ResourceReference)
  const wrapper = mount(
    defineComponent({
      setup() {
        const image = useResourceThumbnail(() => source.value)
        return () => h('div', String(Boolean(image.value)))
      },
    }),
  )
  await flushPromises()
  expect(getBlob).toHaveBeenCalledTimes(1)
  source.value = { ...source.value, name: 'renamed', tags: ['new'], updatedAt: 20 }
  await flushPromises()
  expect(wrapper.text()).toBe('true')
  expect(getBlob).toHaveBeenCalledTimes(1)
  source.value = { ...source.value, thumbnailAssetId: 'replacement', contentHash: 'changed' }
  await flushPromises()
  expect(getBlob).toHaveBeenCalledTimes(2)
  expect(getBlob).toHaveBeenLastCalledWith('replacement')
  wrapper.unmount()
})
