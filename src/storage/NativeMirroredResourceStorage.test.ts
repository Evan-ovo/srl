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
}))

vi.mock('./NativeResourceFileMirror', () => ({
  stageNativeResourceFile: mirror.stage,
  isAndroidNativeResourceMirrorAvailable: mirror.available,
  clearNativeResourceFiles: mirror.clear,
  removeNativeResourceFile: mirror.remove,
  removeNativeResourceFiles: mirror.removeMany,
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
  beforeEach(() => {
    vi.clearAllMocks()
    mirror.stage.mockResolvedValue({ commit: mirror.commit, abort: mirror.abort })
    mirror.commit.mockResolvedValue(undefined)
    mirror.abort.mockResolvedValue(undefined)
    mirror.clear.mockResolvedValue(undefined)
    mirror.available.mockReturnValue(true)
  })

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
    expect(storage.listAllVersions).not.toHaveBeenCalled()
    expect(storage.getVersion).not.toHaveBeenCalled()
  })
})
