import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { VaultService } from '../services/VaultService'
import { RESOURCE_TYPE, type Resource } from '../types/Resource'
import type { ResourceStorageAdapter } from './ResourceStorageAdapter'

const mirror = vi.hoisted(() => ({
  commit: vi.fn(),
  abort: vi.fn(),
  stage: vi.fn(),
  clear: vi.fn(),
  remove: vi.fn(),
  removeMany: vi.fn(),
  available: vi.fn(),
  release: vi.fn(),
}))

vi.mock('./NativeResourceFileMirror', () => ({
  stageNativeResourceFile: mirror.stage,
  isAndroidNativeResourceMirrorAvailable: mirror.available,
  clearNativeResourceFiles: mirror.clear,
  removeNativeResourceFile: mirror.remove,
  removeNativeResourceFiles: mirror.removeMany,
  releaseReplacedNativeObjects: mirror.release,
}))

import { NativeMirroredResourceStorage } from './NativeMirroredResourceStorage'

function resource(): Resource {
  return {
    id: 'resource-1',
    type: RESOURCE_TYPE.OTHER,
    name: '资源',
    description: '',
    fileName: 'resource.json',
    mimeType: 'application/json',
    fileSize: 2,
    contentHash: 'a'.repeat(64),
    favorite: false,
    categoryId: null,
    tags: [],
    metadata: {},
    originalBlob: new Blob(['{}']),
    createdAt: 1,
    updatedAt: 2,
  }
}

function delegate(save: (resource: Resource) => Promise<void>): ResourceStorageAdapter {
  return {
    list: vi.fn(),
    listSummaries: vi.fn(),
    get: vi.fn(),
    findByHash: vi.fn(),
    findVersionByHash: vi.fn(),
    listVersions: vi.fn(),
    listAllVersions: vi.fn(),
    listVersionSummaries: vi.fn(),
    saveVersionSummary: vi.fn(),
    saveVersion: vi.fn(),
    updateVersion: vi.fn(),
    deleteVersion: vi.fn(),
    save,
    saveMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  } as ResourceStorageAdapter
}

describe('NativeMirroredResourceStorage', () => {
  it.each([false, true])(
    'commits only a successful atomic insertion (inserted=%s)',
    async (inserted) => {
      const backing = delegate(vi.fn(async () => undefined))
      backing.insertIfAbsent = vi.fn(async () => inserted)
      backing.convertToNativeReference = vi.fn(async () => true)
      const storage = new NativeMirroredResourceStorage(backing, {
        isEnabled: () => false,
      } as VaultService)
      expect(await storage.insertIfAbsent?.(resource())).toBe(inserted)
      expect(backing.save).not.toHaveBeenCalled()
      expect(mirror.commit).toHaveBeenCalledTimes(inserted ? 1 : 0)
      expect(mirror.abort).toHaveBeenCalledTimes(inserted ? 0 : 1)
      expect(backing.convertToNativeReference).toHaveBeenCalledTimes(inserted ? 1 : 0)
    },
  )

  it('keeps atomic insertion optional and preserves vault and staging failure behavior', async () => {
    const backing = delegate(async () => undefined)
    expect(
      new NativeMirroredResourceStorage(backing, { isEnabled: () => false } as VaultService)
        .insertIfAbsent,
    ).toBeUndefined()
    backing.insertIfAbsent = vi.fn(async () => true)
    const encrypted = new NativeMirroredResourceStorage(backing, {
      isEnabled: () => true,
    } as VaultService)
    expect(await encrypted.insertIfAbsent?.(resource())).toBe(true)
    expect(mirror.stage).not.toHaveBeenCalled()
    vi.mocked(backing.insertIfAbsent).mockClear()
    mirror.stage.mockRejectedValueOnce(new Error('stage failed'))
    const ordinary = new NativeMirroredResourceStorage(backing, {
      isEnabled: () => false,
    } as VaultService)
    await expect(ordinary.insertIfAbsent?.(resource())).rejects.toThrow('stage failed')
    expect(backing.insertIfAbsent).not.toHaveBeenCalled()
  })

  it('does not retry aborting an occupied insertion when abort itself fails', async () => {
    const backing = delegate(async () => undefined)
    backing.insertIfAbsent = vi.fn(async () => false)
    mirror.abort.mockRejectedValueOnce(new Error('abort failed'))
    const storage = new NativeMirroredResourceStorage(backing, {
      isEnabled: () => false,
    } as VaultService)
    await expect(storage.insertIfAbsent?.(resource())).rejects.toThrow('abort failed')
    expect(mirror.abort).toHaveBeenCalledOnce()
    expect(mirror.commit).not.toHaveBeenCalled()
  })
  it('forwards thumbnail-only reads and keeps a full-read fallback only for old delegates', async () => {
    const backing = delegate(async () => undefined)
    const thumbnail = new Blob(['thumbnail'])
    backing.getThumbnail = vi.fn(async () => thumbnail)
    const storage = new NativeMirroredResourceStorage(backing, {
      isEnabled: () => false,
    } as VaultService)
    expect(await storage.getThumbnail('image')).toBe(thumbnail)
    expect(backing.getThumbnail).toHaveBeenCalledExactlyOnceWith('image')
    expect(backing.get).not.toHaveBeenCalled()
    delete backing.getThumbnail
    vi.mocked(backing.get).mockResolvedValue({ ...resource(), thumbnailBlob: thumbnail })
    expect(await storage.getThumbnail('image')).toBe(thumbnail)
    expect(backing.get).toHaveBeenCalledExactlyOnceWith('image')
    expect(mirror.stage).not.toHaveBeenCalled()
  })

  it('deletes a single resource using scoped historical IDs without loading historical originals', async () => {
    const backing = delegate(async () => undefined)
    backing.listVersions = vi.fn(async () => [
      { ...resource(), id: 'history', versionGroupId: 'resource-1' },
    ])
    backing.listVersionListSummariesForResources = vi.fn(async () => [
      { ...resource(), id: 'history', versionGroupId: 'resource-1' },
    ])
    const storage = new NativeMirroredResourceStorage(backing, {
      isEnabled: () => false,
    } as VaultService)
    await storage.delete('resource-1')
    expect(backing.listVersions).not.toHaveBeenCalled()
    expect(backing.listVersionListSummariesForResources).toHaveBeenCalledExactlyOnceWith([
      'resource-1',
    ])
    expect(mirror.remove.mock.calls).toEqual([
      ['resource-1', 'current'],
      ['history', 'versions'],
    ])
    expect(backing.delete).toHaveBeenCalledExactlyOnceWith('resource-1')
  })

  it('forwards committed batch reads and bounds the targeted fallback for older delegates', async () => {
    const backing = delegate(async () => undefined)
    const row = resource()
    backing.getResourceListSummaries = vi.fn(async () => [row])
    const storage = new NativeMirroredResourceStorage(backing, {
      isEnabled: () => false,
    } as VaultService)
    expect(await storage.getResourceListSummaries([row.id])).toEqual([row])
    expect(backing.getResourceListSummaries).toHaveBeenCalledExactlyOnceWith([row.id])
    delete backing.getResourceListSummaries
    let active = 0,
      maximum = 0
    backing.getResourceListSummary = vi.fn(async (id) => {
      maximum = Math.max(maximum, ++active)
      await Promise.resolve()
      active--
      return id === 'missing' ? undefined : { ...row, id }
    })
    const ids = Array.from({ length: 501 }, (_, index) => `r-${index}`)
    const result = await storage.getResourceListSummaries([...ids, ids[0]!, 'missing'])
    expect(result.map((item) => item.id)).toEqual(ids)
    expect(backing.getResourceListSummary).toHaveBeenCalledTimes(502)
    expect(maximum).toBeLessThanOrEqual(250)
    expect(backing.listSummaries).not.toHaveBeenCalled()
    expect(mirror.stage).not.toHaveBeenCalled()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mirror.stage.mockResolvedValue({ commit: mirror.commit, abort: mirror.abort })
    mirror.commit.mockResolvedValue(undefined)
    mirror.abort.mockResolvedValue(undefined)
    mirror.clear.mockResolvedValue(undefined)
    mirror.available.mockReturnValue(true)
    mirror.release.mockResolvedValue(undefined)
  })

  it.each(Object.values(RESOURCE_TYPE))(
    'reclaims replaced %s bytes only after commit and authoritative readback',
    async (type) => {
      const previous = { ...resource(), type } as Resource
      const changes = { originalBlob: new Blob(['next']), contentHash: 'b'.repeat(64), fileSize: 4 }
      const current = { ...previous, ...changes }
      const backing = delegate(vi.fn(async () => undefined))
      backing.get = vi.fn(async () => previous)
      const replacement = {
        scope: 'current',
        id: current.id,
        contentHash: current.contentHash,
        size: current.fileSize,
        replacedHashes: [previous.contentHash],
      }
      mirror.stage.mockResolvedValueOnce({
        commit: mirror.commit,
        abort: mirror.abort,
        replacement,
      })
      const order: string[] = []
      backing.update = vi.fn(async () => {
        order.push('database')
      })
      backing.convertToNativeReference = vi.fn(async () => {
        order.push('verified')
        return true
      })
      mirror.commit.mockImplementationOnce(async () => {
        order.push('mirror')
      })
      mirror.release.mockImplementationOnce(async () => {
        order.push('cleanup')
      })
      const storage = new NativeMirroredResourceStorage(backing, {
        isEnabled: () => false,
      } as VaultService)
      await storage.update(previous.id, changes)
      expect(order).toEqual(['database', 'mirror', 'verified', 'cleanup'])
      expect(mirror.release).toHaveBeenCalledWith([replacement])
      expect(backing.convertToNativeReference).toHaveBeenCalledExactlyOnceWith(
        previous.id,
        'current',
        current.contentHash,
        4,
      )
    },
  )

  it('retains old files on failed commits or stale readback, and a cleanup error never rolls back saved data', async () => {
    const previous = resource()
    const changes = { originalBlob: new Blob(['next']), contentHash: 'b'.repeat(64), fileSize: 4 }
    const backing = delegate(vi.fn(async () => undefined))
    backing.get = vi.fn(async () => previous)
    const replacement = {
      scope: 'current',
      id: previous.id,
      contentHash: changes.contentHash,
      size: changes.fileSize,
      replacedHashes: [previous.contentHash],
    }
    mirror.stage.mockResolvedValue({ commit: mirror.commit, abort: mirror.abort, replacement })
    backing.convertToNativeReference = vi.fn(async () => false)
    const storage = new NativeMirroredResourceStorage(backing, {
      isEnabled: () => false,
    } as VaultService)
    await storage.update(previous.id, changes)
    expect(mirror.release).not.toHaveBeenCalled()
    mirror.commit.mockRejectedValueOnce(new Error('commit failed'))
    await expect(storage.update(previous.id, changes)).rejects.toThrow('commit failed')
    expect(mirror.release).not.toHaveBeenCalled()
    vi.mocked(backing.convertToNativeReference).mockResolvedValue(true)
    mirror.release.mockRejectedValueOnce(new Error('old APK'))
    await expect(storage.update(previous.id, changes)).resolves.toBeUndefined()
  })

  it.each(['save', 'saveVersion', 'updateVersion', 'updateMany', 'saveMany'] as const)(
    'reclaims replacement receipts through the shared %s entry and batches multi-item cleanup',
    async (entry) => {
      const previous = resource()
      const current = { ...previous, contentHash: 'b'.repeat(64) }
      const backing = delegate(vi.fn(async () => undefined))
      backing.get = vi.fn(async () => current)
      backing.getVersion = vi.fn(async () => current)
      backing.convertToNativeReference = vi.fn(async () => true)
      mirror.stage.mockImplementation(async (value: Resource, scope: 'current' | 'versions') => ({
        commit: mirror.commit,
        abort: mirror.abort,
        replacement: {
          id: value.id,
          scope,
          contentHash: value.contentHash,
          size: value.fileSize,
          replacedHashes: [previous.contentHash],
        },
      }))
      const storage = new NativeMirroredResourceStorage(backing, {
        isEnabled: () => false,
      } as VaultService)
      if (entry === 'save' || entry === 'saveVersion') await storage[entry](current)
      else if (entry === 'updateVersion') await storage.updateVersion(current.id, current)
      else if (entry === 'updateMany') {
        backing.get = vi.fn(async (id) => ({ ...current, id }))
        await storage.updateMany(['one', 'two'], current)
      } else
        await storage.saveMany([
          { ...current, id: 'one' },
          { ...current, id: 'two' },
        ])
      expect(mirror.release).toHaveBeenCalledOnce()
      const records = mirror.release.mock.calls[0]![0]
      expect(records).toHaveLength(entry === 'saveMany' || entry === 'updateMany' ? 2 : 1)
      expect(records[0].scope).toBe(
        entry === 'saveVersion' || entry === 'updateVersion' ? 'versions' : 'current',
      )
    },
  )

  it('forwards the optional gallery query and leaves older delegates on the service fallback', async () => {
    const backing = delegate(async () => undefined)
    backing.listGalleryListSummaries = vi.fn(async () => [])
    const storage = new NativeMirroredResourceStorage(backing, {
      isEnabled: () => false,
    } as VaultService)
    await expect(storage.listGalleryListSummaries?.('owner', true)).resolves.toEqual([])
    expect(backing.listGalleryListSummaries).toHaveBeenCalledWith('owner', true)
    const legacy = new NativeMirroredResourceStorage(
      delegate(async () => undefined),
      { isEnabled: () => false } as VaultService,
    )
    expect(legacy.listGalleryListSummaries).toBeUndefined()
  })

  it('preserves optional persistent chat positions through the production mirror wrapper', async () => {
    const backing = delegate(async () => undefined)
    const cache = { schemaVersion: 1 as const, key: 'identity', stride: 128, checkpoints: [] }
    backing.getChatReadPositionCache = vi.fn(async () => cache)
    backing.setChatReadPositionCache = vi.fn(async () => undefined)
    backing.deleteChatReadPositionCache = vi.fn(async () => undefined)
    const storage = new NativeMirroredResourceStorage(backing, {
      isEnabled: () => false,
    } as VaultService)
    await expect(storage.getChatReadPositionCache?.('chat')).resolves.toEqual(cache)
    await storage.setChatReadPositionCache?.('chat', cache)
    await storage.deleteChatReadPositionCache?.('chat')
    expect(backing.setChatReadPositionCache).toHaveBeenCalledWith('chat', cache)
    expect(backing.deleteChatReadPositionCache).toHaveBeenCalledWith('chat')
    const legacy = new NativeMirroredResourceStorage(
      delegate(async () => undefined),
      { isEnabled: () => false } as VaultService,
    )
    expect(legacy.getChatReadPositionCache).toBeUndefined()
  })

  it('原生文件暂存成功且 IndexedDB 保存成功后才提交镜像', async () => {
    const order: string[] = []
    mirror.stage.mockImplementation(async () => ({
      commit: async () => order.push('commit'),
      abort: async () => order.push('abort'),
    }))
    const storage = new NativeMirroredResourceStorage(
      delegate(async () => {
        order.push('save')
      }),
      { isEnabled: () => false } as VaultService,
    )

    await storage.save(resource())
    expect(order).toEqual(['save', 'commit'])
  })

  it('原生提交完成后把网页原件转为同一原生对象引用，避免后续重复占用', async () => {
    const order: string[] = []
    const backing = delegate(async () => {
      order.push('save')
    })
    backing.convertToNativeReference = vi.fn(async () => {
      order.push('offload')
      return true
    })
    mirror.stage.mockImplementation(async () => ({
      commit: async () => {
        order.push('commit')
      },
      abort: mirror.abort,
    }))
    const storage = new NativeMirroredResourceStorage(backing, {
      isEnabled: () => false,
    } as VaultService)

    await storage.save(resource())
    expect(order).toEqual(['save', 'commit', 'offload'])
    expect(backing.convertToNativeReference).toHaveBeenCalledWith(
      'resource-1',
      'current',
      'a'.repeat(64),
      2,
    )
  })

  it('网页环境绝不改写为原生引用', async () => {
    mirror.available.mockReturnValue(false)
    const backing = delegate(async () => undefined)
    backing.convertToNativeReference = vi.fn(async () => true)
    const storage = new NativeMirroredResourceStorage(backing, {
      isEnabled: () => false,
    } as VaultService)

    await storage.save(resource())
    expect(backing.convertToNativeReference).not.toHaveBeenCalled()
  })

  it('IndexedDB 保存失败时中止暂存文件', async () => {
    const storage = new NativeMirroredResourceStorage(
      delegate(async () => {
        throw new Error('db failed')
      }),
      { isEnabled: () => false } as VaultService,
    )

    await expect(storage.save(resource())).rejects.toThrow('db failed')
    expect(mirror.abort).toHaveBeenCalledOnce()
    expect(mirror.commit).not.toHaveBeenCalled()
  })

  it('原生提交失败时恢复 IndexedDB 中的旧文件记录', async () => {
    const previous = resource()
    const save = vi.fn(async () => undefined)
    const backing = delegate(save)
    backing.get = vi.fn(async () => previous)
    backing.update = vi.fn(async () => undefined)
    mirror.commit.mockRejectedValueOnce(new Error('native commit failed'))
    const storage = new NativeMirroredResourceStorage(backing, {
      isEnabled: () => false,
    } as VaultService)

    await expect(
      storage.update(previous.id, {
        contentHash: 'b'.repeat(64),
        fileSize: 4,
        originalBlob: new Blob(['next']),
      }),
    ).rejects.toThrow('native commit failed')

    expect(save).toHaveBeenCalledWith(previous)
    expect(mirror.abort).toHaveBeenCalledOnce()
  })

  it('保险库开启时仅保存加密 IndexedDB，不清空其他待迁移的原生原件', async () => {
    const save = vi.fn(async () => undefined)
    const storage = new NativeMirroredResourceStorage(delegate(save), {
      isEnabled: () => true,
    } as VaultService)

    await storage.save(resource())
    expect(mirror.clear).not.toHaveBeenCalled()
    expect(mirror.stage).not.toHaveBeenCalled()
    expect(save).toHaveBeenCalledOnce()
  })

  it('串行提交资源写入，避免旧镜像在并发时覆盖新数据库状态', async () => {
    let releaseFirstCommit: (() => void) | undefined
    const firstCommit = new Promise<void>((resolve) => {
      releaseFirstCommit = resolve
    })
    mirror.stage
      .mockResolvedValueOnce({ commit: () => firstCommit, abort: mirror.abort })
      .mockResolvedValueOnce({ commit: mirror.commit, abort: mirror.abort })
    const save = vi.fn(async () => undefined)
    const storage = new NativeMirroredResourceStorage(delegate(save), {
      isEnabled: () => false,
    } as VaultService)

    const first = storage.save(resource())
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    const second = storage.save({ ...resource(), updatedAt: 3 })
    await Promise.resolve()
    expect(mirror.stage).toHaveBeenCalledTimes(1)

    releaseFirstCommit?.()
    await Promise.all([first, second])
    expect(save).toHaveBeenCalledTimes(2)
    expect(mirror.stage).toHaveBeenCalledTimes(2)
  })
})

describe('historical backup descriptor updates', () => {
  it('deletes only selected histories without reading the whole version catalogue', async () => {
    const storage = delegate(vi.fn())
    storage.listVersionListSummaries = vi.fn(async () => {
      throw new Error('whole history scan')
    })
    storage.listVersionListSummariesForResources = vi.fn(async () => [
      { ...resource(), id: 'selected-history', versionGroupId: 'resource-1' },
    ])
    const adapter = new NativeMirroredResourceStorage(storage, {
      isEnabled: () => false,
    } as VaultService)
    await adapter.deleteMany(['resource-1'])
    expect(storage.listVersionListSummariesForResources).toHaveBeenCalledWith(['resource-1'])
    expect(storage.listVersionListSummaries).not.toHaveBeenCalled()
    expect(storage.deleteMany).toHaveBeenCalledWith(['resource-1'], expect.any(Function))
    expect(mirror.removeMany).toHaveBeenCalledWith(
      [
        { id: 'resource-1', scope: 'current' },
        { id: 'selected-history', scope: 'versions' },
      ],
      expect.any(Function),
    )
  })
  it('does not re-read or re-mirror all history for a descriptor-only change', async () => {
    mirror.stage.mockClear()
    const storage = {
      updateVersion: vi.fn(async () => undefined),
      listAllVersions: vi.fn(async () => {
        throw new Error('whole history read')
      }),
      getVersion: vi.fn(),
    } as unknown as ResourceStorageAdapter
    const adapter = new NativeMirroredResourceStorage(storage, {
      isEnabled: () => false,
    } as VaultService)
    const descriptor = {
      version: 2 as const,
      resourceId: 'history',
      contentHash: 'a'.repeat(64),
      size: 2,
      updatedAt: 1,
      parts: [],
    }
    await adapter.updateVersion('history', { backupDescriptor: descriptor })
    expect(storage.updateVersion).toHaveBeenCalledWith('history', { backupDescriptor: descriptor })
    await adapter.updateVersion('history', { versionNote: 'changed note' })
    expect(storage.updateVersion).toHaveBeenCalledWith('history', { versionNote: 'changed note' })
    expect(storage.listAllVersions).not.toHaveBeenCalled()
    expect(storage.getVersion).not.toHaveBeenCalled()
    expect(mirror.stage).not.toHaveBeenCalled()
  })
  it('keeps the original mirror path for changed file bytes and native display metadata', async () => {
    mirror.stage.mockReset().mockResolvedValue({ commit: mirror.commit, abort: mirror.abort })
    mirror.commit.mockReset().mockResolvedValue(undefined)
    let saved: Resource = { ...resource(), id: 'history', versionGroupId: 'current' }
    const backing = delegate(async () => undefined)
    backing.updateVersion = vi.fn(async (_id, changes) => {
      saved = { ...saved, ...changes }
    })
    backing.getVersion = vi.fn(async () => saved)
    const adapter = new NativeMirroredResourceStorage(backing, {
      isEnabled: () => false,
    } as VaultService)
    await adapter.updateVersion(saved.id, { metadata: { assetKind: 'userPersonaAvatar' } })
    expect(mirror.stage).toHaveBeenLastCalledWith(saved, 'versions')
    const originalBlob = new Blob(['replacement'])
    await adapter.updateVersion(saved.id, {
      originalBlob,
      contentHash: 'new-hash',
      fileSize: originalBlob.size,
    })
    expect(mirror.stage).toHaveBeenCalledTimes(2)
    expect(mirror.stage).toHaveBeenLastCalledWith(
      expect.objectContaining({ originalBlob, contentHash: 'new-hash' }),
      'versions',
    )
  })
})
