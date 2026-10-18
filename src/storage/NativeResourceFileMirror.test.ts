import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RESOURCE_TYPE, type Resource } from '../types/Resource'
import { rememberNativeFile } from '../core/NativeFileSource'

const nativePlugin = vi.hoisted(() => ({
  getStorageInfo: vi.fn(),
  beginWrite: vi.fn(),
  appendWrite: vi.fn(),
  appendFile: vi.fn(),
  commitWrite: vi.fn(),
  abortWrite: vi.fn(),
  remove: vi.fn(),
  removeMany: vi.fn(),
  clear: vi.fn(),
  releaseReplacedObjects: vi.fn(),
  clearTemporaryCaches: vi.fn(),
  getObjectPath: vi.fn(),
  linkObjects: vi.fn(),
  matchCharacterCardCandidates: vi.fn(),
  beginCharacterCardParse: vi.fn(),
  appendCharacterCardParse: vi.fn(),
  finishCharacterCardParse: vi.fn(),
  parseCharacterCardUri: vi.fn(),
  cleanupCharacterCardParse: vi.fn(),
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    isPluginAvailable: () => true,
    convertFileSrc: (path: string) => `https://local.invalid/${encodeURIComponent(path)}`,
  },
  registerPlugin: () => nativePlugin,
}))

import {
  clearNativeResourceFiles,
  clearNativeTemporaryCaches,
  getNativeResourceStorageInfo,
  linkNativeResourceObjects,
  matchNativeCharacterCardCandidates,
  parseNativeCharacterCardFile,
  readNativeResourceObject,
  stageNativeResourceFile,
  removeNativeResourceFiles,
  releaseReplacedNativeObjects,
  retainNativeResourceFiles,
} from './NativeResourceFileMirror'

function resource(body = 'hello'): Resource {
  return {
    id: 'resource-1',
    type: RESOURCE_TYPE.OTHER,
    name: '资源',
    description: '',
    fileName: 'resource.json',
    mimeType: 'application/json',
    fileSize: body.length,
    contentHash: 'a'.repeat(64),
    favorite: false,
    categoryId: null,
    tags: [],
    metadata: {},
    originalBlob: new Blob([body]),
    createdAt: 1,
    updatedAt: 2,
  }
}

describe('NativeResourceFileMirror', () => {
  it.each(['commit', 'abort'] as const)(
    'settles an already-present staged link only at %s, without retransferring the original',
    async (action) => {
      nativePlugin.beginWrite.mockResolvedValueOnce({ alreadyPresent: true, token: 'link-token' })
      const handle = await stageNativeResourceFile(resource(), 'current')
      expect(nativePlugin.beginWrite).toHaveBeenCalledWith(
        expect.objectContaining({ deferCommit: true }),
      )
      expect(nativePlugin.commitWrite).not.toHaveBeenCalled()
      expect(nativePlugin.appendWrite).not.toHaveBeenCalled()
      await handle[action]()
      await handle[action]()
      expect(
        nativePlugin[action === 'commit' ? 'commitWrite' : 'abortWrite'],
      ).toHaveBeenCalledExactlyOnceWith({ token: 'link-token' })
      expect(
        nativePlugin[action === 'commit' ? 'abortWrite' : 'commitWrite'],
      ).not.toHaveBeenCalled()
    },
  )
  it('includes known superseded aliases when the next save can reclaim older replacement leftovers', async () => {
    const item = resource()
    item.metadata.recognizedFileHashes = ['c'.repeat(64), 'invalid', 'a'.repeat(64)]
    const handle = await stageNativeResourceFile(item, 'current')
    expect(handle.replacement?.replacedHashes).toEqual(['c'.repeat(64)])
  })
  it('defers replaced files through backup preparation and coalesces edits into one post-reader reference scan', async () => {
    const first = retainNativeResourceFiles(),
      second = retainNativeResourceFiles()
    const record = {
      scope: 'current' as const,
      id: 'edited',
      contentHash: 'b'.repeat(64),
      size: 5,
      replacedHashes: ['a'.repeat(64)],
    }
    await releaseReplacedNativeObjects([record])
    await releaseReplacedNativeObjects([
      { ...record, contentHash: 'c'.repeat(64), replacedHashes: ['b'.repeat(64)] },
    ])
    await first()
    expect(nativePlugin.releaseReplacedObjects).not.toHaveBeenCalled()
    await second()
    expect(nativePlugin.releaseReplacedObjects).toHaveBeenCalledExactlyOnceWith({
      records: [
        {
          ...record,
          contentHash: 'c'.repeat(64),
          replacedHashes: ['a'.repeat(64), 'b'.repeat(64)],
        },
      ],
    })
    await second()
    expect(nativePlugin.releaseReplacedObjects).toHaveBeenCalledOnce()
  })
  it.each([true, false])(
    'carries the exact previous native hash in a replacement receipt (alreadyPresent=%s)',
    async (alreadyPresent) => {
      nativePlugin.beginWrite.mockResolvedValueOnce({
        token: 'token-1',
        alreadyPresent,
        replacedHash: 'c'.repeat(64),
      })
      const handle = await stageNativeResourceFile(resource(), 'current')
      expect(handle.replacement).toEqual({
        scope: 'current',
        id: 'resource-1',
        contentHash: 'a'.repeat(64),
        size: 5,
        replacedHashes: ['c'.repeat(64)],
      })
      expect(nativePlugin.releaseReplacedObjects).not.toHaveBeenCalled()
      await handle.commit()
      await releaseReplacedNativeObjects([handle.replacement!])
      expect(nativePlugin.releaseReplacedObjects).toHaveBeenCalledWith({
        records: [handle.replacement],
      })
    },
  )
  it('原件已有原生路径时直接流式复制，不再把正文通过 Base64 送回原生', async () => {
    const item = resource()
    rememberNativeFile(item.originalBlob, 'file:///shared/original.json')
    const handle = await stageNativeResourceFile(item, 'current')
    expect(nativePlugin.appendFile).toHaveBeenCalledWith({
      token: 'token-1',
      uri: 'file:///shared/original.json',
    })
    expect(nativePlugin.appendWrite).not.toHaveBeenCalled()
    expect(nativePlugin.commitWrite).not.toHaveBeenCalled()
    await handle.commit()
    expect(nativePlugin.commitWrite).toHaveBeenCalledOnce()
  })
  it('deletes in bounded native batches and reports actual completion', async () => {
    nativePlugin.removeMany.mockResolvedValue(undefined)
    const records = Array.from({ length: 257 }, (_, i) => ({
      id: `item-${i}`,
      scope: 'current' as const,
    }))
    const progress = vi.fn()
    await removeNativeResourceFiles(records, progress)
    expect(nativePlugin.removeMany.mock.calls.map(([value]) => value.records.length)).toEqual([
      128, 128, 1,
    ])
    expect(progress.mock.calls.flat()).toEqual([128, 256, 257])
    expect(nativePlugin.remove).not.toHaveBeenCalled()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    nativePlugin.beginWrite.mockResolvedValue({ alreadyPresent: false, token: 'token-1' })
    nativePlugin.appendWrite.mockResolvedValue(undefined)
    nativePlugin.commitWrite.mockResolvedValue(undefined)
    nativePlugin.abortWrite.mockResolvedValue(undefined)
    nativePlugin.clear.mockResolvedValue(undefined)
    nativePlugin.clearTemporaryCaches.mockResolvedValue({ clearedBytes: 12 })
    nativePlugin.getStorageInfo.mockResolvedValue({
      storageVersion: 2,
      path: '/storage/Documents/SRL/library',
      currentCount: 1,
      versionCount: 2,
      objectCount: 2,
      objectBytes: 7,
      appDataBytes: 20,
      externalDataBytes: 30,
      totalBytes: 50,
      availableBytes: 100,
    })
    nativePlugin.getObjectPath.mockResolvedValue({ path: 'file:///library/object.bin', size: 5 })
    nativePlugin.linkObjects.mockResolvedValue({ linked: 1 })
    nativePlugin.beginCharacterCardParse.mockResolvedValue({ token: 'parse-token', size: 9 })
    nativePlugin.appendCharacterCardParse.mockResolvedValue(undefined)
    nativePlugin.finishCharacterCardParse.mockResolvedValue({
      token: 'parse-token',
      state: 'parsed',
      parsedResourceUri: 'file:///parsed-card.json',
    })
    nativePlugin.cleanupCharacterCardParse.mockResolvedValue(undefined)
    nativePlugin.parseCharacterCardUri.mockResolvedValue({ state: 'not_character_card' })
  })

  it('分块写入后只在调用 commit 时提交原生文件', async () => {
    const handle = await stageNativeResourceFile(resource(), 'current')

    expect(nativePlugin.beginWrite).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'current', id: 'resource-1', size: 5 }),
    )
    expect(nativePlugin.appendWrite).toHaveBeenCalledWith({
      token: 'token-1',
      data: btoa('hello'),
    })
    expect(nativePlugin.commitWrite).not.toHaveBeenCalled()

    await handle.commit()
    expect(nativePlugin.commitWrite).toHaveBeenCalledWith({ token: 'token-1' })
  })

  it('暴露原生目录状态并能在保险库开启前清理明文镜像', async () => {
    await expect(getNativeResourceStorageInfo()).resolves.toEqual({
      storageVersion: 2,
      path: '/storage/Documents/SRL/library',
      currentCount: 1,
      versionCount: 2,
      objectCount: 2,
      objectBytes: 7,
      appDataBytes: 20,
      externalDataBytes: 30,
      totalBytes: 50,
      availableBytes: 100,
    })
    await clearNativeResourceFiles()
    expect(nativePlugin.clear).toHaveBeenCalledOnce()
  })

  it('请求清理 APK 的可丢弃缓存目录', async () => {
    await expect(clearNativeTemporaryCaches()).resolves.toBe(12)
    expect(nativePlugin.clearTemporaryCaches).toHaveBeenCalledOnce()
    expect(nativePlugin.clear).not.toHaveBeenCalled()
  })

  it('only requests detailed accounting explicitly, keeping ordinary refreshes out of the database scan', async () => {
    await getNativeResourceStorageInfo()
    expect(nativePlugin.getStorageInfo).toHaveBeenLastCalledWith()
    await getNativeResourceStorageInfo({ includeDetails: false })
    expect(nativePlugin.getStorageInfo).toHaveBeenLastCalledWith()
    await getNativeResourceStorageInfo({ includeDetails: true })
    expect(nativePlugin.getStorageInfo).toHaveBeenLastCalledWith({ includeDetails: true })
  })

  it('restricts retired model cleanup to an explicit native scope', async () => {
    await expect(clearNativeTemporaryCaches({ scope: 'retiredTranslationModels' })).resolves.toBe(
      12,
    )
    expect(nativePlugin.clearTemporaryCaches).toHaveBeenCalledWith({
      scope: 'retiredTranslationModels',
    })
    expect(nativePlugin.clear).not.toHaveBeenCalled()
  })

  it('按需从 NativeLibrary 文件 URL 读取对象，不经过 Base64 bridge', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Blob(['hello'], { type: 'application/json' }))),
    )

    const blob = await readNativeResourceObject('a'.repeat(64), 5, 'application/json')

    await expect(blob.text()).resolves.toBe('hello')
    expect(nativePlugin.getObjectPath).toHaveBeenCalledWith({
      contentHash: 'a'.repeat(64),
      size: 5,
    })
    expect(nativePlugin.appendWrite).not.toHaveBeenCalled()
  })

  it('恢复索引只链接已校验内容寻址对象，不重新发送文件内容', async () => {
    await expect(
      linkNativeResourceObjects([
        {
          scope: 'current',
          id: 'resource-1',
          fileName: 'resource.json',
          mimeType: 'application/json',
          resourceType: 'other',
          hiddenFromDocuments: false,
          contentHash: 'a'.repeat(64),
          size: 5,
          updatedAt: 2,
        },
      ]),
    ).resolves.toBe(1)
    expect(nativePlugin.linkObjects).toHaveBeenCalledOnce()
    expect(nativePlugin.appendWrite).not.toHaveBeenCalled()
  })

  it('把实时版本候选分批交给 Android 原生匹配器', async () => {
    nativePlugin.matchCharacterCardCandidates.mockImplementation(async ({ candidates }) => ({
      candidates: candidates.length
        ? [
            {
              resourceId: String(candidates[0]?.id),
              historical: false,
              score: 90,
              matchKind: 'version',
              reasons: [],
            },
          ]
        : [],
    }))
    const candidates = Array.from({ length: 201 }, (_, index) => ({
      id: `card-${index}`,
      type: 'characterCard',
      metadata: {},
    }))

    const matched = await matchNativeCharacterCardCandidates(
      {
        type: 'characterCard',
        name: '卡片',
        description: '',
        tags: [],
        metadata: { card: { name: '卡片' } },
      },
      'incoming.json',
      candidates,
      false,
    )

    expect(nativePlugin.matchCharacterCardCandidates).toHaveBeenCalledTimes(2)
    expect(
      nativePlugin.matchCharacterCardCandidates.mock.calls.map(
        ([value]) => value.candidates.length,
      ),
    ).toEqual([200, 1])
    expect(matched?.map((candidate) => candidate.resourceId)).toEqual(['card-0', 'card-200'])
  })

  it('普通文件选择器的角色卡通过有界分块交给 APK 原生解析', async () => {
    const parsed = {
      type: 'characterCard',
      name: '原生卡',
      description: '',
      metadata: { card: { name: '原生卡' }, cardFingerprintVersion: 4 },
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(parsed))),
    )
    const file = new File(['{"card":1}'], 'card.json', { type: 'application/json' })

    await expect(parseNativeCharacterCardFile(file)).resolves.toEqual(parsed)

    expect(nativePlugin.beginCharacterCardParse).toHaveBeenCalledWith({
      fileName: 'card.json',
      size: 10,
    })
    expect(nativePlugin.appendCharacterCardParse).toHaveBeenCalledWith({
      token: 'parse-token',
      size: 10,
      data: expect.any(String),
    })
    expect(nativePlugin.finishCharacterCardParse).toHaveBeenCalledWith({
      token: 'parse-token',
      fileName: 'card.json',
      size: 10,
    })
    expect(nativePlugin.cleanupCharacterCardParse).toHaveBeenCalledWith({ token: 'parse-token' })
  })
})

describe('backup-only native identity query', () => {
  it('requests identity without directory usage but retains full usage for storage management', async () => {
    nativePlugin.getStorageInfo.mockResolvedValue({
      storageVersion: 4,
      currentCount: 3,
      versionCount: 2,
    })
    await getNativeResourceStorageInfo(false)
    expect(nativePlugin.getStorageInfo).toHaveBeenLastCalledWith({ includeUsage: false })
    await getNativeResourceStorageInfo()
    expect(nativePlugin.getStorageInfo.mock.calls.at(-1)).toEqual([])
  })
})
