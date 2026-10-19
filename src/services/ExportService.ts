import {
  isResourceAttachment,
  isResourceOwnedFile,
  resourceOwnedFileOwnerId,
} from '../types/ResourceAttachment'
import { retainNativeResourceFiles } from '../storage/NativeResourceFileMirror'
import { includePersonalResource } from './PersonalResourceBackup'
import {
  includeResourceGalleryIds,
  isResourceGalleryImage,
  galleryImageUrl,
  resourceCoverId,
} from '../types/ResourceGallery'
import {
  encodeArchive,
  streamArchive,
  throwIfArchiveAborted,
  type ArchiveEncoding,
  type ArchiveTransferOptions,
} from './ArchiveZipWriter'

import {
  ARCHIVE_FORMAT,
  ARCHIVE_VERSION,
  ARCHIVE_APPLICATION_VERSION,
  COMMUNITY_SOURCE_ARCHIVE_PATH,
  COMMUNITY_SOURCE_ATTACHMENT_ARCHIVE_PREFIX,
  type ArchiveManifest,
  type ArchiveOptions,
  type ArchivedResource,
  type CreatedArchive,
} from '../types/Backup'
import type {
  CommunitySourceAttachmentArchiveEntry,
  CommunitySourceBackupData,
} from '../types/CommunitySource'
import {
  collectCommunitySourceLocalAssetIds,
  sanitizeCommunitySourceAttachmentRefs,
} from './CommunitySourceAttachmentArchive'
import {
  getRelatedResourceIds,
  includeChatCompanionIds,
  getResourceCategoryIds,
  isUserPersonaAvatarAttachment,
  normalizeResourceLinks,
  RESOURCE_TYPE,
  type Category,
  type Resource,
  type ResourceSummary,
} from '../types/Resource'
import {
  createModifiedCharacterResource,
  createCharacterCardArtworkFile,
  readCharacterCardOverrides,
} from '../utils/CharacterCardCustomization'
import { hashBlob } from './HashService'
import { readJsonChatDocument, readChatMessages } from '../parser/ChatResourceParser'
import { isRecord } from '../utils/UnknownValue'
import { JsonResourceParser } from '../parser/JsonResourceParser'
import { getModifiedResourceSyncTags } from './BrowserDevicePreferences'
import type { TavernSendContent } from '../types/BrowserPreferences'

/** Only host-readable formats get a standalone modified download. */
export function resourceDownloadFileHint(resource: Resource): string | undefined {
  if (resource.type === RESOURCE_TYPE.CHARACTER_CARD) return '角色卡 PNG，导入酒馆角色列表'
  if (resource.type === RESOURCE_TYPE.CHAT) return '聊天 JSONL，在对应角色的聊天管理中导入'
  if (!/\.json$/iu.test(resource.fileName)) return undefined
  switch (resource.type) {
    case RESOURCE_TYPE.WORLD_BOOK:
      return '世界书 JSON，导入酒馆世界书'
    case RESOURCE_TYPE.PRESET:
      return '预设 JSON，导入对应模型/API 的预设'
    case RESOURCE_TYPE.REGEX:
      return resource.metadata.detectedVariant === 'regexPreset'
        ? '正则启用方案 JSON，导入酒馆正则方案'
        : '正则 JSON，导入正则扩展；酒馆助手格式需对应扩展'
    case RESOURCE_TYPE.QUICK_REPLY:
      return '快速回复 JSON，导入酒馆快速回复扩展'
    case RESOURCE_TYPE.USER_PERSONA:
      return '人设备份 JSON，在酒馆人设管理中恢复；头像图片需另行导入'
    case RESOURCE_TYPE.BEAUTIFICATION:
      return resource.metadata.detectedVariant === 'theme'
        ? '主题 JSON，在酒馆主题设置中导入'
        : undefined
    case RESOURCE_TYPE.SCRIPT:
      return String(resource.metadata.detectedVariant).startsWith('tavernHelperScript')
        ? '酒馆助手脚本 JSON，需在酒馆助手脚本库中导入'
        : undefined
    default:
      return undefined
  }
}

function safeFileName(fileName: string): string {
  const withoutControlCharacters = Array.from(fileName, (character) =>
    character.charCodeAt(0) < 32 ? '_' : character,
  ).join('')
  const sanitized = withoutControlCharacters
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/^\.+|\.+$/g, '')
    .trim()
  return sanitized || 'resource.bin'
}

function createArchivePath(resource: Resource, version = false): string {
  return `${version ? 'versions' : 'files'}/${resource.type}/${resource.id}-${safeFileName(resource.fileName)}`
}

function withoutBlobs(
  resource: Resource,
  archivePath: string,
  selectedIds: Set<string>,
  preserveExternalRelatedResourceIds = false,
): ArchivedResource {
  return {
    id: resource.id,
    type: resource.type,
    name: resource.name,
    description: resource.description,
    fileName: resource.fileName,
    mimeType: resource.mimeType,
    fileSize: resource.fileSize,
    contentHash: resource.contentHash,
    favorite: resource.favorite,
    categoryId: resource.categoryId,
    categoryIds: getResourceCategoryIds(resource),
    relatedResourceIds: preserveExternalRelatedResourceIds
      ? getRelatedResourceIds(resource)
      : getRelatedResourceIds(resource).filter((id) => selectedIds.has(id)),
    sourceLinks: normalizeResourceLinks(resource.sourceLinks),
    tags: resource.tags,
    metadata: resource.metadata,
    versionGroupId: resource.versionGroupId,
    versionImportedAt: resource.versionImportedAt,
    versionLabel: resource.versionLabel,
    versionNote: resource.versionNote,
    versionCount: resource.versionCount,
    createdAt: resource.createdAt,
    updatedAt: resource.updatedAt,
    archivePath,
  }
}

function archiveFileName(
  mode: ArchiveOptions['mode'],
  createdAt: Date,
  part?: { index: number; total: number },
): string {
  const timestamp = createdAt.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const suffix = part
    ? `-第${String(part.index).padStart(2, '0')}卷-共${String(part.total).padStart(2, '0')}卷`
    : ''
  return `酒馆资源库-${mode === 'full' ? '完整备份' : '分包'}-${timestamp}${suffix}.zip`
}

function splitResources(resources: Resource[], splitSizeBytes?: number): Resource[][] {
  if (!splitSizeBytes || splitSizeBytes <= 0) return [resources]
  const resourcesById = new Map(resources.map((resource) => [resource.id, resource]))
  const consumedAttachmentIds = new Set<string>()
  const galleryByOwner = new Map<string, Resource[]>()
  for (const image of resources) {
    if (!isResourceOwnedFile(image)) continue
    const ownerId = resourceOwnedFileOwnerId(image)
    const images = galleryByOwner.get(ownerId) ?? []
    images.push(image)
    galleryByOwner.set(ownerId, images)
  }
  const units: Resource[][] = []
  for (const resource of resources) {
    if (isUserPersonaAvatarAttachment(resource) || isResourceOwnedFile(resource)) continue
    const attachments =
      resource.type === RESOURCE_TYPE.USER_PERSONA
        ? getRelatedResourceIds(resource).flatMap((resourceId) => {
            const related = resourcesById.get(resourceId)
            if (!related || !isUserPersonaAvatarAttachment(related)) return []
            consumedAttachmentIds.add(related.id)
            return [related]
          })
        : []
    units.push([resource, ...attachments, ...(galleryByOwner.get(resource.id) ?? [])])
  }
  for (const resource of resources) {
    if (
      (isUserPersonaAvatarAttachment(resource) && !consumedAttachmentIds.has(resource.id)) ||
      (isResourceAttachment(resource) && !resourcesById.has(resourceOwnedFileOwnerId(resource)))
    ) {
      units.push([resource])
    }
  }
  const groups: Resource[][] = []
  let current: Resource[] = []
  let currentSize = 0

  for (const unit of units) {
    const unitSize = unit.reduce((total, resource) => total + resource.fileSize, 0)
    if (current.length && currentSize + unitSize > splitSizeBytes) {
      groups.push(current)
      current = []
      currentSize = 0
    }
    current.push(...unit)
    currentSize += unitSize
  }
  if (current.length) groups.push(current)
  return groups.length ? groups : [[]]
}

/** Keep parent/derived images together; each saved image belongs to exactly one ZIP volume. */
function splitAlbum(
  album: NonNullable<import('../types/Backup').ArchivePortableData['generatedImageAlbum']>,
  limit: number,
) {
  const roots = new Map(album.map((entry) => [entry.item.id, entry.item.id]))
  const root = (id: string): string => {
    let current = id
    while (roots.get(current) !== current) current = roots.get(current)!
    while (roots.get(id) !== id) {
      const next = roots.get(id)!
      roots.set(id, current)
      id = next
    }
    return current
  }
  for (const entry of album) {
    const parent = entry.item.generationManifest?.parentImageId
    if (parent && roots.has(parent)) roots.set(root(entry.item.id), root(parent))
  }
  const families = new Map<string, typeof album>()
  for (const entry of album) {
    const id = root(entry.item.id),
      family = families.get(id) ?? []
    family.push(entry)
    families.set(id, family)
  }
  const result: Array<typeof album> = []
  let current: typeof album = [],
    size = 0
  for (const family of families.values()) {
    const bytes = family.reduce((sum, entry) => sum + entry.item.sizeBytes, 0)
    if (current.length && size + bytes > limit) {
      result.push(current)
      current = []
      size = 0
    }
    current.push(...family)
    size += bytes
  }
  if (current.length) result.push(current)
  return result
}

function hasPortableContent(options: ArchiveOptions): boolean {
  return Boolean(
    options.communitySourceData ||
    Object.keys(options.portableData ?? {}).some((key) => key !== 'version'),
  )
}

function selectResourcesForArchive(resources: Resource[], options: ArchiveOptions): Resource[] {
  if (options.personalResources)
    resources = resources.filter((resource) =>
      includePersonalResource(resource, options.personalResources),
    )
  const selectedIds = new Set(
    options.mode === 'full' || !options.resourceIds
      ? resources.map((r) => r.id)
      : options.resourceIds,
  )
  if (!selectedIds.size) return []
  const includesAll =
    options.mode === 'full' ||
    !options.resourceIds ||
    resources.every((resource) => selectedIds.has(resource.id))
  if (!includesAll) {
    if (
      resources.some(
        (resource) => resource.type === RESOURCE_TYPE.CHAT && selectedIds.has(resource.id),
      )
    )
      includeChatCompanionIds(resources, selectedIds)
    let byId: Map<string, Resource> | undefined
    for (const resource of resources) {
      if (resource.type !== RESOURCE_TYPE.USER_PERSONA || !selectedIds.has(resource.id)) continue
      for (const relatedId of getRelatedResourceIds(resource)) {
        if (!byId) {
          byId = new Map()
          for (const candidate of resources)
            if (!byId.has(candidate.id)) byId.set(candidate.id, candidate)
        }
        const related = byId.get(relatedId)
        if (related && isUserPersonaAvatarAttachment(related)) selectedIds.add(related.id)
      }
    }
  }
  includeResourceGalleryIds(
    resources,
    selectedIds,
    options.portableSelection?.resourceGallery !== false,
    options.portableSelection?.resourceAttachments !== false,
    options.preserveExternalRelatedResourceIds === true,
  )
  return resources.filter((resource) => selectedIds.has(resource.id))
}

function selectCommunitySourcesForArchive(
  data: CommunitySourceBackupData | undefined,
  resourceIds: Set<string>,
  includeUnbound: boolean,
): CommunitySourceBackupData | undefined {
  if (!data) return undefined
  const bindings = data.bindings.filter((binding) => resourceIds.has(binding.resourceId))
  const boundSourceIds = new Set(bindings.map((binding) => binding.sourceId))
  const allBoundSourceIds = new Set(data.bindings.map((binding) => binding.sourceId))
  const selectedSourceIds = new Set(boundSourceIds)
  if (includeUnbound) {
    for (const source of data.sources) {
      if (!allBoundSourceIds.has(source.id)) selectedSourceIds.add(source.id)
    }
  }
  const sources = data.sources.filter((source) => selectedSourceIds.has(source.id))
  if (!sources.length) return undefined
  const messages = data.messages.filter((message) => selectedSourceIds.has(message.sourceId))
  return {
    version: 1,
    sources: structuredClone(sources),
    messages: structuredClone(messages),
    bindings: structuredClone(bindings),
  }
}

function selectCommunityAttachmentsForArchive(
  data: CommunitySourceBackupData | undefined,
  attachments: readonly CommunitySourceAttachmentArchiveEntry[] | undefined,
): {
  data: CommunitySourceBackupData | undefined
  attachments: CommunitySourceAttachmentArchiveEntry[]
} {
  if (!data) return { data: undefined, attachments: [] }
  const referencedIds = collectCommunitySourceLocalAssetIds(data)
  const selected = new Map<string, CommunitySourceAttachmentArchiveEntry>()
  for (const attachment of attachments ?? []) {
    if (!referencedIds.has(attachment.assetId) || selected.has(attachment.assetId)) continue
    selected.set(attachment.assetId, attachment)
  }
  const availableIds = new Set(selected.keys())
  return {
    data: sanitizeCommunitySourceAttachmentRefs(data, availableIds),
    attachments: [...selected.values()].sort((left, right) =>
      left.assetId.localeCompare(right.assetId),
    ),
  }
}

export interface ArchiveStreamWriter {
  encode?(encoding: ArchiveEncoding): Promise<number>
  write(chunk: Uint8Array): Promise<void>
  commit(): Promise<void>
  abort(): Promise<void>
}

export interface StreamedArchive {
  fileName: string
  manifest: ArchiveManifest
  bytes: number
}

/** Summaries plan selection; each read loads one complete resource. */
export interface ArchiveSource {
  resources: ResourceSummary[]
  versions: ResourceSummary[]
  read(resource: ResourceSummary, historical: boolean): Promise<Resource>
}

export async function createResourceArchiveSource(
  service: import('./ResourceService').ResourceService,
  selectedIds?: string[],
  allowDetachedAttachments = false,
): Promise<ArchiveSource> {
  const selection = selectedIds ? new Set(selectedIds) : undefined
  let resources = await service.listResourceListSummaries(
    selection ? { ids: [...selection] } : undefined,
  )
  if (selection?.size) {
    // Preserve the eager export's chat dependencies and persona avatars using
    // only their referenced IDs. Their gallery and history are then planned once.
    const companionIds = new Set<string>()
    for (const resource of resources) {
      if (resource.type === RESOURCE_TYPE.CHAT) {
        for (const id of getRelatedResourceIds(resource)) companionIds.add(id)
        for (const key of ['chatDisplayRegexId', 'chatReadingScriptId']) {
          const id = resource.metadata[key]
          if (typeof id === 'string') companionIds.add(id)
        }
      } else if (resource.type === RESOURCE_TYPE.USER_PERSONA) {
        for (const id of getRelatedResourceIds(resource)) companionIds.add(id)
      }
    }
    const missing = [...companionIds].filter((id) => !selection.has(id))
    const companions = missing.length
      ? await service.listResourceListSummaries({ ids: missing })
      : []
    const candidates = [...resources, ...companions]
    if (
      candidates.some(
        (resource) => resource.type === RESOURCE_TYPE.CHAT && selection.has(resource.id),
      )
    )
      includeChatCompanionIds(candidates, selection)
    const avatars = new Map<string, { id: string; index: number }>()
    for (const [index, companion] of companions.entries()) {
      const id = companion.id
      if (isUserPersonaAvatarAttachment(companion) && !avatars.has(id))
        avatars.set(id, { id, index })
    }
    for (const resource of resources) {
      if (resource.type !== RESOURCE_TYPE.USER_PERSONA) continue
      const related = getRelatedResourceIds(resource)
        .flatMap((id) => {
          const avatar = avatars.get(id)
          return avatar ? [avatar] : []
        })
        .sort((left, right) => left.index - right.index)
      for (const avatar of related) selection.add(avatar.id)
    }
    resources = candidates.filter((resource) => selection.has(resource.id))
    // Gallery ownership lives in metadata, so only OTHER summaries need a scan.
    // Unselected character/chat bodies and metadata never enter a single-item archive plan.
    const owners = new Set(resources.filter((r) => !isResourceOwnedFile(r)).map((r) => r.id))
    const images = (
      await service.listResourceListSummaries({ types: [RESOURCE_TYPE.OTHER] })
    ).filter((r) => isResourceOwnedFile(r) && owners.has(resourceOwnedFileOwnerId(r)))
    const byId = new Map([...resources, ...images].map((r) => [r.id, r]))
    resources = [...byId.values()]
  }
  if (selection)
    includeResourceGalleryIds(resources, selection, true, true, allowDetachedAttachments)
  return {
    resources: selection ? resources.filter((resource) => selection.has(resource.id)) : resources,
    versions: selection
      ? await service.listVersionSummariesForResources([...selection])
      : await service.listVersionSummaries(true),
    read: async (summary, historical) => {
      const resource = historical
        ? await service.getVersion(summary.id)
        : await service.get(summary.id)
      if (!resource) throw new Error(`导出资源已不存在：${summary.fileName}`)
      return resource
    },
  }
}

type ArchiveWriterFactory = (
  fileName: string,
  manifest: ArchiveManifest,
) => Promise<ArchiveStreamWriter>

type CommunitySourceExportProvider = () => Promise<CommunitySourceBackupData>
type CommunitySourceAttachmentExportProvider = () => Promise<
  CommunitySourceAttachmentArchiveEntry[]
>

interface InternalCreatedArchive extends CreatedArchive {
  streamedBytes?: number
}

export class ExportService {
  private readonly communitySourceExportProvider?: CommunitySourceExportProvider
  private readonly communitySourceAttachmentExportProvider?: CommunitySourceAttachmentExportProvider

  private readonly readAlbumFile?: (id: string) => Promise<Blob>

  constructor(
    communitySourceExportProvider?: CommunitySourceExportProvider,
    communitySourceAttachmentExportProvider?: CommunitySourceAttachmentExportProvider,
    readAlbumFile?: (id: string) => Promise<Blob>,
  ) {
    this.readAlbumFile = readAlbumFile
    this.communitySourceExportProvider = communitySourceExportProvider
    this.communitySourceAttachmentExportProvider = communitySourceAttachmentExportProvider
  }

  /** A single-resource delivery uses the existing restore format for library-only details. */
  async createResourceDownloadArchive(
    resource: Resource,
    attachments: Resource[],
    categories: Category[],
    replacementResources: Resource[] = [],
  ): Promise<CreatedArchive> {
    const exported = await this.prepareCharacterDownload(
      resource,
      attachments,
      replacementResources,
    )
    const coverId = resourceCoverId(resource)
    const images = attachments.map((image) =>
      image.id === coverId && isResourceGalleryImage(image)
        ? { ...image, metadata: { ...image.metadata, galleryOwnerId: exported.id } }
        : image,
    )
    const result = await this.createArchive([exported, ...images], categories, {
      mode: 'partial',
      resourceIds: [exported.id],
      resourceContent: 'modified',
      preserveExternalRelatedResourceIds: true,
    })
    return { ...result, fileName: `${safeFileName(resource.name)}-修改版.zip` }
  }

  async createResourceDownloadFile(
    resource: Resource,
    attachments: Resource[] = [],
    replacementResources: Resource[] = [],
    options: { syncCharacterTags?: boolean } = { syncCharacterTags: getModifiedResourceSyncTags() },
  ): Promise<File> {
    if (!resourceDownloadFileHint(resource))
      throw new Error('此资源没有酒馆原生单文件格式，请下载原版或完整修改包')
    const stem = safeFileName(resource.name).replace(/\.(png|jsonl|json)$/iu, '')
    if (resource.type === RESOURCE_TYPE.CHARACTER_CARD) {
      const prepared = await this.prepareCharacterDownload(
        resource,
        attachments,
        replacementResources,
        true,
        options.syncCharacterTags,
      )
      return new File([prepared.originalBlob], `${stem}-修改版.png`, { type: 'image/png' })
    }
    if (resource.type === RESOURCE_TYPE.CHAT) {
      if (resource.metadata.format !== 'json' && !/\.json$/iu.test(resource.fileName)) {
        // Validate through the existing streaming reader; retain header, swipes and unknown fields.
        let count = 0
        for await (const message of readChatMessages(resource.originalBlob, 'jsonl')) {
          void message
          count++
        }
        if (!count) throw new Error('聊天记录中没有消息')
        return new File([resource.originalBlob], `${stem}-修改版.jsonl`, {
          type: 'application/x-ndjson',
        })
      }
      const { header: savedHeader, messages } = await readJsonChatDocument(resource.originalBlob)
      const header = savedHeader ?? {
        user_name: messages.find((item) => item.is_user)?.name ?? 'User',
        character_name: messages.find((item) => !item.is_user)?.name ?? resource.name,
        chat_metadata: {},
      }
      return new File(
        [
          JSON.stringify(header) + '\n',
          ...messages.map((message) => JSON.stringify(message) + '\n'),
        ],
        `${stem}-修改版.jsonl`,
        { type: 'application/x-ndjson' },
      )
    }
    const parsed = await new JsonResourceParser().parse(
      new File([resource.originalBlob], resource.fileName, { type: 'application/json' }),
    )
    if (parsed.type !== resource.type)
      throw new Error('文件内容与资源类型不一致，请核对后下载原版或完整修改包')
    // These editors save through the resource/version owner, so the current bytes are authoritative.
    if (
      resource.type === RESOURCE_TYPE.REGEX &&
      resource.metadata.detectedVariant === 'regexCollection'
    ) {
      const value: unknown = JSON.parse(await resource.originalBlob.text())
      if (isRecord(value)) {
        const scripts = ['global', 'scoped', 'preset'].flatMap((key) =>
          Array.isArray(value[key]) ? value[key] : [],
        )
        if (scripts.length)
          return new File([JSON.stringify(scripts, null, 2)], `${stem}-修改版.json`, {
            type: 'application/json',
          })
      }
    }
    return new File([await this.prepareNativeNamedContent(resource)], `${stem}-修改版.json`, {
      type: 'application/json',
    })
  }

  /** Only native names are materialized; collection members and scope bindings keep their identity. */
  private async prepareNativeNamedContent(resource: Resource): Promise<Blob> {
    const name = resource.name.trim()
    if (!name) return resource.originalBlob
    const supported = [
      RESOURCE_TYPE.WORLD_BOOK,
      RESOURCE_TYPE.PRESET,
      RESOURCE_TYPE.REGEX,
      RESOURCE_TYPE.SCRIPT,
      RESOURCE_TYPE.QUICK_REPLY,
      RESOURCE_TYPE.BEAUTIFICATION,
      RESOURCE_TYPE.USER_PERSONA,
    ]
    if (!supported.includes(resource.type as (typeof supported)[number]))
      return resource.originalBlob
    if (!/\.json$/iu.test(resource.fileName)) return resource.originalBlob
    if (
      resource.type === RESOURCE_TYPE.BEAUTIFICATION &&
      resource.metadata.detectedVariant !== 'theme'
    )
      return resource.originalBlob
    const value: unknown = JSON.parse(await resource.originalBlob.text())
    if (!isRecord(value)) return resource.originalBlob
    if (resource.type === RESOURCE_TYPE.REGEX) {
      if (typeof value.scriptName === 'string') value.scriptName = name
      else if (typeof value.script_name === 'string') value.script_name = name
      else if (resource.metadata.detectedVariant === 'regexPreset') value.name = name
      else return resource.originalBlob
    } else if (resource.type === RESOURCE_TYPE.USER_PERSONA) {
      if (!isRecord(value.personas)) return resource.originalBlob
      const avatars = Object.keys(value.personas)
      if (avatars.length !== 1) return resource.originalBlob
      value.personas[avatars[0]!] = name
    } else {
      value.name = name
    }
    return new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })
  }

  /** Cards retain avatar identity; other native files use saved names without changing scope targets. */
  async createTavernTransferFile(
    resource: Resource,
    content: TavernSendContent,
    source: Pick<import('./ResourceService').ResourceService, 'get'>,
    fileName = resource.fileName,
    options: { syncCharacterTags?: boolean } = { syncCharacterTags: getModifiedResourceSyncTags() },
  ): Promise<File> {
    if (content === 'original')
      return new File([resource.originalBlob], fileName, { type: resource.mimeType })
    if (!resourceDownloadFileHint(resource))
      return new File([resource.originalBlob], fileName, { type: resource.mimeType })
    const stem = safeFileName(resource.name).replace(/\.(png|jsonl|json)$/iu, '')
    if (resource.type !== RESOURCE_TYPE.CHARACTER_CARD && resource.type !== RESOURCE_TYPE.CHAT)
      return new File([await this.prepareNativeNamedContent(resource)], `${stem}.json`, {
        type: resource.mimeType,
      })
    const attachments: Resource[] = []
    const replacements: Resource[] = []
    if (resource.type === RESOURCE_TYPE.CHARACTER_CARD) {
      const coverId = resourceCoverId(resource)
      if (coverId) {
        const cover = await source.get(coverId)
        if (!cover) throw new Error('自定义封面已不存在，无法发送修改版')
        attachments.push(cover)
      }
      const overrides = readCharacterCardOverrides(resource.metadata)
      for (const id of new Set([overrides.worldBookResourceId, overrides.greetingResourceId])) {
        if (!id) continue
        const replacement = await source.get(id)
        if (replacement) replacements.push(replacement)
      }
    }
    const file = await this.createResourceDownloadFile(resource, attachments, replacements, options)
    const extension = resource.type === RESOURCE_TYPE.CHARACTER_CARD ? '.png' : '.jsonl'
    const name =
      resource.type === RESOURCE_TYPE.CHAT
        ? stem + extension
        : safeFileName(fileName).replace(/\.[^.]+$/u, '') + extension
    return new File([file], name, { type: file.type })
  }

  private async prepareCharacterDownload(
    resource: Resource,
    attachments: Resource[],
    replacementResources: Resource[],
    png = false,
    syncCharacterTags = getModifiedResourceSyncTags(),
  ): Promise<Resource> {
    let exported =
      resource.type === RESOURCE_TYPE.CHARACTER_CARD
        ? await createModifiedCharacterResource(
            resource,
            replacementResources,
            undefined,
            syncCharacterTags,
          )
        : resource
    const coverId = resourceCoverId(resource)
    if (
      resource.type === RESOURCE_TYPE.CHARACTER_CARD &&
      (coverId || (png && !/\.png$/iu.test(exported.fileName) && exported.mimeType !== 'image/png'))
    ) {
      const cover = coverId ? attachments.find((image) => image.id === coverId) : undefined
      if (coverId && !cover) throw new Error('自定义封面已不存在，无法导出修改版')
      const url = cover ? galleryImageUrl(cover) : undefined
      // JSON cards without artwork use a neutral PNG carrier, never an unrelated image.
      const blank =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
      let artwork =
        cover?.originalBlob ??
        resource.thumbnailBlob ??
        new Blob([Uint8Array.from(atob(blank), (value) => value.charCodeAt(0))], {
          type: 'image/png',
        })
      if (url) {
        const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' })
        if (!response.ok) throw new Error(`自定义封面下载失败（${response.status}）`)
        artwork = await response.blob()
      }
      const file = await createCharacterCardArtworkFile(exported, artwork)
      exported = {
        ...exported,
        originalBlob: file,
        fileName: file.name,
        mimeType: file.type,
        fileSize: file.size,
        contentHash: await hashBlob(file),
      }
    }
    return exported
  }

  async prepareOptions(
    options: ArchiveOptions,
    signal?: AbortSignal,
    freezeAlbum = false,
  ): Promise<ArchiveOptions> {
    if (freezeAlbum && options.portableData?.generatedImageAlbum?.length) {
      const { createGitHubBundle } = await import('./GitHubBackupBundle')
      const album = []
      for (const entry of options.portableData.generatedImageAlbum) {
        throwIfArchiveAborted(signal)
        let object = entry.object
        if (!object) {
          const blob = await (options.readAlbumFile ?? this.readAlbumFile)?.(entry.item.id)
          throwIfArchiveAborted(signal)
          if (!blob || blob.size !== entry.item.sizeBytes)
            throw new Error(`相册原图缺失或已变化：${entry.item.name}`)
          object = (await createGitHubBundle(blob, entry.item.name)).manifest
        }
        throwIfArchiveAborted(signal)
        album.push({ item: entry.item, object })
      }
      options = {
        ...options,
        portableData: { ...options.portableData, generatedImageAlbum: album },
      }
    }
    if (!options.portableSelection?.communitySources) return options
    const communitySourceData =
      options.communitySourceData ?? (await this.communitySourceExportProvider?.())
    if (!communitySourceData) return options
    const communitySourceAttachments =
      options.communitySourceAttachments ??
      (await this.communitySourceAttachmentExportProvider?.()) ??
      []
    return {
      ...options,
      communitySourceData,
      communitySourceAttachments,
    }
  }

  async createArchive(
    resources: Resource[],
    categories: Category[],
    options: ArchiveOptions,
    versions: Resource[] = [],
    transfer?: ArchiveTransferOptions,
  ): Promise<CreatedArchive> {
    const preparedOptions = await this.prepareOptions(options)
    return this.createSingleArchive(
      resources,
      categories,
      {
        ...preparedOptions,
        splitSizeBytes: undefined,
      },
      undefined,
      versions,
      resources,
      undefined,
      undefined,
      transfer,
    )
  }

  async createArchives(
    resources: Resource[],
    categories: Category[],
    options: ArchiveOptions,
    versions: Resource[] = [],
  ): Promise<CreatedArchive[]> {
    return this.createArchivesInternal(
      resources,
      categories,
      await this.prepareOptions(options),
      versions,
    )
  }

  async createArchivesToSinks(
    resources: Resource[],
    categories: Category[],
    options: ArchiveOptions,
    versions: Resource[],
    writerFactory: ArchiveWriterFactory,
  ): Promise<StreamedArchive[]> {
    const archives = await this.createArchivesInternal(
      resources,
      categories,
      await this.prepareOptions(options),
      versions,
      writerFactory,
    )
    return archives.map((archive) => ({
      fileName: archive.fileName,
      manifest: archive.manifest,
      bytes: archive.streamedBytes ?? 0,
    }))
  }

  async createArchivesFromSource(
    source: ArchiveSource,
    categories: Category[],
    options: ArchiveOptions,
    writerFactory?: (fileName: string) => Promise<ArchiveStreamWriter>,
    transfer?: ArchiveTransferOptions,
  ): Promise<Array<Omit<InternalCreatedArchive, 'manifest'> & { resourceCount: number }>> {
    throwIfArchiveAborted(transfer?.signal)
    let placeholderBlob: Blob | undefined
    const placeholder = (resource: ResourceSummary): Resource => ({
      ...resource,
      originalBlob: (placeholderBlob ??= new Blob()),
    })
    const archives = await this.createArchivesInternal(
      source.resources.map(placeholder),
      categories,
      await this.prepareOptions(options),
      source.versions.map(placeholder),
      writerFactory,
      source,
      transfer,
    )
    return archives.map(({ manifest, ...archive }) => ({
      ...archive,
      resourceCount: manifest.resourceCount,
    }))
  }

  private async createArchivesInternal(
    ...args: Parameters<ExportService['buildArchivesInternal']>
  ): Promise<InternalCreatedArchive[]> {
    const release = retainNativeResourceFiles()
    try {
      return await this.buildArchivesInternal(...args)
    } finally {
      await release()
    }
  }

  private async buildArchivesInternal(
    resources: Resource[],
    categories: Category[],
    options: ArchiveOptions,
    versions: Resource[] = [],
    writerFactory?: ArchiveWriterFactory,
    source?: ArchiveSource,
    transfer?: ArchiveTransferOptions,
  ): Promise<InternalCreatedArchive[]> {
    throwIfArchiveAborted(transfer?.signal)
    const selectedResources = selectResourcesForArchive(resources, options)

    if (
      options.mode === 'partial' &&
      selectedResources.length === 0 &&
      !hasPortableContent(options)
    ) {
      throw new Error('请至少选择一项资源')
    }

    let groups = splitResources(selectedResources, options.splitSizeBytes)
    let albumsByGroup = groups.map(() => options.portableData?.generatedImageAlbum)
    if (
      options.splitSizeBytes &&
      options.splitSizeBytes > 0 &&
      options.portableData?.generatedImageAlbum?.length
    ) {
      groups = groups.filter((group) => group.length > 0)
      albumsByGroup = groups.map(() => undefined)
      for (const album of splitAlbum(
        options.portableData.generatedImageAlbum,
        options.splitSizeBytes,
      )) {
        groups.push([])
        albumsByGroup.push(album)
      }
    }
    const versionsByGroup = groups.map(() => [] as Resource[])
    if (versions.length) {
      const memberGroups = new Map<string, number[]>()
      for (const [index, group] of groups.entries()) {
        for (const resource of group) {
          const id = resource.id,
            indexes = memberGroups.get(id)
          if (!indexes) memberGroups.set(id, [index])
          else if (indexes[indexes.length - 1] !== index) indexes.push(index)
        }
      }
      // Append in input order; the same owner can occur in more than one part.
      for (const version of versions) {
        const owner = version.versionGroupId
        if (owner === undefined) continue
        for (const index of memberGroups.get(owner) ?? []) versionsByGroup[index]!.push(version)
      }
    }
    let relatedById: Map<string, ResourceSummary | undefined> | undefined
    let allRelatedIndexed = false
    const relatedSummaries = source?.resources
    const findRelatedSummary =
      relatedSummaries && options.resourceContent === 'modified'
        ? (id: string) => {
            if (!relatedById) {
              relatedById = new Map()
            }
            if (!allRelatedIndexed && !relatedById.has(id)) {
              // One card has at most two replacements. Resolve just those until
              // a batch requests more distinct IDs, then index the snapshot once.
              if (relatedById.size < 2)
                relatedById.set(
                  id,
                  relatedSummaries.find((summary) => summary.id === id),
                )
              else {
                for (const summary of relatedSummaries)
                  if (!relatedById.has(summary.id)) relatedById.set(summary.id, summary)
                allRelatedIndexed = true
              }
            }
            return relatedById.get(id)
          }
        : undefined
    const archives: InternalCreatedArchive[] = []
    for (const [index, group] of groups.entries()) {
      archives.push(
        await this.createSingleArchive(
          group,
          categories,
          {
            ...options,
            portableData: options.portableData
              ? { ...options.portableData, generatedImageAlbum: albumsByGroup[index] }
              : undefined,
            resourceIds: group.map((resource) => resource.id),
            splitSizeBytes: undefined,
          },
          groups.length > 1 ? { index: index + 1, total: groups.length } : undefined,
          versionsByGroup[index],
          resources,
          writerFactory,
          source,
          transfer,
          findRelatedSummary,
        ),
      )
    }
    return archives
  }

  private async createSingleArchive(
    ...args: Parameters<ExportService['buildSingleArchive']>
  ): Promise<InternalCreatedArchive> {
    const release = retainNativeResourceFiles()
    try {
      return await this.buildSingleArchive(...args)
    } finally {
      await release()
    }
  }

  private async buildSingleArchive(
    resources: Resource[],
    categories: Category[],
    options: ArchiveOptions,
    part?: { index: number; total: number },
    versions: Resource[] = [],
    replacementResources: Resource[] = resources,
    writerFactory?: ArchiveWriterFactory,
    source?: ArchiveSource,
    transfer?: ArchiveTransferOptions,
    findRelatedSummary?: (id: string) => ResourceSummary | undefined,
  ): Promise<InternalCreatedArchive> {
    throwIfArchiveAborted(transfer?.signal)
    const selectedResources = selectResourcesForArchive(resources, options)

    if (
      options.mode === 'partial' &&
      selectedResources.length === 0 &&
      !hasPortableContent(options)
    ) {
      throw new Error('请至少选择一项资源')
    }

    const exportedResources = selectedResources
    const referencedCategoryIds = new Set(exportedResources.flatMap(getResourceCategoryIds))
    const selectedCategories =
      options.mode === 'full' || options.includeAllCategories
        ? categories
        : categories.filter((category) => referencedCategoryIds.has(category.id))
    const archivedResources: ArchivedResource[] = []
    const descriptorPositions = !source
      ? ([new Map<string, number>(), new Map<string, number>()] as const)
      : undefined
    const archivedResourceIds = new Set(exportedResources.map((resource) => resource.id))

    for (const resource of exportedResources) {
      const archivePath = createArchivePath(resource)
      const descriptor = withoutBlobs(
        resource,
        archivePath,
        archivedResourceIds,
        options.preserveExternalRelatedResourceIds,
      )
      if (descriptorPositions && !descriptorPositions[0].has(descriptor.id))
        descriptorPositions[0].set(descriptor.id, archivedResources.length)
      archivedResources.push(descriptor)
    }
    const selectedVersions = versions.filter((version) =>
      archivedResourceIds.has(version.versionGroupId ?? ''),
    )
    const exportedVersions = selectedVersions
    const archivedVersions = exportedVersions.map((version, index) => {
      const descriptor = withoutBlobs(
        version,
        createArchivePath(version, true),
        archivedResourceIds,
        options.preserveExternalRelatedResourceIds,
      )
      if (descriptorPositions && !descriptorPositions[1].has(descriptor.id))
        descriptorPositions[1].set(descriptor.id, index)
      return descriptor
    })

    const selectedCommunitySourceData = selectCommunitySourcesForArchive(
      options.communitySourceData,
      archivedResourceIds,
      options.mode === 'full' && (!part || part.index === 1),
    )
    const selectedCommunity = selectCommunityAttachmentsForArchive(
      selectedCommunitySourceData,
      options.communitySourceAttachments,
    )
    const communitySourceData = selectedCommunity.data
    const communitySourceAttachments = selectedCommunity.attachments
    const createdAt = new Date(transfer?.createdAt ?? Date.now())
    const manifest: ArchiveManifest = {
      format: ARCHIVE_FORMAT,
      version:
        options.portableData?.generatedImageAlbum ||
        options.portableData?.frontendWorkshopProjects ||
        options.portableData?.imageGeneration
          ? ARCHIVE_APPLICATION_VERSION
          : ARCHIVE_VERSION,
      mode: options.mode,
      resourceContent: options.resourceContent ?? 'original',
      createdAt: createdAt.toISOString(),
      resourceCount: archivedResources.length,
      categoryCount: selectedCategories.length,
      categories: selectedCategories,
      resources: archivedResources,
      versionCount: archivedVersions.length,
      versions: archivedVersions,
      portableData: options.portableData
        ? {
            ...options.portableData,
            resourceGalleryCategories:
              options.portableSelection?.resourceGallery === false
                ? undefined
                : options.portableData.resourceGalleryCategories,
            ...(options.portableData.plaintextSecretCopies
              ? {
                  plaintextSecretCopies: options.portableData.plaintextSecretCopies.filter((copy) =>
                    archivedResources.some((resource) => resource.contentHash === copy.contentHash),
                  ),
                }
              : {}),
          }
        : undefined,
      ...(communitySourceData
        ? {
            communitySources: {
              version: 1 as const,
              path: COMMUNITY_SOURCE_ARCHIVE_PATH,
              sourceCount: communitySourceData.sources.length,
              messageCount: communitySourceData.messages.length,
              bindingCount: communitySourceData.bindings.length,
              attachmentCount: communitySourceAttachments.length,
              attachmentPathPrefix: COMMUNITY_SOURCE_ATTACHMENT_ARCHIVE_PREFIX,
            },
          }
        : {}),
    }
    const fileName = archiveFileName(options.mode, createdAt, part)
    const encoding: ArchiveEncoding = {
      readAlbumFile: options.readAlbumFile ?? this.readAlbumFile,
      signal: transfer?.signal,
      readAhead: transfer?.readAhead,
      onReadFailures: transfer?.onReadFailures,
      readCommunityAttachment: transfer?.readCommunityAttachment,
      onProgress: ({ writtenBytes }) => transfer?.onProgress?.({ writtenBytes, fileName }),
      resources: exportedResources,
      versions: exportedVersions,
      manifest,
      communitySourceData,
      communitySourceAttachments,
      path: createArchivePath,
      read: async (planned, historical) => {
        let resource = source ? await source.read(planned, historical) : planned
        if (
          resource.id !== planned.id ||
          resource.contentHash !== planned.contentHash ||
          resource.updatedAt !== planned.updatedAt
        )
          throw new Error(`导出期间资源发生变化，请重新导出：${planned.fileName}`)
        if (options.resourceContent === 'modified') {
          const overrides = readCharacterCardOverrides(resource.metadata)
          const related = source ? [] : replacementResources
          if (source) {
            for (const id of new Set([
              overrides.worldBookResourceId,
              overrides.greetingResourceId,
            ])) {
              if (!id) continue
              const summary = findRelatedSummary?.(id)
              if (summary) {
                const value = await source.read(summary, false)
                if (
                  value.contentHash !== summary.contentHash ||
                  value.updatedAt !== summary.updatedAt
                )
                  throw new Error(`导出关联资源已变化：${summary.fileName}`)
                related.push(value)
              }
            }
          }
          resource = await createModifiedCharacterResource(
            resource,
            related,
            undefined,
            getModifiedResourceSyncTags(),
          )
        }
        return resource
      },
      describe: (resource, historical) => {
        const descriptor = withoutBlobs(
          resource,
          createArchivePath(resource, historical),
          archivedResourceIds,
          options.preserveExternalRelatedResourceIds,
        )
        // Eager API callers retain the complete manifest. Lazy export callers receive only
        // the file/result; the complete on-disk manifest is serialized one record at a time.
        if (descriptorPositions) {
          const records = historical ? archivedVersions : archivedResources
          records[descriptorPositions[historical ? 1 : 0].get(descriptor.id) ?? -1] = descriptor
        }
        return descriptor
      },
    }
    if (writerFactory) {
      const writer = await writerFactory(fileName, manifest)
      try {
        const streamedBytes = writer.encode
          ? await writer.encode(encoding)
          : await encodeArchive(encoding, writer.write)
        throwIfArchiveAborted(transfer?.signal)
        await writer.commit()
        return {
          blob: new Blob([], { type: 'application/zip' }),
          fileName,
          manifest,
          streamedBytes,
        }
      } catch (error) {
        await writer.abort().catch(() => undefined)
        throw error
      }
    }

    const blob = await streamArchive(encoding)

    return {
      blob,
      fileName,
      manifest,
    }
  }
}
