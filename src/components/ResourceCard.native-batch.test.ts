/** @vitest-environment jsdom */
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AppDatabase } from '../database/AppDatabase'
import type { ResourceSummary } from '../types/Resource'

const state = vi.hoisted(() => ({ vault: false }))
const sources = vi.hoisted(() => vi.fn())
const getBlob = vi.hoisted(() => vi.fn())
vi.mock('../storage/AndroidNativeDexieCore', () => ({
  isAndroidNativeAppDatabaseActive: () => true,
  runAndroidNativeRead: (_tx: unknown, read: () => Promise<unknown>) => read(),
}))
vi.mock('../storage/NativeAppDatabaseBridge', () => ({
  nativeAppDatabase: { getAssetImageSources: sources },
}))
vi.mock('@capacitor/core', () => ({
  registerPlugin: () => ({}),
  Capacitor: { convertFileSrc: (path: string) => `https://localhost/_capacitor_file_${path}` },
}))
vi.mock('../core/AppContainer', async () => {
  const { IndexedDbAssetStore } = await import('../storage/IndexedDbAssetStore')
  const database = {
    assets: {},
    assetFiles: {},
    transaction: async (...args: unknown[]) =>
      (args.at(-1) as (tx: unknown) => Promise<unknown>)({ idbtrans: {} }),
  } as unknown as AppDatabase
  const store = new IndexedDbAssetStore(database, {
    isEnabled: () => state.vault,
    protectBlob: vi.fn(),
    revealBlob: vi.fn(),
  })
  store.getBlob = getBlob
  return { assetStore: store }
})
import ResourceCard from './ResourceCard.vue'

const mounted: ReturnType<typeof mount>[] = []
function rows(keys: string[]) {
  return keys.map((key) => ({
    key,
    blob: {
      path: `file:///synthetic/${JSON.parse(key)}.webp`,
      mimeType: 'image/webp',
      size: 12,
      sha256: 'a'.repeat(64),
    },
  }))
}
function mountPage(count: number) {
  for (let index = 0; index < count; index++)
    mounted.push(
      mount(ResourceCard, {
        props: {
          resource: {
            id: `card-${index}`,
            name: 'Synthetic',
            type: 'characterCard',
            mimeType: 'image/png',
            fileName: 'synthetic.png',
            contentHash: `hash-${index}`,
            thumbnailAssetId: `asset-${index}`,
            metadata: {},
            tags: [],
          } as unknown as ResourceSummary,
        },
      }),
    )
}
beforeEach(() => {
  state.vault = false
  vi.stubGlobal('IntersectionObserver', undefined)
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:synthetic'), revokeObjectURL: vi.fn() })
  getBlob.mockReset().mockResolvedValue(new Blob(['synthetic']))
  sources.mockReset().mockImplementation(async (keys: string[]) => rows(keys))
})
afterEach(async () => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount())
  await flushPromises()
  vi.unstubAllGlobals()
})

it('lets one native metadata batch serve a 24-card page without reading image bytes', async () => {
  mountPage(24)
  await flushPromises()
  expect(sources.mock.calls.map(([keys]) => keys.length)).toEqual([24])
  expect(getBlob).not.toHaveBeenCalled()
  for (const [index, wrapper] of mounted.entries())
    expect(wrapper.get('img').attributes('src')).toContain(`/asset-${index}.webp`)
})

it('keeps native metadata batches bounded at 32 for a larger visible page', async () => {
  mountPage(65)
  await flushPromises()
  expect(sources.mock.calls.map(([keys]) => keys.length)).toEqual([32, 32, 1])
  expect(mounted.filter((wrapper) => wrapper.find('img').exists())).toHaveLength(65)
})

it('only resolves nearby covers and cancels queued native sources after unmount', async () => {
  let notify!: IntersectionObserverCallback
  const elements: Element[] = []
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        notify = callback
      }
      observe(element: Element) {
        elements.push(element)
      }
      unobserve() {}
      disconnect() {}
    },
  )
  let complete!: () => void
  sources.mockImplementationOnce(
    (keys: string[]) => new Promise((resolve) => (complete = () => resolve(rows(keys)))),
  )
  mountPage(100)
  await flushPromises()
  expect(sources).not.toHaveBeenCalled()
  notify(
    elements
      .slice(0, 65)
      .map((target) => ({ target, isIntersecting: true })) as IntersectionObserverEntry[],
    {} as IntersectionObserver,
  )
  await flushPromises()
  expect(sources.mock.calls.map(([keys]) => keys.length)).toEqual([32])
  mounted.splice(0).forEach((wrapper) => wrapper.unmount())
  complete()
  await flushPromises()
  expect(sources).toHaveBeenCalledTimes(1)
  expect(getBlob).not.toHaveBeenCalled()
})

it.each(['native fallback', 'vault'])(
  'keeps %s byte reads at four and cancels the rest on exit',
  async (mode) => {
    state.vault = mode === 'vault'
    sources.mockImplementation(async (keys: string[]) =>
      keys.map((key) => ({ key, fallback: true })),
    )
    const finishes: ((blob: Blob) => void)[] = []
    getBlob.mockImplementation(() => new Promise((resolve) => finishes.push(resolve)))
    mountPage(24)
    try {
      await flushPromises()
      expect(sources.mock.calls.map(([keys]) => keys.length)).toEqual(state.vault ? [] : [24])
      expect(getBlob).toHaveBeenCalledTimes(4)
    } finally {
      mounted.splice(0).forEach((wrapper) => wrapper.unmount())
      finishes.forEach((finish) => finish(new Blob(['fallback'])))
      await flushPromises()
    }
    expect(getBlob).toHaveBeenCalledTimes(4)
  },
)
