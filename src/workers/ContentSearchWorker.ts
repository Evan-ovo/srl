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
  type: 'reset' | 'cancel'
}

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
    }
    return
  }

  const matchedIds: string[] = []
  const indexedHashes: string[] = []
  const evictedHashes: string[] = []
  let batchSize = 0
  for (const item of request.items) {
    // Cached matches also need to yield, otherwise a new query cannot cancel a large scan.
    if (++batchSize % 32 === 0) await new Promise((resolve) => setTimeout(resolve, 0))
    if (current !== generation) return
    let content = contentByHash.get(item.contentHash)
    if (content === undefined && item.blob) {
      content = (await item.blob.text()).toLocaleLowerCase()
      if (current !== generation) return
      const bytes = content.length * 2
      if (bytes <= 8 * 1024 * 1024) {
        contentByHash.set(item.contentHash, content)
        cachedBytes += bytes
        while (contentByHash.size > 2048 || cachedBytes > 8 * 1024 * 1024) {
          const hash = contentByHash.keys().next().value!
          cachedBytes -= contentByHash.get(hash)!.length * 2
          contentByHash.delete(hash)
          evictedHashes.push(hash)
        }
      }
    }
    if (contentByHash.has(item.contentHash)) indexedHashes.push(item.contentHash)
    if (content?.includes(request.query)) matchedIds.push(item.id)
  }

  self.postMessage({
    type: 'result',
    requestId: request.requestId,
    matchedIds,
    indexedHashes,
    ...(evictedHashes.length ? { evictedHashes } : {}),
  })
}

export {}
