import type { ComputedRef, Ref } from 'vue'
import { chooseAction, confirmAction } from '../composables/UseConfirmDialog'
import { recycleBinService, userPersonaService } from '../core/AppContainer'
import {
  createEmptyPersonaBackup,
  parseSillyTavernPersonaBackup,
  removePersonaFromBackup,
  serializeSillyTavernPersonaBackup,
  updatePersonaInBackup,
} from '../parser/SillyTavernPersonaBackup'

import { type Resource, type ResourceSummary } from '../types/Resource'
import {
  type SillyTavernPersonaBackup,
  type UserPersonaConnection,
  type UserPersonaDraft,
  type UserPersonaEntry,
} from '../types/UserPersona'

import { normalizeUserPersonaAvatarId } from '../utils/UserPersonaAvatar'

interface PersonaResourceDeliveryContext {
  characters: ComputedRef<ResourceSummary[]>
  characterAvatarId: (resource: ResourceSummary) => string
  draft: Ref<UserPersonaDraft>
  selectedCharacterIds: Ref<Set<string>>
  worldBooks: ComputedRef<ResourceSummary[]>
  fileBaseName: (value: string) => string
  currentBackup: Ref<SillyTavernPersonaBackup | null>
  initialAvatarResourceIds: Ref<Set<string>>
  currentResource: Ref<Resource | null>
  avatarResourcesByAvatarId: Ref<Map<string, Resource>>
  emit: ((event: 'back') => void) & ((event: 'library-changed') => void)
  loadResource: (resourceId: string, preferredAvatarId?: string) => Promise<void>
  saving: Ref<boolean, boolean>
  errorMessage: Ref<string, string>
  statusMessage: Ref<string, string>
  ensureAvatarCached: (avatarId: string) => Promise<Resource | null>
  creatingPack: Ref<boolean, boolean>
  selectedAvatarId: Ref<string, string>
  selectedVariantCharacterId: Ref<string, string>
  selectedVariantVersionId: Ref<string, string>
  applyAvatarBindingForSave: (
    originalAvatarId: string,
    nextAvatarId: string,
    resource: Resource | null,
  ) => void
  selectedResourceId: Ref<string, string>
  activeEntry: ComputedRef<UserPersonaEntry | undefined>
  entries: ComputedRef<UserPersonaEntry[]>
  page: Ref<'list' | 'profile-sections' | 'versions' | 'character-picker' | 'editor'>
  loading: Ref<boolean, boolean>
}

export function usePersonaResourceDelivery(getContext: () => PersonaResourceDeliveryContext) {
  function connectionsForSave(): UserPersonaConnection[] {
    const context = getContext()

    const knownCharacterIds = new Set(
      context.characters.value.flatMap((resource) => [
        context.characterAvatarId(resource),
        resource.fileName,
        resource.name,
      ]),
    )
    const preserved = context.draft.value.connections.filter((connection) => {
      if (connection.type === 'group') return true
      const snapshot = context.draft.value.characterBindings[connection.id]
      // A saved hash can identify a renamed card even when the old filename no longer matches.
      if (snapshot)
        return !context.characters.value.some((resource) => resource.contentHash === snapshot.hash)
      return !knownCharacterIds.has(connection.id)
    })
    const selected = context.characters.value
      .filter((resource) => context.selectedCharacterIds.value.has(resource.id))
      .map((resource) => ({ type: 'character' as const, id: context.characterAvatarId(resource) }))
    return [...preserved, ...selected]
  }

  function relatedIdsForBackup(backup: SillyTavernPersonaBackup): string[] {
    const context = getContext()

    const view = parseSillyTavernPersonaBackup(backup)
    const ids = new Set<string>()
    for (const entry of view.entries) {
      const worldBook = context.worldBooks.value.find(
        (resource) =>
          resource.name === entry.lorebook ||
          context.fileBaseName(resource.fileName) === entry.lorebook,
      )
      if (worldBook) ids.add(worldBook.id)
      for (const connection of entry.connections) {
        if (connection.type !== 'character') continue
        const snapshot = entry.characterBindings[connection.id]
        const character = context.characters.value.find((resource) =>
          snapshot
            ? resource.contentHash === snapshot.hash
            : context.characterAvatarId(resource) === connection.id ||
              resource.fileName === connection.id ||
              resource.name === connection.id,
        )
        if (character) ids.add(character.id)
      }
      for (const characterId of Object.keys(entry.profile.variants)) {
        const snapshot = entry.characterBindings[characterId]
        const character = context.characters.value.find((resource) =>
          snapshot
            ? resource.contentHash === snapshot.hash
            : context.characterAvatarId(resource) === characterId ||
              resource.fileName === characterId ||
              resource.name === characterId,
        )
        if (character) ids.add(character.id)
      }
    }
    return Array.from(ids)
  }

  function relatedIdsForSave(backup: SillyTavernPersonaBackup): string[] {
    const context = getContext()

    const previousManagedIds = new Set(
      context.currentBackup.value ? relatedIdsForBackup(context.currentBackup.value) : [],
    )
    for (const resourceId of context.initialAvatarResourceIds.value)
      previousManagedIds.add(resourceId)
    const preservedIds = (context.currentResource.value?.relatedResourceIds ?? []).filter(
      (resourceId) => !previousManagedIds.has(resourceId),
    )
    const avatarResourceIds = Array.from(
      new Set(
        Array.from(context.avatarResourcesByAvatarId.value.values(), (resource) => resource.id),
      ),
    )
    return Array.from(
      new Set([...preservedIds, ...relatedIdsForBackup(backup), ...avatarResourceIds]),
    )
  }

  function coverResourceForBackup(backup: SillyTavernPersonaBackup): Resource | null {
    const context = getContext()

    const defaultAvatarId = parseSillyTavernPersonaBackup(backup).defaultPersona
    return defaultAvatarId
      ? (context.avatarResourcesByAvatarId.value.get(defaultAvatarId) ?? null)
      : null
  }

  async function persistBackup(
    backup: SillyTavernPersonaBackup,
    note: string,
    avatarId?: string,
    preservePreviousVersion = true,
  ): Promise<void> {
    const context = getContext()

    if (!context.currentResource.value) return
    const selectedCharacterId = context.selectedVariantCharacterId.value
    const selectedVersionId = context.selectedVariantVersionId.value
    const page = context.page.value
    await userPersonaService.save(
      context.currentResource.value.id,
      backup,
      relatedIdsForSave(backup),
      note,
      coverResourceForBackup(backup),
      preservePreviousVersion,
    )
    context.emit('library-changed')
    await context.loadResource(context.currentResource.value.id, avatarId)
    if (
      selectedCharacterId &&
      selectedVersionId &&
      context.draft.value.profile.variants[selectedCharacterId]?.versions[selectedVersionId]
    ) {
      context.selectedVariantCharacterId.value = selectedCharacterId
      context.selectedVariantVersionId.value = selectedVersionId
    }
    context.page.value = page
  }

  async function saveDraft(): Promise<void> {
    const context = getContext()

    if (context.saving.value || context.loading.value) return
    context.saving.value = true
    context.errorMessage.value = ''
    context.statusMessage.value = ''
    try {
      const nextDraft: UserPersonaDraft = {
        ...context.draft.value,
        profile: JSON.parse(
          JSON.stringify(context.draft.value.profile),
        ) as UserPersonaDraft['profile'],
        name: context.draft.value.name.trim(),
        title: context.draft.value.title.trim(),
        avatarId: context.draft.value.avatarId.trim(),
        connections: connectionsForSave(),
      }
      const characterBindingIds = new Set([
        ...nextDraft.connections
          .filter((connection) => connection.type === 'character')
          .map((connection) => connection.id),
        ...Object.keys(nextDraft.profile.variants),
      ])
      nextDraft.characterBindings = Object.fromEntries(
        Object.entries(nextDraft.characterBindings).filter(([id]) => characterBindingIds.has(id)),
      )
      for (const character of context.characters.value) {
        if (!context.selectedCharacterIds.value.has(character.id)) continue
        const avatar = context.characterAvatarId(character)
        if (!characterBindingIds.has(avatar)) continue
        nextDraft.characterBindings[avatar] = {
          avatar: character.fileName,
          name: character.name || character.fileName,
          hash: character.contentHash,
        }
      }
      const baseSection = nextDraft.profile.sections[0]
      if (baseSection) baseSection.text = nextDraft.description
      if (!nextDraft.name) throw new Error('人设名称不能为空')
      nextDraft.avatarId = normalizeUserPersonaAvatarId(nextDraft.avatarId)
      const backup = context.creatingPack.value
        ? createEmptyPersonaBackup(nextDraft)
        : context.currentBackup.value
          ? updatePersonaInBackup(
              context.currentBackup.value,
              context.selectedAvatarId.value,
              nextDraft,
            )
          : null
      if (!backup) throw new Error('没有可保存的人设资源')
      let preservePreviousVersion = false
      if (
        !context.creatingPack.value &&
        context.currentBackup.value &&
        serializeSillyTavernPersonaBackup(backup) !==
          serializeSillyTavernPersonaBackup(context.currentBackup.value)
      ) {
        const decision = await chooseAction({
          title: '资源文件版本',
          message:
            '是否将修改前的整份人设文件保留为资源文件版本？这与角色卡下的“人设版本”互相独立。',
          confirmLabel: '不保留旧版并保存',
          alternativeLabel: '保留旧版并保存',
          cancelLabel: '取消保存',
        })
        if (decision === 'cancel') return
        preservePreviousVersion = decision === 'alternative'
      }
      const avatarResource = await context.ensureAvatarCached(nextDraft.avatarId)
      const originalAvatarId = context.creatingPack.value ? '' : context.selectedAvatarId.value
      context.applyAvatarBindingForSave(originalAvatarId, nextDraft.avatarId, avatarResource)

      if (context.creatingPack.value) {
        const resource = await userPersonaService.create(
          nextDraft,
          relatedIdsForSave(backup),
          coverResourceForBackup(backup),
        )
        context.emit('library-changed')
        context.creatingPack.value = false
        context.selectedResourceId.value = resource.id
        await context.loadResource(resource.id, nextDraft.avatarId)
        context.statusMessage.value = '已保存到资源库 · 用户人设'
        return
      }
      if (!context.currentBackup.value || !context.currentResource.value)
        throw new Error('没有可保存的人设资源')
      await persistBackup(backup, '编辑用户人设', nextDraft.avatarId, preservePreviousVersion)
      context.statusMessage.value = '已保存到资源库 · 用户人设'
    } catch (error) {
      context.errorMessage.value = error instanceof Error ? error.message : '保存失败'
    } finally {
      context.saving.value = false
    }
  }

  async function deleteCurrent(): Promise<void> {
    const context = getContext()

    if (!context.currentResource.value || !context.activeEntry.value) return
    const entry = context.activeEntry.value
    if (!entry) return
    const confirmed = await confirmAction({
      title: context.entries.value.length === 1 ? '删除人设资源' : '删除这条用户人设',
      message:
        context.entries.value.length === 1
          ? `“${entry.name}”是文件中的最后一个人设。继续会删除整个资源，资源文件版本仍按资源库规则处理。`
          : `确定从当前人设文件中删除“${entry.name}”吗？修改前文件会收入历史版本。`,
      confirmLabel: '删除',
      danger: true,
    })
    if (!confirmed) return
    if (context.saving.value || context.loading.value) return
    context.saving.value = true
    try {
      if (context.entries.value.length === 1) {
        await recycleBinService.moveToRecycleBin([context.currentResource.value.id])
        context.emit('library-changed')
        context.selectedResourceId.value = ''
        context.currentResource.value = null
        context.currentBackup.value = null
        context.page.value = 'list'
        context.statusMessage.value = '用户人设资源已删除'
      } else if (context.currentBackup.value) {
        const nextAvatars = new Map(context.avatarResourcesByAvatarId.value)
        nextAvatars.delete(entry.avatarId)
        context.avatarResourcesByAvatarId.value = nextAvatars
        await persistBackup(
          removePersonaFromBackup(context.currentBackup.value, entry.avatarId),
          '删除用户人设',
        )
        context.statusMessage.value = '已删除人设，修改前文件已收入历史版本'
      }
    } catch (error) {
      context.errorMessage.value = error instanceof Error ? error.message : '删除失败'
    } finally {
      context.saving.value = false
    }
  }

  async function importPersonaFiles(event: Event): Promise<void> {
    const context = getContext()

    const input = event.target as HTMLInputElement
    const files = Array.from(input.files ?? [])
    input.value = ''
    if (!files.length) return
    context.loading.value = true
    context.errorMessage.value = ''
    try {
      const report = await userPersonaService.importFiles(files)
      context.emit('library-changed')
      context.statusMessage.value = `已导入 ${report.imported} 份，跳过重复 ${report.duplicates} 份`
      if (report.failed.length) {
        context.errorMessage.value = report.failed
          .map((item) => `${item.fileName}：${item.message}`)
          .join('；')
      }
    } catch (error) {
      context.errorMessage.value = error instanceof Error ? error.message : '用户人设导入失败'
    } finally {
      context.loading.value = false
    }
  }

  return { connectionsForSave, saveDraft, deleteCurrent, importPersonaFiles }
}
