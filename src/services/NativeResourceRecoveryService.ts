import type { ResourceParserRegistry } from '../parser/ResourceParser'
import type { ParsedResource } from '../types/Import'
import { RESOURCE_TYPE, type ResourceType } from '../types/Resource'
import type { IndexedDbAssetStore } from '../storage/IndexedDbAssetStore'
import type {
  IndexedDbResourceHealthStorage,
  NativeRecoveryInput,
} from '../storage/IndexedDbResourceHealthStorage'
import {
  inspectNativeRecoveryObject,
  linkNativeResourceObjects,
  listNativeRecoveryCandidates,
  unlinkNativeResourceEntries,
  verifyNativeResourceLinks,
  deleteNativeRecoveryCandidates,
  type NativeRecoveryCandidate,
  type NativeRecoveryDeletionReport,
  type NativeRecoveryCandidatePage,
} from '../storage/NativeResourceFileMirror'

export interface NativeRecoveryReport {
  created: number
  updated: number
  existing: number
  unsupported: number
  failed: number
  pendingLinks: number
}

export interface NativeRecoveryPreview {
  name: string
  type?: ResourceType
}

/** The only recovery orchestrator: parse existing bytes, then commit references, not imports. */
export class NativeResourceRecoveryService {
  private busy = false

  private readonly storage: IndexedDbResourceHealthStorage
  private readonly parsers: ResourceParserRegistry
  private readonly assets: Pick<IndexedDbAssetStore, 'put'>
  private readonly isVaultEnabled: () => boolean
  private readonly inspect: typeof inspectNativeRecoveryObject
  private readonly link: typeof linkNativeResourceObjects
  private readonly unlink: typeof unlinkNativeResourceEntries
  private readonly verifyLinks: typeof verifyNativeResourceLinks

  constructor(
    storage: IndexedDbResourceHealthStorage,
    parsers: ResourceParserRegistry,
    assets: Pick<IndexedDbAssetStore, 'put'>,
    isVaultEnabled: () => boolean,
    inspect = inspectNativeRecoveryObject,
    link = linkNativeResourceObjects,
    unlink = unlinkNativeResourceEntries,
    verifyLinks = verifyNativeResourceLinks,
  ) {
    this.storage = storage
    this.parsers = parsers
    this.assets = assets
    this.isVaultEnabled = isVaultEnabled
    this.inspect = inspect
    this.link = link
    this.unlink = unlink
    this.verifyLinks = verifyLinks
  }

  private assertWritable(): void {
    if (this.isVaultEnabled()) throw new Error('保险箱开启时不能把明文 Android 对象重新挂回资源库')
  }

  private async parse(
    candidate: NativeRecoveryInput,
    verify: boolean,
  ): Promise<
    | {
        parsed: ParsedResource
        fileName: string
        mimeType: string
        thumbnail?: Blob
      }
    | undefined
  > {
    this.assertWritable()
    const source = await this.inspect(candidate, verify)
    if (source.kind === 'unknown' || source.text === undefined) return undefined
    const extension = source.kind === 'png' ? 'png' : source.kind === 'css' ? 'css' : 'json'
    const mimeType =
      source.kind === 'png' ? 'image/png' : source.kind === 'css' ? 'text/css' : 'application/json'
    // PNG image bytes stay native. The existing JSON parser interprets its extracted chara/ccv3.
    let parsed: ParsedResource
    try {
      parsed = await this.parsers.parse(
        new File([source.text], source.kind === 'css' ? 'recovered.css' : 'recovered.json', {
          type: source.kind === 'css' ? 'text/css' : 'application/json',
        }),
      )
    } catch {
      return undefined
    }
    if (
      parsed.type === RESOURCE_TYPE.OTHER ||
      (source.kind === 'png' && parsed.type !== RESOURCE_TYPE.CHARACTER_CARD)
    )
      return undefined
    const name =
      parsed.name
        .replace(/[\\/:*?"<>|]/g, '_')
        .split('')
        .map((character) => (character.charCodeAt(0) < 32 ? '_' : character))
        .join('')
        .slice(0, 160) || '找回资源'
    let thumbnail: Blob | undefined
    if (verify && source.thumbnailBase64) {
      if (source.thumbnailBase64.length > 6 * 1024 * 1024) throw new Error('找回缩略图超过安全上限')
      thumbnail = new Blob(
        [Uint8Array.from(atob(source.thumbnailBase64), (char) => char.charCodeAt(0))],
        { type: 'image/png' },
      )
    }
    return { parsed, fileName: `${name}.${extension}`, mimeType, thumbnail }
  }

  private async unlinkStaleNativeIndex(
    candidate: NativeRecoveryInput,
    linkedId: string,
    linkedScope: 'current' | 'versions',
  ): Promise<void> {
    if (candidate.nativeScope !== 'current' || !candidate.nativeId) return
    if (linkedScope === 'current' && linkedId === candidate.nativeId) return
    const removed = await this.unlink([
      {
        scope: 'current',
        id: candidate.nativeId,
        contentHash: candidate.contentHash.toLowerCase(),
      },
    ])
    if (removed !== 1) throw new Error('陈旧原生索引未撤下，保留待下次核对')
  }

  async listCandidates(
    cursor: string | undefined,
    limit = 100,
  ): Promise<NativeRecoveryCandidatePage | null> {
    const currentIds = await this.storage.nativeRecoveryCurrentIds()
    return listNativeRecoveryCandidates(cursor, limit, currentIds)
  }

  async preview(candidate: NativeRecoveryInput): Promise<NativeRecoveryPreview> {
    const result = await this.parse(candidate, false)
    return result
      ? { name: result.parsed.name, type: result.parsed.type }
      : { name: '未识别文件（保留原件）' }
  }

  async deleteCandidates(
    candidates: readonly NativeRecoveryCandidate[],
    options: { signal?: AbortSignal; onProgress?: (completed: number, total: number) => void } = {},
  ): Promise<NativeRecoveryDeletionReport> {
    this.assertWritable()
    if (this.busy) throw new Error('已有原件找回或删除任务正在运行')
    const hashes = new Set<string>()
    for (const item of candidates) {
      if (
        !/^[a-f0-9]{64}$/.test(item.contentHash) ||
        hashes.has(item.contentHash) ||
        !Number.isSafeInteger(item.size) ||
        item.size < 0 ||
        !Number.isSafeInteger(item.modifiedAt) ||
        item.modifiedAt < 0
      )
        throw new Error('待删除原件标识、大小或时间无效，请重新扫描')
      hashes.add(item.contentHash)
    }
    this.busy = true
    const report: NativeRecoveryDeletionReport = {
      deletedHashes: [],
      retainedHashes: [],
      clearedBytes: 0,
    }
    try {
      for (let offset = 0; offset < candidates.length; offset += 100) {
        options.signal?.throwIfAborted()
        this.assertWritable()
        const batch = candidates.slice(offset, offset + 100)
        const result = await deleteNativeRecoveryCandidates(batch)
        if (
          !result ||
          !Array.isArray(result.deletedHashes) ||
          !Array.isArray(result.retainedHashes)
        )
          throw new Error('原件删除回执不完整，请重新检查；部分文件可能已删除')
        const returned = [...result.deletedHashes, ...result.retainedHashes]
        if (
          returned.length !== batch.length ||
          new Set(returned).size !== batch.length ||
          returned.some((hash) => !batch.some((item) => item.contentHash === hash)) ||
          !Number.isSafeInteger(result.clearedBytes) ||
          result.clearedBytes < 0 ||
          result.clearedBytes !==
            batch
              .filter((item) => result.deletedHashes.includes(item.contentHash))
              .reduce((sum, item) => sum + item.size, 0)
        )
          throw new Error('原件删除回执不完整，请重新检查；部分文件可能已删除')
        report.deletedHashes.push(...result.deletedHashes)
        report.retainedHashes.push(...result.retainedHashes)
        report.clearedBytes += result.clearedBytes
        options.onProgress?.(offset + batch.length, candidates.length)
      }
      return report
    } finally {
      this.busy = false
    }
  }

  async recover(
    candidates: Iterable<NativeRecoveryInput> | AsyncIterable<NativeRecoveryInput>,
    retryPending = false,
  ): Promise<NativeRecoveryReport> {
    this.assertWritable()
    if (this.busy) throw new Error('已有原件找回任务正在运行')
    this.busy = true
    const report: NativeRecoveryReport = {
      created: 0,
      updated: 0,
      existing: 0,
      unsupported: 0,
      failed: 0,
      pendingLinks: 0,
    }
    const visited = new Set<string>()
    try {
      if (retryPending) {
        for await (const link of this.storage.listPendingNativeLinks()) {
          this.assertWritable()
          try {
            if (!(await this.storage.isNativeRecoveryLinkCurrent(link)))
              throw new Error('待补写索引与当前资源不一致，保留待核对记录')
            if ((await this.link([link])) !== 1) throw new Error('原生索引未写入')
            await this.storage.completeNativeRecoveryLink(link)
            report.existing++
          } catch {
            report.pendingLinks++
          }
        }
      }
      for await (const candidate of candidates) {
        const hash = candidate.contentHash.toLowerCase()
        if (visited.has(hash)) continue
        visited.add(hash)
        try {
          const normalized = { ...candidate, contentHash: hash }
          const existingLink = await this.storage.prepareExistingNativeCandidate(normalized)
          if (existingLink) {
            report.existing++
            try {
              if ((await this.link([existingLink])) !== 1) throw new Error('原生索引未写入')
              await this.unlinkStaleNativeIndex(normalized, existingLink.id, existingLink.scope)
              await this.storage.completeNativeRecoveryLink(existingLink)
            } catch {
              report.pendingLinks++
            }
            continue
          }
          const ready = await this.parse(normalized, true)
          if (!ready) {
            report.unsupported++
            continue
          }
          this.assertWritable()
          const thumbnailAssetId = ready.thumbnail
            ? (await this.assets.put(ready.thumbnail, { source: 'thumbnail' })).assetId
            : undefined
          this.assertWritable()
          const recovered = await this.storage.recoverNativeCandidate(
            { ...candidate, contentHash: hash },
            ready.parsed,
            candidate.fileName || ready.fileName,
            ready.mimeType,
            thumbnailAssetId,
          )
          report[recovered.outcome]++
          try {
            if ((await this.link([recovered.link])) !== 1) throw new Error('原生索引未写入')
            await this.unlinkStaleNativeIndex(normalized, recovered.link.id, recovered.link.scope)
            await this.storage.completeNativeRecoveryLink(recovered.link)
          } catch {
            // The resource is already readable. Retry links on the next recovery without another row.
            report.pendingLinks++
          }
        } catch {
          report.failed++
        }
      }
      return report
    } finally {
      this.busy = false
    }
  }

  repairExisting(): Promise<NativeRecoveryReport> {
    return this.recover(this.storage.listRecoveredCandidates(), true)
  }

  /**
   * Drops only IndexedDB Blob mirrors whose native entry and object SHA-256 both verify.
   * We deliberately batch verification before each IndexedDB conversion: an interrupted run leaves
   * redundant bytes, never a resource without an original.
   */
  async reclaimVerifiedNativeMirrors() {
    this.assertWritable()
    if (this.busy) throw new Error('已有原件找回或回收任务正在运行')
    this.busy = true
    try {
      const batch: Array<{
        scope: 'current' | 'versions'
        id: string
        contentHash: string
        size: number
      }> = []
      const total = {
        currentCount: 0,
        versionCount: 0,
        reclaimableBytes: 0,
        convertedCurrent: 0,
        convertedVersions: 0,
      }
      const flush = async (): Promise<void> => {
        if (!batch.length) return
        const verifiedBatch = [...batch]
        if ((await this.verifyLinks(verifiedBatch)) !== verifiedBatch.length)
          throw new Error('原生镜像核验结果不完整，已保留网页副本')
        const report = await this.storage.convertVerifiedNativeMirrors(verifiedBatch)
        total.currentCount += report.currentCount
        total.versionCount += report.versionCount
        total.reclaimableBytes += report.reclaimableBytes
        total.convertedCurrent += report.convertedCurrent
        total.convertedVersions += report.convertedVersions
        batch.length = 0
      }
      for await (const record of this.storage.listNativeMirrorDuplicates()) {
        batch.push(record)
        if (batch.length === 100) await flush()
      }
      await flush()
      return total
    } finally {
      this.busy = false
    }
  }

  nativeMirrorDuplicationSummary() {
    return this.storage.nativeMirrorDuplicationSummary()
  }

  storageAccounting(options?: Parameters<IndexedDbResourceHealthStorage['storageAccounting']>[0]) {
    return this.storage.storageAccounting(options)
  }
}
