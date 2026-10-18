/** @vitest-environment node */
import { Capacitor } from '@capacitor/core'
import { describe, expect, it, vi } from 'vitest'
import { nativeFileSource, rememberNativeFile } from '../core/NativeFileSource'
import type { ArchiveStorageAdapter } from '../storage/ArchiveStorageAdapter'
import type { RestoreStagingStore } from '../storage/RestoreStagingStore'
import type { PreparedRestore } from '../types/Backup'
import type { Resource } from '../types/Resource'
import type { RestoreStagingEntry } from '../types/RestoreStaging'
import { RestoreService } from './RestoreService'
import type { StructuredResource, StructuredSnapshot } from './CloudStructuredSnapshot'

async function resource(id: string, mimeType = 'application/json'): Promise<Resource> {
  const originalBlob = new Blob([JSON.stringify({ id, value: 'fixture-' + id })], {
    type: mimeType,
  })
  const contentHash = [
    ...new Uint8Array(await crypto.subtle.digest('SHA-256', await originalBlob.arrayBuffer())),
  ]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
  return {
    id,
    type: 'other',
    name: id,
    description: '',
    fileName: id + '.json',
    mimeType,
    fileSize: originalBlob.size,
    contentHash,
    originalBlob,
    metadata: { nested: { preserved: id } },
    tags: ['fixture'],
    favorite: false,
    categoryId: null,
    createdAt: 1,
    updatedAt: 2,
  }
}
function plan(resources: Resource[], versions: Resource[]): PreparedRestore {
  return {
    resources,
    versions,
    categories: [],
    staging: {
      jobId: 'fixture-job',
      paths: [...resources, ...versions].map((row) => [row.contentHash, row.id]),
    },
    preview: {
      fileName: 'fixture.zip',
      mode: 'full',
      createdAt: '2026-10-16T00:00:00.000Z',
      archiveResourceCount: resources.length,
      resourcesToAdd: resources.length,
      duplicatesToSkip: 0,
      conflictsToPreserve: 0,
      categoriesToCreate: 0,
      categoriesToReuse: 0,
    },
  }
}
function fixture(prepared: PreparedRestore) {
  const entries = new Map<string, RestoreStagingEntry>(
    [...prepared.resources, ...prepared.versions].map((row) => [
      row.id,
      {
        jobId: 'fixture-job',
        path: row.id,
        blob: row.originalBlob,
        size: row.fileSize,
        sha256: row.contentHash,
        updatedAt: 1,
      },
    ]),
  )
  const get = vi.fn(async (_jobId: string, path: string) => entries.get(path)),
    deleteJob = vi.fn(async () => undefined)
  const staging: RestoreStagingStore = {
    get,
    deleteJob,
    putChunk: async () => undefined,
    complete: async () => undefined,
    getMetadata: async (_jobId, path) => entries.get(path),
  }
  const committed: Resource[] = []
  const storage: ArchiveStorageAdapter = {
    replace: async () => undefined,
    restore: async (_categories, resources, versions = [], hydrate = async (row) => row) => {
      const next: Resource[] = []
      for (const row of [...resources, ...versions]) next.push(await hydrate(row))
      committed.push(...next)
    },
  }
  return { service: new RestoreService(storage, staging), committed, entries, get, deleteJob }
}
async function countEmpty<T>(action: () => Promise<T> | T) {
  const NativeBlob = globalThis.Blob
  let count = 0
  vi.stubGlobal(
    'Blob',
    new Proxy(NativeBlob, {
      construct(target, args, newTarget) {
        if (!args[0] || args[0].length === 0) count++
        return Reflect.construct(target, args, newTarget)
      },
    }),
  )
  try {
    return { result: await action(), count }
  } finally {
    vi.unstubAllGlobals()
  }
}
function structured(row: Resource): StructuredResource {
  const { originalBlob: _originalBlob, ...record } = row
  return {
    ...record,
    object: {
      format: 'srl-github-backup-bundle',
      version: 2,
      createdAt: '2026-10-16T00:00:00.000Z',
      fileName: row.fileName,
      totalSize: row.fileSize,
      totalSha256: row.contentHash,
      parts: [],
    },
  }
}

describe('restore plan placeholders', () => {
  it.each([false, true])(
    'revives without per-record Blob allocations and hydrates distinct original/native sources (native=%s)',
    async (native) => {
      const resources = await Promise.all(
        Array.from({ length: 201 }, (_, i) =>
          resource(`resource-${i}`, i % 2 ? 'text/plain' : 'application/json'),
        ),
      )
      const versions = await Promise.all(
        Array.from({ length: 51 }, async (_, i) => ({
          ...(await resource(`history-${i}`, 'application/octet-stream')),
          versionGroupId: resources[i]!.id,
        })),
      )
      const prepared = plan(resources, versions),
        test = fixture(prepared)
      const platform = vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(native)
      try {
        if (native)
          for (const [id, entry] of test.entries)
            rememberNativeFile(entry.blob, `content://fixture/${id}`)
        const { result: revived, count } = await countEmpty(() =>
          test.service.resumePrepared(prepared),
        )
        expect(test.get).not.toHaveBeenCalled()
        expect(
          [...revived.resources, ...revived.versions].every(
            (row) => row.originalBlob.size === 0 && row.originalBlob.type === '',
          ),
        ).toBe(true)
        expect(prepared.resources[0]!.originalBlob.size).toBeGreaterThan(0)
        const report = await test.service.restore(revived)
        expect(report.restoredResources).toBe(resources.length)
        expect(report.restoredVersions).toBe(versions.length)
        expect(test.get).toHaveBeenCalledTimes(resources.length + versions.length)
        expect(test.deleteJob).toHaveBeenCalledOnce()
        for (const [index, restored] of test.committed.entries()) {
          const original = [...resources, ...versions][index]!
          expect(restored.id).toBe(original.id)
          expect(restored.metadata).toEqual(original.metadata)
          expect(restored.originalBlob.type).toBe(original.mimeType)
          expect(await restored.originalBlob.text()).toBe(await original.originalBlob.text())
          expect(nativeFileSource(restored.originalBlob)).toBe(
            native ? `content://fixture/${original.id}` : undefined,
          )
        }
        expect(count).toBeLessThanOrEqual(1)
      } finally {
        platform.mockRestore()
      }
    },
  )

  it.each(['sha256', 'size'] as const)(
    'keeps corrupt %s entries uncommitted and retains staged files',
    async (field) => {
      const prepared = plan([await resource('one')], [])
      const test = fixture(prepared),
        entry = test.entries.get('one')!
      test.entries.set('one', { ...entry, [field]: field === 'size' ? entry.size + 1 : 'bad' })
      const revived = test.service.revivePrepared(prepared)
      await expect(test.service.restore(revived)).rejects.toThrow('备份原文件校验失败')
      expect(test.committed).toEqual([])
      expect(test.deleteJob).not.toHaveBeenCalled()
    },
  )

  it('does not allocate placeholders or clear data for a missing durable plan', async () => {
    const prepared = plan([], []),
      test = fixture(prepared)
    const { staging: _staging, ...missing } = prepared
    const result = await countEmpty(() => {
      expect(() => test.service.revivePrepared(missing)).toThrow('恢复任务缺少已校验文件引用')
    })
    expect(result.count).toBe(0)
    expect(test.deleteJob).not.toHaveBeenCalled()
  })

  it('prepares native structured references with one placeholder per MIME while retaining the original MIME behavior', async () => {
    const mimes = ['application/json', 'text/plain', 'application/octet-stream', 'text/PLAIN']
    const rows = await Promise.all(
      Array.from({ length: 100 }, (_, i) => resource(`resource-${i}`, mimes[i % mimes.length]!)),
    )
    const versions = await Promise.all(
      Array.from({ length: 21 }, async (_, i) => ({
        ...(await resource(`history-${i}`, mimes[i % mimes.length]!)),
        versionGroupId: rows[i]!.id,
      })),
    )
    const test = fixture(plan(rows, versions)),
      prepare = vi.spyOn(test.service, 'prepareStructured')
    const { result, count } = await countEmpty(() =>
      test.service.prepareStructuredNative(
        rows.map(structured),
        versions.map(structured),
        [],
        { version: 1 },
        [],
        [],
        'fixture',
      ),
    )
    expect(test.get).not.toHaveBeenCalled()
    const input = [...prepare.mock.calls[0]![0], ...prepare.mock.calls[0]![1]]
    const originals = [...rows, ...versions]
    for (const [index, row] of input.entries()) {
      expect(row.originalBlob.size).toBe(0)
      expect(row.originalBlob.type).toBe(originals[index]!.originalBlob.type)
    }
    for (const [index, row] of [...result.resources, ...result.versions].entries()) {
      expect(row).not.toHaveProperty('originalBlob')
      expect(row.nativeOriginal).toEqual({
        version: 1,
        contentHash: originals[index]!.contentHash,
        size: originals[index]!.fileSize,
      })
      expect(row.metadata).toEqual(originals[index]!.metadata)
    }
    expect(new Set([...result.resources, ...result.versions].map((row) => row.id)).size).toBe(
      rows.length + versions.length,
    )
    for (const [index, row] of result.versions.entries()) {
      expect(row.id).toMatch(
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i,
      )
      expect(row.id).not.toBe(versions[index]!.id)
      expect(row.versionGroupId).toBe(versions[index]!.versionGroupId)
    }
    expect(count).toBeLessThanOrEqual(mimes.length)
  })

  it.each([false, true])(
    'hydrates mixed-MIME structured originals instead of persisting shared placeholders (native=%s)',
    async (native) => {
      const mimes = ['application/json', 'text/plain', 'application/octet-stream']
      const rows = await Promise.all(
        Array.from({ length: 60 }, (_, i) => resource(`resource-${i}`, mimes[i % mimes.length]!)),
      )
      const versions = await Promise.all(
        Array.from({ length: 9 }, async (_, i) => ({
          ...(await resource(`history-${i}`, mimes[i % mimes.length]!)),
          versionGroupId: rows[i]!.id,
        })),
      )
      const test = fixture(plan(rows, versions)),
        byHash = new Map([...rows, ...versions].map((row) => [row.contentHash, row]))
      const read = vi.fn(
        async (object: StructuredResource['object']) =>
          byHash.get(object.totalSha256)!.originalBlob,
      )
      const snapshot: StructuredSnapshot = {
        format: 'srl-structured-cloud-snapshot',
        version: 3,
        createdAt: '2026-10-16T00:00:00.000Z',
        resources: rows.map(structured),
        versions: versions.map(structured),
        categories: [],
        portableData: { version: 1 },
      }
      const platform = vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(native)
      try {
        if (native)
          for (const row of byHash.values())
            rememberNativeFile(row.originalBlob, `content://fixture/${row.id}`)
        const { result, count } = await countEmpty(() =>
          test.service.restoreStructured(snapshot, read, [], [], 'fixture'),
        )
        expect(result.restoredResources).toBe(rows.length)
        expect(result.restoredVersions).toBe(versions.length)
        expect(read).toHaveBeenCalledTimes(rows.length + versions.length)
        for (const row of test.committed) {
          const original = byHash.get(row.contentHash)!
          expect(await row.originalBlob.text()).toBe(await original.originalBlob.text())
          expect(row.originalBlob.type).toBe(original.originalBlob.type)
          expect(nativeFileSource(row.originalBlob)).toBe(
            native ? `content://fixture/${original.id}` : undefined,
          )
        }
        expect(count).toBeLessThanOrEqual(mimes.length)
      } finally {
        platform.mockRestore()
      }
    },
  )
})
