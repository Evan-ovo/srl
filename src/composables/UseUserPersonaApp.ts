import {
  selectEntry as selectEntryOperation,
  loadResource as loadResourceOperation,
  openResource as openResourceOperation,
  importTransferredFiles as importTransferredFilesOperation,
  deleteProfileCharacter as deleteProfileCharacterOperation,
  openVariantVersion as openVariantVersionOperation,
  setDefaultVariantVersion as setDefaultVariantVersionOperation,
  addVariantVersion as addVariantVersionOperation,
  deleteVersionFromList as deleteVersionFromListOperation,
  deleteVariantVersion as deleteVariantVersionOperation,
  type UsePersonaResourceActionsContext,
} from './UsePersonaResourceActions'
import type { EmitFn } from 'vue'
import { computed, nextTick, onBeforeUnmount, ref, useTemplateRef, watch } from 'vue'
import type { ActionSheetAction } from '../components/ActionSheet.vue'
import { chooseAction, confirmAction } from './UseConfirmDialog'
import { browserStorageService } from '../core/AppContainer'
import { dirtyStateRegistry } from '../core/DirtyStateRegistry'
import { SRL_BACK_REQUEST_EVENT, type SrlBackRequestDetail } from './UseBackStack'
import { parseSillyTavernPersonaBackup } from '../parser/SillyTavernPersonaBackup'
import { getResourceCategoryIds, RESOURCE_TYPE, type Resource } from '../types/Resource'
import {
  USER_PERSONA_POSITIONS,
  USER_PERSONA_ROLES,
  type SillyTavernPersonaBackup,
  type UserPersonaDraft,
  type UserPersonaConnection,
  type UserPersonaEntry,
  type UserPersonaSectionOverride,
  type UserPersonaTemplate,
} from '../types/UserPersona'
import type { UserPersonaAppEvents, UserPersonaAppProps } from '../types/UserPersonaAppView'
import { USER_PERSONA_TEMPLATES } from '../utils/UserPersonaManagement'
import { usePersonaAvatarEditing } from './UsePersonaAvatarEditing'
import { usePersonaResourceDelivery } from './UsePersonaResourceDelivery'
import {
  createUserPersonaCharacterVariant,
  createUserPersonaProfile,
  compareUserPersonaVersions,
  resolveUserPersonaProfile,
} from '../utils/UserPersonaProfile'

export type { UserPersonaAppEvents, UserPersonaAppProps } from '../types/UserPersonaAppView'

export function useUserPersonaApp(
  props: Readonly<UserPersonaAppProps>,
  emit: EmitFn<UserPersonaAppEvents>,
) {
  const page = ref<'list' | 'profile-sections' | 'versions' | 'character-picker' | 'editor'>('list')
  const transferOpen = ref(false)
  const selectedResourceId = ref('')
  const selectedAvatarId = ref('')
  const currentResource = ref<Resource | null>(null)
  const currentBackup = ref<SillyTavernPersonaBackup | null>(null)
  const currentWarnings = ref<string[]>([])
  const draft = ref<UserPersonaDraft>(createDraft())
  const originalDraftSignature = ref('')
  const avatarSourceUrl = ref('')
  const cachedAvatarResource = ref<Resource | null>(null)
  const pendingAvatarFile = ref<File | null>(null)
  const cachedAvatarPreview = ref('')
  const pendingAvatarPreview = ref('')
  const avatarPreviewFailed = ref(false)
  const avatarResourcesByAvatarId = ref<Map<string, Resource>>(new Map())
  const initialAvatarResourceIds = ref(new Set<string>())
  const selectedWorldBookId = ref('')
  const selectedCharacterIds = ref(new Set<string>())
  const selectedVariantCharacterId = ref('')
  const selectedVariantVersionId = ref('')
  const characterCategoryFilter = ref('all')
  const characterSearchQuery = ref('')
  const searchQuery = ref('')
  const listLimit = ref(30)
  const selectedTemplateId = ref('blank')
  const customTemplates = ref<UserPersonaTemplate[]>(
    browserStorageService.getUserPersonaTemplates(),
  )
  const customTemplateName = ref('')
  const creatingTemplate = ref(false)
  const showTemplates = ref(false)
  const showAdvanced = ref(false)
  const loading = ref(false)
  const saving = ref(false)
  const creatingPack = ref(false)
  const statusMessage = ref('')
  const errorMessage = ref('')
  const headerMoreOpen = ref(false)
  const importInput = useTemplateRef<HTMLInputElement>('importInput')
  const avatarInput = useTemplateRef<HTMLInputElement>('avatarInput')
  const descriptionInput = ref<HTMLTextAreaElement | null>(null)
  const busy = computed(() => loading.value || saving.value)
  const {
    revokePreview,
    setCachedAvatar,
    setPendingAvatar,
    clearAvatarEditor,
    avatarSourceOf,
    loadAvatarResources,
    fileBaseName,
    characterAvatarId,
    ensureAvatarCached,
    onAvatarFileChange,
    onAvatarUrlInput,
    chooseAvatarImage,
    removeAvatarBinding,
    applyAvatarBindingForSave,
  } = usePersonaAvatarEditing(() => ({
    cachedAvatarPreview,
    cachedAvatarResource,
    avatarPreviewFailed,
    pendingAvatarPreview,
    pendingAvatarFile,
    avatarSourceUrl,
    avatarResourcesByAvatarId,
    initialAvatarResourceIds,
    emit,
    errorMessage,
    statusMessage,
    avatarInput,
    draft,
  }))
  const { connectionsForSave, saveDraft, deleteCurrent, importPersonaFiles } =
    usePersonaResourceDelivery(() => ({
      characters,
      characterAvatarId,
      draft,
      selectedCharacterIds,
      worldBooks,
      fileBaseName,
      currentBackup,
      initialAvatarResourceIds,
      currentResource,
      avatarResourcesByAvatarId,
      emit,
      loadResource,
      saving,
      errorMessage,
      statusMessage,
      ensureAvatarCached,
      creatingPack,
      selectedAvatarId,
      selectedVariantCharacterId,
      selectedVariantVersionId,
      applyAvatarBindingForSave,
      selectedResourceId,
      activeEntry,
      entries,
      page,
      loading,
    }))
  const personaResources = computed(() =>
    props.resources
      .filter((r) => r.type === RESOURCE_TYPE.USER_PERSONA)
      .sort((a, b) => b.updatedAt - a.updatedAt),
  )
  const filteredResources = computed(() => {
    const query = searchQuery.value.trim().toLocaleLowerCase()
    return personaResources.value.filter(
      (r) =>
        !query ||
        `${r.name}\n${r.metadata.personaNames ?? ''}\n${r.metadata.personaNativeCharacterNames ?? ''}\n${r.metadata.personaProfileCharacterNames ?? ''}\n${r.tags.join(' ')}`
          .toLocaleLowerCase()
          .includes(query),
    )
  })
  const visibleResources = computed(() => filteredResources.value.slice(0, listLimit.value))
  watch(searchQuery, () => {
    listLimit.value = 30
  })
  const worldBooks = computed(() =>
    props.resources.filter((r) => r.type === RESOURCE_TYPE.WORLD_BOOK),
  )
  const characters = computed(() =>
    props.resources.filter((r) => r.type === RESOURCE_TYPE.CHARACTER_CARD),
  )
  const profileCharacters = computed(() =>
    characters.value
      .map((resource) => ({
        id: characterAvatarId(resource),
        name: resource.name || resource.fileName,
      }))
      .filter((character) => character.id),
  )
  const activeCharacterVariant = computed(
    () => draft.value.profile.variants[selectedVariantCharacterId.value],
  )
  const activeProfileVariant = computed(
    () => activeCharacterVariant.value?.versions[selectedVariantVersionId.value],
  )
  const resolvedProfilePreview = computed(() =>
    resolveUserPersonaProfile(
      draft.value.profile,
      editorMode.value === 'variant' ? selectedVariantCharacterId.value : '',
      editorMode.value === 'variant' ? selectedVariantVersionId.value : undefined,
    ),
  )
  const versionComparison = computed(() =>
    compareUserPersonaVersions(
      draft.value.profile,
      selectedVariantCharacterId.value,
      activeCharacterVariant.value?.defaultVersionId ?? '',
      selectedVariantVersionId.value,
    ),
  )
  const isDefaultVariantVersion = computed(
    () => activeCharacterVariant.value?.defaultVersionId === selectedVariantVersionId.value,
  )
  const backLabel = computed(() => {
    if (page.value === 'list') return '返回功能桌面'
    if (page.value === 'versions') return '返回人设内容'
    if (page.value === 'character-picker') return '返回添加前的页面'
    if (page.value === 'editor' && editorMode.value === 'variant')
      return activeVariantVersions.value.length > 1 ? '返回版本列表' : '返回人设内容'
    return Object.keys(draft.value.profile.variants).length && page.value === 'editor'
      ? '返回人设内容'
      : '返回人设列表'
  })
  const textTargetLabel = computed(() =>
    editorMode.value === 'variant' ? '角色专属补充' : '全局人设',
  )
  const selectedVariantCharacter = computed(
    () =>
      profileCharacters.value.find((item) => item.id === selectedVariantCharacterId.value) ??
      (selectedVariantCharacterId.value
        ? {
            id: selectedVariantCharacterId.value,
            name:
              draft.value.characterBindings[selectedVariantCharacterId.value]?.name ??
              selectedVariantCharacterId.value.replace(/\.png$/i, ''),
          }
        : undefined),
  )
  const personaVariantCharacters = computed(() =>
    Object.keys(draft.value.profile.variants).map(
      (id) =>
        profileCharacters.value.find((character) => character.id === id) ?? {
          id,
          name: draft.value.characterBindings[id]?.name ?? id,
        },
    ),
  )
  const activeVariantVersions = computed(() =>
    Object.entries(activeCharacterVariant.value?.versions ?? {}).map(([id, version]) => ({
      id,
      ...version,
    })),
  )
  const filteredCharacters = computed(() => {
    const query = characterSearchQuery.value.trim().toLocaleLowerCase()
    return characters.value.filter(
      (r) =>
        (characterCategoryFilter.value === 'all' ||
          getResourceCategoryIds(r).includes(characterCategoryFilter.value)) &&
        (!query ||
          `${r.name}\n${r.fileName}\n${r.tags.join(' ')}\n${getResourceCategoryIds(r)
            .map((id) => props.categories.find((category) => category.id === id)?.name ?? '')
            .join(' ')}`
            .toLocaleLowerCase()
            .includes(query)),
    )
  })
  const addableProfileCharacters = computed(() =>
    filteredCharacters.value.filter((resource) => {
      const id = characterAvatarId(resource)
      return id && !draft.value.profile.variants[id]
    }),
  )
  const entries = computed(() =>
    currentBackup.value ? parseSillyTavernPersonaBackup(currentBackup.value).entries : [],
  )
  const activeEntry = computed(() =>
    entries.value.find((e) => e.avatarId === selectedAvatarId.value),
  )
  const selectedCustomTemplate = computed(() =>
    customTemplates.value.find((t) => t.id === selectedTemplateId.value),
  )
  const unresolvedConnections = computed(() =>
    draft.value.connections.filter(
      (c) =>
        c.type === 'group' ||
        !characters.value.some((r) => {
          const snapshot = draft.value.characterBindings[c.id]
          return snapshot
            ? r.contentHash === snapshot.hash
            : [characterAvatarId(r), r.fileName, r.name].includes(c.id)
        }),
    ),
  )
  function removeUnresolvedConnection(connection: UserPersonaConnection): void {
    draft.value.connections = draft.value.connections.filter(
      (item) => item.type !== connection.type || item.id !== connection.id,
    )
  }
  const avatarPreviewUrl = computed(() => {
    if (pendingAvatarPreview.value) return pendingAvatarPreview.value
    const source = avatarSourceUrl.value.trim()
    if (
      source &&
      source !== cachedAvatarResource.value?.metadata.sourceUrl &&
      /^https:\/\//i.test(source)
    )
      return source
    return cachedAvatarPreview.value || (/^https:\/\//i.test(source) ? source : '')
  })
  const isDirty = computed(
    () =>
      page.value !== 'list' &&
      !!selectedAvatarId.value &&
      editorSignature() !== originalDraftSignature.value,
  )
  const headerMoreActions = computed<ActionSheetAction[]>(() =>
    page.value === 'list'
      ? [{ id: 'import', label: '导入人设 JSON' }]
      : page.value === 'editor' && editorMode.value === 'global'
        ? [
            { id: 'add-character-profile', label: '增加角色卡专属人设' },
            ...(currentResource.value
              ? [
                  { id: 'history', label: '查看历史版本' },
                  { id: 'transfer', label: '发送整份人设文件到酒馆' },
                  { id: 'delete', label: '删除当前人设', danger: true },
                ]
              : []),
          ]
        : page.value === 'editor' && editorMode.value === 'variant'
          ? [
              { id: 'add-variant-version', label: '增加其他版本' },
              { id: 'delete-variant-version', label: '移入回收站', danger: true },
            ]
          : page.value === 'profile-sections'
            ? [
                { id: 'history', label: '查看资源文件版本' },
                { id: 'transfer', label: '发送整份人设文件到酒馆' },
              ]
            : [],
  )
  const editorMode = ref<'global' | 'variant'>('global')

  function createDraft(): UserPersonaDraft {
    return {
      avatarId: `persona-${crypto.randomUUID()}.png`,
      name: '',
      title: '',
      description: '',
      position: USER_PERSONA_POSITIONS.IN_PROMPT,
      depth: 2,
      role: USER_PERSONA_ROLES.SYSTEM,
      lorebook: '',
      connections: [],
      characterBindings: {},
      profile: createUserPersonaProfile(),
    }
  }
  function editorSignature(): string {
    return JSON.stringify({
      draft: draft.value,
      url: avatarSourceUrl.value.trim(),
      avatar: cachedAvatarResource.value?.id ?? '',
      file: pendingAvatarFile.value
        ? `${pendingAvatarFile.value.name}:${pendingAvatarFile.value.size}:${pendingAvatarFile.value.lastModified}`
        : '',
    })
  }
  function resetPanels(): void {
    showAdvanced.value = false
    showTemplates.value = false
    creatingTemplate.value = false
    selectedTemplateId.value = 'blank'
    characterSearchQuery.value = ''
    characterCategoryFilter.value = 'all'
    descriptionInput.value = null
  }
  function selectEntry(entry: UserPersonaEntry): void {
    return selectEntryOperation(getUsePersonaResourceActionsContext(), entry)
  }
  async function loadResource(
    resourceId: string,
    preferredAvatarId = selectedAvatarId.value,
  ): Promise<void> {
    return loadResourceOperation(
      getUsePersonaResourceActionsContext(),
      resourceId,
      preferredAvatarId,
    )
  }
  async function openResource(resourceId: string): Promise<void> {
    return openResourceOperation(getUsePersonaResourceActionsContext(), resourceId)
  }
  async function changeEntry(event: Event): Promise<void> {
    const input = event.target as HTMLSelectElement
    const id = input.value
    input.value = selectedAvatarId.value
    if (!(await confirmDiscardDraft())) return
    const entry = entries.value.find((e) => e.avatarId === id)
    if (entry) {
      selectEntry(entry)
      resetPanels()
    }
  }
  function startNewPack(): void {
    if (busy.value) return
    creatingPack.value = true
    currentResource.value = null
    currentBackup.value = null
    currentWarnings.value = []
    selectedResourceId.value = ''
    selectedAvatarId.value = '__new__'
    draft.value = createDraft()
    selectedWorldBookId.value = ''
    selectedCharacterIds.value = new Set()
    selectedVariantCharacterId.value = profileCharacters.value[0]?.id ?? ''
    selectedVariantVersionId.value = ''
    editorMode.value = 'global'
    avatarResourcesByAvatarId.value = new Map()
    initialAvatarResourceIds.value = new Set()
    clearAvatarEditor()
    resetPanels()
    errorMessage.value = ''
    statusMessage.value = ''
    originalDraftSignature.value = editorSignature()
    page.value = 'editor'
  }
  function discardDraft(): void {
    if (activeEntry.value) selectEntry(activeEntry.value)
    else originalDraftSignature.value = editorSignature()
  }
  async function confirmDiscardDraft(): Promise<boolean> {
    if (!isDirty.value) return true
    const decision = await chooseAction({
      title: '人设有未保存修改',
      message: '保存到资源库后离开？',
      confirmLabel: '保存并离开',
      alternativeLabel: '放弃修改',
      cancelLabel: '继续编辑',
    })
    if (decision === 'confirm') {
      await saveDraft()
      return !errorMessage.value && !isDirty.value
    }
    if (decision === 'alternative') {
      discardDraft()
      return true
    }
    return false
  }
  async function goBack(): Promise<void> {
    if (busy.value) return
    if (transferOpen.value) {
      transferOpen.value = false
      return
    }
    if (page.value !== 'list' && isDirty.value && !(await confirmDiscardDraft())) return
    if (page.value === 'editor') {
      if (editorMode.value === 'variant') {
        const count = Object.keys(activeCharacterVariant.value?.versions ?? {}).length
        page.value = count > 1 ? 'versions' : 'profile-sections'
      } else
        page.value = Object.keys(draft.value.profile.variants).length ? 'profile-sections' : 'list'
      return
    }
    if (page.value === 'profile-sections') {
      page.value = 'list'
      return
    }
    if (page.value === 'versions') {
      page.value = 'profile-sections'
      return
    }
    if (page.value === 'character-picker') {
      page.value = characterPickerReturnPage.value
      return
    }
    emit('back')
  }
  async function openTransfer(): Promise<void> {
    if (busy.value || !(await confirmDiscardDraft())) return
    transferOpen.value = true
  }
  async function importTransferredFiles(files: File[], onComplete?: () => void): Promise<void> {
    return importTransferredFilesOperation(getUsePersonaResourceActionsContext(), files, onComplete)
  }
  async function selectHeaderMore(action: ActionSheetAction): Promise<void> {
    if (action.id === 'import') importInput.value?.click()
    if (action.id === 'history' && currentResource.value && (await confirmDiscardDraft())) {
      emit('open-history', currentResource.value)
    }
    if (action.id === 'transfer') await openTransfer()
    if (action.id === 'delete') await deleteCurrent()
    if (action.id === 'delete-variant-version') await deleteVariantVersion()
    if (action.id === 'add-character-profile') {
      openCharacterPicker()
    }
    if (action.id === 'add-variant-version') addVariantVersion()
  }

  const characterPickerReturnPage = ref<'profile-sections' | 'editor'>('editor')
  function openCharacterPicker(): void {
    if (busy.value) return
    characterPickerReturnPage.value =
      page.value === 'profile-sections' ? 'profile-sections' : 'editor'
    characterSearchQuery.value = ''
    characterCategoryFilter.value = 'all'
    page.value = 'character-picker'
  }

  function chooseProfileCharacter(characterId: string): void {
    selectedVariantCharacterId.value = characterId
    const existing = draft.value.profile.variants[characterId]
    if (existing) return
    const variant = createUserPersonaCharacterVariant()
    draft.value.profile.variants[characterId] = variant
    selectedVariantVersionId.value = variant.defaultVersionId
    editorMode.value = 'variant'
    descriptionInput.value = null
    page.value = 'editor'
  }

  function openGlobalProfileEditor(): void {
    editorMode.value = 'global'
    descriptionInput.value = null
    page.value = 'editor'
  }

  function openProfileCharacter(characterId: string): void {
    selectedVariantCharacterId.value = characterId
    const variant = draft.value.profile.variants[characterId]
    if (!variant) return
    if (!variant.versions[variant.defaultVersionId])
      variant.defaultVersionId = Object.keys(variant.versions)[0] ?? ''
    if (Object.keys(variant.versions).length > 1) page.value = 'versions'
    else {
      selectedVariantVersionId.value = variant.defaultVersionId
      editorMode.value = 'variant'
      descriptionInput.value = null
      page.value = 'editor'
    }
  }

  async function deleteProfileCharacter(characterId: string): Promise<void> {
    return deleteProfileCharacterOperation(getUsePersonaResourceActionsContext(), characterId)
  }

  function openVariantVersion(versionId: string): void {
    return openVariantVersionOperation(getUsePersonaResourceActionsContext(), versionId)
  }

  function setDefaultVariantVersion(versionId: string): void {
    return setDefaultVariantVersionOperation(getUsePersonaResourceActionsContext(), versionId)
  }

  function addVariantVersion(): void {
    return addVariantVersionOperation(getUsePersonaResourceActionsContext())
  }

  function deleteVersionFromList(versionId: string): void {
    return deleteVersionFromListOperation(getUsePersonaResourceActionsContext(), versionId)
  }

  async function deleteVariantVersion(): Promise<void> {
    return deleteVariantVersionOperation(getUsePersonaResourceActionsContext())
  }
  async function applyTemplate(): Promise<void> {
    const template = [...USER_PERSONA_TEMPLATES, ...customTemplates.value].find(
      (t) => t.id === selectedTemplateId.value,
    )
    const content = selectedTextContent()
    if (!template || template.description === content) return
    if (
      content.trim() &&
      !(await confirmAction({
        title: '使用模板',
        message: `替换“${textTargetLabel.value}”的内容？其他设定、名称、封面和绑定保持不变。`,
        confirmLabel: '替换描述',
      }))
    )
      return
    updateSelectedText(template.description)
  }
  function saveCustomTemplate(): void {
    const name = customTemplateName.value.trim()
    if (!name || !selectedTextContent().trim()) {
      errorMessage.value = !name ? '请填写模板名称' : '请先填写人设描述'
      return
    }
    const template = {
      id: `custom-${crypto.randomUUID()}`,
      name,
      description: selectedTextContent(),
    }
    customTemplates.value = browserStorageService.setUserPersonaTemplates([
      ...customTemplates.value,
      template,
    ])
    selectedTemplateId.value = template.id
    creatingTemplate.value = false
    customTemplateName.value = ''
    errorMessage.value = ''
    statusMessage.value = '模板已保存'
  }
  async function deleteSelectedCustomTemplate(): Promise<void> {
    const template = selectedCustomTemplate.value
    if (
      !template ||
      !(await confirmAction({
        title: '删除模板',
        message: `删除“${template.name}”？已填写的人设不受影响。`,
        confirmLabel: '删除',
        danger: true,
      }))
    )
      return
    customTemplates.value = browserStorageService.setUserPersonaTemplates(
      customTemplates.value.filter((t) => t.id !== template.id),
    )
    selectedTemplateId.value = 'blank'
  }
  async function insertPlaceholder(token: '{{user}}' | '{{char}}'): Promise<void> {
    const textarea = descriptionInput.value
    const content = selectedTextContent()
    const start = textarea?.selectionStart ?? content.length
    const end = textarea?.selectionEnd ?? start
    updateSelectedText(content.slice(0, start) + token + content.slice(end))
    await nextTick()
    textarea?.focus({ preventScroll: true })
    textarea?.setSelectionRange(start + token.length, start + token.length)
  }
  function bindDescriptionInput(element: unknown): void {
    descriptionInput.value = element instanceof HTMLTextAreaElement ? element : null
  }
  function selectTextInput(event: Event): void {
    descriptionInput.value = event.target as HTMLTextAreaElement
  }
  function selectedTextContent(): string {
    return editorMode.value === 'variant'
      ? (activeProfileVariant.value?.addition ?? '')
      : draft.value.description
  }
  function updateSelectedText(text: string): void {
    if (editorMode.value === 'variant') updateProfileAddition(text)
    else draft.value.description = text
  }
  function onWorldBookChange(): void {
    const selected = worldBooks.value.find((r) => r.id === selectedWorldBookId.value)
    draft.value.lorebook = selected?.name ?? ''
  }
  function toggleCharacter(id: string): void {
    const next = new Set(selectedCharacterIds.value)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    selectedCharacterIds.value = next
    draft.value.connections = connectionsForSave()
  }
  function addProfileSection(): void {
    draft.value.profile.sections.push({
      id: `section-${crypto.randomUUID()}`,
      name: '新设定',
      text: '',
    })
  }
  function removeProfileSection(sectionId: string): void {
    if (draft.value.profile.sections.length <= 1) return
    draft.value.profile.sections = draft.value.profile.sections.filter(
      (section) => section.id !== sectionId,
    )
    for (const variant of Object.values(draft.value.profile.variants))
      for (const version of Object.values(variant.versions)) delete version.overrides[sectionId]
  }
  async function changeProfileOverrideMode(sectionId: string, event: Event): Promise<void> {
    const input = event.target as HTMLSelectElement
    const mode = input.value as 'inherit' | UserPersonaSectionOverride['mode']
    const previous = activeProfileVariant.value?.overrides[sectionId]
    if (mode === 'inherit') await restoreProfileOverride(sectionId)
    else if (mode === 'disable' && previous?.mode === 'replace' && previous.text?.trim()) {
      if (
        await confirmAction({
          title: '不使用这段设定',
          message: '此版本的专属改写将被移除。全局内容和其他版本保持不变，保存前可放弃修改。',
          confirmLabel: '不使用',
          danger: true,
        })
      )
        setProfileOverride(sectionId, mode)
    } else setProfileOverride(sectionId, mode)
    input.value = activeProfileVariant.value?.overrides[sectionId]?.mode ?? 'inherit'
  }
  function setProfileOverride(
    sectionId: string,
    mode: 'inherit' | UserPersonaSectionOverride['mode'],
  ): void {
    const characterId = selectedVariantCharacterId.value
    if (!characterId) return
    const characterVariant = draft.value.profile.variants[characterId]
    if (!characterVariant) return
    const variant = characterVariant.versions[selectedVariantVersionId.value]
    if (!variant) return
    if (mode === 'inherit') delete variant.overrides[sectionId]
    else if (mode === 'replace') {
      const section = draft.value.profile.sections.find((item) => item.id === sectionId)
      variant.overrides[sectionId] = { mode, text: section?.text ?? '' }
    } else variant.overrides[sectionId] = { mode }
  }
  async function restoreProfileOverride(sectionId: string): Promise<void> {
    const characterId = selectedVariantCharacterId.value
    const variant = draft.value.profile.variants[characterId]
    const version = variant?.versions[selectedVariantVersionId.value]
    if (!variant || !version?.overrides[sectionId]) return
    const section = draft.value.profile.sections.find((item) => item.id === sectionId)
    if (
      !(await confirmAction({
        title: '恢复使用全局内容',
        message: `移除“${version.name}”对“${section?.name ?? '全局设定'}”的专属修改？不会影响全局内容或其他版本。`,
        confirmLabel: '恢复全局内容',
        danger: true,
      }))
    )
      return
    delete version.overrides[sectionId]
  }
  function updateProfileOverride(sectionId: string, text: string): void {
    const characterId = selectedVariantCharacterId.value
    if (!characterId) return
    const variant =
      draft.value.profile.variants[characterId]?.versions[selectedVariantVersionId.value]
    if (!variant) return
    variant.overrides[sectionId] = { mode: 'replace', text }
  }
  function updateProfileAddition(text: string): void {
    const characterId = selectedVariantCharacterId.value
    if (!characterId) return
    const variant =
      draft.value.profile.variants[characterId]?.versions[selectedVariantVersionId.value]
    if (!variant) return
    variant.addition = text
  }
  watch(
    () => draft.value.description,
    (description) => {
      const base = draft.value.profile.sections[0]
      if (base && base.text !== description) base.text = description
    },
  )
  watch(profileCharacters, (next) => {
    if (!next.some((character) => character.id === selectedVariantCharacterId.value))
      selectedVariantCharacterId.value = next[0]?.id ?? ''
  })
  const unregister = dirtyStateRegistry.register({
    featureId: 'user-persona',
    label: 'user才是老大',
    isDirty: () => isDirty.value,
    save: saveDraft,
    discard: discardDraft,
  })
  watch(isDirty, (dirty) => {
    dirtyStateRegistry.changed()
    if (dirty) statusMessage.value = ''
  })
  watch(
    () => props.resources.find((resource) => resource.id === selectedResourceId.value)?.updatedAt,
    (updatedAt) => {
      if (
        page.value !== 'editor' ||
        !updatedAt ||
        !currentResource.value ||
        currentResource.value.updatedAt === updatedAt ||
        isDirty.value
      )
        return
      void loadResource(selectedResourceId.value).catch((reason: unknown) => {
        errorMessage.value = reason instanceof Error ? reason.message : '刷新人设版本失败'
      })
    },
  )
  function onBackRequest(event: Event): void {
    const detail = (event as CustomEvent<SrlBackRequestDetail>).detail
    if (
      detail.handled ||
      headerMoreOpen.value ||
      document.querySelector('[role="dialog"], [role="alertdialog"]')
    )
      return
    if (page.value !== 'list' || transferOpen.value) {
      detail.handled = true
      void goBack()
    }
  }
  window.addEventListener(SRL_BACK_REQUEST_EVENT, onBackRequest)
  onBeforeUnmount(() => {
    unregister()
    window.removeEventListener(SRL_BACK_REQUEST_EVENT, onBackRequest)
    revokePreview(cachedAvatarPreview.value)
    revokePreview(pendingAvatarPreview.value)
  })
  return {
    page,
    transferOpen,
    busy,
    loading,
    saving,
    goBack,
    openTransfer,
    importTransferredFiles,
    selectedResourceId,
    backLabel,
    headerMoreOpen,
    headerMoreActions,
    selectHeaderMore,
    importInput,
    importPersonaFiles,
    startNewPack,
    statusMessage,
    errorMessage,
    searchQuery,
    listLimit,
    filteredResources,
    visibleResources,
    openResource,
    draft,
    entries,
    selectedAvatarId,
    changeEntry,
    currentResource,
    currentWarnings,
    creatingPack,
    isDirty,
    saveDraft,
    avatarPreviewUrl,
    avatarPreviewFailed,
    avatarSourceUrl,
    cachedAvatarResource,
    pendingAvatarFile,
    chooseAvatarImage,
    onAvatarFileChange,
    onAvatarUrlInput,
    removeAvatarBinding,
    showTemplates,
    selectedTemplateId,
    applyTemplate,
    USER_PERSONA_TEMPLATES,
    customTemplates,
    selectedCustomTemplate,
    deleteSelectedCustomTemplate,
    creatingTemplate,
    customTemplateName,
    saveCustomTemplate,
    insertPlaceholder,
    showAdvanced,
    USER_PERSONA_POSITIONS,
    USER_PERSONA_ROLES,
    selectedWorldBookId,
    onWorldBookChange,
    worldBooks,
    characters,
    characterSearchQuery,
    characterCategoryFilter,
    filteredCharacters,
    addableProfileCharacters,
    selectedCharacterIds,
    profileCharacters,
    selectedVariantCharacterId,
    selectedVariantVersionId,
    selectedVariantCharacter,
    personaVariantCharacters,
    activeVariantVersions,
    editorMode,
    chooseProfileCharacter,
    openGlobalProfileEditor,
    openProfileCharacter,
    deleteProfileCharacter,
    openVariantVersion,
    setDefaultVariantVersion,
    deleteVersionFromList,
    previewVersion: (versionId: string) =>
      resolveUserPersonaProfile(draft.value.profile, selectedVariantCharacterId.value, versionId),
    characterAvatarId,
    activeProfileVariant,
    isDefaultVariantVersion,
    versionComparison,
    textTargetLabel,
    bindDescriptionInput,
    selectTextInput,
    changeProfileOverrideMode,
    openCharacterPicker,
    addVariantVersion,
    resolvedProfilePreview,
    addProfileSection,
    removeProfileSection,
    setProfileOverride,
    restoreProfileOverride,
    updateProfileOverride,
    updateProfileAddition,
    toggleCharacter,
    unresolvedConnections,
    removeUnresolvedConnection,
  }

  function getUsePersonaResourceActionsContext(): UsePersonaResourceActionsContext {
    return {
      selectedAvatarId,
      draft,
      selectedWorldBookId,
      worldBooks,
      fileBaseName,
      selectedCharacterIds,
      characters,
      characterAvatarId,
      profileCharacters,
      selectedVariantCharacterId,
      selectedVariantVersionId,
      setPendingAvatar,
      avatarResourcesByAvatarId,
      setCachedAvatar,
      avatarSourceUrl,
      avatarSourceOf,
      originalDraftSignature,
      editorSignature,
      loadAvatarResources,
      currentResource,
      currentBackup,
      currentWarnings,
      selectedResourceId,
      creatingPack,
      selectEntry,
      busy,
      loading,
      errorMessage,
      statusMessage,
      loadResource,
      resetPanels,
      page,
      editorMode,
      emit,
      transferOpen,
      personaVariantCharacters,
      isDirty,
      saving,
      activeCharacterVariant,
      descriptionInput,
      deleteVariantVersion,
      activeProfileVariant,
    }
  }
}
