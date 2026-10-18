import type { ResourceStorageAdapter } from '../storage/ResourceStorageAdapter'
import { RESOURCE_TYPE, type Resource, type ResourceSummary } from '../types/Resource'
import {
  isResourceAttachment,
  isResourceOwnedFile,
  RESOURCE_ATTACHMENT_KIND,
  resourceOwnedFileOwnerId,
} from '../types/ResourceAttachment'
import { nativeFileSize } from '../core/NativeFileSource'
import { hashBlob } from './HashService'

/** Attachment bytes use the existing resource/vault/native/backup owners. */
export class ResourceAttachmentService {
  private readonly storage: ResourceStorageAdapter
  constructor(storage: ResourceStorageAdapter) {
    this.storage = storage
  }

  async list(ownerId: string): Promise<ResourceSummary[]> {
    const rows = await (this.storage.listAttachmentListSummaries?.(ownerId) ??
      this.storage.listResourceListSummaries?.({ types: [RESOURCE_TYPE.OTHER] }) ??
      this.storage.listSummaries())
    return rows
      .filter((r) => isResourceAttachment(r) && resourceOwnedFileOwnerId(r) === ownerId)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  }

  private async owner(id: string): Promise<void> {
    const owner = await (this.storage.getSummary?.(id) ?? this.storage.get(id))
    if (!owner || isResourceOwnedFile(owner)) throw new Error('所属资源已经不存在')
  }

  async get(ownerId: string, id: string): Promise<Resource> {
    await this.owner(ownerId)
    const resource = await this.storage.get(id)
    if (
      !resource ||
      !isResourceAttachment(resource) ||
      resourceOwnedFileOwnerId(resource) !== ownerId
    )
      throw new Error('附件已移除或不属于当前资源')
    return resource
  }

  async add(ownerId: string, file: File, signal?: AbortSignal): Promise<Resource> {
    signal?.throwIfAborted()
    await this.owner(ownerId)
    const hash = await hashBlob(file)
    signal?.throwIfAborted()
    const now = Date.now()
    const id = `attachment-${crypto.randomUUID()}`
    const resource: Resource = {
      id,
      type: RESOURCE_TYPE.OTHER,
      name: file.name,
      description: '',
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      fileSize: nativeFileSize(file),
      contentHash: hash,
      favorite: false,
      categoryId: null,
      categoryIds: [],
      relatedResourceIds: [],
      tags: [],
      metadata: {
        assetKind: RESOURCE_ATTACHMENT_KIND,
        attachmentOwnerId: ownerId,
        attachmentIdentity: id,
      },
      originalBlob: file,
      createdAt: now,
      updatedAt: now,
    }
    // Recheck after hashing so a late picker result cannot attach to a deleted owner.
    await this.owner(ownerId)
    signal?.throwIfAborted()
    await this.storage.save(resource)
    try {
      await this.owner(ownerId)
      const saved = await (this.storage.getSummary?.(id) ?? this.storage.get(id))
      if (!saved || saved.contentHash !== hash || saved.fileSize !== resource.fileSize)
        throw new Error('附件保存后校验失败')
    } catch (error) {
      await this.storage.delete(id)
      throw error
    }
    return resource
  }

  private async historyParent(ownerId: string, id: string): Promise<void> {
    await this.owner(ownerId)
    const current = await (this.storage.getSummary?.(id) ?? this.storage.get(id))
    if (!current || !isResourceAttachment(current) || resourceOwnedFileOwnerId(current) !== ownerId)
      throw new Error('附件已移除或不属于当前资源')
  }

  async history(ownerId: string, id: string): Promise<ResourceSummary[]> {
    await this.historyParent(ownerId, id)
    const rows = await (this.storage.listVersionListSummariesForResources?.([id]) ??
      this.storage.listVersionSummaries())
    return rows
      .filter(
        (row) =>
          row.versionGroupId === id &&
          isResourceAttachment(row) &&
          resourceOwnedFileOwnerId(row) === ownerId,
      )
      .sort(
        (a, b) =>
          (b.versionImportedAt ?? b.updatedAt) - (a.versionImportedAt ?? a.updatedAt) ||
          a.id.localeCompare(b.id),
      )
  }

  async getHistory(ownerId: string, id: string, versionId: string): Promise<Resource> {
    await this.historyParent(ownerId, id)
    const version = this.storage.getVersion
      ? await this.storage.getVersion(versionId)
      : (await this.storage.listVersions(id)).find((row) => row.id === versionId)
    if (
      !version ||
      version.id === id ||
      version.versionGroupId !== id ||
      !isResourceAttachment(version) ||
      resourceOwnedFileOwnerId(version) !== ownerId
    )
      throw new Error('历史版本已移除或不属于当前附件')
    return version
  }

  async deleteHistory(
    ownerId: string,
    id: string,
    versionId: string,
    expectedHash: string,
  ): Promise<void> {
    await this.historyParent(ownerId, id)
    const version = await (this.storage.getSummary?.(versionId, true) ??
      this.getHistory(ownerId, id, versionId))
    if (
      !version ||
      versionId === id ||
      version.versionGroupId !== id ||
      !isResourceAttachment(version) ||
      resourceOwnedFileOwnerId(version) !== ownerId ||
      version.contentHash !== expectedHash
    )
      throw new Error('历史版本已变化，请重新打开后操作')
    await this.storage.deleteVersion(versionId)
    if ((await this.history(ownerId, id)).some((row) => row.id === versionId))
      throw new Error('历史版本删除后校验失败')
  }

  async restoreHistory(ownerId: string, id: string, version: Resource): Promise<void> {
    await this.historyParent(ownerId, id)
    if (
      version.id === id ||
      version.versionGroupId !== id ||
      !isResourceAttachment(version) ||
      resourceOwnedFileOwnerId(version) !== ownerId ||
      nativeFileSize(version.originalBlob) !== version.fileSize ||
      (await hashBlob(version.originalBlob)) !== version.contentHash
    )
      throw new Error('附件历史恢复记录无效')
    const existing = this.storage.getVersion
      ? await this.storage.getVersion(version.id)
      : (await this.storage.listAllVersions()).find((row) => row.id === version.id)
    if (existing?.versionGroupId === id && existing.contentHash === version.contentHash) return
    if (
      existing &&
      (await this.history(ownerId, id)).some(
        (row) =>
          row.contentHash === version.contentHash &&
          row.fileSize === version.fileSize &&
          row.fileName === version.fileName &&
          row.versionImportedAt === version.versionImportedAt &&
          row.versionNote === version.versionNote &&
          row.createdAt === version.createdAt,
      )
    )
      return
    const restored = { ...version, id: existing ? crypto.randomUUID() : version.id }
    await this.storage.saveVersion(restored)
    const saved = await this.getHistory(ownerId, id, restored.id)
    if (saved.contentHash !== restored.contentHash || saved.fileSize !== restored.fileSize)
      throw new Error('附件历史恢复后校验失败')
  }

  async rename(ownerId: string, id: string, fileName: string): Promise<void> {
    const current = await this.get(ownerId, id)
    const name = fileName.trim()
    if (!name || /[\\/]/u.test(name) || name.includes('\0'))
      throw new Error('请输入不含路径的文件名')
    if (name === current.fileName) return
    const changes = { name, fileName: name, updatedAt: Date.now() }
    if (this.storage.updateMetadata) await this.storage.updateMetadata(id, changes)
    else await this.storage.update(id, changes)
  }

  async replace(ownerId: string, id: string, file: File, expectedHash: string): Promise<Resource> {
    const current = await this.get(ownerId, id)
    if (current.contentHash !== expectedHash) throw new Error('附件已被修改，请重新打开后编辑')
    const hash = await hashBlob(file)
    const fresh = await this.get(ownerId, id)
    if (fresh.contentHash !== expectedHash) throw new Error('附件已被修改，请重新打开后编辑')
    const now = Date.now()
    let preservedId: string | undefined
    if (hash !== current.contentHash) {
      // Preserve the previous original through the existing resource history pipeline.
      preservedId = crypto.randomUUID()
      await this.storage.saveVersion({
        ...fresh,
        id: preservedId,
        versionGroupId: id,
        versionImportedAt: now,
        versionNote: '附件编辑前',
      })
    }
    try {
      await this.storage.update(
        id,
        {
          originalBlob: file,
          fileName: file.name,
          name: file.name,
          fileSize: nativeFileSize(file),
          mimeType: file.type || fresh.mimeType,
          contentHash: hash,
          backupDescriptor: undefined,
          updatedAt: now,
        },
        expectedHash,
      )
    } catch (cause) {
      if (preservedId) await this.storage.deleteVersion(preservedId)
      throw cause
    }
    const saved = await this.get(ownerId, id)
    if (saved.contentHash !== hash || saved.fileSize !== nativeFileSize(file))
      throw new Error('附件更新后校验失败')
    return saved
  }
}
