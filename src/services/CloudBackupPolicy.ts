import type {
  CloudBackupContentSelection,
  CloudBackupProtection,
  CloudBackupSchedule,
} from '../types/CloudBackup'
import { type GitHubBundleManifest } from './GitHubBackupBundle'
export const LEGACY_RELEASE_TAG = 'srl-cloud-backups'

export const MINUTE_MS = 60 * 1000

export const HOUR_MS = 60 * MINUTE_MS

export const DAY_MS = 24 * HOUR_MS

export const RETRY_MS = 15 * MINUTE_MS

export function normalizeRetention(value: number): number {
  return Math.min(30, Math.max(1, Math.round(Number(value) || 7)))
}

export function normalizeSchedule(schedule?: CloudBackupSchedule): CloudBackupSchedule {
  if (schedule?.mode === 'daily') {
    return {
      mode: 'daily',
      time: /^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time) ? schedule.time : '02:00',
    }
  }
  const unit = schedule?.unit ?? 'days'
  const limits = unit === 'minutes' ? [15, 1440] : unit === 'hours' ? [1, 168] : [1, 30]
  return {
    mode: 'interval',
    unit,
    value: Math.min(limits[1], Math.max(limits[0], Math.round(Number(schedule?.value) || 1))),
  }
}

export function normalizeProtection(protection?: CloudBackupProtection): CloudBackupProtection {
  return {
    wifiOnly: protection?.wifiOnly ?? false,
    chargingOnly: protection?.chargingOnly ?? false,
  }
}

export function normalizeContentSelection(
  selection?: CloudBackupContentSelection,
): CloudBackupContentSelection {
  return {
    credentials: selection?.credentials === true,
    resourceAttachments: selection?.resourceAttachments === true,
    resourceGallery: selection?.resourceGallery === true,
    appearance: selection?.appearance !== false,
    cloudBackup: selection?.cloudBackup !== false,
    characterDraw: selection?.characterDraw !== false,
    generalPreferences: selection?.generalPreferences !== false,
    resourceIds: Array.isArray(selection?.resourceIds)
      ? Array.from(
          new Set(
            selection.resourceIds.filter(
              (id): id is string => typeof id === 'string' && Boolean(id.trim()),
            ),
          ),
        )
      : undefined,
    personalResources: {
      resourceAttachments: selection?.resourceAttachments === true,
      resourceGallery: selection?.resourceGallery === true,
      extraStory: selection?.personalResources?.extraStory !== false,
      pocketPhone: selection?.personalResources?.pocketPhone !== false,
      secret: selection?.personalResources?.secret === true,
      resourceIds: Array.isArray(selection?.resourceIds)
        ? Array.from(
            new Set(
              selection.resourceIds.filter(
                (id): id is string => typeof id === 'string' && Boolean(id.trim()),
              ),
            ),
          )
        : undefined,
    },
    plaintextSecretCopy: selection?.plaintextSecretCopy === true,
    aiTaggingState: selection?.aiTaggingState === true,
    externalApps: selection?.externalApps === true,
    chatReader: selection?.chatReader !== false,
    assistantData: selection?.assistantData === true,
    stitchWork: selection?.stitchWork === true,
    frontendWorkshopComponents: selection?.frontendWorkshopComponents === true,
    frontendWorkshopProjects: selection?.frontendWorkshopProjects === true,
    imageGeneration: selection?.imageGeneration === true,
    generatedImageAlbum: selection?.generatedImageAlbum === true,
    communitySources: selection?.communitySources === true,
  }
}

export function isScheduleDue(
  schedule: CloudBackupSchedule,
  lastSuccessAt: number | undefined,
  now: number,
): boolean {
  if (schedule.mode === 'interval') {
    if (!lastSuccessAt) return true
    const unitMs =
      schedule.unit === 'minutes' ? MINUTE_MS : schedule.unit === 'hours' ? HOUR_MS : DAY_MS
    return now - lastSuccessAt >= schedule.value * unitMs
  }
  const [hour, minute] = schedule.time.split(':').map(Number)
  const scheduled = new Date(now)
  scheduled.setHours(hour, minute, 0, 0)
  if (!lastSuccessAt) return now >= scheduled.getTime()
  return now >= scheduled.getTime() && lastSuccessAt < scheduled.getTime()
}

export function normalizeFolder(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, '') || 'SRL-Backups'
}

export function joinUrl(baseUrl: string, ...parts: string[]): string {
  const base = baseUrl.trim().replace(/\/+$/g, '')
  return `${base}/${parts
    .flatMap((part) => part.split('/'))
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/')}`
}

export function basicAuthorization(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `Basic ${btoa(binary)}`
}

export function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function canonicalizeFingerprintValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeFingerprintValue)
  if (value instanceof Blob) return { size: value.size, type: value.type }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalizeFingerprintValue(entry)]),
    )
  }
  return value
}

export function structuredPartObjectKey(part: GitHubBundleManifest['parts'][number]): string {
  return part.storage?.objectKey ?? part.name
}

export function structuredPartContainer(part: GitHubBundleManifest['parts'][number]): string {
  return part.storage?.kind === 'github-release' ? part.storage.container : LEGACY_RELEASE_TAG
}

export function structuredPartIdentity(part: GitHubBundleManifest['parts'][number]): string {
  return `${structuredPartContainer(part)}\u0000${structuredPartObjectKey(part)}`
}

export async function allowsAutomaticBackup(protection: CloudBackupProtection): Promise<boolean> {
  if (typeof navigator === 'undefined') return true
  if (protection.wifiOnly) {
    const connection = (
      navigator as Navigator & { connection?: { type?: string; effectiveType?: string } }
    ).connection
    if (connection?.type && connection.type !== 'wifi' && connection.type !== 'ethernet')
      return false
    if (!connection?.type && /2g|3g|4g|5g/.test(connection?.effectiveType ?? '')) return false
  }
  if (protection.chargingOnly) {
    const getBattery = (
      navigator as Navigator & { getBattery?: () => Promise<{ charging: boolean }> }
    ).getBattery
    if (getBattery && !(await getBattery.call(navigator)).charging) return false
  }
  return true
}
