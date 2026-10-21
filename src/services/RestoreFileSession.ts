import { COMMUNITY_SOURCE_ARCHIVE_PATH, type ArchiveManifest } from '../types/Backup'
import type { CommunitySourceBackupData } from '../types/CommunitySource'
import { parseCommunitySourceBackupData } from './CommunitySourceBackupService'
import type { RestoreStagingStore } from '../storage/RestoreStagingStore'
import { isUserPersonaAvatarAttachment, RESOURCE_TYPE, type Resource } from '../types/Resource'
import { nativeFileSize, nativeFileSource, rememberNativeFile } from '../core/NativeFileSource'
import { createImageThumbnail } from '../utils/createImageThumbnail'

/** Hydrates one verified entry and its thumbnail; planning and commit remain in RestoreService. */
export async function openArchiveFiles(
  staging: RestoreStagingStore,
  jobId: string,
  paths: Map<string, string>,
  resources: Resource[],
  preferNativeFile = false,
): Promise<{ hydrate: (resource: Resource) => Promise<Resource>; dispose: () => Promise<void> }> {
  type Avatar = { resource: Resource; index: number }
  let avatarsById: Map<string, Avatar[]> | undefined
  const materialize = async (resource: Resource): Promise<Resource> => {
    const path = paths.get(resource.contentHash.toLowerCase())
    // Personal originals are parsed for protection; character PNGs also need thumbnail bytes.
    const nativeOriginal =
      preferNativeFile &&
      resource.fileSize > 1024 * 1024 &&
      resource.type !== RESOURCE_TYPE.SECRET &&
      resource.type !== RESOURCE_TYPE.EXTRA_STORY &&
      resource.type !== RESOURCE_TYPE.POCKET_PHONE &&
      resource.type !== RESOURCE_TYPE.CHARACTER_CARD &&
      !isUserPersonaAvatarAttachment(resource)
    const entry = path
      ? ((nativeOriginal ? await staging.getNativeFile?.(jobId, path) : undefined) ??
        (await staging.get(jobId, path)))
      : undefined
    if (
      !entry ||
      entry.size !== resource.fileSize ||
      entry.sha256 !== resource.contentHash.toLowerCase()
    )
      throw new Error(`备份原文件校验失败：${resource.fileName}`)
    const originalBlob = entry.blob.slice(0, entry.blob.size, resource.mimeType)
    const nativeUri = nativeFileSource(entry.blob)
    if (nativeUri) rememberNativeFile(originalBlob, nativeUri, nativeFileSize(entry.blob))
    const avatar = isUserPersonaAvatarAttachment(resource)
    const thumbnailBlob =
      (resource.type === RESOURCE_TYPE.CHARACTER_CARD || avatar) &&
      (resource.mimeType === 'image/png' || /\.png$/iu.test(resource.fileName))
        ? ((await createImageThumbnail(originalBlob)) ?? (avatar ? originalBlob : undefined))
        : undefined
    return { ...resource, originalBlob, thumbnailBlob }
  }
  return {
    dispose: () => staging.deleteJob(jobId),
    hydrate: async (resource) => {
      const ready = await materialize(resource)
      if (resource.type === RESOURCE_TYPE.USER_PERSONA) {
        if (!avatarsById) {
          avatarsById = new Map()
          for (const [index, candidate] of resources.entries()) {
            if (!isUserPersonaAvatarAttachment(candidate)) continue
            const avatar = { resource: candidate, index },
              matches = avatarsById.get(candidate.id)
            if (matches) matches.push(avatar)
            else avatarsById.set(candidate.id, [avatar])
          }
        }
        let first: Avatar | undefined, preferred: Avatar | undefined
        for (const id of new Set(resource.relatedResourceIds ?? [])) {
          for (const avatar of avatarsById.get(id) ?? []) {
            if (!first || avatar.index < first.index) first = avatar
            if (
              avatar.resource.metadata.avatarId === resource.metadata.defaultPersonaAvatarId &&
              (!preferred || avatar.index < preferred.index)
            )
              preferred = avatar
          }
        }
        const cover = (preferred ?? first)?.resource
        if (cover) ready.thumbnailBlob = (await materialize(cover)).thumbnailBlob
      }
      return ready
    },
  }
}

export async function readCommunitySourceSidecar(
  jobId: string,
  manifest: ArchiveManifest,
  staging: RestoreStagingStore,
): Promise<CommunitySourceBackupData | undefined> {
  const descriptor = manifest.communitySources
  if (!descriptor) return undefined
  const entry = await staging.get(jobId, COMMUNITY_SOURCE_ARCHIVE_PATH)
  if (!entry) throw new Error('备份声明包含 Discord 正文，但缺少 community-sources.json')
  let parsed: unknown
  try {
    parsed = JSON.parse(await entry.blob.text())
  } catch {
    throw new Error('Discord 社区来源备份不是有效 JSON')
  }
  const data = parseCommunitySourceBackupData(parsed)
  if (
    data.sources.length !== descriptor.sourceCount ||
    data.messages.length !== descriptor.messageCount ||
    data.bindings.length !== descriptor.bindingCount
  ) {
    throw new Error('Discord 社区来源备份数量与清单不一致')
  }
  return data
}
