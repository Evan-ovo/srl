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
  private readonly targetsByOwner = new Map<string, Set<string>>()

  replaceOwner(
    ownerType: ReferenceEntityType,
    ownerId: string,
    references: EntityReference[],
  ): void {
    this.removeOwner(ownerType, ownerId)
    const ownerKey = this.key(ownerType, ownerId)
    const targetKeys = new Set<string>()
    for (const reference of references) {
      if (reference.ownerType !== ownerType || reference.ownerId !== ownerId) continue
      const targetKey = this.key(reference.targetType, reference.targetId)
      const target = this.byTarget.get(targetKey) ?? new Map()
      target.set(ownerKey, reference)
      this.byTarget.set(targetKey, target)
      targetKeys.add(targetKey)
    }
    if (targetKeys.size) this.targetsByOwner.set(ownerKey, targetKeys)
  }

  impacts(targetType: ReferenceEntityType, targetId: string): EntityReference[] {
    return [...(this.byTarget.get(this.key(targetType, targetId))?.values() ?? [])]
  }

  clear(): void {
    this.byTarget.clear()
    this.targetsByOwner.clear()
  }

  removeOwner(ownerType: ReferenceEntityType, ownerId: string): void {
    const ownerKey = this.key(ownerType, ownerId)
    const targetKeys = this.targetsByOwner.get(ownerKey)
    if (!targetKeys) return
    for (const targetKey of targetKeys) {
      const references = this.byTarget.get(targetKey)
      references?.delete(ownerKey)
      if (references?.size === 0) this.byTarget.delete(targetKey)
    }
    this.targetsByOwner.delete(ownerKey)
  }

  private key(type: ReferenceEntityType, id: string): string {
    return `${type}:${id}`
  }
}

export const referenceIndex = new ReferenceIndex()
