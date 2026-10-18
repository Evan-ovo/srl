import { Capacitor } from '@capacitor/core'

import type { CloudBackupConfig, CloudBackupItem, CloudBackupProvider } from '../types/CloudBackup'
import { nativeAppDatabase } from '../storage/NativeAppDatabaseBridge'
import type { BackupScopeId } from './BackupScopeRegistry'

const DATABASE_NAME = 'srl-cloud-jobs-v3'
const DATABASE_VERSION = 4
const NATIVE_MIGRATION_KEY = 'migration:cloud-backup-jobs:v1'

type NativeJobDatabase = Pick<
  typeof nativeAppDatabase,
  | 'status'
  | 'getState'
  | 'putState'
  | 'getRecord'
  | 'getRecords'
  | 'getRecordsByKeys'
  | 'putRecords'
  | 'deleteRecords'
>

export interface NativeCloudRestoreRecovery {
  item: CloudBackupItem
  target: CloudBackupConfig
  resourceKeys: string[]
  includeGallery: boolean
  portableScopeIds?: BackupScopeId[]
}

export type CloudBackupObjectJobState = 'pending' | 'verified' | 'failed'

export interface CloudBackupJobRecord {
  id: string
  provider: CloudBackupProvider
  planHash: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  objects: Record<string, CloudBackupObjectJobState>
  manifestName?: string
  error?: string
  updatedAt: number
  kind?: 'restore'
  restore?: NativeCloudRestoreRecovery
}

interface CloudBackupObjectStateRecord {
  jobId: string
  objectName: string
  state: CloudBackupObjectJobState
  updatedAt: number
}
function applyObjectState(record: CloudBackupJobRecord, entry: CloudBackupObjectStateRecord): void {
  record.objects[entry.objectName] = entry.state
  if (entry.state === 'failed') record.status = 'failed'
  record.updatedAt = Math.max(record.updatedAt, entry.updatedAt)
}

interface CloudBackupOrphanRecord {
  id: string
  scope: string
  identity: string
  firstSeenAt: number
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('浏览器云备份任务数据库操作失败'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('浏览器云备份任务事务已中止'))
    transaction.onerror = () => reject(transaction.error ?? new Error('浏览器云备份任务事务失败'))
  })
}

export class CloudBackupJobStore {
  private database?: Promise<IDBDatabase>
  private nativeReady?: Promise<NativeJobDatabase | undefined>
  private readonly nativeOverride?: NativeJobDatabase
  private readonly androidOverride?: boolean

  constructor(options?: { nativeDatabase?: NativeJobDatabase; isAndroid?: boolean }) {
    this.nativeOverride = options?.nativeDatabase
    this.androidOverride = options?.isAndroid
  }

  private nativePlatformAvailable(): boolean {
    if (this.androidOverride !== undefined) return this.androidOverride
    return (
      Capacitor.isNativePlatform() &&
      Capacitor.getPlatform() === 'android' &&
      Capacitor.isPluginAvailable('NativeAppDatabase')
    )
  }

  private getNative(): Promise<NativeJobDatabase | undefined> {
    if (!this.nativePlatformAvailable()) return Promise.resolve(undefined)
    if (this.nativeReady) return this.nativeReady
    const native = this.nativeOverride ?? nativeAppDatabase
    this.nativeReady = this.migrateToNative(native).catch((error) => {
      this.nativeReady = undefined
      throw error
    })
    return this.nativeReady
  }

  private async migrateToNative(native: NativeJobDatabase): Promise<NativeJobDatabase> {
    const marker = await native.getState(NATIVE_MIGRATION_KEY)
    if (marker === 'verified-v1') return native

    const database = await this.open()
    const source = database.transaction(['jobs', 'orphans', 'objectStates'], 'readonly')
    const jobsRequest = source.objectStore('jobs').getAll()
    const orphansRequest = source.objectStore('orphans').getAll()
    const statesRequest = source.objectStore('objectStates').getAll()
    const [sourceJobs, sourceOrphans, objectStates] = (await Promise.all([
      requestResult(jobsRequest),
      requestResult(orphansRequest),
      requestResult(statesRequest),
    ])) as [CloudBackupJobRecord[], CloudBackupOrphanRecord[], CloudBackupObjectStateRecord[]]
    await transactionDone(source)
    const jobsById = new Map(sourceJobs.map((job) => [job.id, job]))
    for (const entry of objectStates) {
      const job = jobsById.get(entry.jobId)
      if (job) applyObjectState(job, entry)
    }
    await this.copyAndVerifyNativeStore(native, 'cloudBackupJobs', sourceJobs)
    await this.copyAndVerifyNativeStore(native, 'cloudBackupOrphans', sourceOrphans)
    await native.putState(NATIVE_MIGRATION_KEY, 'verified-v1')
    return native
  }

  private async copyAndVerifyNativeStore(
    native: NativeJobDatabase,
    store: 'cloudBackupJobs' | 'cloudBackupOrphans',
    records: Array<{ id: string }>,
  ): Promise<void> {
    for (let offset = 0; offset < records.length; offset += 100) {
      const rows = records.slice(offset, offset + 100).map((record) => ({
        key: JSON.stringify(record.id),
        value: record as unknown as Record<string, unknown>,
      }))
      await native.putRecords(store, rows)
      const saved = await native.getRecordsByKeys(
        store,
        rows.map((row) => row.key),
      )
      const savedByKey = new Map(saved.map((row) => [row.key, row.value]))
      for (const row of rows) {
        if (JSON.stringify(savedByKey.get(row.key)) !== JSON.stringify(row.value)) {
          throw new Error(`Android 云备份任务迁移读回校验失败：${store}`)
        }
      }
    }
    const status = await native.status()
    if ((status.counts[store] ?? 0) !== records.length) {
      throw new Error(`Android 云备份任务迁移记录数校验失败：${store}`)
    }
  }

  private async nativeRecords<T extends { id: string }>(
    native: NativeJobDatabase,
    store: 'cloudBackupJobs' | 'cloudBackupOrphans',
  ): Promise<T[]> {
    const result: T[] = []
    let afterKey: string | undefined
    while (true) {
      const page = await native.getRecords(store, afterKey, 250)
      result.push(...(page.rows.map((row) => row.value) as T[]))
      if (!page.nextKey) return result
      afterKey = page.nextKey
    }
  }

  private async mirrorNativeMutation(
    storeName: 'jobs' | 'orphans',
    mutation: (store: IDBObjectStore) => void,
  ): Promise<void> {
    const database = await this.open()
    const transaction = database.transaction(storeName, 'readwrite')
    mutation(transaction.objectStore(storeName))
    await transactionDone(transaction)
  }

  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database
    const pending: Promise<IDBDatabase> = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
      let abandoned = false
      request.onblocked = () => {
        abandoned = true
        reject(new Error('云备份任务数据库升级被旧页面占用，请关闭其他资源库页面后重试'))
      }
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('objectStates')) {
          const states = request.result.createObjectStore('objectStates', { keyPath: 'id' })
          states.createIndex('jobId', 'jobId')
        }
        if (!request.result.objectStoreNames.contains('jobs')) {
          request.result.createObjectStore('jobs', { keyPath: 'id' })
        }
        const jobs = request.transaction!.objectStore('jobs')
        if (!jobs.indexNames.contains('kind-status'))
          jobs.createIndex('kind-status', ['kind', 'status'])
        if (!request.result.objectStoreNames.contains('orphans')) {
          request.result.createObjectStore('orphans', { keyPath: 'id' })
        }
      }
      request.onsuccess = () => {
        const database = request.result
        // A blocked request may finish after its caller has already received the error.
        if (abandoned) {
          database.close()
          return
        }
        database.onversionchange = () => {
          database.close()
          if (this.database === pending) this.database = undefined
        }
        resolve(database)
      }
      request.onerror = () => reject(request.error ?? new Error('无法打开浏览器云备份任务数据库'))
    }).catch((error) => {
      if (this.database === pending) this.database = undefined
      throw error
    })
    this.database = pending
    return pending
  }

  private id(provider: CloudBackupProvider, planHash: string): string {
    return `${provider}:${planHash}`
  }

  async beginRestore(
    planHash: string,
    restore: NativeCloudRestoreRecovery,
  ): Promise<CloudBackupJobRecord> {
    const record: CloudBackupJobRecord = {
      id: `${restore.target.provider}:restore:${planHash}`,
      provider: restore.target.provider,
      planHash,
      kind: 'restore',
      status: 'running',
      objects: {},
      // UI selections may contain Vue proxies; persist an independent JSON snapshot.
      restore: JSON.parse(JSON.stringify(restore)) as NativeCloudRestoreRecovery,
      updatedAt: Date.now(),
    }
    await this.put(record)
    return record
  }

  async pendingRestores(): Promise<CloudBackupJobRecord[]> {
    const native = await this.getNative()
    if (native) {
      return (await this.nativeRecords<CloudBackupJobRecord>(native, 'cloudBackupJobs'))
        .filter(
          (record) => record.kind === 'restore' && ['running', 'failed'].includes(record.status),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)
    }
    const database = await this.open()
    const index = database.transaction('jobs', 'readonly').objectStore('jobs').index('kind-status')
    const [running, failed] = await Promise.all([
      requestResult(index.getAll(['restore', 'running'])),
      requestResult(index.getAll(['restore', 'failed'])),
    ])
    return (running.concat(failed) as CloudBackupJobRecord[]).sort(
      (a, b) => b.updatedAt - a.updatedAt,
    )
  }

  async begin(
    provider: CloudBackupProvider,
    planHash: string,
    objectNames: Iterable<string>,
    verifiedNames?: Iterable<string>,
  ): Promise<CloudBackupJobRecord> {
    const id = this.id(provider, planHash)
    const existing = verifiedNames === undefined ? await this.read(provider, planHash) : undefined
    const objects = Object.fromEntries([...objectNames].map((name) => [name, 'pending'])) as Record<
      string,
      CloudBackupObjectJobState
    >
    for (const [name, state] of Object.entries(existing?.objects ?? {})) {
      if (name in objects && state === 'verified') objects[name] = state
    }
    for (const name of verifiedNames ?? []) {
      if (name in objects) objects[name] = 'verified'
    }
    const record: CloudBackupJobRecord = {
      id,
      provider,
      planHash,
      status: 'running',
      objects,
      updatedAt: Date.now(),
    }
    await this.put(record)
    return record
  }

  async markObject(
    job: CloudBackupJobRecord,
    objectName: string,
    state: CloudBackupObjectJobState,
  ): Promise<void> {
    job.objects[objectName] = state
    job.status = state === 'failed' ? 'failed' : 'running'
    job.updatedAt = Date.now()
    if (await this.getNative()) {
      await this.put(job)
    } else {
      const database = await this.open()
      const transaction = database.transaction('objectStates', 'readwrite')
      transaction.objectStore('objectStates').put({
        id: `${job.id}\0${objectName}`,
        jobId: job.id,
        objectName,
        state,
        updatedAt: job.updatedAt,
      })
      await transactionDone(transaction)
    }
  }

  async complete(job: CloudBackupJobRecord, manifestName: string): Promise<void> {
    job.status = 'completed'
    job.manifestName = manifestName
    job.error = undefined
    job.updatedAt = Date.now()
    await this.put(job)
  }

  async cancel(job: CloudBackupJobRecord): Promise<void> {
    job.status = 'cancelled'
    job.error = undefined
    job.updatedAt = Date.now()
    await this.put(job)
  }

  async fail(job: CloudBackupJobRecord, error: unknown): Promise<void> {
    job.status = 'failed'
    job.error = error instanceof Error ? error.message : String(error)
    job.updatedAt = Date.now()
    await this.put(job)
  }

  async read(
    provider: CloudBackupProvider,
    planHash: string,
  ): Promise<CloudBackupJobRecord | undefined> {
    const id = this.id(provider, planHash)
    const native = await this.getNative()
    if (native) {
      return (await native.getRecord('cloudBackupJobs', JSON.stringify(id))) as
        CloudBackupJobRecord | undefined
    }
    const database = await this.open()
    const transaction = database.transaction(['jobs', 'objectStates'], 'readonly')
    const [record, states] = await Promise.all([
      requestResult(transaction.objectStore('jobs').get(id)) as Promise<
        CloudBackupJobRecord | undefined
      >,
      requestResult(transaction.objectStore('objectStates').index('jobId').getAll(id)) as Promise<
        CloudBackupObjectStateRecord[]
      >,
    ])
    if (record) {
      for (const entry of states) {
        applyObjectState(record, entry)
      }
    }
    return record
  }

  async eligibleOrphans(
    scope: string,
    identities: Iterable<string>,
    now: number,
    graceMs: number,
  ): Promise<string[]> {
    const native = await this.getNative()
    if (native) {
      const existing = await this.nativeRecords<CloudBackupOrphanRecord>(
        native,
        'cloudBackupOrphans',
      )
      const candidates = new Set(identities)
      const byIdentity = new Map(
        existing
          .filter((record) => record.scope === scope)
          .map((record) => [record.identity, record]),
      )
      const stale = existing.filter(
        (record) => record.scope === scope && !candidates.has(record.identity),
      )
      if (stale.length) {
        await native.deleteRecords(
          'cloudBackupOrphans',
          stale.map((record) => JSON.stringify(record.id)),
        )
        await this.mirrorNativeMutation('orphans', (store) =>
          stale.forEach((record) => store.delete(record.id)),
        )
      }
      const eligible: string[] = []
      const added: CloudBackupOrphanRecord[] = []
      for (const identity of candidates) {
        const record = byIdentity.get(identity)
        if (!record) {
          added.push({ id: `${scope}\u0000${identity}`, scope, identity, firstSeenAt: now })
        } else if (record.firstSeenAt <= now - graceMs) {
          eligible.push(identity)
        }
      }
      if (added.length) {
        await native.putRecords(
          'cloudBackupOrphans',
          added.map((record) => ({
            key: JSON.stringify(record.id),
            value: record as unknown as Record<string, unknown>,
          })),
        )
        await this.mirrorNativeMutation('orphans', (store) =>
          added.forEach((record) => store.put(record)),
        )
      }
      return eligible
    }
    const database = await this.open()
    const transaction = database.transaction('orphans', 'readwrite')
    const store = transaction.objectStore('orphans')
    const existing = (await requestResult(store.getAll())) as CloudBackupOrphanRecord[]
    const candidates = new Set(identities)
    const byIdentity = new Map(
      existing
        .filter((record) => record.scope === scope)
        .map((record) => [record.identity, record]),
    )
    for (const record of existing) {
      if (record.scope === scope && !candidates.has(record.identity)) store.delete(record.id)
    }
    const eligible: string[] = []
    for (const identity of candidates) {
      const record = byIdentity.get(identity)
      if (!record) {
        store.put({
          id: `${scope}\u0000${identity}`,
          scope,
          identity,
          firstSeenAt: now,
        } satisfies CloudBackupOrphanRecord)
      } else if (record.firstSeenAt <= now - graceMs) {
        eligible.push(identity)
      }
    }
    await transactionDone(transaction)
    return eligible
  }

  async clearOrphan(scope: string, identity: string): Promise<void> {
    const id = `${scope}\u0000${identity}`
    const native = await this.getNative()
    if (native) {
      await native.deleteRecords('cloudBackupOrphans', [JSON.stringify(id)])
      await this.mirrorNativeMutation('orphans', (store) => store.delete(id))
      return
    }
    const database = await this.open()
    const transaction = database.transaction('orphans', 'readwrite')
    transaction.objectStore('orphans').delete(`${scope}\u0000${identity}`)
    await transactionDone(transaction)
  }

  /** Pending candidates are rechecked against retained manifests before any later deletion. */
  async pendingOrphans(scope: string): Promise<string[]> {
    const native = await this.getNative()
    if (native) {
      return (await this.nativeRecords<CloudBackupOrphanRecord>(native, 'cloudBackupOrphans'))
        .filter((record) => record.scope === scope)
        .map((record) => record.identity)
    }
    const database = await this.open()
    const records = (await requestResult(
      database.transaction('orphans', 'readonly').objectStore('orphans').getAll(),
    )) as CloudBackupOrphanRecord[]
    return records.filter((record) => record.scope === scope).map((record) => record.identity)
  }

  private async put(record: CloudBackupJobRecord): Promise<void> {
    const native = await this.getNative()
    if (native) {
      const key = JSON.stringify(record.id)
      await native.putRecords('cloudBackupJobs', [
        { key, value: record as unknown as Record<string, unknown> },
      ])
      const [saved] = await native.getRecordsByKeys('cloudBackupJobs', [key])
      if (JSON.stringify(saved?.value) !== JSON.stringify(record)) {
        throw new Error('Android 云备份任务写入读回校验失败')
      }
      await this.mirrorNativeMutation('jobs', (store) => store.put(record))
      return
    }
    const database = await this.open()
    const transaction = database.transaction(['jobs', 'objectStates'], 'readwrite')
    transaction.objectStore('jobs').put(record)
    const states = transaction.objectStore('objectStates')
    const ids = await requestResult(states.index('jobId').getAllKeys(record.id))
    for (const id of ids) states.delete(id)
    await transactionDone(transaction)
  }
}
