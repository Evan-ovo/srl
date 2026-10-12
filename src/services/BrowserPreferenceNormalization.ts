import type { UserPersonaTemplate } from '../types/UserPersona'
import type { PresetFavoriteSnapshot } from '../utils/PresetStitcher'
import { type PresetStitchTemplate, type CabinetLayoutEntry } from '../types/BrowserPreferences'

export function normalizeCabinetLayout(value: unknown): CabinetLayoutEntry[] {
  if (!Array.isArray(value)) return []
  const keys = new Set<string>()
  const slots = new Set<number>()
  const normalized: CabinetLayoutEntry[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const candidate = item as Partial<CabinetLayoutEntry>
    if (candidate.kind !== 'folder' && candidate.kind !== 'resource') continue
    if (typeof candidate.id !== 'string' || !candidate.id) continue
    if (!Number.isInteger(candidate.slot) || Number(candidate.slot) < 0) continue
    const slot = Number(candidate.slot)
    if (slot >= 6000) continue
    const key = `${candidate.kind}:${candidate.id}`
    if (keys.has(key) || slots.has(slot)) continue
    keys.add(key)
    slots.add(slot)
    normalized.push({
      kind: candidate.kind,
      id: candidate.id,
      slot,
      columnSpan:
        candidate.columnSpan === 2 || candidate.columnSpan === 4 ? candidate.columnSpan : 1,
      rowSpan: candidate.rowSpan === 2 ? 2 : 1,
    })
  }
  return normalized.sort((left, right) => left.slot - right.slot)
}

export function normalizeUserPersonaTemplates(value: unknown): UserPersonaTemplate[] {
  if (!Array.isArray(value)) return []
  const ids = new Set<string>()
  const normalized: UserPersonaTemplate[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const candidate = item as Partial<UserPersonaTemplate>
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
    const name = typeof candidate.name === 'string' ? candidate.name.trim().slice(0, 80) : ''
    const description =
      typeof candidate.description === 'string' ? candidate.description.slice(0, 20000) : ''
    if (!id.startsWith('custom-') || !name || !description.trim() || ids.has(id)) continue
    ids.add(id)
    normalized.push({
      id,
      name,
      description,
    })
    if (normalized.length >= 30) break
  }
  return normalized
}

export function normalizeStitchFavorites(value: unknown): PresetFavoriteSnapshot[] {
  if (!Array.isArray(value)) return []
  const ids = new Set<string>()
  const normalized: PresetFavoriteSnapshot[] = []
  let estimatedBytes = 0
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const candidate = item as Partial<PresetFavoriteSnapshot>
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
    const identifier = typeof candidate.identifier === 'string' ? candidate.identifier.trim() : ''
    const name = typeof candidate.name === 'string' ? candidate.name.trim().slice(0, 160) : ''
    const role = typeof candidate.role === 'string' ? candidate.role.slice(0, 40) : ''
    const content = typeof candidate.content === 'string' ? candidate.content : ''
    const prompt = candidate.prompt
    if (
      !id ||
      ids.has(id) ||
      !identifier ||
      !name ||
      !prompt ||
      typeof prompt !== 'object' ||
      Array.isArray(prompt)
    ) {
      continue
    }
    const snapshot: PresetFavoriteSnapshot = {
      id,
      sourceResourceId:
        typeof candidate.sourceResourceId === 'string' ? candidate.sourceResourceId : undefined,
      sourceName:
        typeof candidate.sourceName === 'string' && candidate.sourceName.trim()
          ? candidate.sourceName.trim().slice(0, 160)
          : '已收藏条目',
      identifier,
      name,
      role,
      content,
      prompt: JSON.parse(JSON.stringify(prompt)) as Record<string, unknown>,
      createdAt: Number.isFinite(candidate.createdAt) ? Number(candidate.createdAt) : Date.now(),
      updatedAt: Number.isFinite(candidate.updatedAt) ? Number(candidate.updatedAt) : Date.now(),
    }
    const bytes = JSON.stringify(snapshot).length
    if (bytes > 200_000 || estimatedBytes + bytes > 2_000_000) continue
    estimatedBytes += bytes
    ids.add(id)
    normalized.push(snapshot)
    if (normalized.length >= 80) break
  }
  return normalized
}

export function normalizeStitchTemplates(value: unknown): PresetStitchTemplate[] {
  if (!Array.isArray(value)) return []
  const ids = new Set<string>()
  const normalized: PresetStitchTemplate[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const candidate = item as Partial<PresetStitchTemplate>
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
    const name = typeof candidate.name === 'string' ? candidate.name.trim().slice(0, 80) : ''
    const entries = normalizeStitchFavorites(candidate.entries).slice(0, 40)
    if (!id || !name || !entries.length || ids.has(id)) continue
    ids.add(id)
    normalized.push({
      id,
      name,
      entries,
      createdAt: Number.isFinite(candidate.createdAt) ? Number(candidate.createdAt) : Date.now(),
      updatedAt: Number.isFinite(candidate.updatedAt) ? Number(candidate.updatedAt) : Date.now(),
    })
    if (normalized.length >= 30) break
  }
  return normalized
}
