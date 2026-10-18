import { yieldContentSearch } from '../utils/ContentSearchCache'

interface SearchItem {
  id: string
  contentHash: string
  blob?: Blob
}

interface SearchRequest {
  type: 'search'
  requestId: number
  query: string
  items: SearchItem[]
}

interface ResetRequest {
  type: 'reset' | 'cancel' | 'prune'
  hashes?: string[]
}

const MAX_BYTES = 8 * 1024 * 1024
const MAX_ITEMS = 2048
const contentByHash = new Map<string, string>()
let cachedBytes = 0
let generation = 0

self.onmessage = async (event: MessageEvent<SearchRequest | ResetRequest>) => {
  const request = event.data
  const current = ++generation
  if (request.type !== 'search') {
    if (request.type === 'reset') {
      contentByHash.clear()
      cachedBytes = 0
    } else if (request.type === 'prune') {
      for (const hash of request.hashes ?? []) {
        cachedBytes -= (contentByHash.get(hash)?.length ?? 0) * 2
        contentByHash.delete(hash)
      }
    }
    return
  }

  const matchedIds: string[] = []
  const indexedHashes: string[] = []
  const batchMatches = new Map<string, boolean>()
  try {
    let batchSize = 0
    for (const item of request.items) {
      if (++batchSize % 256 === 0) await yieldContentSearch()
      if (current !== generation) return
      if (!item.contentHash) throw new Error('Search content identity is missing')
      let matched = batchMatches.get(item.contentHash)
      if (matched === undefined) {
        const content = contentByHash.get(item.contentHash)
        if (content !== undefined) matched = content.includes(request.query)
        else {
          if (!item.blob) throw new Error('Search original is unavailable')
          const budget = contentByHash.size < MAX_ITEMS ? MAX_BYTES - cachedBytes : 0
          const text = await item.blob.text()
          if (current !== generation) return
          const lowered = text.toLocaleLowerCase()
          matched = lowered.includes(request.query)
          // Scan-resistant admission: a miss never evicts a resident entry.
          // Sequential libraries larger than the cache therefore reuse the same
          // subset on the next query instead of cyclically missing every item.
          if (budget && lowered.length * 2 <= budget) {
            contentByHash.set(item.contentHash, lowered)
            cachedBytes += lowered.length * 2
          }
        }
        batchMatches.set(item.contentHash, matched)
      }
      if (contentByHash.has(item.contentHash)) indexedHashes.push(item.contentHash)
      if (matched) matchedIds.push(item.id)
    }
    if (current !== generation) return
    self.postMessage({ type: 'result', requestId: request.requestId, matchedIds, indexedHashes })
  } catch (error) {
    if (current !== generation) return
    // Do not send arbitrary thrown strings/objects or log resource contents.
    // The parent records the stable code through the existing diagnostic Owner.
    self.postMessage({
      type: 'error',
      requestId: request.requestId,
      code: 'SRL-SEARCH-CONTENT-SCAN',
      errorName: error instanceof Error ? error.name : 'Error',
    })
  }
}
