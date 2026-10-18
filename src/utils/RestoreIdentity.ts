import { isRecord } from './UnknownValue'
import {
  isResourceAttachment,
  isResourceOwnedFile,
  resourceOwnedFileOwnerId,
} from '../types/ResourceAttachment'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { canonicalizeCardJson } from './CharacterCardFingerprint'
import {
  isUserPersonaAvatarAttachment,
  RESOURCE_TYPE,
  type ResourceSummary,
} from '../types/Resource'

function avatarOwners(resources: ResourceSummary[]): Map<string, string[]> {
  const byId = new Map(resources.map((resource) => [resource.id, resource]))
  const owners = new Map<string, Set<string>>()
  const add = (avatar: string, owner: ResourceSummary) => {
    const hashes = owners.get(avatar) ?? new Set<string>()
    hashes.add(owner.contentHash.toLowerCase())
    owners.set(avatar, hashes)
  }
  for (const resource of resources) {
    if (isResourceOwnedFile(resource)) {
      const owner = byId.get(resourceOwnedFileOwnerId(resource))
      if (owner) add(resource.id, owner)
    }
    for (const id of resource.relatedResourceIds ?? []) {
      const related = byId.get(id)
      if (!related) continue
      if (resource.type === RESOURCE_TYPE.CHAT && related.type === RESOURCE_TYPE.CHARACTER_CARD)
        add(resource.id, related)
      if (resource.type === RESOURCE_TYPE.USER_PERSONA && isUserPersonaAvatarAttachment(related))
        add(id, resource)
      if (isUserPersonaAvatarAttachment(resource) && related.type === RESOURCE_TYPE.USER_PERSONA)
        add(resource.id, related)
    }
  }
  return new Map([...owners].map(([id, hashes]) => [id, [...hashes].sort()]))
}

/** Same image bytes can represent different persona avatars. Preserve their identity. */
export class RestoreDuplicateIndex {
  private readonly ids = new Map<string, string>()
  private readonly incomingOwners: Map<string, string[]>

  constructor(existing: ResourceSummary[], incoming: ResourceSummary[]) {
    const owners = avatarOwners(existing)
    for (const resource of existing) {
      const key = this.key(resource, owners)
      if (!this.ids.has(key)) this.ids.set(key, resource.id)
    }
    this.incomingOwners = avatarOwners(incoming)
  }

  private key(resource: ResourceSummary, owners: Map<string, string[]>): string {
    const hash = resource.contentHash.toLowerCase()
    if (isResourceOwnedFile(resource)) {
      return JSON.stringify([
        isResourceAttachment(resource) ? 'resource-attachment' : 'resource-gallery',
        hash,
        owners.get(resource.id) ?? resourceOwnedFileOwnerId(resource),
        resource.metadata.attachmentIdentity ??
          resource.metadata.galleryImageIdentity ??
          resource.id,
      ])
    }
    if (resource.type === RESOURCE_TYPE.CHAT) {
      const companion = isRecord(resource.metadata.chatCharacter)
        ? resource.metadata.chatCharacter
        : {}
      const roles =
        owners.get(resource.id) ?? (typeof companion.hash === 'string' ? [companion.hash] : [])
      return JSON.stringify(['chat', hash, roles])
    }
    if (!isUserPersonaAvatarAttachment(resource)) return `resource:${hash}`
    const ownerHashes = owners.get(resource.id)
    return JSON.stringify([
      'avatar',
      hash,
      resource.metadata.avatarId,
      ownerHashes?.length && typeof resource.metadata.avatarId === 'string'
        ? ownerHashes
        : resource.id,
    ])
  }

  find(resource: ResourceSummary): string | undefined {
    return this.ids.get(this.key(resource, this.incomingOwners))
  }

  add(resource: ResourceSummary, id: string): void {
    this.ids.set(this.key(resource, this.incomingOwners), id)
  }
}

/** Read-only estimate for current resources; history and portable settings are merged separately. */
export function summarizeRestoreSelection(
  existing: ResourceSummary[],
  incoming: ResourceSummary[],
) {
  const duplicates = new RestoreDuplicateIndex(existing, incoming)
  const ids = new Set(existing.map((resource) => resource.id))
  let added = 0
  let skipped = 0
  let conflicts = 0
  for (const resource of incoming) {
    if (duplicates.find(resource)) {
      skipped += 1
      continue
    }
    if (ids.has(resource.id)) conflicts += 1
    ids.add(resource.id)
    duplicates.add(resource, resource.id)
    added += 1
  }
  return { added, skipped, conflicts }
}

/** Preserve separate timeline entries, labels, and carriers, while ignoring restore-generated IDs. */
export function restoreVersionKey(
  resource: ResourceSummary,
  groupId = resource.versionGroupId,
): string {
  const metadata = { ...resource.metadata }
  // Cloud manifests rebuild card from the verified original; other custom metadata is retained.
  if (resource.type === RESOURCE_TYPE.CHARACTER_CARD) delete metadata.card
  return bytesToHex(
    sha256(
      new TextEncoder().encode(
        canonicalizeCardJson([
          groupId,
          resource.contentHash.toLowerCase(),
          resource.fileName,
          resource.mimeType,
          resource.createdAt,
          resource.updatedAt,
          resource.versionImportedAt,
          resource.versionLabel,
          resource.versionNote,
          resource.name,
          resource.description,
          metadata,
        ]),
      ),
    ),
  )
}
