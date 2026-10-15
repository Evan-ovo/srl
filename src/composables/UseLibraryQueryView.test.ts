import { computed, ref, shallowRef } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { FilterValue, SortValue } from '../types/AppView'
import {
  RESOURCE_TYPE,
  USER_PERSONA_AVATAR_ASSET_KIND,
  type Category,
  type ResourceSummary,
} from '../types/Resource'
import { RESOURCE_GALLERY_ASSET_KIND } from '../types/ResourceGallery'
import { useLibraryQueryView } from './UseLibraryQueryView'
import type { SearchScope } from './UseSearchIndex'

function resource(id: string, values: Partial<ResourceSummary> = {}): ResourceSummary {
  return {
    id,
    type: RESOURCE_TYPE.CHARACTER_CARD,
    name: id,
    fileName: `${id}.json`,
    mimeType: 'application/json',
    fileSize: 1,
    contentHash: id,
    description: '',
    tags: [],
    categoryId: null,
    categoryIds: [],
    relatedResourceIds: [],
    sourceLinks: [],
    favorite: false,
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
    ...values,
  }
}

function category(id: string, hidden = false): Category {
  return { id, name: id, hidden, color: '#000000', createdAt: 1, updatedAt: 1 }
}

function setup(resources: ResourceSummary[], categories: Category[] = []) {
  const context = {
    resources: ref(resources),
    categories: ref(categories),
    hideCharacterAssets: ref(false),
    hideChatDisplayRegex: ref(false),
    showManuallyBoundResources: ref(true),
    activeCategoryId: ref<string | null | undefined>(undefined),
    activeFilter: ref<FilterValue>('all'),
    activeResourceIds: ref<Set<string> | undefined>(undefined),
    searchQuery: ref(''),
    activeTag: ref(''),
    sortValue: ref<SortValue>('newest'),
    resourceNameCollator: new Intl.Collator('zh-CN'),
    searchScope: ref<SearchScope>('name'),
    nameSearchIndexById: computed(() => new Map(resources.map((item) => [item.id, item.name]))),
    searchIndexById: computed(() => new Map<string, { name: string; content: string }>()),
    contentSearchQuery: ref(''),
    contentSearchMatchIds: shallowRef(new Set<string>()),
    currentPage: ref(1),
    pageSize: ref(20),
    selectedSplitResourceId: ref<string | undefined>(undefined),
  }
  return { context, view: useLibraryQueryView(context) }
}

describe('UseLibraryQueryView folder counts', () => {
  it('keeps a chat-bound character visible even when legacy imports marked the link as manual', () => {
    const { context, view } = setup([
      resource('card'),
      resource('chat', {
        type: RESOURCE_TYPE.CHAT,
        relatedResourceIds: ['card', 'regex'],
        metadata: { manuallyBoundResourceIds: ['card', 'regex'] },
      }),
      resource('regex', { type: RESOURCE_TYPE.REGEX }),
    ])
    context.showManuallyBoundResources.value = false
    expect(view.filteredResources.value.map((resource) => resource.id)).toContain('card')
    expect(view.filteredResources.value.map((resource) => resource.id)).not.toContain('regex')
    expect(view.resourceFilterCounts.value.get(RESOURCE_TYPE.CHARACTER_CARD)).toBe(1)
  })
  it('counts and renders a Chinese sorted page without eagerly sorting the complete bulk-selection list', () => {
    const resources = Array.from({ length: 10000 }, (_, index) =>
      resource(`r-${index}`, {
        name: `角色${(index * 157) % 997}`,
        favorite: index % 3 === 0,
        categoryIds: index % 2 ? ['folder'] : [],
      }),
    )
    const { context, view } = setup(resources)
    const originalCompare = context.resourceNameCollator.compare
    const compare = vi.fn(originalCompare)
    Object.defineProperty(context.resourceNameCollator, 'compare', { value: compare })
    context.sortValue.value = 'name'
    context.currentPage.value = 2
    expect(view.filteredResourceCount.value).toBe(10000)
    expect(view.totalPages.value).toBe(500)
    expect(compare).not.toHaveBeenCalled()
    const expected = resources.slice().sort((a, b) => originalCompare(a.name, b.name))
    expect(view.paginatedResources.value.map((item) => item.id)).toEqual(
      expected.slice(20, 40).map((item) => item.id),
    )
    expect(compare.mock.calls.length).toBeLessThan(30000)
    compare.mockClear()
    expect(view.filteredResources.value.map((item) => item.id)).toEqual(
      expected.map((item) => item.id),
    )
    expect(compare.mock.calls.length).toBeGreaterThan(30000)
    context.activeFilter.value = 'favorites'
    context.activeCategoryId.value = 'folder'
    expect(view.filteredResourceCount.value).toBe(
      resources.filter((item) => item.favorite && item.categoryIds?.includes('folder')).length,
    )
    expect(view.resourceFilterCounts.value.get('all')).toBe(5000)
  })

  it.each([10000, 30000, 50000])(
    'reuses deep ordering at %i rows and invalidates changed sort keys',
    (size) => {
      const rows = Array.from({ length: size }, (_, i) =>
        resource(`r-${i}`, { name: `角色${(i * 48271) % size}` }),
      )
      const { context, view } = setup(rows)
      let comparisons = 0
      const nativeCompare = context.resourceNameCollator.compare
      const compare = (a: string, b: string) => {
        comparisons++
        return nativeCompare(a, b)
      }
      Object.defineProperty(context.resourceNameCollator, 'compare', { value: compare })
      context.sortValue.value = 'name'
      context.currentPage.value = Math.floor(size / 20)
      const expected = rows.slice().sort((a, b) => compare(a.name, b.name))
      expect(view.paginatedResources.value.map((r) => r.id)).toEqual(
        expected.slice(-20).map((r) => r.id),
      )
      comparisons = 0
      context.currentPage.value--
      expect(view.paginatedResources.value.map((r) => r.id)).toEqual(
        expected.slice(-40, -20).map((r) => r.id),
      )
      expect(comparisons).toBe(0)
      expect(view.filteredResources.value.map((r) => r.id)).toEqual(expected.map((r) => r.id))
      expect(comparisons).toBe(0)
      // Deep refs used by callers/tests must retain Vue's sort-key invalidation semantics.
      context.resources.value[0]!.name = 'ZZZ changed'
      expect(view.filteredResources.value.map((r) => r.id)).toEqual(
        rows
          .slice()
          .sort((a, b) => nativeCompare(a.name, b.name))
          .map((r) => r.id),
      )
      expect(comparisons).toBeGreaterThan(0)
      context.activeFilter.value = 'favorites'
      expect(view.paginatedResources.value).toEqual([])
    },
  )

  it('counts each resource once per folder and preserves all, favorites and type filters', () => {
    const { context, view } = setup([
      resource('multi', {
        categoryId: 'first',
        categoryIds: ['first', 'second', 'second'],
        favorite: true,
      }),
      resource('legacy', { categoryId: 'first', categoryIds: undefined }),
      resource('loose', { type: RESOURCE_TYPE.WORLD_BOOK, favorite: true }),
      resource('unknown', { type: RESOURCE_TYPE.WORLD_BOOK, categoryIds: ['removed'] }),
    ])

    expect(view.countCategory(undefined)).toBe(4)
    expect(view.countCategory(null)).toBe(1)
    expect(view.countCategory('first')).toBe(2)
    expect(view.countCategory('second')).toBe(1)
    expect(view.countCategory('removed')).toBe(1)
    expect(view.countCategory('missing')).toBe(0)

    context.activeFilter.value = 'favorites'
    expect(view.countCategory(undefined)).toBe(2)
    expect(view.countCategory(null)).toBe(1)
    expect(view.countCategory('first')).toBe(1)
    expect(view.countCategory('second')).toBe(1)

    context.activeFilter.value = RESOURCE_TYPE.WORLD_BOOK
    expect(view.countCategory(undefined)).toBe(2)
    expect(view.countCategory(null)).toBe(1)
    expect(view.countCategory('first')).toBe(0)
    expect(view.countCategory('removed')).toBe(1)
  })

  it('tracks visibility preferences while keeping persona and gallery attachments excluded', () => {
    const { context, view } = setup(
      [
        resource('visible', { categoryIds: ['visible'] }),
        resource('hidden', { categoryIds: ['visible', 'hidden'] }),
        resource('avatar', { metadata: { assetKind: USER_PERSONA_AVATAR_ASSET_KIND } }),
        resource('gallery', { metadata: { assetKind: RESOURCE_GALLERY_ASSET_KIND } }),
        resource('asset', {
          type: RESOURCE_TYPE.WORLD_BOOK,
          metadata: { extractedFromCharacterId: 'visible', extractedAssetKind: 'worldBook' },
        }),
        resource('owner', {
          relatedResourceIds: ['bound'],
          metadata: { manuallyBoundResourceIds: ['bound', 'unrelated'] },
        }),
        resource('bound'),
        resource('unrelated'),
        resource('chat', { type: RESOURCE_TYPE.CHAT, metadata: { chatDisplayRegexId: 'regex' } }),
        resource('regex', { type: RESOURCE_TYPE.REGEX }),
      ],
      [category('visible'), category('hidden', true)],
    )

    expect(view.countCategory(undefined)).toBe(7)
    expect(view.countCategory('visible')).toBe(1)
    expect(view.countCategory('hidden')).toBe(0)
    context.hideCharacterAssets.value = true
    expect(view.countCategory(undefined)).toBe(6)
    context.showManuallyBoundResources.value = false
    expect(view.countCategory(undefined)).toBe(5)
    context.hideChatDisplayRegex.value = true
    expect(view.countCategory(undefined)).toBe(4)
    expect(view.countCategory(null)).toBe(3)
    context.categories.value[1]!.hidden = false
    expect(view.countCategory(undefined)).toBe(5)
    expect(view.countCategory('visible')).toBe(2)
    expect(view.countCategory('hidden')).toBe(1)
  })

  it('refreshes counts after resources move, favorite changes, removal and replacement', () => {
    const { context, view } = setup([resource('one', { categoryIds: ['first'] })])
    expect(view.countCategory('first')).toBe(1)

    context.resources.value[0]!.categoryIds = ['second', 'third']
    expect(view.countCategory('first')).toBe(0)
    expect(view.countCategory('second')).toBe(1)
    expect(view.countCategory('third')).toBe(1)
    context.activeFilter.value = 'favorites'
    expect(view.countCategory(undefined)).toBe(0)
    context.resources.value[0]!.favorite = true
    expect(view.countCategory('second')).toBe(1)

    context.activeFilter.value = RESOURCE_TYPE.WORLD_BOOK
    expect(view.countCategory('second')).toBe(0)
    context.resources.value[0]!.type = RESOURCE_TYPE.WORLD_BOOK
    expect(view.countCategory('second')).toBe(1)
    context.activeFilter.value = 'favorites'

    context.resources.value.push(resource('two', { favorite: true }))
    expect(view.countCategory(undefined)).toBe(2)
    expect(view.countCategory(null)).toBe(1)
    context.resources.value.splice(0, 1)
    expect(view.countCategory('second')).toBe(0)
    expect(view.countCategory(undefined)).toBe(1)
    context.resources.value = [resource('replacement', { categoryId: 'first', favorite: true })]
    expect(view.countCategory('first')).toBe(1)
    expect(view.countCategory(null)).toBe(0)
  })

  it('keeps folder counts independent of the active folder, search, tag and temporary ID scope', () => {
    const { context, view } = setup([
      resource('one', { categoryIds: ['first'] }),
      resource('two', { categoryIds: ['second'] }),
    ])
    expect(view.countCategory(undefined)).toBe(2)

    context.activeResourceIds.value = new Set(['one'])
    context.activeCategoryId.value = 'first'
    context.searchQuery.value = 'absent'
    context.activeTag.value = 'absent'
    expect(view.filteredResources.value).toHaveLength(0)
    expect(view.countCategory(undefined)).toBe(2)
    expect(view.countCategory('second')).toBe(1)
  })

  it('reads resource memberships once when rendering hundreds of folder counts', () => {
    const membershipRead = vi.fn(() => ['first', 'second'])
    const items = Array.from({ length: 1000 }, (_, index) => {
      const item = resource(`item-${index}`)
      Object.defineProperty(item, 'categoryIds', { configurable: true, get: membershipRead })
      return item
    })
    const { context, view } = setup(items)
    expect(view.visibleLibraryResources.value).toHaveLength(1000)
    membershipRead.mockClear()

    expect(view.countCategory(undefined)).toBe(1000)
    expect(view.countCategory(null)).toBe(0)
    expect(view.countCategory('first')).toBe(1000)
    expect(view.countCategory('second')).toBe(1000)
    const firstReads = membershipRead.mock.calls.length
    expect(firstReads).toBeGreaterThan(0)
    expect(firstReads).toBeLessThanOrEqual(2000)
    for (let index = 0; index < 200; index++) expect(view.countCategory(`folder-${index}`)).toBe(0)
    expect(membershipRead).toHaveBeenCalledTimes(firstReads)

    context.searchQuery.value = 'changed'
    context.activeTag.value = 'changed'
    context.activeResourceIds.value = new Set()
    expect(view.countCategory('first')).toBe(1000)
    expect(membershipRead).toHaveBeenCalledTimes(firstReads)
  })
})
