import type { Ref } from 'vue'
import {
  browserStorageService,
  getNativeMirrorHealth,
  resourceHealthStorage,
  syncNativeResourceFiles,
} from '../core/LibraryContainer'
import { healthCenter, type HealthIssue } from '../core/HealthCenter'
import { auditOfflineResourceCache, removeFullOfflineResources } from '../core/OfflineResources'
import { rebuildResourceReferenceIndex } from '../core/ResourceReferenceIndex'
import { type ResourceSummary } from '../types/Resource'

interface LibraryHealthRegistrationContext {
  resources: Ref<ResourceSummary[]>
}

export function useLibraryHealthRegistration(context: LibraryHealthRegistrationContext) {
  healthCenter.register({
    id: 'resource-references',
    async scan() {
      const missing = rebuildResourceReferenceIndex(
        context.resources.value,
        browserStorageService.getCabinetResourceIds(),
      )
      return missing.map((reference) => ({
        id: `missing-reference:${reference.ownerType}:${reference.ownerId}:${reference.missingResourceId}`,
        kind: 'missing-resource-reference',
        label: reference.ownerType === 'relation' ? '失效资源关联' : '失效界面固定项',
        details: `${reference.ownerLabel} 引用了不存在的资源 ${reference.missingResourceId}`,
        severity: reference.ownerType === 'relation' ? ('error' as const) : ('warning' as const),
        ...(reference.ownerType === 'ui'
          ? {
              safeRepair: async () => {
                browserStorageService.setCabinetResourceIds(
                  browserStorageService
                    .getCabinetResourceIds()
                    .filter((id) => id !== reference.missingResourceId),
                )
              },
            }
          : {}),
      }))
    },
  })

  healthCenter.register({
    id: 'local-library-integrity',
    async scan(options) {
      const [audit, nativeMirror, offlineCache] = await Promise.all([
        resourceHealthStorage.audit(options),
        getNativeMirrorHealth(),
        auditOfflineResourceCache(),
      ])
      const found: HealthIssue[] = []
      const driftCount =
        audit.currentSummaryDrift.length +
        audit.listSummaryDrift.length +
        audit.versionSummaryDrift.length
      if (driftCount) {
        found.push({
          id: 'derived-index-drift',
          kind: 'summary-mismatch',
          label: '资源摘要索引与原件不一致',
          details: `当前摘要 ${audit.currentSummaryDrift.length} 项、列表摘要 ${audit.listSummaryDrift.length} 项、历史摘要 ${audit.versionSummaryDrift.length} 项需要重建。`,
          severity: 'warning' as const,
          safeRepair: () => resourceHealthStorage.repairDerivedIndexes(),
        })
      }
      if (audit.orphanVersions.length) {
        found.push({
          id: 'orphan-resource-versions',
          kind: 'orphan-version',
          label: '发现没有所属资源的历史版本',
          details: `共 ${audit.orphanVersions.length} 项。历史版本可能仍有恢复价值，因此不会自动删除。`,
          severity: 'warning' as const,
        })
      }
      if (audit.missingGeneratedImageFiles.length) {
        found.push({
          id: 'missing-generated-image-files',
          kind: 'missing-asset',
          label: '生成图记录缺少原始图片',
          details: `共 ${audit.missingGeneratedImageFiles.length} 项元数据找不到对应图片文件。`,
          severity: 'error' as const,
        })
      }
      if (audit.orphanGeneratedImageFiles.length) {
        found.push({
          id: 'orphan-generated-image-files',
          kind: 'ownerless-generated-image',
          label: '发现无主生成图文件',
          details: `共 ${audit.orphanGeneratedImageFiles.length} 个图片文件没有相册记录；不会自动删除原图。`,
          severity: 'warning' as const,
        })
      }
      if (audit.corruptJsonResources.length) {
        found.push({
          id: 'corrupt-json-resources',
          kind: 'corrupt-json',
          label: '资源原件包含损坏的 JSON',
          details: `共 ${audit.corruptJsonResources.length} 项无法解析，请从历史版本或备份中人工恢复。`,
          severity: 'error' as const,
        })
      }
      if (audit.unreachableExternalLinks.length) {
        found.push({
          id: 'unreachable-external-links',
          kind: 'dead-external-link',
          label: '外部链接当前无法访问',
          details: `共 ${audit.unreachableExternalLinks.length} 项。网络、站点限制或链接失效都可能导致此结果，请人工复核。`,
          severity: 'warning' as const,
        })
      }
      if (nativeMirror?.mismatch) {
        found.push({
          id: 'native-mirror-mismatch',
          kind: 'native-mirror-mismatch',
          label: 'Android 原生镜像与资源库不一致',
          details: nativeMirror.details,
          severity: 'warning' as const,
          safeRepair: nativeMirror.safeRepair ? syncNativeResourceFiles : undefined,
        })
      }
      if (offlineCache.anomalies.length) {
        found.push({
          id: 'offline-cache-anomaly',
          kind: 'cache-anomaly',
          label: '完整离线缓存状态异常',
          details: offlineCache.anomalies.join('；'),
          severity: 'warning' as const,
          safeRepair: removeFullOfflineResources,
        })
      }
      return found
    },
  })
  return {}
}
