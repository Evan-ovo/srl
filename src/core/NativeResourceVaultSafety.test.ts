/** @vitest-environment jsdom */
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'

const nativeFiles = vi.hoisted(() => ({ info: vi.fn(), clear: vi.fn(), mirror: vi.fn() }))
vi.mock('../storage/NativeResourceFileMirror', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../storage/NativeResourceFileMirror')>()),
  getNativeResourceStorageInfo: nativeFiles.info,
  clearNativeResourceFiles: nativeFiles.clear,
  mirrorNativeResourceFile: nativeFiles.mirror,
}))
vi.mock('../utils/CapacitorDetection', () => ({ isCapacitorApp: () => true }))

import { syncNativeResourceFiles, vaultService } from './AppContainer'
import { indexedDbStorage } from './LibraryContainer'
import type { ResourceReadSource } from '../types/ResourceReadSource'

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('native startup and incomplete vault migration', () => {
  it('repairs mixed current/history native mirrors without materializing their original bodies', async () => {
    vi.spyOn(vaultService, 'isEnabled').mockReturnValue(false)
    const nativeFile = new Blob()
    const source = {
      id: 'native',
      contentHash: 'a'.repeat(64),
      originalSource: { size: 33554432, nativeFile: vi.fn(async () => nativeFile) },
    } as unknown as ResourceReadSource
    vi.spyOn(indexedDbStorage, 'listResourceListSummaries').mockResolvedValue([source])
    vi.spyOn(indexedDbStorage, 'listVersionListSummaries').mockResolvedValue([
      { ...source, id: 'history' },
    ])
    vi.spyOn(indexedDbStorage, 'getReadSource').mockImplementation(async (id) => ({
      ...source,
      id,
    }))
    const current = vi
      .spyOn(indexedDbStorage, 'get')
      .mockRejectedValue(new Error('whole original read'))
    const history = vi
      .spyOn(indexedDbStorage, 'getVersion')
      .mockRejectedValue(new Error('whole history read'))
    nativeFiles.info
      .mockReset()
      .mockResolvedValueOnce({ storageVersion: 4, currentCount: 0, versionCount: 0 })
      .mockResolvedValue(undefined)
    await syncNativeResourceFiles()
    expect(current).not.toHaveBeenCalled()
    expect(history).not.toHaveBeenCalled()
    expect(nativeFiles.mirror).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'native', originalBlob: nativeFile }),
      'current',
    )
    expect(nativeFiles.mirror).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'history', originalBlob: nativeFile }),
      'versions',
    )
    expect(nativeFiles.info).toHaveBeenCalledTimes(2)
  })

  it('retains whole-read compatibility and the final manifest convergence check', async () => {
    vi.spyOn(vaultService, 'isEnabled').mockReturnValue(false)
    const source = {
      id: 'old',
      contentHash: 'a'.repeat(64),
      originalSource: new Blob(['old']),
    } as unknown as ResourceReadSource
    vi.spyOn(indexedDbStorage, 'listResourceListSummaries').mockResolvedValue([source])
    vi.spyOn(indexedDbStorage, 'listVersionListSummaries').mockResolvedValue([])
    vi.spyOn(indexedDbStorage, 'getReadSource').mockResolvedValue(source)
    const get = vi
      .spyOn(indexedDbStorage, 'get')
      .mockResolvedValue({ ...source, originalBlob: source.originalSource } as never)
    nativeFiles.info
      .mockReset()
      .mockResolvedValue({ storageVersion: 4, currentCount: 0, versionCount: 0 })
    await expect(syncNativeResourceFiles()).rejects.toThrow('镜像修复未收敛')
    expect(get).toHaveBeenCalledWith('old')
  })

  it('shares a single native mirror sync when startup and cloud backup meet', async () => {
    let resolveInfo!: (value: undefined) => void
    nativeFiles.info.mockReturnValueOnce(new Promise((resolve) => (resolveInfo = resolve)))
    const startup = syncNativeResourceFiles()
    const backup = syncNativeResourceFiles()
    await vi.waitFor(() => expect(nativeFiles.info).toHaveBeenCalledOnce())
    resolveInfo(undefined)
    await Promise.all([startup, backup])
  })

  it('does not clear native-only originals while an enabled vault awaits migration/unlock', async () => {
    nativeFiles.info.mockResolvedValue({ storageVersion: 4 })
    vi.spyOn(vaultService, 'isEnabled').mockReturnValue(true)
    nativeFiles.clear.mockResolvedValue(undefined)
    await syncNativeResourceFiles()
    expect(nativeFiles.info).toHaveBeenCalledOnce()
    expect(nativeFiles.info).toHaveBeenCalledWith(false)
    expect(nativeFiles.clear).not.toHaveBeenCalled()
    expect(nativeFiles.mirror).not.toHaveBeenCalled()
  })
})
