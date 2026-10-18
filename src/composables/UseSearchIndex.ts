import { computed, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue'

import { browserStorageService, resourceService } from '../core/AppContainer'
import {
  isErrorCancellation,
  reportHandledError,
  type HandledErrorCode,
} from '../core/FatalErrorNotice'
import { noticeCenter } from '../core/NoticeCenter'
import {
  ContentSearchCache,
  hasSearchableOriginal,
  searchContentIdentity,
  yieldContentSearch,
} from '../utils/ContentSearchCache'
import type { ResourceSummary } from '../types/Resource'
import { resourceAuthorSearchText } from '../utils/ResourceAuthors'

function contentSearchCancelled(): never {
  throw new DOMException('Content search cancelled', 'AbortError')
}

const SEARCH_HISTORY_LIMIT = 10
export type SearchScope = 'name' | 'content' | 'author'

interface ContentSearchResult {
  matchedIds: string[]
  indexedHashes: string[]
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
  const contentSearchError = ref('')
  const answers = new ContentSearchCache()
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
    const hash = resource.contentHash || searchContentIdentity(resource)
    const cached = readCache.get(hash)
    if (cached) return Promise.resolve(cached)
    const existing = pendingReads.get(hash)
    if (existing) return existing
    const epoch = readCacheGeneration
    const pending = resourceService
      .get(resource.id)
      .then((stored) => {
        if (epoch !== readCacheGeneration) contentSearchCancelled()
        if (stored?.contentHash !== resource.contentHash)
          throw new Error('Search original identity changed')
        const blob = stored?.originalBlob
        if (!blob) throw new Error('Search original is missing')
        if (blob && (blob.size ?? 0) <= 8 * 1024 * 1024) {
          readCache.set(hash, blob)
          readCacheBytes += blob.size ?? 0
          while (readCache.size > 64 || readCacheBytes > 8 * 1024 * 1024)
            dropRead(readCache.keys().next().value!)
        }
        return blob
      })
      .finally(() => {
        if (pendingReads.get(hash) === pending) pendingReads.delete(hash)
      })
    pendingReads.set(hash, pending)
    return pending
  }
  function cancelSearch(): void {
    searchIndexGeneration += 1
    cancelWorkerRequest?.()
    try {
      worker?.postMessage({ type: 'cancel' })
    } catch {
      worker?.terminate()
      worker = undefined
      indexedHashes.clear()
    }
    isSearchIndexing.value = false
  }
  watch(
    [searchQuery, searchScope],
    () => {
      cancelSearch()
      contentSearchMatchIds.value = new Set()
      contentSearchQuery.value = ''
      contentSearchError.value = ''
    },
    { flush: 'sync' },
  )
  onScopeDispose(() => {
    cancelSearch()
    clearReads()
    answers.clear()
    indexedHashes.clear()
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
    contentSearchError.value = ''
    contentSearchMatchIds.value = new Set()
    contentSearchQuery.value = ''
    if (!query) return
    isSearchIndexing.value = true
    let failureCode: HandledErrorCode = 'SRL-SEARCH-WORKER'
    try {
      if (!worker && typeof Worker === 'function') {
        worker = new Worker(new URL('../workers/ContentSearchWorker.ts', import.meta.url), {
          type: 'module',
        })
      }
      const identities = new Set(items.map(searchContentIdentity))
      answers.retain(identities)
      answers.begin(query)
      const activeHashes = new Set(
        items.filter(hasSearchableOriginal).map((item) => item.contentHash),
      )
      const removedHashes = [...indexedHashes].filter((hash) => !activeHashes.has(hash))
      for (const hash of removedHashes) indexedHashes.delete(hash)
      if (removedHashes.length) worker?.postMessage({ type: 'prune', hashes: removedHashes })
      const matchedIds: string[] = []
      for (let start = 0; start < items.length; start += 32) {
        if (start && start % 256 === 0) await yieldContentSearch()
        if (generation !== searchIndexGeneration) return
        const candidates: Array<{
          id: string
          contentHash: string
          blob?: Blob
          identity: string
        }> = []
        for (const resource of items.slice(start, start + 32)) {
          if (generation !== searchIndexGeneration) return
          const identity = searchContentIdentity(resource)
          const known = answers.get(query, identity)
          if (known !== undefined || !hasSearchableOriginal(resource)) {
            if (known) matchedIds.push(resource.id)
            continue
          }
          failureCode = 'SRL-SEARCH-ORIGINAL-READ'
          if (!resource.contentHash) throw new Error('Search original content identity is missing')
          const blob = !indexedHashes.has(resource.contentHash)
            ? await readOriginal(resource)
            : undefined
          if (generation !== searchIndexGeneration) return
          candidates.push({ id: resource.id, contentHash: resource.contentHash, blob, identity })
        }
        if (!candidates.length) continue
        let found: Set<string>
        if (worker) {
          failureCode = 'SRL-SEARCH-WORKER'
          const searchWorker = worker
          const currentRequestId = ++requestId
          const result = await new Promise<ContentSearchResult>((resolve, reject) => {
            const handleMessage = (
              event: MessageEvent<
                ContentSearchResult & {
                  type: string
                  requestId: number
                  errorName?: string
                }
              >,
            ) => {
              if (event.data.requestId !== currentRequestId) return
              if (event.data.type === 'result') {
                for (const hash of event.data.indexedHashes) indexedHashes.add(hash)
                cleanup()
                resolve(event.data)
              } else if (event.data.type === 'error') {
                cleanup()
                failureCode = 'SRL-SEARCH-CONTENT-SCAN'
                const error = new Error('Search content scan failed')
                if (
                  ['NotReadableError', 'AbortError', 'EncodingError'].includes(
                    event.data.errorName ?? '',
                  )
                )
                  error.name = event.data.errorName!
                reject(error)
              }
            }
            const handleError = (event: ErrorEvent) => {
              cleanup()
              reject(event.error ?? new Error('Search worker failed'))
            }
            const handleMessageError = () => {
              cleanup()
              reject(new Error('Search worker response could not be read'))
            }
            const cleanup = () => {
              searchWorker.removeEventListener('message', handleMessage)
              searchWorker.removeEventListener('error', handleError)
              searchWorker.removeEventListener('messageerror', handleMessageError)
              cancelWorkerRequest = undefined
            }
            cancelWorkerRequest = () => {
              cleanup()
              // These at-most-32 supplied hashes may have been admitted before
              // cancellation, including a result still queued for delivery.
              // Previously acknowledged residents were sent without a Blob.
              try {
                searchWorker.postMessage({
                  type: 'prune',
                  hashes: candidates
                    .filter((candidate) => candidate.blob)
                    .map((candidate) => candidate.contentHash),
                })
              } catch {
                searchWorker.terminate()
                if (worker === searchWorker) worker = undefined
                indexedHashes.clear()
              }
              resolve({ matchedIds: [], indexedHashes: [] })
            }
            searchWorker.addEventListener('message', handleMessage)
            searchWorker.addEventListener('error', handleError)
            searchWorker.addEventListener('messageerror', handleMessageError)
            try {
              searchWorker.postMessage({
                type: 'search',
                requestId: currentRequestId,
                query,
                items: candidates,
              })
            } catch (error) {
              cleanup()
              reject(error)
            }
          })
          if (generation !== searchIndexGeneration) return
          found = new Set(result.matchedIds)
        } else {
          failureCode = 'SRL-SEARCH-CONTENT-SCAN'
          found = new Set()
          const batchMatches = new Map<string, boolean>()
          for (const candidate of candidates) {
            if (generation !== searchIndexGeneration) return
            if (!candidate.blob) throw new Error('Search original is unavailable')
            let matched = batchMatches.get(candidate.contentHash)
            if (matched === undefined) {
              const text = await candidate.blob.text()
              if (generation !== searchIndexGeneration) return
              matched = text.toLocaleLowerCase().includes(query)
              batchMatches.set(candidate.contentHash, matched)
            }
            if (matched) found.add(candidate.id)
          }
        }
        if (generation !== searchIndexGeneration) return
        for (const candidate of candidates) {
          const matched = found.has(candidate.id)
          answers.put(query, candidate.identity, matched)
          dropRead(candidate.contentHash || candidate.identity)
          if (matched) matchedIds.push(candidate.id)
        }
      }
      if (generation === searchIndexGeneration) {
        contentSearchMatchIds.value = new Set(matchedIds)
        contentSearchQuery.value = query
      }
    } catch (error) {
      if (generation !== searchIndexGeneration) return
      contentSearchMatchIds.value = new Set()
      contentSearchQuery.value = ''
      // A broken Worker cannot leave hashes advertised as resident. Retry
      // creates a fresh Worker; verified boolean answers remain reusable.
      if (failureCode !== 'SRL-SEARCH-ORIGINAL-READ') {
        worker?.terminate()
        worker = undefined
        indexedHashes.clear()
      }
      clearReads()
      // Only our generation change proves user cancellation. A storage/Blob
      // AbortError in the current generation still means an incomplete search.
      const failure = isErrorCancellation(error)
        ? new Error('Search source aborted before completion', { cause: error })
        : error
      const message = reportHandledError(failureCode, failure, { itemCount: items.length })
      contentSearchError.value = message ?? '正文搜索未完成，请重试。'
      if (message) noticeCenter.push({ type: 'error', message })
    } finally {
      if (generation === searchIndexGeneration) isSearchIndexing.value = false
    }
  }

  // Only content identity/eligibility changes invalidate body answers. Renaming
  // display metadata with unchanged JSON eligibility does not restart a scan.
  watch(
    () => resources.value.map(searchContentIdentity),
    (next, previous) => {
      const previousIdentities = new Set(previous)
      if (next.length === previous.length && next.every((value) => previousIdentities.has(value)))
        return
      cancelSearch()
      contentSearchMatchIds.value = new Set()
      contentSearchQuery.value = ''
      if (searchScope.value === 'content' && searchQuery.value.trim())
        void refreshSearchContentIndex(resources.value)
    },
    { flush: 'sync' },
  )

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
    answers.clear()
    contentSearchError.value = ''
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
    contentSearchError,
    retryContentSearch: () => refreshSearchContentIndex(resources.value),
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
