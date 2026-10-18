import { Capacitor } from '@capacitor/core'
import Dexie from 'dexie'
import type {
  DBCore,
  DBCoreCursor,
  DBCoreIndex,
  DBCoreMutateRequest,
  DBCorePutRequest,
  DBCoreTable,
  DBCoreTransaction,
} from 'dexie'

import {
  decodeAppDatabaseKey,
  decodeAppDatabaseValue,
  encodeAppDatabaseIndexes,
  encodeAppDatabaseKey,
  encodeAppDatabaseValue,
  isEncodedBlobValue,
} from './AndroidAppDatabaseMigration'
import {
  APP_DATABASE_STORES,
  nativeAppDatabase,
  type NativeAppDatabaseBatchOperation,
  type NativeAppDatabaseStore,
  type NativeKeyPageQuery,
} from './NativeAppDatabaseBridge'

type StoreChange = {
  key: IDBValidKey
  value?: unknown
  deleted: boolean
  encoded?: boolean
  preservedBinaryFields?: string[]
}

interface NativeTransaction extends DBCoreTransaction {
  readonly mode: 'readonly' | 'readwrite'
  readonly storeNames: string[]
  readonly _explicit: boolean
  oncomplete: ((event: Event) => void) | null
  onabort: ((event: Event) => void) | null
  onerror: ((event: Event) => void) | null
  objectStore(name: string): {
    get(key: IDBValidKey): {
      onsuccess: (() => void) | null
      onerror: ((event: Event) => void) | null
      result?: unknown
    }
  }
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: unknown,
  ): void
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void
  commit(): void
}

interface StoredEntry {
  key: IDBValidKey
  value: unknown
  encoded?: boolean
}

interface IndexedRow {
  key: IDBValidKey
  primaryKey: IDBValidKey
  value: unknown
  encoded?: boolean
}

interface KeyRange {
  type: number
  lower: IDBValidKey | null | undefined
  lowerOpen?: boolean
  upper: IDBValidKey | null | undefined
  upperOpen?: boolean
}

const STORE_SET = new Set<string>(APP_DATABASE_STORES)
let nativeDatabaseActive = false

// IndexedDB serializes overlapping transactions when either writes. SQLite only serializes
// applyBatch(), so the JavaScript read/modify phase must keep that same boundary too.
const nativeTransactions = new WeakMap<
  typeof nativeAppDatabase,
  Array<{ stores: Set<string>; mode: string; done: Promise<void> }>
>()
function reserveTransaction(native: typeof nativeAppDatabase, stores: string[], mode: string) {
  const pending = nativeTransactions.get(native) ?? []
  nativeTransactions.set(native, pending)
  const previous = pending.filter(
    (transaction) =>
      (mode === 'readwrite' || transaction.mode === 'readwrite') &&
      stores.some((store) => transaction.stores.has(store)),
  )
  let complete!: () => void
  const transaction = {
    stores: new Set(stores),
    mode,
    done: new Promise<void>((resolve) => {
      complete = resolve
    }),
  }
  pending.push(transaction)
  const ready = Promise.all(previous.map((entry) => entry.done)).then(() => undefined)
  return {
    ready,
    release() {
      void ready.then(() => {
        const index = pending.indexOf(transaction)
        if (index !== -1) pending.splice(index, 1)
        complete()
      })
    },
  }
}

export function activateAndroidNativeAppDatabase(): void {
  nativeDatabaseActive = true
}

export function deactivateAndroidNativeAppDatabase(): void {
  nativeDatabaseActive = false
}

export function isAndroidNativeAppDatabaseActive(): boolean {
  return nativeDatabaseActive
}

export async function compactAndroidNativeAppDatabase(native = nativeAppDatabase) {
  if (!nativeDatabaseActive) return undefined
  const reservation = reserveTransaction(native, [...APP_DATABASE_STORES], 'readwrite')
  try {
    await reservation.ready
    return await native.compact()
  } finally {
    reservation.release()
  }
}

/** A bounded bridge read under the existing transaction's reservation and completion guard. */
export function runAndroidNativeRead<T>(transaction: DBCoreTransaction, read: () => Promise<T>) {
  return Dexie.Promise.resolve((transaction as NativeTransactionFacade).runRequest(read))
}

function compareKeys(left: IDBValidKey, right: IDBValidKey): number {
  const rank = (value: IDBValidKey): number => {
    if (typeof value === 'number') return 1
    if (value instanceof Date) return 2
    if (typeof value === 'string') return 3
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return 4
    if (Array.isArray(value)) return 5
    throw new Error('IndexedDB key type cannot be compared')
  }
  const leftRank = rank(left)
  const rightRank = rank(right)
  if (leftRank !== rightRank) return leftRank < rightRank ? -1 : 1
  if (leftRank === 1)
    return (left as number) < (right as number) ? -1 : (left as number) > (right as number) ? 1 : 0
  if (leftRank === 2) {
    const a = (left as Date).getTime()
    const b = (right as Date).getTime()
    return a < b ? -1 : a > b ? 1 : 0
  }
  if (leftRank === 3)
    return (left as string) < (right as string) ? -1 : (left as string) > (right as string) ? 1 : 0
  if (leftRank === 4) {
    const bytes = (value: IDBValidKey) =>
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(
            (value as ArrayBufferView).buffer,
            (value as ArrayBufferView).byteOffset,
            (value as ArrayBufferView).byteLength,
          )
    const a = bytes(left)
    const b = bytes(right)
    for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
      if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1
    }
    return a.length < b.length ? -1 : a.length > b.length ? 1 : 0
  }
  const a = left as IDBValidKey[]
  const b = right as IDBValidKey[]
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const order = compareKeys(a[index]!, b[index]!)
    if (order) return order
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0
}

function cloneValue<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value)
  return value
}

function matchesRange(key: IDBValidKey, range: KeyRange): boolean {
  if (range.type === 3) return true
  if (range.type === 4) return false
  if (range.type === 1) return range.lower != null && compareKeys(key, range.lower) === 0
  const lower = range.lower == null ? 1 : compareKeys(key, range.lower)
  const upper = range.upper == null ? -1 : compareKeys(key, range.upper)
  return (
    (range.lower == null || lower > 0 || (lower === 0 && !range.lowerOpen)) &&
    (range.upper == null || upper < 0 || (upper === 0 && !range.upperOpen))
  )
}

function extractedKeys(index: DBCoreIndex, value: unknown, primaryKey: IDBValidKey): IDBValidKey[] {
  if (index.isPrimaryKey) return [primaryKey]
  const extracted = index.extractKey?.(value)
  if (extracted === undefined) return []
  const candidates = index.multiEntry && Array.isArray(extracted) ? extracted : [extracted]
  const distinct: IDBValidKey[] = []
  for (const key of candidates as IDBValidKey[]) {
    try {
      encodeAppDatabaseKey(key)
      if (!distinct.some((existing) => compareKeys(existing, key) === 0)) distinct.push(key)
    } catch {
      // Match IndexedDB and encodeAppDatabaseIndexes: invalid secondary keys are omitted.
    }
  }
  return distinct
}

function collectStagedBlobs(
  value: unknown,
  store: NativeAppDatabaseStore,
  output: Array<{ store: NativeAppDatabaseStore; key: string; fieldPath: string }>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectStagedBlobs(item, store, output)
    return
  }
  if (!value || typeof value !== 'object') return
  const record = value as Record<string, unknown>
  if (
    typeof record.fieldPath === 'string' &&
    typeof record.blobOwnerKey === 'string' &&
    ['blob', 'file', 'text', 'array-buffer', 'typed-array'].includes(
      String(record.__srlAppDatabaseValueV1),
    )
  ) {
    output.push({ store, key: record.blobOwnerKey, fieldPath: record.fieldPath })
  }
  for (const item of Object.values(record)) collectStagedBlobs(item, store, output)
}

class NativeTransactionFacade implements NativeTransaction {
  private readonly pageRevisions = new Map<string, string>()
  private keyPagesUnavailable = false
  readonly storeNames: string[]
  readonly mode: 'readonly' | 'readwrite'
  readonly _explicit = true
  oncomplete: ((event: Event) => void) | null = null
  onabort: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()
  private readonly cache = new Map<string, Map<string, StoreChange>>()
  private readonly tables = new Map<string, Map<string, StoreChange>>()
  private readonly loaded = new Set<string>()
  readonly cleared = new Set<string>()
  private readonly primaryKeys = new Map<string, Map<string, StoredEntry>>()
  private aborted = false
  private finished = false
  private activeRequests = 0
  private autoCompleteTimer?: ReturnType<typeof setTimeout>
  readonly native: typeof nativeAppDatabase
  private readonly emitComplete: (error?: unknown) => Promise<void>
  private readonly reservation: ReturnType<typeof reserveTransaction>
  readonly expectedRevisions: Record<string, number> = {}
  private revisionsReady?: Promise<void>

  constructor(
    stores: string[],
    mode: 'readonly' | 'readwrite',
    emitComplete: (error?: unknown) => Promise<void>,
    native: typeof nativeAppDatabase,
  ) {
    this.storeNames = [...stores]
    this.mode = mode
    this.native = native
    this.emitComplete = emitComplete
    this.reservation = reserveTransaction(native, stores, mode)
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: unknown) {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
    const signal = (options as { signal?: AbortSignal } | undefined)?.signal
    if (signal)
      signal.addEventListener('abort', () => this.removeEventListener(type, listener), {
        once: true,
      })
  }

  objectStore(name: string) {
    if (!this.storeNames.includes(name)) throw new Error(`事务未包含数据表：${name}`)
    return {
      get: (key: IDBValidKey) => {
        const request: {
          onsuccess: (() => void) | null
          onerror: ((event: Event) => void) | null
          result?: unknown
        } = {
          onsuccess: null,
          onerror: null,
        }
        void this.runRequest(async () => {
          if (key !== Number.NEGATIVE_INFINITY && key !== Number.POSITIVE_INFINITY)
            request.result = await this.get(name, key)
          await new Promise<void>((resolve) => {
            setTimeout(() => {
              try {
                request.onsuccess?.()
              } finally {
                resolve()
              }
            }, 0)
          })
        }).catch((error) =>
          request.onerror?.(new ErrorEvent('error', { error }) as unknown as Event),
        )
        return request
      },
    }
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    this.listeners.get(type)?.delete(listener)
  }

  abort(): void {
    if (this.finished || this.aborted) return
    this.aborted = true
    this.finished = true
    if (this.autoCompleteTimer) clearTimeout(this.autoCompleteTimer)
    this.dispatch('abort')
    this.reservation.release()
  }

  commit(): void {
    if (this.autoCompleteTimer) clearTimeout(this.autoCompleteTimer)
    if (this.finished || this.aborted || this.mode !== 'readwrite') {
      if (!this.finished && !this.aborted) {
        this.finished = true
        this.dispatch('complete')
        this.reservation.release()
      }
      return
    }
    this.finished = true
    void this.reservation.ready
      .then(() => this.emitComplete())
      .then(
        () => this.dispatch('complete'),
        (error) => {
          this.aborted = true
          this.dispatch('error', error)
          this.dispatch('abort', error)
        },
      )
      .finally(() => this.reservation.release())
  }

  async load(store: string): Promise<Map<string, StoredEntry>> {
    if (!this.storeNames.includes(store)) throw new Error(`事务未包含数据表：${store}`)
    if (!STORE_SET.has(store)) throw new Error(`原生数据库不支持数据表：${store}`)
    // Enumeration needs only primary keys. Values and attachments stay native until requested.
    if (!this.loaded.has(store)) {
      const entries = new Map<string, StoredEntry>()
      let afterKey: string | undefined
      if (!this.cleared.has(store)) {
        while (true) {
          const page = await this.native.getRecordKeys(
            store as NativeAppDatabaseStore,
            afterKey,
            1000,
          )
          for (const token of page.keys)
            entries.set(token, {
              key: decodeAppDatabaseKey(token),
              value: undefined,
              encoded: true,
            })
          if (!page.nextKey) break
          afterKey = page.nextKey
        }
      }
      this.primaryKeys.set(store, entries)
      this.loaded.add(store)
    }
    const entries = new Map(this.primaryKeys.get(store))
    for (const [token, change] of this.changesFor(store)) {
      if (change.deleted) entries.delete(token)
      else entries.set(token, { key: change.key, value: change.value, encoded: false })
    }
    return entries
  }

  async getMany(store: string, keys: IDBValidKey[], loadBinary = true): Promise<unknown[]> {
    if (!this.storeNames.includes(store)) throw new Error(`事务未包含数据表：${store}`)
    const cache = this.cacheFor(store)
    const changes = this.changesFor(store)
    const values: unknown[] = []
    // Decode and release each batch before reading the next. The result array is requested by
    // the caller, but the transaction must not keep a second copy of the whole scanned table.
    // The list index contains compact metadata only; match its caller's 250-row
    // batch instead of splitting every page into three bridge round trips.
    const batchSize = store === 'resourceListSummaries' ? 250 : 100
    for (let offset = 0; offset < keys.length; offset += batchSize) {
      const batch = keys.slice(offset, offset + batchSize)
      const missing = [...new Set(batch.map(encodeAppDatabaseKey))].filter(
        (token) => !changes.has(token) && !cache.has(token),
      )
      if (!this.cleared.has(store) && missing.length) {
        const rows = await this.native.getRecordsByKeys(store as NativeAppDatabaseStore, missing)
        const found = new Set(rows.map((row) => row.key))
        for (const row of rows)
          cache.set(row.key, {
            key: decodeAppDatabaseKey(row.key),
            value: row.value,
            deleted: false,
            encoded: true,
          })
        for (const token of missing)
          if (!found.has(token))
            cache.set(token, { key: decodeAppDatabaseKey(token), deleted: true })
      }
      try {
        for (const key of batch) values.push(await this.get(store, key, loadBinary))
      } finally {
        for (const token of missing) cache.delete(token)
      }
    }
    return values
  }

  clear(store: string): void {
    this.cleared.add(store)
    this.changesFor(store).clear()
    this.cacheFor(store).clear()
    this.primaryKeys.set(store, new Map())
    this.loaded.add(store)
  }

  async get(store: string, key: IDBValidKey, loadBinary = true): Promise<unknown> {
    if (!this.storeNames.includes(store)) throw new Error(`事务未包含数据表：${store}`)
    const token = encodeAppDatabaseKey(key)
    const changes = this.changesFor(store)
    const staged = changes.get(token)
    if (staged) {
      if (staged.deleted) return undefined
      const value = cloneValue(staged.value) as Record<string, unknown>
      for (const field of staged.preservedBinaryFields ?? []) {
        value[field] = await decodeAppDatabaseValue(
          value[field],
          store as NativeAppDatabaseStore,
          token,
          this.native,
          loadBinary,
        )
      }
      return value
    }
    const cached = this.cacheFor(store).get(token)
    if (cached) {
      if (cached.deleted) return undefined
      if (cached.encoded) {
        // Clone descriptors before hydration: cloning a hydrated Blob drops its
        // NativeFileSource identity and makes APK cloud handoff reject the file.
        // Keep only descriptors in the transaction cache, never hydrated attachments.
        return decodeAppDatabaseValue(
          cloneValue(cached.value),
          store as NativeAppDatabaseStore,
          token,
          this.native,
          loadBinary,
        )
      }
      return cloneValue(cached.value)
    }
    if (this.cleared.has(store)) return undefined
    const nativeStore = store as NativeAppDatabaseStore
    const value = await this.native.getRecord(nativeStore, token)
    if (value === undefined) return undefined
    return decodeAppDatabaseValue(cloneValue(value), nativeStore, token, this.native, loadBinary)
  }

  async queryIndex(
    store: string,
    index: DBCoreIndex,
    range: KeyRange,
    direction: string,
  ): Promise<IndexedRow[]> {
    if (!index.name || index.isPrimaryKey) throw new Error('原生次级索引查询缺少索引名')
    const exactKey =
      range.type === 1 && range.lower != null ? encodeAppDatabaseKey(range.lower) : undefined
    const nativeRows = this.cleared.has(store)
      ? []
      : await this.native.getIndexEntries(store as NativeAppDatabaseStore, index.name, exactKey)
    const changed = this.changesFor(store)
    const rows: IndexedRow[] = []
    for (const row of nativeRows) {
      const primaryKey = decodeAppDatabaseKey(row.primaryKey)
      if (changed.has(row.primaryKey)) continue
      const key = decodeAppDatabaseKey(row.indexKey)
      if (matchesRange(key, range)) rows.push({ key, primaryKey, value: undefined, encoded: true })
    }
    for (const change of changed.values()) {
      if (change.deleted) continue
      for (const key of extractedKeys(index, change.value, change.key)) {
        if (matchesRange(key, range))
          rows.push({ key, primaryKey: change.key, value: change.value, encoded: false })
      }
    }
    const reverse = direction.startsWith('prev')
    rows.sort((left, right) => {
      const byIndex = compareKeys(left.key, right.key)
      if (byIndex) return reverse ? -byIndex : byIndex
      const byPrimary = compareKeys(left.primaryKey, right.primaryKey)
      return reverse && !direction.endsWith('unique') ? -byPrimary : byPrimary
    })
    if (direction.endsWith('unique')) {
      const unique: IndexedRow[] = []
      for (const row of rows) {
        if (!unique.length || compareKeys(unique.at(-1)!.key, row.key) !== 0) unique.push(row)
      }
      return unique
    }
    return rows
  }

  async queryKeyPage(
    store: string,
    index: DBCoreIndex,
    range: KeyRange,
    direction: string,
    options: Pick<
      NativeKeyPageQuery,
      | 'limit'
      | 'countOnly'
      | 'offset'
      | 'afterKey'
      | 'afterPrimaryKey'
      | 'seekKey'
      | 'seekPrimaryKey'
    > = {},
  ) {
    if (
      this.mode !== 'readonly' ||
      this.keyPagesUnavailable ||
      typeof this.native.queryKeyPage !== 'function'
    )
      return undefined
    if (range.type === 4) return { rows: [], count: 0 }
    // The legacy comparator handles non-finite range sentinels; persisted keys remain finite.
    if (
      range.type !== 3 &&
      [range.lower, range.upper].some((key) => typeof key === 'number' && !Number.isFinite(key))
    )
      return undefined
    const query: NativeKeyPageQuery = {
      ...options,
      indexName: index.isPrimaryKey ? undefined : (index.name ?? undefined),
      reverse: direction.startsWith('prev'),
      unique: direction.endsWith('unique'),
      lower:
        range.lower == null || range.type === 3 ? undefined : encodeAppDatabaseKey(range.lower),
      upper:
        range.type === 1
          ? encodeAppDatabaseKey(range.lower!)
          : range.upper == null || range.type === 3
            ? undefined
            : encodeAppDatabaseKey(range.upper),
      lowerOpen: range.type === 1 ? false : range.lowerOpen,
      upperOpen: range.type === 1 ? false : range.upperOpen,
      revision: this.pageRevisions.get(store),
    }
    try {
      const page = await this.native.queryKeyPage(store as NativeAppDatabaseStore, query)
      if (typeof page.revision !== 'string' || (!options.countOnly && !Array.isArray(page.rows)))
        throw new Error('原生范围查询响应无效')
      if (query.revision !== undefined && query.revision !== page.revision)
        throw new Error('原生查询期间数据已变化，请重新打开列表')
      this.pageRevisions.set(store, page.revision)
      return {
        count: page.count,
        rows:
          page.rows?.map((row): IndexedRow => ({
            key: decodeAppDatabaseKey(row.indexKey),
            primaryKey: decodeAppDatabaseKey(row.primaryKey),
            value: undefined,
            encoded: true,
          })) ?? [],
      }
    } catch (error) {
      if ((error as { code?: string }).code !== 'UNIMPLEMENTED') throw error
      this.keyPagesUnavailable = true
      return undefined
    }
  }

  scheduleAutoComplete(): void {
    if (this.finished || this.aborted || this.activeRequests > 0) return
    if (this.autoCompleteTimer) clearTimeout(this.autoCompleteTimer)
    this.autoCompleteTimer = setTimeout(() => this.commit(), 0)
  }

  pauseAutoComplete(): void {
    if (this.autoCompleteTimer) clearTimeout(this.autoCompleteTimer)
    this.autoCompleteTimer = undefined
  }

  beginRequest(): () => void {
    if (this.finished || this.aborted)
      throw new DOMException('原生数据库事务已经结束', 'TransactionInactiveError')
    this.pauseAutoComplete()
    this.activeRequests += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.activeRequests -= 1
      if (this.activeRequests === 0) this.scheduleAutoComplete()
    }
  }

  async runRequest<T>(operation: () => Promise<T>): Promise<T> {
    const release = this.beginRequest()
    try {
      await this.waitUntilReady()
      return await operation()
    } finally {
      release()
    }
  }

  async waitUntilReady(): Promise<void> {
    await this.reservation.ready
    if (this.aborted) throw new DOMException('原生数据库事务已取消', 'AbortError')
    if (this.mode === 'readwrite') {
      this.revisionsReady ??= (async () => {
        for (const store of this.storeNames) {
          const raw = await this.native.getState(`revision:appdb:v1:${store}`)
          const revision = raw === undefined ? 0 : Number(raw)
          if (!Number.isSafeInteger(revision) || revision < 0)
            throw new Error(`原生数据表 ${store} 的版本无效`)
          this.expectedRevisions[store] = revision
        }
      })()
      await this.revisionsReady
    }
  }

  cacheFor(store: string): Map<string, StoreChange> {
    let cache = this.cache.get(store)
    if (!cache) {
      cache = new Map()
      this.cache.set(store, cache)
    }
    return cache
  }

  changesFor(store: string): Map<string, StoreChange> {
    let changes = this.tables.get(store)
    if (!changes) {
      changes = new Map()
      this.tables.set(store, changes)
    }
    return changes
  }

  private dispatch(type: string, error?: unknown): void {
    const event = new Event(type)
    if (error !== undefined) Object.defineProperty(event, 'error', { value: error })
    const handler =
      type === 'complete' ? this.oncomplete : type === 'abort' ? this.onabort : this.onerror
    handler?.(event)
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === 'function') listener.call(this, event)
      else listener.handleEvent(event)
    }
  }
}

function getCursorRows(
  entries: Map<string, StoredEntry>,
  index: DBCoreIndex,
  range: KeyRange,
  direction: string,
): Array<{ key: IDBValidKey; primaryKey: IDBValidKey; value: unknown; encoded?: boolean }> {
  const rows: Array<{
    key: IDBValidKey
    primaryKey: IDBValidKey
    value: unknown
    encoded?: boolean
  }> = []
  for (const entry of entries.values()) {
    for (const key of extractedKeys(index, entry.value, entry.key)) {
      if (matchesRange(key, range))
        rows.push({ key, primaryKey: entry.key, value: entry.value, encoded: entry.encoded })
    }
  }
  const reverse = direction.startsWith('prev')
  rows.sort((left, right) => {
    const byIndex = compareKeys(left.key, right.key)
    if (byIndex) return reverse ? -byIndex : byIndex
    const byPrimary = compareKeys(left.primaryKey, right.primaryKey)
    return reverse && !direction.endsWith('unique') ? -byPrimary : byPrimary
  })
  if (direction.endsWith('unique')) {
    const unique: typeof rows = []
    let previous: IDBValidKey | undefined
    for (const row of rows) {
      if (previous === undefined || compareKeys(previous, row.key) !== 0) unique.push(row)
      previous = row.key
    }
    return unique
  }
  return rows
}

function createCursor(
  trans: DBCoreTransaction,
  rows: Array<{ key: IDBValidKey; primaryKey: IDBValidKey; value: unknown; encoded?: boolean }>,
  values: boolean,
  reverse: boolean,
  decode: (value: unknown, row: (typeof rows)[number]) => Promise<unknown>,
  nativeTransaction: NativeTransactionFacade,
  fetchPage?: (
    last: { key: IDBValidKey; primaryKey: IDBValidKey },
    options: Pick<NativeKeyPageQuery, 'offset' | 'seekKey' | 'seekPrimaryKey'>,
  ) => Promise<IndexedRow[]>,
): DBCoreCursor {
  nativeTransaction.pauseAutoComplete()
  let position = 0
  let done = rows.length === 0
  let callback: (() => void) | undefined
  let resolveIteration: ((value?: unknown) => void) | undefined
  let hydratedRow: (typeof rows)[number] | undefined
  let seek: Pick<NativeKeyPageQuery, 'seekKey' | 'seekPrimaryKey'> = {}
  const requests = new Set<() => void>()
  const releaseRequests = () => {
    for (const release of requests) release()
    requests.clear()
  }
  const releaseValue = () => {
    if (hydratedRow) {
      hydratedRow.value = undefined
      hydratedRow.encoded = true
      hydratedRow = undefined
    }
  }
  const cursor: DBCoreCursor = {
    trans,
    get key() {
      return rows[position]?.key
    },
    get primaryKey() {
      return rows[position]?.primaryKey
    },
    get value() {
      return values && !done ? rows[position]?.value : undefined
    },
    get done() {
      return done
    },
    start(onNext) {
      callback = onNext
      return new Dexie.Promise((resolve) => {
        resolveIteration = resolve
        queueMicrotask(run)
      })
    },
    continue(key) {
      if (done) return
      releaseValue()
      position += 1
      seek = key === undefined ? {} : { seekKey: encodeAppDatabaseKey(key) }
      if (key !== undefined) {
        while (
          position < rows.length &&
          (reverse
            ? compareKeys(rows[position]!.key, key) > 0
            : compareKeys(rows[position]!.key, key) < 0)
        )
          position += 1
      }
      queueMicrotask(run)
    },
    continuePrimaryKey(key, primaryKey) {
      if (done) return
      releaseValue()
      position += 1
      seek = {
        seekKey: encodeAppDatabaseKey(key),
        seekPrimaryKey: encodeAppDatabaseKey(primaryKey),
      }
      while (
        position < rows.length &&
        (reverse
          ? compareKeys(rows[position]!.key, key) > 0 ||
            (compareKeys(rows[position]!.key, key) === 0 &&
              compareKeys(rows[position]!.primaryKey, primaryKey) > 0)
          : compareKeys(rows[position]!.key, key) < 0 ||
            (compareKeys(rows[position]!.key, key) === 0 &&
              compareKeys(rows[position]!.primaryKey, primaryKey) < 0))
      )
        position += 1
      queueMicrotask(run)
    },
    advance(count) {
      if (done) return
      releaseValue()
      position += Math.max(1, count)
      seek = {}
      queueMicrotask(run)
    },
    stop(value) {
      if (done && resolveIteration === undefined) return
      done = true
      releaseValue()
      rows = []
      releaseRequests()
      nativeTransaction.scheduleAutoComplete()
      resolveIteration?.(value)
      resolveIteration = undefined
    },
    fail(error) {
      done = true
      releaseValue()
      rows = []
      releaseRequests()
      nativeTransaction.scheduleAutoComplete()
      // Dexie's cursor consumer owns the promise rejection through this method.
      resolveIteration?.(Promise.reject(error))
      resolveIteration = undefined
    },
    async next() {
      if (done) return cursor
      await new Promise<void>((resolve, reject) => {
        const previous = callback
        callback = () => {
          try {
            previous?.()
            resolve()
          } catch (error) {
            reject(error)
          }
        }
        if (!resolveIteration) resolveIteration = () => resolve()
        queueMicrotask(run)
      })
      return cursor
    },
  }

  async function run(): Promise<void> {
    if (done) return
    let release: (() => void) | undefined
    try {
      release = nativeTransaction.beginRequest()
      requests.add(release)
      await nativeTransaction.waitUntilReady()
      if (done) return
      if (position >= rows.length && fetchPage && rows.length) {
        const last = rows.at(-1)!
        const nextRows = await fetchPage(last, { ...seek, offset: position - rows.length })
        if (done) return
        await nativeTransaction.waitUntilReady()
        if (done) return
        rows = nextRows
        position = 0
        seek = {}
      }
      if (position >= rows.length) {
        done = true
        releaseValue()
        nativeTransaction.scheduleAutoComplete()
        resolveIteration?.()
        resolveIteration = undefined
        return
      }
      if (values && rows[position]!.encoded) {
        const row = rows[position]!
        const value = await decode(row.value, row)
        if (done) return
        await nativeTransaction.waitUntilReady()
        if (done) return
        row.value = value
        row.encoded = false
        hydratedRow = row
      }
      callback?.()
    } catch (error) {
      if (done) return
      cursor.fail(error as Error)
    } finally {
      if (release) {
        requests.delete(release)
        release()
      }
    }
  }
  return cursor
}

async function applyMutations(
  trans: NativeTransactionFacade,
  store: string,
  schema: DBCoreTable['schema'],
  request: DBCoreMutateRequest,
) {
  if (trans.mode !== 'readwrite') throw new Error('只读事务不能写入')
  // Only the storage metadata owner opts in; ordinary Dexie reads/modifiers still
  // receive real binary values. Retained references come from the stored record.
  const metadataOnly =
    (request as DBCoreMutateRequest & { resourceMetadataOnly?: boolean }).resourceMetadataOnly ===
    true
  if (metadataOnly && !['resources', 'resourceVersions'].includes(store))
    throw new Error('元数据更新仅支持资源表')
  if (metadataOnly && (request.type !== 'put' || !request.updates))
    throw new Error('元数据更新必须按资源主键提交补丁')
  const changes = trans.changesFor(store)
  const failures: Record<number, Error> = {}
  const results: unknown[] = []
  let lastResult: unknown
  const putOne = async (value: unknown, key?: IDBValidKey, index?: number) => {
    const actualKey = key ?? schema.primaryKey.extractKey?.(value)
    if (actualKey === undefined) throw new Error(`数据表 ${store} 缺少主键`)
    const token = encodeAppDatabaseKey(actualKey)
    if (request.type === 'add' && (await trans.get(store, actualKey)) !== undefined) {
      failures[index ?? 0] = new DOMException('主键已存在', 'ConstraintError')
      return
    }
    if (
      request.type === 'put' &&
      request.upsert === false &&
      !metadataOnly &&
      (await trans.get(store, actualKey, !metadataOnly)) === undefined
    )
      return
    const uniqueIndexes = schema.indexes.filter(
      (candidate) => candidate.unique && !candidate.isPrimaryKey,
    )
    if (uniqueIndexes.length) {
      for (const uniqueIndex of uniqueIndexes) {
        const candidateKeys = extractedKeys(uniqueIndex, value, actualKey)
        if (!uniqueIndex.name) continue
        for (const candidateKey of candidateKeys) {
          const encodedIndexKey = encodeAppDatabaseKey(candidateKey)
          const existing = trans.cleared.has(store)
            ? []
            : await trans.native.getIndexEntries(
                store as NativeAppDatabaseStore,
                uniqueIndex.name,
                encodedIndexKey,
              )
          const pending = trans.changesFor(store)
          if (
            existing.some((entry) => {
              if (entry.primaryKey === token) return false
              return !pending.has(entry.primaryKey)
            })
          ) {
            throw new DOMException(`唯一索引 ${uniqueIndex.name} 已存在相同值`, 'ConstraintError')
          }
          for (const [pendingKey, change] of pending) {
            if (change.deleted || pendingKey === token) continue
            if (
              extractedKeys(uniqueIndex, change.value, change.key).some(
                (key) => compareKeys(key, candidateKey) === 0,
              )
            ) {
              throw new DOMException(`唯一索引 ${uniqueIndex.name} 已存在相同值`, 'ConstraintError')
            }
          }
        }
      }
    }
    changes.set(token, { key: actualKey, value: cloneValue(value), deleted: false })
    lastResult = actualKey
    results.push(actualKey)
  }

  if (request.type === 'add' || request.type === 'put') {
    const putRequest = request as DBCorePutRequest
    if (putRequest.updates) {
      for (let index = 0; index < putRequest.updates.keys.length; index += 1) {
        const key = putRequest.updates.keys[index] as IDBValidKey
        const current = (await trans.get(store, key, !metadataOnly)) as
          Record<string, unknown> | undefined
        if (!current) continue
        const updated = { ...current }
        for (const [path, value] of Object.entries(putRequest.updates.changeSpecs[index] ?? {})) {
          const parts = path.split('.')
          let target = updated
          for (const part of parts.slice(0, -1)) {
            const nested = target[part]
            if (!nested || typeof nested !== 'object') target[part] = {}
            target = target[part] as Record<string, unknown>
          }
          target[parts.at(-1)!] = value
        }
        await putOne(updated, key, index)
        if (metadataOnly) {
          const containsBinaryReference = (value: unknown): boolean =>
            isEncodedBlobValue(value) ||
            (!!value &&
              typeof value === 'object' &&
              Object.values(value).some(containsBinaryReference))
          const specs = putRequest.updates.changeSpecs[index] ?? {}
          changes.get(encodeAppDatabaseKey(key))!.preservedBinaryFields = [
            'originalBlob',
            'original',
            'thumbnailBlob',
            'thumbnail',
          ].filter(
            (field) =>
              !Object.keys(specs).some((path) => path === field || path.startsWith(`${field}.`)) &&
              containsBinaryReference(current[field]),
          )
        }
      }
    } else if (putRequest.criteria && putRequest.changeSpec) {
      const index = putRequest.criteria.index
        ? schema.getIndexByKeyPath(putRequest.criteria.index)
        : schema.primaryKey
      if (!index) throw new Error(`数据表 ${store} 不存在指定索引`)
      let indexOffset = 0
      const rows = index.isPrimaryKey
        ? getCursorRows(await trans.load(store), index, putRequest.criteria.range, 'next')
        : await trans.queryIndex(store, index, putRequest.criteria.range, 'next')
      const uniqueKeys = new Map(
        rows.map((row) => [encodeAppDatabaseKey(row.primaryKey), row.primaryKey]),
      )
      for (const key of uniqueKeys.values()) {
        const updated = { ...((await trans.get(store, key)) as Record<string, unknown>) }
        for (const [path, value] of Object.entries(putRequest.changeSpec)) {
          const parts = path.split('.')
          let target = updated
          for (const part of parts.slice(0, -1)) {
            const nested = target[part]
            if (!nested || typeof nested !== 'object') target[part] = {}
            target = target[part] as Record<string, unknown>
          }
          target[parts.at(-1)!] = value
        }
        await putOne(updated, key, indexOffset++)
      }
    } else {
      for (let index = 0; index < request.values.length; index += 1) {
        await putOne(request.values[index], request.keys?.[index] as IDBValidKey | undefined, index)
      }
    }
  } else if (request.type === 'delete') {
    if (request.criteria) {
      const index = request.criteria.index
        ? schema.getIndexByKeyPath(request.criteria.index)
        : schema.primaryKey
      if (!index) throw new Error(`数据表 ${store} 不存在指定索引`)
      const rows = index.isPrimaryKey
        ? getCursorRows(await trans.load(store), index, request.criteria.range, 'next')
        : await trans.queryIndex(store, index, request.criteria.range, 'next')
      for (const row of rows) {
        changes.set(encodeAppDatabaseKey(row.primaryKey), { key: row.primaryKey, deleted: true })
        lastResult = row.primaryKey
      }
    } else {
      for (const key of request.keys) {
        changes.set(encodeAppDatabaseKey(key), { key, deleted: true })
        lastResult = key
      }
    }
  } else if (request.range.type === 3) {
    trans.clear(store)
  } else {
    const entries = await trans.load(store)
    for (const entry of entries.values()) {
      const primaryKey = entry.key
      if (matchesRange(primaryKey, request.range)) {
        changes.set(encodeAppDatabaseKey(primaryKey), { key: primaryKey, deleted: true })
        lastResult = primaryKey
      }
    }
  }
  return { numFailures: Object.keys(failures).length, failures, results, lastResult }
}

/** DBCore backend used only after Android's per-store migration has been verified. */
export function createAndroidNativeDexieCore(options: {
  enabled: () => boolean
  native?: typeof nativeAppDatabase
}) {
  const native = options.native ?? nativeAppDatabase
  return {
    stack: 'dbcore' as const,
    // Keep Dexie cache, observability, hooks and virtual indexes above the backend.
    level: -2,
    name: 'AndroidNativeAppDatabase',
    create(downstream: DBCore): DBCore {
      const txByFacade = new WeakMap<object, NativeTransactionFacade>()
      const core: DBCore = {
        ...downstream,
        transaction(stores, mode) {
          if (!options.enabled()) return downstream.transaction(stores, mode)
          const facade = new NativeTransactionFacade(
            stores,
            mode,
            async () => {
              const operations: NativeAppDatabaseBatchOperation[] = []
              const stagedBlobs: Array<{
                store: NativeAppDatabaseStore
                key: string
                fieldPath: string
              }> = []
              try {
                for (const store of stores) {
                  const changes = txByFacade.get(facade)?.changesFor(store)
                  if (facade.cleared.has(store))
                    operations.push({ type: 'clear', store: store as NativeAppDatabaseStore })
                  if (!changes?.size) continue
                  const tableSchema = downstream.table(store).schema
                  const puts: Array<{
                    key: string
                    value: Record<string, unknown>
                    indexes?: ReturnType<typeof encodeAppDatabaseIndexes>
                  }> = []
                  const deletes: string[] = []
                  for (const [key, change] of changes) {
                    if (change.deleted) deletes.push(key)
                    else {
                      const blobOwnerKey = `__srl_tx_${crypto.randomUUID()}`
                      const value = { ...(change.value as Record<string, unknown>) }
                      const preserved = Object.fromEntries(
                        (change.preservedBinaryFields ?? []).map((field) => [field, value[field]]),
                      )
                      for (const field of Object.keys(preserved)) delete value[field]
                      const encoded = await encodeAppDatabaseValue(
                        value,
                        store as NativeAppDatabaseStore,
                        key,
                        native,
                        blobOwnerKey,
                      )
                      if (!encoded || typeof encoded !== 'object' || Array.isArray(encoded))
                        throw new Error(`原生数据库记录必须是对象：${store}`)
                      Object.assign(encoded, preserved)
                      collectStagedBlobs(encoded, store as NativeAppDatabaseStore, stagedBlobs)
                      puts.push({
                        key,
                        value: encoded as Record<string, unknown>,
                        indexes: encodeAppDatabaseIndexes(change.value, tableSchema.indexes),
                      })
                    }
                  }
                  if (puts.length)
                    operations.push({
                      type: 'put',
                      store: store as NativeAppDatabaseStore,
                      rows: puts,
                    })
                  if (deletes.length)
                    operations.push({
                      type: 'delete',
                      store: store as NativeAppDatabaseStore,
                      keys: deletes,
                    })
                }
                if (operations.length)
                  await native.applyBatch(operations, {
                    requireActiveLibrary: true,
                    expectedRevisions: facade.expectedRevisions,
                  })
              } catch (error) {
                await Promise.all(
                  stagedBlobs.map(({ store, key, fieldPath }) =>
                    native.deleteBlob(store, key, fieldPath).catch(() => undefined),
                  ),
                )
                throw error
              }
            },
            native,
          )
          txByFacade.set(facade, facade)
          // Even an unused/cache-only transaction completes, as an IndexedDB transaction does.
          facade.scheduleAutoComplete()
          return facade as unknown as ReturnType<DBCore['transaction']>
        },
        table(name) {
          const downstreamTable = downstream.table(name)
          if (!STORE_SET.has(name)) return downstreamTable
          const table: DBCoreTable = {
            ...downstreamTable,
            get(request) {
              if (!options.enabled()) return downstreamTable.get(request)
              const trans = request.trans as NativeTransactionFacade
              const loadBinary = (request as typeof request & { loadBinary?: boolean }).loadBinary
              return Dexie.Promise.resolve(
                trans.runRequest(() => trans.get(name, request.key, loadBinary)),
              )
            },
            getMany(request) {
              if (!options.enabled()) return downstreamTable.getMany(request)
              const trans = request.trans as NativeTransactionFacade
              const loadBinary = (request as typeof request & { loadBinary?: boolean }).loadBinary
              return Dexie.Promise.resolve(
                trans.runRequest(() => trans.getMany(name, request.keys, loadBinary)),
              )
            },
            query(request) {
              if (!options.enabled()) return downstreamTable.query(request)
              const trans = request.trans as NativeTransactionFacade
              return Dexie.Promise.resolve(
                trans.runRequest(async () => {
                  if (request.limit === 0) return { result: [] }
                  const first = await trans.queryKeyPage(
                    name,
                    request.query.index,
                    request.query.range,
                    request.direction ?? 'next',
                    { limit: Math.min(1000, request.limit ?? 1000) || 1 },
                  )
                  if (first) {
                    const rows = first.rows
                    const limit = request.limit ?? Infinity
                    while (rows.length < limit && rows.length && rows.length % 1000 === 0) {
                      const last = rows.at(-1)!
                      const page = await trans.queryKeyPage(
                        name,
                        request.query.index,
                        request.query.range,
                        request.direction ?? 'next',
                        {
                          limit: Math.min(1000, limit - rows.length),
                          afterKey: encodeAppDatabaseKey(last.key),
                          afterPrimaryKey: encodeAppDatabaseKey(last.primaryKey),
                        },
                      )
                      rows.push(...page!.rows)
                      if (page!.rows.length < 1000) break
                    }
                    const chosen = rows.slice(0, limit)
                    return {
                      result:
                        request.values === false
                          ? chosen.map((row) => cloneValue(row.primaryKey))
                          : await trans.getMany(
                              name,
                              chosen.map((row) => row.primaryKey),
                            ),
                    }
                  }
                  if (!request.query.index.isPrimaryKey && request.query.index.name) {
                    let rows = await trans.queryIndex(
                      name,
                      request.query.index,
                      request.query.range,
                      request.direction ?? 'next',
                    )
                    if (request.limit !== undefined) rows = rows.slice(0, request.limit)
                    const result =
                      request.values === false
                        ? rows.map((row) => cloneValue(row.primaryKey))
                        : await trans.getMany(
                            name,
                            rows.map((row) => row.primaryKey),
                          )
                    return { result }
                  }
                  const entries = await trans.load(name)
                  const direction = request.direction ?? 'next'
                  let rows = getCursorRows(
                    entries,
                    request.query.index,
                    request.query.range,
                    direction,
                  )
                  if (request.limit !== undefined) rows = rows.slice(0, request.limit)
                  const result =
                    request.values === false
                      ? rows.map((row) => cloneValue(row.primaryKey))
                      : await trans.getMany(
                          name,
                          rows.map((row) => row.primaryKey),
                        )
                  return { result }
                }),
              )
            },
            count(request) {
              if (!options.enabled()) return downstreamTable.count(request)
              const trans = request.trans as NativeTransactionFacade
              return Dexie.Promise.resolve(
                trans.runRequest(async () => {
                  if (request.query.range.type === 4) return 0
                  const page = await trans.queryKeyPage(
                    name,
                    request.query.index,
                    request.query.range,
                    'next',
                    { countOnly: true },
                  )
                  if (page) {
                    if (!Number.isSafeInteger(page.count) || page.count! < 0)
                      throw new Error('原生范围计数无效')
                    return page.count!
                  }
                  if (!request.query.index.isPrimaryKey && request.query.index.name) {
                    if (
                      trans.changesFor(name).size === 0 &&
                      [1, 3].includes(request.query.range.type)
                    )
                      return trans.cleared.has(name)
                        ? 0
                        : trans.native.countIndexEntries(
                            name as NativeAppDatabaseStore,
                            request.query.index.name,
                            request.query.range.type === 1
                              ? encodeAppDatabaseKey(request.query.range.lower!)
                              : undefined,
                          )
                    return (
                      await trans.queryIndex(name, request.query.index, request.query.range, 'next')
                    ).length
                  }
                  if (request.query.range.type === 3 && trans.changesFor(name).size === 0)
                    return trans.cleared.has(name)
                      ? 0
                      : trans.native.countRecords(name as NativeAppDatabaseStore)
                  const entries = await trans.load(name)
                  return getCursorRows(entries, request.query.index, request.query.range, 'next')
                    .length
                }),
              )
            },
            mutate(request) {
              if (!options.enabled()) return downstreamTable.mutate(request)
              const trans = request.trans as NativeTransactionFacade
              return Dexie.Promise.resolve(
                trans.runRequest(() =>
                  applyMutations(trans, name, downstreamTable.schema, request),
                ),
              )
            },
            openCursor(request) {
              if (!options.enabled()) return downstreamTable.openCursor(request)
              const trans = request.trans as NativeTransactionFacade
              trans.pauseAutoComplete()
              return Dexie.Promise.resolve(
                (async () => {
                  await trans.waitUntilReady()
                  const direction = request.reverse
                    ? request.unique
                      ? 'prevunique'
                      : 'prev'
                    : request.unique
                      ? 'nextunique'
                      : 'next'
                  const first = await trans.queryKeyPage(
                    name,
                    request.query.index,
                    request.query.range,
                    direction,
                  )
                  if (first) {
                    if (!first.rows.length) {
                      trans.scheduleAutoComplete()
                      return null
                    }
                    return createCursor(
                      request.trans,
                      first.rows,
                      request.values !== false,
                      request.reverse ?? false,
                      (_value, row) => trans.get(name, row.primaryKey),
                      trans,
                      async (last, options) =>
                        (await trans.queryKeyPage(
                          name,
                          request.query.index,
                          request.query.range,
                          direction,
                          {
                            ...options,
                            afterKey: encodeAppDatabaseKey(last.key),
                            afterPrimaryKey: encodeAppDatabaseKey(last.primaryKey),
                          },
                        ))!.rows,
                    )
                  }
                  if (!request.query.index.isPrimaryKey && request.query.index.name) {
                    const rows = await trans.queryIndex(
                      name,
                      request.query.index,
                      request.query.range,
                      request.reverse
                        ? request.unique
                          ? 'prevunique'
                          : 'prev'
                        : request.unique
                          ? 'nextunique'
                          : 'next',
                    )
                    if (!rows.length) {
                      trans.scheduleAutoComplete()
                      return null
                    }
                    return rows.length
                      ? createCursor(
                          request.trans,
                          rows,
                          request.values !== false,
                          request.reverse ?? false,
                          async (value, row) =>
                            row.encoded ? trans.get(name, row.primaryKey) : value,
                          trans,
                        )
                      : null
                  }
                  const entries = await trans.load(name)
                  const fallbackDirection = request.reverse
                    ? request.unique
                      ? 'prevunique'
                      : 'prev'
                    : request.unique
                      ? 'nextunique'
                      : 'next'
                  const rows = getCursorRows(
                    entries,
                    request.query.index,
                    request.query.range,
                    fallbackDirection,
                  )
                  if (!rows.length) {
                    trans.scheduleAutoComplete()
                    return null
                  }
                  return rows.length
                    ? createCursor(
                        request.trans,
                        rows,
                        request.values !== false,
                        request.reverse ?? false,
                        (value, row) =>
                          row.encoded ? trans.get(name, row.primaryKey) : Promise.resolve(value),
                        trans,
                      )
                    : null
                })(),
              )
            },
          }
          return table
        },
      }
      return core
    },
  }
}

export function canUseAndroidNativeDexieCore(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
}
