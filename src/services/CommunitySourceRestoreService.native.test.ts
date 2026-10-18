import { expect, it, vi } from 'vitest'
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
  registerPlugin: () => ({}),
}))
import { CommunitySourceRestoreService } from './CommunitySourceRestoreService'
import { MemoryRestoreStagingStore } from '../storage/RestoreStagingStore'
import type { ArchiveStorageAdapter } from '../storage/ArchiveStorageAdapter'
import type { ArchivePortableData } from '../types/Backup'
import type { CommunitySourceAttachmentArchiveEntry } from '../types/CommunitySource'
import { nativeFileSource, rememberNativeFile } from '../core/NativeFileSource'

it('keeps the native CAS file reference when restoring an attachment with its saved MIME type', async () => {
  const blob = rememberNativeFile(new Blob(['saved-bytes']), 'file:///app/library/object.bin')
  const restore = vi.fn(async (_entries: readonly CommunitySourceAttachmentArchiveEntry[]) => {})
  const service = new CommunitySourceRestoreService(
    {} as ArchiveStorageAdapter,
    new MemoryRestoreStagingStore(),
    { restoreBackup: async () => {}, replaceAll: async () => {} },
    restore,
  )
  const data: ArchivePortableData = {
    version: 1,
    communitySources: {
      data: { version: 1, sources: [], messages: [], bindings: [] },
      attachments: [
        {
          assetId: `asset-${'a'.repeat(64)}`,
          mimeType: 'text/plain',
          object: {
            format: 'srl-github-backup-bundle',
            version: 2,
            createdAt: new Date().toISOString(),
            fileName: 'saved.txt',
            totalSize: blob.size,
            totalSha256: 'a'.repeat(64),
            parts: [],
          },
        },
      ],
    },
  }
  await service.restoreStructuredCommunityAttachments(data, async () => blob)
  expect(restore).toHaveBeenCalledOnce()
  const restored = restore.mock.calls[0]![0][0]!.blob
  expect(restored.type).toBe('text/plain')
  expect(nativeFileSource(restored)).toBe(nativeFileSource(blob))
  expect(await restored.text()).toBe('saved-bytes')
  const read = vi.fn(async () => blob)
  const controller = new AbortController()
  controller.abort()
  await expect(
    service.restoreStructuredCommunityAttachments(data, read, controller.signal),
  ).rejects.toThrow()
  expect(read).not.toHaveBeenCalled()
  expect(restore).toHaveBeenCalledOnce()
})
