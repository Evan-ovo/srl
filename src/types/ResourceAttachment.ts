import type { ResourceReference } from './Resource'

export const RESOURCE_ATTACHMENT_KIND = 'resource-attachment'

export function isResourceAttachment(resource: Pick<ResourceReference, 'metadata'>): boolean {
  return resource.metadata?.assetKind === RESOURCE_ATTACHMENT_KIND
}

/** Owned files share resource storage, but never appear as independent library entries. */
export function isResourceOwnedFile(resource: Pick<ResourceReference, 'metadata'>): boolean {
  return isResourceAttachment(resource) || resource.metadata?.assetKind === 'resource-gallery-image'
}

export function resourceOwnedFileOwnerId(resource: Pick<ResourceReference, 'metadata'>): string {
  const key = isResourceAttachment(resource) ? 'attachmentOwnerId' : 'galleryOwnerId'
  return isResourceOwnedFile(resource) && typeof resource.metadata[key] === 'string'
    ? resource.metadata[key]
    : ''
}

export function includeResourceAttachmentIds<T extends Pick<ResourceReference, 'id' | 'metadata'>>(
  resources: readonly T[],
  selected: Set<string>,
  include: boolean,
  allowDetached = false,
): void {
  for (const resource of resources) {
    if (!isResourceAttachment(resource)) continue
    const explicitlySelected = selected.has(resource.id)
    selected.delete(resource.id)
    if (
      include &&
      (selected.has(resourceOwnedFileOwnerId(resource)) || (allowDetached && explicitlySelected))
    )
      selected.add(resource.id)
  }
}
