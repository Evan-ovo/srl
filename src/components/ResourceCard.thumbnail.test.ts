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

it('uses 320 only for a small measured card and upgrades to 640 after a resize', async () => {
  let height = 150,
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
  const wrapper = mount(ResourceCard, { props: { resource: resource(), blurThumbnails: false } })
  await flushPromises()
  expect(getImageUrl).toHaveBeenCalledExactlyOnceWith('a', 'card')
  height = 240
  resized([{ target } as ResizeObserverEntry], {} as ResizeObserver)
  await flushPromises()
  expect(getImageUrl).toHaveBeenLastCalledWith('a', 'preview')
  expect(getBlob).not.toHaveBeenCalled()
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
