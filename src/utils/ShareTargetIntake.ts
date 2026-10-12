import { Capacitor, registerPlugin } from '@capacitor/core'
import { rememberNativeFile } from '../core/NativeFileSource'
import type { ImportResult, ParsedResource } from '../types/Import'
import { setNativePreparedImport } from '../services/NativePreparedImport'

/**
 * 取回系统分享暂存的文件。
 *
 * 网页由 Service Worker 暂存；APK 由 Android 流式复制到应用私有持久目录。
 * 应用登录完成后交给常规导入管线，只有数据库导入成功才确认删除；
 * 失败文件保留七天供下次启动重试。文件从不离开本机。
 */

const INTAKE_CACHE = 'srl-share-intake'
const LEGACY_MANIFEST_KEY = '/srl-shared/manifest'
const PENDING_ROUTE_PREFIX = 'srl.shared-import-route.v1.'
const PENDING_IMPORT_PREFIX = 'srl.shared-import-attempt.v1.'
const PENDING_IMPORT_ITEM_PREFIX = 'srl.shared-import-item.v1.'
const PENDING_ROUTE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

interface SharedFileMeta {
  name: string
  type: string
}

interface NativeSharedFile extends SharedFileMeta {
  discordSourceToken?: string
  cloudLibraryId?: string
  size?: number
  /** 0.0.2 及更早原生壳返回 Base64；保留读取能力，避免网页先更新时旧 APK 失效。 */
  data?: string
  /** 新原生壳返回应用私有暂存目录中的 file:// URI，避免 Base64 放大与多次内存复制。 */
  uri?: string
  cleanupToken?: string
  route?: SharedImportRoute | 'discordUrl'
  nativeCharacterCardResult?: {
    state?: string
    parsedResourceUri?: string
  }
}

export interface NativeDiscordAttachmentShare {
  cloudLibraryId?: string
  name: string
  type: string
  size?: number
  cleanupToken: string
  discordUrl: string
  error?: string
}

interface ShareReceiverPlugin {
  listIntakeFiles(): Promise<{ entries: NativeIntakeFile[] }>
  removeIntakeFile(options: { token: string; snapshot: string }): Promise<{ removedBytes: number }>
  removeIntakeReceipts(options: {
    items: Array<{ token: string; snapshot: string }>
  }): Promise<NativeReceiptCleanupResult>
  getPendingShare(): Promise<{
    files: NativeSharedFile[]
    discordUrls?: NativeDiscordAttachmentShare[]
    downloads?: Array<{ token: string; workId?: string; name?: string }>
  }>
  cleanupPendingShare(options: { tokens: string[] }): Promise<void>
  setPendingShareRoute?(options: { tokens: string[]; route?: SharedImportRoute }): Promise<void>
  downloadDiscordAttachment(options: { token: string }): Promise<void>
  stageCloudResource(options: {
    id: string
    libraryId: string
    workerUrl: string
    url: string
    automaticAutoBinding?: boolean
  }): Promise<{ token: string }>
  readCloudResource(options: { id: string; libraryId: string; workerUrl: string }): Promise<{
    active?: boolean
    cancelled?: boolean
    error?: string
    nativeImportOutcome?: {
      state?: string
      message?: string
      resourceId?: string
      name?: string
      automaticBindingPending?: boolean
      notificationPosted?: boolean
      cloudAckPending?: boolean
    }
    transferredBytes: number
    totalBytes?: number
    file?: NativeSharedFile
  }>
  cancelCloudResource?(options: { id: string; libraryId: string; workerUrl: string }): Promise<void>
}

const shareReceiver = registerPlugin<ShareReceiverPlugin>('ShareReceiver')
type NativeShareSnapshot = Awaited<ReturnType<ShareReceiverPlugin['getPendingShare']>>

// 原件保留到导入提交成功，但同一 WebView 会话只投递一次。
// Android 的 ready / 回前台事件不是新分享；进程重建后集合自然清空。
const deliveredNativeTokens = new Set<string>()
let nativeIntakeOperation: Promise<unknown> = Promise.resolve()
function runNativeIntakeOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = nativeIntakeOperation.then(operation, operation)
  nativeIntakeOperation = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

export interface NativeIntakeFile {
  token: string
  name: string
  state: string
  bytes: number
  modifiedAt: number
  fileCount: number
  snapshot: string
  protectedReason: string
  receiptOnly?: boolean
}

export interface NativeReceiptCleanupResult {
  removedTokens: string[]
  removedBytes: number
  skipped: Array<{ token: string; message: string }>
}

export async function removeNativeIntakeReceipts(
  entries: NativeIntakeFile[],
  control: {
    signal: AbortSignal
    beforeBatch(): Promise<void>
    progress(completed: number, result: NativeReceiptCleanupResult): void
  },
): Promise<NativeReceiptCleanupResult> {
  const selected = entries.filter((entry) => entry.receiptOnly && !entry.protectedReason)
  const result: NativeReceiptCleanupResult = { removedTokens: [], removedBytes: 0, skipped: [] }
  for (let index = 0; index < selected.length; index += 64) {
    await control.beforeBatch()
    if (control.signal.aborted) break
    const batch = selected.slice(index, index + 64)
    const next = await runNativeIntakeOperation(async () => {
      if (control.signal.aborted) return { removedTokens: [], removedBytes: 0, skipped: [] }
      if (!Capacitor.isNativePlatform()) throw new Error('接收回执清理仅支持 Android APK')
      const available = batch.filter((entry) => !intakeSessionOwns(entry.token))
      const skipped = batch
        .filter((entry) => intakeSessionOwns(entry.token))
        .map((entry) => ({ token: entry.token, message: '导入面板正在使用，保留' }))
      const cleared = available.length
        ? await shareReceiver.removeIntakeReceipts({
            items: available.map(({ token, snapshot }) => ({ token, snapshot })),
          })
        : { removedTokens: [], removedBytes: 0, skipped: [] }
      for (const token of cleared.removedTokens) {
        if (!available.some((entry) => entry.token === token))
          throw new Error('回执清理结果身份不匹配')
        saveStoredRoute(token)
        clearStoredImportAttempt(token)
      }
      return { ...cleared, skipped: [...skipped, ...cleared.skipped] }
    })
    result.removedTokens.push(...next.removedTokens)
    result.removedBytes += next.removedBytes
    result.skipped.push(...next.skipped)
    control.progress(Math.min(index + batch.length, selected.length), result)
  }
  return result
}

function intakeSessionOwns(token: string): boolean {
  return deliveredNativeTokens.has(token) || deliveredNativeTokens.has(`${token}-0`)
}

export async function listNativeIntakeFiles(): Promise<NativeIntakeFile[]> {
  if (!Capacitor.isNativePlatform()) throw new Error('接收暂存列表仅支持 Android APK')
  try {
    const { entries } = await shareReceiver.listIntakeFiles()
    return entries.map((entry) => ({
      ...entry,
      protectedReason:
        entry.protectedReason ||
        (intakeSessionOwns(entry.token) ? '导入面板正在使用，请先完成或取消该导入' : ''),
    }))
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'UNIMPLEMENTED'
    )
      throw new Error('当前 APK 尚不支持逐项查看接收暂存，请安装包含此功能的新版 APK', {
        cause: error,
      })
    throw error
  }
}

export function removeNativeIntakeFile(entry: NativeIntakeFile): Promise<number> {
  return runNativeIntakeOperation(async () => {
    if (!Capacitor.isNativePlatform()) throw new Error('接收暂存清理仅支持 Android APK')
    if (intakeSessionOwns(entry.token)) throw new Error('导入面板正在使用，请先完成或取消该导入')
    if (entry.protectedReason) throw new Error(entry.protectedReason)
    const { removedBytes } = await shareReceiver.removeIntakeFile({
      token: entry.token,
      snapshot: entry.snapshot,
    })
    for (const token of [entry.token, `${entry.token}-0`]) {
      saveStoredRoute(token)
      clearStoredImportAttempt(token)
    }
    return removedBytes
  })
}

export interface SharedFileBatch {
  /** The receiver's task continues through parsing/import; do not create a second task. */
  taskOperationId?: string
  /** True only for resources received from the paired Discord cloud inbox. */
  automaticCloud?: boolean
  /** The cloud intake settles one logical batch after every attachment/decision completes. */
  deferAutomaticBinding?: boolean
  onItemComplete?(result: ImportResult): Promise<void>
  onVersionResolved?(committedHash?: string, resourceId?: string): Promise<void>
  onFailure?(message: string): Promise<void>
  /** Cancel the remote owner when an interrupted cloud import is explicitly discarded. */
  onCancel?(): Promise<void>
  files: File[]
  route?: SharedImportRoute
  routeWasPersisted?: boolean
  /** A prior import was interrupted; ask before replaying it after app restart. */
  interrupted?: boolean
  /** Content hashes committed by an earlier run of this same retained share. */
  completedContentHashes?: string[]
  completedImportAliases?: Record<string, string>
  /** Stable identity used to retain staged source files until follow-up decisions finish. */
  recoveryId?: string
  nativeShareTokens?: string[]
  discordAttachment?: NativeDiscordAttachmentShare
  setRoute?(route?: SharedImportRoute): Promise<void>
  markImportStarted?(): Promise<void>
  markImportItemCompleted?(contentHash: string, sourceContentHash?: string): Promise<void>
  acknowledge(): Promise<void>
}

export type SharedImportRoute = 'libraryBackup' | 'tavernBackup' | 'resource' | 'thirdPartyApp'

export function shouldAutoResumeSharedImport(
  batch: Pick<SharedFileBatch, 'route' | 'interrupted'>,
): batch is Pick<SharedFileBatch, 'route' | 'interrupted'> & { route: SharedImportRoute } {
  return Boolean(batch.route) && !batch.interrupted
}

export function shouldShowSharedImportRouteChoices(batch: Pick<SharedFileBatch, 'route'>): boolean {
  return !batch.route
}

function isSharedImportRoute(value: unknown): value is SharedImportRoute {
  return (
    value === 'libraryBackup' ||
    value === 'tavernBackup' ||
    value === 'resource' ||
    value === 'thirdPartyApp'
  )
}

function storedRoute(token: string): SharedImportRoute | undefined {
  const key = `${PENDING_ROUTE_PREFIX}${token}`
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? 'null') as {
      route?: unknown
      savedAt?: unknown
    } | null
    if (
      !saved ||
      !isSharedImportRoute(saved.route) ||
      typeof saved.savedAt !== 'number' ||
      Date.now() - saved.savedAt > PENDING_ROUTE_MAX_AGE_MS
    ) {
      localStorage.removeItem(key)
      return undefined
    }
    return saved.route
  } catch {
    return undefined
  }
}

function saveStoredRoute(token: string, route?: SharedImportRoute): void {
  const key = `${PENDING_ROUTE_PREFIX}${token}`
  if (!route) {
    try {
      localStorage.removeItem(key)
    } catch {
      // A removed/expired share cannot be misrouted by a leftover token entry.
    }
    return
  }
  localStorage.setItem(key, JSON.stringify({ route, savedAt: Date.now() }))
}

interface StoredImportAttempt {
  startedAt?: number
}

function readStoredImportAttempt(token: string): StoredImportAttempt | undefined {
  const key = `${PENDING_IMPORT_PREFIX}${token}`
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? 'null') as {
      startedAt?: unknown
    } | null
    if (!saved || typeof saved !== 'object') return undefined
    return {
      ...(typeof saved.startedAt === 'number' ? { startedAt: saved.startedAt } : {}),
    }
  } catch {
    return undefined
  }
}

function readStoredCompletedImportHashes(token: string): string[] {
  const prefix = `${PENDING_IMPORT_ITEM_PREFIX}${token}.`
  const hashes = new Set<string>()
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (!key?.startsWith(prefix)) continue
      const hash = key.slice(prefix.length)
      if (/^[a-f\d]{64}$/iu.test(hash)) hashes.add(hash.toLowerCase())
    }
  } catch {
    // Checkpoint reads are best-effort; resource storage remains authoritative.
  }
  return [...hashes]
}

function hasInterruptedImport(token: string): boolean {
  const key = `${PENDING_IMPORT_PREFIX}${token}`
  try {
    const saved = readStoredImportAttempt(token)
    if (
      typeof saved?.startedAt === 'number' &&
      Date.now() - saved.startedAt <= PENDING_ROUTE_MAX_AGE_MS
    )
      return true
    localStorage.removeItem(key)
  } catch {
    return false
  }
  return false
}

function markStoredImportStarted(token: string): void {
  const key = `${PENDING_IMPORT_PREFIX}${token}`
  const saved = readStoredImportAttempt(token)
  localStorage.setItem(key, JSON.stringify({ ...saved, startedAt: saved?.startedAt ?? Date.now() }))
}

function markStoredImportItemCompleted(token: string, contentHash: string): void {
  localStorage.setItem(`${PENDING_IMPORT_ITEM_PREFIX}${token}.${contentHash.toLowerCase()}`, '1')
}

function readStoredImportAliases(token: string): Record<string, string> {
  const prefix = `${PENDING_IMPORT_ITEM_PREFIX}${token}.`
  const aliases: Record<string, string> = {}
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (!key?.startsWith(prefix)) continue
      const sourceHash = key.slice(prefix.length)
      const committedHash = localStorage.getItem(key) ?? ''
      if (/^[a-f\d]{64}$/iu.test(sourceHash) && /^[a-f\d]{64}$/iu.test(committedHash))
        aliases[sourceHash.toLowerCase()] = committedHash.toLowerCase()
    }
  } catch {
    // A resume still verifies the matching resource in authoritative storage.
  }
  return aliases
}

export function markSharedImportItemCompleted(
  recoveryId: string,
  contentHash: string,
  sourceContentHash?: string,
): void {
  if (!/^[a-f\d]{64}$/iu.test(contentHash)) throw new Error('导入检查点校验值无效')
  markStoredImportItemCompleted(recoveryId, contentHash)
  if (
    sourceContentHash &&
    /^[a-f\d]{64}$/iu.test(sourceContentHash) &&
    sourceContentHash !== contentHash
  )
    localStorage.setItem(
      `${PENDING_IMPORT_ITEM_PREFIX}${recoveryId}.${sourceContentHash.toLowerCase()}`,
      contentHash.toLowerCase(),
    )
}

function clearStoredImportAttempt(token: string): void {
  try {
    localStorage.removeItem(`${PENDING_IMPORT_PREFIX}${token}`)
    const itemPrefix = `${PENDING_IMPORT_ITEM_PREFIX}${token}.`
    const itemKeys: string[] = []
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key?.startsWith(itemPrefix)) itemKeys.push(key)
    }
    for (const key of itemKeys) localStorage.removeItem(key)
  } catch {
    // Native acknowledgement remains authoritative when WebView storage is unavailable.
  }
}

function base64File(shared: NativeSharedFile & { data: string }): File {
  const binary = atob(shared.data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new File([bytes], shared.name || 'shared-file', {
    type: shared.type || 'application/octet-stream',
  })
}

async function takeNativeSharedFiles(snapshot?: NativeShareSnapshot): Promise<SharedFileBatch> {
  return runNativeIntakeOperation(() => takeNativeSharedFilesNow(snapshot))
}

async function takeNativeSharedFilesNow(snapshot?: NativeShareSnapshot): Promise<SharedFileBatch> {
  if (!Capacitor.isNativePlatform()) return { files: [], acknowledge: async () => undefined }
  const result = snapshot ?? (await shareReceiver.getPendingShare())
  const pendingDiscordUrl = result.discordUrls?.find(
    (attachment) => !deliveredNativeTokens.has(attachment.cleanupToken),
  )
  // Keep URL and file shares in separate confirmation batches so cancelling a
  // URL can never acknowledge an unrelated file that was already pending.
  const pending = pendingDiscordUrl
    ? []
    : (result.files ?? []).filter(
        (shared) => !shared.cleanupToken || !deliveredNativeTokens.has(shared.cleanupToken),
      )
  const files: File[] = []
  const nativeParsedResults: Array<NativeSharedFile['nativeCharacterCardResult'] | undefined> = []
  const cleanupTokens: string[] = pendingDiscordUrl ? [pendingDiscordUrl.cleanupToken] : []
  for (const shared of pending) {
    if (shared.uri) {
      if (
        shared.route === 'libraryBackup' ||
        shared.route === 'tavernBackup' ||
        shared.route === 'resource' ||
        shared.route === undefined
      ) {
        // ZIP routes keep Android's staged file as the byte owner. NativeArchive
        // lists the central directory and inflates only selected entries. The
        // generic chooser materializes only when the selected parser needs bytes.
        files.push(
          rememberNativeFile(
            new File([], shared.name || 'shared-file', {
              type: shared.type || 'application/octet-stream',
            }),
            shared.uri,
            shared.size,
          ),
        )
        nativeParsedResults.push(shared.nativeCharacterCardResult)
      } else {
        // Third-party app import needs a regular File until it has a native source API.
        const response = await fetch(Capacitor.convertFileSrc(shared.uri), { cache: 'no-store' })
        if (!response.ok) throw new Error(`读取系统分享暂存文件失败（HTTP ${response.status}）`)
        const blob = await response.blob()
        files.push(
          rememberNativeFile(
            new File([blob], shared.name || 'shared-file', {
              type: shared.type || blob.type || 'application/octet-stream',
            }),
            shared.uri,
            shared.size ?? blob.size,
          ),
        )
        nativeParsedResults.push(shared.nativeCharacterCardResult)
      }
    } else if (typeof shared.data === 'string') {
      files.push(base64File(shared as NativeSharedFile & { data: string }))
      nativeParsedResults.push(shared.nativeCharacterCardResult)
    } else continue
    if (shared.cleanupToken) cleanupTokens.push(shared.cleanupToken)
  }
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]!
    const nativeResult = nativeParsedResults[index]
    if (
      !nativeResult ||
      !['parsed', 'parsed_index_unavailable'].includes(nativeResult.state ?? '') ||
      !nativeResult.parsedResourceUri
    )
      continue
    try {
      const response = await fetch(Capacitor.convertFileSrc(nativeResult.parsedResourceUri), {
        cache: 'no-store',
      })
      if (!response.ok) continue
      const parsed = (await response.json()) as ParsedResource
      if (
        parsed.type !== 'characterCard' ||
        !parsed.metadata ||
        typeof parsed.metadata !== 'object' ||
        !parsed.metadata.card ||
        typeof parsed.metadata.card !== 'object'
      ) {
        continue
      }
      setNativePreparedImport(file, {
        parsed,
      })
    } catch {
      // The original staged file remains authoritative; unreadable parse sidecars use the safe parser.
    }
  }
  for (const token of cleanupTokens) deliveredNativeTokens.add(token)
  const interrupted = cleanupTokens.some(hasInterruptedImport)
  const checkpointToken = [...cleanupTokens].sort()[0]
  const completedContentHashes = checkpointToken
    ? readStoredCompletedImportHashes(checkpointToken)
    : []
  const completedContentHashSet = new Set(completedContentHashes)
  const completedImportAliases = checkpointToken ? readStoredImportAliases(checkpointToken) : {}
  const routedFile = pending
    .map((shared) => {
      const platformRoute = isSharedImportRoute(shared.route) ? shared.route : undefined
      const rememberedRoute =
        !platformRoute && shared.cleanupToken ? storedRoute(shared.cleanupToken) : undefined
      return {
        route: platformRoute ?? rememberedRoute,
        routeWasPersisted: Boolean(platformRoute || rememberedRoute),
      }
    })
    .find((candidate) => candidate.route)
  return {
    files,
    route: routedFile?.route,
    routeWasPersisted: routedFile?.routeWasPersisted,
    interrupted,
    completedContentHashes,
    completedImportAliases,
    recoveryId: checkpointToken,
    nativeShareTokens: [
      ...new Set([
        ...cleanupTokens,
        ...pending
          .map((file) => file.discordSourceToken)
          .filter((token): token is string => Boolean(token)),
      ]),
    ],
    discordAttachment: pendingDiscordUrl,
    setRoute: async (route) => {
      let nativeRoutePersisted = false
      if (cleanupTokens.length && shareReceiver.setPendingShareRoute) {
        try {
          await shareReceiver.setPendingShareRoute({ tokens: cleanupTokens, route })
          nativeRoutePersisted = true
        } catch (error) {
          // Older APKs do not expose native route persistence; local storage remains
          // the compatibility path for those shells.
          if (
            typeof error !== 'object' ||
            error === null ||
            !('code' in error) ||
            error.code !== 'UNIMPLEMENTED'
          ) {
            throw error
          }
        }
      }
      for (const token of cleanupTokens) {
        try {
          saveStoredRoute(token, route)
        } catch {
          if (!nativeRoutePersisted) throw new Error('无法保存系统分享用途')
        }
      }
    },
    markImportStarted: async () => {
      for (const token of cleanupTokens) markStoredImportStarted(token)
    },
    markImportItemCompleted: async (contentHash, sourceContentHash) => {
      if (!checkpointToken) return
      const normalizedHash = contentHash.toLowerCase()
      markSharedImportItemCompleted(checkpointToken, normalizedHash, sourceContentHash)
      if (!completedContentHashSet.has(normalizedHash)) {
        completedContentHashSet.add(normalizedHash)
        completedContentHashes.push(normalizedHash)
      }
      if (sourceContentHash && sourceContentHash !== normalizedHash)
        completedImportAliases[sourceContentHash.toLowerCase()] = normalizedHash
    },
    acknowledge: async () => {
      if (cleanupTokens.length) {
        await shareReceiver.cleanupPendingShare({ tokens: cleanupTokens })
        for (const token of cleanupTokens) {
          deliveredNativeTokens.delete(token)
          saveStoredRoute(token)
          clearStoredImportAttempt(token)
        }
      }
    },
  }
}

export async function downloadSharedDiscordAttachment(
  attachment: NativeDiscordAttachmentShare,
): Promise<void> {
  if (!Capacitor.isNativePlatform()) throw new Error('Discord URL 直传仅支持 APK')
  await shareReceiver.downloadDiscordAttachment({ token: attachment.cleanupToken })
}

export function allowDiscordAttachmentRetry(token: string): void {
  deliveredNativeTokens.delete(token)
}

export function forgetCompletedDiscordAttachment(token: string): void {
  deliveredNativeTokens.delete(token)
}

export async function takeSharedFileBatch(): Promise<SharedFileBatch> {
  const nativeBatch = await takeNativeSharedFiles()
  if (nativeBatch.files.length || nativeBatch.discordAttachment) return nativeBatch
  return takeWebSharedFileBatch()
}

/** Drain one native snapshot into the existing confirmation queue with one bridge/directory read. */
export async function takeSharedFileBatches(
  onDownload?: (detail: { token: string; workId?: string; name?: string }) => void,
): Promise<SharedFileBatch[]> {
  if (Capacitor.isNativePlatform()) {
    const nativeBatches = await runNativeIntakeOperation(async () => {
      const received = await shareReceiver.getPendingShare()
      for (const detail of received.downloads ?? []) onDownload?.(detail)
      // Only the paired cloud intake may claim these files after a restart.
      const snapshot = {
        files: received.files.filter((file) => !file.cloudLibraryId),
        discordUrls: received.discordUrls?.filter((file) => !file.cloudLibraryId),
      }
      const batches: SharedFileBatch[] = []
      const urls = snapshot.discordUrls?.filter(
        (attachment) => !deliveredNativeTokens.has(attachment.cleanupToken),
      )
      if (urls?.length) {
        for (const attachment of urls) {
          const batch = await takeNativeSharedFilesNow({ files: [], discordUrls: [attachment] })
          if (batch.discordAttachment) batches.push(batch)
        }
        return batches
      }
      // A notification identifies one CDN share. Keep unrelated downloaded attachments
      // separate; ordinary multi-file system shares retain their existing batch semantics.
      const ordinary = snapshot.files.filter((file) => !file.discordSourceToken)
      const groups = new Map<string, NativeSharedFile[]>()
      for (const file of snapshot.files) {
        if (!file.discordSourceToken) continue
        const group = groups.get(file.discordSourceToken) ?? []
        group.push(file)
        groups.set(file.discordSourceToken, group)
      }
      for (const files of [ordinary, ...groups.values()]) {
        if (!files.length) continue
        const batch = await takeNativeSharedFilesNow({ files })
        if (batch.files.length) batches.push(batch)
      }
      return batches
    })
    if (nativeBatches.length) return nativeBatches
  }
  const batch = await takeWebSharedFileBatch()
  return batch.files.length ? [batch] : []
}

export async function stageCloudDiscordResource(options: {
  id: string
  libraryId: string
  workerUrl: string
  url: string
  automaticAutoBinding?: boolean
}): Promise<void> {
  try {
    await shareReceiver.stageCloudResource(options)
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'UNIMPLEMENTED'
    )
      throw new Error('当前 APK 尚不支持云端资源下载，请更新 APK；原来的直接分享仍可使用。', {
        cause: error,
      })
    throw error
  }
}

export async function cancelNativeCloudDiscordResource(options: {
  id: string
  libraryId: string
  workerUrl: string
}): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false
  if (!shareReceiver.cancelCloudResource) return false
  try {
    await shareReceiver.cancelCloudResource(options)
    return true
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'UNIMPLEMENTED'
    )
      return false
    throw error
  }
}

/** Web cloud files can be re-downloaded; retain only the existing hash/alias checkpoints. */
export function cloudWebResourceBatch(
  file: File,
  recoveryId: string,
  automaticCloud = true,
): SharedFileBatch {
  const completedContentHashes = readStoredCompletedImportHashes(recoveryId)
  const completedImportAliases = readStoredImportAliases(recoveryId)
  return {
    files: [file],
    automaticCloud,
    recoveryId,
    completedContentHashes,
    completedImportAliases,
    markImportStarted: async () => markStoredImportStarted(recoveryId),
    markImportItemCompleted: async (hash, sourceHash) => {
      markSharedImportItemCompleted(recoveryId, hash, sourceHash)
      if (!completedContentHashes.includes(hash)) completedContentHashes.push(hash)
      if (sourceHash && sourceHash !== hash) completedImportAliases[sourceHash] = hash
    },
    acknowledge: async () => clearStoredImportAttempt(recoveryId),
  }
}

export async function readCloudDiscordResource(options: {
  id: string
  libraryId: string
  workerUrl: string
}): Promise<{
  batch?: SharedFileBatch
  active?: boolean
  cancelled?: boolean
  error?: string
  nativeImportOutcome?: {
    state?: string
    message?: string
    resourceId?: string
    name?: string
    automaticBindingPending?: boolean
    notificationPosted?: boolean
    cloudAckPending?: boolean
  }
  transferredBytes: number
  totalBytes?: number
}> {
  return runNativeIntakeOperation(async () => {
    const state = await shareReceiver.readCloudResource(options)
    return {
      active: state.active,
      cancelled: state.cancelled,
      error: state.error,
      nativeImportOutcome: state.nativeImportOutcome,
      transferredBytes: state.transferredBytes,
      totalBytes: state.totalBytes,
      batch: state.file ? await takeNativeSharedFilesNow({ files: [state.file] }) : undefined,
    }
  })
}

/** Remove a committed native receipt after upstream acknowledgement or confirmed task expiry. */
export async function cleanupCompletedCloudDiscordResource(id: string): Promise<void> {
  if (!/^[a-f\d-]{36}$/iu.test(id)) throw new Error('资源下载任务身份无效')
  await shareReceiver.cleanupPendingShare({ tokens: [`discord-url-${id}`, `discord-url-${id}-0`] })
}

async function takeWebSharedFileBatch(): Promise<SharedFileBatch> {
  if (typeof caches === 'undefined') return { files: [], acknowledge: async () => undefined }
  try {
    const cacheNames = await caches.keys()
    if (!cacheNames.includes(INTAKE_CACHE)) return { files: [], acknowledge: async () => undefined }
    const cache = await caches.open(INTAKE_CACHE)
    const requestedIntakeId = new URLSearchParams(window.location.search).get('share-target')
    const intakeId = requestedIntakeId && requestedIntakeId !== 'received' ? requestedIntakeId : ''
    const prefix = intakeId ? `/srl-shared/${encodeURIComponent(intakeId)}` : '/srl-shared'
    const manifestKey = intakeId ? `${prefix}/manifest` : LEGACY_MANIFEST_KEY
    const manifestResponse = await cache.match(manifestKey)
    if (!manifestResponse) {
      return { files: [], acknowledge: async () => undefined }
    }
    const manifestPayload = (await manifestResponse.json().catch(() => [])) as
      SharedFileMeta[] | { files?: SharedFileMeta[] }
    const manifest = Array.isArray(manifestPayload)
      ? manifestPayload
      : (manifestPayload.files ?? [])
    const files: File[] = []
    const consumedKeys = [manifestKey]
    for (let index = 0; index < manifest.length; index += 1) {
      const key = `${prefix}/${index}`
      const response = await cache.match(key)
      if (!response) continue
      consumedKeys.push(key)
      const blob = await response.blob()
      files.push(
        new File([blob], manifest[index]?.name || `分享文件-${index + 1}`, {
          type: manifest[index]?.type || blob.type,
        }),
      )
    }
    return {
      files,
      acknowledge: async () => {
        await Promise.all(consumedKeys.map((key) => cache.delete(key)))
      },
    }
  } catch {
    return { files: [], acknowledge: async () => undefined }
  }
}

/** 兼容旧调用：读取后立即确认；主应用使用批次 API，在数据库导入完成后才确认。 */
export async function takeSharedFiles(): Promise<File[]> {
  const batch = await takeSharedFileBatch()
  await batch.acknowledge()
  return batch.files
}

/** 清掉分享跳转带来的查询参数，避免刷新时误判为再次分享。 */
export function clearShareTargetQuery(): void {
  if (!new URLSearchParams(window.location.search).has('share-target')) return
  window.history.replaceState(null, '', window.location.pathname)
}
