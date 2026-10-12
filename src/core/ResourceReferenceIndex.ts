import { getRelatedResourceIds, type ResourceSummary } from '../types/Resource'
import { referenceIndex } from './ReferenceIndex'

export interface MissingResourceReference {
  ownerType: 'relation' | 'ui'
  ownerId: string
  ownerLabel: string
  missingResourceId: string
}

export function rebuildResourceReferenceIndex(
  resources: ResourceSummary[],
  cabinetResourceIds: string[] = [],
): MissingResourceReference[] {
  referenceIndex.clear()
  const resourceIds = new Set(resources.map((resource) => resource.id))
  const missing: MissingResourceReference[] = []

  for (const resource of resources) {
    const references = getRelatedResourceIds(resource).flatMap((targetId) => {
      if (!resourceIds.has(targetId)) {
        missing.push({
          ownerType: 'relation',
          ownerId: resource.id,
          ownerLabel: resource.name,
          missingResourceId: targetId,
        })
        return []
      }
      return [
        {
          ownerType: 'relation' as const,
          ownerId: resource.id,
          targetType: 'resource' as const,
          targetId,
          label: `资源关联：${resource.name}`,
          strength: 'strong' as const,
        },
      ]
    })
    referenceIndex.replaceOwner('relation', resource.id, references)
  }

  for (const targetId of cabinetResourceIds) {
    if (!resourceIds.has(targetId)) {
      missing.push({
        ownerType: 'ui',
        ownerId: 'cabinet',
        ownerLabel: '首页陈列柜',
        missingResourceId: targetId,
      })
      continue
    }
    referenceIndex.replaceOwner('relation', `ui:cabinet:${targetId}`, [
      {
        ownerType: 'relation',
        ownerId: `ui:cabinet:${targetId}`,
        targetType: 'resource',
        targetId,
        label: '首页陈列柜固定项',
        strength: 'ui',
      },
    ])
  }
  return missing
}
