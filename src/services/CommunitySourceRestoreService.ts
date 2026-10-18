import type { ArchiveStorageAdapter } from '../storage/ArchiveStorageAdapter'
import type { RestoreStagingStore } from '../storage/RestoreStagingStore'
import type { ArchivePortableData, PreparedRestore, RestoreReport } from '../types/Backup'
import type { GitHubBundleManifest } from './GitHubBackupBundle'
import { nativeFileSource, rememberNativeFile } from '../core/NativeFileSource'
import type { CommunitySourceAttachmentArchiveEntry } from '../types/CommunitySource'
import {
  readCommunitySourceLocalAttachmentsFromArchive,
  readCommunitySourceStagedAttachments,
  sanitizeCommunitySourceAttachmentRefs,
} from './CommunitySourceAttachmentArchive'
import type { CommunitySourceService } from './CommunitySourceService'
import { RestoreService } from './RestoreService'

type AttachmentRestore = (
  entries: readonly CommunitySourceAttachmentArchiveEntry[],
) => Promise<void>

/**
 * 整库覆盖的语义必须同时覆盖社区来源：
 * - 备份带 community-sources.json：RestoreService 按备份替换；
 * - 旧备份或未选择 Discord 正文：不把缺失 sidecar 当作授权清空已保存评论。
 * - 显式携带空 sidecar：仍按用户选择的覆盖恢复语义清空社区来源。
 * - 新版备份把已经本地化的 Discord 附件作为独立二进制 sidecar；旧备份没有 sidecar 时
 *   会自动清掉失效的 localAssetId，退回远端 URL，而不是恢复一个假的“本机副本”引用。
 * 合并恢复仍由 RestoreService 处理，不会删除当前来源。
 */
export class CommunitySourceRestoreService extends RestoreService {
  private readonly attachmentRestore?: AttachmentRestore

  constructor(
    storage: ArchiveStorageAdapter,
    staging: RestoreStagingStore,
    sourceOwner: Pick<CommunitySourceService, 'restoreBackup' | 'replaceAll'>,
    attachmentRestore?: AttachmentRestore,
    albumOwner?: Pick<
      import('./GeneratedImageAlbumService').GeneratedImageAlbumService,
      'importPortableState'
    >,
  ) {
    super(storage, staging, sourceOwner, albumOwner)
    this.attachmentRestore = attachmentRestore
  }

  override async prepare(...args: Parameters<RestoreService['prepare']>): Promise<PreparedRestore> {
    const prepared = await super.prepare(...args)
    if (!prepared.communitySourceData) return prepared

    const attachments = prepared.staging
      ? await readCommunitySourceStagedAttachments(
          this.staging,
          prepared.staging.jobId,
          prepared.communitySourceData,
        )
      : await readCommunitySourceLocalAttachmentsFromArchive(args[0], prepared.communitySourceData)
    const availableAssetIds = new Set(attachments.map((entry) => entry.assetId))
    const communitySourceData = sanitizeCommunitySourceAttachmentRefs(
      prepared.communitySourceData,
      availableAssetIds,
    )
    return {
      ...prepared,
      forReplacement: prepared.forReplacement
        ? async () => {
            const replacement = await prepared.forReplacement!()
            return {
              ...replacement,
              communitySourceData: replacement.communitySourceData
                ? sanitizeCommunitySourceAttachmentRefs(
                    replacement.communitySourceData,
                    availableAssetIds,
                  )
                : undefined,
              communitySourceAttachments: attachments,
              preview: { ...replacement.preview, communityAttachmentCount: attachments.length },
            }
          }
        : undefined,
      communitySourceData,
      communitySourceAttachments: attachments,
      preview: {
        ...prepared.preview,
        communityAttachmentCount: attachments.length,
      },
    }
  }

  override async restore(...args: Parameters<RestoreService['restore']>): Promise<RestoreReport> {
    const [prepared] = args
    if (prepared.communitySourceAttachments?.length && this.attachmentRestore) {
      await this.attachmentRestore(prepared.communitySourceAttachments)
    }
    const report = await super.restore(...args)
    return {
      ...report,
      restoredCommunityAttachments: prepared.communitySourceAttachments?.length,
    }
  }

  override async restoreStructuredCommunityAttachments(
    data: ArchivePortableData | undefined,
    readObject: (object: GitHubBundleManifest) => Promise<Blob>,
    signal?: AbortSignal,
  ): Promise<void> {
    for (const entry of data?.communitySources?.attachments ?? []) {
      signal?.throwIfAborted()
      if (!this.attachmentRestore) throw new Error('当前恢复服务没有接入 Discord 附件存储')
      const original = await readObject(entry.object)
      signal?.throwIfAborted()
      if (original.size !== entry.object.totalSize)
        throw new Error(`Discord 本地附件完整性校验失败：${entry.assetId}`)
      const uri = nativeFileSource(original)
      const blob =
        original.type === entry.mimeType ? original : new Blob([original], { type: entry.mimeType })
      await this.attachmentRestore([
        { assetId: entry.assetId, blob: uri ? rememberNativeFile(blob, uri) : blob },
      ])
    }
  }

  override async resumePrepared(prepared: PreparedRestore): Promise<PreparedRestore> {
    const revived = await super.resumePrepared(prepared)
    if (revived.communitySourceData && revived.staging) {
      revived.communitySourceAttachments = await readCommunitySourceStagedAttachments(
        this.staging,
        revived.staging.jobId,
        revived.communitySourceData,
      )
    }
    return revived
  }

  override async replace(
    prepared: PreparedRestore,
    onProgress?: Parameters<RestoreService['replace']>[1],
  ): Promise<RestoreReport> {
    if (prepared.communitySourceAttachments?.length && this.attachmentRestore) {
      await this.attachmentRestore(prepared.communitySourceAttachments)
    }
    const report = await super.replace(prepared, onProgress)
    return {
      ...report,
      restoredCommunityAttachments: prepared.communitySourceAttachments?.length,
    }
  }
}
