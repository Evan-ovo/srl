/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NativeMirroredResourceStorage } from '../storage/NativeMirroredResourceStorage'
import { releaseReplacedNativeObjects } from '../storage/NativeResourceFileMirror'
import { rememberNativeFile } from '../core/NativeFileSource'
import { openCheckpointArchiveWriter } from '../core/NativeArchiveExport'
import { ExportService } from './ExportService'
import type { ResourceStorageAdapter } from '../storage/ResourceStorageAdapter'
import type { VaultService } from './VaultService'
import type { Resource } from '../types/Resource'

const bridge = vi.hoisted(() => ({
  files: new Set<string>(),
  index: new Map<string, string>(),
  pending: new Map<string, { id: string; contentHash: string }>(),
  release: vi.fn(),
  compress: vi.fn(),
}))
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    isPluginAvailable: () => true,
  },
  registerPlugin: () => ({
    beginWrite: async (record: { id: string; contentHash: string; deferCommit?: boolean }) => {
      const token = 'link-' + record.id
      if (record.deferCommit) bridge.pending.set(token, record)
      else bridge.index.set(record.id, record.contentHash)
      return { token, alreadyPresent: true }
    },
    commitWrite: async ({ token }: { token: string }) => {
      const record = bridge.pending.get(token)!
      bridge.index.set(record.id, record.contentHash)
      bridge.pending.delete(token)
    },
    abortWrite: async ({ token }: { token: string }) => {
      bridge.pending.delete(token)
    },
    releaseReplacedObjects: (options: unknown) => bridge.release(options),
    beginArchive: async () => ({ id: 'archive' }),
    getArchiveEntry: async () => ({}),
    compressArchiveEntry: (options: unknown) => bridge.compress(options),
    resetArchiveInput: async () => {},
    appendArchiveInput: async () => {},
    assembleArchive: async () => ({ bytes: 8 }),
    publishArchive: async () => ({}),
  }),
}))
const oldHash = 'a'.repeat(64),
  newHash = 'b'.repeat(64)
function resource(id = 'resource'): Resource {
  const originalBlob = rememberNativeFile(new Blob(['old!']), 'file:///' + id)
  return {
    id,
    type: 'other',
    name: id,
    description: '',
    fileName: id + '.bin',
    mimeType: 'application/octet-stream',
    fileSize: 4,
    contentHash: oldHash,
    favorite: false,
    categoryId: null,
    tags: [],
    metadata: {},
    originalBlob,
    createdAt: 1,
    updatedAt: 1,
  }
}
describe('native archive source lifetime and rejected insertion', () => {
  beforeEach(() => {
    bridge.files.clear()
    bridge.index.clear()
    bridge.pending.clear()
    vi.clearAllMocks()
    bridge.release.mockImplementation(async () => {
      bridge.files.clear()
      return { clearedBytes: 4 }
    })
    bridge.compress.mockImplementation(
      async (options: { uri?: string; size: number; descriptor?: unknown }) => {
        if (options.uri && !bridge.files.has(options.uri))
          throw new Error('export source was reclaimed')
        return { bytes: options.size, descriptor: options.descriptor }
      },
    )
  })
  it('does not publish a prepared native link when atomic insertion rejects the occupied ID', async () => {
    const original = resource()
    bridge.index.set(original.id, oldHash)
    const storage = new NativeMirroredResourceStorage(
      { insertIfAbsent: async () => false } as unknown as ResourceStorageAdapter,
      { isEnabled: () => false } as VaultService,
    )
    expect(await storage.insertIfAbsent!({ ...original, contentHash: newHash })).toBe(false)
    expect(bridge.index.get(original.id)).toBe(oldHash)
    expect(bridge.pending.size).toBe(0)
  })
  it.each(['complete', 'failure', 'cancel'] as const)(
    'protects all export volumes and releases source ownership on %s',
    async (outcome) => {
      const rows = [resource('one'), resource('two')]
      rows.forEach((row) => bridge.files.add('file:///' + row.id))
      const controller = new AbortController()
      const service = new ExportService()
      let read = 0
      const pending = service.createArchivesFromSource(
        {
          resources: rows,
          versions: [],
          read: async (row) => {
            read++
            await releaseReplacedNativeObjects([
              {
                scope: 'current',
                id: row.id,
                contentHash: newHash,
                size: 4,
                replacedHashes: [oldHash],
              },
            ])
            expect(bridge.release).not.toHaveBeenCalled()
            if (outcome === 'failure') throw new Error('fixture read failure')
            if (outcome === 'cancel') controller.abort(new DOMException('stopped', 'AbortError'))
            return rows.find((resource) => resource.id === row.id)!
          },
        },
        [],
        { mode: 'full', splitSizeBytes: 1 },
        (name) => openCheckpointArchiveWriter(name, name),
        { signal: controller.signal },
      )
      if (outcome === 'complete') {
        expect(await pending).toHaveLength(2)
        expect(read).toBe(2)
      } else
        await expect(pending).rejects.toThrow(
          outcome === 'failure' ? 'fixture read failure' : 'stopped',
        )
      expect(bridge.release).toHaveBeenCalledOnce()
      expect(bridge.files.size).toBe(0)
    },
  )
})
