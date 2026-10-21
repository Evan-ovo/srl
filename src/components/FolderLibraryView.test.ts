/** @vitest-environment jsdom */
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BrowserStorageService } from '../services/BrowserStorageService'
import {
  RESOURCE_TYPE,
  type Category,
  type ResourceSummary,
  type ResourceType,
} from '../types/Resource'
import FolderLibraryView from './FolderLibraryView.vue'
import { assetStore } from '../core/AppContainer'
import {
  createFolderThumbnailCache,
  folderThumbnailCacheKey,
} from '../composables/FolderThumbnailCache'

const categories: Category[] = [
  {
    id: 'folder-a',
    name: '古风收藏',
    color: '#486b5d',
    createdAt: 1,
    updatedAt: 1,
  },
]

function resource(
  id: string,
  name: string,
  categoryIds: string[] = [],
  type: ResourceType = RESOURCE_TYPE.CHARACTER_CARD,
): ResourceSummary {
  return {
    id,
    name,
    description: '',
    type,
    fileName: `${name}.png`,
    mimeType: 'image/png',
    fileSize: 100,
    contentHash: id.padEnd(64, '0'),
    favorite: false,
    categoryId: categoryIds[0] ?? null,
    categoryIds,
    tags: [],
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  }
}

function render(
  categoryItems = categories,
  resourceItems = [resource('a', '青衣', ['folder-a']), resource('b', '待整理')],
  cabinetResourceIds: string[] = [],
  cache?: ReturnType<typeof createFolderThumbnailCache>,
) {
  return mount(FolderLibraryView, {
    props: {
      categories: categoryItems,
      resources: resourceItems,
      busy: false,
      cabinetResourceIds,
    },
    global: {
      provide: cache ? { [folderThumbnailCacheKey as symbol]: cache } : {},
      stubs: { teleport: true },
    },
  })
}

async function enterFolderEditMode(wrapper: ReturnType<typeof render>) {
  vi.useFakeTimers()
  const folder = wrapper.get('[data-folder-order-id]')
  await dispatchPointer(folder.element, 'pointerdown', {
    pointerId: 91,
    pointerType: 'touch',
    button: 0,
    clientX: 80,
    clientY: 120,
  })
  await vi.advanceTimersByTimeAsync(430)
  await dispatchPointer(window, 'pointerup', {
    pointerId: 91,
    pointerType: 'touch',
    clientX: 80,
    clientY: 120,
  })
}

async function dispatchPointer(
  target: EventTarget,
  type: string,
  values: Record<string, string | number>,
) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(event, key, { configurable: true, value })
  }
  target.dispatchEvent(event)
  await nextTick()
}

describe('FolderLibraryView', () => {
  it.each([1000, 5000, 10000])(
    'bounds native cover work to visible entries in a %i-resource library',
    async (count) => {
      vi.spyOn(assetStore, 'supportsImageUrls', 'get').mockReturnValue(true)
      const finishes: ((url: string) => void)[] = []
      const direct = vi.spyOn(assetStore, 'getImageUrl').mockImplementation(
        () =>
          new Promise((resolve) => {
            finishes.push(resolve)
          }),
      )
      const bytes = vi.spyOn(assetStore, 'getBlob')
      const cards = Array.from({ length: count }, (_, id) => ({
        ...resource(String(id), `封面${id}`),
        thumbnailAssetId: `asset-${id}`,
      }))
      const wrapper = render(
        [],
        cards,
        cards.slice(0, 6).map((card) => card.id),
      )
      try {
        await flushPromises()
        expect(direct).toHaveBeenCalledTimes(6) // Only the six visible entries, in one address batch.
      } finally {
        wrapper.unmount()
        for (const finish of finishes) finish('https://native/late')
      }
      await flushPromises()
      expect(direct).toHaveBeenCalledTimes(6)
      expect(bytes).not.toHaveBeenCalled()
    },
  )

  it('drops a cached native address when direct access is unavailable, preserving the protected read path', async () => {
    const cache = createFolderThumbnailCache()
    const card = { ...resource('protected', '封面', ['folder-a']), thumbnailAssetId: 'asset' }
    cache.acquire(card, 'https://native/old')!.release()
    vi.spyOn(assetStore, 'supportsImageUrls', 'get').mockReturnValue(false)
    const direct = vi.spyOn(assetStore, 'getImageUrl')
    const bytes = vi.spyOn(assetStore, 'getBlob').mockResolvedValue(new Blob(['protected']))
    const wrapper = render(categories, [card], [], cache)
    try {
      await flushPromises()
      expect(wrapper.get('.visual-folder__mosaic img').attributes('src')).toMatch(/^blob:/)
      expect(direct).not.toHaveBeenCalled()
      expect(bytes).toHaveBeenCalledTimes(1)
    } finally {
      wrapper.unmount()
      cache.clear()
    }
  })

  it('displays and reuses native covers without reading image bytes, and invalidates a replaced image', async () => {
    vi.spyOn(assetStore, 'supportsImageUrls', 'get').mockReturnValue(true)
    const cache = createFolderThumbnailCache()
    const card = { ...resource('native', '原生封面', ['folder-a']), thumbnailAssetId: 'old' }
    const direct = vi
      .spyOn(assetStore, 'getImageUrl')
      .mockImplementation(async (id) => `https://native/${id}`)
    const bytes = vi.spyOn(assetStore, 'getBlob')
    const create = vi.spyOn(URL, 'createObjectURL')
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    let wrapper = render(categories, [card], [], cache)
    try {
      await flushPromises()
      expect(wrapper.get('.visual-folder__mosaic img').attributes('src')).toBe('https://native/old')
      wrapper.unmount()
      wrapper = render(categories, [card], [], cache)
      await nextTick()
      expect(wrapper.get('.visual-folder__mosaic img').attributes('src')).toBe('https://native/old')
      expect(direct).toHaveBeenCalledTimes(1)
      await wrapper.setProps({ resources: [{ ...card, thumbnailAssetId: 'new' }] })
      await flushPromises()
      expect(wrapper.get('.visual-folder__mosaic img').attributes('src')).toBe('https://native/new')
      expect(direct).toHaveBeenCalledTimes(2)
      expect(bytes).not.toHaveBeenCalled()
      expect(create).not.toHaveBeenCalled()
    } finally {
      wrapper.unmount()
      cache.clear()
    }
    expect(revoke).not.toHaveBeenCalled()
  })

  it('falls back once after a native display error and replaces its cached address with a Blob', async () => {
    vi.spyOn(assetStore, 'supportsImageUrls', 'get').mockReturnValue(true)
    const cache = createFolderThumbnailCache()
    const card = { ...resource('fallback', '回退封面', ['folder-a']), thumbnailAssetId: 'asset' }
    const direct = vi.spyOn(assetStore, 'getImageUrl').mockResolvedValue('https://native/broken')
    const bytes = vi.spyOn(assetStore, 'getBlob').mockResolvedValue(new Blob(['image']))
    let wrapper = render(categories, [card], [], cache)
    try {
      await flushPromises()
      await wrapper.get('.visual-folder__mosaic img').trigger('error')
      await flushPromises()
      expect(wrapper.get('.visual-folder__mosaic img').attributes('src')).toMatch(/^blob:/)
      await wrapper.get('.visual-folder__mosaic img').trigger('error')
      await flushPromises()
      expect(bytes).toHaveBeenCalledTimes(1)
      wrapper.unmount()
      wrapper = render(categories, [card], [], cache)
      await nextTick()
      expect(wrapper.get('.visual-folder__mosaic img').attributes('src')).toMatch(/^blob:/)
      expect(direct).toHaveBeenCalledTimes(1)
      expect(bytes).toHaveBeenCalledTimes(1)
    } finally {
      wrapper.unmount()
      cache.clear()
    }
  })

  it.each([undefined, 'https://native/late'])(
    'discards a late native result %s after unmount without falling back or retaining it',
    async (result) => {
      vi.spyOn(assetStore, 'supportsImageUrls', 'get').mockReturnValue(true)
      const cache = createFolderThumbnailCache()
      const card = {
        ...resource('late-native', '原生封面', ['folder-a']),
        thumbnailAssetId: 'asset',
      }
      let finish!: (url: string | undefined) => void
      vi.spyOn(assetStore, 'getImageUrl').mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      )
      const bytes = vi.spyOn(assetStore, 'getBlob')
      const wrapper = render(categories, [card], [], cache)
      await nextTick()
      wrapper.unmount()
      finish(result)
      await flushPromises()
      expect(bytes).not.toHaveBeenCalled()
      expect(cache.acquire(card)).toBeUndefined()
      cache.clear()
    },
  )

  it('clears native covers on source removal and does not cache storage failures', async () => {
    vi.spyOn(assetStore, 'supportsImageUrls', 'get').mockReturnValue(true)
    const cache = createFolderThumbnailCache()
    const card = { ...resource('locked', '封面', ['folder-a']), thumbnailAssetId: 'asset' }
    const direct = vi
      .spyOn(assetStore, 'getImageUrl')
      .mockResolvedValueOnce('https://native/asset')
      .mockRejectedValue(new Error('storage failure'))
    const bytes = vi.spyOn(assetStore, 'getBlob')
    const wrapper = render(categories, [card], [], cache)
    try {
      await flushPromises()
      cache.prune([])
      await wrapper.setProps({ resources: [] })
      expect(wrapper.find('.visual-folder__mosaic img').exists()).toBe(false)
      await wrapper.setProps({ resources: [card] })
      await flushPromises()
      expect(direct).toHaveBeenCalledTimes(2)
      expect(bytes).not.toHaveBeenCalled()
      expect(cache.acquire(card)).toBeUndefined()
    } finally {
      wrapper.unmount()
      cache.clear()
    }
  })

  it('reuses ready covers synchronously on reentry and reloads a changed cover', async () => {
    const cache = createFolderThumbnailCache()
    const card = {
      ...resource('cached-cover', '封面', ['folder-a']),
      thumbnailAssetId: 'asset-old',
    }
    const getBlob = vi.spyOn(assetStore, 'getBlob').mockResolvedValue(new Blob(['cover']))
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    let wrapper = render(categories, [card], [], cache)
    try {
      await flushPromises()
      const url = wrapper.get('.visual-folder__mosaic img').attributes('src')
      wrapper.unmount()
      expect(revoke).not.toHaveBeenCalledWith(url)
      wrapper = render(categories, [card], [], cache)
      await nextTick()
      expect(wrapper.get('.visual-folder__mosaic img').attributes('src')).toBe(url)
      expect(getBlob).toHaveBeenCalledTimes(1)
      await wrapper.setProps({ resources: [{ ...card, thumbnailAssetId: 'asset-new' }] })
      await flushPromises()
      expect(getBlob).toHaveBeenCalledTimes(2)
      expect(wrapper.get('.visual-folder__mosaic img').attributes('src')).not.toBe(url)
      expect(revoke).toHaveBeenCalledWith(url)
    } finally {
      wrapper.unmount()
      cache.clear()
    }
  })

  it('does not retain a thumbnail whose native read finishes after leaving the cabinet', async () => {
    const cache = createFolderThumbnailCache()
    const card = { ...resource('late-cover', '封面', ['folder-a']), thumbnailAssetId: 'late-asset' }
    let finish!: (blob: Blob) => void
    vi.spyOn(assetStore, 'getBlob').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const wrapper = render(categories, [card], [], cache)
    await nextTick()
    wrapper.unmount()
    finish(new Blob(['late']))
    await flushPromises()
    expect(cache.acquire(card)).toBeUndefined()
    cache.clear()
  })
  beforeEach(() => localStorage.clear())

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    Reflect.deleteProperty(document, 'elementFromPoint')
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
  })

  it('uses shared categories and renders pinned resources as desktop icons', () => {
    const wrapper = render(undefined, undefined, ['b'])
    expect(wrapper.text()).toContain('古风收藏')
    expect(wrapper.get('[data-cabinet-resource-id="b"]').text()).toContain('待整理')
    expect(wrapper.text()).toContain('1 项资源')
  })

  it('keeps the resource thumbnail mosaic ahead of the empty-folder artwork', async () => {
    const card = resource('cover-card', '封面角色', ['folder-a'])
    card.thumbnailBlob = new Blob(['thumbnail'], { type: 'image/png' })
    const wrapper = render(categories, [card])
    await nextTick()

    expect(wrapper.find('.visual-folder__mosaic').exists()).toBe(true)
    expect(wrapper.get('.visual-folder__mosaic img').attributes('src')).toMatch(/^blob:/)
    expect(wrapper.find('.visual-folder__empty-art').exists()).toBe(false)
  })

  it('shows ready thumbnails before slow ones and does not preload a closed organizer', async () => {
    const cards = Array.from({ length: 60 }, (_, index) => ({
      ...resource(`card-${index}`, `卡片${index}`),
      thumbnailAssetId: `asset-${index}`,
    }))
    const pending = new Map<string, (blob: Blob) => void>()
    const getBlob = vi
      .spyOn(assetStore, 'getBlob')
      .mockImplementation((id) => new Promise<Blob>((resolve) => pending.set(id, resolve)))
    const wrapper = render([], cards, ['card-0', 'card-1', 'card-2', 'card-3'])
    try {
      await flushPromises()
      expect(getBlob).toHaveBeenCalledTimes(4)
      pending.get('asset-0')!(new Blob(['first'], { type: 'image/png' }))
      await flushPromises()
      expect(wrapper.get('[data-cabinet-resource-id="card-0"] img').attributes('src')).toMatch(
        /^blob:/,
      )
      expect(wrapper.find('[data-cabinet-resource-id="card-1"] img').exists()).toBe(false)
      for (let index = 1; index < 4; index++) {
        pending.get(`asset-${index}`)!(new Blob(['image'], { type: 'image/png' }))
        await flushPromises()
      }
      expect(getBlob).toHaveBeenCalledTimes(4)
      expect(getBlob).not.toHaveBeenCalledWith('asset-4')
    } finally {
      wrapper.unmount()
    }
  })
  it.each([1000, 5000, 10000])(
    'does not rescan %i folder entries when visible images finish loading',
    async (size) => {
      let inspected = 0
      const emptyImages = Array.from({ length: size }, (_, index) => {
        const item = resource(`empty-${index}`, '无图片', ['folder-b'])
        Object.defineProperty(item, 'thumbnailAssetId', {
          enumerable: true,
          get: () => {
            inspected++
            return undefined
          },
        })
        return item
      })
      const pending = new Map<string, (blob: Blob) => void>()
      const getBlob = vi
        .spyOn(assetStore, 'getBlob')
        .mockImplementation((id) => new Promise<Blob>((resolve) => pending.set(id, resolve)))
      const images = Array.from({ length: 4 }, (_, index) => ({
        ...resource(`image-${index}`, '封面', ['folder-a']),
        thumbnailAssetId: `asset-${index}`,
      }))
      const wrapper = render(
        [...categories, { ...categories[0]!, id: 'folder-b', name: '无图文件夹' }],
        [...images, ...emptyImages],
      )
      try {
        await flushPromises()
        expect(getBlob).toHaveBeenCalledTimes(4)
        expect(inspected).toBeGreaterThanOrEqual(size)
        inspected = 0
        for (const resolve of pending.values()) {
          resolve(new Blob(['image'], { type: 'image/png' }))
          await flushPromises()
        }
        expect(wrapper.findAll('.visual-folder__mosaic img')).toHaveLength(4)
        expect(inspected).toBe(0)
        expect(getBlob).toHaveBeenCalledTimes(4)
      } finally {
        wrapper.unmount()
      }
    },
  )

  it('discards late thumbnail reads after leaving the cabinet', async () => {
    let resolve!: (blob: Blob) => void
    vi.spyOn(assetStore, 'getBlob').mockImplementation(
      () =>
        new Promise<Blob>((done) => {
          resolve = done
        }),
    )
    const create = vi.spyOn(URL, 'createObjectURL')
    const wrapper = render(
      [],
      [{ ...resource('card', '卡片'), thumbnailAssetId: 'asset' }],
      ['card'],
    )
    await flushPromises()
    wrapper.unmount()
    resolve(new Blob(['late']))
    await flushPromises()
    expect(create).not.toHaveBeenCalled()
  })

  it('keeps loading other images when one asset is unavailable and reads again on reentry', async () => {
    const getBlob = vi.spyOn(assetStore, 'getBlob').mockImplementation(async (id) => {
      if (id === 'missing') throw new Error('missing thumbnail')
      return new Blob(['image'], { type: 'image/png' })
    })
    const cards = [
      { ...resource('a', '缺失'), thumbnailAssetId: 'missing' },
      { ...resource('b', '正常'), thumbnailAssetId: 'ready' },
    ]
    for (let entry = 0; entry < 2; entry++) {
      const wrapper = render([], cards, ['a', 'b'])
      try {
        await flushPromises()
        expect(wrapper.get('[data-cabinet-resource-id="b"] img').attributes('src')).toMatch(
          /^blob:/,
        )
        expect(wrapper.find('[data-cabinet-resource-id="a"] img').exists()).toBe(false)
      } finally {
        wrapper.unmount()
      }
    }
    expect(getBlob).toHaveBeenCalledTimes(4)
  })

  it('opens a visual folder inside the cabinet and returns without leaving it', async () => {
    const wrapper = render()
    await wrapper.get('button[aria-label="打开古风收藏"]').trigger('click')
    expect(wrapper.get('.feature-app-header h1').text()).toBe('古风收藏')
    expect(wrapper.get('.folder-detail').text()).toContain('青衣')

    await wrapper.get('[aria-label="返回收藏柜"]').trigger('click')
    expect(wrapper.find('.folder-detail').exists()).toBe(false)
    expect(wrapper.get('button[aria-label="打开古风收藏"]')).toBeDefined()
  })

  it('consumes Escape after returning from a folder so the feature hub does not also close', async () => {
    const wrapper = render()
    await wrapper.get('button[aria-label="打开古风收藏"]').trigger('click')
    const parentEscapeHandler = vi.fn()
    window.addEventListener('keydown', parentEscapeHandler)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
    await nextTick()

    expect(wrapper.find('.folder-detail').exists()).toBe(false)
    expect(parentEscapeHandler).not.toHaveBeenCalled()
    window.removeEventListener('keydown', parentEscapeHandler)
  })

  it('opens a resource from the folder detail without losing cabinet state', async () => {
    const wrapper = render()
    await wrapper.get('button[aria-label="打开古风收藏"]').trigger('click')
    await wrapper.get('.folder-detail__resource').trigger('click')

    expect(wrapper.emitted('openResource')).toEqual([[expect.objectContaining({ id: 'a' })]])
    expect(wrapper.find('.folder-detail').exists()).toBe(true)
  })

  it('supports touch-friendly selection before adding resources to a folder', async () => {
    const wrapper = render()
    const resourceButton = wrapper
      .findAll('.folder-tray__resource')
      .find((button) => button.text().includes('待整理'))
    expect(resourceButton).toBeDefined()
    await resourceButton?.trigger('click')

    const addButton = wrapper
      .findAll('.visual-folder__add-selected')
      .find((button) => button.text().includes('加入 1 项'))
    expect(addButton).toBeDefined()
    await addButton?.trigger('click')
    expect(wrapper.emitted('add')).toEqual([[{ categoryId: 'folder-a', resourceIds: ['b'] }]])
  })

  it('exposes cover customization and folder management', async () => {
    const wrapper = render()
    await enterFolderEditMode(wrapper)
    await wrapper.get('.visual-folder__rename').trigger('click')
    expect(wrapper.get('.folder-rename__sheet').text()).toContain('HTTPS 封面直链')
    expect(wrapper.get('.folder-rename__cover-actions').text()).toContain('导入本地图片')
    await wrapper.get('.folder-rename__sheet button').trigger('click')
    await wrapper.get('.folder-library__manage').trigger('click')
    expect(wrapper.emitted('manage')).toHaveLength(1)
  })

  it('keeps cover customization out of the folder detail view', async () => {
    const wrapper = render()
    await wrapper.get('button[aria-label="打开古风收藏"]').trigger('click')

    expect(wrapper.find('.folder-detail__cover-action').exists()).toBe(false)
    expect(wrapper.find('.folder-detail__tools').exists()).toBe(false)
    expect(wrapper.get('[aria-label="添加资源到当前文件夹"]').find('svg').exists()).toBe(true)
  })

  it('adds selected resources directly to the current folder without a destination step', async () => {
    const wrapper = render()
    await wrapper.get('button[aria-label="打开古风收藏"]').trigger('click')
    await wrapper.get('[aria-label="添加资源到当前文件夹"]').trigger('click')
    expect(wrapper.get('.folder-organizer__step small').text()).toBe('选择资源')
    expect(wrapper.find('.folder-organizer__targets-stage').exists()).toBe(false)
    const resourceButton = wrapper
      .findAll('.folder-organizer__resource')
      .find((button) => button.text().includes('待整理'))
    expect(resourceButton).toBeDefined()
    await resourceButton?.trigger('click')
    expect(wrapper.get('.folder-organizer__selection').text()).toContain('已选 1 项')
    expect(wrapper.find('.folder-organizer__targets').exists()).toBe(false)
    await wrapper.get('.folder-organizer__folder-action button').trigger('click')

    expect(wrapper.emitted('add')).toContainEqual([{ categoryId: 'folder-a', resourceIds: ['b'] }])
    expect(wrapper.find('.folder-organizer').exists()).toBe(false)
  })

  it('uses the newly opened folder as the destination and disables empty or busy submission', async () => {
    const wrapper = render([
      ...categories,
      { ...categories[0]!, id: 'folder-b', name: '另一个文件夹' },
    ])
    await wrapper.get('[aria-label="打开古风收藏"]').trigger('click')
    await wrapper.get('[aria-label="添加资源到当前文件夹"]').trigger('click')
    expect(
      wrapper.get('.folder-organizer__folder-action button').attributes('disabled'),
    ).toBeDefined()
    await wrapper.get('[aria-label="关闭添加资源"]').trigger('click')
    await wrapper.get('[aria-label="返回收藏柜"]').trigger('click')
    await wrapper.get('[aria-label="打开另一个文件夹"]').trigger('click')
    await wrapper.get('[aria-label="添加资源到当前文件夹"]').trigger('click')
    await wrapper.get('.folder-organizer__resource').trigger('click')
    await wrapper.setProps({ busy: true })
    expect(
      wrapper.get('.folder-organizer__folder-action button').attributes('disabled'),
    ).toBeDefined()
    await wrapper.setProps({ busy: false })
    await wrapper.get('.folder-organizer__folder-action button').trigger('click')
    expect(wrapper.emitted('add')).toEqual([[{ categoryId: 'folder-b', resourceIds: ['b'] }]])
  })

  it('places folder search before filters and keeps search scoped to the open folder', async () => {
    const wrapper = render()
    await wrapper.get('[aria-label="打开古风收藏"]').trigger('click')
    expect(wrapper.get('.folder-detail').element.firstElementChild?.className).toBe(
      'folder-detail__search',
    )
    await wrapper.get('[aria-label="在当前文件夹中搜索"]').setValue('待整理')
    expect(wrapper.find('.folder-detail__resource').exists()).toBe(false)
    await wrapper.get('[aria-label="在当前文件夹中搜索"]').setValue('青衣')
    expect(wrapper.get('.folder-detail__resource').text()).toContain('青衣')
  })

  it('excludes current-folder resources from all candidates, counts, type filters and search', async () => {
    const wrapper = render(categories, [
      resource('a', '青衣', ['folder-a']),
      resource('b', '待整理'),
      resource('c', '别处收藏', ['folder-b']),
      resource('d', '共用世界书', ['folder-b', 'folder-a'], RESOURCE_TYPE.WORLD_BOOK),
    ])
    await wrapper.get('button[aria-label="打开古风收藏"]').trigger('click')
    await wrapper.get('[aria-label="添加资源到当前文件夹"]').trigger('click')

    const filterButtons = wrapper.findAll('.folder-type-filter--organizer button')
    const unclassified = filterButtons.find((button) => button.text().includes('未分类'))
    const all = filterButtons.find((button) => button.text().includes('全部'))
    expect(unclassified?.attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('.folder-organizer__resources').text()).toContain('待整理')
    expect(wrapper.get('.folder-organizer__resources').text()).not.toContain('青衣')

    await all?.trigger('click')
    expect(wrapper.get('.folder-organizer__resources').text()).toContain('待整理')
    expect(wrapper.get('.folder-organizer__resources').text()).not.toContain('青衣')
    expect(wrapper.get('.folder-organizer__resources').text()).toContain('别处收藏')
    expect(all?.text()).toBe('全部 2')
    const cards = filterButtons.find((button) => button.text().includes('角色卡'))
    expect(cards?.text()).toBe('角色卡 2')
    expect(filterButtons.some((button) => button.text().includes('世界书'))).toBe(false)
    await cards?.trigger('click')
    expect(wrapper.findAll('.folder-organizer__resource')).toHaveLength(2)
    await wrapper.get('.folder-organizer input[type="search"]').setValue('青衣')
    expect(wrapper.find('.folder-organizer__resource').exists()).toBe(false)
    await wrapper.get('.folder-organizer input[type="search"]').setValue('别处收藏')
    await wrapper.get('.folder-organizer__resource').trigger('click')
    await wrapper.get('.folder-organizer__folder-action button').trigger('click')
    expect(wrapper.emitted('add')).toEqual([[{ categoryId: 'folder-a', resourceIds: ['c'] }]])
  })

  it('hides newly added resources when reopening and preserves cabinet candidates', async () => {
    const wrapper = render()
    await wrapper.get('[aria-label="打开古风收藏"]').trigger('click')
    await wrapper.get('[aria-label="添加资源到当前文件夹"]').trigger('click')
    await wrapper.get('.folder-organizer__resource').trigger('click')
    await wrapper.get('.folder-organizer__folder-action button').trigger('click')
    await wrapper.setProps({
      resources: [resource('a', '青衣', ['folder-a']), resource('b', '待整理', ['folder-a'])],
    })
    await wrapper.get('[aria-label="添加资源到当前文件夹"]').trigger('click')
    expect(wrapper.find('.folder-organizer__resource').exists()).toBe(false)
    expect(wrapper.find('.folder-type-filter--organizer').exists()).toBe(false)
    expect(
      wrapper.get('.folder-organizer__folder-action button').attributes('disabled'),
    ).toBeDefined()
    await wrapper.get('[aria-label="关闭添加资源"]').trigger('click')
    await wrapper.get('[aria-label="返回收藏柜"]').trigger('click')
    await enterFolderEditMode(wrapper)
    await wrapper.get('.folder-library__organize').trigger('click')
    expect(wrapper.findAll('.folder-organizer__resource')).toHaveLength(2)
  })

  it('pins selected resources to the cabinet only from edit mode', async () => {
    const wrapper = render()
    expect(wrapper.find('.folder-library__dock').exists()).toBe(false)
    await enterFolderEditMode(wrapper)
    await wrapper.get('.folder-library__organize').trigger('click')
    expect(wrapper.get('#folder-organizer-title').text()).toBe('放入收藏柜')
    const resourceButton = wrapper
      .findAll('.folder-organizer__resource')
      .find((button) => button.text().includes('待整理'))
    await resourceButton?.trigger('click')
    await wrapper.get('.folder-organizer__cabinet-action button').trigger('click')

    expect(wrapper.emitted('pin')).toEqual([[['b']]])
    expect(wrapper.find('.folder-organizer').exists()).toBe(false)
  })

  it('removes a pinned desktop icon without deleting the resource', async () => {
    const wrapper = render(undefined, undefined, ['b'])
    await enterFolderEditMode(wrapper)

    await wrapper.get('button[aria-label="从收藏柜移除待整理"]').trigger('click')

    expect(wrapper.emitted('unpin')).toEqual([['b']])
    expect(wrapper.props('resources').some((item) => item.id === 'b')).toBe(true)
    expect(wrapper.emitted('openResource')).toBeUndefined()
  })

  it('drags a pinned desktop resource into a shared folder and removes its desktop pin', async () => {
    vi.useFakeTimers()
    const wrapper = render(undefined, undefined, ['b'])
    const source = wrapper.get('[data-cabinet-resource-id="b"]')
    const target = wrapper.get('[data-folder-drop-id="folder-a"]').element
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => target),
    })
    await dispatchPointer(source.element, 'pointerdown', {
      pointerType: 'touch',
      pointerId: 71,
      clientX: 180,
      clientY: 200,
    })
    await vi.advanceTimersByTimeAsync(421)
    await dispatchPointer(source.element, 'pointermove', {
      pointerType: 'touch',
      pointerId: 71,
      clientX: 80,
      clientY: 120,
    })
    await dispatchPointer(source.element, 'pointerup', {
      pointerType: 'touch',
      pointerId: 71,
      clientX: 80,
      clientY: 120,
    })

    expect(wrapper.emitted('add')).toContainEqual([
      { categoryId: 'folder-a', resourceIds: ['b'], removeFromCabinet: true },
    ])
  })

  it('supports long-press touch dragging onto a folder target', async () => {
    vi.useFakeTimers()
    const wrapper = render()
    const resourceButton = wrapper
      .findAll('.folder-tray__resource')
      .find((button) => button.text().includes('待整理'))
    expect(resourceButton).toBeDefined()

    await dispatchPointer(resourceButton!.element, 'pointerdown', {
      pointerType: 'touch',
      pointerId: 7,
      clientX: 40,
      clientY: 500,
    })
    vi.advanceTimersByTime(321)
    await nextTick()
    expect(wrapper.find('.folder-touch-drag').exists()).toBe(true)

    const target = wrapper.get('[data-folder-drop-id="folder-a"]').element
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => target),
    })
    await dispatchPointer(resourceButton!.element, 'pointermove', {
      pointerType: 'touch',
      pointerId: 7,
      clientX: 80,
      clientY: 120,
    })
    await dispatchPointer(resourceButton!.element, 'pointerup', {
      pointerType: 'touch',
      pointerId: 7,
      clientX: 80,
      clientY: 120,
    })

    expect(wrapper.emitted('add')).toContainEqual([
      { categoryId: 'folder-a', resourceIds: ['b'], removeFromCabinet: false },
    ])
  })

  it('keeps twelve stable app slots per phone page and leaves empty positions', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    const manyCategories = Array.from({ length: 14 }, (_, index): Category => ({
      id: `folder-${index + 1}`,
      name: `文件夹${index + 1}`,
      color: '#486b5d',
      sortOrder: index,
      createdAt: index,
      updatedAt: index,
    }))
    const wrapper = render(manyCategories, [])

    expect(wrapper.findAll('[data-folder-order-id]')).toHaveLength(12)
    expect(wrapper.text()).toContain('1 / 2')
    await wrapper.get('button[aria-label="下一页文件夹"]').trigger('click')
    expect(wrapper.findAll('[data-folder-order-id]')).toHaveLength(2)
    expect(wrapper.findAll('.visual-folder--empty-slot')).toHaveLength(10)
    expect(wrapper.text()).toContain('文件夹14')
  })

  it('uses six stable slots when the user chooses two cabinet columns', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    new BrowserStorageService().setCabinetColumns(2)
    const manyCategories = Array.from({ length: 7 }, (_, index): Category => ({
      id: `folder-${index + 1}`,
      name: `文件夹${index + 1}`,
      color: '#486b5d',
      sortOrder: index,
      createdAt: index,
      updatedAt: index,
    }))
    const wrapper = render(manyCategories, [])

    expect(wrapper.get('.folder-library').attributes('style')).toContain('--cabinet-columns: 2')
    expect(wrapper.findAll('[data-folder-order-id]')).toHaveLength(6)
    expect(wrapper.text()).toContain('1 / 2')
    await wrapper.get('button[aria-label="下一页文件夹"]').trigger('click')
    expect(wrapper.findAll('[data-folder-order-id]')).toHaveLength(1)
    expect(wrapper.findAll('.visual-folder--empty-slot')).toHaveLength(5)
  })

  it('moves exactly one page with a deliberate horizontal swipe', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    const manyCategories = Array.from({ length: 13 }, (_, index): Category => ({
      id: `folder-${index + 1}`,
      name: `文件夹${index + 1}`,
      color: '#486b5d',
      sortOrder: index,
      createdAt: index,
      updatedAt: index,
    }))
    const wrapper = render(manyCategories, [])
    const pager = wrapper.get('.folder-library__pager').element
    const firstPageGrid = wrapper.get('.folder-library__grid').element
    await dispatchPointer(pager, 'pointerdown', {
      pointerType: 'touch',
      pointerId: 11,
      clientX: 300,
      clientY: 300,
    })
    await dispatchPointer(pager, 'pointermove', {
      pointerType: 'touch',
      pointerId: 11,
      clientX: 210,
      clientY: 305,
    })
    await dispatchPointer(pager, 'pointerup', {
      pointerType: 'touch',
      pointerId: 11,
      clientX: 210,
      clientY: 305,
    })

    expect(wrapper.text()).toContain('2 / 2')
    expect(wrapper.text()).toContain('文件夹13')
    expect(wrapper.text()).not.toContain('文件夹12')
    expect(wrapper.get('.folder-library__grid').element).not.toBe(firstPageGrid)
  })

  it('filters resources inside a folder by resource type', async () => {
    const wrapper = render(categories, [
      resource('a', '青衣', ['folder-a']),
      resource('b', '江湖设定', ['folder-a'], RESOURCE_TYPE.WORLD_BOOK),
    ])
    await wrapper.get('button[aria-label="打开古风收藏"]').trigger('click')
    const worldBookFilter = wrapper
      .findAll('.folder-type-filter button')
      .find((button) => button.text().includes('世界书'))
    expect(worldBookFilter).toBeDefined()
    await worldBookFilter?.trigger('click')

    expect(wrapper.get('.folder-detail__grid').text()).toContain('江湖设定')
    expect(wrapper.get('.folder-detail__grid').text()).not.toContain('青衣')
  })

  it('renames a folder from desktop edit mode without opening it', async () => {
    const wrapper = render()
    await enterFolderEditMode(wrapper)
    await wrapper.get('.visual-folder__rename').trigger('click')
    await wrapper.get('.folder-rename__sheet input').setValue('新的收藏名')
    await wrapper.get('.folder-rename__sheet').trigger('submit')

    expect(wrapper.emitted('rename')).toEqual([
      [{ category: expect.objectContaining({ id: 'folder-a' }), name: '新的收藏名' }],
    ])
    expect(wrapper.find('.folder-detail').exists()).toBe(false)
  })

  it('saves an https folder cover from the edit sheet', async () => {
    const wrapper = render()
    await enterFolderEditMode(wrapper)
    await wrapper.get('.visual-folder__rename').trigger('click')
    await wrapper
      .get('.folder-rename__sheet input[type="url"]')
      .setValue('https://images.example.com/folder.webp')
    await wrapper.get('.folder-rename__sheet').trigger('submit')

    expect(wrapper.emitted('cover')).toEqual([
      [
        {
          category: expect.objectContaining({ id: 'folder-a' }),
          coverUrl: 'https://images.example.com/folder.webp',
        },
      ],
    ])
  })

  it('submits a changed folder name and https cover as one edit payload', async () => {
    const wrapper = render()
    await enterFolderEditMode(wrapper)
    await wrapper.get('.visual-folder__rename').trigger('click')
    await wrapper.get('.folder-rename__sheet input').setValue('新的收藏名')
    await wrapper
      .get('.folder-rename__sheet input[type="url"]')
      .setValue('https://images.example.com/folder.webp')
    await wrapper.get('.folder-rename__sheet').trigger('submit')

    expect(wrapper.emitted('rename')).toEqual([
      [
        {
          category: expect.objectContaining({ id: 'folder-a' }),
          name: '新的收藏名',
          coverImage: 'https://images.example.com/folder.webp',
          coverChanged: true,
        },
      ],
    ])
    expect(wrapper.emitted('cover')).toBeUndefined()
  })

  it('submits a changed folder name and local cover as one edit payload', async () => {
    const wrapper = render()
    await enterFolderEditMode(wrapper)
    await wrapper.get('.visual-folder__rename').trigger('click')
    await wrapper.get('.folder-rename__sheet input').setValue('本地封面收藏')
    const file = new File(['cover'], 'cover.webp', { type: 'image/webp' })
    const input = wrapper.get('.folder-rename__sheet input[type="file"]')
    Object.defineProperty(input.element, 'files', { configurable: true, value: [file] })
    await input.trigger('change')

    expect(wrapper.emitted('rename')).toEqual([
      [
        {
          category: expect.objectContaining({ id: 'folder-a' }),
          name: '本地封面收藏',
          file,
          coverChanged: true,
        },
      ],
    ])
    expect(wrapper.emitted('cover')).toBeUndefined()
  })

  it('submits a changed folder name while restoring the automatic cover', async () => {
    const wrapper = render(
      [{ ...categories[0]!, coverImage: 'https://images.example.com/old.webp' }],
      [],
    )
    await enterFolderEditMode(wrapper)
    await wrapper.get('.visual-folder__rename').trigger('click')
    await wrapper.get('.folder-rename__sheet input').setValue('自动拼贴收藏')
    const restoreButton = wrapper
      .findAll('.folder-rename__cover-actions button')
      .find((button) => button.text().includes('恢复自动拼贴'))
    expect(restoreButton).toBeDefined()
    await restoreButton?.trigger('click')

    expect(wrapper.emitted('rename')).toEqual([
      [
        {
          category: expect.objectContaining({ id: 'folder-a' }),
          name: '自动拼贴收藏',
          coverChanged: true,
          coverImage: undefined,
        },
      ],
    ])
    expect(wrapper.emitted('cover')).toBeUndefined()
  })

  it('uses all four arrow keys to move a folder through the four-column grid', async () => {
    const manyCategories: Category[] = Array.from({ length: 5 }, (_, index) => ({
      ...categories[0]!,
      id: `folder-${index + 1}`,
      name: `文件夹${index + 1}`,
      sortOrder: index,
    }))
    const wrapper = render(manyCategories, [])
    await enterFolderEditMode(wrapper)

    await wrapper.get('button[aria-label="调整文件夹1"]').trigger('keydown', { key: 'ArrowDown' })

    expect(wrapper.emitted('reorder')).toEqual([
      [['folder-2', 'folder-3', 'folder-4', 'folder-5', 'folder-1']],
    ])
  })

  it('moves folders into real empty desktop slots and persists the sparse position', async () => {
    vi.useFakeTimers()
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    const wrapper = render()
    const folder = wrapper.get('[data-folder-order-id="folder-a"]')
    const emptySlot = wrapper.get('[data-cabinet-slot="5"]')
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => emptySlot.element),
    })

    await dispatchPointer(folder.element, 'pointerdown', {
      pointerId: 73,
      pointerType: 'touch',
      button: 0,
      clientX: 60,
      clientY: 90,
    })
    await vi.advanceTimersByTimeAsync(430)
    await dispatchPointer(window, 'pointermove', {
      pointerId: 73,
      pointerType: 'touch',
      clientX: 220,
      clientY: 360,
    })
    await dispatchPointer(window, 'pointerup', {
      pointerId: 73,
      pointerType: 'touch',
      clientX: 220,
      clientY: 360,
    })

    expect(new BrowserStorageService().getCabinetLayout()).toContainEqual(
      expect.objectContaining({ kind: 'folder', id: 'folder-a', slot: 5 }),
    )
  })

  it('uses the same edit-first hold timing for pinned resources and lets them fill empty slots', async () => {
    vi.useFakeTimers()
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    const wrapper = render(undefined, undefined, ['b'])
    const pinned = wrapper.get('[data-cabinet-resource-id="b"]')

    await dispatchPointer(pinned.element, 'pointerdown', {
      pointerId: 81,
      pointerType: 'touch',
      button: 0,
      clientX: 140,
      clientY: 90,
    })
    await vi.advanceTimersByTimeAsync(330)
    expect(wrapper.find('.folder-library__dock').exists()).toBe(false)
    expect(wrapper.find('.folder-touch-drag').exists()).toBe(false)
    await vi.advanceTimersByTimeAsync(89)
    expect(wrapper.find('.folder-library__dock').exists()).toBe(false)
    expect(wrapper.find('.folder-touch-drag').exists()).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    expect(wrapper.find('.folder-library__dock').exists()).toBe(true)
    expect(wrapper.find('.folder-touch-drag').exists()).toBe(true)

    const emptySlot = wrapper.get('[data-cabinet-slot="6"]')
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => emptySlot.element),
    })
    await dispatchPointer(window, 'pointermove', {
      pointerId: 81,
      pointerType: 'touch',
      clientX: 230,
      clientY: 360,
    })
    await dispatchPointer(window, 'pointerup', {
      pointerId: 81,
      pointerType: 'touch',
      clientX: 230,
      clientY: 360,
    })

    expect(new BrowserStorageService().getCabinetLayout()).toContainEqual(
      expect.objectContaining({ kind: 'resource', id: 'b', slot: 6 }),
    )
  })

  it('requires a stationary long press before reordering folders', async () => {
    vi.useFakeTimers()
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    const twoCategories: Category[] = [
      { ...categories[0]!, sortOrder: 0 },
      {
        id: 'folder-b',
        name: '世界书收藏',
        color: '#8a6a47',
        sortOrder: 1,
        createdAt: 2,
        updatedAt: 2,
      },
    ]
    const wrapper = render(twoCategories, [])
    const source = wrapper.get('[data-folder-order-id="folder-a"]').element
    const target = wrapper.get('[data-folder-order-id="folder-b"]').element
    await dispatchPointer(source, 'pointerdown', {
      pointerType: 'touch',
      pointerId: 19,
      clientX: 70,
      clientY: 240,
    })
    vi.advanceTimersByTime(419)
    await nextTick()
    expect(wrapper.find('.folder-order-drag').exists()).toBe(false)
    vi.advanceTimersByTime(2)
    await nextTick()
    expect(wrapper.find('.folder-order-drag').exists()).toBe(true)

    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => target),
    })
    await dispatchPointer(window, 'pointermove', {
      pointerType: 'touch',
      pointerId: 19,
      clientX: 220,
      clientY: 240,
    })
    await vi.advanceTimersByTimeAsync(17)
    await nextTick()
    expect(
      wrapper
        .findAll('[data-folder-order-id]')
        .map((folder) => folder.attributes('data-folder-order-id')),
    ).toEqual(['folder-b', 'folder-a'])
    await dispatchPointer(window, 'pointerup', {
      pointerType: 'touch',
      pointerId: 19,
      clientX: 220,
      clientY: 240,
    })

    expect(wrapper.emitted('reorder')).toEqual([[['folder-b', 'folder-a']]])
    expect(
      wrapper
        .findAll('[data-folder-order-id]')
        .map((folder) => folder.attributes('data-folder-order-id')),
    ).toEqual(['folder-b', 'folder-a'])
    expect(new BrowserStorageService().getCabinetLayout()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'folder', id: 'folder-b', slot: 0 }),
        expect.objectContaining({ kind: 'folder', id: 'folder-a', slot: 1 }),
      ]),
    )
  })

  it('inserts a dragged folder at the target slot and shifts intervening folders like iOS', async () => {
    vi.useFakeTimers()
    const threeCategories: Category[] = [
      { ...categories[0]!, sortOrder: 0 },
      {
        id: 'folder-b',
        name: '世界书收藏',
        color: '#8a6a47',
        sortOrder: 1,
        createdAt: 2,
        updatedAt: 2,
      },
      {
        id: 'folder-c',
        name: '预设收藏',
        color: '#735f8a',
        sortOrder: 2,
        createdAt: 3,
        updatedAt: 3,
      },
    ]
    const wrapper = render(threeCategories, [])
    const source = wrapper.get('[data-folder-order-id="folder-a"]').element
    const target = wrapper.get('[data-folder-order-id="folder-c"]').element
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => target),
    })

    await dispatchPointer(source, 'pointerdown', {
      pointerType: 'touch',
      pointerId: 29,
      button: 0,
      clientX: 60,
      clientY: 180,
    })
    await vi.advanceTimersByTimeAsync(421)
    await dispatchPointer(window, 'pointermove', {
      pointerType: 'touch',
      pointerId: 29,
      clientX: 300,
      clientY: 180,
    })
    await vi.advanceTimersByTimeAsync(17)

    expect(
      wrapper
        .findAll('[data-folder-order-id]')
        .map((folder) => folder.attributes('data-folder-order-id')),
    ).toEqual(['folder-b', 'folder-c', 'folder-a'])

    await dispatchPointer(window, 'pointerup', {
      pointerType: 'touch',
      pointerId: 29,
      clientX: 300,
      clientY: 180,
    })

    expect(wrapper.emitted('reorder')).toEqual([[['folder-b', 'folder-c', 'folder-a']]])
    expect(new BrowserStorageService().getCabinetLayout()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'folder', id: 'folder-b', slot: 0 }),
        expect.objectContaining({ kind: 'folder', id: 'folder-c', slot: 1 }),
        expect.objectContaining({ kind: 'folder', id: 'folder-a', slot: 2 }),
      ]),
    )
  })

  it('keeps folder layout persistence off the pointermove hot path', async () => {
    vi.useFakeTimers()
    const twoCategories: Category[] = [
      { ...categories[0]!, sortOrder: 0 },
      {
        id: 'folder-b',
        name: '世界书收藏',
        color: '#8a6a47',
        sortOrder: 1,
        createdAt: 2,
        updatedAt: 2,
      },
    ]
    const wrapper = render(twoCategories, [])
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem')
    storageWrite.mockClear()
    const source = wrapper.get('[data-folder-order-id="folder-a"]').element
    const target = wrapper.get('[data-folder-order-id="folder-b"]').element
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => target),
    })

    await dispatchPointer(source, 'pointerdown', {
      pointerType: 'touch',
      pointerId: 41,
      clientX: 70,
      clientY: 240,
    })
    await vi.advanceTimersByTimeAsync(421)
    await dispatchPointer(window, 'pointermove', {
      pointerType: 'touch',
      pointerId: 41,
      clientX: 220,
      clientY: 240,
    })
    await vi.advanceTimersByTimeAsync(17)

    expect(storageWrite).not.toHaveBeenCalled()

    await dispatchPointer(window, 'pointerup', {
      pointerType: 'touch',
      pointerId: 41,
      clientX: 220,
      clientY: 240,
    })
    expect(storageWrite).toHaveBeenCalledTimes(1)
    expect(storageWrite).toHaveBeenCalledWith('srl.cabinet.layout', expect.any(String))
  })

  it('cancels folder long press when the finger moves beyond the mistake tolerance', async () => {
    vi.useFakeTimers()
    const wrapper = render()
    const source = wrapper.get('[data-folder-order-id="folder-a"]').element
    await dispatchPointer(source, 'pointerdown', {
      pointerType: 'touch',
      pointerId: 23,
      clientX: 80,
      clientY: 240,
    })
    await dispatchPointer(window, 'pointermove', {
      pointerType: 'touch',
      pointerId: 23,
      clientX: 92,
      clientY: 240,
    })
    vi.advanceTimersByTime(500)
    await nextTick()

    expect(wrapper.find('.folder-order-drag').exists()).toBe(false)
    expect(wrapper.find('.folder-library__edit').exists()).toBe(false)
  })

  it('keeps dragging alive while an edge dwell turns to the next page', async () => {
    vi.useFakeTimers()
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    const manyCategories = Array.from({ length: 13 }, (_, index): Category => ({
      id: `folder-${index + 1}`,
      name: `文件夹${index + 1}`,
      color: '#486b5d',
      sortOrder: index,
      createdAt: index,
      updatedAt: index,
    }))
    const wrapper = render(manyCategories, [])
    const source = wrapper.get('[data-folder-order-id="folder-1"]').element
    await dispatchPointer(source, 'pointerdown', {
      pointerType: 'touch',
      pointerId: 29,
      clientX: 70,
      clientY: 240,
    })
    vi.advanceTimersByTime(421)
    await nextTick()
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => undefined),
    })
    await dispatchPointer(window, 'pointermove', {
      pointerType: 'touch',
      pointerId: 29,
      clientX: 385,
      clientY: 240,
    })
    vi.advanceTimersByTime(521)
    await nextTick()
    expect(wrapper.text()).toContain('2 / 2')

    const target = wrapper.get('[data-folder-order-id="folder-13"]').element
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => target),
    })
    await dispatchPointer(window, 'pointermove', {
      pointerType: 'touch',
      pointerId: 29,
      clientX: 210,
      clientY: 240,
    })
    await dispatchPointer(window, 'pointerup', {
      pointerType: 'touch',
      pointerId: 29,
      clientX: 210,
      clientY: 240,
    })

    expect(wrapper.emitted('reorder')).toEqual([
      [
        [
          'folder-2',
          'folder-3',
          'folder-4',
          'folder-5',
          'folder-6',
          'folder-7',
          'folder-8',
          'folder-9',
          'folder-10',
          'folder-11',
          'folder-12',
          'folder-13',
          'folder-1',
        ],
      ],
    ])
  })
})

it('retains unchanged image URLs and releases only replaced or removed thumbnails', async () => {
  const create = vi
    .fn()
    .mockReturnValueOnce('blob:a')
    .mockReturnValueOnce('blob:b')
    .mockReturnValueOnce('blob:c')
  const revoke = vi.fn()
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }))
  const a = { ...resource('a', 'A', ['folder-a']), thumbnailBlob: new Blob(['A']) }
  const b = { ...resource('b', 'B', ['folder-a']), thumbnailBlob: new Blob(['B']) }
  const wrapper = render(categories, [a, b])
  await nextTick()
  expect(create).toHaveBeenCalledTimes(2)
  await wrapper.setProps({ resources: [b, a] })
  expect(create).toHaveBeenCalledTimes(2)
  expect(revoke).not.toHaveBeenCalled()
  await wrapper.setProps({
    resources: [{ ...a, thumbnailBlob: new Blob(['C']), contentHash: 'changed' }],
  })
  expect(create).toHaveBeenCalledTimes(3)
  expect(revoke.mock.calls.flat()).toEqual(expect.arrayContaining(['blob:a', 'blob:b']))
  wrapper.unmount()
  expect(revoke).toHaveBeenCalledWith('blob:c')
  vi.unstubAllGlobals()
})

it('shows completed covers before slow covers and ignores results after leaving', async () => {
  const resolvers = new Map<string, (blob: Blob) => void>()
  const getBlob = vi
    .spyOn(assetStore, 'getBlob')
    .mockImplementation((id) => new Promise((resolve) => resolvers.set(id, resolve)))
  const create = vi.fn().mockReturnValue('blob:ready-cover')
  const revoke = vi.fn()
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }))
  const cards = ['a', 'b', 'c', 'd'].map((id) => ({
    ...resource(id, id, ['folder-a']),
    thumbnailAssetId: id,
  }))
  const wrapper = render(categories, cards)
  try {
    await flushPromises()
    expect(getBlob).toHaveBeenCalledTimes(4)
    resolvers.get('b')!(new Blob(['ready']))
    await flushPromises()
    expect(wrapper.find('img[src="blob:ready-cover"]').exists()).toBe(true)
    expect(create).toHaveBeenCalledTimes(1)
    wrapper.unmount()
    expect(revoke).toHaveBeenCalledWith('blob:ready-cover')
    for (const id of ['a', 'c', 'd']) resolvers.get(id)!(new Blob(['late']))
    await flushPromises()
    expect(create).toHaveBeenCalledTimes(1)
  } finally {
    wrapper.unmount()
    getBlob.mockRestore()
    vi.unstubAllGlobals()
  }
})

it('limits cover reads to four even with a 10,000-resource library', async () => {
  const resolvers = new Map<string, (blob: Blob) => void>()
  let active = 0
  let peak = 0
  const getBlob = vi.spyOn(assetStore, 'getBlob').mockImplementation((id) => {
    active++
    peak = Math.max(peak, active)
    return new Promise((resolve) =>
      resolvers.set(id, (blob) => {
        active--
        resolve(blob)
      }),
    )
  })
  const cards = Array.from({ length: 10000 }, (_, index) => ({
    ...resource(`r${index}`, `R${index}`),
    thumbnailAssetId: `asset${index}`,
  }))
  const wrapper = render(
    [],
    cards,
    cards.slice(0, 6).map((card) => card.id),
  )
  try {
    await flushPromises()
    expect(getBlob).toHaveBeenCalledTimes(4)
    expect(peak).toBe(4)
    wrapper.unmount()
    for (const resolve of resolvers.values()) resolve(new Blob(['late']))
    await flushPromises()
    expect(getBlob).toHaveBeenCalledTimes(4)
  } finally {
    wrapper.unmount()
    getBlob.mockRestore()
  }
})
