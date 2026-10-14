import * as versionOperations from './ResourceVersionOperations'
import { JSON_RESOURCE_PARSER_VERSION } from '../parser/JsonResourceParser'
import type { ResourceParserRegistry } from '../parser/ResourceParser'
import type {
  ResourceListSummaryFilter,
  ResourceStorageAdapter,
} from '../storage/ResourceStorageAdapter'
import type { ResourceVersionMatchFingerprintCache } from '../storage/ResourceStorageAdapter'
import type { MissingPngThumbnailRepairStatus } from '../storage/ResourceThumbnailMaintenance'
import type { ImportResult, ParsedResource } from '../types/Import'
import type { CharacterCardContentEdit } from '../types/CharacterCardContentEdit'
import {
  getRelatedResourceIds,
  normalizeResource,
  RESOURCE_TYPE,
  isUserPersonaAvatarAttachment,
  toResourceListSummary,
  toResourceSummary,
  type Resource,
  type ResourceBackupDescriptor,
  type ResourceListSummary,
  type ResourceLink,
  type ResourceReference,
  type ResourceSummary,
  type ResourceType,
} from '../types/Resource'
import {
  CHARACTER_CARD_FINGERPRINT_VERSION,
  canonicalizeCharacterCardContent,
  canonicalizeCharacterCardCore,
  computeCardFingerprints,
} from '../utils/CharacterCardFingerprint'
import { hashFile } from './HashService'
import { createStructuredContentDraft } from '../utils/StructuredResourceContent'
import { stableCharacterContentJson } from '../utils/CharacterCardContentEdits'
import { importPipeline, type ImportFileContext } from './ImportPipeline'
import { inspectGitHubResource, type GitHubResourceInspector } from './GitHubResourceInspector'
import {
  createCharacterCardArtworkFile,
  type CharacterCardOverrides,
} from '../utils/CharacterCardCustomization'
import {
  compareVersionCandidates,
  createVersionMatchEntries,
  findVersionCandidates,
  type VersionCandidate,
} from './ResourceVersionMatcher'
import { resourceVersionLabel, findManualTypeOverride } from './ResourceVersionIdentity'
import { normalizeTags } from './ResourceLinkImport'
import { ResourceAssetOperations } from './ResourceAssetOperations'
import { ResourceRecognizedFileHashes } from './ResourceRecognizedFileHashes'
import {
  type ImportOptions,
  type PreparedFileImportOptions,
  type ResourceVersionView,
  type CharacterAssetExtractionReport,
  type ExternalAppResourceUpdate,
  type AiTagMutationEntry,
  type AiTagMutationResult,
} from '../types/ResourceOperations'
import * as operationsResourceOrganizationOperations from './ResourceOrganizationOperations'
import {
  importFilesSerial as importResourceFilesSerial,
  importLinks as importResourceLinks,
  type ResourceImportOperationsContext,
  type VersionMatchIndexCache,
} from './ResourceImportOperations'

export {
  type ImportOptions,
  type PreparedFileImportOptions,
  type ResourceVersionView,
  type CharacterAssetExtractionReport,
  type ExternalAppResourceUpdate,
  type AiTagMutationEntry,
  type AiTagMutationResult,
} from '../types/ResourceOperations'

export { resourceLogicalVersionKey, countResourceLogicalVersions } from './ResourceVersionIdentity'

export interface ParsedCharacterTagCandidate {
  resource: ResourceSummary
  tags: string[]
}

export interface ParsedCharacterTagRemoval {
  resourceId: string
  tags: string[]
}

export interface ParsedTagProgress {
  completed: number
  total: number
  resourceName: string
  failed: number
}

async function createContentHash(file: File): Promise<string> {
  return hashFile(file)
}

export class ResourceService {
  private readonly storage: ResourceStorageAdapter
  private readonly parserRegistry: ResourceParserRegistry
  private readonly linkInspector: GitHubResourceInspector
  private readonly recognizedFileHashes: ResourceRecognizedFileHashes
  private readonly assetOperations: ResourceAssetOperations
  private fileImportQueue: Promise<void> = Promise.resolve()
  // Only names and hashes from the current scan; never retain original files here.
  private readonly parsedTagCache = new Map<string, { hash: string; tags: string[] }>()
  private versionMatchIndexCache?: VersionMatchIndexCache
  private versionMatchFingerprintCache: ResourceVersionMatchFingerprintCache = {
    schemaVersion: 1,
    resources: {},
    versions: {},
  }
  private persistedVersionMatchCacheLoaded = false
  private versionMatchFingerprintCacheDirty = false

  constructor(
    storage: ResourceStorageAdapter,
    parserRegistry: ResourceParserRegistry,
    linkInspector: GitHubResourceInspector = inspectGitHubResource,
  ) {
    this.storage = storage
    this.recognizedFileHashes = new ResourceRecognizedFileHashes(storage)
    this.assetOperations = new ResourceAssetOperations(storage, parserRegistry)
    this.parserRegistry = parserRegistry
    this.linkInspector = linkInspector
  }

  private importOperationsContext(): ResourceImportOperationsContext {
    return {
      resourceService: this,
      get persistedVersionMatchCacheLoaded() {
        return this.resourceService.persistedVersionMatchCacheLoaded
      },
      set persistedVersionMatchCacheLoaded(value) {
        this.resourceService.persistedVersionMatchCacheLoaded = value
      },
      storage: this.storage,
      get versionMatchFingerprintCache() {
        return this.resourceService.versionMatchFingerprintCache
      },
      set versionMatchFingerprintCache(value) {
        this.resourceService.versionMatchFingerprintCache = value
      },
      get versionMatchFingerprintCacheDirty() {
        return this.resourceService.versionMatchFingerprintCacheDirty
      },
      set versionMatchFingerprintCacheDirty(value) {
        this.resourceService.versionMatchFingerprintCacheDirty = value
      },
      get versionMatchIndexCache() {
        return this.resourceService.versionMatchIndexCache
      },
      set versionMatchIndexCache(value) {
        this.resourceService.versionMatchIndexCache = value
      },
      linkInspector: this.linkInspector,
      parserRegistry: this.parserRegistry,
      upgradeJsonResource: (resource) => this.upgradeJsonResource(resource),
      extractEmbeddedAssets: (resource) => this.extractEmbeddedAssets(resource),
      ensureParsedFingerprints: (parsed) => this.ensureParsedFingerprints(parsed),
      refineCardVersionCandidates: (parsed, fileName, candidates) =>
        this.refineCardVersionCandidates(parsed, fileName, candidates),
      createImportedResource: (...args) => this.createImportedResource(...args),
    }
  }

  findByContentHash(hash: string): Promise<Resource | undefined> {
    return this.storage.findByHash(hash)
  }

  findCharacterCardByContentHash(hash: string) {
    return this.recognizedFileHashes.findCharacterCardByContentHash(hash)
  }

  rememberRecognizedFileHash(
    file: File,
    matchedResource: ResourceSummary,
    historical: boolean,
  ): Promise<string> {
    return this.recognizedFileHashes.remember(file, matchedResource, historical)
  }
  list(): Promise<Resource[]> {
    return this.storage.list()
  }

  listSummaries(): Promise<ResourceSummary[]> {
    return this.storage.listSummaries()
  }

  async listResourceListSummaries(
    filter?: ResourceListSummaryFilter,
  ): Promise<ResourceListSummary[]> {
    const summaries = this.storage.listResourceListSummaries
      ? await this.storage.listResourceListSummaries(filter)
      : (await this.storage.listSummaries()).map(toResourceListSummary)
    if (!filter?.ids && !filter?.types) return summaries
    const ids = filter?.ids ? new Set(filter.ids) : undefined
    const types = filter?.types ? new Set(filter.types) : undefined
    return summaries.filter(
      (resource) => (!ids || ids.has(resource.id)) && (!types || types.has(resource.type)),
    )
  }

  async getResourceListSummary(id: string): Promise<ResourceListSummary | undefined> {
    if (this.storage.getResourceListSummary) return this.storage.getResourceListSummary(id)
    const summary = await (this.storage.getSummary?.(id) ?? this.storage.get(id))
    return summary ? toResourceListSummary(summary) : undefined
  }

  listRecentCharacterCards(limit = 100): Promise<ResourceListSummary[]> {
    if (this.storage.listRecentCharacterCardSummaries)
      return this.storage.listRecentCharacterCardSummaries(limit)
    return this.listResourceListSummaries().then((resources) =>
      resources
        .filter((resource) => resource.type === RESOURCE_TYPE.CHARACTER_CARD)
        .slice(0, limit),
    )
  }

  getThumbnail(id: string): Promise<Blob | undefined> {
    return this.storage.getThumbnail
      ? this.storage.getThumbnail(id)
      : this.storage.get(id).then((resource) => resource?.thumbnailBlob)
  }

  repairThumbnailAssets(): Promise<number> {
    return this.storage.repairThumbnailAssets?.() ?? Promise.resolve(0)
  }

  getMissingPngThumbnailRepairStatus(): Promise<MissingPngThumbnailRepairStatus> {
    return (
      this.storage.getMissingPngThumbnailRepairStatus?.() ??
      Promise.resolve({ status: 'not-started', repaired: 0 })
    )
  }

  repairMissingPngCharacterCardThumbnails(options?: { restart?: boolean }): Promise<number> {
    return this.storage.repairMissingPngCharacterCardThumbnails?.(options) ?? Promise.resolve(0)
  }

  listAllVersions(): Promise<Resource[]> {
    return this.storage.listAllVersions()
  }

  listVersionSummaries(light = false): Promise<ResourceSummary[]> {
    return light && this.storage.listVersionListSummaries
      ? this.storage.listVersionListSummaries()
      : this.storage.listVersionSummaries()
  }

  async listVersionSummariesForResources(ids: string[]): Promise<ResourceSummary[]> {
    return this.storage.listVersionListSummariesForResources
      ? this.storage.listVersionListSummariesForResources(ids)
      : (await this.listVersionSummaries(true)).filter((version) =>
          ids.includes(version.versionGroupId ?? ''),
        )
  }

  get(id: string): Promise<Resource | undefined> {
    return this.storage.get(id)
  }

  async getSummary(id: string, historical = false): Promise<ResourceSummary | undefined> {
    if (this.storage.getSummary) return this.storage.getSummary(id, historical)
    const resource = historical ? await this.getVersion(id) : await this.get(id)
    return resource ? toResourceSummary(resource) : undefined
  }

  async getReadSource(id: string) {
    if (this.storage.getReadSource) return this.storage.getReadSource(id)
    const resource = await this.get(id)
    return resource
      ? { ...toResourceSummary(resource), originalSource: resource.originalBlob }
      : undefined
  }

  async getVersion(id: string): Promise<Resource | undefined> {
    if (this.storage.getVersion) return this.storage.getVersion(id)
    return (await this.storage.listAllVersions()).find((version) => version.id === id)
  }

  updateBackupDescriptor(
    id: string,
    descriptor: ResourceBackupDescriptor,
    historical = false,
  ): Promise<void> {
    return historical
      ? this.storage.updateVersion(id, { backupDescriptor: descriptor })
      : this.storage.update(id, { backupDescriptor: descriptor })
  }

  async importPreparedFile(
    file: File,
    parsed: ParsedResource,
    options: PreparedFileImportOptions = {},
  ): Promise<ImportResult> {
    try {
      const context = importPipeline.intake<ParsedResource>(file)
      const contentHash = await context.hash()
      if (!options.allowContentDuplicate) {
        const duplicate =
          (await this.storage.findByHash(contentHash)) ??
          (await this.storage.findVersionByHash(contentHash))
        if (duplicate) {
          return {
            status: 'duplicate',
            fileName: file.name,
            message: '相同文件已经存在于资源库中',
            resource: duplicate,
            reclassified: false,
          }
        }
      }
      const resource = await this.createImportedResource(file, parsed, contentHash, context)
      await this.storage.save(resource)
      context.mark('commit')
      return { status: 'imported', fileName: file.name, resource }
    } catch (error) {
      return {
        status: 'failed',
        fileName: file.name,
        message: error instanceof Error ? error.message : '资源保存失败',
      }
    }
  }

  /** Parse an incoming file into an in-memory Resource for preview-only comparisons. */
  async previewImportFile(file: File): Promise<Resource> {
    const context = importPipeline.intake<ParsedResource>(file)
    return this.createImportedResource(file, undefined, undefined, context, {
      createThumbnail: false,
    })
  }

  async findVersionCandidateForGroup(
    file: File,
    resourceId: string,
    options: { sameNameVersionCandidates?: boolean } = {},
  ): Promise<VersionCandidate | undefined> {
    const current = await this.storage.get(resourceId)
    if (!current) return undefined

    const parsed = await this.previewImportFile(file)
    const fingerprintSummary = async (resource: ResourceSummary): Promise<ResourceSummary> => {
      if (
        resource.type !== RESOURCE_TYPE.CHARACTER_CARD ||
        (resource.metadata.cardFingerprintVersion === CHARACTER_CARD_FINGERPRINT_VERSION &&
          typeof resource.metadata.cardContentHash === 'string' &&
          typeof resource.metadata.cardCoreHash === 'string')
      )
        return resource
      const fingerprints = await computeCardFingerprints(resource.metadata)
      if (!fingerprints) return resource
      return {
        ...resource,
        metadata: {
          ...resource.metadata,
          cardContentHash: fingerprints.full,
          cardCoreHash: fingerprints.core,
          cardFingerprintVersion: CHARACTER_CARD_FINGERPRINT_VERSION,
        },
      }
    }
    const summaries = await Promise.all([
      fingerprintSummary(toResourceSummary(current)),
      ...(await this.storage.listVersionSummaries())
        .filter((version) => version.versionGroupId === resourceId)
        .map(fingerprintSummary),
    ])
    const candidates = findVersionCandidates(
      parsed,
      file.name,
      createVersionMatchEntries([summaries[0]!], summaries.slice(1)),
      options,
    )
    await this.refineCardVersionCandidates(parsed, file.name, candidates)
    return candidates.find((candidate) => candidate.resource.id === resourceId)
  }

  /** 角色卡写入与封装无关的内容指纹，供版本匹配与「同卡不同封装」查重使用。 */
  private async ensureParsedFingerprints(parsed: ParsedResource): Promise<void> {
    if (parsed.type !== RESOURCE_TYPE.CHARACTER_CARD) return
    if (
      typeof parsed.metadata.cardContentHash === 'string' &&
      parsed.metadata.cardFingerprintVersion === CHARACTER_CARD_FINGERPRINT_VERSION
    )
      return
    const fingerprints = await computeCardFingerprints(parsed.metadata)
    if (fingerprints) {
      parsed.metadata.cardContentHash = fingerprints.full
      parsed.metadata.cardCoreHash = fingerprints.core
      parsed.metadata.cardFingerprintVersion = CHARACTER_CARD_FINGERPRINT_VERSION
    }
  }

  async clearVersionMatchFingerprintCache(): Promise<void> {
    this.versionMatchFingerprintCache = { schemaVersion: 1, resources: {}, versions: {} }
    this.versionMatchFingerprintCacheDirty = false
    this.versionMatchIndexCache = undefined
    this.persistedVersionMatchCacheLoaded = true
    await this.storage.clearVersionMatchFingerprintCache?.()
  }

  private async refineCardVersionCandidates(
    parsed: ParsedResource,
    fileName: string,
    candidates: VersionCandidate[],
  ): Promise<void> {
    if (parsed.type !== RESOURCE_TYPE.CHARACTER_CARD || !candidates.length) return
    const incomingContent = canonicalizeCharacterCardContent(parsed.metadata)
    const incomingCore = canonicalizeCharacterCardCore(parsed.metadata)
    if (incomingContent === undefined) return

    const containerFormat = (name: string, mimeType = ''): 'json' | 'png' | undefined => {
      if (/\.json$/iu.test(name) || /json/iu.test(mimeType)) return 'json'
      if (/\.png$/iu.test(name) || /png/iu.test(mimeType)) return 'png'
      return undefined
    }
    const incomingFormat = containerFormat(fileName)
    for (const candidate of candidates) {
      const stored = candidate.matchedHistorical
        ? await this.storage.getVersion?.(candidate.matchedResource.id)
        : await this.storage.get(candidate.matchedResource.id)
      if (!stored) continue
      const existingContent = canonicalizeCharacterCardContent(stored.metadata)
      if (existingContent === undefined) continue
      candidate.matchedResource = toResourceSummary(stored)

      if (incomingContent === existingContent) {
        const existingFormat = containerFormat(stored.fileName, stored.mimeType)
        candidate.matchKind =
          incomingFormat && existingFormat && incomingFormat !== existingFormat
            ? 'containerVariant'
            : 'contentDuplicate'
        candidate.score = 100
        candidate.reasons = [
          candidate.matchKind === 'contentDuplicate'
            ? candidate.matchedHistorical
              ? '与历史版本的卡内数据完全一致'
              : '卡内数据完全一致'
            : candidate.matchedHistorical
              ? '与历史版本卡数据一致，仅立绘或文件封装可能不同'
              : '卡数据一致，仅立绘或文件封装可能不同',
        ]
      } else if (
        incomingCore !== undefined &&
        canonicalizeCharacterCardCore(stored.metadata) === incomingCore
      ) {
        candidate.matchKind = 'version'
        candidate.score = 90
        candidate.reasons = [
          candidate.matchedHistorical
            ? '与历史版本核心设定一致，其他卡内字段不同'
            : '核心设定一致，其他卡内字段不同',
        ]
      } else if (
        candidate.score === 100 &&
        (candidate.matchKind === 'contentDuplicate' || candidate.matchKind === 'containerVariant')
      ) {
        candidate.matchKind = 'heuristic'
        candidate.score = 60
        candidate.reasons = ['指纹候选的卡内数据不同，请人工确认']
      }
    }

    candidates.sort(compareVersionCandidates)
  }

  private async createImportedResource(
    file: File,
    parsedResource?: ParsedResource,
    knownHash?: string,
    context?: ImportFileContext<ParsedResource>,
    options: { createThumbnail?: boolean } = {},
  ): Promise<Resource> {
    const importContext = context ?? importPipeline.intake<ParsedResource>(file)
    const parsed =
      parsedResource ?? (await importContext.parse((source) => this.parserRegistry.parse(source)))
    await this.ensureParsedFingerprints(parsed)
    const now = Date.now()
    const isAvatarAttachment = isUserPersonaAvatarAttachment(parsed)
    const thumbnailBlob =
      options.createThumbnail === false
        ? parsed.thumbnailBlob
        : (parsed.type === RESOURCE_TYPE.CHARACTER_CARD || isAvatarAttachment) &&
            (file.type === 'image/png' || /\.png$/i.test(file.name))
          ? ((await importContext.remember('thumbnail:preview', async () =>
              (await import('../utils/createImageThumbnail')).createImageThumbnail(file),
            )) ?? (isAvatarAttachment ? file : undefined))
          : parsed.thumbnailBlob
    const resource: Resource = {
      id: crypto.randomUUID(),
      ...parsed,
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      fileSize: file.size,
      contentHash: knownHash ?? (await importContext.hash()),
      favorite: false,
      categoryId: null,
      categoryIds: [],
      relatedResourceIds: [],
      tags: parsed.tags ?? [],
      thumbnailBlob,
      originalBlob: file,
      versionImportedAt: now,
      versionCount: 1,
      createdAt: now,
      updatedAt: now,
    }
    resource.versionLabel = resourceVersionLabel(resource)
    return resource
  }

  async listVersions(resourceId: string): Promise<ResourceVersionView[]> {
    return versionOperations.listVersions(this.storage, resourceId)
  }

  async updatePersonalContent(
    file: File,
    parsed: ParsedResource,
    resourceId: string,
  ): Promise<Resource> {
    return versionOperations.updatePersonalContent(this.storage, file, parsed, resourceId)
  }

  async updatePersonalMetadata(current: Resource, parsed: ParsedResource): Promise<Resource> {
    if (current.type !== RESOURCE_TYPE.POCKET_PHONE || parsed.type !== current.type)
      throw new Error('只能更新小手机资料')
    if (!this.storage.updateMetadata) throw new Error('当前存储不支持局部更新')
    const summary = await this.storage.updateMetadata(
      current.id,
      {
        name: parsed.name,
        description: parsed.description,
        metadata: parsed.metadata,
        thumbnailBlob: parsed.thumbnailBlob,
        backupDescriptor: undefined,
        updatedAt: Date.now(),
      },
      JSON.stringify(current.metadata.personalDocument ?? null),
    )
    return { ...summary, originalBlob: current.originalBlob, thumbnailBlob: parsed.thumbnailBlob }
  }

  async importAsVersion(...request: versionOperations.VersionImportRequest): Promise<Resource> {
    const imported = await versionOperations.importAsVersion(
      this.storage,
      (source) => this.createImportedResource(source),
      ...request,
    )
    this.recognizedFileHashes.invalidate()
    return imported
  }

  /** Save native WI/regex JSON through the same resource/version storage owner. */
  async saveStructuredContent(
    resourceId: string,
    expectedHash: string,
    edits: CharacterCardContentEdit[],
    newRegexGroup = 'global',
  ): Promise<Resource> {
    const current = await this.storage.get(resourceId)
    if (!current || current.contentHash !== expectedHash)
      throw new Error('资源版本已变化，请重新打开详情后编辑。')
    const source: unknown = JSON.parse(await current.originalBlob.text())
    const content = createStructuredContentDraft(source, current.type).build(edits, newRegexGroup)
    if (stableCharacterContentJson(content) === stableCharacterContentJson(source)) return current
    const file = new File([JSON.stringify(content, null, 2)], current.fileName, {
      type: 'application/json',
    })
    const prepared = await this.createImportedResource(file)
    if (prepared.type !== current.type)
      throw new Error('编辑后的文件无法识别为原资源类型，请至少保留一个有效条目。')
    if ((await this.storage.get(resourceId))?.contentHash !== expectedHash)
      throw new Error('资源版本已变化，请重新打开详情后编辑。')
    const saved = await versionOperations.importAsVersion(
      this.storage,
      async () => ({
        ...prepared,
        name: current.name,
        description: current.description,
        metadata: { ...current.metadata, ...prepared.metadata },
      }),
      file,
      resourceId,
      true,
      '资源内容编辑',
      undefined,
      {},
      true,
    )
    this.recognizedFileHashes.invalidate()
    return saved
  }

  async replaceHistoricalVersion(
    file: File,
    resourceId: string,
    versionId: string,
    characterContentEdits?: CharacterCardContentEdit[],
  ): Promise<Resource> {
    const replaced = await versionOperations.replaceHistoricalVersion(
      this.storage,
      (source) => this.createImportedResource(source),
      resourceId,
      versionId,
      file,
      characterContentEdits,
    )
    this.recognizedFileHashes.invalidate()
    return replaced
  }

  async replaceCharacterCardArtwork(resourceId: string, artwork: File): Promise<Resource> {
    const current = await this.storage.get(resourceId)
    if (!current) throw new Error('要更换卡面的角色卡已经不存在')
    const file = await createCharacterCardArtworkFile(current, artwork)
    return this.importAsVersion(file, resourceId, true, '用户自定义卡面', 'container', {
      artworkVariantKind: 'custom',
      artworkSourceFileName: artwork.name,
    })
  }

  async activateVersion(resourceId: string, versionId: string): Promise<Resource> {
    const activated = await versionOperations.activateVersion(this.storage, resourceId, versionId)
    this.recognizedFileHashes.invalidate()
    return activated
  }

  async detachVersion(resourceId: string, versionId: string): Promise<Resource> {
    const detached = await versionOperations.detachVersion(this.storage, resourceId, versionId)
    this.recognizedFileHashes.invalidate()
    return detached
  }

  async deleteVersion(resourceId: string, versionId: string): Promise<void> {
    await this.deleteVersions(resourceId, [versionId])
  }

  async deleteVersions(resourceId: string, versionIds: string[]): Promise<number> {
    const deleted = await versionOperations.deleteVersions(this.storage, resourceId, versionIds)
    this.recognizedFileHashes.invalidate()
    return deleted
  }

  async updateVersionNote(resourceId: string, versionId: string, note: string): Promise<void> {
    return versionOperations.updateVersionNote(this.storage, resourceId, versionId, note)
  }

  async mergeExistingResourceAsVersion(
    resourceId: string,
    sourceResourceId: string,
    note = '',
  ): Promise<Resource> {
    return versionOperations.mergeExistingResourceAsVersion(
      this.storage,
      (id) => this.delete(id),
      resourceId,
      sourceResourceId,
      note,
    )
  }

  async mergeDuplicates(keepId: string, removeIds: string[]): Promise<number> {
    return operationsResourceOrganizationOperations.mergeDuplicates(
      this.storage,
      (id) => this.delete(id),
      keepId,
      removeIds,
    )
  }

  /** 把新资源与来源资源建立双向关联；来源已删除的 id 会被静默跳过。 */
  private async linkRelatedResources(resourceId: string, relatedIds: string[]): Promise<string[]> {
    const now = Date.now()
    const targets = (
      await Promise.all(
        Array.from(new Set(relatedIds))
          .filter((id) => id && id !== resourceId)
          .map((id) => this.storage.get(id)),
      )
    ).flatMap((resource) => (resource ? [resource] : []))
    if (targets.length) {
      await this.storage.saveMany(
        targets.map((target) =>
          normalizeResource({
            ...target,
            relatedResourceIds: Array.from(new Set([...getRelatedResourceIds(target), resourceId])),
            updatedAt: now,
          }),
        ),
      )
    }
    return targets.map((target) => target.id)
  }

  /** 把两个或更多已入库资源设为双向关联，供成套但仍保持原生格式的资源使用。 */
  async linkResources(resourceIds: string[]): Promise<void> {
    const ids = Array.from(new Set(resourceIds.filter(Boolean)))
    if (ids.length < 2) return

    const source = await this.storage.get(ids[0]!)
    if (!source) throw new Error('无法关联：主资源不存在或已被删除')

    const linkedIds = await this.linkRelatedResources(source.id, ids.slice(1))
    await this.storage.update(source.id, {
      relatedResourceIds: Array.from(
        new Set([...getRelatedResourceIds(source), ...linkedIds]),
      ).filter((id) => id !== source.id),
      updatedAt: Date.now(),
    })
  }

  /**
   * 「缝了么」产物入库：写入 stitchedFrom 溯源与来源双向关联。
   * asVersionOf 存在时作为该资源的新版本入库（重缝场景），否则新建资源。
   */
  async importStitchedPreset(
    file: File,
    options: {
      stitchedFrom: unknown[]
      baseResourceId?: string
      relatedResourceIds: string[]
      asVersionOf?: string
      versionNote?: string
    },
  ): Promise<Resource> {
    let resource: Resource
    if (options.asVersionOf) {
      resource = await this.importAsVersion(
        file,
        options.asVersionOf,
        true,
        options.versionNote ?? '',
      )
    } else {
      const contentHash = await createContentHash(file)
      const duplicate =
        (await this.storage.findByHash(contentHash)) ??
        (await this.storage.findVersionByHash(contentHash))
      if (duplicate) throw new Error(`缝合结果与「${duplicate.name}」内容完全相同，无需重复入库`)
      resource = await this.createImportedResource(file, undefined, contentHash)
      await this.storage.save(resource)
    }
    const linkedIds = await this.linkRelatedResources(resource.id, options.relatedResourceIds)
    await this.storage.update(resource.id, {
      relatedResourceIds: Array.from(
        new Set([...getRelatedResourceIds(resource), ...linkedIds]),
      ).filter((id) => id !== resource.id),
      metadata: {
        ...resource.metadata,
        stitchedFrom: options.stitchedFrom,
        ...(options.baseResourceId ? { stitchedBaseId: options.baseResourceId } : {}),
      },
      updatedAt: Date.now(),
    })
    return (await this.storage.get(resource.id)) ?? resource
  }

  private async upgradeJsonResource(resource: Resource): Promise<Resource | undefined> {
    const isJson = resource.fileName.toLocaleLowerCase().endsWith('.json')
    if (!isJson || resource.metadata.parserVersion === JSON_RESOURCE_PARSER_VERSION) {
      return undefined
    }

    try {
      const file = new File([resource.originalBlob], resource.fileName, {
        type: resource.mimeType,
      })
      const parsed = await this.parserRegistry.parse(file)
      const manualTypeOverride = findManualTypeOverride(resource)
      const changes: Partial<Resource> = {
        type: manualTypeOverride ?? parsed.type,
        name: parsed.name,
        description: parsed.description,
        tags: normalizeTags([...resource.tags, ...(parsed.tags ?? [])]),
        metadata: {
          ...parsed.metadata,
          ...(manualTypeOverride ? { manualTypeOverride } : {}),
          authorNote: resource.metadata.authorNote,
        },
      }
      await this.storage.update(resource.id, changes)
      return { ...resource, ...changes }
    } catch {
      return undefined
    }
  }

  async upgradeLegacyJsonResources(
    checkpoint = () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
  ): Promise<number> {
    await checkpoint()
    const resources = await this.storage.listSummaries()
    let upgradedCount = 0

    let processed = 0
    for (const summary of resources) {
      if (++processed % 32 === 0) await checkpoint()
      const legacyGlobalRegexName = summary.fileName.replace(/\.json$/i, '').trim()
      if (
        summary.fileName.toLocaleLowerCase().endsWith('.json') &&
        summary.metadata.parserVersion === JSON_RESOURCE_PARSER_VERSION &&
        summary.metadata.detectedVariant === 'regexCollection' &&
        summary.metadata.regexScope === 'global' &&
        summary.metadata.itemCount === 1 &&
        summary.metadata.sourceName === '全局正则' &&
        summary.metadata.legacyGlobalRegexNameRepaired !== true &&
        summary.name === '全局正则' &&
        legacyGlobalRegexName !== '全局正则' &&
        legacyGlobalRegexName
      ) {
        await this.storage.update(summary.id, {
          name: legacyGlobalRegexName,
          metadata: {
            ...(await this.storage.get(summary.id))?.metadata,
            legacyGlobalRegexNameRepaired: true,
          },
        })
        upgradedCount += 1
        continue
      }
      const isLegacyJson =
        summary.fileName.toLocaleLowerCase().endsWith('.json') &&
        summary.metadata.parserVersion !== JSON_RESOURCE_PARSER_VERSION
      if (!isLegacyJson) continue
      const resource = await this.storage.get(summary.id)
      if (resource && (await this.upgradeJsonResource(resource))) upgradedCount += 1
    }

    return upgradedCount
  }

  backfillCardFingerprints(checkpoint?: () => Promise<void>): Promise<number> {
    return versionOperations.backfillCardFingerprints(this.storage, checkpoint)
  }
  loadVersionRecognitionSnapshot(
    checkpoint?: () => Promise<void>,
  ): Promise<versionOperations.VersionRecognitionSnapshot> {
    return versionOperations.loadVersionRecognitionSnapshot(this.storage, checkpoint)
  }
  private extractEmbeddedAssets(source: Resource) {
    return this.assetOperations.extractEmbeddedAssets(source)
  }

  extractCharacterAssetsMany(ids: string[]): Promise<CharacterAssetExtractionReport> {
    return this.assetOperations.extractMany(ids)
  }
  importLinks(
    urls: string[],
    options: Pick<ImportOptions, 'signal' | 'onItemComplete'> = {},
  ): Promise<ImportResult[]> {
    return importResourceLinks(this.importOperationsContext(), urls, options)
  }

  importFiles(files: File[], options: ImportOptions = {}): Promise<ImportResult[]> {
    const run = () => {
      options.signal?.throwIfAborted()
      const importCurrent = () =>
        importResourceFilesSerial(this.importOperationsContext(), files, options)
      // Hash lookup and commit must share one boundary, including imports from other tabs.
      return typeof navigator !== 'undefined' && navigator.locks
        ? navigator.locks.request(
            'srl-resource-file-import',
            { signal: options.signal },
            importCurrent,
          )
        : importCurrent()
    }
    const pending = this.fileImportQueue.then(run)
    this.fileImportQueue = pending.then(
      () => undefined,
      () => undefined,
    )
    return pending
  }

  async setFavorite(resource: ResourceReference, favorite: boolean): Promise<void> {
    await this.storage.update(resource.id, { favorite, updatedAt: Date.now() })
  }

  async setFavoriteMany(ids: string[], favorite: boolean): Promise<void> {
    if (!ids.length) return
    await this.storage.updateMany(ids, { favorite, updatedAt: Date.now() })
  }

  async updateThumbnail(resourceId: string, thumbnailBlob?: Blob): Promise<Resource> {
    const resource = await this.storage.get(resourceId)
    if (!resource) throw new Error('要更新封面的资源不存在')
    await this.storage.update(resourceId, { thumbnailBlob, updatedAt: Date.now() })
    const updated = await this.storage.get(resourceId)
    if (!updated) throw new Error('资源封面更新失败')
    return updated
  }

  async updateOrganization(
    resource: Resource,
    categoryIds: string[],
    tags: string[],
  ): Promise<void> {
    const normalizedCategoryIds = Array.from(new Set(categoryIds.filter(Boolean)))
    await this.storage.update(resource.id, {
      categoryId: normalizedCategoryIds[0] ?? null,
      categoryIds: normalizedCategoryIds,
      tags: normalizeTags(tags),
      updatedAt: Date.now(),
    })
  }

  clearParsedCharacterTagScan(): void {
    this.parsedTagCache.clear()
  }

  private async originalCharacterTags(
    summary: ResourceSummary,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const cached = this.parsedTagCache.get(summary.id)
    if (cached && summary.contentHash && cached.hash === summary.contentHash) return cached.tags
    const resource = await this.storage.get(summary.id)
    if (!resource || resource.contentHash !== summary.contentHash)
      throw new Error('资源已变化，请重新扫描')
    const parsed = await this.parserRegistry.parse(
      new File([resource.originalBlob], resource.fileName, { type: resource.mimeType }),
    )
    const tags = normalizeTags(parsed.tags ?? [])
    if (!signal?.aborted) this.parsedTagCache.set(summary.id, { hash: summary.contentHash, tags })
    return tags
  }

  /** Parse each unchanged original once; scans use lightweight current tags and hashes. */
  async findParsedCharacterTags(
    onProgress?: (progress: ParsedTagProgress) => void,
    signal?: AbortSignal,
  ): Promise<ParsedCharacterTagCandidate[]> {
    const summaries = (await this.listResourceListSummaries()).filter(
      (item) => item.type === RESOURCE_TYPE.CHARACTER_CARD && item.tags.length,
    )
    const liveIds = new Set(summaries.map((item) => item.id))
    for (const id of this.parsedTagCache.keys())
      if (!liveIds.has(id)) this.parsedTagCache.delete(id)
    const candidates: ParsedCharacterTagCandidate[] = []
    let completed = 0
    let failed = 0
    onProgress?.({ completed, total: summaries.length, resourceName: '', failed })
    for (const summary of summaries) {
      signal?.throwIfAborted()
      try {
        const parsedTags = await this.originalCharacterTags(summary, signal)
        const current = new Set(summary.tags.map((tag) => tag.toLocaleLowerCase()))
        const tags = parsedTags.filter((tag) => current.has(tag.toLocaleLowerCase()))
        if (tags.length) candidates.push({ resource: summary, tags })
      } catch {
        failed += 1
      }
      completed += 1
      onProgress?.({ completed, total: summaries.length, resourceName: summary.name, failed })
      if (completed % 32 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
    return candidates
  }

  /** Changed originals are parsed again; unchanged files never need another binary read/write. */
  async removeParsedCharacterTags(
    removals: ParsedCharacterTagRemoval[],
    onProgress?: (progress: ParsedTagProgress) => void,
  ): Promise<{
    resourceCount: number
    tagCount: number
    entries: Array<{ resourceId: string; resourceName: string; tags: string[] }>
    failed: number
  }> {
    const selected = new Map(
      removals.map((item) => [
        item.resourceId,
        new Set(item.tags.map((tag) => tag.toLocaleLowerCase())),
      ]),
    )
    const summaries = new Map(
      (await this.listResourceListSummaries()).map((item) => [item.id, item]),
    )
    const entries: Array<{ resourceId: string; resourceName: string; tags: string[] }> = []
    let completed = 0
    let failed = 0
    onProgress?.({ completed, total: selected.size, resourceName: '', failed })
    for (const [id, selectedTags] of selected) {
      const resource = summaries.get(id)
      try {
        if (!resource || resource.type !== RESOURCE_TYPE.CHARACTER_CARD) continue
        const parsedTags = new Set(
          (await this.originalCharacterTags(resource)).map((tag) => tag.toLocaleLowerCase()),
        )
        const removed = resource.tags.filter(
          (tag) =>
            parsedTags.has(tag.toLocaleLowerCase()) && selectedTags.has(tag.toLocaleLowerCase()),
        )
        if (!removed.length) continue
        const removedKeys = new Set(removed.map((tag) => tag.toLocaleLowerCase()))
        await this.storage.update(resource.id, {
          tags: resource.tags.filter((tag) => !removedKeys.has(tag.toLocaleLowerCase())),
          updatedAt: Date.now(),
        })
        entries.push({ resourceId: resource.id, resourceName: resource.name, tags: removed })
      } catch {
        failed += 1
      } finally {
        completed += 1
        onProgress?.({
          completed,
          total: selected.size,
          resourceName: resource?.name ?? id,
          failed,
        })
      }
    }
    return {
      failed,
      resourceCount: entries.length,
      tagCount: entries.reduce((count, entry) => count + entry.tags.length, 0),
      entries,
    }
  }

  restoreParsedCharacterTags(entries: ParsedCharacterTagRemoval[]): Promise<AiTagMutationResult> {
    // Undo must preserve original long tags, unlike newly suggested AI tags.
    return operationsResourceOrganizationOperations.addTagsPerResource(this.storage, entries, true)
  }

  async updateExternalAppResource(update: ExternalAppResourceUpdate): Promise<Resource> {
    return operationsResourceOrganizationOperations.updateExternalAppResource(this.storage, update)
  }

  async updateMetadata(resourceId: string, patch: Record<string, unknown>): Promise<Resource> {
    const resource = await this.storage.get(resourceId)
    if (!resource) throw new Error('要更新的资源已经不存在')
    const metadata = { ...resource.metadata, ...patch }
    await this.storage.update(resourceId, { metadata, updatedAt: Date.now() })
    return (await this.storage.get(resourceId)) ?? { ...resource, metadata }
  }

  async updateDetails(
    resource: Resource,
    details: {
      name: string
      authorNote?: string
      description: string
      type: ResourceType
      categoryIds: string[]
      relatedResourceIds: string[]
      tags: string[]
      sourceLinks?: ResourceLink[]
      characterOverrides?: CharacterCardOverrides
      characterContentEdits?: CharacterCardContentEdit[]
    },
  ): Promise<void> {
    return operationsResourceOrganizationOperations.updateDetails(this.storage, resource, details)
  }

  async restoreRelatedLinks(resources: Resource[]): Promise<void> {
    return operationsResourceOrganizationOperations.restoreRelatedLinks(this.storage, resources)
  }

  async moveManyToCategory(ids: string[], categoryId: string | null): Promise<void> {
    return operationsResourceOrganizationOperations.moveManyToCategory(
      this.storage,
      ids,
      categoryId,
    )
  }

  async updateTagsMany(ids: string[], tag: string, action: 'add' | 'remove'): Promise<void> {
    return operationsResourceOrganizationOperations.updateTagsMany(this.storage, ids, tag, action)
  }

  async addTagsPerResource(
    suggestions: Array<{ resourceId: string; tags: string[] }>,
  ): Promise<AiTagMutationResult> {
    return operationsResourceOrganizationOperations.addTagsPerResource(this.storage, suggestions)
  }

  async undoAddedTags(entries: AiTagMutationEntry[]): Promise<AiTagMutationResult> {
    return operationsResourceOrganizationOperations.undoAddedTags(this.storage, entries)
  }

  async delete(id: string): Promise<void> {
    return operationsResourceOrganizationOperations.deleteResource(this.storage, id)
  }

  async deleteMany(
    ids: string[],
    onProgress?: (progress: { completed: number; total: number }) => void,
  ): Promise<ResourceListSummary[] | undefined> {
    return operationsResourceOrganizationOperations.deleteMany(this.storage, ids, onProgress)
  }
}
