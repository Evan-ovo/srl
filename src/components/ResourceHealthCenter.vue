<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import StorageUsageChart, { type StorageUsageSlice } from './StorageUsageChart.vue'
import NativeIntakeFiles from './NativeIntakeFiles.vue'

import { BUILD_INFO } from '../core/BuildInfo'
import { domainEvents } from '../core/DomainEvents'
import { healthCenter, type HealthIssue } from '../core/HealthCenter'
import { noticeCenter } from '../core/NoticeCenter'
import { confirmAction } from '../composables/UseConfirmDialog'
import { getPlatformInfo } from '../core/PlatformService'
import { isSafeModeActive } from '../core/SafeStartup'
import { taskCenter } from '../core/TaskCenter'
import {
  browserStorageService,
  communitySourceService,
  nativeResourceRecoveryService,
} from '../core/AppContainer'
import { RESOURCE_TYPE_LABELS } from '../types/Resource'
import type {
  NativeRecoveryPreview,
  NativeRecoveryReport,
} from '../services/NativeResourceRecoveryService'
import {
  clearNativeTemporaryCaches,
  getNativeResourceStorageInfo,
  type NativeRecoveryCandidate,
} from '../storage/NativeResourceFileMirror'

const emit = defineEmits<{ 'library-changed': [] }>()
const storageLabels: Record<string, string> = {
  'srl-app-data': '原生数据库附件',
  'official-apps': '内置 APP 程序文件',
  'srl-shared-intake': '接收暂存（可能含历史残留）',
  'srl-cloud-jobs': '云传输暂存',
  'srl-export-jobs': '导出暂存',
  'srl-archive-jobs': '导入暂存',
  'srl-archive-tasks': '归档任务暂存',
  'srl-character-card-parser': '角色卡解析暂存',
  other: '其他内部文件',
  resources: '当前资源',
  resourceVersions: '历史版本',
  resourceSummaries: '资源摘要',
  resourceListSummaries: '列表摘要',
  resourceVersionSummaries: '历史摘要',
  categories: '分类',
  settings: '设置',
  backupRecords: '回收站与恢复副本',
  externalApps: 'APP 安装记录',
  externalAppRuntimes: 'APP 程序',
  externalAppData: 'APP 使用数据（含读了么、收藏柜）',
  externalAppDrafts: 'APP 草稿',
  frontendWorkshopProjects: '前端了么项目',
  frontendWorkshopProjectLastGood: '前端了么项目恢复点',
  frontendWorkshopSourceDocuments: '前端了么源码',
  frontendWorkshopSourceDocumentLastGood: '前端了么源码恢复点',
  frontendWorkshopSourceComponents: '前端了么组件',
  generatedImages: '生成图片记录',
  generatedImageFiles: '生成图片文件',
  restoreStaging: '恢复暂存记录',
  restoreStagingChunks: '恢复分块',
  assets: '素材记录（含缩略图）',
  assetFiles: '素材文件（含缩略图）',
  communitySources: '资源来源',
  communitySourceMessages: '来源消息',
  resourceSourceBindings: '资源来源关联',
  cloudBackupJobs: '云备份任务',
  cloudBackupOrphans: '云备份待处理记录',
}
const issues = ref<HealthIssue[]>([])
const scanning = ref(false)
const repairing = ref(false)
const scanned = ref(false)
const scannedDeep = ref(false)
const summariesCompact = ref<boolean>()
let summaryStatusRevision = 0
for (const event of ['ResourceImported', 'ResourceUpdated', 'ResourceDeleted'] as const)
  onUnmounted(
    domainEvents.on(event, () => {
      summaryStatusRevision++
      summariesCompact.value = undefined
      accountingStale.value = true
    }),
  )
const nativeStorage = ref<Awaited<ReturnType<typeof getNativeResourceStorageInfo>>>(null)
const browserStorage = ref<Awaited<ReturnType<typeof browserStorageService.getHealth>>>()
const inspectionError = ref('')
const storageMeasuredAt = ref(0)
let storageRequest = 0
onUnmounted(
  domainEvents.on('NativeTemporaryCachesCleared', ({ storage, measuredAt }) => {
    // Reuse the completed measurement; do not reread originals or rerun the health audit.
    storageRequest++
    nativeStorage.value = storage
    storageMeasuredAt.value = storage ? measuredAt : 0
  }),
)
const recoveryCandidates = ref<Array<NativeRecoveryCandidate & Partial<NativeRecoveryPreview>>>([])
const accounting =
  ref<Awaited<ReturnType<typeof nativeResourceRecoveryService.storageAccounting>>>()
const mirrorDuplication =
  ref<Awaited<ReturnType<typeof nativeResourceRecoveryService.nativeMirrorDuplicationSummary>>>()
const recoveryScanBusy = ref(false)
const accountingStale = ref(false)
const recoveryScanned = ref(0)
const recoveryNextCursor = ref<string>()
const selectedRecoveryHashes = ref<string[]>([])
const recovering = ref(false)
const reclaimingMirrors = ref(false)
const clearingRetiredModels = ref(false)
const clearingAppCaches = ref(false)
const optimizingSummaries = ref(false)
const clearingPostMedia = ref(false)
const showingIntakeFiles = ref(false)
const intakeBusy = ref(false)
const postMedia = ref<{ count: number; bytes: number }>()
const postMediaError = ref('')
const cleanupBusy = computed(
  () =>
    optimizingSummaries.value ||
    clearingPostMedia.value ||
    intakeBusy.value ||
    reclaimingMirrors.value ||
    clearingRetiredModels.value ||
    clearingAppCaches.value ||
    recovering.value ||
    recoveryScanBusy.value,
)
const retiredModel = computed(() =>
  nativeStorage.value?.supportsRetiredTranslationModelCleanup
    ? nativeStorage.value.internalBreakdown?.noBackupBreakdown?.otherEntries?.find(
        (item) =>
          item.name === 'com.google.mlkit.translate.models' && item.directory && item.bytes > 0,
      )
    : undefined,
)
const summaryBytes = computed(() =>
  nativeStorage.value?.nativeDatabase?.stores
    .filter(
      (item) => item.store === 'resourceSummaries' || item.store === 'resourceVersionSummaries',
    )
    .reduce((total, item) => total + item.jsonBytes, 0),
)
const storageSlices = computed<StorageUsageSlice[]>(() => {
  const info = nativeStorage.value
  if (!info)
    return browserStorage.value?.usage
      ? [
          {
            id: 'browser',
            label: '浏览器本机存储',
            bytes: browserStorage.value.usage,
            color: 'var(--usage-color-originals, var(--color-accent))',
          },
        ]
      : []
  const groups = info.internalBreakdown?.fileGroups
  const values = [
    {
      id: 'originals',
      label: '资源原件与恢复目录',
      bytes: info.libraryBytes ?? info.objectBytes,
      color: 'var(--usage-color-originals, var(--color-accent))',
    },
    {
      id: 'database',
      label: '文字、设置与查询记录',
      bytes: info.internalBreakdown?.databaseBytes ?? info.nativeDatabase?.fileBytes ?? 0,
      color: 'var(--usage-color-database, var(--color-warning))',
    },
    {
      id: 'assets',
      label: '图片等素材文件',
      bytes: groups?.['srl-app-data'] ?? 0,
      color:
        'var(--usage-color-assets, color-mix(in srgb, var(--color-accent) 60%, var(--color-danger)))',
    },
    {
      id: 'apps',
      label: '内置 APP 程序',
      bytes: groups?.['official-apps'] ?? 0,
      color: 'var(--usage-color-apps, var(--color-danger))',
    },
    {
      id: 'intake',
      label: '接收暂存文件',
      bytes: groups?.['srl-shared-intake'] ?? 0,
      color: 'var(--usage-color-intake, var(--color-success))',
    },
    {
      id: 'webview',
      label: '网页容器',
      bytes: info.webViewBytes ?? 0,
      color:
        'var(--usage-color-webview, color-mix(in srgb, var(--color-accent) 70%, var(--color-surface-raised)))',
    },
    {
      id: 'cache',
      label: '临时缓存',
      bytes: info.cacheBytes ?? 0,
      color:
        'var(--usage-color-cache, color-mix(in srgb, var(--color-warning) 70%, var(--color-surface-raised)))',
    },
    {
      id: 'models',
      label: '旧翻译模型',
      bytes: retiredModel.value?.bytes ?? 0,
      color:
        'var(--usage-color-models, color-mix(in srgb, var(--color-danger) 65%, var(--color-accent)))',
    },
  ]
  const known = values.reduce((sum, item) => sum + item.bytes, 0)
  return [
    ...values,
    {
      id: 'other',
      label: '其他应用数据',
      bytes: Math.max(0, (info.totalBytes ?? known) - known),
      color: 'var(--usage-color-other, var(--color-ink-soft))',
    },
  ].filter((item) => item.bytes > 0)
})

async function showStoragePart(id: string): Promise<void> {
  const part = storageSlices.value.find((item) => item.id === id)
  if (!part) return
  const details: Record<string, { text: string; action?: () => Promise<void> }> = {
    originals: {
      text: `这里是导入资源的完整文件、历史版本的原件，以及找回或恢复所需的文件。它们不是缓存。\n\n${mirrorDuplication.value?.reclaimableBytes ? '已发现另一处存放的重复副本，可以先比较文件内容再释放副本；这里的原件会保留。' : '想减少这部分：到资源列表删除不需要的资源，确认不再需要恢复后再清空回收站。此处不会整批删除原件。'}`,
      action: mirrorDuplication.value?.reclaimableBytes ? reclaimNativeMirrors : undefined,
    },
    database: {
      text: '存放资源名字、标签、解析出的正文、版本记录和 APP 设置；其中查询记录可能重复存了一份正文。\n\n可以精简这份重复文字。完整角色卡、聊天内容、历史版本，以及读了么和收藏柜的使用数据会保留。',
      action: optimizeSummaries,
    },
    browser: {
      text: '这是浏览器报告的本站总占用，目前无法准确拆成互不重叠的文件分项。\n\n可以精简重复查询文字，保留完整资源、历史和 APP 数据。浏览器会自行回收空闲空间。',
      action: optimizeSummaries,
    },
    assets: {
      text: `这里包含封面小图、图库素材和下载到本机的帖子媒体。\n\n已下载的帖子媒体：${postMedia.value?.count ?? 0} 个，约 ${formatBytes(postMedia.value?.bytes ?? 0)}。清理仅处理帖子图片、音频和视频；正文和链接保留，其他内容共用的文件也保留。清理后这些帖子媒体需要联网查看，链接过期时可能无法重新下载。`,
      action: postMedia.value?.count ? clearPostMedia : undefined,
    },
    apps: {
      text: '这里是内置 APP 的程序文件，用来离线打开读了么、收藏柜等 APP，不是你的角色或收藏数据。\n\n删掉程序会影响离线打开 APP，因此这里保留它们。',
    },
    intake: {
      text: '这里保存分享、下载后的接收副本，可能有待导入文件、失败或已处理的残留。没有正在接收的任务，也可能仍有占用。\n\n可以查看名称、大小和状态，再逐项确认清理。正在传输、被导入面板或恢复任务使用的文件会保留。',
      action: async () => {
        showingIntakeFiles.value = true
      },
    },
    webview: {
      text: '这是 APK 的页面运行环境，包括页面自己的存储、网络缓存和临时文件。\n\n它不全是缓存，直接清空可能丢失页面设置或尚未迁移的数据，因此这里不会整批清空。',
    },
    cache: {
      text: '保存可重新生成的临时文件和程序运行缓存。\n\n可以清理；你的资源、角色、收藏和设置会保留。之后首次打开某些页面或 APP，可能需要多等一会儿。',
      action: clearAppCaches,
    },
    models: {
      text: '这是已停用的离线翻译功能下载的语言模型。\n\n可以删除，不影响当前资源库、读了么或收藏柜。',
      action: clearRetiredModels,
    },
    other: {
      text: '包含后台任务记录、应用偏好设置以及尚未单独归类的文件。用途尚未逐项确认，不能把它们都当成垃圾。\n\n详细数字可在下方“查看占用分项”中查看；此处保留这些文件。',
    },
  }
  const detail = details[id]
  if (!detail) return
  const confirmed = await confirmAction({
    title: `${part.label} · ${formatBytes(part.bytes)}`,
    message: detail.text,
    confirmLabel: detail.action ? '查看清理内容' : '知道了',
    cancelLabel: '关闭',
  })
  if (confirmed && detail.action) await detail.action()
}

async function clearAppCaches(): Promise<void> {
  if (
    cleanupBusy.value ||
    !(await confirmAction({
      title: '清理临时缓存',
      message:
        '会删除：APK 的临时文件和程序运行缓存。\n\n会保留：资源原件、角色内容、收藏、APP 使用数据、设置和网页容器。\n\n可能影响：首次重新打开部分页面或 APP 时，缓存需要重新生成，可能稍慢。',
      confirmLabel: '清理缓存',
      cancelLabel: '取消',
      danger: true,
    }))
  )
    return
  clearingAppCaches.value = true
  try {
    const bytes = await clearNativeTemporaryCaches()
    const storage = await getNativeResourceStorageInfo({ includeDetails: true })
    domainEvents.emit('NativeTemporaryCachesCleared', { storage, measuredAt: Date.now() })
    noticeCenter.push({ type: 'success', message: `已清理临时缓存 ${formatBytes(bytes)}。` })
  } catch (error) {
    noticeCenter.push({
      type: 'error',
      message: error instanceof Error ? error.message : '缓存清理失败',
    })
  } finally {
    clearingAppCaches.value = false
  }
}

function intakeFilesChanged(remainingBytes: number): void {
  // Only this directory was remeasured; keep the original timestamp for the other categories.
  const storage = nativeStorage.value
  const groups = storage?.internalBreakdown?.fileGroups
  if (!storage || !groups) return
  const delta = remainingBytes - (groups['srl-shared-intake'] ?? 0)
  groups['srl-shared-intake'] = remainingBytes
  if (storage.totalBytes !== undefined) storage.totalBytes += delta
  if (storage.internalBreakdown) storage.internalBreakdown.filesBytes += delta
  accountingStale.value = true
}
const recoveryCandidateByHash = computed(
  () => new Map(recoveryCandidates.value.map((item) => [item.contentHash, item])),
)

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)))
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`
}

async function scanNativeRecovery(reset = true, includeAccounting = false): Promise<void> {
  if (recoveryScanBusy.value) return
  recoveryScanBusy.value = true
  inspectionError.value = ''
  try {
    const cursor = reset ? undefined : recoveryNextCursor.value
    if (!reset && !cursor) return
    const request = ++storageRequest
    if (includeAccounting) postMediaError.value = ''
    const summaryRevision = summaryStatusRevision
    const [info, media, compact] = await Promise.all([
      getNativeResourceStorageInfo({ includeDetails: includeAccounting }),
      includeAccounting
        ? communitySourceService.downloadedMediaUsage().catch((error: unknown) => {
            postMediaError.value =
              error instanceof Error ? error.message : '帖子媒体统计失败，请解锁保险库后重新检查'
            return undefined
          })
        : Promise.resolve(postMedia.value),
      includeAccounting
        ? browserStorageService.getSummaryCompactionStatus().catch(() => undefined)
        : Promise.resolve(undefined),
    ])
    if (includeAccounting && summaryRevision === summaryStatusRevision)
      summariesCompact.value = compact
    if (includeAccounting) postMedia.value = media
    if (request === storageRequest) {
      nativeStorage.value = info
      storageMeasuredAt.value = info ? Date.now() : 0
    }
    if (!info) {
      // Web/PWA originals live in the browser database, not the Android object directory.
      browserStorage.value = await browserStorageService.getHealth()
      storageMeasuredAt.value = Date.now()
      if (includeAccounting) {
        accounting.value = await nativeResourceRecoveryService.storageAccounting()
        accountingStale.value = false
      }
      return
    }
    const page = await nativeResourceRecoveryService.listCandidates(cursor, 100)
    if (!page) throw new Error('Android 未提供原件检查结果，未修改或清理文件')
    const previews: typeof recoveryCandidates.value = []
    for (const candidate of page.candidates) {
      const preview = info.recoveryMetadataVersion
        ? await nativeResourceRecoveryService
            .preview(candidate)
            .catch(() => ({ name: '暂无法识别（保留原件）' }))
        : { name: '需要更新 APK 后识别原件' }
      previews.push({ ...candidate, ...preview })
    }
    recoveryCandidates.value = reset ? previews : [...recoveryCandidates.value, ...previews]
    if (reset) selectedRecoveryHashes.value = []
    recoveryScanned.value = page.scanned
    recoveryNextCursor.value = page.nextCursor
    if (includeAccounting) {
      ;[accounting.value, mirrorDuplication.value] = await Promise.all([
        nativeResourceRecoveryService.storageAccounting(),
        nativeResourceRecoveryService.nativeMirrorDuplicationSummary(),
      ])
      accountingStale.value = false
    }
  } catch (error) {
    inspectionError.value =
      error instanceof Error ? error.message : '原件检查失败，未修改或清理文件'
    noticeCenter.push({
      type: 'error',
      message: inspectionError.value,
    })
  } finally {
    recoveryScanBusy.value = false
  }
}

async function clearRetiredModels(): Promise<void> {
  if (clearingRetiredModels.value) return
  clearingRetiredModels.value = true
  try {
    if (
      !(await confirmAction({
        title: '删除已停用的离线翻译模型',
        message:
          '会删除：已停用的离线翻译功能下载的语言模型。\n\n会保留：资源原件、角色、图片素材、APP 使用数据和其他缓存。\n\n可能影响：旧离线翻译模型将不再保留；当前版本已停用此功能，不影响读了么和收藏柜。',
        confirmLabel: '删除旧模型',
        cancelLabel: '取消',
        danger: true,
      }))
    )
      return
    const clearedBytes = await clearNativeTemporaryCaches({ scope: 'retiredTranslationModels' })
    const storage = await getNativeResourceStorageInfo({ includeDetails: true })
    domainEvents.emit('NativeTemporaryCachesCleared', { storage, measuredAt: Date.now() })
    noticeCenter.push({
      type: 'success',
      message: `已删除旧翻译模型，释放 ${formatBytes(clearedBytes)}。`,
    })
  } catch (error) {
    noticeCenter.push({
      type: 'error',
      message: error instanceof Error ? error.message : '旧翻译模型清理失败，请重新检查占用',
    })
  } finally {
    clearingRetiredModels.value = false
  }
}

async function optimizeSummaries(): Promise<void> {
  if (
    cleanupBusy.value ||
    summariesCompact.value === true ||
    !(await confirmAction({
      title: '精简重复摘要',
      message:
        '会处理：查询记录里重复存的一份角色内容和列表文字，以及数据库留下的空闲空间。\n\n会保留：完整角色卡、聊天正文、资源原件、历史版本、收藏柜和读了么的使用数据。\n\n可能影响：处理期间操作可能稍慢，请暂时不要导入或编辑资源；完成后无需重新导入。',
      confirmLabel: '精简并回收',
      cancelLabel: '取消',
    }))
  )
    return
  optimizingSummaries.value = true
  try {
    const report = await browserStorageService.optimizeDerivedSummaries()
    summariesCompact.value = true
    accountingStale.value = true
    noticeCenter.push({
      type: 'success',
      message:
        report && 'alreadyCompact' in report
          ? '摘要已精简，无需重复重建或压缩数据库。'
          : report
            ? `摘要已精简，数据库释放 ${formatBytes(Math.max(0, report.beforeBytes - report.afterBytes))}。`
            : '摘要已精简；浏览器会自行回收数据库空间。',
    })
    // The successful maintenance receipt is enough; do not repeat recovery/media/accounting.
  } catch (error) {
    noticeCenter.push({
      type: 'error',
      message: error instanceof Error ? error.message : '摘要精简或空间回收失败，请重新检查占用',
    })
  } finally {
    optimizingSummaries.value = false
  }
}

async function clearPostMedia(): Promise<void> {
  if (
    cleanupBusy.value ||
    !postMedia.value?.count ||
    !(await confirmAction({
      title: '清理已下载的帖子媒体',
      message: `会处理：当前帖子及历史快照保存的图片、音频和视频，共 ${postMedia.value.count} 个文件，约 ${formatBytes(postMedia.value.bytes)}。只删除没有被封面、图库等其他内容共用的文件。\n\n会保留：完整正文、原始图片链接、角色卡和其他资源。\n\n可能影响：清理后这些帖子媒体需要联网查看；Discord 链接过期时可能无法重新下载。请暂时不要导入或编辑资源。`,
      confirmLabel: '清理帖子媒体',
      cancelLabel: '取消',
      danger: true,
    }))
  )
    return
  clearingPostMedia.value = true
  try {
    const report = await communitySourceService.clearDownloadedMedia()
    noticeCenter.push({
      type: 'success',
      message: `已清理 ${report.count} 个独占媒体，约 ${formatBytes(report.bytes)}；保留 ${report.retainedCount} 个共用或用途未确认的文件。正文和链接已保留。`,
    })
    await scanNativeRecovery(true, true)
  } catch (error) {
    noticeCenter.push({
      type: 'error',
      message: error instanceof Error ? error.message : '帖子媒体清理失败，未提交修改',
    })
  } finally {
    clearingPostMedia.value = false
  }
}

async function reclaimNativeMirrors(): Promise<void> {
  const preview = mirrorDuplication.value
  if (!preview?.reclaimableBytes || reclaimingMirrors.value) return
  const confirmed = await confirmAction({
    title: '释放已验证的重复原件',
    message: `会删除：已经在另一处完整保存、且文件内容完全相同的重复原件副本。先逐项检查文件是否完好，再比较内容。\n\n会保留：本机原件、当前 ${preview.currentCount} 项与历史 ${preview.versionCount} 项资源记录、正文和使用数据。\n\n可能影响：不再保留第二份重复文件，资源仍可正常打开；预计减少 ${formatBytes(preview.reclaimableBytes)}，系统可能稍后才显示空间回落。`,
    confirmLabel: '校验并释放',
    cancelLabel: '取消',
    danger: true,
  })
  if (!confirmed) return
  reclaimingMirrors.value = true
  try {
    const report = await nativeResourceRecoveryService.reclaimVerifiedNativeMirrors()
    accountingStale.value = true
    noticeCenter.push({
      type: 'success',
      message: `已转为原生唯一副本：当前 ${report.convertedCurrent} 项，历史 ${report.convertedVersions} 项；释放 IndexedDB 镜像约 ${formatBytes(report.reclaimableBytes)}。`,
    })
    emit('library-changed')
    await scanNativeRecovery(true, true)
  } catch (error) {
    noticeCenter.push({
      type: 'error',
      message: error instanceof Error ? error.message : '镜像核验未通过，已保留所有网页副本',
    })
  } finally {
    reclaimingMirrors.value = false
  }
}

function reportRecovery(report: NativeRecoveryReport): void {
  accountingStale.value = true
  if (accounting.value) {
    accounting.value.recoveredPlaceholderCount = Math.max(
      0,
      accounting.value.recoveredPlaceholderCount - report.updated,
    )
    accounting.value.pendingNativeLinkCount = report.pendingLinks
  }
  noticeCenter.push({
    type: report.failed || report.pendingLinks ? 'warning' : 'success',
    message: `新增 ${report.created} 项，原位补全 ${report.updated} 项，已有 ${report.existing} 项；未识别保留 ${report.unsupported} 项，失败 ${report.failed} 项，待补写原生索引 ${report.pendingLinks} 项`,
  })
  if (report.created || report.updated) emit('library-changed')
}

async function repairRecovered(): Promise<void> {
  if (recovering.value) return
  recovering.value = true
  try {
    reportRecovery(await nativeResourceRecoveryService.repairExisting())
    await scanNativeRecovery(true)
  } catch (error) {
    noticeCenter.push({
      type: 'error',
      message: error instanceof Error ? error.message : '补全失败，原件仍保留',
    })
  } finally {
    recovering.value = false
  }
}

function toggleRecovery(hash: string): void {
  selectedRecoveryHashes.value = selectedRecoveryHashes.value.includes(hash)
    ? selectedRecoveryHashes.value.filter((item) => item !== hash)
    : [...selectedRecoveryHashes.value, hash]
}

async function recoverSelected(): Promise<void> {
  if (recovering.value || !selectedRecoveryHashes.value.length) return
  recovering.value = true
  try {
    const report = await nativeResourceRecoveryService.recover(
      selectedRecoveryHashes.value.flatMap((hash) => {
        const item = recoveryCandidateByHash.value.get(hash)
        return item
          ? [
              {
                contentHash: item.contentHash,
                size: item.size,
                nativeId: item.nativeId,
                nativeScope: item.nativeScope,
                fileName: item.fileName,
              },
            ]
          : []
      }),
    )
    reportRecovery(report)
    // Refresh only the native candidate page, not the full JSON/network/index/accounting audit.
    await scanNativeRecovery(true)
  } catch (error) {
    noticeCenter.push({
      type: 'error',
      message: error instanceof Error ? error.message : '找回失败，原件仍保留',
    })
  } finally {
    recovering.value = false
  }
}

async function scan(deep = false): Promise<void> {
  if (scanning.value) return
  scanning.value = true
  try {
    issues.value = await healthCenter.scan({ deep })
    scannedDeep.value = deep
    scanned.value = true
  } finally {
    scanning.value = false
  }
}

async function repairSafe(): Promise<void> {
  if (repairing.value) return
  repairing.value = true
  try {
    await healthCenter.repairSafe(issues.value)
    await scan(scannedDeep.value)
  } finally {
    repairing.value = false
  }
}

async function exportDiagnostics(): Promise<void> {
  const platform = await getPlatformInfo().catch(() => undefined)
  const storage = await navigator.storage?.estimate?.().catch(() => undefined)
  const native = await getNativeResourceStorageInfo({ includeDetails: true }).catch(() => null)
  const payload = {
    generatedAt: new Date().toISOString(),
    location: window.location.origin,
    build: BUILD_INFO,
    databaseSchemaVersion: BUILD_INFO.databaseVersion,
    nativeApiVersion: BUILD_INFO.nativeApiVersion,
    platform,
    storage: storage
      ? { usageBytes: storage.usage ?? null, quotaBytes: storage.quota ?? null }
      : undefined,
    nativeStorage: native,
    logicalPayloadAccounting: await nativeResourceRecoveryService.storageAccounting(),
    accountingNote:
      '数据库为逻辑载荷字节，不等于磁盘占用；原生分项为 totalBytes 的子集，不可相加。',
    nativeRecovery: {
      scannedCount: recoveryScanned.value,
      candidateCount: recoveryCandidates.value.length,
    },
    safeMode: isSafeModeActive(),
    tasks: taskCenter.list().map(({ name, phase, status, startedAt, updatedAt, error }) => ({
      name,
      phase,
      status,
      startedAt,
      updatedAt,
      hasError: Boolean(error),
    })),
    noticesByType: noticeCenter.list().reduce<Record<string, number>>((counts, notice) => {
      counts[notice.type] = (counts[notice.type] ?? 0) + 1
      return counts
    }, {}),
    issues: issues.value.map(({ id, kind, label, details, severity, safeRepair }) => ({
      id,
      kind,
      label,
      details,
      severity,
      safeRepairAvailable: Boolean(safeRepair),
    })),
  }
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
  )
  const link = document.createElement('a')
  link.href = url
  link.download = `srl-diagnostics-${new Date().toISOString().slice(0, 10)}.json`
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
</script>

<template>
  <div class="resource-health">
    <div class="resource-health__summary">
      <span>
        <strong>资源库健康与修复</strong>
        <small v-if="scanning">正在扫描引用、摘要与本地状态…</small>
        <small v-else-if="scanned && !issues.length">{{
          scannedDeep ? '本次完整检查未发现问题' : '索引与引用未发现问题'
        }}</small>
        <small v-else-if="issues.length">发现 {{ issues.length }} 项需要查看的问题</small>
        <small v-else>只报告问题，不会静默删除用户文件</small>
      </span>
      <button
        class="button button--quiet"
        type="button"
        :disabled="scanning || recovering || recoveryScanBusy"
        @click="scanNativeRecovery(true, true)"
      >
        {{ recoveryScanBusy ? '正在检查…' : '检查原件与空间' }}
      </button>
      <button
        class="button button--quiet"
        type="button"
        :disabled="scanning || recovering || recoveryScanBusy"
        @click="scan()"
      >
        扫描
      </button>
    </div>
    <small
      >检查原件与空间：盘点占用、寻找未关联原件。扫描：检查索引与引用，不解析所有原文件或联网检查。</small
    >
    <details>
      <summary>深度检查</summary>
      <p>逐项解析 JSON / 聊天原文件并检查外部链接，库越大或网络越慢，耗时越长。</p>
      <button
        class="button button--quiet"
        type="button"
        :disabled="scanning || recoveryScanBusy || cleanupBusy"
        @click="scan(true)"
      >
        检查文件与链接
      </button>
    </details>
    <p v-if="inspectionError" role="alert">{{ inspectionError }}</p>

    <section v-if="browserStorage && !nativeStorage" class="resource-health__native">
      <div class="resource-health__native-head">
        <span>
          <strong>网页本机存储</strong>
          <small v-if="browserStorage.supported && browserStorage.quota > 0">
            站点已用 {{ formatBytes(browserStorage.usage) }} · 浏览器配额
            {{ formatBytes(browserStorage.quota) }}（估算值）
          </small>
          <small v-else>当前浏览器未提供占用总量，仍可查看数据库载荷分项。</small>
          <small v-if="storageMeasuredAt">
            检查于 {{ new Date(storageMeasuredAt).toLocaleTimeString('zh-CN') }}，非实时值
          </small>
        </span>
      </div>
      <p class="resource-health__recovery-note">
        原件保存在当前浏览器数据库中；下方核对已登记载荷大小，不逐文件校验内容。Android
        孤立文件找回与镜像清理不适用于网页。
      </p>
    </section>

    <section v-if="nativeStorage" class="resource-health__native">
      <div class="resource-health__native-head">
        <span>
          <strong>Android 本地存储诊断</strong>
          <small>
            应用数据 {{ formatBytes(nativeStorage.totalBytes) }} · 原件对象
            {{ formatBytes(nativeStorage.objectBytes) }} · {{ nativeStorage.objectCount }} 个对象
          </small>
          <small v-if="storageMeasuredAt">
            占用统计于 {{ new Date(storageMeasuredAt).toLocaleTimeString('zh-CN') }}，非实时值
          </small>
        </span>
        <span v-if="recoveryScanned" class="resource-health__candidate-count">
          已扫描 {{ recoveryScanned }} 项
        </span>
      </div>
      <p v-if="recoveryCandidates.length" class="resource-health__recovery-note">
        候选可能是数据库崩溃后仍保留的 Android
        索引，也可能包含旧备份分块。只识别完整资源；未识别内容原地保留，不当作垃圾。
      </p>
      <div v-if="recoveryCandidates.length" class="resource-health__candidates">
        <label v-for="item in recoveryCandidates" :key="item.contentHash">
          <input
            type="checkbox"
            :checked="selectedRecoveryHashes.includes(item.contentHash)"
            @change="toggleRecovery(item.contentHash)"
          />
          <span>
            <strong>{{ item.name || item.contentHash.slice(0, 12) }}</strong>
            <small v-if="item.type">{{ RESOURCE_TYPE_LABELS[item.type] }}</small>
            <small>{{ formatBytes(item.size) }}</small>
          </span>
        </label>
      </div>
      <div v-if="recoveryCandidates.length || recoveryNextCursor" class="resource-health__actions">
        <button
          v-if="recoveryNextCursor"
          class="button button--quiet"
          type="button"
          :disabled="recovering || recoveryScanBusy"
          @click="scanNativeRecovery(false)"
        >
          继续扫描
        </button>
        <button
          class="button button--primary"
          type="button"
          :disabled="
            recovering ||
            recoveryScanBusy ||
            !nativeStorage.recoveryMetadataVersion ||
            !selectedRecoveryHashes.length
          "
          @click="recoverSelected"
        >
          {{ recovering ? '正在找回' : `找回所选（${selectedRecoveryHashes.length}）` }}
        </button>
      </div>
      <small v-else-if="recoveryScanned"
        >没有发现脱离当前与历史索引的 Android 对象；这不代表数据库已完整恢复。</small
      >
      <p v-if="!nativeStorage.recoveryMetadataVersion" class="resource-health__recovery-note">
        原件识别需要安装包含本次修复的新 APK，仅更新网页无效。
      </p>
      <div class="resource-health__actions">
        <button
          v-if="
            accounting &&
            (accounting.recoveredPlaceholderCount || accounting.pendingNativeLinkCount)
          "
          class="button button--quiet"
          type="button"
          :disabled="recovering || recoveryScanBusy || !nativeStorage.recoveryMetadataVersion"
          @click="repairRecovered"
        >
          补全以前找回的文件 / 重试索引
        </button>
        <button class="button button--quiet" type="button" @click="exportDiagnostics">
          导出只读占用报告
        </button>
      </div>
    </section>
    <StorageUsageChart
      v-if="accounting && storageSlices.length"
      :slices="storageSlices"
      :total-label="`本次盘点 ${formatBytes(storageSlices.reduce((sum, item) => sum + item.bytes, 0))}`"
      @select="showStoragePart"
    />
    <section v-if="accounting" class="resource-health__cleanup" aria-label="数据清理">
      <header><strong>数据清理</strong><small>只处理可精简或可确认的副本</small></header>
      <div v-if="nativeStorage" class="resource-health__cleanup-row">
        <span
          ><strong>接收暂存文件</strong><small>逐项查看与手动清理 · 使用中的文件保留</small></span
        >
        <button
          class="button button--quiet"
          type="button"
          :disabled="cleanupBusy"
          @click="showingIntakeFiles = !showingIntakeFiles"
        >
          {{ showingIntakeFiles ? '收起列表' : '查看文件' }}
        </button>
      </div>
      <NativeIntakeFiles
        v-if="showingIntakeFiles"
        :disabled="cleanupBusy && !intakeBusy"
        @busy="intakeBusy = $event"
        @changed="intakeFilesChanged"
        @close="showingIntakeFiles = false"
      />
      <div class="resource-health__cleanup-row">
        <span
          ><strong>查询摘要</strong
          ><small
            >{{
              summaryBytes === undefined
                ? '可精简重复文字'
                : `当前摘要文字 ${formatBytes(summaryBytes)}`
            }}
            · 保留完整资源与历史</small
          ></span
        >
        <button
          class="button button--quiet"
          type="button"
          :disabled="cleanupBusy || summariesCompact === true"
          @click="optimizeSummaries"
        >
          {{ optimizingSummaries ? '正在精简…' : summariesCompact ? '已精简' : '精简摘要' }}
        </button>
      </div>
      <div class="resource-health__cleanup-row">
        <span
          ><strong>帖子媒体</strong
          ><small
            >{{
              postMedia
                ? `${postMedia.count} 个文件 · ${formatBytes(postMedia.bytes)}`
                : postMediaError || '尚未统计'
            }}
            · 共用素材保留</small
          ></span
        >
        <button
          class="button button--quiet"
          type="button"
          :disabled="cleanupBusy || !postMedia?.count"
          @click="clearPostMedia"
        >
          {{ clearingPostMedia ? '正在清理…' : '清理帖子媒体' }}
        </button>
      </div>
      <div v-if="mirrorDuplication?.reclaimableBytes" class="resource-health__cleanup-row">
        <span
          ><strong>重复原件镜像</strong
          ><small
            >约 {{ formatBytes(mirrorDuplication.reclaimableBytes) }} ·
            校验后保留原生唯一副本</small
          ></span
        >
        <button
          class="button button--quiet"
          type="button"
          :disabled="cleanupBusy"
          @click="reclaimNativeMirrors"
        >
          {{ reclaimingMirrors ? '正在校验…' : '释放重复镜像' }}
        </button>
      </div>
      <div v-if="retiredModel" class="resource-health__cleanup-row">
        <span
          ><strong>停用的翻译模型</strong><small>{{ formatBytes(retiredModel.bytes) }}</small></span
        >
        <button
          class="button button--quiet"
          type="button"
          :disabled="cleanupBusy"
          @click="clearRetiredModels"
        >
          {{ clearingRetiredModels ? '正在删除旧模型' : '删除已停用翻译模型' }}
        </button>
      </div>
      <p>帖子媒体清理保留正文与链接。资源原件、历史版本和恢复副本不属于此处清理范围。</p>
    </section>
    <details v-if="accounting" class="resource-health__accounting">
      <summary>查看占用分项（不删除文件）</summary>
      <dl class="resource-health__sizes">
        <template v-if="nativeStorage">
          <dt>当前与历史的去重原件</dt>
          <dd>{{ formatBytes(nativeStorage.objectBytes) }}</dd>
          <dt>数据库文字、索引等</dt>
          <dd>
            {{
              formatBytes(
                nativeStorage.internalBreakdown?.databaseBytes ??
                  nativeStorage.nativeDatabase?.fileBytes ??
                  0,
              )
            }}
          </dd>
          <dt>素材等数据库附件</dt>
          <dd>{{ formatBytes(nativeStorage.internalBreakdown?.blobFilesBytes ?? 0) }}</dd>
          <dt>网页容器</dt>
          <dd>{{ formatBytes(nativeStorage.webViewBytes ?? 0) }}</dd>
          <template
            v-for="(bytes, name) in nativeStorage.internalBreakdown?.fileGroups"
            :key="name"
          >
            <template v-if="bytes && name !== 'srl-app-data'"
              ><dt>{{ storageLabels[name] ?? '其他内部文件' }}</dt>
              <dd>{{ formatBytes(bytes) }}</dd></template
            >
          </template>
        </template>
        <dt>素材库逻辑大小</dt>
        <dd>{{ formatBytes(accounting.assetBytes) }}</dd>
        <dt>其中缩略图</dt>
        <dd>{{ formatBytes(accounting.thumbnailAssetBytes) }}</dd>
        <dt>本地恢复副本逻辑大小</dt>
        <dd>{{ formatBytes(accounting.localSnapshotBytes) }}</dd>
      </dl>
      <small>分项可能有包含关系，不能直接相加。磁盘占用与运行内存不同。</small>
      <details class="resource-health__technical">
        <summary>技术明细与恢复信息</summary>
        <p v-if="accountingStale">资源已经变化；此处是上次盘点值，可用“检查原件与空间”刷新。</p>
        <p v-if="nativeStorage">以下原生分项是应用总量的子集，不能与总量相加。</p>
        <p v-if="nativeStorage && nativeStorage.webViewBytes !== undefined">
          网页容器 {{ formatBytes(nativeStorage.webViewBytes) }}；应用缓存
          {{ formatBytes(nativeStorage.cacheBytes ?? 0) }}
          <template v-if="nativeStorage.appCacheBytes !== undefined">
            （缓存目录 {{ formatBytes(nativeStorage.appCacheBytes) }}，代码缓存
            {{ formatBytes(nativeStorage.codeCacheBytes ?? 0) }}）
          </template>
          ；原生库
          {{ formatBytes(nativeStorage.libraryBytes ?? 0) }}（其中原件
          {{ formatBytes(nativeStorage.objectBytes) }}，恢复暂存
          {{ formatBytes(nativeStorage.restoreTemporaryBytes ?? 0) }}）。
        </p>
        <p v-if="nativeStorage?.webViewBreakdown">
          网页容器内：数据库与站点存储
          {{ formatBytes(nativeStorage.webViewBreakdown.siteDataBytes) }}；网络与代码缓存
          {{ formatBytes(nativeStorage.webViewBreakdown.cacheBytes) }}；临时 Blob
          {{ formatBytes(nativeStorage.webViewBreakdown.temporaryBlobBytes) }}；其他
          {{ formatBytes(nativeStorage.webViewBreakdown.otherBytes) }}。
          按目录分类，均包含在网页容器总量中；临时 Blob 不包含数据库保存的附件。
        </p>
        <p v-else-if="nativeStorage && nativeStorage.webViewBytes !== undefined">
          当前 APK 未提供网页容器内部明细，不能把这部分全部当作缓存。
        </p>
        <p v-if="nativeStorage">
          “清理缓存”仅清理 APK 临时缓存与代码缓存，不会清空网页容器。
          数据库空间与临时文件可能由系统延后回收；这些数字是磁盘占用，不是运行内存。
        </p>
        <template v-if="nativeStorage?.internalBreakdown">
          <p>
            内部文件 {{ formatBytes(nativeStorage.internalBreakdown.filesBytes) }}；数据库目录
            {{ formatBytes(nativeStorage.internalBreakdown.databaseBytes) }}；偏好设置
            {{
              formatBytes(nativeStorage.internalBreakdown.preferencesBytes)
            }}；不参与系统备份的数据
            {{ formatBytes(nativeStorage.internalBreakdown.noBackupBytes) }}；其他内部数据
            {{ formatBytes(nativeStorage.internalBreakdown.otherBytes) }}。
          </p>
          <p v-if="nativeStorage.internalBreakdown.noBackupBreakdown">
            其中后台任务数据库
            {{
              formatBytes(nativeStorage.internalBreakdown.noBackupBreakdown.databaseBytes)
            }}，写入日志
            {{ formatBytes(nativeStorage.internalBreakdown.noBackupBreakdown.walBytes) }}，共享索引
            {{ formatBytes(nativeStorage.internalBreakdown.noBackupBreakdown.shmBytes) }}，其他
            {{ formatBytes(nativeStorage.internalBreakdown.noBackupBreakdown.otherBytes) }}。
          </p>
          <p
            v-for="item in nativeStorage.internalBreakdown.noBackupBreakdown?.otherEntries"
            :key="item.name"
          >
            该目录其他{{ item.directory ? '目录' : '文件' }}：{{ item.name }}，
            {{ formatBytes(item.bytes) }}（已包含在上面的总量中）。
          </p>
          <details>
            <summary>内部文件明细（已包含在内部文件总量中）</summary>
            <template
              v-for="(bytes, name) in nativeStorage.internalBreakdown.fileGroups"
              :key="name"
            >
              <p v-if="bytes">{{ storageLabels[name] ?? '其他数据' }}：{{ formatBytes(bytes) }}</p>
            </template>
            <p>
              其中附件文件 {{ formatBytes(nativeStorage.internalBreakdown.blobFilesBytes) }}，
              未完成附件 {{ formatBytes(nativeStorage.internalBreakdown.pendingBlobFilesBytes) }}。
            </p>
          </details>
        </template>
        <details v-if="nativeStorage?.nativeDatabase">
          <summary>原生数据库明细（只读统计）</summary>
          <p>
            数据库文件 {{ formatBytes(nativeStorage.nativeDatabase.fileBytes) }}；写入日志
            {{ formatBytes(nativeStorage.nativeDatabase.walBytes) }}；共享索引
            {{ formatBytes(nativeStorage.nativeDatabase.shmBytes) }}。数据库逻辑页
            {{ formatBytes(nativeStorage.nativeDatabase.pageBytes) }}，其中可复用空闲页
            {{ formatBytes(nativeStorage.nativeDatabase.freePageBytes) }}（未压缩或删除）。
          </p>
          <p>
            已引用附件去重后
            {{ formatBytes(nativeStorage.nativeDatabase.uniqueReferencedBlobBytes) }}； 未完成附件
            {{ nativeStorage.nativeDatabase.pendingBlobCount }} 项。
          </p>
          <p v-for="item in nativeStorage.nativeDatabase.stores" :key="item.store">
            {{ storageLabels[item.store] ?? '其他数据' }}：{{ item.records }} 条，文字记录
            {{ formatBytes(item.jsonBytes) }}，附件引用 {{ formatBytes(item.blobReferenceBytes) }}。
          </p>
          <p>
            文字与附件引用是逻辑载荷；共享附件可能被多表引用，不能将这些数值与磁盘总量相加。
            统计期间写入会让各项略有变化，不读取或导出记录正文。
          </p>
        </details>
        <p v-if="nativeStorage?.nativeDatabaseUnavailable">
          本次未能读取原生数据库明细，不能将其视为零占用。
        </p>
        <p>
          数据库内原件载荷（不含原生文件引用）：当前原件
          {{ formatBytes(accounting.currentOriginalBytes) }}；历史原件
          {{ formatBytes(accounting.versionOriginalBytes) }}；本地恢复副本
          {{ formatBytes(accounting.localSnapshotBytes) }}；恢复暂存
          {{ formatBytes(accounting.restoreStagingBytes) }}。
        </p>
        <p v-if="accounting.nativeReferenceBytes">
          已关联原生原件的逻辑大小（当前与历史合计）
          {{ formatBytes(accounting.nativeReferenceBytes) }}。同一文件可能被多条记录引用，
          此数值不是去重后的磁盘占用，不能与原生库总量相加。
        </p>
        <p v-if="mirrorDuplication?.reclaimableBytes">
          已发现可校验的网页镜像：当前 {{ mirrorDuplication.currentCount }} 项、历史
          {{ mirrorDuplication.versionCount }} 项，预计可释放
          {{ formatBytes(mirrorDuplication.reclaimableBytes) }}。释放前会重新核验原生 SHA-256。
        </p>
        <p>
          素材库 {{ formatBytes(accounting.assetBytes) }} /
          {{ accounting.assetCount }} 项；其中缩略图
          {{ formatBytes(accounting.thumbnailAssetBytes) }} /
          {{ accounting.thumbnailAssetCount }} 项。
        </p>
        <p v-if="accounting.recoveredPlaceholderCount">
          旧版“找回文件”占位记录 {{ accounting.recoveredPlaceholderCount }} 项，对应原件引用约
          {{ formatBytes(accounting.recoveredPlaceholderBytes) }}。这是引用量，不与磁盘总量相加。
        </p>
        <p>
          逻辑载荷不等于磁盘文件大小，也不应与占用总量相加。旧本地恢复副本不会作为重复原件自动清理。
        </p>
      </details>
    </details>

    <div v-if="issues.length" class="resource-health__issues">
      <article v-for="issue in issues" :key="issue.id" :class="`is-${issue.severity}`">
        <strong>{{ issue.label }}</strong>
        <p>{{ issue.details }}</p>
        <small>{{ issue.safeRepair ? '可安全修复' : '需要查看后手动处理' }}</small>
      </article>
      <div class="resource-health__actions">
        <button
          class="button button--primary"
          type="button"
          :disabled="repairing || !issues.some((issue) => issue.safeRepair)"
          @click="repairSafe"
        >
          {{ repairing ? '正在修复' : '自动修复安全项' }}
        </button>
        <button class="button button--quiet" type="button" @click="exportDiagnostics">
          导出诊断
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.resource-health {
  display: grid;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  gap: 0.6rem;
  padding: 0.75rem;
  border: 1px solid var(--color-line);
  border-radius: 0.8rem;
  background: var(--color-surface);
}

.resource-health__summary,
.resource-health__actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.resource-health__summary span,
.resource-health__summary small {
  display: block;
}

.resource-health__summary small,
.resource-health__issues small {
  margin-top: 0.2rem;
  color: var(--color-ink-soft);
}

.resource-health__native {
  display: grid;
  gap: 0.55rem;
  padding-top: 0.6rem;
  border-top: 1px solid var(--color-line);
}

.resource-health__native-head {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 0.75rem;
  align-items: start;
}

.resource-health__native-head > span {
  min-width: 0;
}

.resource-health__native-head small,
.resource-health__candidate-count,
.resource-health__recovery-note {
  color: var(--color-ink-soft);
  font-size: 0.76rem;
}

.resource-health__native-head span > small {
  display: block;
  margin-top: 0.2rem;
}

.resource-health__recovery-note {
  margin: 0;
}

.resource-health__candidates {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
  gap: 0.35rem;
  max-height: 14rem;
  overflow: auto;
}

.resource-health__candidates label {
  display: flex;
  gap: 0.45rem;
  align-items: center;
  min-width: 0;
  padding: 0.45rem;
  border: 1px solid var(--color-line);
  border-radius: 0.55rem;
}

.resource-health__candidates span,
.resource-health__candidates small {
  display: block;
  min-width: 0;
}

.resource-health__summary,
.resource-health__actions {
  min-width: 0;
  flex-wrap: wrap;
}

.resource-health__summary > span {
  min-width: 0;
  flex: 1 1 12rem;
}

.resource-health__summary .button,
.resource-health__actions .button {
  min-width: 0;
  max-width: 100%;
  white-space: normal;
}

@media (max-width: 22rem) {
  .resource-health__summary {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }

  .resource-health__summary > span {
    grid-column: 1 / -1;
  }

  .resource-health__summary .button {
    width: 100%;
  }
}

.resource-health__candidates strong,
.resource-health__accounting {
  overflow-wrap: anywhere;
}

.resource-health__cleanup {
  border-top: 1px solid var(--color-line);
  padding-top: 0.75rem;
}
.resource-health__cleanup > header {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 0.75rem;
  align-items: baseline;
  margin-bottom: 0.5rem;
}
.resource-health__cleanup-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.65rem;
  padding: 0.65rem 0;
  border-bottom: 1px solid var(--color-line);
}
.resource-health__cleanup-row > span {
  min-width: 0;
}
.resource-health__cleanup-row strong,
.resource-health__cleanup-row small {
  display: block;
}
.resource-health__cleanup-row strong {
  font-size: 0.84rem;
}
.resource-health__cleanup small,
.resource-health__cleanup p {
  font-size: 0.76rem;
  line-height: 1.55;
  color: var(--color-ink-soft);
}
.resource-health__cleanup-row .button {
  flex-shrink: 0;
  min-height: 2.75rem;
}
.resource-health__sizes {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.6rem 0.75rem;
  margin: 0.85rem 0;
  align-items: baseline;
}
.resource-health__sizes dt {
  overflow-wrap: anywhere;
}
.resource-health__sizes dd {
  margin: 0;
  color: var(--color-ink);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.resource-health__technical {
  margin-top: 0.8rem;
  padding-top: 0.6rem;
  border-top: 1px solid var(--color-line);
}
@media (max-width: 22rem) {
  .resource-health__cleanup-row {
    flex-wrap: wrap;
  }
  .resource-health__cleanup-row .button {
    margin-left: auto;
  }
}

.resource-health__accounting {
  min-width: 0;
  color: var(--color-ink-soft);
  font-size: 0.8rem;
}

.resource-health__issues {
  display: grid;
  gap: 0.45rem;
}

.resource-health__issues article {
  padding: 0.6rem;
  border-left: 0.2rem solid var(--color-warning);
  background: var(--color-warning-soft);
}

.resource-health__issues article.is-error {
  border-left-color: var(--color-danger);
}

.resource-health__issues p {
  margin: 0.2rem 0 0;
  font-size: 0.78rem;
}

.resource-health__actions {
  justify-content: flex-end;
  flex-wrap: wrap;
}
</style>
