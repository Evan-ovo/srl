import { Capacitor } from '@capacitor/core'

import type { TavernConflictPolicy } from './TavernBridgeProtocol'

import type { UserPersonaTemplate } from '../types/UserPersona'

import type { PresetFavoriteSnapshot } from '../utils/PresetStitcher'

import {
  type PresetStitchTemplate,
  type PresetStitchDraft,
  type ProjectNoticeStoragePlugin,
  type TavernSendContent,
} from '../types/BrowserPreferences'

import * as operationsBrowserPreferenceNormalization from './BrowserPreferenceNormalization'

export interface BridgeTransferDraft {
  direction: 'pull' | 'send'
  origin: string
  policy: TavernConflictPolicy
  at: number
  items: Array<{
    key: string
    name: string
    label: string
    status: 'pending' | 'active' | 'done' | 'failed'
    detail: string
    operationId?: string
    content?: TavernSendContent
    syncCharacterTags?: boolean
    readingScriptIds?: string[]
    carryReadingScripts?: boolean
  }>
}

export const PROJECT_NOTICE_VERSION = '2026-09-21-v2'

export const PRESET_STITCH_DRAFT_KEY = 'srl.stitch.draft'

export const PRESET_STITCH_CHECKPOINT_KEY = 'srl.stitch.checkpoint'

export const PRESET_STITCH_RECENT_KEY = 'srl.stitch.recentPresets'

export const PRESET_STITCH_FAVORITES_KEY = 'srl.stitch.favoriteEntries'

export const PRESET_STITCH_TEMPLATES_KEY = 'srl.stitch.templates'

export const PRESET_STITCH_MAIN_SIDE_KEY = 'srl.stitch.mainSide'

export const FRONTEND_WORKSHOP_RECENT_COLORS_KEY = 'srl.frontendWorkshop.recentColors'

export const PROJECT_NOTICE_ACKNOWLEDGED_KEY = 'srl.projectNotice.acknowledgedVersion'

export const PROJECT_NOTICE_ACKNOWLEDGED_COOKIE = 'srl_project_notice'

export function getNativeProjectNoticeStorage(): ProjectNoticeStoragePlugin | undefined {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return undefined
  return (
    window as { Capacitor?: { Plugins?: { ProjectNoticeStorage?: ProjectNoticeStoragePlugin } } }
  ).Capacitor?.Plugins?.ProjectNoticeStorage
}

export const USER_PERSONA_TEMPLATES_KEY = 'srl.userPersona.templates'
export function exportStitchWork(): {
  draft?: PresetStitchDraft
  checkpoint?: PresetStitchDraft
  recentPresets?: string[]
} {
  return {
    draft: getPresetStitchDraft(),
    checkpoint: getPresetStitchCheckpoint(),
    recentPresets: getStitchRecentIds(),
  }
}

export function importStitchWork(value: {
  draft?: PresetStitchDraft
  checkpoint?: PresetStitchDraft
  recentPresets?: string[]
}): void {
  if (value.draft) setPresetStitchDraft(value.draft)
  if (value.checkpoint) setPresetStitchCheckpoint(value.checkpoint)
  if (value.recentPresets) {
    for (const id of value.recentPresets.slice().reverse()) pushStitchRecentId(id)
  }
}

export function getUserPersonaTemplates(): UserPersonaTemplate[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(USER_PERSONA_TEMPLATES_KEY) ?? '[]')
    return normalizeUserPersonaTemplates(parsed)
  } catch {
    return []
  }
}

export function setUserPersonaTemplates(value: UserPersonaTemplate[]): UserPersonaTemplate[] {
  const normalized = normalizeUserPersonaTemplates(value)
  try {
    localStorage.setItem(USER_PERSONA_TEMPLATES_KEY, JSON.stringify(normalized))
  } catch {
    // 自定义人设模板属于本机偏好，写入失败时不影响当前人设编辑。
  }
  return normalized
}

export function getBridgeTransferLog(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem('srl-bridge-transfer-log') || '[]')
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string').slice(0, 20)
      : []
  } catch {
    return []
  }
}

export function getTavernChatCarryScripts(): boolean {
  try {
    return localStorage.getItem('srl.tavern.chatCarryScripts') !== 'false'
  } catch {
    return true
  }
}
export function setTavernChatCarryScripts(enabled: boolean): void {
  try {
    localStorage.setItem('srl.tavern.chatCarryScripts', String(enabled))
  } catch {
    /* Keep this session's choice. */
  }
}

export function getTavernSendContent(): TavernSendContent {
  try {
    return localStorage.getItem('srl.tavern.sendContent') === 'original' ? 'original' : 'modified'
  } catch {
    return 'modified'
  }
}

export function getModifiedResourceSyncTags(): boolean {
  try {
    return localStorage.getItem('srl.modifiedResource.syncTags') === 'true'
  } catch {
    return false
  }
}

export function setModifiedResourceSyncTags(enabled: boolean): void {
  try {
    localStorage.setItem('srl.modifiedResource.syncTags', String(enabled === true))
  } catch {
    // An unavailable preference store must not prevent this session's transfer.
  }
}

export function setTavernSendContent(content: TavernSendContent): void {
  try {
    localStorage.setItem('srl.tavern.sendContent', content === 'original' ? 'original' : 'modified')
  } catch {
    // An unavailable preference store must not prevent this session's transfer.
  }
}

export function appendBridgeTransferLog(entries: string[]): string[] {
  const next = [...entries, ...getBridgeTransferLog()].slice(0, 20)
  try {
    localStorage.setItem('srl-bridge-transfer-log', JSON.stringify(next))
  } catch {
    // 报告属于非关键偏好，写入失败不影响传输。
  }
  return next
}

export function getBridgeTransferDraft(): BridgeTransferDraft | undefined {
  try {
    const value = JSON.parse(
      localStorage.getItem('srl-bridge-transfer-draft') || 'null',
    ) as BridgeTransferDraft | null
    if (
      !value ||
      !['pull', 'send'].includes(value.direction) ||
      typeof value.origin !== 'string' ||
      !['copy', 'skip', 'overwrite'].includes(value.policy) ||
      !Number.isFinite(value.at) ||
      Date.now() - value.at > 7 * 86400_000 ||
      !Array.isArray(value.items) ||
      value.items.length > 200
    )
      return
    if (
      value.items.some(
        (item) =>
          !item ||
          typeof item.key !== 'string' ||
          typeof item.name !== 'string' ||
          typeof item.label !== 'string' ||
          typeof item.detail !== 'string' ||
          !['pending', 'active', 'done', 'failed'].includes(item.status) ||
          (item.carryReadingScripts !== undefined &&
            typeof item.carryReadingScripts !== 'boolean') ||
          (item.content !== undefined && !['original', 'modified'].includes(item.content)) ||
          (item.readingScriptIds !== undefined &&
            (!Array.isArray(item.readingScriptIds) ||
              item.readingScriptIds.length > 8 ||
              item.readingScriptIds.some(
                (id) =>
                  typeof id !== 'string' ||
                  id.length > 512 ||
                  !/^(scriptGlobal|scriptPreset):.+$/.test(id),
              ))) ||
          (item.operationId !== undefined &&
            (typeof item.operationId !== 'string' || !/^[\w-]{16,80}$/.test(item.operationId))),
      )
    )
      return
    return value
  } catch {
    return
  }
}

export function setBridgeTransferDraft(value: BridgeTransferDraft): void {
  try {
    // Only task metadata: no files, endpoint credentials, pairing tokens or encryption keys.
    localStorage.setItem(
      'srl-bridge-transfer-draft',
      JSON.stringify({ ...value, items: value.items.slice(0, 200) }),
    )
  } catch {
    /* A disabled preference store must not prevent an otherwise valid transfer. */
  }
}

export function getPresetStitchDraft(): PresetStitchDraft | undefined {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PRESET_STITCH_DRAFT_KEY) || 'null')
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as PresetStitchDraft).baseId === 'string' &&
      Array.isArray((parsed as PresetStitchDraft).entries)
    ) {
      return parsed as PresetStitchDraft
    }
    return undefined
  } catch {
    return undefined
  }
}

export function setPresetStitchDraft(draft: PresetStitchDraft): void {
  try {
    localStorage.setItem(PRESET_STITCH_DRAFT_KEY, JSON.stringify(draft))
  } catch {
    // 草稿属于便利功能，写入失败不阻断缝合流程。
  }
}

export function clearPresetStitchDraft(): void {
  try {
    localStorage.removeItem(PRESET_STITCH_DRAFT_KEY)
  } catch {
    // 同上。
  }
}

export function getPresetStitchCheckpoint(): PresetStitchDraft | undefined {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PRESET_STITCH_CHECKPOINT_KEY) || 'null')
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as PresetStitchDraft).baseId === 'string' &&
      Array.isArray((parsed as PresetStitchDraft).entries)
    ) {
      return parsed as PresetStitchDraft
    }
    return undefined
  } catch {
    return undefined
  }
}

export function setPresetStitchCheckpoint(checkpoint: PresetStitchDraft): void {
  try {
    localStorage.setItem(PRESET_STITCH_CHECKPOINT_KEY, JSON.stringify(checkpoint))
  } catch {
    // 检查点属于本机便利功能，写入失败不阻断缝合流程。
  }
}

export function clearPresetStitchCheckpoint(): void {
  try {
    localStorage.removeItem(PRESET_STITCH_CHECKPOINT_KEY)
  } catch {
    // 同上。
  }
}

export function getStitchRecentIds(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PRESET_STITCH_RECENT_KEY) || '[]')
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string').slice(0, 6)
      : []
  } catch {
    return []
  }
}

export function pushStitchRecentId(id: string): void {
  const next = [id, ...getStitchRecentIds().filter((item) => item !== id)].slice(0, 6)
  try {
    localStorage.setItem(PRESET_STITCH_RECENT_KEY, JSON.stringify(next))
  } catch {
    // 同上。
  }
}

export function getStitchFavorites(): PresetFavoriteSnapshot[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PRESET_STITCH_FAVORITES_KEY) || '[]')
    return normalizeStitchFavorites(parsed)
  } catch {
    return []
  }
}

export function setStitchFavorites(value: PresetFavoriteSnapshot[]): PresetFavoriteSnapshot[] {
  const normalized = normalizeStitchFavorites(value)
  try {
    localStorage.setItem(PRESET_STITCH_FAVORITES_KEY, JSON.stringify(normalized))
  } catch {
    // 收藏属于本机便利数据，写入失败不阻断预设编辑与导出。
  }
  return normalized
}

export function getStitchTemplates(): PresetStitchTemplate[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PRESET_STITCH_TEMPLATES_KEY) || '[]')
    return normalizeStitchTemplates(parsed)
  } catch {
    return []
  }
}

export function setStitchTemplates(value: PresetStitchTemplate[]): PresetStitchTemplate[] {
  const normalized = normalizeStitchTemplates(value)
  try {
    localStorage.setItem(PRESET_STITCH_TEMPLATES_KEY, JSON.stringify(normalized))
  } catch {
    // 缝合包是可恢复偏好，写入失败不阻断本次缝合。
  }
  return normalized
}

export function getStitchMainSide(): 'left' | 'right' {
  try {
    return localStorage.getItem(PRESET_STITCH_MAIN_SIDE_KEY) === 'left' ? 'left' : 'right'
  } catch {
    return 'right'
  }
}

export function setStitchMainSide(value: 'left' | 'right'): 'left' | 'right' {
  const normalized = value === 'left' ? 'left' : 'right'
  try {
    localStorage.setItem(PRESET_STITCH_MAIN_SIDE_KEY, normalized)
  } catch {
    // 左右习惯属于非关键偏好。
  }
  return normalized
}

export function getFrontendWorkshopDrawerSize(): { bottom: number; side: number } {
  try {
    const value = JSON.parse(localStorage.getItem('srl.frontendWorkshop.drawerSize') ?? '{}')
    const normalize = (n: unknown, fallback: number) =>
      typeof n === 'number' && Number.isFinite(n) ? Math.max(0.12, Math.min(0.95, n)) : fallback
    return { bottom: normalize(value?.bottom, 0.46), side: normalize(value?.side, 0.32) }
  } catch {
    return { bottom: 0.46, side: 0.32 }
  }
}

export function setFrontendWorkshopDrawerSize(value: { bottom: number; side: number }): void {
  try {
    localStorage.setItem('srl.frontendWorkshop.drawerSize', JSON.stringify(value))
  } catch {
    /* Nonessential device layout; editing must remain available. */
  }
}

export function getFrontendWorkshopRecentColors(): string[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(FRONTEND_WORKSHOP_RECENT_COLORS_KEY) ?? '[]',
    )
    return normalizeFrontendWorkshopRecentColors(value)
  } catch {
    return []
  }
}

export function setFrontendWorkshopRecentColors(value: unknown): string[] {
  const normalized = normalizeFrontendWorkshopRecentColors(value)
  try {
    localStorage.setItem(FRONTEND_WORKSHOP_RECENT_COLORS_KEY, JSON.stringify(normalized))
  } catch {
    // 最近色属于非关键设备偏好，写入失败不阻断当前编辑。
  }
  return normalized
}

export function pushFrontendWorkshopRecentColor(value: string): string[] {
  return setFrontendWorkshopRecentColors([value, ...getFrontendWorkshopRecentColors()])
}

export function normalizeFrontendWorkshopRecentColors(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim().toUpperCase())
        .filter((item) => /^#[0-9A-F]{6}$/u.test(item)),
    ),
  ).slice(0, 12)
}

export function hasAcknowledgedProjectNotice(): boolean {
  const hasCookie = () => {
    try {
      return document.cookie
        .split(';')
        .map((item) => item.trim())
        .includes(`${PROJECT_NOTICE_ACKNOWLEDGED_COOKIE}=${PROJECT_NOTICE_VERSION}`)
    } catch {
      return false
    }
  }
  try {
    return (
      localStorage.getItem(PROJECT_NOTICE_ACKNOWLEDGED_KEY) === PROJECT_NOTICE_VERSION ||
      hasCookie()
    )
  } catch {
    return hasCookie()
  }
}

export async function hasAcknowledgedProjectNoticePersisted(): Promise<boolean> {
  if (hasAcknowledgedProjectNotice()) return true
  try {
    const version = (await getNativeProjectNoticeStorage()?.getAcknowledgedVersion())?.version
    return version === PROJECT_NOTICE_VERSION
  } catch {
    return false
  }
}

export function acknowledgeProjectNotice(): void {
  try {
    localStorage.setItem(PROJECT_NOTICE_ACKNOWLEDGED_KEY, PROJECT_NOTICE_VERSION)
  } catch {
    // WebView 的 localStorage 不可用或尚未落盘时，仍由同设备 Cookie 保留确认记录。
  }
  try {
    const secure = window.location.protocol === 'https:' ? '; Secure' : ''
    document.cookie = `${PROJECT_NOTICE_ACKNOWLEDGED_COOKIE}=${PROJECT_NOTICE_VERSION}; Max-Age=315360000; Path=/; SameSite=Lax${secure}`
  } catch {
    // 这是设备侧的首次阅读提示；两种本地存储都不可用时，本次仍可继续使用。
  }
  void getNativeProjectNoticeStorage()
    ?.setAcknowledgedVersion({ version: PROJECT_NOTICE_VERSION })
    .catch(() => undefined)
}

export function normalizeUserPersonaTemplates(value: unknown): UserPersonaTemplate[] {
  return operationsBrowserPreferenceNormalization.normalizeUserPersonaTemplates(value)
}

export function normalizeStitchFavorites(value: unknown): PresetFavoriteSnapshot[] {
  return operationsBrowserPreferenceNormalization.normalizeStitchFavorites(value)
}

export function normalizeStitchTemplates(value: unknown): PresetStitchTemplate[] {
  return operationsBrowserPreferenceNormalization.normalizeStitchTemplates(value)
}
