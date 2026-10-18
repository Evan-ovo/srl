import Dexie from 'dexie'
import type { AppDatabase } from '../database/AppDatabase'
import { includeResourceGalleryIds } from '../types/ResourceGallery'
import {
  RESOURCE_TYPE,
  type BackupRecord,
  type BackupRecordSummary,
  type Resource,
  type ResourceListSummary,
} from '../types/Resource'
import {
  getBackupRecordSummary,
  listBackupRecordSummaries,
} from '../storage/IndexedDbArchiveStorage'
import type { RetainedIndexedDbRecoverySource } from '../storage/AndroidNativeAppDatabaseRuntime'
import { encodeAppDatabaseValue } from '../storage/AndroidAppDatabaseMigration'
import { hashBlob } from './HashService'
import type { CategoryService } from './CategoryService'
import { createResourceArchiveSource, type ExportService } from './ExportService'
import type { ResourceService } from './ResourceService'
import type { ResourceAttachmentService } from './ResourceAttachmentService'
import { resourceOwnedFileOwnerId } from '../types/ResourceAttachment'
import type { RestoreService } from './RestoreService'
import type { VaultService } from './VaultService'
import type { UserPersonaService } from './UserPersonaService'
import { updatePersonaInBackup } from '../parser/SillyTavernPersonaBackup'
import type { UserPersonaCharacterVariantVersion, UserPersonaDraft } from '../types/UserPersona'

const RECYCLE_BIN_ADAPTER = 'local-recycle-bin'
const RECYCLE_BIN_PERSONA_VERSION_ADAPTER = 'local-recycle-bin-persona-version'

interface PersonaVersionRecyclePayload {
  version: 1
  resourceId: string
  avatarId: string
  personaName: string
  characterId: string
  characterName: string
  versionId: string
  variantVersion: UserPersonaCharacterVariantVersion
  wasDefault: boolean
  chatIds: string[]
}

interface PersonaCharacterRecyclePayload {
  version: 1
  resourceId: string
  avatarId: string
  personaName: string
  characterId: string
  characterName: string
  variant: UserPersonaDraft['profile']['variants'][string]
}

export interface RecycleBinMoveProgress {
  phase: 'archive' | 'save' | 'delete'
  writtenBytes?: number
  completed?: number
  total?: number
}

export interface RecycleBinMoveResult {
  record: BackupRecord
  /** The complete post-delete catalogue already read by relation/gallery cleanup. */
  resources?: ResourceListSummary[]
}

function recycleArchiveFileName(createdAt: Date): string {
  const timestamp = createdAt.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `回收站-${timestamp}.zip`
}

export class RecycleBinService {
  private readonly database: AppDatabase
  private readonly resourceService: ResourceService
  private readonly categoryService: CategoryService
  private readonly exportService: ExportService
  private readonly restoreService: RestoreService
  private readonly vaultService: VaultService
  private readonly userPersonaService: UserPersonaService
  private readonly attachments?: ResourceAttachmentService

  constructor(
    database: AppDatabase,
    resourceService: ResourceService,
    categoryService: CategoryService,
    exportService: ExportService,
    restoreService: RestoreService,
    vaultService: VaultService,
    userPersonaService: UserPersonaService,
    attachments?: ResourceAttachmentService,
  ) {
    this.database = database
    this.resourceService = resourceService
    this.categoryService = categoryService
    this.exportService = exportService
    this.restoreService = restoreService
    this.vaultService = vaultService
    this.userPersonaService = userPersonaService
    this.attachments = attachments
  }

  async list(): Promise<BackupRecordSummary[]> {
    const records = await listBackupRecordSummaries(this.database, [
      RECYCLE_BIN_ADAPTER,
      RECYCLE_BIN_PERSONA_VERSION_ADAPTER,
    ])
    return records.sort((left, right) => right.createdAt - left.createdAt)
  }

  async preserveLegacyDatabaseCopy(source: RetainedIndexedDbRecoverySource): Promise<void> {
    const createdAt = Date.now()
    const resources: Resource[] = []
    const records: Array<{ store: string; key: string; resourceId: string }> = []
    const binaries: Array<{ store: string; key: string; fieldPath: string; resourceId: string }> =
      []
    const add = async (originalBlob: Blob, fileName: string): Promise<Resource> => {
      const resource: Resource = {
        id: crypto.randomUUID(),
        type: RESOURCE_TYPE.OTHER,
        name: fileName,
        description: '迁移前旧副本恢复文件；不会自动覆盖当前库。',
        fileName,
        mimeType: originalBlob.type,
        fileSize: originalBlob.size,
        contentHash: await hashBlob(originalBlob),
        originalBlob,
        favorite: false,
        categoryId: null,
        categoryIds: [],
        tags: [],
        metadata: {},
        createdAt,
        updatedAt: createdAt,
      }
      resources.push(resource)
      return resource
    }
    // Reuse the migration codec for every persisted type. Binary bodies remain Blob references;
    // they are streamed by the existing ZIP writer, never expanded to base64 or number arrays.
    const binaryWriter = {
      async writeBlob(store: string, key: string, fieldPath: string, blob: Blob) {
        const resource = await add(blob, `legacy-binary-${binaries.length}.bin`)
        binaries.push({ store, key, fieldPath, resourceId: resource.id })
        return { sha256: resource.contentHash, size: blob.size, mimeType: blob.type }
      },
    }
    const copiedCounts = new Map<string, number>()
    await source.readRecords(async (row) => {
      // JSON escapes lone UTF-16 surrogates losslessly; UTF-8 Blob conversion would replace
      // them. Keep text in the per-record JSON, while genuine binary bodies remain streamed.
      const value = await encodeAppDatabaseValue(
        row.value,
        row.store,
        row.key,
        binaryWriter,
        row.key,
        Infinity,
      )
      const resource = await add(
        new Blob([JSON.stringify({ store: row.store, key: row.key, value })], {
          type: 'application/json',
        }),
        `legacy-record-${records.length}.json`,
      )
      records.push({ store: row.store, key: row.key, resourceId: resource.id })
      copiedCounts.set(row.store, (copiedCounts.get(row.store) ?? 0) + 1)
    })
    // ZIP creation and live-database persistence must not inherit the locked old source.
    // waitFor resumes cleanup in an active source event after readback has completed.
    await Dexie.waitFor(
      Dexie.ignoreTransaction(async () => {
        if (
          source.stores.some((store) => (copiedCounts.get(store.name) ?? 0) !== store.count) ||
          [...copiedCounts.keys()].some(
            (name) => !source.stores.some((store) => store.name === name),
          )
        )
          throw new Error('旧副本恢复档未包含完整记录；旧副本已保留')
        await add(
          new Blob(
            [
              JSON.stringify({
                format: 'srl-legacy-indexeddb-recovery',
                version: 1,
                databaseName: source.databaseName,
                stores: source.stores,
                records,
                binaries,
              }),
            ],
            { type: 'application/json' },
          ),
          'legacy-indexeddb-recovery.json',
        )
        const archives = await this.exportService.createArchives(resources, [], { mode: 'partial' })
        if (archives.length !== 1 || archives[0]!.manifest.resourceCount !== resources.length)
          throw new Error('无法保存完整旧副本恢复档；旧副本已保留')
        let blob = archives[0]!.blob
        let encryptionIv: string | undefined
        const encrypted = this.vaultService.isEnabled()
        if (encrypted) {
          const protectedBlob = await this.vaultService.protectBlob(blob)
          blob = protectedBlob.data
          encryptionIv = protectedBlob.iv
        }
        const expectedHash = await hashBlob(blob)
        const record: BackupRecord = {
          id: `legacy-indexeddb-${expectedHash}`,
          adapter: RECYCLE_BIN_ADAPTER,
          objectKey: recycleArchiveFileName(new Date(createdAt)),
          resourceCount: resources.length,
          createdAt,
          reason: '迁移前旧副本恢复档',
          size: blob.size,
          blob,
          encrypted,
          encryptionIv,
        }
        await this.database.backupRecords.put(record)
        const saved = await this.database.backupRecords.get(record.id)
        if (
          !saved?.blob ||
          saved.blob.size !== blob.size ||
          saved.encrypted !== encrypted ||
          saved.encryptionIv !== encryptionIv ||
          (await hashBlob(saved.blob)) !== expectedHash
        )
          throw new Error('旧副本恢复档未通过保存校验；旧副本已保留')
      }),
      Infinity,
    )
  }
  async movePersonaVersionToRecycleBin(input: {
    resourceId: string
    avatarId: string
    characterId: string
    characterName: string
    versionId: string
  }): Promise<BackupRecord> {
    const { resource, view } = await this.userPersonaService.load(input.resourceId)
    const entry = view.entries.find((item) => item.avatarId === input.avatarId)
    const profile = entry?.profile
    const variant = profile?.variants[input.characterId]
    const version = variant?.versions[input.versionId]
    if (!entry || !profile || !variant || !version)
      throw new Error('要删除的角色人设版本已经不存在，请刷新后重试')

    const payload: PersonaVersionRecyclePayload = {
      version: 1,
      resourceId: resource.id,
      avatarId: entry.avatarId,
      personaName: entry.name,
      characterId: input.characterId,
      characterName: input.characterName,
      versionId: input.versionId,
      variantVersion: JSON.parse(JSON.stringify(version)) as UserPersonaCharacterVariantVersion,
      wasDefault: variant.defaultVersionId === input.versionId,
      chatIds: Object.entries(variant.chatVersions ?? {})
        .filter(([, selectedVersionId]) => selectedVersionId === input.versionId)
        .map(([chatId]) => chatId),
    }
    const createdAt = Date.now()
    let blob = new Blob([JSON.stringify(payload)], { type: 'application/json' })
    let encrypted = false
    let encryptionIv: string | undefined
    if (this.vaultService.isEnabled()) {
      const protectedBlob = await this.vaultService.protectBlob(blob)
      blob = protectedBlob.data
      encrypted = true
      encryptionIv = protectedBlob.iv
    }
    const record: BackupRecord = {
      id: crypto.randomUUID(),
      adapter: RECYCLE_BIN_PERSONA_VERSION_ADAPTER,
      itemKind: 'persona-version',
      objectKey: `user-persona-version-${createdAt}.json`,
      resourceCount: 1,
      createdAt,
      reason: `${entry.name} · ${input.characterName} · ${version.name}`,
      size: blob.size,
      blob,
      encrypted,
      encryptionIv,
    }

    const updatedProfile = JSON.parse(JSON.stringify(profile)) as typeof profile
    const updatedVariant = updatedProfile.variants[input.characterId]!
    delete updatedVariant.versions[input.versionId]
    if (updatedVariant.chatVersions) {
      for (const [chatId, selectedVersionId] of Object.entries(updatedVariant.chatVersions)) {
        if (selectedVersionId === input.versionId) delete updatedVariant.chatVersions[chatId]
      }
    }
    const remainingVersionIds = Object.keys(updatedVariant.versions)
    if (!remainingVersionIds.length) delete updatedProfile.variants[input.characterId]
    else if (updatedVariant.defaultVersionId === input.versionId)
      updatedVariant.defaultVersionId = remainingVersionIds[0]!

    const draft: UserPersonaDraft = {
      avatarId: entry.avatarId,
      name: entry.name,
      title: entry.title,
      description: entry.description,
      position: entry.position,
      depth: entry.depth,
      role: entry.role,
      lorebook: entry.lorebook,
      connections: entry.connections,
      characterBindings: entry.characterBindings,
      profile: updatedProfile,
    }
    const backup = updatePersonaInBackup(view.raw, entry.avatarId, draft)

    await this.database.backupRecords.put(record)
    try {
      await this.userPersonaService.save(
        resource.id,
        backup,
        resource.relatedResourceIds ?? [],
        '移除角色人设版本到回收站',
        undefined,
        false,
      )
    } catch (error) {
      await this.database.backupRecords.delete(record.id)
      throw error
    }
    return record
  }

  async movePersonaCharacterToRecycleBin(input: {
    resourceId: string
    avatarId: string
    characterId: string
    characterName: string
  }): Promise<BackupRecord> {
    const { resource, view } = await this.userPersonaService.load(input.resourceId)
    const entry = view.entries.find((item) => item.avatarId === input.avatarId)
    const variant = entry?.profile.variants[input.characterId]
    if (!entry || !variant) throw new Error('要删除的角色卡人设已经不存在，请刷新后重试')

    const payload: PersonaCharacterRecyclePayload = {
      version: 1,
      resourceId: resource.id,
      avatarId: entry.avatarId,
      personaName: entry.name,
      characterId: input.characterId,
      characterName: input.characterName,
      variant: JSON.parse(JSON.stringify(variant)) as PersonaCharacterRecyclePayload['variant'],
    }
    const createdAt = Date.now()
    let blob = new Blob([JSON.stringify(payload)], { type: 'application/json' })
    let encrypted = false
    let encryptionIv: string | undefined
    if (this.vaultService.isEnabled()) {
      const protectedBlob = await this.vaultService.protectBlob(blob)
      blob = protectedBlob.data
      encrypted = true
      encryptionIv = protectedBlob.iv
    }
    const record: BackupRecord = {
      id: crypto.randomUUID(),
      adapter: RECYCLE_BIN_PERSONA_VERSION_ADAPTER,
      itemKind: 'persona-character',
      objectKey: `user-persona-character-${createdAt}.json`,
      resourceCount: 1,
      createdAt,
      reason: `${entry.name} · ${input.characterName} · 角色人设`,
      size: blob.size,
      blob,
      encrypted,
      encryptionIv,
    }
    const profile = JSON.parse(JSON.stringify(entry.profile)) as typeof entry.profile
    delete profile.variants[input.characterId]
    const draft: UserPersonaDraft = {
      avatarId: entry.avatarId,
      name: entry.name,
      title: entry.title,
      description: entry.description,
      position: entry.position,
      depth: entry.depth,
      role: entry.role,
      lorebook: entry.lorebook,
      connections: entry.connections,
      characterBindings: entry.characterBindings,
      profile,
    }
    const backup = updatePersonaInBackup(view.raw, entry.avatarId, draft)

    await this.database.backupRecords.put(record)
    try {
      await this.userPersonaService.save(
        resource.id,
        backup,
        resource.relatedResourceIds ?? [],
        '移除角色卡人设到回收站',
        undefined,
        false,
      )
    } catch (error) {
      await this.database.backupRecords.delete(record.id)
      throw error
    }
    return record
  }

  async moveAttachmentVersionToRecycleBin(
    ownerId: string,
    attachmentId: string,
    versionId: string,
    options: { signal?: AbortSignal; onProgress?: (progress: RecycleBinMoveProgress) => void } = {},
  ): Promise<void> {
    const { signal, onProgress } = options
    signal?.throwIfAborted()
    if (!this.attachments) throw new Error('附件历史服务不可用')
    const version = await this.attachments.getHistory(ownerId, attachmentId, versionId)
    signal?.throwIfAborted()
    const resource = {
      ...version,
      metadata: {
        ...version.metadata,
        attachmentHistoryRecycle: {
          attachmentId,
          versionImportedAt: version.versionImportedAt,
          versionNote: version.versionNote,
        },
      },
    }
    onProgress?.({ phase: 'archive' })
    const archive = await this.exportService.createArchive(
      [resource],
      [],
      {
        mode: 'partial',
        preserveExternalRelatedResourceIds: true,
      },
      [],
      {
        signal,
        onProgress: ({ writtenBytes }) => onProgress?.({ phase: 'archive', writtenBytes }),
      },
    )
    signal?.throwIfAborted()
    let blob = archive.blob
    let encryptionIv: string | undefined
    const encrypted = this.vaultService.isEnabled()
    if (encrypted) {
      const protectedBlob = await this.vaultService.protectBlob(blob)
      blob = protectedBlob.data
      encryptionIv = protectedBlob.iv
    }
    const digest = await hashBlob(blob)
    signal?.throwIfAborted()
    const createdAt = Date.now()
    const record: BackupRecord = {
      id: crypto.randomUUID(),
      adapter: RECYCLE_BIN_ADAPTER,
      itemKind: 'attachment-version',
      objectKey: recycleArchiveFileName(new Date(createdAt)),
      resourceCount: 1,
      createdAt,
      reason: `${version.fileName} · 附件历史版本`,
      size: blob.size,
      blob,
      encrypted,
      encryptionIv,
    }
    // Saving the recovery copy and removing this one version form the atomic boundary.
    onProgress?.({ phase: 'save' })
    await this.database.backupRecords.put(record)
    const saved = await this.database.backupRecords.get(record.id)
    if (!saved?.blob || (await hashBlob(saved.blob)) !== digest)
      throw new Error('回收站记录保存校验失败，历史版本未删除')
    onProgress?.({ phase: 'delete' })
    await this.attachments.deleteHistory(ownerId, attachmentId, versionId, version.contentHash)
  }

  async moveToRecycleBin(
    ids: string[],
    onProgress?: (progress: RecycleBinMoveProgress) => void,
  ): Promise<RecycleBinMoveResult> {
    const selectedIds = Array.from(new Set(ids.filter(Boolean)))
    if (!selectedIds.length) throw new Error('请选择要移入回收站的资源')

    const source = await createResourceArchiveSource(this.resourceService, selectedIds, true)
    const selected = new Set(selectedIds)
    includeResourceGalleryIds(source.resources, selected, true, true, true)
    const resources = source.resources.filter((resource) => selected.has(resource.id))
    if (!resources.length) throw new Error('要删除的资源已经不存在')

    const categories = await this.categoryService.list()
    const resourceIds = new Set(resources.map((resource) => resource.id))
    const versions = source.versions.filter(
      (version) => version.versionGroupId && resourceIds.has(version.versionGroupId),
    )
    onProgress?.({ phase: 'archive' })
    const [archive] = await this.exportService.createArchivesFromSource(
      { ...source, resources, versions },
      categories,
      { mode: 'partial', preserveExternalRelatedResourceIds: true },
      undefined,
      {
        onProgress: ({ writtenBytes }) => onProgress?.({ phase: 'archive', writtenBytes }),
      },
    )
    if (!archive) throw new Error('未能创建回收站恢复记录')
    const createdAt = Date.now()
    let blob = archive.blob
    let encrypted = false
    let encryptionIv: string | undefined
    if (this.vaultService.isEnabled()) {
      const protectedBlob = await this.vaultService.protectBlob(blob)
      blob = protectedBlob.data
      encrypted = true
      encryptionIv = protectedBlob.iv
    }
    const record: BackupRecord = {
      id: crypto.randomUUID(),
      adapter: RECYCLE_BIN_ADAPTER,
      objectKey: recycleArchiveFileName(new Date(createdAt)),
      resourceCount: resources.length,
      createdAt,
      reason:
        resources.length === 1
          ? resources[0]!.name
          : `${resources[0]!.name} 等 ${resources.length} 项资源`,
      size: blob.size,
      blob,
      encrypted,
      encryptionIv,
    }
    onProgress?.({ phase: 'save' })
    await this.database.backupRecords.put(record)
    onProgress?.({ phase: 'delete', completed: 0, total: resources.length + versions.length })
    const remainingResources = await this.resourceService.deleteMany(
      resources.map((resource) => resource.id),
      ({ completed, total }) => onProgress?.({ phase: 'delete', completed, total }),
    )
    return { record, resources: remainingResources }
  }

  async restore(id: string): Promise<void> {
    const record = await this.getRecord(id)
    if (!record.blob) throw new Error('回收站记录已损坏，无法恢复')
    if (record.itemKind === 'persona-version') {
      const payload = await this.readPersonaVersionPayload(record)
      await this.restorePersonaVersion(payload)
      await this.database.backupRecords.delete(record.id)
      return
    }
    if (record.itemKind === 'persona-character') {
      const payload = await this.readPersonaCharacterPayload(record)
      await this.restorePersonaCharacter(payload)
      await this.database.backupRecords.delete(record.id)
      return
    }
    let blob = record.blob
    if (record.encrypted) {
      if (!record.encryptionIv) throw new Error('回收站记录缺少加密参数')
      blob = await this.vaultService.revealBlob(
        { iv: record.encryptionIv, data: record.blob },
        'application/zip',
      )
    }
    if (record.itemKind === 'attachment-version') {
      if (!this.attachments) throw new Error('附件历史服务不可用')
      const prepared = await this.restoreService.prepare(
        new File([blob], record.objectKey, { type: 'application/zip' }),
        [],
        [],
      )
      if (prepared.resources.length !== 1) throw new Error('附件历史恢复记录无效')
      const version = prepared.resources[0]!
      const history = version.metadata.attachmentHistoryRecycle as
        { attachmentId?: string; versionImportedAt?: number; versionNote?: string } | undefined
      if (
        !history ||
        typeof history.attachmentId !== 'string' ||
        (history.versionImportedAt !== undefined &&
          (typeof history.versionImportedAt !== 'number' ||
            !Number.isFinite(history.versionImportedAt))) ||
        (history.versionNote !== undefined && typeof history.versionNote !== 'string')
      )
        throw new Error('附件历史恢复记录无效')
      const metadata = { ...version.metadata }
      delete metadata.attachmentHistoryRecycle
      await this.attachments.restoreHistory(
        resourceOwnedFileOwnerId(version),
        history.attachmentId,
        {
          ...version,
          metadata,
          versionGroupId: history.attachmentId,
          versionImportedAt: history.versionImportedAt,
          versionNote: history.versionNote,
        },
      )
      await this.database.backupRecords.delete(record.id)
      return
    }
    const [resources, categories] = await Promise.all([
      this.resourceService.listResourceListSummaries(),
      this.categoryService.list(),
    ])
    const prepared = await this.restoreService.prepare(
      new File([blob], record.objectKey, { type: 'application/zip' }),
      resources,
      categories,
      true,
    )
    if (prepared.preview.mode !== 'partial') throw new Error('回收站记录格式无效')
    await this.restoreService.restore(prepared)
    await this.resourceService.restoreRelatedLinks(prepared.resources)
    await this.database.backupRecords.delete(record.id)
  }

  async purge(
    id: string,
    onProgress?: (progress: { completed: number; total: number }) => void,
  ): Promise<void> {
    const record = await getBackupRecordSummary(this.database, id)
    if (
      !record ||
      ![RECYCLE_BIN_ADAPTER, RECYCLE_BIN_PERSONA_VERSION_ADAPTER].includes(record.adapter)
    )
      throw new Error('回收站记录已经不存在')
    onProgress?.({ completed: 0, total: 1 })
    await this.database.backupRecords.delete(id)
    onProgress?.({ completed: 1, total: 1 })
  }

  async empty(
    onProgress?: (progress: { completed: number; total: number }) => void,
  ): Promise<void> {
    const records = await this.list()
    if (!records.length) return
    const total = records.length
    const batchSize = 16
    let completed = 0
    onProgress?.({ completed, total })
    for (let offset = 0; offset < total; offset += batchSize) {
      const batch = records.slice(offset, offset + batchSize)
      await this.database.backupRecords.bulkDelete(batch.map((record) => record.id))
      completed += batch.length
      onProgress?.({ completed, total })
    }
  }

  private async getRecord(id: string): Promise<BackupRecord> {
    const record = await this.database.backupRecords.get(id)
    if (
      !record ||
      ![RECYCLE_BIN_ADAPTER, RECYCLE_BIN_PERSONA_VERSION_ADAPTER].includes(record.adapter)
    )
      throw new Error('回收站记录已经不存在')
    return record
  }

  private async readPersonaVersionPayload(
    record: BackupRecord,
  ): Promise<PersonaVersionRecyclePayload> {
    let blob = record.blob!
    if (record.encrypted) {
      if (!record.encryptionIv) throw new Error('回收站记录缺少加密参数')
      blob = await this.vaultService.revealBlob(
        { iv: record.encryptionIv, data: blob },
        'application/json',
      )
    }
    const payload: unknown = JSON.parse(await blob.text())
    if (
      !payload ||
      typeof payload !== 'object' ||
      (payload as PersonaVersionRecyclePayload).version !== 1 ||
      typeof (payload as PersonaVersionRecyclePayload).resourceId !== 'string' ||
      typeof (payload as PersonaVersionRecyclePayload).avatarId !== 'string' ||
      typeof (payload as PersonaVersionRecyclePayload).characterId !== 'string' ||
      typeof (payload as PersonaVersionRecyclePayload).versionId !== 'string' ||
      !(payload as PersonaVersionRecyclePayload).variantVersion ||
      typeof (payload as PersonaVersionRecyclePayload).variantVersion.name !== 'string' ||
      !Array.isArray((payload as PersonaVersionRecyclePayload).chatIds)
    )
      throw new Error('回收站的人设版本记录无效')
    return payload as PersonaVersionRecyclePayload
  }

  private async restorePersonaVersion(payload: PersonaVersionRecyclePayload): Promise<void> {
    const { resource, view } = await this.userPersonaService.load(payload.resourceId)
    const entry = view.entries.find((item) => item.avatarId === payload.avatarId)
    if (!entry) throw new Error('原 user 人设已不存在，请先从回收站恢复对应人设资源')
    const profile = JSON.parse(JSON.stringify(entry.profile)) as typeof entry.profile
    let variant = profile.variants[payload.characterId]
    if (!variant) {
      variant = { versions: {}, defaultVersionId: '' }
      profile.variants[payload.characterId] = variant
    }
    const versionId = variant.versions[payload.versionId] ? crypto.randomUUID() : payload.versionId
    variant.versions[versionId] = JSON.parse(
      JSON.stringify(payload.variantVersion),
    ) as UserPersonaCharacterVariantVersion
    if (payload.wasDefault || !variant.defaultVersionId) variant.defaultVersionId = versionId
    if (payload.chatIds.length) {
      variant.chatVersions ||= {}
      for (const chatId of payload.chatIds) variant.chatVersions[chatId] = versionId
    }
    const draft: UserPersonaDraft = {
      avatarId: entry.avatarId,
      name: entry.name,
      title: entry.title,
      description: entry.description,
      position: entry.position,
      depth: entry.depth,
      role: entry.role,
      lorebook: entry.lorebook,
      connections: entry.connections,
      characterBindings: entry.characterBindings,
      profile,
    }
    const backup = updatePersonaInBackup(view.raw, entry.avatarId, draft)
    await this.userPersonaService.save(
      resource.id,
      backup,
      resource.relatedResourceIds ?? [],
      '从回收站恢复角色人设版本',
      undefined,
      false,
    )
  }

  private async readPersonaCharacterPayload(
    record: BackupRecord,
  ): Promise<PersonaCharacterRecyclePayload> {
    let blob = record.blob!
    if (record.encrypted) {
      if (!record.encryptionIv) throw new Error('回收站记录缺少加密参数')
      blob = await this.vaultService.revealBlob(
        { iv: record.encryptionIv, data: blob },
        'application/json',
      )
    }
    const payload: unknown = JSON.parse(await blob.text())
    if (
      !payload ||
      typeof payload !== 'object' ||
      (payload as PersonaCharacterRecyclePayload).version !== 1 ||
      typeof (payload as PersonaCharacterRecyclePayload).resourceId !== 'string' ||
      typeof (payload as PersonaCharacterRecyclePayload).avatarId !== 'string' ||
      typeof (payload as PersonaCharacterRecyclePayload).characterId !== 'string' ||
      !(payload as PersonaCharacterRecyclePayload).variant ||
      typeof (payload as PersonaCharacterRecyclePayload).variant.defaultVersionId !== 'string' ||
      !(payload as PersonaCharacterRecyclePayload).variant.versions
    )
      throw new Error('回收站的角色卡人设记录无效')
    return payload as PersonaCharacterRecyclePayload
  }

  private async restorePersonaCharacter(payload: PersonaCharacterRecyclePayload): Promise<void> {
    const { resource, view } = await this.userPersonaService.load(payload.resourceId)
    const entry = view.entries.find((item) => item.avatarId === payload.avatarId)
    if (!entry) throw new Error('原 user 人设已不存在，请先从回收站恢复对应人设资源')
    const profile = JSON.parse(JSON.stringify(entry.profile)) as typeof entry.profile
    const existing = profile.variants[payload.characterId]
    if (!existing) profile.variants[payload.characterId] = payload.variant
    else {
      const restoredIdMap = new Map<string, string>()
      for (const [versionId, version] of Object.entries(payload.variant.versions)) {
        const restoredId = existing.versions[versionId] ? crypto.randomUUID() : versionId
        restoredIdMap.set(versionId, restoredId)
        existing.versions[restoredId] = JSON.parse(JSON.stringify(version))
      }
      if (!existing.defaultVersionId || !existing.versions[existing.defaultVersionId])
        existing.defaultVersionId = restoredIdMap.get(payload.variant.defaultVersionId) ?? ''
      if (payload.variant.chatVersions) {
        existing.chatVersions ||= {}
        for (const [chatId, versionId] of Object.entries(payload.variant.chatVersions)) {
          const restoredId = restoredIdMap.get(versionId)
          if (restoredId) existing.chatVersions[chatId] = restoredId
        }
      }
    }
    const draft: UserPersonaDraft = {
      avatarId: entry.avatarId,
      name: entry.name,
      title: entry.title,
      description: entry.description,
      position: entry.position,
      depth: entry.depth,
      role: entry.role,
      lorebook: entry.lorebook,
      connections: entry.connections,
      characterBindings: entry.characterBindings,
      profile,
    }
    const backup = updatePersonaInBackup(view.raw, entry.avatarId, draft)
    await this.userPersonaService.save(
      resource.id,
      backup,
      resource.relatedResourceIds ?? [],
      '从回收站恢复角色卡人设',
      undefined,
      false,
    )
  }
}
