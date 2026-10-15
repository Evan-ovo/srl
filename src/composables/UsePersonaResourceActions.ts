import { toRaw } from 'vue'

import { confirmAction } from './UseConfirmDialog'

import { recycleBinService, userPersonaService, resourceService } from '../core/AppContainer'

import { parseSillyTavernPersonaBackup } from '../parser/SillyTavernPersonaBackup'

import {
  getRelatedResourceIds,
  getResourceCategoryIds,
  RESOURCE_TYPE,
  type Resource,
  type ResourceSummary,
} from '../types/Resource'

import {
  type SillyTavernPersonaBackup,
  type UserPersonaDraft,
  type UserPersonaEntry,
} from '../types/UserPersona'

import { createUserPersonaVariantVersion } from '../utils/UserPersonaProfile'

export interface UsePersonaResourceActionsContext {
  selectedAvatarId: import('vue').Ref<string, string>
  draft: import('vue').Ref<
    {
      avatarId: string
      name: string
      title: string
      description: string
      position: number
      depth: number
      role: number
      lorebook: string
      connections: { type: import('../types/UserPersona').UserPersonaConnectionType; id: string }[]
      characterBindings: Record<
        string,
        import('../types/UserPersona').UserPersonaCharacterBindingSnapshot
      >
      profile: {
        version: 1
        sections: { id: string; name: string; text: string }[]
        variants: Record<string, import('../types/UserPersona').UserPersonaCharacterVariant>
      }
    },
    | UserPersonaDraft
    | {
        avatarId: string
        name: string
        title: string
        description: string
        position: number
        depth: number
        role: number
        lorebook: string
        connections: {
          type: import('../types/UserPersona').UserPersonaConnectionType
          id: string
        }[]
        characterBindings: Record<
          string,
          import('../types/UserPersona').UserPersonaCharacterBindingSnapshot
        >
        profile: {
          version: 1
          sections: { id: string; name: string; text: string }[]
          variants: Record<string, import('../types/UserPersona').UserPersonaCharacterVariant>
        }
      }
  >
  selectedWorldBookId: import('vue').Ref<string, string>
  worldBooks: import('vue').ComputedRef<import('../types/Resource').ResourceSummary[]>
  fileBaseName: (value: string) => string
  selectedCharacterIds: import('vue').Ref<Set<string>>
  characters: import('vue').ComputedRef<import('../types/Resource').ResourceSummary[]>
  characterAvatarId: (resource: import('../types/Resource').ResourceSummary) => string
  profileCharacters: import('vue').ComputedRef<{ id: string; name: string }[]>
  selectedVariantCharacterId: import('vue').Ref<string, string>
  selectedVariantVersionId: import('vue').Ref<string, string>
  setPendingAvatar: (file: File | null) => void
  avatarResourcesByAvatarId: import('vue').Ref<Map<string, Resource>>
  setCachedAvatar: (resource: Resource | null) => void
  avatarSourceUrl: import('vue').Ref<string, string>
  avatarSourceOf: (resource: Resource) => string
  originalDraftSignature: import('vue').Ref<string, string>
  editorSignature: () => string
  loadAvatarResources: (resourceIds: string[]) => Promise<void>
  currentResource: import('vue').Ref<
    {
      id: string
      type: import('../types/Resource').ResourceType
      name: string
      description: string
      fileName: string
      mimeType: string
      fileSize: number
      contentHash: string
      backupDescriptor?:
        | {
            version: 1 | 2
            resourceId: string
            contentHash: string
            size: number
            updatedAt: number
            parts?:
              | {
                  name: string
                  offset: number
                  size: number
                  sha256: string
                  storedSize?: number | undefined
                  storage?:
                    | {
                        kind: 'github-release' | 'koofr-path'
                        container: string
                        objectKey: string
                      }
                    | undefined
                }[]
              | undefined
          }
        | undefined
      favorite: boolean
      categoryId: string | null
      categoryIds?: string[] | undefined
      relatedResourceIds?: string[] | undefined
      sourceLinks?:
        | {
            id: string
            label: string
            url: string
            type: import('../types/Resource').ResourceLinkType
            note?: string | undefined
            createdAt: number
            purpose?: import('../types/Resource').ResourceLinkPurpose | undefined
            installTarget?: import('../types/Resource').ResourceInstallTarget | undefined
            trustMode?: import('../types/Resource').ResourceLinkTrustMode | undefined
            versionRef?:
              { kind: 'branch' | 'tag' | 'commit' | 'release'; value: string } | undefined
            github?:
              | {
                  owner: string
                  repo: string
                  path?: string | undefined
                  releaseTag?: string | undefined
                  assetName?: string | undefined
                }
              | undefined
          }[]
        | undefined
      tags: string[]
      metadata: Record<string, unknown>
      versionGroupId?: string | undefined
      versionImportedAt?: number | undefined
      versionLabel?: string | undefined
      versionNote?: string | undefined
      versionCount?: number | undefined
      thumbnailAssetId?: string | undefined
      thumbnailBlob?:
        | {
            readonly size: number
            readonly type: string
            arrayBuffer: { (): Promise<ArrayBuffer>; (): Promise<ArrayBuffer> }
            bytes: { (): Promise<Uint8Array<ArrayBuffer>>; (): Promise<Uint8Array<ArrayBuffer>> }
            slice: {
              (start?: number, end?: number, contentType?: string): Blob
              (start?: number, end?: number, contentType?: string): Blob
            }
            stream: {
              (): ReadableStream<Uint8Array<ArrayBuffer>>
              (): ReadableStream<Uint8Array<ArrayBuffer>>
            }
            text: { (): Promise<string>; (): Promise<string> }
          }
        | undefined
      originalBlob: {
        readonly size: number
        readonly type: string
        arrayBuffer: { (): Promise<ArrayBuffer>; (): Promise<ArrayBuffer> }
        bytes: { (): Promise<Uint8Array<ArrayBuffer>>; (): Promise<Uint8Array<ArrayBuffer>> }
        slice: {
          (start?: number, end?: number, contentType?: string): Blob
          (start?: number, end?: number, contentType?: string): Blob
        }
        stream: {
          (): ReadableStream<Uint8Array<ArrayBuffer>>
          (): ReadableStream<Uint8Array<ArrayBuffer>>
        }
        text: { (): Promise<string>; (): Promise<string> }
      }
      createdAt: number
      updatedAt: number
    } | null,
    | Resource
    | {
        id: string
        type: import('../types/Resource').ResourceType
        name: string
        description: string
        fileName: string
        mimeType: string
        fileSize: number
        contentHash: string
        backupDescriptor?:
          | {
              version: 1 | 2
              resourceId: string
              contentHash: string
              size: number
              updatedAt: number
              parts?:
                | {
                    name: string
                    offset: number
                    size: number
                    sha256: string
                    storedSize?: number | undefined
                    storage?:
                      | {
                          kind: 'github-release' | 'koofr-path'
                          container: string
                          objectKey: string
                        }
                      | undefined
                  }[]
                | undefined
            }
          | undefined
        favorite: boolean
        categoryId: string | null
        categoryIds?: string[] | undefined
        relatedResourceIds?: string[] | undefined
        sourceLinks?:
          | {
              id: string
              label: string
              url: string
              type: import('../types/Resource').ResourceLinkType
              note?: string | undefined
              createdAt: number
              purpose?: import('../types/Resource').ResourceLinkPurpose | undefined
              installTarget?: import('../types/Resource').ResourceInstallTarget | undefined
              trustMode?: import('../types/Resource').ResourceLinkTrustMode | undefined
              versionRef?:
                { kind: 'branch' | 'tag' | 'commit' | 'release'; value: string } | undefined
              github?:
                | {
                    owner: string
                    repo: string
                    path?: string | undefined
                    releaseTag?: string | undefined
                    assetName?: string | undefined
                  }
                | undefined
            }[]
          | undefined
        tags: string[]
        metadata: Record<string, unknown>
        versionGroupId?: string | undefined
        versionImportedAt?: number | undefined
        versionLabel?: string | undefined
        versionNote?: string | undefined
        versionCount?: number | undefined
        thumbnailAssetId?: string | undefined
        thumbnailBlob?:
          | {
              readonly size: number
              readonly type: string
              arrayBuffer: { (): Promise<ArrayBuffer>; (): Promise<ArrayBuffer> }
              bytes: { (): Promise<Uint8Array<ArrayBuffer>>; (): Promise<Uint8Array<ArrayBuffer>> }
              slice: {
                (start?: number, end?: number, contentType?: string): Blob
                (start?: number, end?: number, contentType?: string): Blob
              }
              stream: {
                (): ReadableStream<Uint8Array<ArrayBuffer>>
                (): ReadableStream<Uint8Array<ArrayBuffer>>
              }
              text: { (): Promise<string>; (): Promise<string> }
            }
          | undefined
        originalBlob: {
          readonly size: number
          readonly type: string
          arrayBuffer: { (): Promise<ArrayBuffer>; (): Promise<ArrayBuffer> }
          bytes: { (): Promise<Uint8Array<ArrayBuffer>>; (): Promise<Uint8Array<ArrayBuffer>> }
          slice: {
            (start?: number, end?: number, contentType?: string): Blob
            (start?: number, end?: number, contentType?: string): Blob
          }
          stream: {
            (): ReadableStream<Uint8Array<ArrayBuffer>>
            (): ReadableStream<Uint8Array<ArrayBuffer>>
          }
          text: { (): Promise<string>; (): Promise<string> }
        }
        createdAt: number
        updatedAt: number
      }
    | null
  >
  currentBackup: import('vue').Ref<
    {
      [x: string]: unknown
      personas: Record<string, unknown>
      persona_descriptions: Record<string, unknown>
      default_persona?: unknown
    } | null,
    | SillyTavernPersonaBackup
    | {
        [x: string]: unknown
        personas: Record<string, unknown>
        persona_descriptions: Record<string, unknown>
        default_persona?: unknown
      }
    | null
  >
  currentWarnings: import('vue').Ref<string[], string[]>
  selectedResourceId: import('vue').Ref<string, string>
  creatingPack: import('vue').Ref<boolean, boolean>
  selectEntry: (entry: UserPersonaEntry) => void
  busy: import('vue').ComputedRef<boolean>
  loading: import('vue').Ref<boolean, boolean>
  errorMessage: import('vue').Ref<string, string>
  statusMessage: import('vue').Ref<string, string>
  loadResource: (resourceId: string, preferredAvatarId?: string) => Promise<void>
  resetPanels: () => void
  page: import('vue').Ref<
    'versions' | 'list' | 'profile-sections' | 'character-picker' | 'editor',
    'versions' | 'list' | 'profile-sections' | 'character-picker' | 'editor'
  >
  editorMode: import('vue').Ref<'global' | 'variant', 'global' | 'variant'>
  emit: ((event: 'back') => void) &
    ((event: 'library-changed') => void) &
    ((event: 'open-history', resource: import('../types/Resource').ResourceSummary) => void)
  transferOpen: import('vue').Ref<boolean, boolean>
  personaVariantCharacters: import('vue').ComputedRef<{ id: string; name: string }[]>
  isDirty: import('vue').ComputedRef<boolean>
  saving: import('vue').Ref<boolean, boolean>
  activeCharacterVariant: import('vue').ComputedRef<
    import('../types/UserPersona').UserPersonaCharacterVariant
  >
  descriptionInput: import('vue').Ref<HTMLTextAreaElement | null, HTMLTextAreaElement | null>
  deleteVariantVersion: () => Promise<void>
  activeProfileVariant: import('vue').ComputedRef<
    import('../types/UserPersona').UserPersonaCharacterVariantVersion
  >
}
export function selectEntry(
  operations: UsePersonaResourceActionsContext,
  entry: UserPersonaEntry,
): void {
  operations.selectedAvatarId.value = entry.avatarId
  operations.draft.value = {
    avatarId: entry.avatarId,
    name: entry.name,
    title: entry.title,
    description: entry.profile.sections[0]?.text ?? entry.description,
    position: entry.position,
    depth: entry.depth,
    role: entry.role,
    lorebook: entry.lorebook,
    connections: entry.connections.map((c) => ({ ...c })),
    characterBindings: structuredClone(entry.characterBindings),
    profile: structuredClone(entry.profile),
  }
  operations.selectedWorldBookId.value =
    operations.worldBooks.value.find(
      (r) => r.name === entry.lorebook || operations.fileBaseName(r.fileName) === entry.lorebook,
    )?.id ?? ''
  operations.selectedCharacterIds.value = new Set(
    operations.characters.value
      .filter((r) =>
        [
          ...entry.connections
            .filter((connection) => connection.type === 'character')
            .map((c) => c.id),
          ...Object.keys(entry.profile.variants),
        ].some((id) => {
          const snapshot = entry.characterBindings[id]
          if (snapshot) return snapshot.hash === r.contentHash
          return [operations.characterAvatarId(r), r.fileName, r.name].includes(id)
        }),
      )
      .map((r) => r.id),
  )
  if (
    !operations.profileCharacters.value.some(
      (character) => character.id === operations.selectedVariantCharacterId.value,
    )
  )
    operations.selectedVariantCharacterId.value = operations.profileCharacters.value[0]?.id ?? ''
  operations.selectedVariantVersionId.value =
    operations.draft.value.profile.variants[operations.selectedVariantCharacterId.value]
      ?.defaultVersionId ?? ''
  operations.setPendingAvatar(null)
  const avatar = operations.avatarResourcesByAvatarId.value.get(entry.avatarId) ?? null
  operations.setCachedAvatar(avatar)
  operations.avatarSourceUrl.value = avatar ? operations.avatarSourceOf(avatar) : ''
  operations.originalDraftSignature.value = operations.editorSignature()
}

export async function loadResource(
  operations: UsePersonaResourceActionsContext,
  resourceId: string,
  preferredAvatarId = operations.selectedAvatarId.value,
): Promise<void> {
  const loaded = await userPersonaService.load(resourceId)
  await operations.loadAvatarResources(loaded.resource.relatedResourceIds ?? [])
  operations.currentResource.value = loaded.resource
  operations.currentBackup.value = loaded.view.raw
  operations.currentWarnings.value = loaded.view.warnings
  operations.selectedResourceId.value = resourceId
  operations.creatingPack.value = false
  const entry =
    loaded.view.entries.find((e) => e.avatarId === preferredAvatarId) ??
    loaded.view.entries.find((e) => e.avatarId === loaded.view.defaultPersona) ??
    loaded.view.entries[0]
  if (!entry) throw new Error('这份文件没有可编辑的人设')
  operations.selectEntry(entry)
}

export async function openResource(
  operations: UsePersonaResourceActionsContext,
  resourceId: string,
): Promise<void> {
  if (operations.busy.value) return
  operations.loading.value = true
  operations.errorMessage.value = ''
  operations.statusMessage.value = ''
  try {
    await operations.loadResource(resourceId, '')
    operations.resetPanels()
    if (Object.keys(operations.draft.value.profile.variants).length)
      operations.page.value = 'profile-sections'
    else {
      operations.editorMode.value = 'global'
      operations.page.value = 'editor'
    }
  } catch (error) {
    operations.errorMessage.value = error instanceof Error ? error.message : '读取失败'
  } finally {
    operations.loading.value = false
  }
}

export async function importTransferredFiles(
  operations: UsePersonaResourceActionsContext,
  files: File[],
  onComplete?: () => void,
): Promise<void> {
  operations.loading.value = true
  operations.errorMessage.value = ''
  try {
    // The shared transfer page can also select other resource types; keep the common importer.
    const results = await resourceService.importFiles(files, { detectVersions: false })
    const failed = results.filter((r) => r.status === 'failed')
    const bindingErrors: string[] = []
    // Only hash-based persona bindings need a catalogue; share one read (including failure)
    // within this transfer, so an unrelated file never scans the library.
    let summaries: Promise<ResourceSummary[]> | undefined
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index]
      const file = files[index]
      if (!result || result.status === 'failed' || result.status === 'versionCandidate' || !file)
        continue
      if (result.resource.type !== RESOURCE_TYPE.USER_PERSONA) continue
      try {
        const view = parseSillyTavernPersonaBackup(JSON.parse(await file.text()))
        const hashes = new Set(
          view.entries.flatMap((entry) =>
            Object.values(entry.characterBindings).map((binding) => binding.hash),
          ),
        )
        if (!hashes.size) continue
        const matchedIds = (await (summaries ??= resourceService.listResourceListSummaries()))
          .filter(
            (resource) =>
              resource.type === RESOURCE_TYPE.CHARACTER_CARD && hashes.has(resource.contentHash),
          )
          .map((resource) => resource.id)
        if (!matchedIds.length) continue
        const currentIds = getRelatedResourceIds(result.resource)
        const relatedResourceIds = Array.from(new Set([...currentIds, ...matchedIds]))
        if (relatedResourceIds.length === currentIds.length) continue
        await resourceService.updateDetails(result.resource, {
          name: result.resource.name,
          description: result.resource.description,
          type: result.resource.type,
          categoryIds: getResourceCategoryIds(result.resource),
          relatedResourceIds,
          tags: result.resource.tags,
          sourceLinks: result.resource.sourceLinks,
        })
      } catch (error) {
        bindingErrors.push(
          `${file.name} 已接收，但角色卡关系未能更新：${error instanceof Error ? error.message : '未知错误'}`,
        )
      }
    }
    operations.emit('library-changed')
    operations.errorMessage.value = [
      ...failed.map((r) => (r.status === 'failed' ? r.message : '')),
      ...bindingErrors,
    ]
      .filter(Boolean)
      .join('；')
    operations.statusMessage.value = `已接收 ${results.filter((r) => r.status === 'imported').length} 项，跳过重复 ${results.filter((r) => r.status === 'duplicate').length} 项`
    operations.transferOpen.value = false
    operations.page.value = 'list'
  } catch (error) {
    operations.errorMessage.value = error instanceof Error ? error.message : '接收失败'
    operations.transferOpen.value = false
  } finally {
    operations.loading.value = false
    onComplete?.()
  }
}

export async function deleteProfileCharacter(
  operations: UsePersonaResourceActionsContext,
  characterId: string,
): Promise<void> {
  const variant = operations.draft.value.profile.variants[characterId]
  if (!variant) return
  const character = operations.personaVariantCharacters.value.find(
    (item) => item.id === characterId,
  )
  const characterName = character?.name ?? characterId
  const versionCount = Object.keys(variant.versions).length
  const resourceId = operations.currentResource.value?.id
  const avatarId = operations.selectedAvatarId.value
  if (!resourceId || !avatarId) return
  const unsavedNote = operations.isDirty.value ? '当前未保存的草稿修改会被丢弃。' : ''
  if (
    !(await confirmAction({
      title: '删除角色卡人设',
      message: `将“${characterName}”的专属人设及 ${versionCount} 个版本移入回收站？不影响全局人设或其他角色卡。${unsavedNote}可在“数据保护 → 回收站”恢复。`,
      confirmLabel: '移入回收站',
      danger: true,
    }))
  )
    return
  operations.saving.value = true
  operations.errorMessage.value = ''
  operations.statusMessage.value = ''
  try {
    await recycleBinService.movePersonaCharacterToRecycleBin({
      resourceId,
      avatarId,
      characterId,
      characterName,
    })
    operations.emit('library-changed')
    await operations.loadResource(resourceId, avatarId)
    operations.selectedVariantCharacterId.value = ''
    operations.selectedVariantVersionId.value = ''
    operations.page.value = Object.keys(operations.draft.value.profile.variants).length
      ? 'profile-sections'
      : 'editor'
    operations.editorMode.value = 'global'
    operations.statusMessage.value = `“${characterName}”的专属人设已移入回收站，可在“数据保护 → 回收站”恢复。`
  } catch (error) {
    operations.errorMessage.value = error instanceof Error ? error.message : '移入回收站失败'
  } finally {
    operations.saving.value = false
  }
}

export function openVariantVersion(
  operations: UsePersonaResourceActionsContext,
  versionId: string,
): void {
  if (!operations.activeCharacterVariant.value?.versions[versionId]) return
  operations.selectedVariantVersionId.value = versionId
  operations.editorMode.value = 'variant'
  operations.descriptionInput.value = null
  operations.page.value = 'editor'
}

export function setDefaultVariantVersion(
  operations: UsePersonaResourceActionsContext,
  versionId: string,
): void {
  const variant = operations.activeCharacterVariant.value
  if (variant?.versions[versionId]) variant.defaultVersionId = versionId
}

export function addVariantVersion(operations: UsePersonaResourceActionsContext): void {
  if (operations.busy.value) return
  const variant = operations.activeCharacterVariant.value
  if (!variant) return
  const versionId = `version-${crypto.randomUUID()}`
  const current =
    variant.versions[operations.selectedVariantVersionId.value] ??
    variant.versions[variant.defaultVersionId]
  variant.versions[versionId] = current
    ? structuredClone({ ...toRaw(current), name: '新版本' })
    : createUserPersonaVariantVersion('新版本')
  variant.versions[versionId]!.name = '新版本'
  operations.selectedVariantVersionId.value = versionId
  operations.editorMode.value = 'variant'
  operations.descriptionInput.value = null
  operations.page.value = 'editor'
}

export function deleteVersionFromList(
  operations: UsePersonaResourceActionsContext,
  versionId: string,
): void {
  operations.selectedVariantVersionId.value = versionId
  void operations.deleteVariantVersion()
}

export async function deleteVariantVersion(
  operations: UsePersonaResourceActionsContext,
): Promise<void> {
  const variant = operations.activeCharacterVariant.value
  const version = operations.activeProfileVariant.value
  if (!variant || !version) return
  const remainingCount = Object.keys(variant.versions).length - 1
  const followUp =
    remainingCount === 0 ? '这张角色卡将不再有专属人设。' : `删除后还剩 ${remainingCount} 个版本。`
  const unsavedNote = operations.isDirty.value ? '当前未保存的草稿修改会被丢弃。' : ''
  if (
    !(await confirmAction({
      title: '删除角色人设版本',
      message: `将“${version.name}”移入回收站？${followUp}${unsavedNote}可在“数据保护 → 回收站”恢复。`,
      confirmLabel: '移入回收站',
      danger: true,
    }))
  )
    return
  const resourceId = operations.currentResource.value?.id
  const avatarId = operations.selectedAvatarId.value
  const characterId = operations.selectedVariantCharacterId.value
  const versionId = operations.selectedVariantVersionId.value
  if (!resourceId || !avatarId || !characterId || !versionId) return

  operations.saving.value = true
  operations.errorMessage.value = ''
  operations.statusMessage.value = ''
  try {
    await recycleBinService.movePersonaVersionToRecycleBin({
      resourceId,
      avatarId,
      characterId,
      versionId,
      characterName:
        operations.personaVariantCharacters.value.find((item) => item.id === characterId)?.name ??
        characterId,
    })
    operations.emit('library-changed')
    await operations.loadResource(resourceId, avatarId)
    const refreshedVariant = operations.draft.value.profile.variants[characterId]
    if (refreshedVariant) {
      operations.selectedVariantCharacterId.value = characterId
      operations.selectedVariantVersionId.value = refreshedVariant.defaultVersionId
      operations.page.value = 'versions'
    } else {
      operations.page.value = 'profile-sections'
    }
    operations.statusMessage.value = `“${version.name}”已移入回收站，可在“数据保护 → 回收站”恢复。`
  } catch (error) {
    operations.errorMessage.value = error instanceof Error ? error.message : '移入回收站失败'
  } finally {
    operations.saving.value = false
  }
}
