import type { EmitFn } from 'vue'
import { computed, nextTick, onMounted, onUnmounted, ref, useTemplateRef, watch } from 'vue'
import { chooseAction, confirmAction } from '../composables/UseConfirmDialog'
import { isResourceGalleryImage } from '../types/ResourceGallery'
import { createAsyncPanel } from '../core/AsyncPanel'
import { dirtyStateRegistry } from '../core/DirtyStateRegistry'
import { hasResourceDetailDraftChanges } from '../services/ResourceDetailDirtyState'
import { platform } from '../core/PlatformService'
import { getResourceInspector } from '../core/ResourceInspectorRegistry'
import type { ResourceVersionView } from '../services/ResourceService'
import type { CharacterCardContentEdit } from '../types/CharacterCardContentEdit'
import {
  getRelatedResourceIds,
  getResourceCategoryIds,
  normalizeResourceLinks,
  RESOURCE_TYPE,
  RESOURCE_TYPE_LABELS,
  type Category,
  type Resource,
  type ResourceLink,
  type ResourceReference,
  type ResourceSummary,
  type ResourceType,
} from '../types/Resource'
import {
  readCharacterCardOverrides,
  type CharacterCardOverrides,
} from '../utils/CharacterCardCustomization'
import {
  filterResourceRelationCandidates,
  isResourceBoundElsewhere,
} from '../utils/ResourceRelationCandidates'
import { isRecord } from '../utils/UnknownValue'
import { readAuthorNote, readParsedAuthor } from '../utils/ResourceAuthors'
import { readCharacterCardContentEdits } from '../utils/CharacterCardContentEdits'

export type DetailTab = 'overview' | 'content' | 'gallery' | 'relations' | 'versions' | 'file'

export type ResourceOrganizerProps = {
  settingsOpen?: boolean
  initialTab?: DetailTab
  prepareTab?: (tab: DetailTab) => Promise<void>
  resource: Resource
  resources: ResourceSummary[]
  boundResources: Resource[]
  versions: ResourceVersionView[]
  categories: Category[]
  busy: boolean
}

export type ResourceOrganizerEvents = {
  openSecretSettings: []
  personalSaved: [resource: Resource]
  personalBusy: [busy: boolean]
  close: []
  download: [resource: ResourceReference, content?: 'original' | 'modified']
  open: [resource: ResourceSummary]
  downloadRelated: [resourceIds: string[]]
  activateVersion: [versionId: string]
  deleteVersion: [versionId: string | string[]]
  detachVersion: [versionId: string]
  updateVersionNote: [versionId: string, note: string]
  mergeVersion: [resourceId: string, note: string]
  replaceArtwork: [file: File]
  save: [
    details: {
      name: string
      authorNote?: string
      description: string
      type: ResourceType
      categoryIds: string[]
      relatedResourceIds: string[]
      tags: string[]
      sourceLinks: ResourceLink[]
      characterOverrides?: CharacterCardOverrides
      characterContentEdits?: CharacterCardContentEdit[]
    },
  ]
}

export function useResourceOrganizer(
  props: Readonly<ResourceOrganizerProps>,
  emit: EmitFn<ResourceOrganizerEvents>,
) {
  const CharacterCardDetails = createAsyncPanel(
    '角色卡详情',
    () => import('../components/CharacterCardDetails.vue'),
  )

  const StructuredResourceDetails = createAsyncPanel(
    '资源内容',
    () => import('../components/StructuredResourceDetails.vue'),
  )

  const VersionDiffDialog = createAsyncPanel(
    '版本对比',
    () => import('../components/VersionDiffDialog.vue'),
  )

  const DETAIL_TABS: Array<{ value: DetailTab; label: string }> = [
    { value: 'overview', label: '概览' },
    { value: 'content', label: '内容' },
    { value: 'gallery', label: '图库' },
    { value: 'relations', label: '关联' },
    { value: 'versions', label: '版本' },
    { value: 'file', label: '文件' },
  ]

  const name = ref('')
  const authorNote = ref('')
  const parsedAuthor = computed(() => readParsedAuthor(props.resource) || '未知作者')
  let preservePersonalDraft = false
  function handlePersonalSaved(resource: Resource) {
    preservePersonalDraft = true
    emit('personalSaved', resource)
  }

  const description = ref('')

  const resourceType = ref<ResourceType>(RESOURCE_TYPE.OTHER)

  const categoryIds = ref(new Set<string>())

  const relatedResourceIds = ref(new Set<string>())

  const relatedDownloadIds = ref(new Set<string>())

  const relationQuery = ref('')
  const relationCategoryId = ref('all')
  const relationTypeFilter = ref<ResourceType | 'all'>('all')
  const relationPage = ref(1)
  const hideBoundRelationCandidates = ref(false)
  watch(
    [
      relationQuery,
      relationCategoryId,
      relationTypeFilter,
      hideBoundRelationCandidates,
      () => props.resources,
    ],
    () => {
      relationPage.value = 1
    },
  )

  const tagText = ref('')

  const sourceLinks = ref<ResourceLink[]>([])

  const characterOverrides = ref<CharacterCardOverrides>({})

  const characterContentEdits = ref<CharacterCardContentEdit[]>([])
  const characterEditorDirty = ref(false)
  const characterWorkbenchOpen = ref(false)
  const structuredEditorDirty = ref(false)
  const structuredWorkbenchOpen = ref(false)
  const structuredContent = useTemplateRef<{ prepareSave: () => Promise<boolean> }>(
    'structuredContent',
  )
  const characterContent = useTemplateRef<{ prepareSave: () => Promise<boolean> }>(
    'characterContent',
  )

  const versionNotes = ref<Record<string, string>>({})

  const diffTarget = ref<Resource>()

  const manualVersionResourceId = ref('')

  const manualVersionNote = ref('')

  const artworkInput = useTemplateRef<HTMLInputElement>('artworkInput')

  const activeTab = ref<DetailTab>(props.initialTab ?? 'overview')

  const preparedTabs = ref(new Set<DetailTab>())
  const preparingTab = ref<DetailTab>()
  const preparationError = ref('')
  let preparationGeneration = 0
  async function prepareActiveTab() {
    const generation = ++preparationGeneration,
      tab = activeTab.value
    preparationError.value = ''
    if (preparedTabs.value.has(tab) || !props.prepareTab) {
      preparedTabs.value.add(tab)
      preparingTab.value = undefined
      return
    }
    preparingTab.value = tab
    try {
      await props.prepareTab(tab)
      if (generation === preparationGeneration) preparedTabs.value.add(tab)
    } catch (error) {
      if (generation === preparationGeneration)
        preparationError.value = error instanceof Error ? error.message : '详情读取失败'
    } finally {
      if (generation === preparationGeneration) preparingTab.value = undefined
    }
  }
  watch(
    () => [props.resource.id, props.resource.contentHash],
    (identity, previous) => {
      if (identity[0] !== previous?.[0]) activeTab.value = props.initialTab ?? 'overview'
      preparedTabs.value = new Set()
      void prepareActiveTab()
    },
    { immediate: true },
  )
  watch(activeTab, () => {
    void prepareActiveTab()
  })
  onUnmounted(() => {
    preparationGeneration++
  })

  const detailSheet = useTemplateRef<HTMLElement>('detailSheet')

  const detailTabs = useTemplateRef<HTMLElement>('detailTabs')

  const tabScrollPositions = new Map<DetailTab, number>()

  const artworkPickerStatus = ref('')

  const resourceInspector = computed(() => getResourceInspector(resourceType.value))

  const visibleDetailTabs = computed(() =>
    DETAIL_TABS.filter((tab) => resourceInspector.value.sections.includes(tab.value)),
  )

  function handleArtworkFileChange(event: Event): void {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (file) emit('replaceArtwork', file)
    input.value = ''
  }

  async function chooseArtworkFile(): Promise<void> {
    if (!(await platform.files.isImagePickerAvailable())) {
      artworkInput.value?.click()
      return
    }
    try {
      const file = await platform.files.pickImage()
      if (file) emit('replaceArtwork', file)
    } catch (error) {
      artworkPickerStatus.value = error instanceof Error ? error.message : '无法读取所选卡面'
    }
  }

  const typeOptions = Object.values(RESOURCE_TYPE).map((value) => ({
    value,
    label: RESOURCE_TYPE_LABELS[value],
  }))

  const metadataJson = computed(() => JSON.stringify(props.resource.metadata, null, 2))

  const isCharacter = computed(() => props.resource.type === RESOURCE_TYPE.CHARACTER_CARD)

  const availableBoundResources = computed(() =>
    props.boundResources.filter((resource) => relatedResourceIds.value.has(resource.id)),
  )

  const characterIdentity = computed(() => {
    const card = props.resource.metadata.card
    const cardRecord = isRecord(card) ? card : undefined
    const rawData = cardRecord?.data ?? cardRecord
    const data = isRecord(rawData) ? rawData : undefined
    const read = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    return {
      creator: read(data?.creator) || read(props.resource.metadata.creator) || '未知作者',
      version:
        read(data?.character_version) ||
        read(props.resource.metadata.characterVersion) ||
        '未标注版本',
    }
  })

  const cardData = computed(() => {
    const card = isRecord(props.resource.metadata.card) ? props.resource.metadata.card : undefined
    const data = card?.data ?? card
    return isRecord(data) ? data : undefined
  })

  let unregisterDirtyState: (() => void) | undefined

  onMounted(() => {
    unregisterDirtyState = dirtyStateRegistry.register({
      featureId: 'resource-detail',
      label: '资源详情',
      isDirty: () => isDirty.value,
      save: async () => handleSubmit(),
      discard: () => undefined,
    })
  })

  onUnmounted(() => {
    unregisterDirtyState?.()
  })

  const formattedFileSize = computed(() => {
    const bytes = props.resource.fileSize
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  })

  const createdDate = computed(() => new Date(props.resource.createdAt).toLocaleString('zh-CN'))

  const updatedDate = computed(() => new Date(props.resource.updatedAt).toLocaleString('zh-CN'))

  const fileExtension = computed(
    () => props.resource.fileName.split('.').pop()?.toLocaleUpperCase() || 'FILE',
  )

  const visibleTags = computed(() => props.resource.tags.slice(0, 2))

  const hiddenTagCount = computed(() =>
    Math.max(0, props.resource.tags.length - visibleTags.value.length),
  )

  const summaryStats = computed(() => {
    const relatedCount = relatedResourceIds.value.size
    const folderCount = categoryIds.value.size
    const tagCount = tagText.value
      .split(/[,，\n]/)
      .map((tag) => tag.trim())
      .filter(Boolean).length
    if (isCharacter.value) {
      const alternates = Array.isArray(cardData.value?.alternate_greetings)
        ? cardData.value.alternate_greetings.length
        : 0
      const greetingCount = (typeof cardData.value?.first_mes === 'string' ? 1 : 0) + alternates
      const book = isRecord(cardData.value?.character_book)
        ? cardData.value.character_book
        : undefined
      const entries = book?.entries
      const worldBookCount = Array.isArray(entries)
        ? entries.length
        : isRecord(entries)
          ? Object.keys(entries).length
          : 0
      const extensions = isRecord(cardData.value?.extensions)
        ? cardData.value.extensions
        : undefined
      const regexCount = Array.isArray(extensions?.regex_scripts)
        ? extensions.regex_scripts.length
        : 0
      return [
        { label: '开场白', value: String(greetingCount) },
        { label: '世界书', value: String(worldBookCount) },
        { label: '正则', value: String(regexCount) },
        { label: '关联', value: String(relatedCount) },
      ]
    }

    const itemCount = Number(props.resource.metadata.itemCount)
    const countLabel = {
      [RESOURCE_TYPE.GREETING]: '开场白',
      [RESOURCE_TYPE.CHAT]: '聊天楼层',
      [RESOURCE_TYPE.USER_PERSONA]: '用户人设',
      [RESOURCE_TYPE.WORLD_BOOK]: '世界书条目',
      [RESOURCE_TYPE.REGEX]: '正则逻辑',
      [RESOURCE_TYPE.PRESET]: '提示词段',
      [RESOURCE_TYPE.QUICK_REPLY]: '快速回复',
      [RESOURCE_TYPE.SCRIPT]: '脚本数量',
      [RESOURCE_TYPE.BEAUTIFICATION]: '样式内容',
      [RESOURCE_TYPE.PLUGIN]: '解析字段',
      [RESOURCE_TYPE.EXTRA_STORY]: '内容',
      [RESOURCE_TYPE.POCKET_PHONE]: '附件',
      [RESOURCE_TYPE.SECRET]: '字段',
      [RESOURCE_TYPE.OTHER]: '解析字段',
      [RESOURCE_TYPE.CHARACTER_CARD]: '内容',
    }[props.resource.type]
    const fallbackCount = Array.isArray(props.resource.metadata.rootKeys)
      ? props.resource.metadata.rootKeys.length
      : 0
    return [
      {
        label: countLabel,
        value: String(Number.isFinite(itemCount) ? itemCount : fallbackCount),
      },
      { label: '关联资源', value: String(relatedCount) },
      { label: '标签', value: String(tagCount) },
      { label: '文件夹', value: String(folderCount) },
    ]
  })

  const relationCandidates = computed(() => {
    return filterResourceRelationCandidates(props.resources, {
      currentResourceId: props.resource.id,
      selectedResourceIds: relatedResourceIds.value,
      query: relationQuery.value,
      hideBoundElsewhere: hideBoundRelationCandidates.value,
      resourceType: relationTypeFilter.value === 'all' ? undefined : relationTypeFilter.value,
      categoryId:
        relationCategoryId.value === 'all'
          ? undefined
          : relationCategoryId.value === 'uncategorized'
            ? null
            : relationCategoryId.value,
    })
  })

  const boundElsewhereCandidateCount = computed(
    () =>
      props.resources.filter(
        (resource) =>
          resource.id !== props.resource.id &&
          !relatedResourceIds.value.has(resource.id) &&
          isResourceBoundElsewhere(resource, props.resource.id),
      ).length,
  )

  const relationTypeOptions = computed(() => {
    const types = new Set(
      props.resources
        .filter(
          (resource) => resource.id !== props.resource.id && !isResourceGalleryImage(resource),
        )
        .map((resource) => resource.type),
    )
    return typeOptions.filter((option) => types.has(option.value))
  })
  const relationPageCount = computed(() =>
    Math.max(1, Math.ceil(relationCandidates.value.length / 30)),
  )
  const relationGroups = computed(() => {
    const visible = relationCandidates.value.slice(
      (relationPage.value - 1) * 30,
      relationPage.value * 30,
    )
    return Object.values(RESOURCE_TYPE).flatMap((type) => {
      const visibleItems = visible.filter((resource) => resource.type === type)
      if (!visibleItems.length) return []
      const items = relationCandidates.value.filter((resource) => resource.type === type)
      return [
        {
          type,
          label: RESOURCE_TYPE_LABELS[type],
          items,
          visibleItems,
          selectedCount: items.filter((resource) => relatedResourceIds.value.has(resource.id))
            .length,
        },
      ]
    })
  })

  const manualVersionCandidates = computed(() => {
    const versionIds = new Set(props.versions.map((version) => version.resource.id))
    return props.resources
      .filter((resource) => resource.id !== props.resource.id)
      .filter((resource) => !isResourceGalleryImage(resource))
      .filter((resource) => resource.type === props.resource.type)
      .filter((resource) => !versionIds.has(resource.id))
      .sort(
        (left, right) => right.updatedAt - left.updatedAt || left.name.localeCompare(right.name),
      )
  })

  const relatedDownloadCount = computed(() => relatedDownloadIds.value.size)

  const normalizedDraftTags = computed(() =>
    Array.from(
      new Set(
        tagText.value
          .split(/[,，\n]/)
          .map((tag) => tag.trim())
          .filter(Boolean),
      ),
    ),
  )

  const isDirty = computed(
    () =>
      characterEditorDirty.value ||
      structuredEditorDirty.value ||
      hasResourceDetailDraftChanges(
        {
          name: name.value,
          authorNote: authorNote.value,
          description: description.value,
          type: resourceType.value,
          categoryIds: categoryIds.value,
          relatedResourceIds: relatedResourceIds.value,
          tags: normalizedDraftTags.value,
          sourceLinks: sourceLinks.value,
          characterOverrides: characterOverrides.value,
          characterContentEdits: characterContentEdits.value,
        },
        props.resource,
      ),
  )

  watch(isDirty, () => dirtyStateRegistry.changed())

  watch(
    () => props.resource,
    (resource, previous) => {
      const keep = preservePersonalDraft && previous?.id === resource.id
      const retain = <T>(draft: T, before: T | undefined, after: T): T =>
        keep && JSON.stringify(draft) !== JSON.stringify(before) ? draft : after
      name.value = retain(name.value, previous?.name, resource.name)
      authorNote.value = retain(
        authorNote.value,
        previous && readAuthorNote(previous),
        readAuthorNote(resource),
      )
      description.value = retain(description.value, previous?.description, resource.description)
      resourceType.value = retain(resourceType.value, previous?.type, resource.type)
      categoryIds.value = new Set(
        retain(
          [...categoryIds.value],
          previous && getResourceCategoryIds(previous),
          getResourceCategoryIds(resource),
        ),
      )
      relatedResourceIds.value = new Set(
        retain(
          [...relatedResourceIds.value],
          previous && getRelatedResourceIds(previous),
          getRelatedResourceIds(resource),
        ),
      )
      relatedDownloadIds.value = new Set(getRelatedResourceIds(resource))
      relationQuery.value = ''
      relationCategoryId.value = 'all'
      relationTypeFilter.value = 'all'
      relationPage.value = 1
      manualVersionResourceId.value = ''
      manualVersionNote.value = ''
      diffTarget.value = undefined
      tagText.value = retain(tagText.value, previous?.tags.join('，'), resource.tags.join('，'))
      sourceLinks.value = retain(
        sourceLinks.value,
        previous && normalizeResourceLinks(previous.sourceLinks),
        normalizeResourceLinks(resource.sourceLinks).map((link) => ({ ...link })),
      )
      characterOverrides.value = retain(
        characterOverrides.value,
        previous && readCharacterCardOverrides(previous.metadata),
        readCharacterCardOverrides(resource.metadata),
      )
      characterContentEdits.value = retain(
        characterContentEdits.value,
        previous && readCharacterCardContentEdits(previous.metadata.characterContentEdits),
        readCharacterCardContentEdits(resource.metadata.characterContentEdits),
      )
      preservePersonalDraft = false
      if (!previous || previous.id !== resource.id) {
        characterEditorDirty.value = false
        characterWorkbenchOpen.value = false
        structuredEditorDirty.value = false
        structuredWorkbenchOpen.value = false
        activeTab.value = props.initialTab ?? 'overview'
        tabScrollPositions.clear()
      }
    },
    { immediate: true },
  )

  watch(
    () => props.versions,
    (versions) => {
      versionNotes.value = Object.fromEntries(
        versions.flatMap((version) =>
          (version.carriers?.length ? version.carriers : [version.resource]).map((carrier) => [
            carrier.id,
            carrier.versionNote ?? '',
          ]),
        ),
      )
    },
    { immediate: true },
  )

  async function handleSubmit(): Promise<void> {
    if (!isDirty.value || props.busy) return
    if (characterContent.value && !(await characterContent.value.prepareSave())) {
      activeTab.value = 'content'
      return
    }
    if (structuredContent.value && !(await structuredContent.value.prepareSave())) {
      activeTab.value = 'content'
      return
    }
    await nextTick()
    emit('save', {
      name: name.value,
      authorNote: authorNote.value,
      description: description.value,
      type: resourceType.value,
      categoryIds: Array.from(categoryIds.value),
      relatedResourceIds: Array.from(relatedResourceIds.value),
      sourceLinks: sourceLinks.value,
      tags: tagText.value.split(/[,，\n]/),
      characterOverrides: characterOverrides.value,
      characterContentEdits: characterContentEdits.value,
    })
  }

  async function requestClose(): Promise<void> {
    if (!isDirty.value) {
      emit('close')
      return
    }
    const decision = await chooseAction({
      title: '资源详情有未保存修改',
      message: '离开前可以保存、放弃修改，或取消返回继续编辑。',
      confirmLabel: '保存',
      alternativeLabel: '放弃修改',
      cancelLabel: '取消返回',
    })
    if (decision === 'confirm') await handleSubmit()
    else if (decision === 'alternative') emit('close')
  }

  function toggleCategory(categoryId: string): void {
    const ids = new Set(categoryIds.value)
    if (ids.has(categoryId)) ids.delete(categoryId)
    else ids.add(categoryId)
    categoryIds.value = ids
  }

  function toggleRelation(resourceId: string): void {
    const ids = new Set(relatedResourceIds.value)
    const downloadIds = new Set(relatedDownloadIds.value)
    if (ids.has(resourceId)) {
      ids.delete(resourceId)
      downloadIds.delete(resourceId)
    } else {
      ids.add(resourceId)
      downloadIds.add(resourceId)
    }
    relatedResourceIds.value = ids
    relatedDownloadIds.value = downloadIds
  }

  function toggleRelatedDownload(resourceId: string): void {
    const ids = new Set(relatedDownloadIds.value)
    if (ids.has(resourceId)) ids.delete(resourceId)
    else ids.add(resourceId)
    relatedDownloadIds.value = ids
  }

  async function openRelatedResource(resource: ResourceSummary): Promise<void> {
    if (!relatedResourceIds.value.has(resource.id)) return
    if (
      isDirty.value &&
      !(await confirmAction({
        title: '跳转关联资源',
        message: '当前资源有未保存修改。继续跳转将放弃这些修改，是否继续？',
        confirmLabel: '放弃并跳转',
        danger: true,
      }))
    ) {
      return
    }
    emit('open', resource)
  }

  function handleRelationDoubleClick(event: MouseEvent, resource: ResourceSummary): void {
    const target = event.target
    if (target instanceof Element && target.closest('input, button')) return
    openRelatedResource(resource)
  }

  function submitManualVersionMerge(): void {
    if (!manualVersionResourceId.value) return
    emit('mergeVersion', manualVersionResourceId.value, manualVersionNote.value)
    manualVersionResourceId.value = ''
    manualVersionNote.value = ''
  }

  async function selectTab(tab: DetailTab): Promise<void> {
    if (tab === activeTab.value) return
    const sheet = detailSheet.value
    if (sheet) tabScrollPositions.set(activeTab.value, sheet.scrollTop)
    activeTab.value = tab
    await nextTick()
    if (!sheet) return
    const stored = tabScrollPositions.get(tab)
    sheet.scrollTo({
      top: stored ?? Math.max(0, (detailTabs.value?.offsetTop ?? 0) - 12),
      behavior: 'auto',
    })
  }
  return {
    authorNote,
    parsedAuthor,
    handlePersonalSaved,
    requestClose,
    isCharacter,
    fileExtension,
    name,
    characterIdentity,
    RESOURCE_TYPE_LABELS,
    formattedFileSize,
    visibleTags,
    hiddenTagCount,
    artworkPickerStatus,
    handleSubmit,
    visibleDetailTabs,
    activeTab,
    preparedTabs,
    preparingTab,
    preparationError,
    prepareActiveTab,
    selectTab,
    relatedResourceIds,
    summaryStats,
    resourceType,
    typeOptions,
    description,
    categoryIds,
    toggleCategory,
    tagText,
    sourceLinks,
    CharacterCardDetails,
    availableBoundResources,
    characterOverrides,
    characterContentEdits,
    characterEditorDirty,
    characterWorkbenchOpen,
    structuredEditorDirty,
    structuredWorkbenchOpen,
    StructuredResourceDetails,
    relatedDownloadCount,
    relatedDownloadIds,
    relationQuery,
    relationCategoryId,
    relationTypeFilter,
    relationTypeOptions,
    relationPage,
    relationPageCount,
    relationCandidates,
    hideBoundRelationCandidates,
    boundElsewhereCandidateCount,
    relationGroups,
    handleRelationDoubleClick,
    toggleRelation,
    toggleRelatedDownload,
    openRelatedResource,
    RESOURCE_TYPE,
    chooseArtworkFile,
    handleArtworkFileChange,
    manualVersionResourceId,
    manualVersionCandidates,
    manualVersionNote,
    submitManualVersionMerge,
    versionNotes,
    diffTarget,
    createdDate,
    updatedDate,
    metadataJson,
    isDirty,
    VersionDiffDialog,
  }
}
