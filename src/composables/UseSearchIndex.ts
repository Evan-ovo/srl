import { computed, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue'

import { browserStorageService, resourceService } from '../core/AppContainer'
import type { ResourceSummary } from '../types/Resource'
import { resourceAuthorSearchText } from '../utils/ResourceAuthors'

const SEARCH_HISTORY_LIMIT = 10
export type SearchScope = 'name' | 'content' | 'author'

interface ContentSearchResult {
  matchedIds: string[]
  indexedHashes: string[]
  evictedHashes?: string[]
}

/**
 * 搜索状态与正文索引。
 *
 * 正文索引按内容哈希缓存，逐批让出主线程，避免大资源库在移动端阻塞渲染；
 * 开启保险库后搜索历史只留在当前会话，不写入浏览器本地存储。
 */
export function useSearchIndex(resources: Ref<ResourceSummary[]>, isVaultEnabled: () => boolean) {
  const searchQuery = ref('')
  const searchScope = ref<SearchScope>('name')
  const searchHistory = ref(browserStorageService.getSearchHistory())
  const isSearchHistoryOpen = ref(false)
  const isSearchFocused = ref(false)
  const contentSearchMatchIds = shallowRef(new Set<string>())
  const contentSearchQuery = ref('')
  const isSearchIndexing = ref(false)
  let searchIndexGeneration = 0
  let requestId = 0
  const indexedHashes = new Set<string>()
  let worker: Worker | undefined
  let cancelWorkerRequest: (() => void) | undefined
  const readCache = new Map<string, Blob>()
  const pendingReads = new Map<string, Promise<Blob | undefined>>()
  let readCacheBytes = 0
  let readCacheGeneration = 0
  function dropRead(hash: string): void {
    const blob = readCache.get(hash)
    if (blob) readCacheBytes -= blob.size ?? 0
    readCache.delete(hash)
  }
  function clearReads(): void {
    readCacheGeneration++
    readCache.clear()
    pendingReads.clear()
    readCacheBytes = 0
  }
  function readOriginal(resource: ResourceSummary): Promise<Blob | undefined> {
    const hash = resource.contentHash
    const cached = readCache.get(hash)
    if (cached) return Promise.resolve(cached)
    const existing = pendingReads.get(hash)
    if (existing) return existing
    const epoch = readCacheGeneration
    const pending = resourceService
      .get(resource.id)
      .then((stored) => {
        if (epoch !== readCacheGeneration || (stored?.contentHash && stored.contentHash !== hash))
          return undefined
        const blob = stored?.originalBlob
        if (blob && (blob.size ?? 0) <= 8 * 1024 * 1024) {
          readCache.set(hash, blob)
          readCacheBytes += blob.size ?? 0
          while (readCache.size > 64 || readCacheBytes > 8 * 1024 * 1024)
            dropRead(readCache.keys().next().value!)
        }
        return blob
      })
      .catch(() => undefined)
      .finally(() => {
        if (pendingReads.get(hash) === pending) pendingReads.delete(hash)
      })
    pendingReads.set(hash, pending)
    return pending
  }
  function cancelSearch(): void {
    searchIndexGeneration += 1
    cancelWorkerRequest?.()
    worker?.postMessage({ type: 'cancel' })
    isSearchIndexing.value = false
  }
  watch(
    [searchQuery, searchScope],
    () => {
      cancelSearch()
      contentSearchMatchIds.value = new Set()
      contentSearchQuery.value = ''
    },
    { flush: 'sync' },
  )
  onScopeDispose(() => {
    cancelSearch()
    clearReads()
    worker?.terminate()
  })

  const nameSearchIndexById = computed(() => {
    const index = new Map<string, string>()
    for (const resource of resources.value) {
      index.set(resource.id, `${resource.name}\n${resource.fileName}`.toLocaleLowerCase())
    }
    return index
  })

  const searchIndexById = computed(() => {
    const index = new Map<string, { name: string; content: string }>()
    for (const resource of resources.value) {
      const name = `${resource.name}\n${resource.fileName}`.toLocaleLowerCase()
      const creator = resourceAuthorSearchText(resource)
      const version =
        typeof resource.metadata.characterVersion === 'string'
          ? resource.metadata.characterVersion
          : ''
      index.set(resource.id, {
        name,
        content:
          `${name}\n${resource.description}\n${resource.tags.join('\n')}\n${creator}\n${version}`.toLocaleLowerCase(),
      })
    }
    return index
  })

  async function refreshSearchContentIndex(items: ResourceSummary[]): Promise<void> {
    cancelSearch()
    const generation = ++searchIndexGeneration
    const query = searchQuery.value.trim().toLocaleLowerCase()
    if (!query) {
      contentSearchMatchIds.value = new Set()
      contentSearchQuery.value = ''
      isSearchIndexing.value = false
      return
    }
    if (!worker && typeof Worker === 'function') {
      worker = new Worker(new URL('../workers/ContentSearchWorker.ts', import.meta.url), {
        type: 'module',
      })
    }
    isSearchIndexing.value = true
    try {
      const matchedIds: string[] = []
      for (let start = 0; start < items.length; start += 32) {
        const candidates: Array<{ id: string; contentHash: string; blob?: Blob }> = []
        for (const resource of items.slice(start, start + 32)) {
          if (generation !== searchIndexGeneration) return
          const blob =
            !indexedHashes.has(resource.contentHash) &&
            (resource.mimeType === 'application/json' ||
              resource.fileName.toLocaleLowerCase().endsWith('.json'))
              ? await readOriginal(resource)
              : undefined
          if (generation !== searchIndexGeneration) return
          candidates.push({ id: resource.id, contentHash: resource.contentHash, blob })
        }
        if (worker) {
          const searchWorker = worker
          const currentRequestId = ++requestId
          const result = await new Promise<ContentSearchResult>((resolve, reject) => {
            const handleMessage = (
              event: MessageEvent<{
                type: string
                requestId: number
                matchedIds: string[]
                indexedHashes: string[]
                evictedHashes?: string[]
              }>,
            ) => {
              if (event.data.type !== 'result' || event.data.requestId !== currentRequestId) return
              cleanup()
              resolve(event.data)
            }
            const handleError = (event: ErrorEvent) => {
              cleanup()
              reject(event.error ?? new Error(event.message))
            }
            const cleanup = () => {
              searchWorker.removeEventListener('message', handleMessage)
              searchWorker.removeEventListener('error', handleError)
              cancelWorkerRequest = undefined
            }
            cancelWorkerRequest = () => {
              cleanup()
              resolve({ matchedIds: [], indexedHashes: [] })
            }
            searchWorker.addEventListener('message', handleMessage)
            searchWorker.addEventListener('error', handleError)
            searchWorker.postMessage({
              type: 'search',
              requestId: currentRequestId,
              query,
              items: candidates,
            })
          })
          if (generation !== searchIndexGeneration) return
          for (const hash of result.indexedHashes) {
            indexedHashes.add(hash)
            dropRead(hash)
          }
          for (const hash of result.evictedHashes ?? []) indexedHashes.delete(hash)
          matchedIds.push(...result.matchedIds)
        } else {
          for (const candidate of candidates) {
            if (generation !== searchIndexGeneration) return
            if (
              candidate.blob &&
              (await candidate.blob.text()).toLocaleLowerCase().includes(query)
            ) {
              matchedIds.push(candidate.id)
            }
          }
        }
      }

      if (generation === searchIndexGeneration) {
        contentSearchMatchIds.value = new Set(matchedIds)
        contentSearchQuery.value = query
      }
    } finally {
      if (generation === searchIndexGeneration) isSearchIndexing.value = false
    }
  }

  function commitSearch(): void {
    if (isVaultEnabled()) {
      const normalized = searchQuery.value.trim()
      if (normalized) {
        searchHistory.value = [
          normalized,
          ...searchHistory.value.filter(
            (item) => item.toLocaleLowerCase() !== normalized.toLocaleLowerCase(),
          ),
        ].slice(0, SEARCH_HISTORY_LIMIT)
      }
    } else {
      searchHistory.value = browserStorageService.saveSearch(searchQuery.value)
    }
    isSearchHistoryOpen.value = false
  }

  function useSearchHistory(query: string): void {
    searchQuery.value = query
    commitSearch()
  }

  function clearSearchHistory(): void {
    browserStorageService.clearSearchHistory()
    searchHistory.value = []
  }

  function closeSearchHistorySoon(): void {
    window.setTimeout(() => {
      isSearchHistoryOpen.value = false
    }, 120)
  }

  function handleSearchFocus(): void {
    isSearchFocused.value = true
    isSearchHistoryOpen.value = true
  }

  function handleSearchBlur(): void {
    isSearchFocused.value = false
    closeSearchHistorySoon()
  }

  function cancelSearchInput(event?: Event): void {
    searchQuery.value = ''
    isSearchHistoryOpen.value = false
    isSearchFocused.value = false
    const target = event?.currentTarget
    if (target instanceof HTMLElement) target.blur()
    const active = document.activeElement
    if (active instanceof HTMLInputElement) active.blur()
  }

  /** 保险库上锁时清空全部搜索痕迹与正文索引。 */
  function resetSearchState(): void {
    cancelSearch()
    browserStorageService.clearSearchHistory()
    searchQuery.value = ''
    searchHistory.value = []
    contentSearchMatchIds.value = new Set()
    contentSearchQuery.value = ''
    indexedHashes.clear()
    clearReads()
    worker?.postMessage({ type: 'reset' })
    searchIndexGeneration += 1
  }

  return {
    searchQuery,
    searchScope,
    searchHistory,
    isSearchHistoryOpen,
    isSearchFocused,
    contentSearchMatchIds,
    contentSearchQuery,
    isSearchIndexing,
    nameSearchIndexById,
    searchIndexById,
    refreshSearchContentIndex,
    commitSearch,
    useSearchHistory,
    clearSearchHistory,
    closeSearchHistorySoon,
    handleSearchFocus,
    handleSearchBlur,
    cancelSearchInput,
    resetSearchState,
  }
}
