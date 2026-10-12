/** @vitest-environment jsdom */

import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useLibraryNavigation } from './UseLibraryNavigation'
import { readAppResumeState } from '../core/AppResumeState'

describe('UseLibraryNavigation notification routes', () => {
  it('opens the existing assistant for a native browser request', async () => {
    const isFeatureHubOpen = ref(false)
    const navigation = useLibraryNavigation(() => ({ isFeatureHubOpen }) as never)
    const shortcut = vi.fn()
    window.addEventListener('srl:native-shortcut', shortcut)
    try {
      await navigation.handleNativeDeepLink(
        new CustomEvent('srl:native-deep-link', { detail: { kind: 'assistant' } }),
      )
      expect(isFeatureHubOpen.value).toBe(true)
      expect(readAppResumeState()).toMatchObject({ feature: 'featureHub', subpage: 'assistant' })
      expect((shortcut.mock.calls[0]![0] as CustomEvent).detail).toBe('assistant')
    } finally {
      window.removeEventListener('srl:native-shortcut', shortcut)
    }
  })
  it.each(['library', 'favorites', 'import', 'link-import', 'settings'])(
    'opens the assistant destination %s through the existing library owner',
    (id) => {
      const state = {
        isFeatureHubOpen: ref(true),
        isBusy: ref(false),
        searchQuery: ref('旧搜索'),
        activeFilter: ref('all'),
        activeCategoryId: ref('旧分类'),
        activeTag: ref('旧标签'),
        isMobileFiltersOpen: ref(true),
        isSearchHistoryOpen: ref(true),
        isSearchFocused: ref(true),
        isSettingsOpen: ref(false),
        openImportChooser: vi.fn(),
        openLinkImportPanel: vi.fn(),
      }
      const navigation = useLibraryNavigation(() => state as never)
      navigation.openAssistantDestination(id)
      expect(state.isFeatureHubOpen.value).toBe(false)
      expect(state.activeFilter.value).toBe(id === 'favorites' ? 'favorites' : 'all')
      expect(state.searchQuery.value).toBe('')
      expect(state.openImportChooser).toHaveBeenCalledTimes(id === 'import' ? 1 : 0)
      expect(state.openLinkImportPanel).toHaveBeenCalledTimes(id === 'link-import' ? 1 : 0)
      expect(state.isSettingsOpen.value).toBe(id === 'settings')
    },
  )
  it('rejects login, arbitrary routes and busy navigation before changing the current view', () => {
    const state = { isBusy: ref(true), isFeatureHubOpen: ref(true), openImportChooser: vi.fn() }
    const navigation = useLibraryNavigation(() => state as never)
    expect(() => navigation.openAssistantDestination('login')).toThrow('不能')
    expect(() => navigation.openAssistantDestination('https://example.com')).toThrow('不能')
    expect(() => navigation.openAssistantDestination('import')).toThrow('正在进行')
    expect(state.isFeatureHubOpen.value).toBe(true)
    expect(state.openImportChooser).not.toHaveBeenCalled()
  })
  it('opens the cloud feature page for backup notifications without opening restore', async () => {
    const isFeatureHubOpen = ref(false)
    const openRestorePanel = vi.fn()
    const navigation = useLibraryNavigation(() => ({ isFeatureHubOpen, openRestorePanel }) as never)

    await navigation.handleNativeDeepLink(
      new CustomEvent('srl:native-deep-link', { detail: { kind: 'backup' } }),
    )

    expect(isFeatureHubOpen.value).toBe(true)
    expect(sessionStorage.getItem('srl.native.shortcut')).toBe('cloud')
    expect(readAppResumeState()).toMatchObject({ feature: 'featureHub', subpage: 'cloud' })
    expect(openRestorePanel).not.toHaveBeenCalled()
  })

  it('opens the ZIP restore panel only for restore-choice notifications', async () => {
    const isFeatureHubOpen = ref(true)
    const openRestorePanel = vi.fn()
    const navigation = useLibraryNavigation(() => ({ isFeatureHubOpen, openRestorePanel }) as never)

    await navigation.handleNativeDeepLink(
      new CustomEvent('srl:native-deep-link', { detail: { kind: 'restore' } }),
    )

    expect(isFeatureHubOpen.value).toBe(false)
    expect(openRestorePanel).toHaveBeenCalledWith('export', true)
  })
})
