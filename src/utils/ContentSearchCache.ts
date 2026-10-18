import type { ResourceSummary } from '../types/Resource'

/** A real task boundary without nested setTimeout's browser minimum delay. */
export function yieldContentSearch(): Promise<void> {
  if (typeof MessageChannel !== 'function') return new Promise((resolve) => setTimeout(resolve, 0))
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel()
    const close = () => {
      channel.port1.close()
      channel.port2.close()
    }
    channel.port1.onmessage = () => {
      close()
      resolve()
    }
    try {
      channel.port2.postMessage(0)
    } catch (error) {
      close()
      reject(error)
    }
  })
}

const MAX_QUERIES = 4
const MAX_ITEMS = 32_768
const MAX_BYTES = 4 * 1024 * 1024

export function hasSearchableOriginal(resource: ResourceSummary): boolean {
  return (
    resource.mimeType === 'application/json' ||
    resource.fileName.toLocaleLowerCase().endsWith('.json')
  )
}

export function searchContentIdentity(resource: ResourceSummary): string {
  // JSON framing avoids collisions involving separators in user-controlled IDs.
  return JSON.stringify([resource.id, resource.contentHash, hasSearchableOriginal(resource)])
}

/** Bounded session-only booleans, never original text, Blobs or whole manifests. */
export class ContentSearchCache {
  private readonly queries = new Map<string, Map<string, boolean>>()
  private bytes = 0
  private items = 0

  clear(): void {
    this.queries.clear()
    this.bytes = 0
    this.items = 0
  }

  private remove(query: string): void {
    const values = this.queries.get(query)!
    this.bytes -= query.length * 2 + 128
    for (const key of values.keys()) this.bytes -= key.length * 2 + 128
    this.items -= values.size
    this.queries.delete(query)
  }

  begin(query: string): void {
    const existing = this.queries.get(query)
    if (existing) {
      this.queries.delete(query)
      this.queries.set(query, existing)
      return
    }
    if (query.length * 2 + 128 > MAX_BYTES) return
    while (
      this.queries.size &&
      (this.queries.size >= MAX_QUERIES || this.bytes + query.length * 2 + 128 > MAX_BYTES)
    )
      this.remove(this.queries.keys().next().value!)
    this.queries.set(query, new Map())
    this.bytes += query.length * 2 + 128
  }

  get(query: string, identity: string): boolean | undefined {
    const exact = this.queries.get(query)?.get(identity)
    if (exact !== undefined) return exact
    for (const [previous, values] of this.queries) {
      const result = values.get(identity)
      // Safe substring implications help typing/backspacing without claiming
      // anything about unscanned resources or locale-insensitive case folding.
      if (result === false && query.includes(previous)) return false
      if (result === true && previous.includes(query)) return true
    }
    return undefined
  }

  put(query: string, identity: string, matched: boolean): void {
    const values = this.queries.get(query)
    if (!values || values.has(identity)) return
    const cost = identity.length * 2 + 128
    while ((this.bytes + cost > MAX_BYTES || this.items >= MAX_ITEMS) && this.queries.size > 1) {
      const oldest = this.queries.keys().next().value!
      if (oldest === query) break
      this.remove(oldest)
    }
    // A scan larger than the budget keeps its admitted subset. Cycling through
    // misses must not evict all resident answers before the next scan reaches them.
    if (this.bytes + cost > MAX_BYTES || this.items >= MAX_ITEMS) return
    values.set(identity, matched)
    this.bytes += cost
    this.items++
  }

  retain(identities: ReadonlySet<string>): void {
    for (const values of this.queries.values()) {
      for (const key of values.keys()) {
        if (identities.has(key)) continue
        values.delete(key)
        this.bytes -= key.length * 2 + 128
        this.items--
      }
    }
  }

  /** Measurable admission limits; not a JS-heap or native allocation estimate. */
  get usage() {
    return { queries: this.queries.size, items: this.items, accountedBytes: this.bytes }
  }
}
