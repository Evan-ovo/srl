import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'

import type { ArchiveStorageAdapter } from '../storage/ArchiveStorageAdapter'
import { MemoryRestoreStagingStore } from '../storage/RestoreStagingStore'
import type { ArchiveManifest } from '../types/Backup'
import type { RestoreStagingChunk } from '../types/RestoreStaging'
import {
  normalizeResourceLinks,
  RESOURCE_LINK_TYPE,
  RESOURCE_TYPE,
  type Category,
  type Resource,
} from '../types/Resource'
import { ExportService } from './ExportService'
import { selectPreparedRestore } from './BackupRestoreSelection'
import { RestoreService } from './RestoreService'
import type { StructuredResource } from './CloudStructuredSnapshot'
import type { NativeBackedResourceRecord } from '../types/Vault'
import * as nativeCloud from './NativeCloudTransfer'

class MemoryArchiveStorage implements ArchiveStorageAdapter {
  categories: Category[] = []
  resources: Resource[] = []
  versions: Resource[] = []

  async restore(
    categories: Category[],
    resources: Resource[],
    versions: Resource[] = [],
    hydrate: (resource: Resource) => Promise<Resource> = async (resource) => resource,
  ): Promise<void> {
    this.categories.push(...categories)
    this.resources.push(...(await Promise.all(resources.map(hydrate))))
    this.versions.push(...(await Promise.all(versions.map(hydrate))))
  }

  async replace(
    categories: Category[],
    resources: Resource[],
    versions: Resource[] = [],
    hydrate: (resource: Resource) => Promise<Resource> = async (resource) => resource,
  ): Promise<void> {
    this.categories = [...categories]
    this.resources = await Promise.all(resources.map(hydrate))
    this.versions = await Promise.all(versions.map(hydrate))
  }
}

class TrackingRestoreStagingStore extends MemoryRestoreStagingStore {
  chunkCount = 0
  maxChunkBytes = 0

  override async putChunk(chunk: RestoreStagingChunk): Promise<void> {
    this.chunkCount += 1
    this.maxChunkBytes = Math.max(this.maxChunkBytes, chunk.blob.size)
    await super.putChunk(chunk)
  }
}

async function contentHash(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
}

async function createResource(
  id: string,
  categoryId: string | null,
  content: string,
): Promise<Resource> {
  const now = Date.now()
  return {
    id,
    type: RESOURCE_TYPE.WORLD_BOOK,
    name: id,
    description: '',
    fileName: `${id}.json`,
    mimeType: 'application/json',
    fileSize: new TextEncoder().encode(content).byteLength,
    contentHash: await contentHash(content),
    favorite: false,
    categoryId,
    tags: ['恢复测试'],
    metadata: { format: 'json' },
    originalBlob: new Blob([content]),
    createdAt: now,
    updatedAt: now,
  }
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(data.length)
  copy.set(data)
  return copy.buffer
}

async function createBackup(resources: Resource[], categories: Category[]): Promise<File> {
  const archive = await new ExportService().createArchive(resources, categories, { mode: 'full' })
  return new File([archive.blob], archive.fileName, { type: 'application/zip' })
}

const archivedCategory: Category = {
  id: 'lore',
  name: '设定',
  color: '#486b5d',
  createdAt: 1,
  updatedAt: 1,
}

describe('RestoreService', () => {
  it('replans full replacement without rereading or extracting originals during preview', async () => {
    const first = await createResource('existing', archivedCategory.id, '{"first":true}')
    const second = await createResource('new', archivedCategory.id, '{"second":true}')
    const identicalCopy = { ...first, id: 'separate-copy' }
    const version = {
      ...(await createResource('history', archivedCategory.id, '{"older":true}')),
      versionGroupId: first.id,
    }
    const archive = await new ExportService().createArchive(
      [first, second, identicalCopy],
      [archivedCategory],
      { mode: 'full' },
      [version],
    )
    const staging = new TrackingRestoreStagingStore()
    const reads = vi.spyOn(staging, 'get')
    const storage = new MemoryArchiveStorage()
    const service = new RestoreService(storage, staging)
    const prepared = await service.prepare(
      new File([archive.blob], archive.fileName),
      [first],
      [archivedCategory],
      true,
    )
    expect(prepared.resources.map((resource) => resource.id)).toEqual([second.id])
    expect(prepared.categories).toEqual([])
    expect(reads.mock.calls.map(([, path]) => path)).toEqual(['manifest.json'])
    const stagedChunks = staging.chunkCount
    await service.replace(prepared)
    expect(storage.resources.map((resource) => resource.id)).toEqual([
      first.id,
      second.id,
      identicalCopy.id,
    ])
    expect(storage.categories).toEqual([archivedCategory])
    expect(storage.versions[0]?.versionGroupId).toBe(first.id)
    expect(await storage.resources[0]!.originalBlob.text()).toBe('{"first":true}')
    expect(staging.chunkCount).toBe(stagedChunks)
  })

  it('restores embedded chat portraits, rules and scripts without a separate script resource', async () => {
    const content = '{"name":"角色","is_user":false,"mes":"同一正文"}'
    const first = {
      ...(await createResource('chat-a', null, content)),
      type: RESOURCE_TYPE.CHAT,
      metadata: {
        format: 'jsonl',
        chatCharacter: {
          hash: 'a'.repeat(64),
          name: '同名',
          avatar: 'a.png',
          thumbnail: 'data:image/webp;base64,dGh1bWJuYWls',
          card: {
            scripts: [
              {
                type: 'script',
                id: 'role-phone',
                name: '手机',
                content: 'rolePhone()',
                data: { theme: 'night' },
                buttonDefinitions: [{ name: '显隐', visible: true }],
              },
            ],
            extensions: { regex_scripts: [{ scriptName: '状态栏' }] },
          },
        },
      },
    }
    const second = {
      ...first,
      id: 'chat-b',
      metadata: {
        ...first.metadata,
        chatCharacter: { ...first.metadata.chatCharacter, hash: 'b'.repeat(64), avatar: 'b.png' },
      },
    }
    const backup = await createBackup([first, second], [])
    const storage = new MemoryArchiveStorage()
    const service = new RestoreService(storage)
    const prepared = await service.prepare(backup, [], [])
    expect(prepared.resources).toHaveLength(2)
    await service.restore(prepared)
    expect(storage.resources.map((r) => r.metadata.chatCharacter)).toEqual([
      first.metadata.chatCharacter,
      second.metadata.chatCharacter,
    ])
    expect((await service.prepare(backup, storage.resources, [])).resources).toHaveLength(0)
  })
  it('selects a resource together with its persona avatar and history', async () => {
    const persona = await createResource('persona-select', null, '{"persona":true}')
    persona.type = RESOURCE_TYPE.USER_PERSONA
    persona.relatedResourceIds = ['avatar-select']
    const avatar = await createResource('avatar-select', null, 'avatar')
    avatar.metadata = { assetKind: 'userPersonaAvatar', avatarId: 'select.png' }
    avatar.relatedResourceIds = [persona.id]
    const other = await createResource('other-select', null, '{"other":true}')
    const version = { ...persona, id: 'persona-version', versionGroupId: persona.id }
    const prepared = {
      preview: {
        fileName: 'select.zip',
        mode: 'full' as const,
        createdAt: new Date().toISOString(),
        archiveResourceCount: 3,
        resourcesToAdd: 3,
        duplicatesToSkip: 0,
        conflictsToPreserve: 0,
        categoriesToCreate: 0,
        categoriesToReuse: 0,
      },
      resources: [persona, avatar, other],
      versions: [version],
      categories: [],
    }

    const selected = selectPreparedRestore(prepared, new Set([persona.id]))

    expect(selected.resources.map((resource) => resource.id)).toEqual([persona.id, avatar.id])
    expect(selected.versions.map((resource) => resource.versionGroupId)).toEqual([persona.id])
    expect(selected.preview.resourcesToAdd).toBe(2)
  })

  it('prepares APK V3 metadata as NativeLibrary references without materializing resource blobs', async () => {
    const resource = await createResource('native-resource', null, '{"name":"native"}')
    const { originalBlob: _originalBlob, thumbnailBlob: _thumbnailBlob, ...record } = resource
    const structured: StructuredResource = {
      ...record,
      object: {
        format: 'srl-github-backup-bundle',
        version: 2,
        createdAt: '2026-08-26T00:00:00.000Z',
        fileName: resource.fileName,
        totalSize: resource.fileSize,
        totalSha256: resource.contentHash,
        parts: [
          {
            name: `srl-chunk--sha256-${resource.contentHash}`,
            size: resource.fileSize,
            sha256: resource.contentHash,
          },
        ],
      },
    }
    const service = new RestoreService(new MemoryArchiveStorage())

    const prepared = await service.prepareStructuredNative(
      [structured],
      [],
      [],
      { version: 1 },
      [],
      [],
      'snapshot.srlmanifest.v3.json.gz',
    )

    expect(prepared.resources[0]).toMatchObject({
      id: resource.id,
      nativeOriginal: {
        version: 1,
        contentHash: resource.contentHash,
        size: resource.fileSize,
      },
    })
    expect(prepared.resources[0]).not.toHaveProperty('originalBlob')
  })

  it('requires APK character-card metadata rebuilt from the verified native object', async () => {
    const resource = await createResource('native-card', null, '{"name":"native-card"}')
    resource.type = RESOURCE_TYPE.CHARACTER_CARD
    resource.metadata = { format: 'json' }
    const { originalBlob: _originalBlob, thumbnailBlob: _thumbnailBlob, ...record } = resource
    const structured: StructuredResource = {
      ...record,
      object: {
        format: 'srl-github-backup-bundle',
        version: 2,
        createdAt: '2026-08-26T00:00:00.000Z',
        fileName: resource.fileName,
        totalSize: resource.fileSize,
        totalSha256: resource.contentHash,
        parts: [
          {
            name: `srl-chunk--sha256-${resource.contentHash}`,
            size: resource.fileSize,
            sha256: resource.contentHash,
          },
        ],
      },
    }
    const committed: NativeBackedResourceRecord[] = []
    const storage: ArchiveStorageAdapter = {
      restore: async () => {},
      replace: async () => {},
      restoreNative: async (_categories, resources, versions = [], hydrate) => {
        const staged: NativeBackedResourceRecord[] = []
        for (const record of [...resources, ...versions]) staged.push(await hydrate!(record))
        committed.push(...staged)
      },
    }
    const service = new RestoreService(storage)
    const prepared = await service.prepareStructuredNative(
      [structured],
      [],
      [],
      { version: 1 },
      [],
      [],
      'snapshot',
    )
    expect(prepared.resources[0]?.metadata.card).toBeUndefined()
    expect(prepared.resources[0]).not.toHaveProperty('originalBlob')
    await expect(
      service.restoreNative(prepared, async () => ({ hash: 'wrong', card: {} })),
    ).rejects.toThrow(/无法从已校验原文件重建角色卡清单/)
    expect(committed).toEqual([])
    const read = vi.spyOn(nativeCloud, 'readNativeRestoredCardMetadata').mockResolvedValue({
      hash: resource.contentHash,
      card: { name: 'native-card' },
      thumbnailBase64: 'aGVsbG8=',
    })
    await service.restoreNative(prepared)
    expect(read).toHaveBeenCalledOnce()
    expect(read).toHaveBeenCalledWith({
      hash: resource.contentHash,
      size: resource.fileSize,
      fileName: resource.fileName,
    })
    expect(committed[0]?.metadata.card).toEqual({ name: 'native-card' })
    expect(await committed[0]?.thumbnailBlob?.text()).toBe('hello')
    expect(prepared.resources[0]?.metadata.card).toBeUndefined()
    read.mockRestore()
  })

  it('stages a large entry as bounded chunks instead of retaining one entry buffer', async () => {
    const bytes = new Uint8Array(8 * 1024 * 1024)
    let state = 0x12345678
    for (let index = 0; index < bytes.length; index += 1) {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      bytes[index] = state & 0xff
    }
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const hash = Array.from(new Uint8Array(digest), (value) =>
      value.toString(16).padStart(2, '0'),
    ).join('')
    const resource: Resource = {
      id: 'large-entry',
      type: RESOURCE_TYPE.OTHER,
      name: 'large-entry',
      description: '',
      fileName: 'large-entry.bin',
      mimeType: 'application/octet-stream',
      fileSize: bytes.length,
      contentHash: hash,
      favorite: false,
      categoryId: null,
      tags: [],
      metadata: {},
      originalBlob: new Blob([bytes]),
      createdAt: 1,
      updatedAt: 1,
    }
    const staging = new TrackingRestoreStagingStore()

    const prepared = await new RestoreService(new MemoryArchiveStorage(), staging).prepare(
      await createBackup([resource], []),
      [],
      [],
    )

    expect(staging.chunkCount).toBeGreaterThan(2)
    expect(staging.maxChunkBytes).toBeLessThan(bytes.length)
    expect(prepared.resources[0]?.originalBlob.size).toBe(bytes.length)
    expect(await prepared.resources[0]?.originalBlob.arrayBuffer()).toEqual(bytes.buffer)
  }, 30_000)

  it('previews and restores resources with their original files', async () => {
    const storage = new MemoryArchiveStorage()
    const service = new RestoreService(storage)
    const archivedResource = await createResource('atlas', archivedCategory.id, '{"name":"Atlas"}')
    archivedResource.metadata = {
      ...archivedResource.metadata,
      creator: '解析作者',
      authorNote: '我备注的作者',
    }
    archivedResource.sourceLinks = [
      {
        id: 'discord-post',
        label: '作者 DC 原帖',
        url: 'https://discord.gg/example',
        type: RESOURCE_LINK_TYPE.DISCORD,
        note: '首发社区',
        createdAt: 1,
      },
    ]
    const backup = await createBackup([archivedResource], [archivedCategory])

    const prepared = await service.prepare(backup, [], [])
    const report = await service.restore(prepared)

    expect(prepared.preview.resourcesToAdd).toBe(1)
    expect(prepared.preview.categoriesToCreate).toBe(1)
    expect(report.restoredResources).toBe(1)
    expect(storage.resources[0]?.metadata).toMatchObject({
      creator: '解析作者',
      authorNote: '我备注的作者',
    })
    expect(storage.resources[0]?.categoryId).toBe(archivedCategory.id)
    expect(storage.resources[0]?.sourceLinks).toEqual(
      normalizeResourceLinks(archivedResource.sourceLinks),
    )
    expect(await storage.resources[0]?.originalBlob.text()).toBe('{"name":"Atlas"}')
  })

  it('reuses the preflight staging data for a deferred full replacement', async () => {
    const storage = new MemoryArchiveStorage()
    const staging = new TrackingRestoreStagingStore()
    const service = new RestoreService(storage, staging)
    const resource = await createResource('atlas', null, '{"name":"Atlas"}')
    const prepared = await service.prepare(await createBackup([resource], []), [], [], true)
    const stagedChunkCount = staging.chunkCount

    await service.replace(prepared)

    expect(staging.chunkCount).toBe(stagedChunkCount)
    expect(storage.resources).toHaveLength(1)
    expect(await storage.resources[0]?.originalBlob.text()).toBe('{"name":"Atlas"}')
  })

  it('round-trips a SillyTavern persona backup as a user persona resource', async () => {
    const content = JSON.stringify({
      personas: { 'alice.png': 'Alice' },
      persona_descriptions: {
        'alice.png': {
          description: 'Archivist',
          position: 4,
          depth: 2,
          role: 0,
          lorebook: 'Archive',
          connections: [{ type: 'character', id: 'Detective.png' }],
        },
      },
      default_persona: 'alice.png',
    })
    const persona = await createResource('persona', null, content)
    persona.type = RESOURCE_TYPE.USER_PERSONA
    persona.name = 'Alice'
    persona.fileName = 'personas_20260801.json'
    persona.metadata = {
      format: 'json',
      detectedVariant: 'sillyTavernPersonaBackup',
      itemCount: 1,
      defaultPersonaAvatarId: 'alice.png',
    }
    const avatar = await createResource('avatar-alice', null, 'avatar-image')
    avatar.type = RESOURCE_TYPE.OTHER
    avatar.fileName = 'alice.png'
    avatar.mimeType = 'image/png'
    avatar.metadata = { assetKind: 'userPersonaAvatar', avatarId: 'alice.png' }
    persona.relatedResourceIds = [avatar.id]
    avatar.relatedResourceIds = [persona.id]
    const storage = new MemoryArchiveStorage()
    const prepared = await new RestoreService(storage).prepare(
      await createBackup([persona, avatar], []),
      [],
      [],
    )
    await new RestoreService(storage).restore(prepared)

    const restoredPersona = storage.resources.find((resource) => resource.id === persona.id)
    const restoredAvatar = storage.resources.find((resource) => resource.id === avatar.id)
    expect(restoredPersona).toMatchObject({
      type: RESOURCE_TYPE.USER_PERSONA,
      fileName: 'personas_20260801.json',
      metadata: { detectedVariant: 'sillyTavernPersonaBackup', itemCount: 1 },
      relatedResourceIds: [avatar.id],
    })
    expect(restoredPersona?.thumbnailBlob).toBeDefined()
    expect(restoredAvatar?.thumbnailBlob).toBeDefined()
    expect(JSON.parse(await restoredPersona!.originalBlob.text())).toEqual(JSON.parse(content))
  })

  it('preserves avatar attachments with identical bytes but different persona keys', async () => {
    const first = await createResource('avatar-alice', null, 'same-avatar')
    first.type = RESOURCE_TYPE.OTHER
    first.fileName = 'alice.png'
    first.mimeType = 'image/png'
    first.metadata = { assetKind: 'userPersonaAvatar', avatarId: 'alice.png' }
    const second = { ...first, id: 'avatar-owner', fileName: 'owner.png' }
    second.metadata = { assetKind: 'userPersonaAvatar', avatarId: 'owner.png' }

    const prepared = await new RestoreService(new MemoryArchiveStorage()).prepare(
      await createBackup([first, second], []),
      [],
      [],
    )

    expect(prepared.preview.duplicatesToSkip).toBe(0)
    expect(prepared.resources.map((resource) => resource.metadata.avatarId)).toEqual([
      'alice.png',
      'owner.png',
    ])
  })

  it('replaces the local library from a full backup without merge-time duplicate filtering', async () => {
    const storage = new MemoryArchiveStorage()
    storage.resources = [await createResource('local-only', null, '{"local":true}')]
    const service = new RestoreService(storage)
    const backup = await createBackup(
      [await createResource('atlas', archivedCategory.id, '{"name":"Atlas"}')],
      [archivedCategory],
    )

    const prepared = await service.prepare(backup, [], [])
    const report = await service.replace(prepared)

    expect(report.restoredResources).toBe(1)
    expect(storage.resources.map((resource) => resource.id)).toEqual(['atlas'])
    expect(storage.categories.map((category) => category.id)).toEqual([archivedCategory.id])
  })

  it('preserves visual folder covers through export and restore', async () => {
    const storage = new MemoryArchiveStorage()
    const service = new RestoreService(storage)
    const coverImage = `data:image/webp;base64,${btoa('visual-folder-cover')}`
    const coveredCategory = { ...archivedCategory, coverImage }
    const backup = await createBackup([], [coveredCategory])

    const prepared = await service.prepare(backup, [], [])
    await service.restore(prepared)

    expect(storage.categories[0]?.coverImage).toBe(coverImage)
  })

  it('skips content duplicates and preserves ID conflicts as copies', async () => {
    const storage = new MemoryArchiveStorage()
    const service = new RestoreService(storage)
    const duplicate = await createResource('archived-duplicate', null, '{"same":true}')
    const conflicting = await createResource('shared-id', archivedCategory.id, '{"new":true}')
    const existingDuplicate = await createResource('local-duplicate', null, '{"same":true}')
    const existingConflict = await createResource('shared-id', null, '{"local":true}')
    const existingCategory = { ...archivedCategory, id: 'local-lore' }
    const backup = await createBackup([duplicate, conflicting], [archivedCategory])

    const prepared = await service.prepare(
      backup,
      [existingDuplicate, existingConflict],
      [existingCategory],
    )

    expect(prepared.preview.duplicatesToSkip).toBe(1)
    expect(prepared.preview.conflictsToPreserve).toBe(1)
    expect(prepared.preview.categoriesToReuse).toBe(1)
    expect(prepared.resources).toHaveLength(1)
    expect(prepared.resources[0]?.id).not.toBe('shared-id')
    expect(prepared.resources[0]?.categoryId).toBe(existingCategory.id)
  })

  it('restores multiple folders and symmetric companion relations', async () => {
    const secondCategory: Category = {
      id: 'tools',
      name: '工具',
      color: '#8a6a47',
      createdAt: 2,
      updatedAt: 2,
    }
    const atlas = await createResource('atlas', archivedCategory.id, '{"name":"Atlas"}')
    const regex = await createResource('regex', secondCategory.id, '{"name":"Regex"}')
    atlas.categoryIds = [archivedCategory.id, secondCategory.id]
    atlas.relatedResourceIds = [regex.id]
    regex.relatedResourceIds = [atlas.id]
    const backup = await createBackup([atlas, regex], [archivedCategory, secondCategory])

    const prepared = await new RestoreService(new MemoryArchiveStorage()).prepare(backup, [], [])
    const restoredAtlas = prepared.resources.find((resource) => resource.id === atlas.id)
    const restoredRegex = prepared.resources.find((resource) => resource.id === regex.id)

    expect(restoredAtlas?.categoryIds).toEqual([archivedCategory.id, secondCategory.id])
    expect(restoredAtlas?.relatedResourceIds).toEqual([regex.id])
    expect(restoredRegex?.relatedResourceIds).toEqual([atlas.id])
  })

  it('restores inactive resource versions with their version group', async () => {
    const storage = new MemoryArchiveStorage()
    const active = await createResource('atlas', null, '{"version":2}')
    active.versionGroupId = active.id
    active.versionCount = 2
    const previous = await createResource('atlas-v1', null, '{"version":1}')
    previous.versionGroupId = active.id
    previous.versionLabel = '1.0'
    previous.versionNote = '作者发布的初始版'
    const archive = await new ExportService().createArchive([active], [], { mode: 'full' }, [
      previous,
    ])
    const backup = new File([archive.blob], archive.fileName, { type: 'application/zip' })

    const service = new RestoreService(storage)
    const prepared = await service.prepare(backup, [], [])
    const report = await service.restore(prepared)

    expect(prepared.versions).toHaveLength(1)
    expect(report.restoredVersions).toBe(1)
    expect(storage.versions[0]).toMatchObject({
      versionGroupId: active.id,
      versionLabel: '1.0',
      versionNote: '作者发布的初始版',
    })
    expect(storage.versions[0]?.id).not.toBe(previous.id)
    expect(await storage.versions[0]?.originalBlob.text()).toBe('{"version":1}')
  })

  it('rejects an original file that fails integrity verification', async () => {
    const resource = await createResource('atlas', null, '{"name":"Atlas"}')
    const backup = await createBackup([resource], [])
    const files = unzipSync(new Uint8Array(await backup.arrayBuffer()))
    const manifest = JSON.parse(strFromU8(files['manifest.json']!)) as ArchiveManifest
    files[manifest.resources[0]!.archivePath] = strToU8('{"name":"Altered"}')
    const corrupted = new File([toArrayBuffer(zipSync(files))], 'corrupted.zip')

    await expect(
      new RestoreService(new MemoryArchiveStorage()).prepare(corrupted, [], []),
    ).rejects.toThrow(/文件(大小|完整性)校验失败/)
  })

  it('rejects unsupported archive versions before writing', async () => {
    const backup = await createBackup([], [])
    const files = unzipSync(new Uint8Array(await backup.arrayBuffer()))
    const manifest = JSON.parse(strFromU8(files['manifest.json']!)) as ArchiveManifest
    Object.assign(manifest, { version: 99 })
    files['manifest.json'] = strToU8(JSON.stringify(manifest))
    const futureBackup = new File([toArrayBuffer(zipSync(files))], 'future.zip')

    await expect(
      new RestoreService(new MemoryArchiveStorage()).prepare(futureBackup, [], []),
    ).rejects.toThrow('暂不支持备份版本 99')
  })
})

it('remaps an attached script to a deduplicated local script when restoring a chat', async () => {
  const script = await createResource('script-archive', null, '{"scripts":[{"content":"code"}]}')
  script.type = RESOURCE_TYPE.SCRIPT
  const chat = await createResource('chat-archive', null, '{"mes":"正文","is_user":false}')
  chat.type = RESOURCE_TYPE.CHAT
  chat.metadata = { chatReadingScriptId: script.id }
  const localScript = { ...script, id: 'script-local' }
  const storage = new MemoryArchiveStorage()
  storage.resources = [localScript]
  const service = new RestoreService(storage)
  const prepared = await service.prepare(await createBackup([chat, script], []), [localScript], [])
  await service.restore(prepared)
  expect(
    storage.resources.find((r) => r.type === RESOURCE_TYPE.CHAT)?.metadata.chatReadingScriptId,
  ).toBe(localScript.id)
})
