/** @vitest-environment jsdom */
import { defineComponent, h, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ResourceReference } from '../types/Resource'

const { getBlob, getImageUrl, getImagePreview } = vi.hoisted(() => ({
  getBlob: vi.fn(),
  getImageUrl: vi.fn(),
  getImagePreview: vi.fn(),
}))
vi.mock('../core/AppContainer', () => ({
  assetStore: {
    getBlob,
    getImageUrl,
  },
  resourceGalleryService: { getImagePreview },
}))
import {
  enqueueThumbnailRead,
  useResourceThumbnail,
  thumbnailLevelForDisplay,
} from './UseResourceThumbnail'

it('selects a prepared tier only when actual pixels fit, preserving high-density and unknown layouts', () => {
  expect(thumbnailLevelForDisplay(100, 150, 2)).toBe('card')
  expect(thumbnailLevelForDisplay(100, 150, 3)).toBe('preview')
  expect(thumbnailLevelForDisplay(160, 160, 2)).toBe('card')
  expect(thumbnailLevelForDisplay(161, 161, 2)).toBe('preview')
  expect(thumbnailLevelForDisplay(0, 150, 2)).toBe('preview')
  expect(thumbnailLevelForDisplay(100, 150, NaN)).toBe('preview')
})

beforeEach(() => {
  getImageUrl.mockReset().mockResolvedValue(undefined)
  getImagePreview.mockReset()
})

it('uses the preview owner for a custom cover and ignores a late image after switching covers', async () => {
  vi.stubGlobal('IntersectionObserver', undefined)
  let finish!: (preview: { blob?: Blob; url: string }) => void
  getImagePreview.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  getImagePreview.mockResolvedValue({ url: 'https://example.com/new.png' })
  const source = ref({
    id: 'owner',
    metadata: { resourceCoverId: 'old' },
  } as unknown as ResourceReference)
  const remote = ref('')
  const wrapper = mount(
    defineComponent({
      setup() {
        const blob = useResourceThumbnail(() => source.value, undefined, remote)
        return () => h('div', `${remote.value}:${Boolean(blob.value)}`)
      },
    }),
  )
  await flushPromises()
  expect(getImagePreview).toHaveBeenCalledExactlyOnceWith('owner', 'old')
  source.value = { ...source.value, metadata: { resourceCoverId: 'new' } }
  await flushPromises()
  expect(remote.value).toBe('https://example.com/new.png')
  finish({ blob: new Blob(['stale']), url: '' })
  await flushPromises()
  expect(wrapper.text()).toBe('https://example.com/new.png:false')
  expect(getBlob).not.toHaveBeenCalled()
  wrapper.unmount()
})

it('discards a gallery preview after unmount without publishing its URL or pixels', async () => {
  let finish!: (preview: { blob?: Blob; url: string }) => void
  getImagePreview.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const remote = ref('')
  const wrapper = mount(
    defineComponent({
      setup() {
        useResourceThumbnail(
          () =>
            ({
              id: 'owner',
              metadata: { resourceCoverId: 'cover' },
            }) as unknown as ResourceReference,
          undefined,
          remote,
        )
        return () => h('div')
      },
    }),
  )
  await flushPromises()
  wrapper.unmount()
  finish({ url: 'https://example.com/stale.png' })
  await flushPromises()
  expect(remote.value).toBe('')
})

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

it('prioritizes visible work over earlier prefetch jobs while keeping four active reads', async () => {
  const order: string[] = []
  const pending: Array<() => void> = []
  const cancel = Array.from({ length: 8 }, (_, index) =>
    enqueueThumbnailRead(
      async () => {
        order.push(String(index))
        await new Promise<void>((resolve) => pending.push(resolve))
      },
      () => (index < 4 ? 1 : 3),
    ),
  )
  await flushPromises()
  expect(order).toEqual(['4', '5', '6', '7'])
  cancel.forEach((stop) => stop())
  pending.forEach((complete) => complete())
  await flushPromises()
  expect(order).toHaveLength(4)
})

it('cancels queued images that leave the nearby viewport before their read starts', async () => {
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
  const pending: Array<(blob: Blob) => void> = []
  getBlob.mockImplementation(() => new Promise((resolve) => pending.push(resolve)))
  const wrappers = Array.from({ length: 8 }, (_, id) =>
    mount(
      defineComponent({
        setup() {
          const host = ref<Element | null>(null)
          useResourceThumbnail(
            () => ({ id: String(id), thumbnailAssetId: String(id) }) as ResourceReference,
            host,
          )
          return () => h('div', { ref: host })
        },
      }),
    ),
  )
  const notify = (targets: Element[], isIntersecting: boolean) =>
    visible(
      targets.map((target) => ({ target, isIntersecting })) as IntersectionObserverEntry[],
      {} as IntersectionObserver,
    )
  notify(elements, true)
  await flushPromises()
  expect(getBlob).toHaveBeenCalledTimes(4)
  notify(elements.slice(4), false)
  await flushPromises()
  pending.forEach((complete) => complete(new Blob(['image'])))
  await flushPromises()
  expect(getBlob).toHaveBeenCalledTimes(4)
  wrappers.forEach((wrapper) => wrapper.unmount())
})

it('discards an unmounted native result before it can trigger a fallback byte read', async () => {
  vi.stubGlobal('IntersectionObserver', undefined)
  let complete!: (url?: string) => void
  getImageUrl.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  const display = { url: ref(''), failedUrl: ref('') }
  const wrapper = mount(
    defineComponent({
      setup() {
        useResourceThumbnail(
          () => ({ id: 'a', thumbnailAssetId: 'a' }) as ResourceReference,
          undefined,
          undefined,
          display,
        )
        return () => h('div')
      },
    }),
  )
  await flushPromises()
  wrapper.unmount()
  complete()
  await flushPromises()
  expect(getBlob).not.toHaveBeenCalled()
  expect(display.url.value).toBe('')
})
