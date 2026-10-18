import type { ResourceParserRegistry } from '../parser/ResourceParser'

import type { ResourceStorageAdapter } from '../storage/ResourceStorageAdapter'

import type { ResourceVersionMatchFingerprintCache } from '../storage/ResourceStorageAdapter'

import type { ImportResult, NativeVersionMatchReference, ParsedResource } from '../types/Import'

import {
  getResourceLinkRiskBadges,
  normalizeResourceLinks,
  normalizeResource,
  RESOURCE_INSTALL_TARGET,
  RESOURCE_TYPE,
  toResourceSummary,
  type Resource,
  type ResourceReference,
  type ResourceSummary,
} from '../types/Resource'

import {
  CHARACTER_CARD_FINGERPRINT_VERSION,
  computeCardFingerprints,
  readStoredFingerprints,
} from '../utils/CharacterCardFingerprint'

import { isRecord } from '../utils/UnknownValue'

import { isResourceOwnedFile } from '../types/ResourceAttachment'

import { hashFile } from './HashService'

import { importPipeline, type ImportFileContext } from './ImportPipeline'

import { hashNativeFile, materializeNativeFile, nativeFileSource } from '../core/NativeFileSource'

import {
  type GitHubResourceInspection,
  type GitHubResourceInspector,
} from './GitHubResourceInspector'

import {
  compareVersionCandidates,
  createVersionCandidateIndex,
  createVersionMatchEntries,
  findVersionCandidates,
  type VersionCandidate,
  type VersionMatchEntry,
} from './ResourceVersionMatcher'
import { getNativePreparedImport } from './NativePreparedImport'
import {
  matchNativeCharacterCardCandidates,
  parseNativeCharacterCardFile,
} from '../storage/NativeResourceFileMirror'

import { resourceVersionLabel } from './ResourceVersionIdentity'

import {
  safeLinkFileName,
  linkResourceType,
  linkResourceName,
  linkResourceDescription,
  linkResourceTags,
  createResourceLinkDraftFromUrl,
} from './ResourceLinkImport'

import { type ImportOptions } from '../types/ResourceOperations'

export function shouldMakeIncomingPngCurrent(
  incomingIsPng: boolean,
  matchedHistorical: boolean,
): boolean {
  return incomingIsPng && !matchedHistorical
}

export interface ResourceImportOperationsContext {
  resourceService: import('./ResourceService').ResourceService
  persistedVersionMatchCacheLoaded: boolean
  storage: ResourceStorageAdapter
  versionMatchFingerprintCache: ResourceVersionMatchFingerprintCache
  versionMatchFingerprintCacheDirty: boolean
  versionMatchIndexCache: VersionMatchIndexCache | undefined
  linkInspector: GitHubResourceInspector
  parserRegistry: ResourceParserRegistry
  upgradeJsonResource: (resource: Resource) => Promise<Resource | undefined>
  extractEmbeddedAssets: (
    source: Resource,
  ) => Promise<{ resource: Resource; created: Resource[]; assetCount: number }>
  ensureParsedFingerprints: (parsed: ParsedResource) => Promise<void>
  refineCardVersionCandidates: (
    parsed: ParsedResource,
    fileName: string,
    candidates: VersionCandidate[],
  ) => Promise<void>
  createImportedResource: (
    file: File,
    parsedResource?: ParsedResource,
    knownHash?: string,
    context?: ImportFileContext<ParsedResource>,
    options?: { createThumbnail?: boolean },
  ) => Promise<Resource>
}
export interface VersionMatchIndexCache {
  membershipSignature: string
  current: Map<string, ResourceSummary>
  versions: Map<string, ResourceSummary>
  entries: VersionMatchEntry[]
}

export function versionMatchFingerprintSignature(resource: ResourceSummary): string {
  const metadata = resource.metadata
  const card = isRecord(metadata.card) ? metadata.card : undefined
  const cardData = card && isRecord(card.data) ? card.data : card
  const identity = (value: Record<string, unknown> | undefined): unknown[] =>
    value
      ? [
          value.uuid,
          value.character_id,
          value.characterId,
          value.source_id,
          value.sourceId,
          value.source,
          value.creator,
        ]
      : []
  const stored = readStoredFingerprints(metadata)
  return JSON.stringify([
    CHARACTER_CARD_FINGERPRINT_VERSION,
    resource.id,
    resource.type,
    resource.name,
    resource.description,
    resource.fileName,
    resource.mimeType,
    resource.contentHash,
    resource.createdAt,
    resource.updatedAt,
    resource.versionGroupId,
    metadata.creator,
    metadata.source,
    ...identity(metadata),
    ...identity(card),
    ...identity(cardData),
    stored.full,
    stored.core,
    metadata.cardFingerprintVersion,
  ])
}

export function isVersionMatchFingerprintCache(
  value: unknown,
): value is ResourceVersionMatchFingerprintCache {
  if (!isRecord(value) || value.schemaVersion !== 1) return false
  const isFingerprintMap = (records: unknown): boolean =>
    isRecord(records) &&
    Object.values(records).every(
      (record) =>
        isRecord(record) &&
        typeof record.signature === 'string' &&
        typeof record.full === 'string' &&
        typeof record.core === 'string',
    )
  return isFingerprintMap(value.resources) && isFingerprintMap(value.versions)
}

export async function createContentHash(file: File): Promise<string> {
  return hashFile(file)
}
export async function createVersionMatchIndex(
  operations: ResourceImportOperationsContext,
  resources: ResourceSummary[],
  versions: ResourceSummary[],
  persistCache: boolean,
  nativeCharacterCards = false,
): Promise<VersionMatchEntry[]> {
  if (persistCache && !operations.persistedVersionMatchCacheLoaded) {
    try {
      const saved = await operations.storage.getVersionMatchFingerprintCache?.()
      if (isVersionMatchFingerprintCache(saved)) {
        operations.versionMatchFingerprintCache = saved
      } else if (saved) {
        await operations.storage.clearVersionMatchFingerprintCache?.()
      }
    } catch {
      // 派生缓存不可读时仅重新计算，不阻断资源导入。
    }
    operations.persistedVersionMatchCacheLoaded = true
  } else if (!persistCache) {
    try {
      await operations.storage.clearVersionMatchFingerprintCache?.()
    } catch {
      // 清理派生缓存失败不应阻断资源导入。
    }
    operations.persistedVersionMatchCacheLoaded = true
  }

  const withFingerprints = async (
    resource: ResourceSummary,
    scope: 'resources' | 'versions',
  ): Promise<ResourceSummary> => {
    if (nativeCharacterCards && resource.type === RESOURCE_TYPE.CHARACTER_CARD) return resource
    if (
      resource.type !== RESOURCE_TYPE.CHARACTER_CARD ||
      (typeof resource.metadata.cardContentHash === 'string' &&
        resource.metadata.cardFingerprintVersion === CHARACTER_CARD_FINGERPRINT_VERSION)
    ) {
      return resource
    }
    const signature = versionMatchFingerprintSignature(resource)
    const cached = operations.versionMatchFingerprintCache[scope][resource.id]
    if (cached?.signature === signature && cached.full && cached.core) {
      return {
        ...resource,
        metadata: {
          ...resource.metadata,
          cardContentHash: cached.full,
          cardCoreHash: cached.core,
          cardFingerprintVersion: CHARACTER_CARD_FINGERPRINT_VERSION,
        },
      }
    }
    const fingerprints = await computeCardFingerprints(resource.metadata)
    if (!fingerprints) return resource
    operations.versionMatchFingerprintCache[scope][resource.id] = {
      signature,
      full: fingerprints.full,
      core: fingerprints.core,
    }
    operations.versionMatchFingerprintCacheDirty = true
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
  const [activeResources, historicalVersions] = await Promise.all([
    Promise.all(resources.map((resource) => withFingerprints(resource, 'resources'))),
    Promise.all(versions.map((resource) => withFingerprints(resource, 'versions'))),
  ])
  const currentIds = new Set(activeResources.map((resource) => resource.id))
  const historyIds = new Set(historicalVersions.map((resource) => resource.id))
  for (const id of Object.keys(operations.versionMatchFingerprintCache.resources)) {
    if (!currentIds.has(id)) {
      delete operations.versionMatchFingerprintCache.resources[id]
      operations.versionMatchFingerprintCacheDirty = true
    }
  }
  for (const id of Object.keys(operations.versionMatchFingerprintCache.versions)) {
    if (!historyIds.has(id)) {
      delete operations.versionMatchFingerprintCache.versions[id]
      operations.versionMatchFingerprintCacheDirty = true
    }
  }
  const membershipSignature = JSON.stringify([
    activeResources.map((resource) => resource.id),
    historicalVersions.map((resource) => [resource.id, resource.versionGroupId]),
  ])
  const current = new Map(activeResources.map((resource) => [resource.id, resource]))
  const history = new Map(historicalVersions.map((resource) => [resource.id, resource]))
  if (operations.versionMatchIndexCache?.membershipSignature === membershipSignature) {
    for (const entry of operations.versionMatchIndexCache.entries) {
      const resource = entry.historical
        ? history.get(entry.resource.id)
        : current.get(entry.resource.id)
      if (!resource) continue
      entry.resource = resource
      entry.groupResource = entry.historical
        ? (current.get(resource.versionGroupId ?? '') ?? resource)
        : resource
    }
    operations.versionMatchIndexCache.current = current
    operations.versionMatchIndexCache.versions = history
    return operations.versionMatchIndexCache.entries
  }

  const entries = createVersionMatchEntries(activeResources, historicalVersions)
  operations.versionMatchIndexCache = { membershipSignature, current, versions: history, entries }
  return entries
}

function mapNativeVersionCandidates(
  references: NativeVersionMatchReference[],
  entries: VersionMatchEntry[],
  options: ImportOptions,
): VersionCandidate[] | undefined {
  const entriesById = new Map(entries.map((entry) => [entry.resource.id, entry]))
  const candidates = new Map<string, VersionCandidate>()
  for (const reference of references) {
    const entry = entriesById.get(reference.resourceId)
    if (!entry) return undefined
    if (reference.matchKind === 'sameName' && !options.sameNameVersionCandidates) continue
    const candidate: VersionCandidate = {
      resource: entry.groupResource,
      matchedResource: entry.resource,
      matchedHistorical: entry.historical,
      matchKind: reference.matchKind,
      score: Math.max(0, Math.min(100, reference.score)),
      reasons: reference.reasons.filter((reason) => typeof reason === 'string'),
    }
    const current = candidates.get(candidate.resource.id)
    candidates.set(
      candidate.resource.id,
      current && compareVersionCandidates(current, candidate) <= 0 ? current : candidate,
    )
  }
  return Array.from(candidates.values()).sort(compareVersionCandidates).slice(0, 3)
}

function nativeCandidateRows(
  parsed: ParsedResource,
  entries: VersionMatchEntry[],
): Array<Record<string, unknown>> {
  const incomingMetadata = parsed.metadata
  const incomingCard = isRecord(incomingMetadata.card) ? incomingMetadata.card : undefined
  const incomingData =
    incomingCard && isRecord(incomingCard.data) ? incomingCard.data : incomingCard
  const incomingIds = new Set<string>()
  const readIds = (record: Record<string, unknown> | undefined): void => {
    if (!record) return
    for (const key of ['uuid', 'character_id', 'characterId', 'source_id', 'sourceId', 'source']) {
      const value = typeof record[key] === 'string' ? record[key].trim().toLocaleLowerCase() : ''
      if (key === 'source' && !/^https?:\/\//i.test(value)) continue
      if (value) incomingIds.add(`${key}:${value}`)
    }
  }
  readIds(incomingMetadata)
  readIds(incomingCard)
  readIds(incomingData)
  const normalize = (value: string): string =>
    value
      .normalize('NFKC')
      .toLocaleLowerCase()
      .replace(/[\s·・_\-—–()[\]【】（）.]+/gu, '')
  const incomingName = normalize(parsed.name)
  const incomingFingerprints = readStoredFingerprints(incomingMetadata)
  const rows: Array<Record<string, unknown>> = []
  for (const entry of entries) {
    const resource = entry.resource
    if (resource.type !== RESOURCE_TYPE.CHARACTER_CARD) continue
    const metadata = resource.metadata
    const stored = readStoredFingerprints(metadata)
    const card = isRecord(metadata.card) ? metadata.card : undefined
    const data = card && isRecord(card.data) ? card.data : card
    const existingIds = new Set<string>()
    const addIds = (record: Record<string, unknown> | undefined): void => {
      if (!record) return
      for (const key of [
        'uuid',
        'character_id',
        'characterId',
        'source_id',
        'sourceId',
        'source',
      ]) {
        const value = typeof record[key] === 'string' ? record[key].trim().toLocaleLowerCase() : ''
        if (key === 'source' && !/^https?:\/\//i.test(value)) continue
        if (value) existingIds.add(`${key}:${value}`)
      }
    }
    addIds(metadata)
    addIds(card)
    addIds(data)
    const sameName = normalize(resource.name) === incomingName
    const sameId = Array.from(existingIds).some((id) => incomingIds.has(id))
    const sameStoredContent = Boolean(
      incomingFingerprints.full && incomingFingerprints.full === stored.full,
    )
    const sameStoredCore = Boolean(
      incomingFingerprints.core && incomingFingerprints.core === stored.core,
    )
    const legacyCard = metadata.cardFingerprintVersion !== CHARACTER_CARD_FINGERPRINT_VERSION
    if (!sameName && !sameId && !sameStoredContent && !sameStoredCore) continue
    const rowMetadata: Record<string, unknown> = {
      creator: metadata.creator,
      cardContentHash: metadata.cardContentHash,
      cardCoreHash: metadata.cardCoreHash,
      cardFingerprintVersion: metadata.cardFingerprintVersion,
      nativeStableIds: Array.from(existingIds),
    }
    if (legacyCard && card) rowMetadata.card = card
    rows.push({
      id: resource.id,
      type: resource.type,
      name: resource.name,
      description: resource.description,
      fileName: resource.fileName,
      mimeType: resource.mimeType,
      metadata: rowMetadata,
      historical: entry.historical,
      versionGroupId: entry.groupResource.id,
    })
  }
  return rows
}

export async function importLinks(
  operations: ResourceImportOperationsContext,
  urls: string[],
  options: Pick<ImportOptions, 'signal' | 'onItemComplete'> = {},
): Promise<ImportResult[]> {
  options.signal?.throwIfAborted()
  const results: ImportResult[] = []
  if (!urls.length) return results
  const knownResources = await (operations.storage.listResourceListSummaries?.() ??
    operations.storage.listSummaries())
  options.signal?.throwIfAborted()
  const resourceIdsByUrl = new Map<string, string>()
  const duplicateResources = new Map<string, Resource>()
  // Keep this index within one import: edits and deletions are reflected on the next run.
  const rememberSourceLinks = (resource: ResourceReference): void => {
    for (const link of normalizeResourceLinks(resource.sourceLinks)) {
      const key = link.url.toLocaleLowerCase()
      if (!resourceIdsByUrl.has(key)) resourceIdsByUrl.set(key, resource.id)
    }
  }
  knownResources.forEach(rememberSourceLinks)

  for (const rawUrl of urls) {
    const resultCount = results.length
    const displayUrl = rawUrl.trim() || '空链接'
    try {
      options.signal?.throwIfAborted()
      const now = Date.now()
      const linkDraft = createResourceLinkDraftFromUrl(rawUrl, now)
      if (!linkDraft) throw new Error('资源链接仅支持 http/https 地址')

      const linkKey = linkDraft.url.toLocaleLowerCase()
      const duplicateId = resourceIdsByUrl.get(linkKey)
      const duplicate = duplicateId
        ? (duplicateResources.get(duplicateId) ?? (await operations.storage.get(duplicateId)))
        : undefined
      options.signal?.throwIfAborted()
      if (duplicate) {
        duplicateResources.set(duplicate.id, duplicate)
        results.push({
          status: 'duplicate',
          fileName: linkDraft.url,
          message: `已存在相同链接：${duplicate.name}`,
          resource: duplicate,
          reclassified: false,
        })
        continue
      }
      if (duplicateId) resourceIdsByUrl.delete(linkKey)

      const inspection = await operations
        .linkInspector(linkDraft, undefined, options.signal)
        .catch((): GitHubResourceInspection | undefined => undefined)
      options.signal?.throwIfAborted()
      const link = normalizeResourceLinks([
        {
          ...linkDraft,
          ...(inspection && inspection.status !== 'unavailable'
            ? {
                installTarget:
                  inspection.installTarget !== RESOURCE_INSTALL_TARGET.NONE
                    ? inspection.installTarget
                    : linkDraft.installTarget,
                trustMode: inspection.trustMode,
              }
            : {}),
        },
      ])[0]
      if (!link) throw new Error('资源链接结构无效')

      const type = linkResourceType(link)
      const name = linkResourceName(link, inspection)
      const descriptor = {
        format: 'srl-link-resource',
        url: link.url,
        label: link.label,
        type: link.type,
        purpose: link.purpose,
        installTarget: link.installTarget,
        trustMode: link.trustMode,
        versionRef: link.versionRef,
        github: link.github,
        riskBadges: getResourceLinkRiskBadges(link),
        inspection,
        createdAt: now,
        safety: {
          linkOnly: true,
          downloadsContent: false,
          installsExtension: false,
          executesScript: false,
        },
      }
      const blob = new Blob([JSON.stringify(descriptor, null, 2)], {
        type: 'application/srl-link+json',
      })
      const file = new File([blob], safeLinkFileName(name), {
        type: 'application/srl-link+json',
      })
      const contentHash = await createContentHash(file)
      const resource: Resource = {
        id: crypto.randomUUID(),
        type,
        name,
        description: linkResourceDescription(link, inspection),
        fileName: file.name,
        mimeType: file.type,
        fileSize: file.size,
        contentHash,
        favorite: false,
        categoryId: null,
        categoryIds: [],
        relatedResourceIds: [],
        sourceLinks: [link],
        tags: linkResourceTags(link, inspection),
        metadata: {
          format: 'link',
          parserVersion: 1,
          detectedVariant: 'externalLink',
          linkImport: descriptor,
          rootKeys: Object.keys(descriptor),
          itemCount: 1,
        },
        versionImportedAt: now,
        versionCount: 1,
        originalBlob: file,
        createdAt: now,
        updatedAt: now,
      }
      resource.versionLabel = resourceVersionLabel(resource)
      const normalizedResource = normalizeResource(resource)
      options.signal?.throwIfAborted()
      await operations.storage.save(normalizedResource)
      rememberSourceLinks(normalizedResource)
      duplicateResources.set(normalizedResource.id, normalizedResource)
      results.push({
        status: 'imported',
        fileName: link.url,
        resource: normalizedResource,
      })
    } catch (error) {
      if (options.signal?.aborted) throw error
      results.push({
        status: 'failed',
        fileName: displayUrl,
        message: error instanceof Error ? error.message : '链接导入失败',
      })
    } finally {
      if (results.length > resultCount) {
        const result = results.at(-1)
        if (result) await options.onItemComplete?.(result)
      }
    }
  }

  return results
}

export async function importFilesSerial(
  operations: ResourceImportOperationsContext,
  files: File[],
  options: ImportOptions,
): Promise<ImportResult[]> {
  options.signal?.throwIfAborted()
  const chatBatch: import('./TavernChatImport').TavernChatImportBatch = {}
  const results: ImportResult[] = []
  const completedContentHashes = new Set(
    options.completedContentHashes?.map((hash) => hash.toLowerCase()) ?? [],
  )
  const resourceFileCount = files.filter((file) => !/\.srlchat$/i.test(file.name)).length
  const hasResourceFiles = resourceFileCount > 0
  const batchHashLookup = resourceFileCount > 1
  const compareVersions =
    options.detectVersions !== false && options.skipVersionComparison !== true && hasResourceFiles
  let knownResources: ResourceSummary[] = []
  let knownVersions: ResourceSummary[] = []
  let knownSummariesLoaded = false
  const loadKnownSummaries = async (): Promise<void> => {
    if (knownSummariesLoaded) return
    ;[knownResources, knownVersions] = await Promise.all([
      operations.storage.listSummaries(),
      operations.storage.listVersionSummaries(),
    ])
    knownSummariesLoaded = true
  }
  const activeByHash = new Map<string, ResourceSummary>()
  const versionsByHash = new Map<string, ResourceSummary>()
  const knownResourceIds = new Set<string>()
  const rememberActive = (resource: ResourceSummary): void => {
    if (resource.contentHash && !isResourceOwnedFile(resource)) {
      if (!activeByHash.has(resource.contentHash)) activeByHash.set(resource.contentHash, resource)
    }
    if (!knownResourceIds.has(resource.id)) {
      knownResources.push(resource)
      knownResourceIds.add(resource.id)
    }
  }
  if (batchHashLookup) {
    await loadKnownSummaries()
    for (const resource of knownResources) knownResourceIds.add(resource.id)
    for (const resource of knownResources) {
      if (
        resource.contentHash &&
        !isResourceOwnedFile(resource) &&
        !activeByHash.has(resource.contentHash)
      ) {
        activeByHash.set(resource.contentHash, resource)
      }
    }
    for (const version of knownVersions) {
      if (version.contentHash && !versionsByHash.has(version.contentHash)) {
        versionsByHash.set(version.contentHash, version)
      }
    }
  }
  let versionMatchIndex: VersionMatchEntry[] = []
  let candidateIndex: ReturnType<typeof createVersionCandidateIndex> | undefined
  let versionIndexReady = false
  const ensureVersionIndex = async (): Promise<void> => {
    if (!compareVersions || versionIndexReady) return
    await loadKnownSummaries()
    for (const resource of knownResources) knownResourceIds.add(resource.id)
    versionMatchIndex = await createVersionMatchIndex(
      operations,
      knownResources,
      knownVersions,
      options.persistVersionMatchCache !== false,
      files.length > 0 && files.every((file) => getNativePreparedImport(file) !== undefined),
    )
    candidateIndex = createVersionCandidateIndex(versionMatchIndex)
    versionIndexReady = true
  }

  for (const [fileIndex, file] of files.entries()) {
    const resultCount = results.length
    const reportProgress = (phase: string, completed = fileIndex): void =>
      options.onProgress?.({
        completed,
        total: files.length,
        fileName: file.name,
        phase,
      })
    try {
      options.signal?.throwIfAborted()
      reportProgress('正在准备文件')
      const sourceHash = options.originalContentHashes?.get(file)
      const committedHash = sourceHash && options.completedImportAliases?.[sourceHash]
      if (committedHash) {
        const committed =
          (await operations.storage.findByHash(committedHash)) ??
          (await operations.storage.findVersionByHash(committedHash))
        if (committed) {
          results.push({
            status: 'duplicate',
            fileName: file.name,
            message: '此前的导入任务已成功保存此资源',
            resource: committed,
            reclassified: false,
          })
          continue
        }
      }
      if (/\.srlchat$/i.test(file.name)) {
        const { importTavernChat } = await import('./TavernChatImport')
        try {
          results.push(
            await importTavernChat(
              file,
              operations.resourceService,
              operations.parserRegistry,
              options,
              chatBatch,
            ),
          )
        } catch (error) {
          chatBatch.summaries = undefined
          throw error
        }
        continue
      }
      // Mixed imports can change the same summaries before the next chat.
      chatBatch.summaries = undefined
      reportProgress('正在读取并计算校验值')
      let importFile = file
      let context: ImportFileContext<ParsedResource> | undefined
      let contentHash: string
      if (nativeFileSource(file)) {
        const nativeHash = await hashNativeFile(file, options.signal)
        if (nativeHash) contentHash = nativeHash
        else {
          importFile = await materializeNativeFile(file, {
            detachFromNativeSource: true,
            signal: options.signal,
          })
          context = importPipeline.intake<ParsedResource>(importFile)
          contentHash = await context.hash()
        }
      } else {
        context = importPipeline.intake<ParsedResource>(file)
        contentHash = await context.hash()
      }
      options.signal?.throwIfAborted()
      if (completedContentHashes.has(contentHash.toLowerCase())) {
        const committed =
          (await operations.storage.findByHash(contentHash)) ??
          (await operations.storage.findVersionByHash(contentHash))
        if (committed) {
          results.push({
            status: 'duplicate',
            fileName: file.name,
            message: '此前的导入任务已成功保存此资源',
            resource: committed,
            reclassified: false,
          })
          continue
        }
      }
      reportProgress('正在检查重复资源')
      const activeDuplicateSummary = batchHashLookup ? activeByHash.get(contentHash) : undefined
      const versionDuplicateSummary =
        batchHashLookup && !activeDuplicateSummary ? versionsByHash.get(contentHash) : undefined
      const activeDuplicate = batchHashLookup
        ? activeDuplicateSummary
          ? ((await operations.storage.get(activeDuplicateSummary.id)) ??
            (await operations.storage.findByHash(contentHash)))
          : undefined
        : await operations.storage.findByHash(contentHash)
      const versionDuplicate = activeDuplicate
        ? undefined
        : batchHashLookup
          ? versionDuplicateSummary
            ? ((versionDuplicateSummary.versionGroupId
                ? await operations.storage.get(versionDuplicateSummary.versionGroupId)
                : undefined) ??
              (await operations.storage.getVersion?.(versionDuplicateSummary.id)) ??
              (await operations.storage.findVersionByHash(contentHash)))
            : undefined
          : await operations.storage.findVersionByHash(contentHash)
      const duplicateResource = activeDuplicate ?? versionDuplicate
      const matchedHistoricalVersion = Boolean(
        versionDuplicateSummary?.versionGroupId ??
        (!batchHashLookup ? versionDuplicate?.versionGroupId : undefined),
      )

      if (duplicateResource) {
        const upgraded = activeDuplicate
          ? await operations.upgradeJsonResource(duplicateResource)
          : undefined
        const current = upgraded ?? duplicateResource
        const extracted = options.extractCharacterAssets
          ? await operations.extractEmbeddedAssets(current)
          : { resource: current, created: [], assetCount: 0 }
        results.push({
          status: 'duplicate',
          fileName: file.name,
          message: matchedHistoricalVersion
            ? `与「${duplicateResource.name}」的历史版本文件完全相同`
            : `与「${duplicateResource.name}」文件内容完全相同`,
          resource: extracted.resource,
          reclassified: Boolean(upgraded),
          extractedResources: extracted.created,
        })
        for (const resource of extracted.created) rememberActive(toResourceSummary(resource))
        continue
      }

      reportProgress('正在解析资源内容')
      if (nativeFileSource(importFile)) {
        importFile = await materializeNativeFile(importFile, {
          detachFromNativeSource: true,
          signal: options.signal,
        })
      }
      context ??= importPipeline.intake<ParsedResource>(importFile)
      const nativePrepared = getNativePreparedImport(file)
      const nativeParsed =
        nativePrepared?.parsed ?? (await parseNativeCharacterCardFile(file, options.signal))
      const parsed =
        nativeParsed ?? (await context.parse((source) => operations.parserRegistry.parse(source)))
      options.signal?.throwIfAborted()
      // A new persona is not a candidate for a remembered character-card file.
      // Direct current/history hash checks above still protect every resource type.
      // Wait for the cached parse before loading this character-only alias index.
      if (parsed.type === RESOURCE_TYPE.CHARACTER_CARD) {
        const recognizedCharacterCard =
          await operations.resourceService.findCharacterCardByContentHash(contentHash)
        if (recognizedCharacterCard?.matchedBy === 'recognized-hash') {
          results.push({
            status: 'duplicate',
            fileName: file.name,
            message: `此前识别过「${recognizedCharacterCard.resource.name}」的此文件，已自动跳过重复导入`,
            resource: recognizedCharacterCard.resource,
            reclassified: false,
          })
          continue
        }
      }
      await operations.ensureParsedFingerprints(parsed)
      await ensureVersionIndex()
      if (candidateIndex) {
        // Background candidates are only an early notification: the IndexedDB catalog may
        // have changed since then. Re-run version judgement natively against the live summaries.
        const nativeReferences =
          nativePrepared || nativeParsed
            ? await matchNativeCharacterCardCandidates(
                parsed,
                file.name,
                nativeCandidateRows(parsed, versionMatchIndex),
                options.sameNameVersionCandidates === true,
              )
            : null
        let candidates: VersionCandidate[]
        if (nativeReferences) {
          const mapped = mapNativeVersionCandidates(nativeReferences, versionMatchIndex, options)
          if (!mapped) throw new Error('原生版本候选已与当前资源目录不一致，请重新导入')
          candidates = mapped
        } else {
          // Browser/PWA and APK versions without this bridge keep the existing matcher.
          candidates = findVersionCandidates(parsed, file.name, candidateIndex, options)
          await operations.refineCardVersionCandidates(parsed, file.name, candidates)
        }
        const exactContentMatches = candidates.filter(
          (candidate) => candidate.matchKind === 'contentDuplicate',
        )
        if (exactContentMatches.length === 1) {
          const candidate = exactContentMatches[0]
          const duplicateResource = await operations.storage.get(candidate.resource.id)
          if (duplicateResource) {
            await operations.resourceService.rememberRecognizedFileHash(
              importFile,
              candidate.matchedResource,
              candidate.matchedHistorical,
            )
            const extracted = options.extractCharacterAssets
              ? await operations.extractEmbeddedAssets(duplicateResource)
              : { resource: duplicateResource, created: [], assetCount: 0 }
            results.push({
              status: 'duplicate',
              fileName: file.name,
              message: candidate.matchedHistorical
                ? `与「${candidate.resource.name}」的历史版本卡内数据完全一致`
                : `与「${candidate.resource.name}」卡内数据完全一致`,
              resource: extracted.resource,
              reclassified: false,
              extractedResources: extracted.created,
            })
            for (const resource of extracted.created) rememberActive(toResourceSummary(resource))
            continue
          }
        }
        const exactContainerMatch =
          options.preferPngContainer &&
          candidates.length === 1 &&
          candidates[0]?.matchKind === 'containerVariant' &&
          ((/\.png$/iu.test(file.name) &&
            /\.json$/iu.test(candidates[0].matchedResource.fileName)) ||
            (/\.json$/iu.test(file.name) &&
              /\.png$/iu.test(candidates[0].matchedResource.fileName)))
            ? candidates[0]
            : undefined
        if (exactContainerMatch) {
          const targetId = exactContainerMatch.resource.id
          const incomingIsPng = /\.png$/iu.test(file.name)
          const makeIncomingCurrent = shouldMakeIncomingPngCurrent(
            incomingIsPng,
            exactContainerMatch.matchedHistorical,
          )
          const resource = await operations.resourceService.importAsVersion(
            importFile,
            targetId,
            makeIncomingCurrent,
            '同内容 JSON / PNG 封装',
            'container',
          )
          results.push({ status: 'imported', fileName: file.name, resource })
          continue
        }
        if (candidates.length) {
          results.push({
            status: 'versionCandidate',
            fileName: file.name,
            file: importFile,
            candidates,
          })
          continue
        }
      }
      let resource = await operations.createImportedResource(
        importFile,
        parsed,
        contentHash,
        context,
      )

      options.signal?.throwIfAborted()
      reportProgress('正在写入资源库')
      await operations.storage.save(resource)
      context.mark('commit')
      const summary = toResourceSummary(resource)
      rememberActive(summary)
      const matchEntry: VersionMatchEntry = {
        resource: summary,
        groupResource: summary,
        historical: false,
      }
      versionMatchIndex.push(matchEntry)
      candidateIndex?.add(matchEntry)
      if (operations.versionMatchIndexCache) {
        operations.versionMatchIndexCache.current.set(summary.id, summary)
        // The batch-local index is updated above. Mark the reusable index
        // stale in O(1); rebuilding a signature over every ID for each
        // imported file would make large batches quadratic.
        operations.versionMatchIndexCache.membershipSignature = ''
      }
      const extracted = options.extractCharacterAssets
        ? await operations.extractEmbeddedAssets(resource)
        : { resource, created: [], assetCount: 0 }
      resource = extracted.resource
      for (const extractedResource of extracted.created) {
        rememberActive(toResourceSummary(extractedResource))
      }
      results.push({
        status: 'imported',
        fileName: file.name,
        resource,
        extractedResources: extracted.created,
      })
    } catch (error) {
      if (options.signal?.aborted) throw error
      results.push({
        status: 'failed',
        fileName: file.name,
        message: error instanceof Error ? error.message : '导入失败',
      })
    } finally {
      reportProgress(`已处理 ${fileIndex + 1}/${files.length}`, fileIndex + 1)
      if (results.length > resultCount) {
        const result = results.at(-1)
        if (result) {
          if (result.status !== 'failed')
            result.sourceContentHash = options.originalContentHashes?.get(file)
          await options.onItemComplete?.(result)
        }
        if (options.discardCompletedResults) results.pop()
      }
    }
  }

  if (options.persistVersionMatchCache !== false && operations.versionMatchFingerprintCacheDirty) {
    try {
      await operations.storage.setVersionMatchFingerprintCache?.(
        operations.versionMatchFingerprintCache,
      )
      operations.versionMatchFingerprintCacheDirty = false
    } catch {
      // 指纹缓存只是性能优化；写入失败后下次导入重新计算即可。
    }
  }
  return results
}
