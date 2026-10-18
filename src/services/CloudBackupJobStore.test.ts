import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

import { CloudBackupJobStore } from './CloudBackupJobStore'

describe('CloudBackupJobStore orphan grace', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory())
  })

  it('rejects a blocked schema upgrade and permits retry after the old page closes', async () => {
    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('srl-cloud-jobs-v3', 3)
      request.onupgradeneeded = () => {
        request.result.createObjectStore('jobs', { keyPath: 'id' })
        request.result.createObjectStore('orphans', { keyPath: 'id' })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const oldJob = {
      id: 'github:old-plan',
      provider: 'github',
      planHash: 'old-plan',
      status: 'completed',
      objects: { original: 'verified' },
      manifestName: 'old-manifest',
      updatedAt: 1,
    }
    await new Promise<void>((resolve, reject) => {
      const transaction = legacy.transaction('jobs', 'readwrite')
      transaction.objectStore('jobs').put(oldJob)
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error)
    })
    let blocked = false
    const open = indexedDB.open.bind(indexedDB)
    vi.spyOn(indexedDB, 'open').mockImplementation((name, version) => {
      const request = open(name, version)
      request.addEventListener('blocked', () => (blocked = true))
      return request
    })
    const store = new CloudBackupJobStore({ isAndroid: false })
    let failure: unknown
    let settled = false
    const operation = store.begin('github', 'new-plan', ['new-object']).then(
      () => (settled = true),
      (error) => {
        failure = error
        settled = true
      },
    )
    try {
      await vi.waitFor(() => expect(blocked).toBe(true))
      expect(settled).toBe(true)
      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toContain('关闭其他资源库页面')
    } finally {
      legacy.close()
      await operation
    }
    await expect(store.begin('github', 'new-plan', ['new-object'])).resolves.toMatchObject({
      status: 'running',
      objects: { 'new-object': 'pending' },
    })
    expect(await store.read('github', 'old-plan')).toEqual(oldJob)
  })

  it('releases its connection when a newer page requests a schema upgrade', async () => {
    const open = vi.spyOn(indexedDB, 'open')
    const store = new CloudBackupJobStore({ isAndroid: false })
    await store.begin('github', 'existing', ['object'])
    const connection = (open.mock.results[0]!.value as IDBOpenDBRequest).result
    let blocked = false
    let upgraded: IDBDatabase | undefined
    const request = indexedDB.open('srl-cloud-jobs-v3', 5)
    request.onblocked = () => (blocked = true)
    const operation = new Promise<void>((resolve, reject) => {
      request.onsuccess = () => {
        upgraded = request.result
        resolve()
      }
      request.onerror = () => reject(request.error)
    })
    try {
      await vi.waitFor(() => expect(blocked || upgraded !== undefined).toBe(true))
      expect(blocked).toBe(false)
    } finally {
      connection.close()
      await operation
      upgraded?.close()
    }
  })

  it('seals an explicitly cancelled restore across reopening until a new explicit begin', async () => {
    const store = new CloudBackupJobStore({ isAndroid: false })
    const selection = {
      item: { id: 'snapshot', objectKey: 'snapshot.json', size: 1, createdAt: 1 },
      target: {
        provider: 'github' as const,
        owner: 'owner',
        repository: 'repo',
        retention: 1,
        autoBackup: false,
      },
      resourceKeys: ['chosen'],
      includeGallery: false,
    }
    const job = await store.beginRestore('cancel-plan', selection)
    await store.cancel(job)
    const reopened = new CloudBackupJobStore({ isAndroid: false })
    expect(await reopened.pendingRestores()).toEqual([])
    expect(await reopened.read('github', 'restore:cancel-plan')).toMatchObject({
      status: 'cancelled',
    })
    await reopened.beginRestore('cancel-plan', selection)
    expect(await reopened.pendingRestores()).toHaveLength(1)
  })

  it('starts grace when an object first becomes orphan and forgets it when referenced again', async () => {
    const store = new CloudBackupJobStore()
    const day = 24 * 60 * 60 * 1000

    await expect(store.eligibleOrphans('scope', ['object-a'], 1_000, day)).resolves.toEqual([])
    await expect(
      store.eligibleOrphans('scope', ['object-a'], 1_000 + day - 1, day),
    ).resolves.toEqual([])
    await expect(store.eligibleOrphans('scope', ['object-a'], 1_000 + day, day)).resolves.toEqual([
      'object-a',
    ])

    await store.eligibleOrphans('scope', [], 1_000 + day + 1, day)
    await expect(
      store.eligibleOrphans('scope', ['object-a'], 1_000 + day + 2, day),
    ).resolves.toEqual([])
  })

  it('retains the selected restore scope across reopening until metadata import completes', async () => {
    const store = new CloudBackupJobStore()
    const selection = reactive({
      item: {
        id: 'snapshot',
        objectKey: 'snapshot.json.gz',
        size: 1,
        createdAt: 1,
        kind: 'githubSnapshot' as const,
      },
      target: {
        provider: 'github' as const,
        owner: 'owner',
        repository: 'private-backups',
        retention: 1,
        autoBackup: false,
      },
      resourceKeys: ['chosen'],
      includeGallery: false,
    })
    const job = await store.beginRestore('plan', selection)
    selection.resourceKeys.push('later-selection')
    await store.fail(job, new Error('WebView interrupted'))
    const reopened = new CloudBackupJobStore()
    expect(await reopened.pendingRestores()).toEqual([
      expect.objectContaining({
        status: 'failed',
        restore: expect.objectContaining({ resourceKeys: ['chosen'], includeGallery: false }),
      }),
    ])
    await reopened.complete(job, 'snapshot.json.gz')
    expect(await reopened.pendingRestores()).toEqual([])
  })

  it('migrates Android jobs and orphan state into native storage, verifies them, and keeps a live rollback mirror', async () => {
    const records = new Map<string, Map<string, Record<string, unknown>>>()
    const states = new Map<string, string>()
    const native = {
      async status() {
        return {
          schemaVersion: 2,
          counts: Object.fromEntries([...records].map(([name, values]) => [name, values.size])),
        }
      },
      async getState(key: string) {
        return states.get(key)
      },
      async putState(key: string, value: string) {
        states.set(key, value)
      },
      async getRecord(name: string, key: string) {
        return records.get(name)?.get(key)
      },
      async getRecords(name: string, afterKey: string | undefined, limit: number) {
        const rows = [...(records.get(name) ?? new Map())]
          .filter(([key]) => afterKey === undefined || key > afterKey)
          .sort(([left], [right]) => left.localeCompare(right))
          .slice(0, limit)
          .map(([key, value]) => ({ key, value }))
        return {
          rows,
          count: records.get(name)?.size ?? 0,
          nextKey: rows.length === limit ? rows.at(-1)?.key : undefined,
        }
      },
      async getRecordsByKeys(name: string, keys: string[]) {
        return keys.flatMap((key) => {
          const value = records.get(name)?.get(key)
          return value ? [{ key, value }] : []
        })
      },
      async putRecords(name: string, rows: Array<{ key: string; value: Record<string, unknown> }>) {
        const table = records.get(name) ?? new Map<string, Record<string, unknown>>()
        for (const row of rows) table.set(row.key, structuredClone(row.value))
        records.set(name, table)
        return rows.length
      },
      async deleteRecords(name: string, keys: string[]) {
        const table = records.get(name)
        let deleted = 0
        for (const key of keys) if (table?.delete(key)) deleted++
        return deleted
      },
    }

    const legacy = new CloudBackupJobStore({ isAndroid: false })
    const upload = await legacy.begin('github', 'checkpoint-plan', ['content'])
    await legacy.markObject(upload, 'content', 'verified')
    const restore = {
      item: { id: 'snapshot', objectKey: 'snapshot.json', size: 3, createdAt: 1 },
      target: {
        provider: 'github' as const,
        owner: 'owner',
        repository: 'repo',
        retention: 1,
        autoBackup: false,
      },
      resourceKeys: ['resource-1'],
      includeGallery: false,
    }
    const savedRestore = await legacy.beginRestore('restore-plan', restore)
    await legacy.fail(savedRestore, new Error('resume me'))
    await legacy.eligibleOrphans('scope', ['asset-1'], 100, 10)

    const android = new CloudBackupJobStore({ nativeDatabase: native, isAndroid: true })
    await expect(android.pendingRestores()).resolves.toEqual([
      expect.objectContaining({
        id: savedRestore.id,
        status: 'failed',
        restore: expect.objectContaining({ resourceKeys: ['resource-1'] }),
      }),
    ])
    await expect(android.pendingOrphans('scope')).resolves.toEqual(['asset-1'])
    expect(states.get('migration:cloud-backup-jobs:v1')).toBe('verified-v1')
    expect((await android.read('github', 'checkpoint-plan'))?.objects.content).toBe('verified')

    await android.begin('github', 'next-plan', ['file.json'])
    await expect(legacy.read('github', 'next-plan')).resolves.toMatchObject({
      status: 'running',
      objects: { 'file.json': 'pending' },
    })
    expect(records.get('cloudBackupJobs')?.has(JSON.stringify('github:next-plan'))).toBe(true)
  })
})

describe('cloud object checkpoint scaling', () => {
  it('initializes 10,000 verified objects once and persists only small changed-object deltas', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    const store = new CloudBackupJobStore({ isAndroid: false })
    const names = Array.from({ length: 10_000 }, (_, index) => `object-${index}`)
    const job = await store.begin('github', 'large-plan', names, names.slice(0, -2))
    await store.markObject(job, names.at(-2)!, 'verified')
    await store.markObject(job, names.at(-1)!, 'failed')
    const reopened = new CloudBackupJobStore({ isAndroid: false })
    const saved = await reopened.read('github', 'large-plan')
    expect(saved?.objects[names.at(-2)!]).toBe('verified')
    expect(saved?.objects[names.at(-1)!]).toBe('failed')
    expect(Object.values(saved!.objects).filter((state) => state === 'verified')).toHaveLength(
      9_999,
    )
    const database = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open('srl-cloud-jobs-v3')
      request.onsuccess = () => resolve(request.result)
    })
    const entries = await new Promise<Array<Record<string, unknown>>>((resolve) => {
      const request = database.transaction('objectStates').objectStore('objectStates').getAll()
      request.onsuccess = () => resolve(request.result)
    })
    expect(entries).toHaveLength(2)
    expect(JSON.stringify(entries).length).toBeLessThan(500)
    await store.markObject(job, names.at(-1)!, 'verified')
    await store.complete(job, 'manifest')
    expect((await reopened.read('github', 'large-plan'))?.status).toBe('completed')
    // Fresh remote inventory is authoritative if an object was removed after a past success.
    const rebuilt = await reopened.begin('github', 'large-plan', names, names.slice(0, -1))
    expect(rebuilt.objects[names.at(-1)!]).toBe('pending')
    database.close()
  })
})
