import Dexie from 'dexie'
import { hashBytes } from '../services/HashService'
import type { AppDatabase } from '../database/AppDatabase'
import { BUILD_INFO } from '../core/BuildInfo'
import { isCapacitorApp } from '../utils/CapacitorDetection'
import {
  AndroidAppDatabaseMigrator,
  canonicalizeAppDatabaseValue,
  decodeAppDatabaseKey,
  decodeAppDatabaseValue,
  encodeAppDatabaseIndexes,
  encodeAppDatabaseKey,
  encodeAppDatabaseValue,
  fingerprintAppDatabaseStore,
  getAppDatabasePrimaryKey,
} from './AndroidAppDatabaseMigration'
import {
  APP_DATABASE_STORES,
  nativeAppDatabase,
  type NativeAppDatabaseStore,
} from './NativeAppDatabaseBridge'
import {
  activateAndroidNativeAppDatabase,
  canUseAndroidNativeDexieCore,
  deactivateAndroidNativeAppDatabase,
  isAndroidNativeAppDatabaseActive,
} from './AndroidNativeDexieCore'

const ACTIVE_STATE_KEY = 'migration:appdb:v1:active'
const INDEX_STATE_KEY = 'migration:appdb:indexes:v1:active'
const RETRY_STATE_KEY = 'migration:appdb:v1:retry-requested'
const ACTIVE_STATE_VERSION = 1

export function canRetryAndroidNativeAppDatabaseMigration(): boolean {
  return isCapacitorApp() && canUseAndroidNativeDexieCore() && !isAndroidNativeAppDatabaseActive()
}

export async function requestAndroidNativeAppDatabaseMigrationRetry(): Promise<void> {
  if (!canRetryAndroidNativeAppDatabaseMigration())
    throw new Error('当前原生数据库已启用或当前设备不支持迁移重试')
  const activeState = await nativeAppDatabase.getState(ACTIVE_STATE_KEY)
  if (activeState !== undefined)
    throw new Error('原生数据库已有启用状态；为保护现有数据，没有重置迁移副本')
  await nativeAppDatabase.putState(RETRY_STATE_KEY, 'requested-v1')
}

export async function resetIncompleteAndroidNativeAppDatabaseMigration(
  native: typeof nativeAppDatabase = nativeAppDatabase,
): Promise<void> {
  const activeState = await native.getState(ACTIVE_STATE_KEY)
  if (activeState !== undefined)
    throw new Error('检测到原生数据库启用状态；为保护现有数据，没有重置迁移副本')
  for (const store of APP_DATABASE_STORES) {
    await native.clearStore(store)
    await native.putState(`migration:appdb:v1:${store}`, '')
  }
  await native.putState(INDEX_STATE_KEY, '')
  await native.putState(RETRY_STATE_KEY, '')
}

export interface AndroidNativeAppDatabaseStartupProgress {
  store: NativeAppDatabaseStore
  copied: number
  total: number
  status: 'copying' | 'failed' | 'verified'
}

export interface AndroidNativeAppDatabaseStartupResult {
  native: boolean
  migrated: boolean
  copied: number
  total: number
}

async function nativeIndexSchema(database: AppDatabase): Promise<string> {
  const schema = database.tables
    .filter((table) => APP_DATABASE_STORES.includes(table.name as NativeAppDatabaseStore))
    .map((table) => ({
      name: table.name,
      key: table.schema.primKey.keyPath,
      indexes: table.schema.indexes.map(({ name, keyPath, multi, unique }) => ({
        name,
        keyPath,
        multi,
        unique,
      })),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
  return hashBytes(new TextEncoder().encode(JSON.stringify(schema)))
}

async function ensureNativeIndexes(
  database: AppDatabase,
  active: ActiveState,
  native: typeof nativeAppDatabase,
): Promise<string> {
  const schema = await nativeIndexSchema(database)
  if (active.indexSchema === schema) return schema
  // Adopt the existing verified receipt once. A real schema change rebuilds from
  // native metadata, never from the retained (possibly already empty) source.
  if (
    active.indexSchema === undefined &&
    active.databaseVersion === BUILD_INFO.databaseVersion &&
    (await native.getState(INDEX_STATE_KEY)) === 'verified-v1'
  )
    return schema
  await native.putState(INDEX_STATE_KEY, '')
  const available = new Set(database.tables.map((table) => table.name))
  for (const store of APP_DATABASE_STORES) {
    if (!available.has(store)) continue
    const table = database.table(store)
    await native.clearIndexes(store)
    let afterKey: string | undefined
    while (true) {
      const page = await native.getRecords(store, afterKey, 500)
      if (!page.rows.length) break
      await native.putRecords(
        store,
        page.rows.map((row) => ({
          ...row,
          indexes: encodeAppDatabaseIndexes(row.value, table.schema.indexes),
        })),
      )
      afterKey = page.nextKey ?? undefined
      if (!afterKey) break
    }
  }
  await native.putState(INDEX_STATE_KEY, 'verified-v1')
  return schema
}

interface ActiveState {
  version: number
  databaseVersion: number
  activatedAt: number
  mode?: 'active' | 'legacy' | 'rolling-back'
  indexSchema?: string
}

function parseActiveState(value: string | undefined): ActiveState | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as Partial<ActiveState>
    if (
      parsed.version !== ACTIVE_STATE_VERSION ||
      !Number.isSafeInteger(parsed.databaseVersion) ||
      !Number.isFinite(parsed.activatedAt) ||
      (parsed.indexSchema !== undefined &&
        (typeof parsed.indexSchema !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.indexSchema))) ||
      (parsed.mode !== undefined &&
        parsed.mode !== 'active' &&
        parsed.mode !== 'legacy' &&
        parsed.mode !== 'rolling-back')
    )
      return undefined
    return parsed as ActiveState
  } catch {
    return undefined
  }
}

/**
 * Completes the first APK migration before app features can write to Dexie, then activates the
 * native DBCore for all AppDatabase tables. Browser and iOS PWA startup never enters this path.
 */
export async function initializeAndroidNativeAppDatabase(
  database: AppDatabase,
  onProgress?: (progress: AndroidNativeAppDatabaseStartupProgress) => void,
  native: typeof nativeAppDatabase = nativeAppDatabase,
): Promise<AndroidNativeAppDatabaseStartupResult> {
  if (!isCapacitorApp() || !canUseAndroidNativeDexieCore()) {
    return { native: false, migrated: false, copied: 0, total: 0 }
  }

  const activeRaw = await native.getState(ACTIVE_STATE_KEY)
  const active = parseActiveState(activeRaw)
  if (active === undefined && (await native.getState(RETRY_STATE_KEY)) === 'requested-v1')
    await resetIncompleteAndroidNativeAppDatabaseMigration(native)
  else if (activeRaw !== undefined && !active)
    throw new Error('原生数据库启用状态无法识别；为保护数据，已停止迁移')
  if (active?.mode === 'legacy') {
    await database.open()
    return { native: false, migrated: false, copied: 0, total: 0 }
  }
  if (active?.mode === 'rolling-back') {
    await rollbackAndroidNativeAppDatabase(database, undefined, native)
    return { native: false, migrated: false, copied: 0, total: 0 }
  }
  if (active) {
    activateAndroidNativeAppDatabase()
    if (!database.isOpen()) await database.open()
    const indexSchema = await ensureNativeIndexes(database, active, native)
    if (
      active.databaseVersion !== BUILD_INFO.databaseVersion ||
      active.indexSchema !== indexSchema
    ) {
      await native.putState(
        ACTIVE_STATE_KEY,
        JSON.stringify({ ...active, databaseVersion: BUILD_INFO.databaseVersion, indexSchema }),
      )
    }
    return { native: true, migrated: false, copied: 0, total: 0 }
  }

  // Open and finish the existing Dexie schema migrations while the native middleware remains
  // inactive. This creates the final source schema before we take the immutable migration snapshot.
  await database.open()
  const migrator = new AndroidAppDatabaseMigrator({ database, native, isQuiesced: () => true })
  const summary = await migrator.migrateAllStores(onProgress)
  const nativeStatus = await native.status()
  for (const table of database.tables) {
    if (!APP_DATABASE_STORES.includes(table.name as NativeAppDatabaseStore)) continue
    const sourceCount = await table.count()
    const nativeCount = nativeStatus.counts[table.name] ?? 0
    if (sourceCount !== nativeCount) {
      throw new Error(
        `原生数据库表 ${table.name} 最终计数核验失败（IndexedDB ${sourceCount}，SQLite ${nativeCount}）`,
      )
    }
  }

  await native.putState(INDEX_STATE_KEY, 'verified-v1')

  const nextState: ActiveState = {
    version: ACTIVE_STATE_VERSION,
    databaseVersion: BUILD_INFO.databaseVersion,
    activatedAt: Date.now(),
    indexSchema: await nativeIndexSchema(database),
  }
  await native.putState(ACTIVE_STATE_KEY, JSON.stringify(nextState))
  activateAndroidNativeAppDatabase()
  return {
    native: true,
    migrated: true,
    copied: summary.copied,
    total: summary.total,
  }
}

/**
 * Rebuilds the retained IndexedDB copy from verified native rows before disabling native storage.
 * Each record is written and re-read before the next one; a failed rollback leaves the active
 * marker in place so the app will keep using the native source and the operation can be retried.
 */
export async function rollbackAndroidNativeAppDatabase(
  database: AppDatabase,
  onProgress?: (progress: AndroidNativeAppDatabaseStartupProgress) => void,
  native: typeof nativeAppDatabase = nativeAppDatabase,
): Promise<void> {
  const active = parseActiveState(await native.getState(ACTIVE_STATE_KEY))
  if (!active || active.mode === 'legacy') throw new Error('当前没有可回退的 Android 原生主库')

  await native.putState(ACTIVE_STATE_KEY, JSON.stringify({ ...active, mode: 'rolling-back' }))
  database.close()
  deactivateAndroidNativeAppDatabase()
  try {
    await database.open()
    const status = await native.status()
    const stores = database.tables
      .map((table) => table.name)
      .filter((name): name is NativeAppDatabaseStore =>
        APP_DATABASE_STORES.includes(name as NativeAppDatabaseStore),
      )

    for (const store of stores) {
      const table = database.table(store)
      const expected = status.counts[store] ?? 0
      await table.clear()
      let afterKey: string | undefined
      let restored = 0
      while (true) {
        const page = await native.getRecords(store, afterKey, 100)
        for (const row of page.rows) {
          const key = decodeAppDatabaseKey(row.key)
          const value = await decodeAppDatabaseValue(row.value, store, row.key, native)
          await table.put(value as never)
          const actual = await table.get(key as never)
          if (actual === undefined) throw new Error(`回退核验失败：${store}/${row.key} 未写入`)
          const reencoded = await encodeAppDatabaseValue(actual, store, row.key, native)
          if (canonicalizeAppDatabaseValue(reencoded) !== canonicalizeAppDatabaseValue(row.value)) {
            throw new Error(`回退核验失败：${store}/${row.key} 内容不一致`)
          }
          restored += 1
          onProgress?.({ store, copied: restored, total: expected, status: 'copying' })
        }
        if (!page.nextKey) break
        afterKey = page.nextKey
      }
      const actualCount = await table.count()
      if (actualCount !== expected || restored !== expected) {
        throw new Error(`回退核验失败：${store} 原生 ${expected} 条，IndexedDB ${actualCount} 条`)
      }
      onProgress?.({ store, copied: restored, total: expected, status: 'verified' })
    }

    await native.putState(
      ACTIVE_STATE_KEY,
      JSON.stringify({
        version: ACTIVE_STATE_VERSION,
        databaseVersion: BUILD_INFO.databaseVersion,
        activatedAt: active.activatedAt,
        mode: 'legacy',
      } satisfies ActiveState),
    )
  } catch (error) {
    await native.putState(ACTIVE_STATE_KEY, JSON.stringify({ ...active, mode: 'active' }))
    database.close()
    activateAndroidNativeAppDatabase()
    await database.open()
    throw error
  }
}

export interface RetainedIndexedDbCopy {
  records: number
  counts: Record<string, number>
}

async function openRetainedIndexedDb(name: string): Promise<Dexie> {
  const retained = await openRetainedIndexedDbIfPresent(name)
  if (!retained) throw new Error('未找到保留的 IndexedDB 副本')
  return retained
}

export async function openRetainedIndexedDbIfPresent(name: string): Promise<Dexie | undefined> {
  // A separate plain connection never switches the live application's native backend.
  // Keep the existing schema/connection; deleting the database would block live connections.
  if (!(await Dexie.exists(name))) return undefined
  const retained = new Dexie(name)
  await retained.open()
  return retained
}

export async function getRetainedIndexedDbCopy(name: string): Promise<RetainedIndexedDbCopy> {
  const retained = await openRetainedIndexedDb(name)
  try {
    const counts: Record<string, number> = {}
    for (const table of retained.tables) {
      if (APP_DATABASE_STORES.includes(table.name as NativeAppDatabaseStore))
        counts[table.name] = await table.count()
    }
    return { counts, records: Object.values(counts).reduce((sum, count) => sum + count, 0) }
  } finally {
    retained.close()
  }
}

/** A locked source snapshot; each visitor runs outside its source transaction. */
export interface RetainedIndexedDbRecoverySource {
  databaseName: string
  stores: Array<{ name: NativeAppDatabaseStore; count: number; keyPath: string | string[] }>
  readRecords(
    visit: (row: { store: NativeAppDatabaseStore; key: string; value: unknown }) => Promise<void>,
  ): Promise<void>
}

/** Release old copies after proving they were migrated or durably archiving their complete contents. */
export async function clearRetainedIndexedDbCopy(
  name: string,
  plan: RetainedIndexedDbCopy,
  onProgress?: (store: NativeAppDatabaseStore) => void,
  native: typeof nativeAppDatabase = nativeAppDatabase,
  preserveCopy?: (source: RetainedIndexedDbRecoverySource) => Promise<void>,
): Promise<void> {
  const activeRaw = await native.getState(ACTIVE_STATE_KEY)
  const active = parseActiveState(activeRaw)
  if (
    !active ||
    (active.mode !== undefined && active.mode !== 'active') ||
    (await native.getState(INDEX_STATE_KEY)) !== 'verified-v1'
  )
    throw new Error('原生主库尚未完成迁移和索引校验；保留旧副本')
  const retained = await openRetainedIndexedDb(name)
  try {
    const tables = retained.tables.filter((table) =>
      APP_DATABASE_STORES.includes(table.name as NativeAppDatabaseStore),
    )
    if (
      tables.length !== Object.keys(plan.counts).length ||
      tables.reduce((sum, table) => sum + (plan.counts[table.name] ?? 0), 0) !== plan.records
    )
      throw new Error('旧副本清理范围已变化，请重新确认')
    const sourceDigests = new Map<string, string>()
    for (const table of tables) {
      const store = table.name as NativeAppDatabaseStore
      const raw = await native.getState(`migration:appdb:v1:${store}`)
      try {
        const receipt = raw ? JSON.parse(raw) : undefined
        if (
          receipt?.version === 1 &&
          receipt.status === 'verified' &&
          receipt.sourceCount === plan.counts[store] &&
          receipt.copiedCount === receipt.sourceCount &&
          typeof receipt.sourceDigest === 'string' &&
          /^[a-f0-9]{64}$/.test(receipt.sourceDigest)
        )
          sourceDigests.set(store, receipt.sourceDigest)
      } catch {
        /* An old or damaged receipt requires an archive, never deletion based on a guess. */
      }
      onProgress?.(store)
      await native.verifyStore(store)
    }
    if (
      (await native.getState(ACTIVE_STATE_KEY)) !== activeRaw ||
      (await native.getState(INDEX_STATE_KEY)) !== 'verified-v1'
    )
      throw new Error('原生主库状态已变化；停止清理')
    await retained.transaction('rw', tables, async (transaction) => {
      for (const table of tables)
        if ((await table.count()) !== plan.counts[table.name])
          throw new Error('旧副本已变化，请重新确认')
      let needsRecovery = tables.some(
        (table) => plan.counts[table.name] && !sourceDigests.has(table.name),
      )
      if (!needsRecovery) {
        for (const table of tables) {
          if (!plan.counts[table.name]) continue
          const expected = sourceDigests.get(table.name)!
          const fingerprint = await fingerprintAppDatabaseStore(
            retained,
            table.name as NativeAppDatabaseStore,
            {
              native,
              keepTransactionAlive: true,
            },
          )
          if (fingerprint.digest !== expected) {
            needsRecovery = true
            break
          }
        }
      }
      if (needsRecovery) {
        if (!preserveCopy) throw new Error('旧副本需要先保存恢复档，尚未清理；原生主库不受影响')
        // Old records can depend on settings, keys, or other tables. Preserve the whole
        // remaining snapshot, not a changed table without its recovery dependencies.
        const archiveTables = tables
          .filter((table) => plan.counts[table.name])
          .map((table) => transaction.table(table.name))
        const source: RetainedIndexedDbRecoverySource = {
          databaseName: name,
          stores: archiveTables.map((table) => ({
            name: table.name as NativeAppDatabaseStore,
            count: plan.counts[table.name]!,
            keyPath: table.schema.primKey.keyPath!,
          })),
          async readRecords(visit) {
            // Resume each query in the source transaction's active IDB event. An async
            // iterator consumed outside this scope stays alive but becomes inactive after
            // external Blob/hash work in Chromium. Wait only for the external visitor.
            for (const table of archiveTables) {
              let after: IDBValidKey | undefined
              while (true) {
                const batch: unknown[] = await (
                  after === undefined ? table.orderBy(':id') : table.where(':id').above(after)
                )
                  .limit(100)
                  .toArray()
                if (!batch.length) break
                for (const value of batch) {
                  after = getAppDatabasePrimaryKey(value, table.schema.primKey.keyPath!)
                  const row = {
                    store: table.name as NativeAppDatabaseStore,
                    key: encodeAppDatabaseKey(after),
                    value,
                  }
                  await Dexie.waitFor(() => visit(row), Infinity)
                }
              }
            }
          },
        }
        await preserveCopy(source)
      }
      const stillActive = await Dexie.waitFor(
        Promise.all([native.getState(ACTIVE_STATE_KEY), native.getState(INDEX_STATE_KEY)]),
      )
      if (stillActive[0] !== activeRaw || stillActive[1] !== 'verified-v1')
        throw new Error('原生主库状态已变化；停止清理')
      for (const table of tables) await table.clear()
    })
  } finally {
    retained.close()
  }
}
