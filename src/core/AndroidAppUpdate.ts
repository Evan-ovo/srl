import { Capacitor, registerPlugin } from '@capacitor/core'

import { chooseAction } from '../composables/UseConfirmDialog'
// SRL-PUBLIC-SYNC: BEGIN REPLACE id=android-apk-release-provider
import { loadAndroidApkRelease } from './GitHubAndroidApkRelease'
// SRL-PUBLIC-SYNC: END REPLACE id=android-apk-release-provider
import { taskCenter } from './TaskCenter'
import {
  AUTOMATIC_APK_UPDATE_CHANGED,
  PROJECT_NOTICE_ACKNOWLEDGED_EVENT,
  getAutomaticApkUpdateChecks,
  hasAcknowledgedProjectNotice,
  hasAcknowledgedProjectNoticePersisted,
} from '../services/BrowserDevicePreferences'

const REMIND_LATER_MS = 24 * 60 * 60 * 1000
const AUTO_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000
const IGNORED_VERSION_KEY = 'srl.apk-update.ignored-version-code'
const REMIND_AFTER_KEY = 'srl.apk-update.remind-after'
const LAST_UPDATE_CHECK_KEY = 'srl.apk-update.last-check-at'

interface NativeApkUpdater {
  getCurrentVersion(): Promise<{ versionCode: number; versionName: string }>
  cancelDownload(options: { taskId: string }): Promise<{ status: string }>
  downloadAndInstall(options: {
    url: string
    sha256: string
    taskId: string
    sizeBytes?: number
  }): Promise<{ status: string }>
}

interface ApkUpdateManifest {
  versionCode: number
  versionName: string
  apkUrl: string
  sha256: string
  sizeBytes?: number
  notes?: string
  mandatory?: boolean
}

const apkUpdater = registerPlugin<NativeApkUpdater>('ApkUpdater')
let updateCheck: Promise<string> | undefined
let manualCheckRequested = false
let updateAbort: AbortController | undefined
let stopAutomaticChecks: (() => void) | undefined

export function isAndroidApk(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
}

function savedNumber(key: string): number | undefined {
  const value = Number(localStorage.getItem(key))
  return Number.isFinite(value) ? value : undefined
}

function hasValidManifest(value: unknown): value is ApkUpdateManifest {
  if (!value || typeof value !== 'object') return false
  const manifest = value as Partial<ApkUpdateManifest>
  return (
    Number.isInteger(manifest.versionCode) &&
    typeof manifest.versionName === 'string' &&
    typeof manifest.apkUrl === 'string' &&
    /^https:\/\//iu.test(manifest.apkUrl) &&
    typeof manifest.sha256 === 'string' &&
    /^[a-f0-9]{64}$/iu.test(manifest.sha256)
  )
}

function formatSize(sizeBytes: number | undefined): string {
  if (!sizeBytes || !Number.isFinite(sizeBytes) || sizeBytes <= 0) return ''
  return '（' + (sizeBytes / 1024 / 1024).toFixed(1) + ' MiB）'
}

function shouldSuppressAutomaticPrompt(versionCode: number): boolean {
  return (
    savedNumber(IGNORED_VERSION_KEY) === versionCode ||
    (savedNumber(REMIND_AFTER_KEY) ?? 0) > Date.now()
  )
}

async function promptForUpdate(release: ApkUpdateManifest): Promise<string> {
  const response = await chooseAction({
    title: '发现 APK 新版本',
    message:
      '可更新至 ' +
      release.versionName +
      ' ' +
      formatSize(release.sizeBytes) +
      '。\n' +
      (release.notes?.trim() || '本次更新包含稳定性与功能改进。') +
      '\n\n下载完成后将由 Android 系统确认安装。安装和数据迁移可能受手机系统与设备状态影响，建议更新前完成本地备份或云备份。',
    confirmLabel: '更新',
    cancelLabel: '稍后提醒',
    alternativeLabel: '不更新当前版本',
    danger: Boolean(release.mandatory),
  })
  if (response === 'cancel') {
    localStorage.setItem(REMIND_AFTER_KEY, String(Date.now() + REMIND_LATER_MS))
    return '已在 24 小时后再次提醒'
  }
  if (response === 'alternative') {
    localStorage.setItem(IGNORED_VERSION_KEY, String(release.versionCode))
    localStorage.removeItem(REMIND_AFTER_KEY)
    return '已不再提示 ' + release.versionName + '；后续更高版本仍会提示'
  }

  localStorage.removeItem(REMIND_AFTER_KEY)
  const taskId = crypto.randomUUID()
  let cancelled = false
  let stopRequest: Promise<{ status: string }> | undefined
  const download = apkUpdater.downloadAndInstall({
    url: release.apkUrl,
    sha256: release.sha256,
    taskId,
    sizeBytes: release.sizeBytes,
  })
  const operationId = taskCenter.start({
    name: 'APK 更新下载',
    phase: '正在下载并校验；可在任务中心停止',
    cancelable: true,
    cancel: async () => {
      taskCenter.update(operationId, { phase: '正在停止 APK 下载…' })
      const result = await (stopRequest ??= apkUpdater.cancelDownload({ taskId }))
      cancelled = result.status === 'cancelled'
      if (!cancelled) taskCenter.update(operationId, { phase: '安装交接已开始，等待系统确认' })
      await download.catch(() => undefined)
      if (!cancelled) taskCenter.complete(operationId)
    },
  })
  let result: { status: string }
  try {
    result = await download
    if (cancelled) {
      taskCenter.cancelled(operationId)
      return '已取消 APK 下载，未启动安装'
    }
    taskCenter.complete(operationId)
  } catch (error) {
    if (stopRequest)
      cancelled ||= (await stopRequest.catch(() => undefined))?.status === 'cancelled'
    if (cancelled) {
      taskCenter.cancelled(operationId)
      return '已取消 APK 下载，未启动安装'
    }
    taskCenter.fail(operationId, error)
    throw error
  }
  if (result.status === 'permission_required')
    return '请在系统设置中允许“安装未知应用”，然后再次点击“检查 APK 版本更新”'
  return 'APK 已校验完成，正在打开系统安装确认页'
}

/** APK 专属检查；网页端不会调用此路径或替代 Service Worker 更新。 */
export function checkForAndroidAppUpdate(manual = false): Promise<string> {
  if (!isAndroidApk()) return Promise.resolve('当前不是 Android APK')
  if (!manual && !getAutomaticApkUpdateChecks())
    return Promise.resolve('APK 自动检查已关闭，仍可手动检查')
  if (updateCheck) {
    if (updateAbort?.signal.aborted)
      return updateCheck.then(
        () => checkForAndroidAppUpdate(manual),
        () => checkForAndroidAppUpdate(manual),
      )
    manualCheckRequested ||= manual
    return updateCheck
  }
  const lastCheckAt = savedNumber(LAST_UPDATE_CHECK_KEY) ?? 0
  if (!manual && Date.now() - lastCheckAt < AUTO_CHECK_INTERVAL_MS)
    return Promise.resolve('当前 APK 自动检查暂不提示（12 小时限频中）')
  manualCheckRequested = manual
  updateCheck = runUpdateCheck().finally(() => {
    updateCheck = undefined
    updateAbort = undefined
  })
  return updateCheck
}

async function runUpdateCheck(): Promise<string> {
  if (!manualCheckRequested && !(await hasAcknowledgedProjectNoticePersisted()))
    return '请先阅读使用前说明'
  if (!manualCheckRequested && !getAutomaticApkUpdateChecks()) return 'APK 自动检查已关闭'
  const controller = new AbortController()
  updateAbort = controller
  localStorage.setItem(LAST_UPDATE_CHECK_KEY, String(Date.now()))
  let current: { versionCode: number; versionName: string }
  let result: Awaited<ReturnType<typeof loadAndroidApkRelease>>
  try {
    ;[current, result] = await Promise.all([
      apkUpdater.getCurrentVersion(),
      loadAndroidApkRelease(controller.signal),
    ])
  } catch (error) {
    if (controller.signal.aborted && !manualCheckRequested) {
      localStorage.removeItem(LAST_UPDATE_CHECK_KEY)
      return 'APK 自动检查已关闭'
    }
    throw error
  }
  if (controller.signal.aborted || (!manualCheckRequested && !getAutomaticApkUpdateChecks())) {
    localStorage.removeItem(LAST_UPDATE_CHECK_KEY)
    return 'APK 自动检查已关闭'
  }
  updateAbort = undefined
  if (result.status === 404) return 'APK 更新渠道尚未发布'
  if (result.status < 200 || result.status >= 300)
    return '检查更新失败（HTTP ' + result.status + '）'

  const value: unknown = result.release
  if (!hasValidManifest(value)) return '更新清单格式无效，已取消下载'
  if (value.versionCode <= current.versionCode)
    return '已是最新 APK 版本（' + current.versionName + '）'
  if (!manualCheckRequested && shouldSuppressAutomaticPrompt(value.versionCode))
    return '当前版本已选择暂不提示'
  return promptForUpdate(value)
}

/**
 * 仅在原生 APK 内安装自动检查：启动、回到前台和重新联网时检查。
 * 它不运行在网页端，因此不会影响网页 Service Worker 的既有检查周期。
 */
export function installAndroidAppUpdateChecks(): () => void {
  if (!isAndroidApk()) return () => undefined
  if (stopAutomaticChecks) return stopAutomaticChecks
  const check = () => void checkForAndroidAppUpdate().catch(() => undefined)
  const preferenceChanged = () => {
    if (!getAutomaticApkUpdateChecks()) {
      if (!manualCheckRequested) updateAbort?.abort()
    } else if (hasAcknowledgedProjectNotice()) check()
  }
  const startup = window.setTimeout(check, 3000)
  window.addEventListener('srl:native-active', check)
  window.addEventListener('online', check)
  window.addEventListener(PROJECT_NOTICE_ACKNOWLEDGED_EVENT, check)
  window.addEventListener(AUTOMATIC_APK_UPDATE_CHANGED, preferenceChanged)
  stopAutomaticChecks = () => {
    window.clearTimeout(startup)
    window.removeEventListener('srl:native-active', check)
    window.removeEventListener('online', check)
    window.removeEventListener(PROJECT_NOTICE_ACKNOWLEDGED_EVENT, check)
    window.removeEventListener(AUTOMATIC_APK_UPDATE_CHANGED, preferenceChanged)
    if (!manualCheckRequested) updateAbort?.abort()
    stopAutomaticChecks = undefined
  }
  return stopAutomaticChecks
}
