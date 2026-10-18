import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { AppDatabase } from '../database/AppDatabase'
import { IndexedDbArchiveStorage } from '../storage/IndexedDbArchiveStorage'
import { IndexedDbAssetStore } from '../storage/IndexedDbAssetStore'
import { IndexedDbCommunitySourceStorage } from '../storage/IndexedDbCommunitySourceStorage'
import { MemoryRestoreStagingStore } from '../storage/RestoreStagingStore'
import { RESOURCE_TYPE, type Resource, type ResourceSummary } from '../types/Resource'
import type { ArchivePortableData } from '../types/Backup'
import type { CommunitySourceBackupData } from '../types/CommunitySource'
import { CommunitySourceRestoreService } from './CommunitySourceRestoreService'
import { restoreCommunitySourceLocalAttachments } from './CommunitySourceAttachmentArchive'
import { VaultService } from './VaultService'
import { SecretResourceService } from './SecretResourceService'
import { hashCloudBlob } from './CloudArchiveCodec'
import {
  createStructuredSnapshot,
  decodeStructuredSnapshot,
  encodeStructuredSnapshot,
  parseStructuredSnapshot,
  structuredSnapshotParts,
} from './CloudStructuredSnapshot'
import {
  portableRestoreScopeIds,
  selectRestorePortableData,
  selectStructuredSnapshot,
} from './BackupRestoreSelection'
import { BACKUP_SCOPE_REGISTRY } from './BackupScopeRegistry'
import {
  buildNativeRestorePlan,
  materializeStructuredArchive,
  type CloudBackupSnapshotOperationsContext,
  prune,
} from './CloudBackupSnapshotOperations'
import { ExportService } from './ExportService'
import { GeneratedImageAlbumService } from './GeneratedImageAlbumService'
import { IndexedDbGeneratedImageAlbumStorage } from '../storage/IndexedDbGeneratedImageAlbumStorage'
import type { ArchiveRestoreProgress } from '../storage/ArchiveStorageAdapter'

vi.mock('../utils/createImageThumbnail', () => ({ createImageThumbnail: async () => undefined }))

async function resource(
  id: string,
  type: Resource['type'] = RESOURCE_TYPE.OTHER,
  text = id,
): Promise<Resource> {
  const originalBlob = new Blob([text], { type: 'application/json' })
  return {
    id,
    type,
    name: id,
    fileName: `${id}.json`,
    description: 'saved description',
    mimeType: originalBlob.type,
    fileSize: originalBlob.size,
    contentHash: await hashCloudBlob(originalBlob),
    originalBlob,
    favorite: true,
    categoryId: 'folder',
    categoryIds: ['folder'],
    tags: ['saved tag'],
    metadata: {
      custom: 'preserved',
      ...(type === RESOURCE_TYPE.CHARACTER_CARD ? { card: { name: id } } : {}),
    },
    createdAt: 1,
    updatedAt: 2,
  }
}

function community(assetId?: string): CommunitySourceBackupData {
  const sourceId = 'saved-source'
  const message = {
    id: 'saved-message',
    sourceId,
    messageKeyHash: 'b'.repeat(64),
    messageId: 'message-a',
    kind: 'starter' as const,
    authorId: 'author-a',
    authorName: 'saved author',
    content: '完整正文及评论。'.repeat(3000),
    embeds: [],
    attachments: assetId
      ? [
          {
            id: 'file-a',
            name: 'saved.txt',
            size: 11,
            url: 'https://cdn.discordapp.com/attachments/test/file',
            contentType: 'text/plain',
            localAssetId: assetId,
            localState: 'local' as const,
          },
        ]
      : [],
    canonicalUrl: 'https://discord.com/channels/guild/thread/message',
    timestamp: '2026-10-18T00:00:00.000Z',
    capturedAt: 1,
    updatedAt: 2,
  }
  return {
    version: 1,
    sources: [
      {
        id: sourceId,
        platform: 'discord',
        sourceKeyHash: 'a'.repeat(64),
        guildId: 'guild-a',
        channelId: 'thread-a',
        threadId: 'thread-a',
        starterMessageId: 'message-a',
        canonicalUrl: message.canonicalUrl,
        title: 'saved post',
        starterAuthorId: 'author-a',
        starterAuthorName: 'saved author',
        forumTags: ['tag'],
        createdAt: 1,
        updatedAt: 2,
        revisions: [
          {
            id: 'revision',
            createdAt: 1,
            source: {
              title: 'old post',
              forumTags: [],
              starterAuthorName: 'saved author',
              canonicalUrl: message.canonicalUrl,
              updatedAt: 1,
            },
            messages: [{ ...message, content: 'old saved body' }],
          },
        ],
      },
    ],
    messages: [message],
    bindings: [{ id: 'remote:source:saved-source', resourceId: 'remote', sourceId, createdAt: 2 }],
  }
}

function reader(created: Awaited<ReturnType<typeof createStructuredSnapshot>>) {
  return vi.fn(async (object: import('./GitHubBackupBundle').GitHubBundleManifest) => {
    const blob = new Blob(
      object.parts.map((part) =>
        created.chunks.get(part.name)!.slice(part.offset ?? 0, (part.offset ?? 0) + part.size),
      ),
    )
    if (blob.size !== object.totalSize || (await hashCloudBlob(blob)) !== object.totalSha256)
      throw new Error('fixture object integrity failed')
    return blob
  })
}

describe('cloud backup registered content round trips', () => {
  it.each(['complete', 'failed', 'cancelled'] as const)(
    'reports whole preparation progress before album/Discord downloads and preserves it across resources: %s',
    async (mode) => {
      const db = new AppDatabase(`cloud-whole-progress-${crypto.randomUUID()}`)
      const image = new Blob(['album image'], { type: 'image/png' })
      const attachment = new Blob(['saved bytes'], { type: 'text/plain' })
      const assetId = `asset-${await hashCloudBlob(attachment)}`
      const original = await resource('remote')
      const created = await createStructuredSnapshot(
        [original],
        [],
        [],
        {
          version: 1,
          generatedImageAlbum: [
            {
              item: {
                id: 'album',
                name: 'album.png',
                source: 'imported',
                category: '',
                mimeType: 'image/png',
                sizeBytes: image.size,
                createdAt: 1,
                updatedAt: 1,
              },
            },
          ],
          communitySources: { data: community(assetId), attachments: [] },
        },
        { readAlbumFile: async () => image, readAttachment: async () => attachment },
      )
      const events: ArchiveRestoreProgress[] = []
      const controller = new AbortController()
      const album = new GeneratedImageAlbumService(
        new IndexedDbGeneratedImageAlbumStorage(db),
        async () => {
          throw new Error('unused')
        },
      )
      const service = new CommunitySourceRestoreService(
        new IndexedDbArchiveStorage(db),
        new MemoryRestoreStagingStore(),
        {
          restoreBackup: async () => {},
          replaceAll: async () => {},
        },
        (entries) => restoreCommunitySourceLocalAttachments(new IndexedDbAssetStore(db), entries),
        album,
      )
      const blobs = new Map([
        [await hashCloudBlob(image), image],
        [await hashCloudBlob(attachment), attachment],
        [original.contentHash, original.originalBlob],
      ])
      const read = vi.fn(async (object: import('./GitHubBackupBundle').GitHubBundleManifest) => {
        expect(events.at(-1)).toMatchObject({ phase: 'prepare', total: 3 })
        if (object.totalSha256 === (await hashCloudBlob(attachment))) {
          expect(events.at(-1)?.completed).toBe(1)
          if (mode === 'failed') throw new Error('attachment download failed')
          if (mode === 'cancelled') controller.abort(new DOMException('stopped', 'AbortError'))
        }
        return blobs.get(object.totalSha256)!
      })
      try {
        const restoring = service.restoreStructured(created.snapshot, read, [], [], 'progress', {
          signal: controller.signal,
          onProgress: (progress) => events.push(progress),
        })
        if (mode === 'complete') {
          await restoring
          const counts = events.filter((e) => e.phase === 'prepare').map((e) => e.completed)
          expect(counts).toEqual([...counts].sort((a, b) => a - b))
          expect(new Set(counts)).toEqual(new Set([0, 1, 2, 3]))
          expect(read).toHaveBeenCalledTimes(3)
          expect((await db.resources.get('remote'))?.contentHash).toBe(original.contentHash)
        } else {
          await expect(restoring).rejects.toThrow(
            mode === 'failed' ? 'attachment download failed' : 'stopped',
          )
          expect(events.every((e) => e.phase === 'prepare' && e.completed <= 1)).toBe(true)
          expect(read).toHaveBeenCalledTimes(2)
          expect(await db.resources.count()).toBe(0)
        }
      } finally {
        db.close()
        await db.delete()
      }
    },
  )
  it.each([4, 5] as const)(
    'keeps ordinary revision 3 and prevents old retention readers from deleting revision %s data',
    async (revision) => {
      const ordinary = await createStructuredSnapshot([], [], [], { version: 1 })
      const created = await createStructuredSnapshot([], [], [], {
        version: 1,
        communitySources: { data: community(), attachments: [] },
        ...(revision === 5 ? { generatedImageAlbum: [] } : {}),
      })
      expect(ordinary.snapshot.version).toBe(3)
      expect(created.snapshot.version).toBe(revision)
      expect(parseStructuredSnapshot(created.snapshot).version).toBe(revision)
      expect(() => parseStructuredSnapshot({ ...created.snapshot, version: 3 })).toThrow('修订 4')
      // The strict revision gate in the released 0d904176 decoder accepts only 1/2/3.
      // Keeping the same filename family makes its raw retention inventory see this
      // manifest, then its unsupported-revision error stops deletion before objects.
      const legacyRead = async () => {
        if (!(revision === 5 ? [1, 2, 3, 4] : [1, 2, 3]).includes(created.snapshot.version))
          throw new Error('unsupported manifest revision')
        return created.snapshot
      }
      const deletion = vi.fn()
      const context = {
        listRetentionBackups: async () => [
          {
            id: 'community',
            objectKey: 'snapshots/community.srlmanifest.v3.json.gz',
            kind: 'webdavSnapshot',
            size: 1,
            createdAt: 1,
          },
        ],
        readWebDavStructuredSnapshot: legacyRead,
        deleteWebDavObject: deletion,
        transportState: { jobStore: { pendingOrphans: async () => [] } },
      } as unknown as CloudBackupSnapshotOperationsContext
      await expect(
        prune(
          context,
          {
            provider: 'webdav',
            baseUrl: 'https://example.test/dav',
            folder: 'backup',
            username: 'fixture',
            retention: 1,
            autoBackup: false,
          },
          'fixture',
          undefined,
          true,
        ),
      ).rejects.toThrow('unsupported manifest revision')
      expect(deletion).not.toHaveBeenCalled()
    },
  )
  it.each(['duplicate', 'id-conflict', 'posts-only'] as const)(
    'restores saved posts, revisions, binding identities and attachment bytes: %s',
    async (mode) => {
      const dbName = `cloud-community-${crypto.randomUUID()}`
      let db = new AppDatabase(dbName)
      const original = new Blob(['saved bytes'], { type: 'text/plain' })
      const assetId = `asset-${await hashCloudBlob(original)}`
      const data = community(assetId)
      const remote = await resource('remote')
      const attachmentRead = vi.fn(async () => original)
      const created = await createStructuredSnapshot(
        [remote],
        [],
        [],
        {
          version: 1,
          communitySources: { data, attachments: [] },
          generalPreferences: {
            previewPolicy: { allowScripts: false, allowRemoteResources: false },
            extractCharacterAssets: false,
            hideCharacterAssets: true,
            searchHistory: [],
            cabinetResourceIds: ['remote'],
          },
        },
        { readAttachment: attachmentRead },
      )
      expect(attachmentRead).toHaveBeenCalledOnce()
      const snapshot = await decodeStructuredSnapshot(
        await encodeStructuredSnapshot(created.snapshot),
      )
      expect(portableRestoreScopeIds(snapshot.portableData)).toContain('extra.communitySources')
      expect(structuredSnapshotParts(snapshot)).toHaveLength(2)
      const existing =
        mode === 'duplicate'
          ? { ...remote, id: 'existing-local' }
          : mode === 'id-conflict'
            ? await resource('remote', RESOURCE_TYPE.OTHER, 'local content')
            : undefined
      if (existing) await new IndexedDbArchiveStorage(db).restore([], [existing])
      const vault = new VaultService(db)
      const sources = new IndexedDbCommunitySourceStorage(db, vault)
      const assetStore = new IndexedDbAssetStore(db)
      const service = new CommunitySourceRestoreService(
        new IndexedDbArchiveStorage(db),
        new MemoryRestoreStagingStore(),
        {
          restoreBackup: (value) => sources.mergeAll(value),
          replaceAll: (value) => sources.replaceAll(value),
        },
        (entries) => restoreCommunitySourceLocalAttachments(assetStore, entries),
      )
      try {
        const selected =
          mode === 'posts-only' ? selectStructuredSnapshot(snapshot, new Set()) : snapshot
        const objectReader = reader(created)
        const report = await service.restoreStructured(
          selected,
          objectReader,
          existing ? [existing] : [],
          [],
          'cloud',
        )
        expect(report.restoredCommunitySources).toBe(1)
        expect(objectReader).toHaveBeenCalledTimes(mode === 'id-conflict' ? 2 : 1)
        const stored = await sources.exportAll()
        expect(stored.messages[0]?.content).toBe(data.messages[0]!.content)
        expect(stored.sources[0]?.revisions?.[0]?.messages[0]?.content).toBe('old saved body')
        expect(stored.messages[0]?.attachments[0]?.localAssetId).toBe(assetId)
        expect(await (await assetStore.getBlob(assetId))!.text()).toBe('saved bytes')
        if (mode === 'posts-only') expect(stored.bindings).toEqual([])
        else {
          const targetId = stored.bindings[0]!.resourceId
          if (mode === 'duplicate') expect(targetId).toBe('existing-local')
          else expect(targetId).not.toBe('remote')
          expect(await db.resources.get(targetId)).toBeDefined()
          expect(report.portableData?.generalPreferences?.cabinetResourceIds).toEqual([targetId])
        }
        objectReader.mockClear()
        const beforeRepeat = await db.resources.count()
        await service.restoreStructured(
          selected,
          objectReader,
          (await db.resourceSummaries.toArray()) as ResourceSummary[],
          [],
          'cloud',
        )
        expect(await db.resources.count()).toBe(beforeRepeat)
        expect((await sources.exportAll()).sources).toHaveLength(1)
        expect(objectReader).toHaveBeenCalledOnce() // Only the selected saved attachment is revalidated.
        // Reopen the actual persisted database; successful in-memory objects are insufficient.
        db.close()
        db = new AppDatabase(dbName)
        const reread = await new IndexedDbCommunitySourceStorage(
          db,
          new VaultService(db),
        ).exportAll()
        expect(reread.messages[0]?.content).toBe(data.messages[0]!.content)
        expect(await (await new IndexedDbAssetStore(db).getBlob(assetId))!.text()).toBe(
          'saved bytes',
        )
      } finally {
        db.close()
        await db.delete()
      }
    },
  )

  it.each(['corrupt', 'deselected'] as const)(
    'never commits missing post data when its attachment is %s',
    async (mode) => {
      const db = new AppDatabase(`cloud-attachment-${crypto.randomUUID()}`)
      const original = new Blob(['saved bytes'])
      const data = community(`asset-${await hashCloudBlob(original)}`)
      const created = await createStructuredSnapshot(
        [await resource('remote')],
        [],
        [],
        { version: 1, communitySources: { data, attachments: [] } },
        { readAttachment: async () => original },
      )
      const sources = new IndexedDbCommunitySourceStorage(db, new VaultService(db))
      const assets = new IndexedDbAssetStore(db)
      const sourceRestore = vi.fn((value: CommunitySourceBackupData) => sources.mergeAll(value))
      const service = new CommunitySourceRestoreService(
        new IndexedDbArchiveStorage(db),
        new MemoryRestoreStagingStore(),
        { restoreBackup: sourceRestore, replaceAll: (value) => sources.replaceAll(value) },
        (entries) => restoreCommunitySourceLocalAttachments(assets, entries),
      )
      try {
        if (mode === 'corrupt') {
          const part =
            created.snapshot.portableData.communitySources!.attachments[0]!.object.parts[0]!
          created.chunks.set(part.name, new Blob(['wrong bytes']))
          await expect(
            service.restoreStructured(created.snapshot, reader(created), [], [], 'cloud'),
          ).rejects.toThrow('integrity')
          expect(await db.resources.count()).toBe(0)
        } else {
          const selected = {
            ...created.snapshot,
            portableData: selectRestorePortableData(created.snapshot.portableData, [])!,
          }
          const read = reader(created)
          await service.restoreStructured(selected, read, [], [], 'cloud')
          expect(read).toHaveBeenCalledOnce()
          expect(await db.resources.count()).toBe(1)
        }
        expect(sourceRestore).not.toHaveBeenCalled()
        expect(await db.assets.count()).toBe(0)
        expect(await db.restoreStaging.count()).toBe(0)
      } finally {
        db.close()
        await db.delete()
      }
    },
  )

  it('rejects missing, wrong and unlisted local attachments instead of reporting a complete backup', async () => {
    const assetId = `asset-${'a'.repeat(64)}`
    const portable: ArchivePortableData = {
      version: 1,
      communitySources: { data: community(assetId), attachments: [] },
    }
    await expect(createStructuredSnapshot([], [], [], portable)).rejects.toThrow('附件缺失')
    await expect(
      createStructuredSnapshot([], [], [], portable, {
        readAttachment: async () => new Blob(['wrong']),
      }),
    ).rejects.toThrow('完整性校验失败')
    expect(() =>
      parseStructuredSnapshot({
        format: 'srl-structured-cloud-snapshot',
        version: 4,
        createdAt: new Date().toISOString(),
        resources: [],
        versions: [],
        categories: [],
        portableData: portable,
      }),
    ).toThrow('缺少已保存附件')
    const stopped = new AbortController()
    stopped.abort()
    const readAttachment = vi.fn()
    await expect(
      createStructuredSnapshot([], [], [], portable, {
        readAttachment,
        signal: stopped.signal,
      }),
    ).rejects.toThrow()
    expect(readAttachment).not.toHaveBeenCalled()
  })

  it('includes attachment references in native download plans and converts cloud sidecars into offline ZIPs', async () => {
    const blob = new Blob(['saved bytes'], { type: 'text/plain' })
    const data = community(`asset-${await hashCloudBlob(blob)}`)
    const created = await createStructuredSnapshot(
      [],
      [],
      [],
      { version: 1, communitySources: { data, attachments: [] } },
      { readAttachment: async () => blob },
    )
    const readObject = reader(created)
    const config = {
      provider: 'webdav' as const,
      baseUrl: 'https://example.test/dav',
      folder: 'backup',
      username: 'fixture',
      retention: 1,
      autoBackup: false,
    }
    const context = {
      readWebDavStructuredSnapshot: async () => created.snapshot,
      createWebDavObjectReader: () => readObject,
      exportService: new ExportService(),
    } as unknown as CloudBackupSnapshotOperationsContext
    const plan = await buildNativeRestorePlan(context, created.snapshot, config, 'fixture')
    expect(plan.resources).toHaveLength(1)
    expect(plan.objects).toHaveLength(1)
    expect(plan.resources[0]!.hash).toBe(await hashCloudBlob(blob))
    const archive = await materializeStructuredArchive(
      context,
      { id: 'manifest', objectKey: 'snapshot.srlmanifest.v3.json.gz', size: 1, createdAt: 1 },
      config,
      'fixture',
    )
    const prepared = await new CommunitySourceRestoreService(
      new IndexedDbArchiveStorage(new AppDatabase(`zip-${crypto.randomUUID()}`)),
      new MemoryRestoreStagingStore(),
      { restoreBackup: async () => {}, replaceAll: async () => {} },
    ).prepare(new File([archive.blob], 'backup.zip'), [], [])
    expect(prepared.communitySourceData?.messages[0]?.content === data.messages[0]!.content).toBe(
      true,
    )
    expect(prepared.communitySourceAttachments).toHaveLength(1)
    expect(await prepared.communitySourceAttachments![0]!.blob.text()).toBe('saved bytes')
    expect(prepared.portableData?.communitySources).toBeUndefined()
  })

  it('preserves every registered extra scope through JSON/gzip and selects each scope independently', async () => {
    const populated = {
      version: 1,
      communitySources: { data: community(), attachments: [] },
      resourceGalleryCategories: {},
      appearance: {},
      cloudBackup: {},
      characterDraw: {},
      generalPreferences: {},
      mainApiProfiles: {},
      credentials: { version: 1 },
      aiTaggingState: {},
      externalApps: { apps: [], data: [] },
      chatReader: [],
      assistantData: [],
      stitchWork: {},
      frontendWorkshopComponents: [],
      frontendWorkshopProjects: {
        version: 1,
        projects: [],
        lastGood: [],
        documents: [],
        documentLastGood: [],
        components: [],
        sessions: [],
      },
      imageGeneration: {
        configurations: [],
        work: { version: 1, store: { version: 2, drafts: {} }, templates: [] },
      },
      generatedImageAlbum: [],
      plaintextSecretCopies: [],
    } as unknown as ArchivePortableData
    const created = await createStructuredSnapshot([], [], [], populated)
    const snapshot = await decodeStructuredSnapshot(
      await encodeStructuredSnapshot(created.snapshot),
    )
    // Resource attachments use resource descriptors/binaries, not portableData fields.
    const scopes = BACKUP_SCOPE_REGISTRY.filter(
      (entry) => entry.group === 'extraContent' && entry.id !== 'extra.resourceAttachments',
    ).map((entry) => entry.id)
    expect(new Set(portableRestoreScopeIds(snapshot.portableData))).toEqual(new Set(scopes))
    expect(selectRestorePortableData(snapshot.portableData, [])).toEqual({ version: 1 })
    for (const scope of scopes) {
      const selected = selectRestorePortableData(snapshot.portableData, [scope])!
      expect(portableRestoreScopeIds(selected)).toEqual([scope])
      for (const [field, value] of Object.entries(selected))
        expect(populated[field as keyof ArchivePortableData]).toEqual(value)
    }
  })

  it.each(Object.values(RESOURCE_TYPE))(
    'reads original bytes and saved metadata/history back from storage for %s',
    async (type) => {
      let text = JSON.stringify({ type, body: 'saved original' })
      if (type === RESOURCE_TYPE.CHARACTER_CARD)
        text = JSON.stringify({
          spec: 'chara_card_v2',
          data: { name: 'saved card', description: 'saved original' },
        })
      if (type === RESOURCE_TYPE.SECRET) {
        const values = new Map<string, string>()
        const secrets = new SecretResourceService({
          save: async (key, value) => {
            values.set(key, value)
          },
          read: async (key) => values.get(key) ?? '',
          clear: async (key) => {
            values.delete(key)
          },
        })
        await secrets.setPassword('fixture-password')
        text = JSON.stringify(
          await secrets.protect({
            format: 'srl-personal-resource',
            version: 1,
            kind: 'secret',
            name: 'fixture',
            text: '',
            url: '',
            attachments: [],
            fields: [
              { id: 'token', label: 'Token', value: 'fixture-private-value', private: true },
            ],
          }),
        )
      }
      const current = await resource(`current-${type}`, type, text)
      const version = {
        ...(await resource(
          `history-${type}`,
          type,
          text +
            (type === RESOURCE_TYPE.SECRET || type === RESOURCE_TYPE.CHARACTER_CARD
              ? ' '
              : '-history'),
        )),
        versionGroupId: current.id,
      }
      const created = await createStructuredSnapshot(
        [current],
        [version],
        [{ id: 'folder', name: 'saved folder', color: '#123456', createdAt: 1, updatedAt: 2 }],
        { version: 1 },
      )
      const snapshot = await decodeStructuredSnapshot(
        await encodeStructuredSnapshot(created.snapshot),
      )
      const name = `coverage-${crypto.randomUUID()}`
      let db = new AppDatabase(name)
      try {
        const service = new CommunitySourceRestoreService(
          new IndexedDbArchiveStorage(db),
          new MemoryRestoreStagingStore(),
          { restoreBackup: async () => {}, replaceAll: async () => {} },
        )
        await service.restoreStructured(snapshot, reader(created), [], [], 'cloud')
        db.close()
        db = new AppDatabase(name)
        const stored = await db.resources.get(current.id)
        expect(stored).toMatchObject({
          type,
          tags: ['saved tag'],
          favorite: true,
          categoryIds: ['folder'],
          metadata: { custom: 'preserved' },
        })
        if (!stored || !('originalBlob' in stored)) throw new Error('missing original')
        expect(await stored.originalBlob.text()).toBe(text)
        expect(await db.resourceVersions.count()).toBe(1)
        expect(await db.categories.get('folder')).toMatchObject({ name: 'saved folder' })
      } finally {
        db.close()
        await db.delete()
      }
    },
  )
})
