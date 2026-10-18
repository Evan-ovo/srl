import { isRecord } from '../utils/UnknownValue'

export const RESOURCE_TYPE = {
  CHARACTER_CARD: 'characterCard',
  GREETING: 'greeting',
  CHAT: 'chat',
  USER_PERSONA: 'userPersona',
  WORLD_BOOK: 'worldBook',
  BEAUTIFICATION: 'beautification',
  REGEX: 'regex',
  PRESET: 'preset',
  QUICK_REPLY: 'quickReply',
  SCRIPT: 'script',
  PLUGIN: 'plugin',
  EXTRA_STORY: 'extraStory',
  POCKET_PHONE: 'pocketPhone',
  SECRET: 'secret',
  OTHER: 'other',
} as const

export type ResourceType = (typeof RESOURCE_TYPE)[keyof typeof RESOURCE_TYPE]

export const RESOURCE_LINK_TYPE = {
  DISCORD: 'discord',
  WEBSITE: 'website',
  GITHUB: 'github',
  PATREON: 'patreon',
  KOFI: 'kofi',
  OTHER: 'other',
} as const

export type ResourceLinkType = (typeof RESOURCE_LINK_TYPE)[keyof typeof RESOURCE_LINK_TYPE]

export const RESOURCE_LINK_TYPE_LABELS: Record<ResourceLinkType, string> = {
  [RESOURCE_LINK_TYPE.DISCORD]: 'Discord',
  [RESOURCE_LINK_TYPE.WEBSITE]: '网页',
  [RESOURCE_LINK_TYPE.GITHUB]: 'GitHub',
  [RESOURCE_LINK_TYPE.PATREON]: 'Patreon',
  [RESOURCE_LINK_TYPE.KOFI]: 'Ko-fi',
  [RESOURCE_LINK_TYPE.OTHER]: '其他',
}

export const RESOURCE_LINK_PURPOSE = {
  SOURCE_POST: 'sourcePost',
  REPOSITORY: 'repository',
  RELEASE: 'release',
  RAW_FILE: 'rawFile',
  DOWNLOAD: 'download',
  DOCS: 'docs',
  INSTALL_GUIDE: 'installGuide',
  AUTHOR: 'author',
  MIRROR: 'mirror',
} as const

export type ResourceLinkPurpose = (typeof RESOURCE_LINK_PURPOSE)[keyof typeof RESOURCE_LINK_PURPOSE]

export const RESOURCE_LINK_PURPOSE_LABELS: Record<ResourceLinkPurpose, string> = {
  [RESOURCE_LINK_PURPOSE.SOURCE_POST]: '原帖',
  [RESOURCE_LINK_PURPOSE.REPOSITORY]: '仓库',
  [RESOURCE_LINK_PURPOSE.RELEASE]: 'Release',
  [RESOURCE_LINK_PURPOSE.RAW_FILE]: 'Raw 文件',
  [RESOURCE_LINK_PURPOSE.DOWNLOAD]: '下载',
  [RESOURCE_LINK_PURPOSE.DOCS]: '文档',
  [RESOURCE_LINK_PURPOSE.INSTALL_GUIDE]: '安装说明',
  [RESOURCE_LINK_PURPOSE.AUTHOR]: '作者',
  [RESOURCE_LINK_PURPOSE.MIRROR]: '镜像',
}

export const RESOURCE_INSTALL_TARGET = {
  NONE: 'none',
  SILLYTAVERN_EXTENSION: 'sillyTavernExtension',
  TAVERN_HELPER_SCRIPT: 'tavernHelperScript',
  STSCRIPT: 'stscript',
  REGEX: 'regex',
  THEME: 'theme',
} as const

export type ResourceInstallTarget =
  (typeof RESOURCE_INSTALL_TARGET)[keyof typeof RESOURCE_INSTALL_TARGET]

export const RESOURCE_INSTALL_TARGET_LABELS: Record<ResourceInstallTarget, string> = {
  [RESOURCE_INSTALL_TARGET.NONE]: '不安装',
  [RESOURCE_INSTALL_TARGET.SILLYTAVERN_EXTENSION]: 'SillyTavern 扩展',
  [RESOURCE_INSTALL_TARGET.TAVERN_HELPER_SCRIPT]: '酒馆助手脚本',
  [RESOURCE_INSTALL_TARGET.STSCRIPT]: 'STscript',
  [RESOURCE_INSTALL_TARGET.REGEX]: '正则',
  [RESOURCE_INSTALL_TARGET.THEME]: '主题',
}

export const RESOURCE_LINK_TRUST_MODE = {
  LINK_ONLY: 'linkOnly',
  METADATA_SNAPSHOT: 'metadataSnapshot',
  LOCAL_SNAPSHOT: 'localSnapshot',
} as const

export type ResourceLinkTrustMode =
  (typeof RESOURCE_LINK_TRUST_MODE)[keyof typeof RESOURCE_LINK_TRUST_MODE]

export const RESOURCE_LINK_TRUST_MODE_LABELS: Record<ResourceLinkTrustMode, string> = {
  [RESOURCE_LINK_TRUST_MODE.LINK_ONLY]: '仅链接',
  [RESOURCE_LINK_TRUST_MODE.METADATA_SNAPSHOT]: '元数据快照',
  [RESOURCE_LINK_TRUST_MODE.LOCAL_SNAPSHOT]: '本地快照',
}

export interface ResourceLinkVersionRef {
  kind: 'branch' | 'tag' | 'commit' | 'release'
  value: string
}

export interface ResourceLinkGitHubMeta {
  owner: string
  repo: string
  path?: string
  releaseTag?: string
  assetName?: string
}

export interface ResourceLink {
  id: string
  label: string
  url: string
  type: ResourceLinkType
  note?: string
  createdAt: number
  purpose?: ResourceLinkPurpose
  installTarget?: ResourceInstallTarget
  trustMode?: ResourceLinkTrustMode
  versionRef?: ResourceLinkVersionRef
  github?: ResourceLinkGitHubMeta
}

export const RESOURCE_TYPE_LABELS: Record<ResourceType, string> = {
  [RESOURCE_TYPE.CHARACTER_CARD]: '角色卡',
  [RESOURCE_TYPE.GREETING]: '开场白',
  [RESOURCE_TYPE.CHAT]: '聊天记录',
  [RESOURCE_TYPE.USER_PERSONA]: '用户人设',
  [RESOURCE_TYPE.WORLD_BOOK]: '世界书',
  [RESOURCE_TYPE.BEAUTIFICATION]: '主题美化',
  [RESOURCE_TYPE.REGEX]: '正则',
  [RESOURCE_TYPE.PRESET]: '预设',
  [RESOURCE_TYPE.QUICK_REPLY]: '快速回复',
  [RESOURCE_TYPE.SCRIPT]: '脚本',
  [RESOURCE_TYPE.PLUGIN]: '插件清单',
  [RESOURCE_TYPE.EXTRA_STORY]: '番外',
  [RESOURCE_TYPE.POCKET_PHONE]: '小手机',
  [RESOURCE_TYPE.SECRET]: '密钥',
  [RESOURCE_TYPE.OTHER]: '其他',
}

export interface Resource {
  id: string
  type: ResourceType
  name: string
  description: string
  fileName: string
  mimeType: string
  fileSize: number
  contentHash: string
  backupDescriptor?: ResourceBackupDescriptor
  favorite: boolean
  categoryId: string | null
  categoryIds?: string[]
  relatedResourceIds?: string[]
  sourceLinks?: ResourceLink[]
  tags: string[]
  metadata: Record<string, unknown>
  versionGroupId?: string
  versionImportedAt?: number
  versionLabel?: string
  versionNote?: string
  versionCount?: number
  thumbnailAssetId?: string
  thumbnailBlob?: Blob
  originalBlob: Blob
  createdAt: number
  updatedAt: number
}

export interface ResourceBackupDescriptor {
  version: 1 | 2
  resourceId: string
  contentHash: string
  size: number
  updatedAt: number
  parts?: Array<{
    name: string
    offset: number
    size: number
    sha256: string
    storedSize?: number
    storage?: {
      kind: 'github-release' | 'koofr-path'
      container: string
      objectKey: string
    }
  }>
}

export type ResourceSummary = Omit<Resource, 'originalBlob'>
export type ResourceListSummary = ResourceSummary
export type ResourceReference = Resource | ResourceSummary

/** Legacy parser hints describe the import, not the chat's current binding. */
export function getResourceDescription(
  resource: Pick<ResourceReference, 'type' | 'description'>,
): string {
  return resource.type === RESOURCE_TYPE.CHAT
    ? resource.description.replace(/^(\d+) 楼 · 请在读了么中绑定角色卡$/, '$1 楼 · 在读了么中阅读')
    : resource.description
}

export const USER_PERSONA_AVATAR_ASSET_KIND = 'userPersonaAvatar'

export function isUserPersonaAvatarAttachment(
  resource: Pick<ResourceReference, 'metadata'>,
): boolean {
  return resource.metadata.assetKind === USER_PERSONA_AVATAR_ASSET_KIND
}

function toResourceListMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(metadata)) {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null
    ) {
      output[key] = typeof value === 'string' ? value.slice(0, 2_000) : value
      continue
    }
    if (
      Array.isArray(value) &&
      value.every((item) => ['string', 'number', 'boolean'].includes(typeof item))
    ) {
      output[key] = key === 'stitchedFrom' ? [] : value.slice(0, 64)
    }
  }
  const companion = metadata.chatCharacter
  if (companion && typeof companion === 'object' && !Array.isArray(companion)) {
    const value = companion as Record<string, unknown>
    if (typeof value.hash === 'string' && typeof value.name === 'string')
      output.chatCharacter = { hash: value.hash, name: value.name.slice(0, 160) }
  }
  const preview = metadata.beautificationPreview
  if (preview && typeof preview === 'object' && !Array.isArray(preview)) {
    const colors = (preview as Record<string, unknown>).colors
    if (Array.isArray(colors)) {
      output.beautificationPreview = {
        colors: colors.filter((color): color is string => typeof color === 'string').slice(0, 8),
      }
    }
  }
  return output
}

export function toResourceListSummary(resource: ResourceReference): ResourceListSummary {
  const summary: Partial<Resource> = {
    ...resource,
    tags: resource.tags ?? [],
    metadata: toResourceListMetadata(resource.metadata),
  }
  delete summary.originalBlob
  delete summary.thumbnailBlob
  return summary as ResourceSummary
}

export function toResourceSummary(resource: Resource): ResourceSummary {
  const summary: Partial<Resource> = { ...resource, tags: resource.tags ?? [] }
  delete summary.originalBlob
  delete summary.thumbnailBlob
  return summary as ResourceSummary
}

export function getResourceCategoryIds(resource: ResourceReference): string[] {
  return Array.from(
    new Set(
      [...(Array.isArray(resource.categoryIds) ? resource.categoryIds : []), resource.categoryId]
        .filter((id): id is string => typeof id === 'string')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  )
}

export function getRelatedResourceIds(resource: ResourceReference): string[] {
  return Array.from(
    new Set(
      (Array.isArray(resource.relatedResourceIds) ? resource.relatedResourceIds : [])
        .filter((id): id is string => typeof id === 'string')
        .filter((id) => id && id !== resource.id),
    ),
  )
}

/** Chat preview dependencies stay available when exporting/restoring only the chat category. */
export function includeChatCompanionIds<
  T extends Pick<ResourceReference, 'id' | 'type' | 'metadata' | 'relatedResourceIds'>,
>(resources: readonly T[], selectedIds: Set<string>): void {
  const byId = new Map(resources.map((resource) => [resource.id, resource]))
  for (const chat of resources) {
    if (chat.type !== RESOURCE_TYPE.CHAT || !selectedIds.has(chat.id)) continue
    for (const id of chat.relatedResourceIds ?? []) {
      if (byId.get(id)?.type === RESOURCE_TYPE.CHARACTER_CARD) selectedIds.add(id)
    }
    const regexId = chat.metadata.chatDisplayRegexId
    if (typeof regexId === 'string' && byId.get(regexId)?.type === RESOURCE_TYPE.REGEX)
      selectedIds.add(regexId)
    const scriptId = chat.metadata.chatReadingScriptId
    if (typeof scriptId === 'string' && byId.get(scriptId)?.type === RESOURCE_TYPE.SCRIPT)
      selectedIds.add(scriptId)
  }
}

function createStableResourceLinkId(url: string, label: string, index: number): string {
  let hash = 0
  const source = `${url}|${label}|${index}`
  for (let i = 0; i < source.length; i += 1) {
    hash = (hash * 31 + source.charCodeAt(i)) >>> 0
  }
  return `resource-link-${hash.toString(36)}`
}

export function normalizeResourceLinkUrl(value: string): string {
  let raw = value.trim()
  if (!raw) return ''
  if (!/^[a-z][a-z\d+.-]*:/i.test(raw) && /^[\w.-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(raw)) {
    raw = `https://${raw}`
  }

  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return url.toString()
  } catch {
    return ''
  }
}

export function inferResourceLinkType(url: string): ResourceLinkType {
  const normalizedUrl = normalizeResourceLinkUrl(url)
  if (!normalizedUrl) return RESOURCE_LINK_TYPE.OTHER
  const hostname = new URL(normalizedUrl).hostname.toLocaleLowerCase().replace(/^www\./, '')
  if (
    hostname === 'discord.com' ||
    hostname === 'discord.gg' ||
    hostname === 'canary.discord.com' ||
    hostname === 'ptb.discord.com'
  ) {
    return RESOURCE_LINK_TYPE.DISCORD
  }
  if (
    hostname === 'github.com' ||
    hostname.endsWith('.github.com') ||
    hostname === 'raw.githubusercontent.com'
  )
    return RESOURCE_LINK_TYPE.GITHUB
  if (hostname === 'patreon.com') return RESOURCE_LINK_TYPE.PATREON
  if (hostname === 'ko-fi.com' || hostname === 'kofi.com') return RESOURCE_LINK_TYPE.KOFI
  return RESOURCE_LINK_TYPE.WEBSITE
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.includes(value as T)
}

function readPathParts(url: URL): string[] {
  return url.pathname
    .split('/')
    .map((part) => decodeURIComponent(part).trim())
    .filter(Boolean)
}

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/i, '')
}

function inferVersionKind(value: string): ResourceLinkVersionRef['kind'] {
  if (/^[a-f0-9]{7,40}$/i.test(value)) return 'commit'
  if (/^v?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/i.test(value)) return 'tag'
  return 'branch'
}

export function parseGitHubResourceLink(url: string): ResourceLinkGitHubMeta | undefined {
  const normalizedUrl = normalizeResourceLinkUrl(url)
  if (!normalizedUrl) return undefined
  const parsed = new URL(normalizedUrl)
  const hostname = parsed.hostname.toLocaleLowerCase().replace(/^www\./, '')
  const parts = readPathParts(parsed)

  if (hostname === 'raw.githubusercontent.com') {
    const [owner, repo, ref, ...path] = parts
    if (!owner || !repo) return undefined
    return {
      owner,
      repo: stripGitSuffix(repo),
      ...(path.length ? { path: path.join('/') } : {}),
      ...(ref ? { releaseTag: undefined } : {}),
    }
  }

  if (hostname !== 'github.com') return undefined
  const [owner, repo, section, refOrTag, ...rest] = parts
  if (!owner || !repo) return undefined
  const meta: ResourceLinkGitHubMeta = { owner, repo: stripGitSuffix(repo) }

  if (section === 'releases' && refOrTag === 'tag' && rest[0]) {
    meta.releaseTag = rest[0]
  } else if (section === 'releases' && refOrTag === 'download' && rest[0]) {
    meta.releaseTag = rest[0]
    if (rest[1]) meta.assetName = rest.slice(1).join('/')
  } else if ((section === 'blob' || section === 'tree' || section === 'raw') && refOrTag) {
    meta.path = rest.join('/')
  } else if (section === 'commit' && refOrTag) {
    meta.path = ''
  }

  return meta
}

export function inferResourceLinkPurpose(url: string): ResourceLinkPurpose {
  const normalizedUrl = normalizeResourceLinkUrl(url)
  if (!normalizedUrl) return RESOURCE_LINK_PURPOSE.SOURCE_POST
  const parsed = new URL(normalizedUrl)
  const hostname = parsed.hostname.toLocaleLowerCase().replace(/^www\./, '')
  const parts = readPathParts(parsed)
  const extension = parts.at(-1)?.split('.').pop()?.toLocaleLowerCase() ?? ''

  if (inferResourceLinkType(normalizedUrl) === RESOURCE_LINK_TYPE.DISCORD)
    return RESOURCE_LINK_PURPOSE.SOURCE_POST
  if (hostname === 'raw.githubusercontent.com') return RESOURCE_LINK_PURPOSE.RAW_FILE
  if (hostname === 'github.com') {
    const section = parts[2]
    if (section === 'releases') return RESOURCE_LINK_PURPOSE.RELEASE
    if (section === 'blob' || section === 'raw') return RESOURCE_LINK_PURPOSE.RAW_FILE
    if (section === 'wiki' || parts.at(-1)?.toLocaleLowerCase() === 'readme.md')
      return RESOURCE_LINK_PURPOSE.DOCS
    if (parts.length >= 2) return RESOURCE_LINK_PURPOSE.REPOSITORY
  }
  if (['zip', 'json', 'js', 'css', 'txt'].includes(extension))
    return extension === 'zip' ? RESOURCE_LINK_PURPOSE.DOWNLOAD : RESOURCE_LINK_PURPOSE.RAW_FILE
  return RESOURCE_LINK_PURPOSE.SOURCE_POST
}

export function inferResourceInstallTarget(
  url: string,
  purpose = inferResourceLinkPurpose(url),
): ResourceInstallTarget {
  const normalizedUrl = normalizeResourceLinkUrl(url)
  if (!normalizedUrl) return RESOURCE_INSTALL_TARGET.NONE
  const parsed = new URL(normalizedUrl)
  const hostname = parsed.hostname.toLocaleLowerCase().replace(/^www\./, '')
  const parts = readPathParts(parsed)
  const lowerPath = parsed.pathname.toLocaleLowerCase()
  const fileName = parts.at(-1)?.toLocaleLowerCase() ?? ''

  if (inferResourceLinkType(normalizedUrl) === RESOURCE_LINK_TYPE.DISCORD)
    return RESOURCE_INSTALL_TARGET.NONE
  // 仓库 URL 本身不能证明它是 SillyTavern 扩展；只有读取并验证
  // manifest.json 后才能把安装目标提升为扩展。
  if (hostname === 'github.com' && purpose === RESOURCE_LINK_PURPOSE.REPOSITORY)
    return RESOURCE_INSTALL_TARGET.NONE
  if (purpose === RESOURCE_LINK_PURPOSE.RELEASE && fileName.endsWith('.zip'))
    return RESOURCE_INSTALL_TARGET.SILLYTAVERN_EXTENSION
  if (lowerPath.endsWith('.js')) return RESOURCE_INSTALL_TARGET.TAVERN_HELPER_SCRIPT
  if (lowerPath.endsWith('.css')) return RESOURCE_INSTALL_TARGET.THEME
  if (lowerPath.endsWith('.json')) {
    if (/regex|正则/i.test(fileName)) return RESOURCE_INSTALL_TARGET.REGEX
    if (/stscript|slash/i.test(fileName)) return RESOURCE_INSTALL_TARGET.STSCRIPT
    if (/script|helper|runner|助手/i.test(fileName))
      return RESOURCE_INSTALL_TARGET.TAVERN_HELPER_SCRIPT
  }
  return RESOURCE_INSTALL_TARGET.NONE
}

export function inferResourceLinkVersionRef(url: string): ResourceLinkVersionRef | undefined {
  const normalizedUrl = normalizeResourceLinkUrl(url)
  if (!normalizedUrl) return undefined
  const parsed = new URL(normalizedUrl)
  const hostname = parsed.hostname.toLocaleLowerCase().replace(/^www\./, '')
  const parts = readPathParts(parsed)

  if (hostname === 'raw.githubusercontent.com') {
    const ref = parts[2]
    return ref ? { kind: inferVersionKind(ref), value: ref } : undefined
  }

  if (hostname !== 'github.com') return undefined
  const section = parts[2]
  const value = parts[3]
  if ((section === 'blob' || section === 'tree' || section === 'raw') && value) {
    return { kind: inferVersionKind(value), value }
  }
  if (section === 'commit' && value) return { kind: 'commit', value }
  if (section === 'releases' && parts[3] === 'tag' && parts[4]) {
    return { kind: 'release', value: parts[4] }
  }
  if (section === 'releases' && parts[3] === 'download' && parts[4]) {
    return { kind: 'release', value: parts[4] }
  }
  return undefined
}

export function analyzeResourceLink(url: string): Partial<ResourceLink> {
  const normalizedUrl = normalizeResourceLinkUrl(url)
  if (!normalizedUrl) return {}
  const type = inferResourceLinkType(normalizedUrl)
  const purpose = inferResourceLinkPurpose(normalizedUrl)
  const installTarget = inferResourceInstallTarget(normalizedUrl, purpose)
  const github = parseGitHubResourceLink(normalizedUrl)
  const versionRef = inferResourceLinkVersionRef(normalizedUrl)
  return {
    url: normalizedUrl,
    type,
    purpose,
    installTarget,
    trustMode: RESOURCE_LINK_TRUST_MODE.LINK_ONLY,
    ...(github ? { github } : {}),
    ...(versionRef ? { versionRef } : {}),
  }
}

export function getResourceLinkRiskBadges(link: ResourceLink): string[] {
  const badges = new Set<string>()
  const target = link.installTarget ?? RESOURCE_INSTALL_TARGET.NONE
  const purpose = link.purpose ?? inferResourceLinkPurpose(link.url)
  const versionRef = link.versionRef ?? inferResourceLinkVersionRef(link.url)

  badges.add(RESOURCE_LINK_TRUST_MODE_LABELS[link.trustMode ?? RESOURCE_LINK_TRUST_MODE.LINK_ONLY])
  if (target !== RESOURCE_INSTALL_TARGET.NONE) badges.add(RESOURCE_INSTALL_TARGET_LABELS[target])
  if (
    target === RESOURCE_INSTALL_TARGET.SILLYTAVERN_EXTENSION ||
    target === RESOURCE_INSTALL_TARGET.TAVERN_HELPER_SCRIPT ||
    target === RESOURCE_INSTALL_TARGET.STSCRIPT
  ) {
    badges.add('可执行内容')
    badges.add('需手动确认')
  }
  if (purpose === RESOURCE_LINK_PURPOSE.RELEASE || versionRef?.kind === 'tag')
    badges.add('固定版本')
  if (versionRef?.kind === 'commit') badges.add('固定提交')
  if (versionRef?.kind === 'branch') badges.add('移动分支')
  if (!versionRef && link.type === RESOURCE_LINK_TYPE.GITHUB) badges.add('未固定版本')
  return Array.from(badges)
}

export function normalizeResourceLinks(value: unknown): ResourceLink[] {
  if (!Array.isArray(value)) return []
  const types = new Set<ResourceLinkType>(Object.values(RESOURCE_LINK_TYPE))
  const purposes = Object.values(RESOURCE_LINK_PURPOSE)
  const installTargets = Object.values(RESOURCE_INSTALL_TARGET)
  const trustModes = Object.values(RESOURCE_LINK_TRUST_MODE)
  const seenUrls = new Set<string>()
  return value.flatMap((item, index): ResourceLink[] => {
    if (!isRecord(item)) return []
    const url = normalizeResourceLinkUrl(typeof item.url === 'string' ? item.url : '')
    if (!url) return []
    const dedupeKey = url.toLocaleLowerCase()
    if (seenUrls.has(dedupeKey)) return []
    seenUrls.add(dedupeKey)

    const label = (typeof item.label === 'string' ? item.label.trim() : '').slice(0, 80)
    const note = (typeof item.note === 'string' ? item.note.trim() : '').slice(0, 240)
    const type = types.has(item.type as ResourceLinkType)
      ? (item.type as ResourceLinkType)
      : inferResourceLinkType(url)
    const analysis = analyzeResourceLink(url)
    const purpose = isOneOf(purposes, item.purpose) ? item.purpose : analysis.purpose
    const installTarget = isOneOf(installTargets, item.installTarget)
      ? item.installTarget
      : analysis.installTarget
    const trustMode = isOneOf(trustModes, item.trustMode)
      ? item.trustMode
      : RESOURCE_LINK_TRUST_MODE.LINK_ONLY
    const versionRef = isRecord(item.versionRef)
      ? {
          kind: isOneOf(['branch', 'tag', 'commit', 'release'] as const, item.versionRef.kind)
            ? item.versionRef.kind
            : undefined,
          value:
            typeof item.versionRef.value === 'string'
              ? item.versionRef.value.trim().slice(0, 160)
              : '',
        }
      : analysis.versionRef
    const normalizedVersionRef =
      versionRef?.kind && versionRef.value ? (versionRef as ResourceLinkVersionRef) : undefined
    const github = isRecord(item.github)
      ? {
          owner: typeof item.github.owner === 'string' ? item.github.owner.trim().slice(0, 80) : '',
          repo: typeof item.github.repo === 'string' ? item.github.repo.trim().slice(0, 120) : '',
          path:
            typeof item.github.path === 'string'
              ? item.github.path.trim().slice(0, 500)
              : undefined,
          releaseTag:
            typeof item.github.releaseTag === 'string'
              ? item.github.releaseTag.trim().slice(0, 160)
              : undefined,
          assetName:
            typeof item.github.assetName === 'string'
              ? item.github.assetName.trim().slice(0, 240)
              : undefined,
        }
      : analysis.github
    const normalizedGitHub = github?.owner && github.repo ? github : undefined
    const createdAt =
      typeof item.createdAt === 'number' && Number.isFinite(item.createdAt) ? item.createdAt : 0
    return [
      {
        id:
          typeof item.id === 'string' && item.id.trim()
            ? item.id.trim().slice(0, 80)
            : createStableResourceLinkId(url, label, index),
        label,
        url,
        type,
        ...(note ? { note } : {}),
        ...(purpose ? { purpose } : {}),
        ...(installTarget ? { installTarget } : {}),
        trustMode,
        ...(normalizedVersionRef ? { versionRef: normalizedVersionRef } : {}),
        ...(normalizedGitHub ? { github: normalizedGitHub } : {}),
        createdAt,
      },
    ]
  })
}

export function getChatDisplayRegexIds(resources: readonly ResourceReference[]): Set<string> {
  return new Set(
    resources.flatMap((resource) =>
      resource.type === RESOURCE_TYPE.CHAT &&
      typeof resource.metadata.chatDisplayRegexId === 'string'
        ? [resource.metadata.chatDisplayRegexId]
        : [],
    ),
  )
}

export function isExtractedCharacterAsset(resource: ResourceReference): boolean {
  return (
    (typeof resource.metadata.extractedFromCharacterId === 'string' ||
      typeof resource.metadata.extractedFromPresetId === 'string' ||
      typeof resource.metadata.extractedFromResourceId === 'string') &&
    (resource.metadata.extractedAssetKind === 'worldBook' ||
      resource.metadata.extractedAssetKind === 'regex')
  )
}

export function normalizeResource(resource: Resource): Resource {
  const categoryIds = getResourceCategoryIds(resource)
  const existingDescriptor = resource.backupDescriptor
  const backupDescriptor: ResourceBackupDescriptor =
    (existingDescriptor?.version === 1 || existingDescriptor?.version === 2) &&
    existingDescriptor.resourceId === resource.id &&
    existingDescriptor.contentHash === resource.contentHash.toLowerCase() &&
    existingDescriptor.size === resource.fileSize
      ? existingDescriptor
      : {
          version: 1,
          resourceId: resource.id,
          contentHash: resource.contentHash.toLowerCase(),
          size: resource.fileSize,
          updatedAt: resource.updatedAt,
        }
  return {
    ...resource,
    tags: resource.tags ?? [],
    categoryId: categoryIds[0] ?? null,
    categoryIds,
    relatedResourceIds: getRelatedResourceIds(resource),
    sourceLinks: normalizeResourceLinks(resource.sourceLinks),
    versionCount: Math.max(1, Math.round(resource.versionCount ?? 1)),
    backupDescriptor,
  }
}

export interface Category {
  id: string
  name: string
  color: string
  /** Stable manual position in the visual cabinet; legacy folders fall back to creation order. */
  sortOrder?: number
  /** Optional compact raster data URL used only by the visual folder view. */
  coverImage?: string
  /** Hide this folder and all assigned resources from normal browsing and character draws. */
  hidden?: boolean
  createdAt: number
  updatedAt: number
}

export interface AppSetting {
  id: string
  value: unknown
  updatedAt: number
}

export interface BackupRecord {
  id: string
  adapter: string
  itemKind?: 'persona-version' | 'persona-character' | 'attachment-version'
  objectKey: string
  resourceCount: number
  createdAt: number
  categoryCount?: number
  reason?: string
  size?: number
  blob?: Blob
  encrypted?: boolean
  encryptionIv?: string
}

/** Display metadata; recovering an archive must load the selected BackupRecord by ID. */
export type BackupRecordSummary = Omit<BackupRecord, 'blob'>
