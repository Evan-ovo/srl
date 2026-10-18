import { CHAT_READER_APP_ID } from '../core/ChatReaderIdentity'
import type { ArchivePortableData } from '../types/Backup'
import type { ExternalAppDataRecord } from '../types/ExternalApp'
import { isRecord } from '../utils/UnknownValue'
import type { PresetStitchDraft } from '../types/BrowserPreferences'

/** Merge restore changes IDs: reader state, cabinet slots and saved work must follow the originals. */
export function remapReaderPortableData(
  data: ArchivePortableData | undefined,
  ids: ReadonlyMap<string, string>,
  categories: ReadonlyMap<string, string> = new Map(),
): ArchivePortableData | undefined {
  if (!data) return data
  const id = (value: string): string => ids.get(value) ?? value
  const source = <T extends { sourceResourceId?: string }>(value: T): T =>
    value.sourceResourceId ? { ...value, sourceResourceId: id(value.sourceResourceId) } : value
  const draft = (value: PresetStitchDraft): PresetStitchDraft => ({
    ...value,
    baseId: id(value.baseId),
    entries: value.entries.map(source),
    regexPickIds: value.regexPickIds.map(id),
    ...(value.sourceEdits ? { sourceEdits: value.sourceEdits.map(source) } : {}),
    ...(value.candidates ? { candidates: value.candidates.map(source) } : {}),
  })
  const remap = (record: ExternalAppDataRecord): ExternalAppDataRecord => {
    if (record.appId !== CHAT_READER_APP_ID) return record
    const match = /^(chat:|appearance:)(.+)$/.exec(record.key)
    const key = match ? match[1] + (ids.get(match[2]!) ?? match[2]) : record.key
    let value = record.value
    if (match?.[1] === 'chat:' && isRecord(value) && isRecord(value.regexSources)) {
      value = {
        ...value,
        regexSources: Object.fromEntries(
          Object.entries(value.regexSources).map(([scope, id]) => [
            scope,
            typeof id === 'string' ? (ids.get(id) ?? id) : id,
          ]),
        ),
      }
    }
    if (key === 'reader-index-v1' && value && typeof value === 'object') {
      const index = value as Record<string, unknown>
      value = {
        ...index,
        ...(typeof index.lastChat === 'string'
          ? { lastChat: ids.get(index.lastChat) ?? index.lastChat }
          : {}),
      }
    }
    if (match?.[1] === 'chat:' && isRecord(value) && Array.isArray(value.scriptSources))
      value = {
        ...value,
        scriptSources: value.scriptSources.map((id) =>
          typeof id === 'string' ? (ids.get(id) ?? id) : id,
        ),
      }
    // Import recalculates the composite row ID through externalAppDataId.
    return { ...record, key, value }
  }
  return {
    ...data,
    ...(data.generalPreferences
      ? {
          generalPreferences: {
            ...data.generalPreferences,
            ...(data.generalPreferences.cabinetResourceIds
              ? {
                  cabinetResourceIds: data.generalPreferences.cabinetResourceIds.map(id),
                }
              : {}),
            ...(data.generalPreferences.cabinetLayout
              ? {
                  cabinetLayout: data.generalPreferences.cabinetLayout.map((entry) => ({
                    ...entry,
                    id:
                      entry.kind === 'resource'
                        ? id(entry.id)
                        : (categories.get(entry.id) ?? entry.id),
                  })),
                }
              : {}),
            ...(data.generalPreferences.stitchFavorites
              ? {
                  stitchFavorites: data.generalPreferences.stitchFavorites.map(source),
                }
              : {}),
          },
        }
      : {}),
    ...(data.stitchWork
      ? {
          stitchWork: {
            ...data.stitchWork,
            ...(data.stitchWork.draft ? { draft: draft(data.stitchWork.draft) } : {}),
            ...(data.stitchWork.checkpoint
              ? { checkpoint: draft(data.stitchWork.checkpoint) }
              : {}),
            ...(data.stitchWork.recentPresets
              ? { recentPresets: data.stitchWork.recentPresets.map(id) }
              : {}),
          },
        }
      : {}),
    ...(data.aiTaggingState
      ? {
          aiTaggingState: {
            ...data.aiTaggingState,
            ...(data.aiTaggingState.draft
              ? {
                  draft: {
                    ...data.aiTaggingState.draft,
                    categoryFilter:
                      categories.get(data.aiTaggingState.draft.categoryFilter) ??
                      data.aiTaggingState.draft.categoryFilter,
                    selectedIds: data.aiTaggingState.draft.selectedIds.map(id),
                    reviewItems: data.aiTaggingState.draft.reviewItems.map((item) => ({
                      ...item,
                      resourceId: id(item.resourceId),
                    })),
                    failures: data.aiTaggingState.draft.failures.map((failure) => ({
                      ...failure,
                      resourceIds: failure.resourceIds.map(id),
                    })),
                  },
                }
              : {}),
            ...(data.aiTaggingState.undo
              ? {
                  undo: {
                    ...data.aiTaggingState.undo,
                    additions: data.aiTaggingState.undo.additions.map((item) => ({
                      ...item,
                      resourceId: id(item.resourceId),
                    })),
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(data.chatReader ? { chatReader: data.chatReader.map(remap) } : {}),
    ...(data.externalApps
      ? { externalApps: { ...data.externalApps, data: data.externalApps.data.map(remap) } }
      : {}),
  }
}
