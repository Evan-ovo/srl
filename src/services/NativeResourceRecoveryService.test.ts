import 'fake-indexeddb/auto'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppDatabase } from '../database/AppDatabase'
import { JsonResourceParser } from '../parser/JsonResourceParser'
import { TextBeautificationParser } from '../parser/TextBeautificationParser'
import { ResourceParserRegistry } from '../parser/ResourceParser'
import { IndexedDbResourceHealthStorage } from '../storage/IndexedDbResourceHealthStorage'
import { IndexedDbResourceStorage } from '../storage/IndexedDbResourceStorage'
import { IndexedDbAssetStore } from '../storage/IndexedDbAssetStore'
import type { NativeRecoveryMetadata } from '../storage/NativeResourceFileMirror'
import { NativeResourceRecoveryService } from './NativeResourceRecoveryService'
import type { Resource } from '../types/Resource'
import type { NativeBackedResourceRecord } from '../types/Vault'
import * as nativeFiles from '../storage/NativeResourceFileMirror'

const cardText = JSON.stringify({
  spec: 'chara_card_v2',
  data: { name: '找回角色', description: '原始简介' },
})
const candidate = {
  contentHash: createHash('sha256').update(cardText).digest('hex'),
  size: new Blob([cardText]).size,
}
const empty = { created: 0, updated: 0, existing: 0, unsupported: 0, failed: 0, pendingLinks: 0 }

describe('NativeResourceRecoveryService', () => {
  it('deletes selected candidates in 100-item batches and stops before the next batch', async () => {
    const controller = new AbortController()
    const selected = Array.from({ length: 201 }, (_, index) => ({
      contentHash: index.toString(16).padStart(64, '0'),
      size: 1,
      modifiedAt: 1,
    }))
    const bridge = vi
      .spyOn(nativeFiles, 'deleteNativeRecoveryCandidates')
      .mockImplementation(async (items) => ({
        deletedHashes: items.map((item) => item.contentHash),
        retainedHashes: [],
        clearedBytes: items.length,
      }))
    await expect(
      service.deleteCandidates(selected, {
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(bridge).toHaveBeenCalledOnce()
    expect(bridge.mock.calls[0]![0]).toHaveLength(100)
    const report = await service.deleteCandidates(selected.slice(100))
    expect(report.deletedHashes).toHaveLength(101)
    expect(bridge.mock.calls.slice(1).map(([items]) => items.length)).toEqual([100, 1])
  })
  it('does not delete invalid/stale candidates or while vault protection is active, and validates native receipts', async () => {
    const bridge = vi
      .spyOn(nativeFiles, 'deleteNativeRecoveryCandidates')
      .mockResolvedValue({ deletedHashes: [], retainedHashes: [], clearedBytes: 0 })
    await expect(service.deleteCandidates([{ ...candidate, modifiedAt: -1 }])).rejects.toThrow(
      '时间无效',
    )
    expect(bridge).not.toHaveBeenCalled()
    vault = true
    await expect(service.deleteCandidates([{ ...candidate, modifiedAt: 1 }])).rejects.toThrow(
      '保险箱',
    )
    vault = false
    await expect(service.deleteCandidates([{ ...candidate, modifiedAt: 1 }])).rejects.toThrow(
      '回执不完整',
    )
  })
  let db: AppDatabase
  let health: IndexedDbResourceHealthStorage
  let storage: IndexedDbResourceStorage
  let service: NativeResourceRecoveryService
  let vault: boolean
  const inspect =
    vi.fn<(_candidate: typeof candidate, verify?: boolean) => Promise<NativeRecoveryMetadata>>()
  const link = vi.fn(async () => 1)
  const unlink = vi.fn(async () => 1)
  const verifyLinks = vi.fn(async (records: unknown[]) => records.length)
  beforeEach(() => {
    db = new AppDatabase(`native-recovery-${crypto.randomUUID()}`)
    storage = new IndexedDbResourceStorage(db)
    health = new IndexedDbResourceHealthStorage(db, storage)
    vault = false
    inspect.mockReset().mockResolvedValue({ kind: 'json', text: cardText })
    link.mockReset().mockResolvedValue(1)
    unlink.mockReset().mockResolvedValue(1)
    verifyLinks.mockReset().mockImplementation(async (records: unknown[]) => records.length)
    service = new NativeResourceRecoveryService(
      health,
      new ResourceParserRegistry([new JsonResourceParser(), new TextBeautificationParser()]),
      new IndexedDbAssetStore(db),
      () => vault,
      inspect,
      link,
      unlink,
      verifyLinks,
    )
  })
  afterEach(async () => {
    await db.delete()
    vi.restoreAllMocks()
  })

  it('parses using the existing registry and commits native references plus both indexes without saving originals', async () => {
    const save = vi.spyOn(storage, 'save')
    const rebuild = vi.spyOn(storage, 'repairDerivedIndexes')
    const preview = await service.preview(candidate)
    expect(preview).toEqual({ name: '找回角色', type: 'characterCard' })
    expect(inspect).toHaveBeenLastCalledWith(candidate, false)
    expect(await service.recover([candidate])).toEqual({ ...empty, created: 1 })
    expect(inspect).toHaveBeenLastCalledWith(candidate, true)
    const record = (await db.resources.toArray())[0]!
    expect(record).toMatchObject({
      type: 'characterCard',
      name: '找回角色',
      fileName: '找回角色.json',
      nativeOriginal: { contentHash: candidate.contentHash, size: candidate.size },
    })
    expect(record).not.toHaveProperty('originalBlob')
    expect(await db.resourceSummaries.get(record.id)).toMatchObject({ type: 'characterCard' })
    const list = await db.resourceListSummaries.get(record.id)
    expect(list).not.toHaveProperty('nativeOriginal')
    expect(list).not.toHaveProperty('originalBlob')
    expect(list && 'metadata' in list ? list.metadata : undefined).not.toHaveProperty('card')
    expect(save).not.toHaveBeenCalled()
    expect(rebuild).not.toHaveBeenCalled()
    expect(link).toHaveBeenCalledWith([
      expect.objectContaining({
        resourceType: 'characterCard',
        mimeType: 'application/json',
        scope: 'current',
      }),
    ])
  })

  it('short-circuits an already-known hash before parsing or creating a thumbnail asset', async () => {
    expect(await service.recover([candidate])).toEqual({ ...empty, created: 1 })
    expect(await db.assets.count()).toBe(0)
    inspect.mockClear()
    inspect.mockResolvedValue({
      kind: 'png',
      text: cardText,
      thumbnailBase64: btoa('unused-thumbnail'),
    })
    expect(await service.recover([candidate])).toEqual({ ...empty, existing: 1 })
    expect(inspect).not.toHaveBeenCalled()
    expect(await db.assets.count()).toBe(0)
    expect(await db.resources.count()).toBe(1)
  })

  it('reuses known content under its authoritative DB ID and retires only the stale native metadata ID', async () => {
    expect(await service.recover([candidate])).toEqual({ ...empty, created: 1 })
    const existing = (await db.resources.toArray())[0]!
    inspect.mockClear()
    link.mockClear()
    unlink.mockClear()
    const staleCandidate = {
      ...candidate,
      nativeId: 'crash-era-native-id',
      nativeScope: 'current' as const,
      fileName: '崩溃前名字.json',
    }
    expect(await service.recover([staleCandidate])).toEqual({ ...empty, existing: 1 })
    expect(inspect).not.toHaveBeenCalled()
    expect(await db.resources.count()).toBe(1)
    expect(await db.resources.get(existing.id)).toBeDefined()
    expect(await db.resources.get('crash-era-native-id')).toBeUndefined()
    expect(link).toHaveBeenCalledWith([
      expect.objectContaining({
        id: existing.id,
        scope: 'current',
        contentHash: candidate.contentHash,
      }),
    ])
    expect(unlink).toHaveBeenCalledWith([
      {
        scope: 'current',
        id: 'crash-era-native-id',
        contentHash: candidate.contentHash,
      },
    ])
  })

  it('does not unlink the native ID when recovery keeps that same surviving ID', async () => {
    const indexedCandidate = {
      ...candidate,
      nativeId: 'same-native-id',
      nativeScope: 'current' as const,
      fileName: '原来的角色卡.json',
    }
    expect(await service.recover([indexedCandidate])).toEqual({ ...empty, created: 1 })
    expect(unlink).not.toHaveBeenCalled()
  })

  it('preserves a surviving native current ID and original file name when the database row is gone', async () => {
    const indexedCandidate = {
      ...candidate,
      nativeId: 'surviving-native-id',
      nativeScope: 'current' as const,
      fileName: '原来的角色卡.json',
    }
    expect(await service.recover([indexedCandidate])).toEqual({ ...empty, created: 1 })
    const record = await db.resources.get('surviving-native-id')
    expect(record).toMatchObject({
      id: 'surviving-native-id',
      fileName: '原来的角色卡.json',
      type: 'characterCard',
      nativeOriginal: { contentHash: candidate.contentHash, size: candidate.size },
    })
    expect(await db.resources.count()).toBe(1)
  })

  it('retries failed native index links without duplicate rows or original bytes', async () => {
    link.mockRejectedValueOnce(new Error('index write failed'))
    expect(await service.recover([candidate])).toEqual({ ...empty, created: 1, pendingLinks: 1 })
    expect(await service.recover([candidate, candidate])).toEqual({ ...empty, existing: 1 })
    expect(await db.resources.count()).toBe(1)
    expect(await db.resourceSummaries.count()).toBe(1)
    expect(link).toHaveBeenCalledTimes(2)
  })

  it('persists failed links and repairs them after restart without parsing or duplicating originals', async () => {
    link.mockRejectedValueOnce(new Error('link failed'))
    await service.recover([candidate])
    expect((await service.storageAccounting()).pendingNativeLinkCount).toBe(1)
    inspect.mockClear()
    expect(await service.repairExisting()).toEqual({ ...empty, existing: 1 })
    expect(inspect).not.toHaveBeenCalled()
    expect((await service.storageAccounting()).pendingNativeLinkCount).toBe(0)
    expect(await db.resources.count()).toBe(1)
  })

  it('does not recreate a stale native index when the pending resource was subsequently removed', async () => {
    link.mockRejectedValueOnce(new Error('link failed'))
    await service.recover([candidate])
    await db.resources.clear()
    link.mockClear()
    expect(await service.repairExisting()).toEqual({ ...empty, pendingLinks: 1 })
    expect(link).not.toHaveBeenCalled()
    expect((await service.storageAccounting()).pendingNativeLinkCount).toBe(1)
  })

  it.each([
    ['worldBook', { name: 'Lore', entries: { 0: { content: 'Text' } } }],
    ['regex', { scriptName: 'Clean', findRegex: '/foo/g', replaceString: 'bar', placement: [2] }],
    [
      'preset',
      { chat_completion_source: 'openai', temperature: 1, top_p: 1, openai_max_context: 8192 },
    ],
    [
      'quickReply',
      {
        version: 2,
        name: 'Tools',
        disableSend: false,
        qrList: [{ label: 'Run', message: '/run' }],
      },
    ],
  ])(
    'recovers %s through the same parser without original Blob persistence',
    async (type, body) => {
      inspect.mockResolvedValue({ kind: 'json', text: JSON.stringify(body) })
      expect(await service.recover([candidate])).toEqual({ ...empty, created: 1 })
      const record = (await db.resources.toArray())[0]!
      expect(record).toMatchObject({ type })
      expect(record).not.toHaveProperty('originalBlob')
    },
  )

  it('reuses PNG metadata and CSS parsing without importing image bytes', async () => {
    inspect.mockResolvedValueOnce({ kind: 'png', text: cardText })
    expect(await service.recover([candidate])).toEqual({ ...empty, created: 1 })
    expect((await db.resources.toArray())[0]).toMatchObject({
      fileName: '找回角色.png',
      mimeType: 'image/png',
    })
    inspect.mockResolvedValueOnce({ kind: 'css', text: '/* 名称：夜色 */ body { color: #fff; }' })
    expect(await service.recover([{ contentHash: 'b'.repeat(64), size: 100 }])).toEqual({
      ...empty,
      created: 1,
    })
    expect(await db.resources.where('contentHash').equals('b'.repeat(64)).first()).toMatchObject({
      type: 'beautification',
      name: '夜色',
    })
  })

  it('repairs old placeholders in place and preserves manual organization and identifiers', async () => {
    await service.recover([candidate])
    const record = (await db.resources.toArray())[0] as NativeBackedResourceRecord
    const placeholder: NativeBackedResourceRecord = {
      ...record,
      type: 'other',
      name: '我改过的名字',
      description: '我的备注',
      fileName: `recovered-${candidate.contentHash.slice(0, 12)}.bin`,
      mimeType: 'application/octet-stream',
      favorite: true,
      categoryIds: ['my-folder'],
      relatedResourceIds: ['bound'],
      metadata: { recoveredFromNativeObject: true, authorNote: '不可覆盖' },
    }
    await db.resources.put(placeholder)
    expect(await service.repairExisting()).toEqual({ ...empty, updated: 1 })
    expect(await db.resources.get(record.id)).toMatchObject({
      id: record.id,
      name: '我改过的名字',
      description: '我的备注',
      type: 'characterCard',
      fileName: '找回角色.json',
      favorite: true,
      categoryIds: ['my-folder'],
      relatedResourceIds: ['bound'],
      nativeOriginal: record.nativeOriginal,
      metadata: { authorNote: '不可覆盖' },
    })
    expect(await db.resources.count()).toBe(1)
    expect(await service.repairExisting()).toEqual(empty)
  })

  it('does not re-register content already owned by a historical version', async () => {
    await service.recover([candidate])
    const record = (await db.resources.toArray())[0]!
    await db.resourceVersions.put({ ...record, versionGroupId: 'owner' })
    await db.resources.clear()
    expect(await service.recover([candidate])).toEqual({ ...empty, existing: 1 })
    expect(await db.resources.count()).toBe(0)
    expect(link).toHaveBeenLastCalledWith([
      expect.objectContaining({ scope: 'versions', id: record.id }),
    ])
  })

  it('does not leak a normal existing Blob into repaired summary indexes', async () => {
    await service.recover([candidate])
    const native = (await db.resources.toArray())[0] as NativeBackedResourceRecord
    const { nativeOriginal: _native, ...record } = native
    await db.resources.put({ ...record, originalBlob: new Blob([cardText]) } as Resource)
    expect(await service.recover([candidate])).toEqual({ ...empty, existing: 1 })
    expect(await db.resourceSummaries.get(record.id)).not.toHaveProperty('originalBlob')
    expect(await db.resourceListSummaries.get(record.id)).not.toHaveProperty('originalBlob')
  })

  it('rolls back a resource if incremental summary persistence fails', async () => {
    vi.spyOn(db.resourceSummaries, 'put').mockRejectedValueOnce(new Error('quota'))
    expect(await service.recover([candidate])).toEqual({ ...empty, failed: 1 })
    expect(await db.resources.count()).toBe(0)
    expect(link).not.toHaveBeenCalled()
  })

  it('leaves unknown chunks, unrecognized JSON and invalid originals untouched', async () => {
    inspect
      .mockResolvedValueOnce({ kind: 'unknown' })
      .mockResolvedValueOnce({ kind: 'json', text: '{"transportChunk":true}' })
      .mockRejectedValueOnce(new Error('hash mismatch'))
    expect(await service.recover([candidate])).toEqual({ ...empty, unsupported: 1 })
    expect(await service.recover([candidate])).toEqual({ ...empty, unsupported: 1 })
    expect(await service.recover([candidate])).toEqual({ ...empty, failed: 1 })
    expect(await db.resources.count()).toBe(0)
    expect(link).not.toHaveBeenCalled()
  })

  it('rejects plaintext personal secrets instead of bypassing the existing parser guard', async () => {
    inspect.mockResolvedValue({
      kind: 'json',
      text: JSON.stringify({
        format: 'srl-personal-resource',
        version: 1,
        kind: 'secret',
        name: 'private',
        fields: [{ id: 'a', label: 'password', value: 'secret', private: true }],
      }),
    })
    expect((await service.recover([candidate])).created).toBe(0)
    expect(await db.resources.count()).toBe(0)
  })

  it('blocks recovery and inspection under the vault', async () => {
    vault = true
    await expect(service.recover([candidate])).rejects.toThrow('保险箱')
    await expect(service.preview(candidate)).rejects.toThrow('保险箱')
    expect(inspect).not.toHaveBeenCalled()
  })

  it('accounts snapshots separately from originals without reading or deleting Blob contents', async () => {
    await service.recover([candidate])
    const original = (await db.resources.toArray())[0] as NativeBackedResourceRecord
    const { nativeOriginal: _native, ...record } = original
    await db.resources.put({ ...record, originalBlob: new Blob(['1234']) } as Resource)
    await db.resourceVersions.put({
      ...record,
      id: 'history',
      versionGroupId: record.id,
      originalBlob: new Blob(['123456']),
    } as Resource)
    await db.backupRecords.put({
      id: 'snapshot',
      adapter: 'local',
      objectKey: 'x',
      resourceCount: 1,
      createdAt: 1,
      blob: new Blob(['12345678']),
    })
    await db.restoreStagingChunks.put({
      jobId: 'job',
      path: 'x',
      chunkIndex: 0,
      updatedAt: 1,
      blob: new Blob(['123']),
    })
    const read = vi.spyOn(Blob.prototype, 'arrayBuffer')
    const text = vi.spyOn(Blob.prototype, 'text')
    expect(await service.storageAccounting()).toMatchObject({
      currentOriginalBytes: 4,
      versionOriginalBytes: 6,
      localSnapshotBytes: 8,
      restoreStagingBytes: 3,
    })
    expect(read).not.toHaveBeenCalled()
    expect(text).not.toHaveBeenCalled()
    expect(await db.backupRecords.count()).toBe(1)
  })

  it('releases only verified IndexedDB mirrors and keeps resource identities and summaries', async () => {
    await service.recover([candidate])
    const native = (await db.resources.toArray())[0] as NativeBackedResourceRecord
    const { nativeOriginal: _native, ...metadata } = native
    const current = { ...metadata, originalBlob: new Blob([cardText]) } as Resource
    const version = {
      ...metadata,
      id: 'history',
      versionGroupId: current.id,
      originalBlob: new Blob([cardText]),
    } as Resource
    await db.resources.put(current)
    await db.resourceVersions.put(version)

    await expect(service.nativeMirrorDuplicationSummary()).resolves.toMatchObject({
      currentCount: 1,
      versionCount: 1,
      reclaimableBytes: candidate.size * 2,
    })
    await expect(service.reclaimVerifiedNativeMirrors()).resolves.toMatchObject({
      convertedCurrent: 1,
      convertedVersions: 1,
      reclaimableBytes: candidate.size * 2,
    })
    expect(verifyLinks).toHaveBeenCalledWith([
      expect.objectContaining({ id: current.id, scope: 'current' }),
      expect.objectContaining({ id: 'history', scope: 'versions' }),
    ])
    expect(await db.resources.get(current.id)).toMatchObject({ nativeOriginal: candidate })
    expect(await db.resourceVersions.get('history')).toMatchObject({ nativeOriginal: candidate })
    expect(await db.resourceSummaries.get(current.id)).toBeDefined()
  })

  it('keeps every IndexedDB mirror when native SHA verification rejects a batch', async () => {
    await service.recover([candidate])
    const native = (await db.resources.toArray())[0] as NativeBackedResourceRecord
    const { nativeOriginal: _native, ...metadata } = native
    await db.resources.put({ ...metadata, originalBlob: new Blob([cardText]) } as Resource)
    verifyLinks.mockRejectedValueOnce(new Error('native hash mismatch'))

    await expect(service.reclaimVerifiedNativeMirrors()).rejects.toThrow('native hash mismatch')
    expect(await db.resources.get(metadata.id)).toHaveProperty('originalBlob')
  })
})
