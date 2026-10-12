export type ReferenceEntityType =
  'resource' | 'asset' | 'version' | 'relation' | 'workshop-project' | 'generated-image'

export interface EntityReference {
  ownerType: ReferenceEntityType
  ownerId: string
  targetType: ReferenceEntityType
  targetId: string
  label: string
  strength: 'ui' | 'weak' | 'strong'
}

export class ReferenceIndex {
  private readonly byTarget = new Map<string, Map<string, EntityReference>>()

  replaceOwner(
    ownerType: ReferenceEntityType,
    ownerId: string,
    references: EntityReference[],
  ): void {
    this.removeOwner(ownerType, ownerId)
    for (const reference of references) {
      if (reference.ownerType !== ownerType || reference.ownerId !== ownerId) continue
      const targetKey = this.key(reference.targetType, reference.targetId)
      const target = this.byTarget.get(targetKey) ?? new Map()
      target.set(this.key(ownerType, ownerId), reference)
      this.byTarget.set(targetKey, target)
    }
  }

  impacts(targetType: ReferenceEntityType, targetId: string): EntityReference[] {
    return [...(this.byTarget.get(this.key(targetType, targetId))?.values() ?? [])]
  }

  clear(): void {
    this.byTarget.clear()
  }

  removeOwner(ownerType: ReferenceEntityType, ownerId: string): void {
    const ownerKey = this.key(ownerType, ownerId)
    for (const [targetKey, references] of this.byTarget) {
      references.delete(ownerKey)
      if (!references.size) this.byTarget.delete(targetKey)
    }
  }

  private key(type: ReferenceEntityType, id: string): string {
    return `${type}:${id}`
  }
}

export const referenceIndex = new ReferenceIndex()
