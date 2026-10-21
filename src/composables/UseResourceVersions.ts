import type { Ref } from 'vue'

import { resourceService } from '../core/AppContainer'
import { confirmAction } from './UseConfirmDialog'
import type { ResourceVersionView } from '../services/ResourceService'
import type { Resource, ResourceSummary } from '../types/Resource'
import { RESOURCE_TYPE } from '../types/Resource'
import { isRecord } from '../utils/UnknownValue'
import {
  readCharacterCardContentEdits,
  migrateCharacterCardContentEdits,
} from '../utils/CharacterCardContentEdits'
import {
  migrateCharacterCardContentWithReview,
  selectCharacterCardMigrationEdits,
} from '../services/CharacterCardMigrationReview'

interface ResourceVersionsContext {
  /** 详情页当前打开的资源，切换版本后就地替换。 */
  organizingResource: Ref<Resource | undefined>
  organizingVersions: Ref<ResourceVersionView[]>
  /** 详情页忙碌标记，防止版本操作并发。 */
  isOrganizing: Ref<boolean>
  resources: Ref<ResourceSummary[]>
  showNotice: (message: string) => void
  loadResources: (ids?: string[]) => Promise<void>
  refreshStorageHealth: () => Promise<void>
}

/**
 * 资源版本组操作。
 *
 * 当前版与历史版共用文件夹、标签与关联关系，这里只负责切换当前版、
 * 删除非当前版、维护版本备注以及把已有独立资源并入版本历史；
 * 任何一步都不改写原文件内容。
 */
export function useResourceVersions(context: ResourceVersionsContext) {
  async function reloadVersionState(resourceId: string, changedIds?: string[]): Promise<void> {
    context.organizingVersions.value = await resourceService.listVersions(resourceId)
    await context.loadResources(changedIds)
  }

  async function handleActivateVersion(versionId: string): Promise<void> {
    const resource = context.organizingResource.value
    if (!resource || context.isOrganizing.value) return
    context.isOrganizing.value = true
    try {
      const selectedVersion = context.organizingVersions.value
        .flatMap((view) => view.carriers ?? [view.resource])
        .find((item) => item.id === versionId)
      if (!selectedVersion) throw new Error('历史版本已经不存在')
      let migratedEdits: ReturnType<typeof migrateCharacterCardContentEdits> | undefined
      if (resource.type === RESOURCE_TYPE.CHARACTER_CARD) {
        const tracked = readCharacterCardContentEdits(
          resource.metadata.characterContentEdits,
        ).filter((edit) => edit.migrateToVersions)
        const incoming = await selectCharacterCardMigrationEdits(
          tracked,
          selectedVersion.versionLabel ?? selectedVersion.fileName,
        )
        if (!incoming) return
        if (incoming.length) {
          const targetCard = isRecord(selectedVersion.metadata.card)
            ? selectedVersion.metadata.card
            : undefined
          if (targetCard) {
            const targetEdits = readCharacterCardContentEdits(
              selectedVersion.metadata.characterContentEdits,
            )
            const reviewResult = await migrateCharacterCardContentWithReview(
              targetCard,
              targetEdits,
              incoming,
            )
            if (!reviewResult) return
            migratedEdits = reviewResult
          } else {
            migratedEdits = {
              card: {},
              edits: readCharacterCardContentEdits(selectedVersion.metadata.characterContentEdits),
              conflicts: incoming,
              alreadyPresent: [],
              fieldConflicts: [],
            }
          }
          if (migratedEdits.conflicts.length) {
            const conflicts = migratedEdits.conflicts.map((edit) => `• ${edit.label}`).join('\n')
            const keepSwitching = await confirmAction({
              title: '部分修改与新版冲突',
              message: `以下修改不会写入新版：\n${conflicts}\n\n仍要切换到这个版本吗？未迁移的修改仍留在上一版本记录中。`,
              confirmLabel: '切换并保留新版内容',
              cancelLabel: '取消切换',
            })
            if (!keepSwitching) return
          }
        }
      }
      context.organizingResource.value = await resourceService.activateVersion(
        resource.id,
        versionId,
      )
      if (migratedEdits)
        context.organizingResource.value = await resourceService.updateMetadata(resource.id, {
          characterContentEdits: migratedEdits.edits,
        })
      await reloadVersionState(resource.id, [resource.id])
      const migratedCount = migratedEdits
        ? migratedEdits.edits.length -
          readCharacterCardContentEdits(selectedVersion.metadata.characterContentEdits).length
        : 0
      context.showNotice(
        migratedEdits
          ? `已切换版本并迁移 ${Math.max(0, migratedCount)} 项修改；刚才的版本已收入历史`
          : '已切换当前展示版本，刚才的版本已收入历史',
      )
    } catch (error) {
      context.showNotice(error instanceof Error ? error.message : '版本切换失败')
    } finally {
      context.isOrganizing.value = false
    }
  }

  async function handleDeleteResourceVersion(versionId: string | string[]): Promise<void> {
    const resource = context.organizingResource.value
    if (!resource || context.isOrganizing.value) return
    const versionIds = Array.isArray(versionId) ? versionId : [versionId]
    const version = context.organizingVersions.value.find((item) =>
      (item.carriers ?? [item.resource]).some((carrier) => versionIds.includes(carrier.id)),
    )
    if (
      !version ||
      versionIds.includes(resource.id) ||
      (version.active && versionIds.includes(version.resource.id))
    )
      return
    const target = (version.carriers ?? [version.resource]).find((carrier) =>
      versionIds.includes(carrier.id),
    )
    const confirmed = await confirmAction({
      title: '删除历史版本',
      message:
        versionIds.length > 1
          ? `永久删除历史版本“${version.resource.versionLabel ?? version.resource.fileName}”及其 ${versionIds.length} 份封装吗？`
          : `永久删除历史文件“${target?.versionLabel ?? target?.fileName ?? version.resource.fileName}”吗？`,
      confirmLabel: '永久删除',
      danger: true,
    })
    if (!confirmed) return
    context.isOrganizing.value = true
    try {
      await resourceService.deleteVersions(resource.id, versionIds)
      context.organizingResource.value = await resourceService.get(resource.id)
      await reloadVersionState(resource.id, [resource.id])
      context.showNotice('历史版本已删除')
    } catch (error) {
      context.showNotice(error instanceof Error ? error.message : '历史版本删除失败')
    } finally {
      context.isOrganizing.value = false
    }
  }

  async function handleDetachResourceVersion(versionId: string): Promise<void> {
    const resource = context.organizingResource.value
    if (!resource || context.isOrganizing.value) return
    const carrier = context.organizingVersions.value
      .flatMap((version) => version.carriers ?? [version.resource])
      .find((item) => item.id === versionId)
    if (!carrier || versionId === resource.id) return
    const confirmed = await confirmAction({
      title: '解除封装绑定',
      message: `把“${carrier.fileName}”从“${resource.name}”的版本历史中移出并保留为独立资源吗？原文件不会删除。`,
      confirmLabel: '解除并保留',
    })
    if (!confirmed) return
    context.isOrganizing.value = true
    try {
      await resourceService.detachVersion(resource.id, versionId)
      context.organizingResource.value = await resourceService.get(resource.id)
      await reloadVersionState(resource.id, [resource.id, versionId])
      await context.refreshStorageHealth()
      context.showNotice('封装已解除绑定，并作为独立资源保留')
    } catch (error) {
      context.showNotice(error instanceof Error ? error.message : '解除封装失败')
    } finally {
      context.isOrganizing.value = false
    }
  }

  async function handleUpdateVersionNote(versionId: string, note: string): Promise<void> {
    const resource = context.organizingResource.value
    if (!resource || context.isOrganizing.value) return
    context.isOrganizing.value = true
    let saved = false
    try {
      await resourceService.updateVersionNote(resource.id, versionId, note)
      saved = true
      const updated = await resourceService.getSummary(versionId, versionId !== resource.id)
      if (!updated) throw new Error('备注已保存，但对应版本已不存在，请重新打开版本页确认')
      // A late read must not reopen a closed detail or replace another resource's state.
      if (context.organizingResource.value !== resource) return
      const known =
        versionId === resource.id
          ? resource
          : context.organizingVersions.value
              .flatMap((view) => view.carriers ?? [view.resource])
              .find((item) => item.id === versionId)
      if (!known || known.contentHash !== updated.contentHash) {
        // A real version/content change needs the existing full detail read, not a note-only patch.
        const current = await resourceService.get(resource.id)
        const versions = await resourceService.listVersions(resource.id)
        if (context.organizingResource.value !== resource) return
        context.organizingResource.value = current
        context.organizingVersions.value = versions
        await context.loadResources([resource.id])
      } else {
        const patch = (item: Resource): Resource =>
          item.id === versionId
            ? { ...item, versionNote: updated.versionNote, updatedAt: updated.updatedAt }
            : item
        if (versionId === resource.id) context.organizingResource.value = patch(resource)
        context.organizingVersions.value = context.organizingVersions.value.map((view) => ({
          ...view,
          resource: patch(view.resource),
          ...(view.carriers ? { carriers: view.carriers.map(patch) } : {}),
        }))
        if (versionId === resource.id) await context.loadResources([resource.id])
      }
      context.showNotice(updated.versionNote?.trim() ? '备注已保存' : '备注已清除')
    } catch (error) {
      context.showNotice(
        saved
          ? '备注已保存，但显示刷新未完成，请重新打开版本页确认'
          : error instanceof Error
            ? error.message
            : '版本备注保存失败',
      )
    } finally {
      context.isOrganizing.value = false
    }
  }

  async function handleReplaceCharacterCardArtwork(file: File): Promise<void> {
    const resource = context.organizingResource.value
    if (!resource || context.isOrganizing.value) return
    context.isOrganizing.value = true
    try {
      context.organizingResource.value = await resourceService.replaceCharacterCardArtwork(
        resource.id,
        file,
      )
      await reloadVersionState(resource.id, [resource.id])
      context.showNotice('新卡面已保存为当前 PNG 封装，原卡面和原文件仍保留在同一版本中')
    } catch (error) {
      context.showNotice(error instanceof Error ? error.message : '更换卡面失败')
    } finally {
      context.isOrganizing.value = false
    }
  }

  async function handleMergeExistingVersion(sourceResourceId: string, note: string): Promise<void> {
    const resource = context.organizingResource.value
    if (!resource || context.isOrganizing.value) return
    const source = context.resources.value.find((item) => item.id === sourceResourceId)
    if (!source) {
      context.showNotice('要合并的资源已经不存在')
      return
    }
    const confirmed = await confirmAction({
      title: '并入历史版本',
      message: `把“${source.name}”从资源库列表移入“${resource.name}”的历史版本吗？原文件会保留在版本历史里。`,
      confirmLabel: '并入历史',
    })
    if (!confirmed) return
    context.isOrganizing.value = true
    try {
      context.organizingResource.value = await resourceService.mergeExistingResourceAsVersion(
        resource.id,
        sourceResourceId,
        note,
      )
      await reloadVersionState(resource.id)
      await context.refreshStorageHealth()
      context.showNotice('已手动加入历史版本')
    } catch (error) {
      context.showNotice(error instanceof Error ? error.message : '手动版本合并失败')
    } finally {
      context.isOrganizing.value = false
    }
  }

  return {
    handleActivateVersion,
    handleDeleteResourceVersion,
    handleDetachResourceVersion,
    handleUpdateVersionNote,
    handleMergeExistingVersion,
    handleReplaceCharacterCardArtwork,
  }
}
