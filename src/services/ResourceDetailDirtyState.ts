import type { Resource } from '../types/Resource'
import {
  getRelatedResourceIds,
  getResourceCategoryIds,
  normalizeResourceLinks,
  normalizeResourceLinkUrl,
} from '../types/Resource'
import { readCharacterCardOverrides } from '../utils/CharacterCardCustomization'
import type { CharacterCardContentEdit } from '../types/CharacterCardContentEdit'
import { readCharacterCardContentEdits } from '../utils/CharacterCardContentEdits'
import { normalizeTags } from './ResourceLinkImport'

export interface ResourceDetailDraftState {
  name: string
  authorNote: string
  description: string
  type: Resource['type']
  categoryIds: Iterable<string>
  relatedResourceIds: Iterable<string>
  tags: string[]
  sourceLinks: Resource['sourceLinks']
  characterOverrides: unknown
  characterContentEdits: CharacterCardContentEdit[]
}

function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${sortedJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

function setMatches(left: Iterable<string>, right: Iterable<string>): boolean {
  const leftSet = new Set(left)
  const rightSet = new Set(right)
  return leftSet.size === rightSet.size && [...rightSet].every((item) => leftSet.has(item))
}

/** Compare the values that saving would persist, so legacy formatting alone is not dirty. */
export function hasResourceDetailDraftChanges(
  draft: ResourceDetailDraftState,
  resource: Resource,
): boolean {
  const invalidDraftLink = (draft.sourceLinks ?? []).some(
    (link) => link.url.trim() && !normalizeResourceLinkUrl(link.url),
  )
  return (
    draft.name.trim() !== resource.name.trim() ||
    draft.authorNote.trim() !==
      (typeof resource.metadata.authorNote === 'string'
        ? resource.metadata.authorNote.trim()
        : '') ||
    draft.description.trim() !== resource.description.trim() ||
    draft.type !== resource.type ||
    !setMatches(draft.categoryIds, getResourceCategoryIds(resource)) ||
    !setMatches(draft.relatedResourceIds, getRelatedResourceIds(resource)) ||
    normalizeTags(draft.tags).join('\n') !== normalizeTags(resource.tags).join('\n') ||
    invalidDraftLink ||
    sortedJson(normalizeResourceLinks(draft.sourceLinks ?? [])) !==
      sortedJson(normalizeResourceLinks(resource.sourceLinks ?? [])) ||
    sortedJson(readCharacterCardOverrides({ characterOverrides: draft.characterOverrides })) !==
      sortedJson(readCharacterCardOverrides(resource.metadata)) ||
    sortedJson(draft.characterContentEdits) !==
      sortedJson(readCharacterCardContentEdits(resource.metadata.characterContentEdits))
  )
}
