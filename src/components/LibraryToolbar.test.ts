/** @vitest-environment jsdom */
import { mount } from '@vue/test-utils'
import { h, nextTick, reactive } from 'vue'
import { expect, it, vi } from 'vitest'
import type { SortValue } from '../types/AppView'
import LibraryToolbar from './LibraryToolbar.vue'

it('renders the live result count and sort control without requesting the complete sorted catalogue', async () => {
  const model = reactive({
    commitSearch: vi.fn(),
    searchScope: 'name' as const,
    isSearchIndexing: false,
    contentSearchError: '',
    retryContentSearch: vi.fn(),
    searchQuery: '',
    handleSearchFocus: vi.fn(),
    handleSearchBlur: vi.fn(),
    cancelSearchInput: vi.fn(),
    isSearchFocused: false,
    isSearchHistoryOpen: false,
    searchHistory: [],
    clearSearchHistory: vi.fn(),
    useSearchHistory: vi.fn(),
    sortValue: 'newest' as SortValue,
    filteredResourceCount: 10000,
    isBatchMode: false,
    toggleBatchMode: vi.fn(),
    openSimilarNameGroups: vi.fn(),
    get filteredResources() {
      throw new Error('complete sort must remain lazy')
    },
  })
  const wrapper = mount({ render: () => h(LibraryToolbar, { model }) })
  try {
    expect(wrapper.find('.toolbar__result').text()).toBe('10000 项')
    model.filteredResourceCount = 25
    await nextTick()
    expect(wrapper.find('.toolbar__result').text()).toBe('25 项')
    await wrapper.find('select[aria-label="资源排序"]').setValue('name')
    expect(model.sortValue).toBe('name')
  } finally {
    wrapper.unmount()
  }
})
