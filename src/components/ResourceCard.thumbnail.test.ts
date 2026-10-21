/** @vitest-environment jsdom */
import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { ResourceSummary } from '../types/Resource'
const { getImageUrl, getBlob } = vi.hoisted(() => ({ getImageUrl: vi.fn(), getBlob: vi.fn() }))
vi.mock('../core/AppContainer', () => ({
  assetStore: { getImageUrl, getBlob, supportsImageUrls: true },
}))
import ResourceCard from './ResourceCard.vue'

function resource(asset = 'a'): ResourceSummary {
  return {
    id: 'r',
    name: '角色',
    type: 'characterCard',
    mimeType: 'image/png',
    fileName: '角色.png',
    fileSize: 1,
    contentHash: 'hash',
    thumbnailAssetId: asset,
    description: '',
    tags: [],
    metadata: {},
    favorite: false,
    categoryId: null,
    createdAt: 1,
    updatedAt: 1,
  }
}
beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', undefined)
  getImageUrl.mockReset().mockResolvedValue('https://localhost/_capacitor_file_/image.bin')
  getBlob.mockReset().mockResolvedValue(new Blob(['thumbnail'], { type: 'image/webp' }))
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:fallback'), revokeObjectURL: vi.fn() })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function mockCardSize(initialHeight: number) {
  let height = initialHeight,
    resized!: ResizeObserverCallback
  let target!: Element
  vi.stubGlobal('devicePixelRatio', 2)
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, 0, 100, height),
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resized = callback
      }
      observe(element: Element) {
        target = element
      }
      unobserve() {}
      disconnect() {}
    },
  )
  return (nextHeight: number) => {
    height = nextHeight
    resized([{ target } as ResizeObserverEntry], {} as ResizeObserver)
  }
}

it('uses 320 for a small card, upgrades once to 640, and retains the larger image across later resizes', async () => {
  const resize = mockCardSize(150)
  getImageUrl.mockImplementation(async (id, level) => `https://localhost/${id}-${level}.webp`)
  const wrapper = mount(ResourceCard, { props: { resource: resource(), blurThumbnails: false } })
  await flushPromises()
  expect(getImageUrl).toHaveBeenCalledExactlyOnceWith('a', 'card')
  resize(240)
  await flushPromises()
  expect(getImageUrl).toHaveBeenLastCalledWith('a', 'preview')
  for (const height of [150, 240, 150]) {
    resize(height)
    await flushPromises()
    expect(getImageUrl).toHaveBeenCalledTimes(2)
    expect(wrapper.get('img').attributes('src')).toBe('https://localhost/a-preview.webp')
  }
  await wrapper.setProps({ resource: resource('b') })
  await flushPromises()
  expect(getImageUrl).toHaveBeenLastCalledWith('b', 'card')
  expect(getImageUrl).toHaveBeenCalledTimes(3)
  expect(getBlob).not.toHaveBeenCalled()
  wrapper.unmount()
})

it('keeps an in-flight 640 request when the appearance shrinks its card and still falls back on a display error', async () => {
  const resize = mockCardSize(240)
  let complete!: (url: string) => void
  getImageUrl.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  const wrapper = mount(ResourceCard, { props: { resource: resource() } })
  await flushPromises()
  expect(getImageUrl).toHaveBeenCalledExactlyOnceWith('a', 'preview')
  resize(150)
  await flushPromises()
  complete('https://localhost/large.webp')
  await flushPromises()
  expect(getImageUrl).toHaveBeenCalledTimes(1)
  expect(wrapper.get('img').attributes('src')).toBe('https://localhost/large.webp')
  await wrapper.get('img').trigger('error')
  await flushPromises()
  expect(getBlob).toHaveBeenCalledExactlyOnceWith('a')
  expect(wrapper.get('img').attributes('src')).toBe('blob:fallback')
  wrapper.unmount()
})

it('displays a native image without materializing a Blob and retains it for metadata edits', async () => {
  const wrapper = mount(ResourceCard, { props: { resource: resource(), blurThumbnails: false } })
  await flushPromises()
  expect(wrapper.get('img').attributes('src')).toBe('https://localhost/_capacitor_file_/image.bin')
  expect(getBlob).not.toHaveBeenCalled()
  expect(URL.createObjectURL).not.toHaveBeenCalled()
  await wrapper.setProps({ resource: { ...resource(), name: '改名' } })
  await flushPromises()
  expect(getImageUrl).toHaveBeenCalledTimes(1)
  wrapper.unmount()
})

it('uses the existing blob route when direct display fails, and tries a newly selected image normally', async () => {
  const wrapper = mount(ResourceCard, { props: { resource: resource() } })
  await flushPromises()
  await wrapper.get('img').trigger('error')
  await flushPromises()
  expect(getBlob).toHaveBeenCalledExactlyOnceWith('a')
  expect(wrapper.get('img').attributes('src')).toBe('blob:fallback')
  getImageUrl.mockResolvedValueOnce('https://localhost/_capacitor_file_/changed.bin')
  await wrapper.setProps({ resource: resource('b') })
  await flushPromises()
  expect(getImageUrl).toHaveBeenLastCalledWith('b', 'preview')
  expect(wrapper.get('img').attributes('src')).toBe(
    'https://localhost/_capacitor_file_/changed.bin',
  )
  wrapper.unmount()
})

it('keeps Web, encrypted and older APK images on the existing blob display route', async () => {
  getImageUrl.mockResolvedValueOnce(undefined)
  const wrapper = mount(ResourceCard, { props: { resource: resource() } })
  await flushPromises()
  expect(wrapper.get('img').attributes('src')).toBe('blob:fallback')
  expect(getBlob).toHaveBeenCalledExactlyOnceWith('a')
  wrapper.unmount()
})
