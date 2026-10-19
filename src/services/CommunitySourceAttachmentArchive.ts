import { Unzip, UnzipInflate } from 'fflate'

import type { IndexedDbAssetStore } from '../storage/IndexedDbAssetStore'
import { COMMUNITY_SOURCE_ATTACHMENT_ARCHIVE_PREFIX } from '../types/Backup'
import {
  COMMUNITY_SOURCE_ATTACHMENT_LOCAL_STATE,
  type CommunitySourceAttachmentArchiveEntry,
  type CommunitySourceBackupData,
  type CommunitySourceMessage,
  type DiscordAttachmentMeta,
} from '../types/CommunitySource'
import type { CommunitySourceService } from './CommunitySourceService'
import { hashBlob } from './HashService'
import type { RestoreStagingStore } from '../storage/RestoreStagingStore'
import { nativeFileSource, rememberNativeFile } from '../core/NativeFileSource'

const ARCHIVED_ASSET_ID_PATTERN = /^asset-([0-9a-f]{64})$/iu
const MAX_ARCHIVED_ATTACHMENT_BYTES = 64 * 1024 * 1024

type AttachmentReader = Pick<CommunitySourceService, 'exportAll' | 'getAttachmentBlob'>
type AttachmentAssetStore = Pick<IndexedDbAssetStore, 'put'>

function collectMessageAssetIds(message: CommunitySourceMessage, target: Set<string>): void {
  for (const attachment of message.attachments) {
    if (attachment.localAssetId) target.add(attachment.localAssetId)
  }
}

export function collectCommunitySourceLocalAssetIds(data: CommunitySourceBackupData): Set<string> {
  const result = new Set<string>()
  for (const message of data.messages) collectMessageAssetIds(message, result)
  for (const source of data.sources) {
    for (const revision of source.revisions ?? []) {
      for (const message of revision.messages) collectMessageAssetIds(message, result)
    }
  }
  return result
}

function collectAttachmentMimeTypes(data: CommunitySourceBackupData): Map<string, string> {
  const result = new Map<string, string>()
  const collect = (message: CommunitySourceMessage) => {
    for (const attachment of message.attachments) {
      if (!attachment.localAssetId || result.has(attachment.localAssetId)) continue
      result.set(attachment.localAssetId, attachment.contentType || 'application/octet-stream')
    }
  }
  for (const message of data.messages) collect(message)
  for (const source of data.sources) {
    for (const revision of source.revisions ?? []) {
      for (const message of revision.messages) collect(message)
    }
  }
  return result
}

function sanitizeAttachment(
  attachment: DiscordAttachmentMeta,
  availableAssetIds: ReadonlySet<string>,
): DiscordAttachmentMeta {
  if (!attachment.localAssetId || availableAssetIds.has(attachment.localAssetId)) {
    return structuredClone(attachment)
  }
  const { localAssetId: _localAssetId, localState: _localState, ...remote } = attachment
  return {
    ...structuredClone(remote),
    localState: COMMUNITY_SOURCE_ATTACHMENT_LOCAL_STATE.REMOTE_ONLY,
  }
}

function sanitizeMessage(
  message: CommunitySourceMessage,
  availableAssetIds: ReadonlySet<string>,
): CommunitySourceMessage {
  return {
    ...structuredClone(message),
    attachments: message.attachments.map((attachment) =>
      sanitizeAttachment(attachment, availableAssetIds),
    ),
  }
}

export function sanitizeCommunitySourceAttachmentRefs(
  data: CommunitySourceBackupData,
  availableAssetIds: ReadonlySet<string>,
): CommunitySourceBackupData {
  return {
    version: 1,
    sources: data.sources.map((source) => ({
      ...structuredClone(source),
      revisions: source.revisions?.map((revision) => ({
        ...structuredClone(revision),
        messages: revision.messages.map((message) => sanitizeMessage(message, availableAssetIds)),
      })),
    })),
    messages: data.messages.map((message) => sanitizeMessage(message, availableAssetIds)),
    bindings: structuredClone(data.bindings),
  }
}

export async function exportCommunitySourceLocalAttachments(
  source: AttachmentReader,
): Promise<CommunitySourceAttachmentArchiveEntry[]> {
  const data = await source.exportAll()
  const entries: CommunitySourceAttachmentArchiveEntry[] = []
  for (const assetId of collectCommunitySourceLocalAssetIds(data)) {
    const blob = await source.getAttachmentBlob(assetId)
    if (blob) entries.push({ assetId, blob })
  }
  return entries
}

export async function readCommunitySourceLocalAttachmentsFromArchive(
  file: File,
  data: CommunitySourceBackupData,
): Promise<CommunitySourceAttachmentArchiveEntry[]> {
  const referencedIds = collectCommunitySourceLocalAssetIds(data)
  if (!referencedIds.size) return []
  const mimeTypes = collectAttachmentMimeTypes(data)
  const entryPromises: Promise<CommunitySourceAttachmentArchiveEntry>[] = []
  const seen = new Set<string>()
  let parseError: Error | undefined

  const archive = new Unzip((entry) => {
    // fflate 的 entry 只有调用 start() 才真正解压。第二遍扫描只启动 Discord 附件，
    // 避免把普通资源 / 历史版本再次解压一遍。
    if (!entry.name.startsWith(COMMUNITY_SOURCE_ATTACHMENT_ARCHIVE_PREFIX)) return

    const assetId = entry.name.slice(COMMUNITY_SOURCE_ATTACHMENT_ARCHIVE_PREFIX.length)
    if (!ARCHIVED_ASSET_ID_PATTERN.test(assetId)) {
      parseError ??= new Error(`Discord 本地附件路径无效：${entry.name}`)
      return
    }
    if (!referencedIds.has(assetId)) {
      parseError ??= new Error(`Discord 备份包含未引用的本地附件：${assetId}`)
      return
    }
    if (seen.has(assetId)) {
      parseError ??= new Error(`Discord 备份包含重复本地附件：${assetId}`)
      return
    }
    seen.add(assetId)

    entryPromises.push(
      new Promise<CommunitySourceAttachmentArchiveEntry>((resolve, reject) => {
        let size = 0
        const chunks: Uint8Array<ArrayBuffer>[] = []
        entry.ondata = (error, chunk, final) => {
          if (error) {
            reject(error)
            return
          }
          size += chunk.length
          if (size > MAX_ARCHIVED_ATTACHMENT_BYTES) {
            reject(new Error(`Discord 本地附件超过 64 MB 恢复限制：${assetId}`))
            return
          }
          if (chunk.length) {
            const copy = new Uint8Array(chunk.length)
            copy.set(chunk)
            chunks.push(copy)
          }
          if (!final) return
          resolve({
            assetId,
            blob: new Blob(chunks, {
              type: mimeTypes.get(assetId) || 'application/octet-stream',
            }),
          })
        }
        entry.start()
      }),
    )
  })
  archive.register(UnzipInflate)

  const reader = file.stream().getReader()
  while (true) {
    const { done, value } = await reader.read()
    archive.push(value ? new Uint8Array(value) : new Uint8Array(), done)
    if (done) break
  }
  if (parseError) throw parseError

  const entries = await Promise.all(entryPromises)
  for (const entry of entries) {
    const match = ARCHIVED_ASSET_ID_PATTERN.exec(entry.assetId)
    if (!match || (await hashBlob(entry.blob)) !== match[1].toLowerCase()) {
      throw new Error(`Discord 本地附件完整性校验失败：${entry.assetId}`)
    }
  }
  return entries.sort((left, right) => left.assetId.localeCompare(right.assetId))
}

/** Reuse verified archive entries, including after a process restart; never decompress twice. */
export async function readCommunitySourceStagedAttachments(
  staging: RestoreStagingStore,
  jobId: string,
  data: CommunitySourceBackupData,
): Promise<CommunitySourceAttachmentArchiveEntry[]> {
  const result: CommunitySourceAttachmentArchiveEntry[] = []
  const mimeTypes = collectAttachmentMimeTypes(data)
  for (const assetId of collectCommunitySourceLocalAssetIds(data)) {
    const match = ARCHIVED_ASSET_ID_PATTERN.exec(assetId)
    if (!match) throw new Error('Discord 附件标识无效')
    const entry = await staging.get(
      jobId,
      `${COMMUNITY_SOURCE_ATTACHMENT_ARCHIVE_PREFIX}${assetId}`,
    )
    if (!entry) continue // Legacy archives may only contain remote references.
    if (
      entry.size > MAX_ARCHIVED_ATTACHMENT_BYTES ||
      entry.sha256 !== match[1]!.toLowerCase() ||
      (await hashBlob(entry.blob)) !== entry.sha256
    )
      throw new Error(`Discord 本地附件完整性校验失败：${assetId}`)
    const blob = entry.blob.slice(
      0,
      entry.size,
      mimeTypes.get(assetId) || 'application/octet-stream',
    )
    const uri = nativeFileSource(entry.blob)
    result.push({ assetId, blob: uri ? rememberNativeFile(blob, uri) : blob })
  }
  return result
}

export async function restoreCommunitySourceLocalAttachments(
  assetStore: AttachmentAssetStore,
  entries: readonly CommunitySourceAttachmentArchiveEntry[],
): Promise<void> {
  for (const entry of entries) {
    const restored = await assetStore.put(entry.blob, {
      source: 'remote',
      vaultProtected: true,
      replaceExistingFile: true,
    })
    if (restored.assetId !== entry.assetId) {
      throw new Error(`Discord 本地附件完整性校验失败：${entry.assetId}`)
    }
  }
}
