/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'
import { RESOURCE_TYPE, type Resource } from '../types/Resource'
import type { CloudBackupConfig } from '../types/CloudBackup'
import type { StructuredResource, StructuredSnapshot } from './CloudStructuredSnapshot'
import { ExportService, type ArchiveSource } from './ExportService'
import { unzipSync } from 'fflate'
import {
  materializeStructuredArchive,
  type CloudBackupSnapshotOperationsContext,
} from './CloudBackupSnapshotOperations'

function fixture(count: number) {
  let idReads = 0
  const blobs = new Map<string, Blob>()
  const records = (historical: boolean): StructuredResource[] =>
    Array.from({ length: count }, (_, index) => {
      const id = `resource-${index}`,
        fileName = `${historical ? 'history' : 'current'}-${id}.json`,
        blob = new Blob([JSON.stringify({ id, historical })], { type: 'application/json' })
      blobs.set(fileName, blob)
      return {
        get id() {
          idReads++
          return id
        },
        type: RESOURCE_TYPE.OTHER,
        name: fileName,
        description: '',
        fileName,
        mimeType: blob.type,
        fileSize: blob.size,
        contentHash: fileName,
        favorite: false,
        categoryId: null,
        tags: [],
        metadata: { historical, index },
        createdAt: 1,
        updatedAt: 2,
        ...(historical ? { versionGroupId: id } : {}),
        object: {
          format: 'srl-github-backup-bundle',
          version: 2,
          createdAt: '2026-10-16T00:00:00.000Z',
          fileName,
          totalSize: blob.size,
          totalSha256: '0'.repeat(64),
          parts: [],
        },
      }
    })
  const snapshot: StructuredSnapshot = {
    format: 'srl-structured-cloud-snapshot',
    version: 3,
    createdAt: '2026-10-16T00:00:00.000Z',
    resources: records(false),
    versions: records(true),
    categories: [],
    portableData: { version: 1 },
  }
  const reader = vi.fn(async (object: StructuredResource['object']) => {
    const blob = blobs.get(object.fileName)
    if (!blob) throw new Error('Unknown fixture object')
    return blob
  })
  const readGitHub = vi.fn(async () => snapshot),
    readWebDav = vi.fn(async () => snapshot),
    createGitHub = vi.fn(
      async (_config?: unknown, _secret?: string, _options?: { signal: AbortSignal }) => reader,
    ),
    createWebDav = vi.fn(
      (_config?: unknown, _secret?: string, _options?: { signal: AbortSignal }) => reader,
    )
  const archive = { fileName: 'fixture.zip', blob: new Blob(['archive']), resourceCount: count }
  const exported: Resource[] = []
  const encode = vi.fn(
    async (
      source: ArchiveSource,
      _categories?: unknown,
      _archiveOptions?: unknown,
      _writerFactory?: unknown,
      _options?: { signal?: AbortSignal; readAhead?: { onFailure: (error: unknown) => void } },
    ) => {
      for (const record of source.resources) exported.push(await source.read(record, false))
      for (const record of source.versions) exported.push(await source.read(record, true))
      return [archive]
    },
  )
  const context = {
    readGitHubStructuredSnapshot: readGitHub,
    readWebDavStructuredSnapshot: readWebDav,
    createGitHubObjectReader: createGitHub,
    createWebDavObjectReader: createWebDav,
    exportService: { createArchivesFromSource: encode } as unknown as ExportService,
  } as unknown as CloudBackupSnapshotOperationsContext
  return {
    context,
    snapshot,
    reader,
    archive,
    encode,
    exported,
    idReads: () => idReads,
    readGitHub,
    readWebDav,
    createGitHub,
    createWebDav,
  }
}
const item = { id: 'snapshot', objectKey: 'snapshots/fixture.json.gz', size: 1, createdAt: 1 }
function target(github: boolean): CloudBackupConfig {
  return github
    ? {
        provider: 'github',
        owner: 'fixture',
        repository: 'backup',
        retention: 7,
        autoBackup: false,
      }
    : {
        provider: 'webdav',
        baseUrl: 'https://dav.example.com',
        username: 'fixture',
        folder: 'backup',
        retention: 7,
        autoBackup: false,
      }
}

describe('structured cloud archive descriptor lookup', () => {
  it.each([true, false])(
    'streams the complete ZIP into the supplied sink (github=%s)',
    async (github) => {
      const test = fixture(3)
      test.context.exportService = new ExportService()
      const chunks: Uint8Array<ArrayBuffer>[] = []
      const commit = vi.fn(async () => undefined)
      const abort = vi.fn(async () => undefined)
      const archive = await materializeStructuredArchive(
        test.context,
        item,
        target(github),
        'synthetic',
        {
          writerFactory: async () => ({
            write: async (chunk) => {
              chunks.push(chunk.slice())
            },
            commit,
            abort,
          }),
        },
      )
      expect(archive.blob.size).toBe(0)
      expect(commit).toHaveBeenCalledOnce()
      expect(abort).not.toHaveBeenCalled()
      const zip = unzipSync(new Uint8Array(await new Blob(chunks).arrayBuffer()))
      const manifest = JSON.parse(new TextDecoder().decode(zip['manifest.json']))
      for (const [historical, records] of [
        [false, manifest.resources],
        [true, manifest.versions],
      ] as const) {
        expect(records).toHaveLength(3)
        for (const record of records)
          expect(JSON.parse(new TextDecoder().decode(zip[record.archivePath]))).toEqual({
            id: record.id,
            historical,
          })
      }
    },
  )

  it.each([true, false])(
    'keeps real ZIP successes and retries only failed current/history originals (github=%s)',
    async (github) => {
      const test = fixture(8)
      test.context.exportService = new ExportService()
      const attempts = new Map<string, number>()
      const ordinaryRead = test.reader.getMockImplementation()!
      test.reader.mockImplementation(async (object) => {
        const count = (attempts.get(object.fileName) ?? 0) + 1
        attempts.set(object.fileName, count)
        if (
          count === 1 &&
          ['current-resource-0.json', 'history-resource-0.json'].includes(object.fileName)
        )
          throw new Error('connection interrupted')
        return ordinaryRead(object)
      })
      const reports: Array<{ completed: number; total: number; writtenBytes: number }> = []
      const retry = vi.fn(async (failures: readonly { fileName: string }[]) => {
        expect(failures.map((failure) => failure.fileName).sort()).toEqual([
          'current-resource-0.json',
          'history-resource-0.json',
        ])
        expect(attempts.size).toBe(16)
        expect(reports.at(-1)).toMatchObject({ completed: 14, total: 16 })
        expect(reports.at(-1)!.writtenBytes).toBeGreaterThan(0)
      })
      const archive = await materializeStructuredArchive(
        test.context,
        item,
        target(github),
        'synthetic',
        {
          onReadFailures: retry,
          onProgress: (progress) => reports.push(progress),
        },
      )
      expect(retry).toHaveBeenCalledOnce()
      expect(test.reader).toHaveBeenCalledTimes(18)
      expect(reports.at(-1)?.completed).toBe(16)
      expect(Math.max(...reports.map((progress) => progress.completed))).toBe(16)
      const zip = unzipSync(new Uint8Array(await archive.blob.arrayBuffer()))
      const manifest = JSON.parse(new TextDecoder().decode(zip['manifest.json']))
      expect(manifest.resources).toHaveLength(8)
      expect(manifest.versions).toHaveLength(8)
      for (const [historical, records] of [
        [false, manifest.resources],
        [true, manifest.versions],
      ] as const)
        for (const record of records)
          expect(JSON.parse(new TextDecoder().decode(zip[record.archivePath]))).toEqual({
            id: record.id,
            historical,
          })
    },
  )

  it.each([true, false])(
    'reports real reads and ZIP output and keeps every current/history byte (github=%s)',
    async (github) => {
      const test = fixture(8)
      test.context.exportService = new ExportService()
      const reports: Array<{ completed: number; total: number; writtenBytes: number }> = []
      const archive = await materializeStructuredArchive(
        test.context,
        item,
        target(github),
        'synthetic',
        { onProgress: (progress) => reports.push(progress) },
      )
      expect(reports[0]).toEqual({ completed: 0, total: 16, writtenBytes: 0 })
      expect(reports.at(-1)).toEqual({ completed: 16, total: 16, writtenBytes: archive.blob.size })
      expect(test.reader).toHaveBeenCalledTimes(16)
      const files = unzipSync(new Uint8Array(await archive.blob.arrayBuffer()))
      const originals = Object.entries(files)
        .filter(([name]) => name !== 'manifest.json')
        .map(([, bytes]) => JSON.parse(new TextDecoder().decode(bytes)))
      expect(originals).toHaveLength(16)
      expect(originals.filter((record) => record.historical)).toHaveLength(8)
      for (let index = 0; index < 8; index++) {
        expect(originals).toContainEqual({ id: `resource-${index}`, historical: false })
        expect(originals).toContainEqual({ id: `resource-${index}`, historical: true })
      }
    },
  )
  it.each([true, false])('indexes current/history descriptors once (github=%s)', async (github) => {
    const test = fixture(501)
    expect(
      await materializeStructuredArchive(test.context, item, target(github), 'synthetic'),
    ).toBe(test.archive)
    expect(test.exported).toHaveLength(1002)
    expect(test.reader).toHaveBeenCalledTimes(1002)
    for (const [index, resource] of test.exported.entries()) {
      const historical = index >= 501
      expect(resource.metadata).toEqual({ historical, index: index % 501 })
      expect(JSON.parse(await resource.originalBlob.text())).toEqual({
        id: `resource-${index % 501}`,
        historical,
      })
    }
    expect(test.idReads()).toBeLessThanOrEqual(1002 * 8)
    expect(test.encode.mock.calls[0]?.[0].resources).toBe(test.snapshot.resources)
    expect(test.encode.mock.calls[0]?.[0].versions).toBe(test.snapshot.versions)
    expect(test.encode).toHaveBeenCalledWith(
      expect.anything(),
      test.snapshot.categories,
      {
        mode: 'full',
        portableData: test.snapshot.portableData,
        readAlbumFile: expect.any(Function),
      },
      undefined,
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        readAhead: { onFailure: expect.any(Function) },
        onProgress: expect.any(Function),
      }),
    )
    expect(test.readGitHub).toHaveBeenCalledTimes(github ? 1 : 0)
    expect(test.readWebDav).toHaveBeenCalledTimes(github ? 0 : 1)
    expect(test.createGitHub).toHaveBeenCalledTimes(github ? 1 : 0)
    expect(test.createWebDav).toHaveBeenCalledTimes(github ? 0 : 1)
  })

  it('keeps the first duplicate descriptor in each scope and rejects missing descriptions before reading', async () => {
    const test = fixture(1)
    test.snapshot.resources.push({ ...test.snapshot.resources[0]!, metadata: { duplicate: true } })
    test.encode.mockImplementation(async (source) => {
      expect((await source.read(source.resources[0]!, false)).metadata).toEqual({
        historical: false,
        index: 0,
      })
      expect((await source.read(source.versions[0]!, true)).metadata).toEqual({
        historical: true,
        index: 0,
      })
      await expect(
        source.read({ ...source.resources[0]!, id: 'missing', fileName: 'missing.json' }, false),
      ).rejects.toThrow('备份缺少资源描述：missing.json')
      expect(test.reader).toHaveBeenCalledTimes(2)
      return [test.archive]
    })
    expect(await materializeStructuredArchive(test.context, item, target(true), 'synthetic')).toBe(
      test.archive,
    )
  })

  it.each([true, false])(
    'connects ZIP failures to the same provider signal and releases it afterward (github=%s)',
    async (github) => {
      const test = fixture(1)
      const failure = new Error('writer failed')
      let readerSignal: AbortSignal | undefined
      test.encode.mockImplementation(
        async (_source, _categories, _archiveOptions, _writerFactory, options) => {
          readerSignal = (github ? test.createGitHub : test.createWebDav).mock.calls[0]?.[2]?.signal
          expect(readerSignal).toBe(options?.signal)
          expect(readerSignal?.aborted).toBe(false)
          options?.readAhead?.onFailure(failure)
          expect(readerSignal?.aborted).toBe(true)
          expect(readerSignal?.reason).toBe(failure)
          throw failure
        },
      )
      await expect(
        materializeStructuredArchive(test.context, item, target(github), 'synthetic'),
      ).rejects.toBe(failure)
      expect(readerSignal?.aborted).toBe(true)
    },
  )

  it('forwards caller cancellation and prevents reads after it', async () => {
    const test = fixture(1)
    const controller = new AbortController()
    test.context.signal = controller.signal
    const failure = new Error('caller stopped')
    test.encode.mockImplementation(
      async (source, _categories, _archiveOptions, _writerFactory, options) => {
        controller.abort(failure)
        expect(options?.signal?.reason).toBe(failure)
        await expect(source.read(source.resources[0]!, false)).rejects.toBe(failure)
        throw failure
      },
    )
    await expect(
      materializeStructuredArchive(test.context, item, target(true), 'synthetic'),
    ).rejects.toBe(failure)
    expect(test.reader).not.toHaveBeenCalled()
  })
})
