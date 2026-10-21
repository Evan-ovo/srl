import type { EmitFn } from 'vue'
import { computed, inject, nextTick, onMounted, onUnmounted, ref, useTemplateRef, watch } from 'vue'
import { assetStore } from '../core/AppContainer'
import {
  BrowserStorageService,
  type CabinetColumns,
  type CabinetLayoutEntry,
} from '../services/BrowserStorageService'
import {
  cabinetLayoutSignature,
  getCabinetFolderOrder,
  moveCabinetLayoutEntry,
  reconcileCabinetLayout as reconcileStoredCabinetLayout,
  sortCabinetLayout,
} from '../services/CabinetLayout'
import type {
  FolderLibraryViewEvents,
  FolderLibraryViewProps,
  OrganizerResourceFilter,
  ResourceTypeFilter,
  TouchDragState,
} from '../types/FolderLibraryView'
import {
  getResourceCategoryIds,
  RESOURCE_TYPE,
  RESOURCE_TYPE_LABELS,
  type Category,
  type ResourceSummary,
  type ResourceType,
} from '../types/Resource'
import { normalizeFolderCoverUrl } from '../utils/FolderCover'
import { useFolderCabinetDrag } from './UseFolderCabinetDrag'
import { enqueueThumbnailRead } from './UseResourceThumbnail'
import { folderThumbnailCacheKey } from './FolderThumbnailCache'
type ThumbnailSource = { blob?: Blob; assetId?: string; hash: string; nativeUrl?: string }
export type {
  FolderLibraryViewEvents,
  FolderLibraryViewProps,
  OrganizerResourceFilter,
  ResourceTypeFilter,
  TouchDragState,
} from '../types/FolderLibraryView'

export function useFolderLibraryView(
  props: Readonly<FolderLibraryViewProps>,
  emit: EmitFn<FolderLibraryViewEvents>,
) {
  const {
    handlePagerPointerDown,
    handlePagerPointerMove,
    finishPagerGesture,
    cancelPagerGesture,
    cancelFolderDrag,
    handleFolderPointerDown,
    moveFolderByKeyboard,
  } = useFolderCabinetDrag(() => ({
    isFolderEditMode,
    folderDrag,
    FOLDER_HOLD_MS,
    get suppressFolderClickUntil() {
      return suppressFolderClickUntil
    },
    set suppressFolderClickUntil(value: typeof suppressFolderClickUntil) {
      suppressFolderClickUntil = value
    },
    setFolderPage,
    folderPage,
    folderPageCount,
    moveCabinetEntryToSlot,
    orderedFolderIds,
    saveCabinetLayout,
    props,
    FOLDER_EDIT_HOLD_MS,
    cabinetLayout,
    cabinetStorage,
    emit,
    cabinetColumns,
    folderPageSize,
  }))

  const FOLDER_HOLD_MS = 420

  const FOLDER_EDIT_HOLD_MS = 180

  const cabinetStorage = new BrowserStorageService()

  const pendingThumbnails = new Map<string, () => void>()
  const thumbnailCache = inject(folderThumbnailCacheKey, undefined)
  const thumbnailReleases = new Map<string, () => void>()
  const thumbnailSources = new Map<string, ThumbnailSource>()

  const searchQuery = ref('')

  const detailQuery = ref('')

  const detailLimit = ref(24)

  const selectedResourceIds = ref(new Set<string>())

  const activeDropId = ref('')

  const activeFolderId = ref<string | null | undefined>(undefined)

  const isOrganizerOpen = ref(false)

  const isFolderEditMode = ref(false)

  const folderPage = ref(0)

  const cabinetColumns = ref<CabinetColumns>(cabinetStorage.getCabinetColumns())

  const folderPageSize = computed(() => cabinetColumns.value * 3)

  const orderedFolderIds = ref<string[]>([])

  const cabinetLayout = ref<CabinetLayoutEntry[]>([])

  const detailType = ref<ResourceTypeFilter>('all')

  const organizerType = ref<OrganizerResourceFilter>('unclassified')

  const organizerDestination = ref<'cabinet' | 'folders'>('folders')

  const renamingCategory = ref<Category>()

  const renameDraft = ref('')

  const coverUrlDraft = ref('')

  const folderEditError = ref('')

  const thumbnailUrls = ref(new Map<string, string>())

  const organizerCloseButton = useTemplateRef<HTMLButtonElement>('organizerCloseButton')

  const renameInput = useTemplateRef<HTMLInputElement>('renameInput')

  const cabinetRoot = useTemplateRef<HTMLElement>('cabinetRoot')

  let organizerTrigger: HTMLElement | undefined

  let touchHoldTimer: number | undefined

  let touchCandidate:
    | {
        pointerId: number
        resourceId: string
        startX: number
        startY: number
        source: HTMLElement
        fromCabinet: boolean
      }
    | undefined

  let suppressResourceClickUntil = 0

  let suppressFolderClickUntil = 0

  let touchMoveFrame: number | undefined

  let pendingTouchMove: { x: number; y: number } | undefined

  const touchDrag = ref<TouchDragState>()

  const folderDrag = ref<{ pointerId: number; folderId: string; x: number; y: number }>()

  const cabinetGridStyle = computed<Record<string, string>>(() => ({
    '--cabinet-columns': String(cabinetColumns.value),
    '--cabinet-icon-size':
      cabinetColumns.value === 2 ? '8.5rem' : cabinetColumns.value === 3 ? '7rem' : '5.75rem',
  }))

  const resourcesByCategory = computed(() => {
    const grouped = new Map<string, ResourceSummary[]>()
    const unfiled: ResourceSummary[] = []
    for (const resource of props.resources) {
      const categoryIds = getResourceCategoryIds(resource)
      if (!categoryIds.length) unfiled.push(resource)
      for (const categoryId of categoryIds) {
        const resources = grouped.get(categoryId) ?? []
        resources.push(resource)
        grouped.set(categoryId, resources)
      }
    }
    for (const resources of grouped.values()) {
      resources.sort((left, right) => right.updatedAt - left.updatedAt)
    }
    unfiled.sort((left, right) => right.updatedAt - left.updatedAt)
    return { grouped, unfiled }
  })

  const orderedCategories = computed(() => {
    const byId = new Map(props.categories.map((category) => [category.id, category]))
    return orderedFolderIds.value.flatMap((id) => {
      const category = byId.get(id)
      return category ? [category] : []
    })
  })

  const categoryFolderEntries = computed(() =>
    orderedCategories.value.map((category) => ({
      id: category.id,
      category,
      resources: resourcesByCategory.value.grouped.get(category.id) ?? [],
    })),
  )

  const unfiledEntry = computed(() => ({
    id: null,
    category: undefined,
    resources: resourcesByCategory.value.unfiled,
  }))

  const folderEntries = computed(() => [...categoryFolderEntries.value, unfiledEntry.value])

  const cabinetResources = computed(() => {
    const byId = new Map(props.resources.map((resource) => [resource.id, resource]))
    return props.cabinetResourceIds.flatMap((id) => {
      const resource = byId.get(id)
      return resource ? [resource] : []
    })
  })

  const cabinetEntriesByKey = computed(() => {
    const entries = new Map<
      string,
      | ({ kind: 'folder'; slot: number } & (typeof categoryFolderEntries.value)[number])
      | { kind: 'resource'; id: string; slot: number; resource: ResourceSummary }
    >()
    for (const entry of categoryFolderEntries.value) {
      entries.set(`folder:${entry.id}`, { kind: 'folder', slot: -1, ...entry })
    }
    for (const resource of cabinetResources.value) {
      entries.set(`resource:${resource.id}`, {
        kind: 'resource',
        id: `resource:${resource.id}`,
        slot: -1,
        resource,
      })
    }
    return entries
  })

  const folderPageCount = computed(() => {
    const lastSlot = cabinetLayout.value.reduce(
      (maximum, entry) => Math.max(maximum, entry.slot),
      -1,
    )
    return Math.max(1, Math.ceil((lastSlot + 1) / folderPageSize.value))
  })

  const visibleCabinetEntries = computed(() => {
    const start = folderPage.value * folderPageSize.value
    const bySlot = new Map(cabinetLayout.value.map((entry) => [entry.slot, entry]))
    return Array.from({ length: folderPageSize.value }, (_, index) => {
      const slot = start + index
      const layoutEntry = bySlot.get(slot)
      if (!layoutEntry) return { kind: 'empty' as const, id: `empty:${slot}`, slot }
      const entry = cabinetEntriesByKey.value.get(`${layoutEntry.kind}:${layoutEntry.id}`)
      return entry ? { ...entry, slot } : { kind: 'empty' as const, id: `empty:${slot}`, slot }
    })
  })

  const availableOrganizerResources = computed(() => {
    const categoryId = organizerDestination.value === 'folders' ? activeFolderId.value : undefined
    return typeof categoryId === 'string'
      ? props.resources.filter((resource) => !getResourceCategoryIds(resource).includes(categoryId))
      : props.resources
  })

  const matchingResources = computed(() => {
    const query = searchQuery.value.trim().toLocaleLowerCase()
    return availableOrganizerResources.value
      .filter((resource) => {
        if (organizerType.value === 'unclassified' && getResourceCategoryIds(resource).length) {
          return false
        }
        if (
          organizerType.value !== 'all' &&
          organizerType.value !== 'unclassified' &&
          resource.type !== organizerType.value
        ) {
          return false
        }
        return (
          !query ||
          resource.name.toLocaleLowerCase().includes(query) ||
          resource.fileName.toLocaleLowerCase().includes(query)
        )
      })
      .slice()
      .sort((left, right) => right.updatedAt - left.updatedAt)
  })

  const trayResources = computed(() => matchingResources.value.slice(0, 24))

  const organizerResources = computed(() => matchingResources.value.slice(0, 60))

  const activeFolderEntry = computed(() =>
    activeFolderId.value === undefined
      ? undefined
      : folderEntries.value.find((entry) => entry.id === activeFolderId.value),
  )

  const detailResources = computed(() => {
    const query = detailQuery.value.trim().toLocaleLowerCase()
    return (activeFolderEntry.value?.resources ?? []).filter(
      (resource) =>
        (detailType.value === 'all' || resource.type === detailType.value) &&
        (!query ||
          resource.name.toLocaleLowerCase().includes(query) ||
          resource.fileName.toLocaleLowerCase().includes(query)),
    )
  })

  const visibleDetailResources = computed(() => detailResources.value.slice(0, detailLimit.value))

  function createTypeOptions(resources: ResourceSummary[]) {
    const counts = new Map<ResourceType, number>()
    for (const resource of resources)
      counts.set(resource.type, (counts.get(resource.type) ?? 0) + 1)
    return (Object.values(RESOURCE_TYPE) as ResourceType[]).flatMap((type) => {
      const count = counts.get(type) ?? 0
      return count ? [{ type, label: RESOURCE_TYPE_LABELS[type], count }] : []
    })
  }

  const detailTypeOptions = computed(() =>
    createTypeOptions(activeFolderEntry.value?.resources ?? []),
  )

  const organizerTypeOptions = computed(() => createTypeOptions(availableOrganizerResources.value))

  const unclassifiedResourceCount = computed(
    () =>
      availableOrganizerResources.value.filter(
        (resource) => !getResourceCategoryIds(resource).length,
      ).length,
  )

  const visibleFolderCoverCandidates = computed(() => {
    const covers = new Map<ResourceSummary[], ResourceSummary[]>()
    for (const entry of visibleCabinetEntries.value)
      if (entry.kind === 'folder' && !entry.category.coverImage)
        covers.set(entry.resources, folderCoverCandidates(entry.resources))
    return covers
  })

  const visibleThumbnailResources = computed(() => {
    const resources = new Map<string, ResourceSummary>()
    for (const entry of visibleCabinetEntries.value) {
      if (entry.kind === 'resource') {
        if (entry.resource.thumbnailBlob || entry.resource.thumbnailAssetId) {
          resources.set(entry.resource.id, entry.resource)
        }
        continue
      }
      if (entry.kind === 'empty') continue
      if (entry.category.coverImage) continue
      for (const resource of visibleFolderCoverCandidates.value.get(entry.resources) ?? []) {
        resources.set(resource.id, resource)
      }
    }
    for (const resource of visibleDetailResources.value) {
      if (resource.thumbnailBlob || resource.thumbnailAssetId) resources.set(resource.id, resource)
    }
    for (const resource of isOrganizerOpen.value ? organizerResources.value : []) {
      if (resource.thumbnailBlob || resource.thumbnailAssetId) resources.set(resource.id, resource)
    }
    return Array.from(resources.values())
  })

  function revokeThumbnailUrls(): void {
    for (const release of thumbnailReleases.values()) release()
    thumbnailReleases.clear()
    thumbnailUrls.value = new Map()
    thumbnailSources.clear()
  }

  function saveCabinetLayout(layout: CabinetLayoutEntry[], persist = true): void {
    const next = sortCabinetLayout(layout)
    cabinetLayout.value = next
    if (persist) cabinetStorage.setCabinetLayout(next)
  }

  function moveCabinetEntryToSlot(
    kind: CabinetLayoutEntry['kind'],
    id: string,
    targetSlot: number,
    persist = true,
  ): boolean {
    const next = moveCabinetLayoutEntry(cabinetLayout.value, { kind, id }, targetSlot)
    if (!next) return false
    saveCabinetLayout(next, persist)
    if (kind === 'folder') orderedFolderIds.value = getCabinetFolderOrder(next)
    return true
  }

  function reconcileCabinetLayout(): void {
    const validEntries = [
      ...orderedCategories.value.map((category) => ({ kind: 'folder' as const, id: category.id })),
      ...cabinetResources.value.map((resource) => ({ kind: 'resource' as const, id: resource.id })),
    ]
    const stored = cabinetStorage.getCabinetLayout()
    const next = reconcileStoredCabinetLayout(stored, validEntries)
    cabinetLayout.value = next
    if (cabinetLayoutSignature(next) !== cabinetLayoutSignature(stored)) {
      cabinetStorage.setCabinetLayout(next)
    }
  }

  function publishThumbnail(
    resource: ResourceSummary,
    source: ThumbnailSource,
    image: Blob | string,
  ): void {
    if (thumbnailSources.get(resource.id) !== source) return
    const lease = thumbnailCache?.acquire(resource, image) ?? {
      url: typeof image === 'string' ? image : URL.createObjectURL(image),
      native: typeof image === 'string',
      release() {
        if (!this.native) URL.revokeObjectURL(this.url)
      },
    }
    source.nativeUrl = lease.native ? lease.url : undefined
    thumbnailReleases.set(resource.id, () => lease.release())
    thumbnailUrls.value = new Map(thumbnailUrls.value).set(resource.id, lease.url)
  }

  function readThumbnail(resource: ResourceSummary, source: ThumbnailSource, native = true): void {
    if (native && assetStore.supportsImageUrls) {
      pendingThumbnails.set(
        resource.id,
        enqueueThumbnailRead(
          async () => {
            if (!source.assetId || thumbnailSources.get(resource.id) !== source) return
            try {
              const url = await assetStore.getImageUrl(source.assetId)
              if (thumbnailSources.get(resource.id) !== source) return
              if (url) {
                publishThumbnail(resource, source, url)
                pendingThumbnails.delete(resource.id)
              } else readThumbnail(resource, source, false)
            } catch {
              if (thumbnailSources.get(resource.id) === source)
                pendingThumbnails.delete(resource.id)
            }
          },
          undefined,
          'source',
        ),
      )
      return
    }
    pendingThumbnails.set(
      resource.id,
      enqueueThumbnailRead(async () => {
        try {
          if (!source.assetId || thumbnailSources.get(resource.id) !== source) return
          const blob = await assetStore.getBlob(source.assetId)
          if (blob) publishThumbnail(resource, source, blob)
        } catch {
          /* A missing thumbnail must not hold back other cabinet images. */
        } finally {
          if (thumbnailSources.get(resource.id) === source) pendingThumbnails.delete(resource.id)
        }
      }),
    )
  }

  function handleThumbnailError(id: string, event: Event): void {
    const source = thumbnailSources.get(id)
    const url = (event.target as HTMLImageElement).getAttribute('src')
    if (!source?.nativeUrl || url !== source.nativeUrl) return
    const resource = visibleThumbnailResources.value.find((item) => item.id === id)
    if (!resource) return
    thumbnailCache?.invalidate(resource, url)
    source.nativeUrl = undefined
    thumbnailReleases.get(id)?.()
    thumbnailReleases.delete(id)
    thumbnailUrls.value = new Map(thumbnailUrls.value)
    thumbnailUrls.value.delete(id)
    readThumbnail(resource, source, false)
  }

  watch(
    visibleThumbnailResources,
    (resources) => {
      for (const [id, old] of thumbnailSources) {
        const resource = resources.find((item) => item.id === id)
        if (
          resource?.contentHash === old.hash &&
          resource.thumbnailBlob === old.blob &&
          resource.thumbnailAssetId === old.assetId
        )
          continue
        pendingThumbnails.get(id)?.()
        pendingThumbnails.delete(id)
        thumbnailSources.delete(id)
        thumbnailReleases.get(id)?.()
        thumbnailReleases.delete(id)
        thumbnailUrls.value.delete(id)
      }
      thumbnailUrls.value = new Map(thumbnailUrls.value)
      for (const resource of resources) {
        if (thumbnailSources.has(resource.id)) continue
        const source: ThumbnailSource = {
          blob: resource.thumbnailBlob,
          assetId: resource.thumbnailAssetId,
          hash: resource.contentHash,
        }
        thumbnailSources.set(resource.id, source)
        const cached = thumbnailCache?.acquire(resource)
        if (cached) {
          if (cached.native && !assetStore.supportsImageUrls) {
            thumbnailCache?.invalidate(resource, cached.url)
            cached.release()
          } else {
            source.nativeUrl = cached.native ? cached.url : undefined
            thumbnailReleases.set(resource.id, cached.release)
            thumbnailUrls.value = new Map(thumbnailUrls.value).set(resource.id, cached.url)
            continue
          }
        }
        if (source.blob) {
          publishThumbnail(resource, source, source.blob)
          continue
        }
        readThumbnail(resource, source)
      }
    },
    { immediate: true },
  )

  onUnmounted(() => {
    for (const cancel of pendingThumbnails.values()) cancel()
    pendingThumbnails.clear()
    revokeThumbnailUrls()
  })

  watch(
    () => props.categories.map((category) => `${category.id}:${category.sortOrder ?? ''}`),
    () => {
      const incomingIds = props.categories.map((category) => category.id)
      const incomingSet = new Set(incomingIds)
      const preserved = orderedFolderIds.value.filter((id) => incomingSet.has(id))
      const preservedSet = new Set(preserved)
      orderedFolderIds.value = [...preserved, ...incomingIds.filter((id) => !preservedSet.has(id))]
    },
    { immediate: true },
  )

  watch(
    [
      () => props.categories.map((category) => category.id).join('|'),
      () => props.cabinetResourceIds.join('|'),
      () => props.resources.map((resource) => resource.id).join('|'),
    ],
    reconcileCabinetLayout,
    { immediate: true },
  )

  watch([folderPageCount, folderPageSize], () => {
    folderPage.value = Math.min(folderPage.value, folderPageCount.value - 1)
  })

  watch(activeFolderEntry, (entry) => {
    if (activeFolderId.value !== undefined && !entry) activeFolderId.value = undefined
  })

  watch(detailQuery, () => {
    detailLimit.value = 24
  })

  watch(detailType, () => {
    detailLimit.value = 24
  })

  watch(isOrganizerOpen, async (open) => {
    document.body.classList.toggle('folder-organizer-open', open)
    if (open) {
      await nextTick()
      organizerCloseButton.value?.focus({ preventScroll: true })
    } else {
      organizerTrigger?.focus({ preventScroll: true })
      organizerTrigger = undefined
    }
  })

  function coverResources(resources: ResourceSummary[]): ResourceSummary[] {
    return (visibleFolderCoverCandidates.value.get(resources) ?? []).filter((resource) =>
      thumbnailUrls.value.has(resource.id),
    )
  }

  function folderCoverCandidates(resources: ResourceSummary[]): ResourceSummary[] {
    const candidates: ResourceSummary[] = []
    for (const resource of resources) {
      if (resource.thumbnailBlob || resource.thumbnailAssetId) candidates.push(resource)
      if (candidates.length === 4) break
    }
    return candidates
  }

  function toggleResource(resourceId: string): void {
    const selected = new Set(selectedResourceIds.value)
    if (selected.has(resourceId)) selected.delete(resourceId)
    else selected.add(resourceId)
    selectedResourceIds.value = selected
  }

  function handleResourceClick(resourceId: string): void {
    if (Date.now() < suppressResourceClickUntil) return
    toggleResource(resourceId)
  }

  function clearSelection(): void {
    selectedResourceIds.value = new Set()
  }

  function startDrag(event: DragEvent, resourceId: string, fromCabinet = false): void {
    const resourceIds = selectedResourceIds.value.has(resourceId)
      ? Array.from(selectedResourceIds.value)
      : [resourceId]
    if (!selectedResourceIds.value.has(resourceId)) {
      selectedResourceIds.value = new Set(resourceIds)
    }
    event.dataTransfer?.setData('application/x-srl-resource-ids', JSON.stringify(resourceIds))
    event.dataTransfer?.setData('application/x-srl-cabinet-resource', String(fromCabinet))
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy'
  }

  function readDraggedIds(event: DragEvent): string[] {
    try {
      const value = JSON.parse(
        event.dataTransfer?.getData('application/x-srl-resource-ids') ?? '[]',
      )
      return Array.isArray(value)
        ? value.filter((id): id is string => typeof id === 'string' && Boolean(id))
        : []
    } catch {
      return []
    }
  }

  function dropIntoFolder(event: DragEvent, categoryId: string): void {
    activeDropId.value = ''
    const resourceIds = readDraggedIds(event)
    if (!resourceIds.length) return
    emit('add', {
      categoryId,
      resourceIds,
      removeFromCabinet:
        event.dataTransfer?.getData('application/x-srl-cabinet-resource') === 'true',
    })
    clearSelection()
  }

  function activateDrop(category?: Category): void {
    activeDropId.value = category?.id ?? ''
  }

  function addSelected(categoryId: string): void {
    const resourceIds = Array.from(selectedResourceIds.value)
    if (props.busy || !resourceIds.length) return
    emit('add', { categoryId, resourceIds })
    clearSelection()
    closeOrganizer()
  }

  function pinSelected(): void {
    const resourceIds = Array.from(selectedResourceIds.value)
    if (!resourceIds.length) return
    emit('pin', resourceIds)
    clearSelection()
    closeOrganizer()
  }

  function openCabinetResource(resource: ResourceSummary): void {
    if (Date.now() < suppressResourceClickUntil || isFolderEditMode.value) return
    emit('openResource', resource)
  }

  function openFolder(categoryId: string | null): void {
    if (Date.now() < suppressFolderClickUntil || isFolderEditMode.value) return
    activeFolderId.value = categoryId
    detailQuery.value = ''
    detailType.value = 'all'
    detailLimit.value = 24
    cabinetRoot.value?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  }

  function returnToCabinet(): void {
    activeFolderId.value = undefined
    detailQuery.value = ''
    detailType.value = 'all'
    detailLimit.value = 24
    cabinetRoot.value?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  }

  function setFolderPage(nextPage: number): void {
    folderPage.value = Math.min(folderPageCount.value - 1, Math.max(0, nextPage))
  }

  function toggleFolderEditMode(): void {
    isFolderEditMode.value = !isFolderEditMode.value
    cancelFolderDrag()
  }

  async function openRename(category: Category): Promise<void> {
    renamingCategory.value = category
    renameDraft.value = category.name
    coverUrlDraft.value = category.coverImage?.startsWith('https://') ? category.coverImage : ''
    folderEditError.value = ''
    await nextTick()
    renameInput.value?.focus({ preventScroll: true })
    renameInput.value?.select()
  }

  function closeRename(): void {
    renamingCategory.value = undefined
    renameDraft.value = ''
    coverUrlDraft.value = ''
    folderEditError.value = ''
  }

  function saveRename(): void {
    const category = renamingCategory.value
    const name = renameDraft.value.trim()
    if (!category || !name || props.busy) return
    let coverUrl = ''
    if (coverUrlDraft.value.trim()) {
      try {
        coverUrl = normalizeFolderCoverUrl(coverUrlDraft.value)
      } catch (error) {
        folderEditError.value = error instanceof Error ? error.message : '封面直链格式无效'
        return
      }
    }
    const previousUrl = category.coverImage?.startsWith('https://') ? category.coverImage : ''
    const nameChanged = name !== category.name
    const coverChanged = Boolean(coverUrl && coverUrl !== previousUrl)
    if (nameChanged) {
      emit('rename', {
        category,
        name,
        ...(coverChanged ? { coverChanged: true, coverImage: coverUrl } : {}),
      })
    } else if (coverChanged) {
      emit('cover', { category, coverUrl })
    }
    closeRename()
  }

  function handleEditCoverFile(event: Event): void {
    const category = renamingCategory.value
    const name = renameDraft.value.trim()
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!category || !name || !file || props.busy) return
    emit('rename', { category, name, coverChanged: true, file })
    closeRename()
  }

  function restoreAutomaticCover(): void {
    const category = renamingCategory.value
    const name = renameDraft.value.trim()
    if (!category || !name || props.busy) return
    emit('rename', { category, name, coverChanged: true, coverImage: undefined })
    closeRename()
  }

  function openOrganizer(event: Event, destination: 'cabinet' | 'folders' = 'folders'): void {
    organizerTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined
    organizerDestination.value = destination
    organizerType.value = destination === 'folders' ? 'unclassified' : 'all'
    isOrganizerOpen.value = true
  }

  function openCabinetOrganizer(event: Event): void {
    openOrganizer(event, 'cabinet')
  }

  function closeOrganizer(): void {
    isOrganizerOpen.value = false
    clearSelection()
    searchQuery.value = ''
    organizerType.value = 'all'
    cancelTouchDrag()
  }

  function cancelTouchDrag(): void {
    if (touchHoldTimer !== undefined) window.clearTimeout(touchHoldTimer)
    touchHoldTimer = undefined
    if (touchMoveFrame !== undefined) window.cancelAnimationFrame(touchMoveFrame)
    touchMoveFrame = undefined
    pendingTouchMove = undefined
    window.removeEventListener('pointermove', handlePointerMove)
    window.removeEventListener('pointerup', finishTouchDrag)
    window.removeEventListener('pointercancel', handleTouchPointerCancel)
    touchCandidate = undefined
    touchDrag.value = undefined
    activeDropId.value = ''
  }

  function flushTouchPointerMove(): void {
    touchMoveFrame = undefined
    const position = pendingTouchMove
    pendingTouchMove = undefined
    const drag = touchDrag.value
    if (!position || !drag) return

    const target = document.elementFromPoint?.(position.x, position.y)
    const folderTarget = target?.closest<HTMLElement>('[data-folder-drop-id]')
    activeDropId.value = folderTarget?.dataset.folderDropId ?? ''
    const slot = Number(target?.closest<HTMLElement>('[data-cabinet-slot]')?.dataset.cabinetSlot)
    touchDrag.value = {
      ...drag,
      x: position.x,
      y: position.y,
      targetSlot: !folderTarget && Number.isInteger(slot) ? slot : undefined,
    }
  }

  function handleTouchPointerCancel(event: PointerEvent): void {
    if (!touchCandidate || touchCandidate.pointerId !== event.pointerId) return
    cancelTouchDrag()
  }

  function handlePointerDown(
    event: PointerEvent,
    resource: ResourceSummary,
    fromCabinet = false,
  ): void {
    if (event.pointerType === 'mouse' || props.busy) return
    if (event.target instanceof Element && event.target.closest('[data-cabinet-action]')) return
    cancelTouchDrag()
    const source = event.currentTarget
    if (!(source instanceof HTMLElement)) return
    touchCandidate = {
      pointerId: event.pointerId,
      resourceId: resource.id,
      startX: event.clientX,
      startY: event.clientY,
      source,
      fromCabinet,
    }
    window.addEventListener('pointermove', handlePointerMove, { passive: false })
    window.addEventListener('pointerup', finishTouchDrag)
    window.addEventListener('pointercancel', handleTouchPointerCancel)
    const holdMs = fromCabinet
      ? isFolderEditMode.value
        ? FOLDER_EDIT_HOLD_MS
        : FOLDER_HOLD_MS
      : 320
    touchHoldTimer = window.setTimeout(() => {
      if (!touchCandidate || touchCandidate.pointerId !== event.pointerId) return
      if (fromCabinet) isFolderEditMode.value = true
      const resourceIds = selectedResourceIds.value.has(resource.id)
        ? Array.from(selectedResourceIds.value)
        : [resource.id]
      selectedResourceIds.value = new Set(resourceIds)
      touchCandidate.source.setPointerCapture?.(event.pointerId)
      touchDrag.value = {
        pointerId: event.pointerId,
        resourceIds,
        x: event.clientX,
        y: event.clientY,
        label: resourceIds.length > 1 ? `${resourceIds.length} 项资源` : resource.name,
      }
      navigator.vibrate?.(12)
    }, holdMs)
  }

  function handlePointerMove(event: PointerEvent): void {
    if (!touchCandidate || touchCandidate.pointerId !== event.pointerId) return
    if (!touchDrag.value) {
      const distance = Math.hypot(
        event.clientX - touchCandidate.startX,
        event.clientY - touchCandidate.startY,
      )
      if (distance > 10) cancelTouchDrag()
      return
    }
    event.preventDefault()
    pendingTouchMove = { x: event.clientX, y: event.clientY }
    if (touchMoveFrame === undefined) {
      touchMoveFrame = window.requestAnimationFrame(flushTouchPointerMove)
    }
  }

  function finishTouchDrag(event: PointerEvent): void {
    if (!touchCandidate || touchCandidate.pointerId !== event.pointerId) return
    if (touchMoveFrame !== undefined) window.cancelAnimationFrame(touchMoveFrame)
    flushTouchPointerMove()
    if (touchDrag.value) {
      event.preventDefault()
      const resourceIds = touchDrag.value.resourceIds
      const categoryId = activeDropId.value
      suppressResourceClickUntil = Date.now() + 450
      if (categoryId && resourceIds.length) {
        emit('add', {
          categoryId,
          resourceIds,
          removeFromCabinet: touchCandidate.fromCabinet,
        })
        navigator.vibrate?.(20)
        clearSelection()
        if (isOrganizerOpen.value) closeOrganizer()
      } else if (
        touchCandidate.fromCabinet &&
        touchDrag.value.targetSlot !== undefined &&
        moveCabinetEntryToSlot('resource', touchCandidate.resourceId, touchDrag.value.targetSlot)
      ) {
        navigator.vibrate?.(20)
      }
    }
    cancelTouchDrag()
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    if (renamingCategory.value) closeRename()
    else if (folderDrag.value) cancelFolderDrag(true)
    else if (isOrganizerOpen.value) closeOrganizer()
    else if (isFolderEditMode.value) isFolderEditMode.value = false
    else if (activeFolderId.value !== undefined) returnToCabinet()
    else return
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  onMounted(() => {
    window.addEventListener('keydown', handleKeydown)
  })

  onUnmounted(() => {
    window.removeEventListener('keydown', handleKeydown)
    document.body.classList.remove('folder-organizer-open')
    cancelTouchDrag()
    cancelFolderDrag()
    cancelPagerGesture()
  })

  function handleCoverFile(category: Category, event: Event): void {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (file) emit('cover', { category, file })
  }
  return {
    activeFolderId,
    cabinetGridStyle,
    isFolderEditMode,
    handlePagerPointerDown,
    handlePagerPointerMove,
    finishPagerGesture,
    cancelPagerGesture,
    folderPage,
    visibleCabinetEntries,
    activeDropId,
    folderDrag,
    activateDrop,
    dropIntoFolder,
    handleFolderPointerDown,
    openFolder,
    moveFolderByKeyboard,
    coverResources,
    thumbnailUrls,
    handleThumbnailError,
    openRename,
    handleCoverFile,
    selectedResourceIds,
    addSelected,
    startDrag,
    handlePointerDown,
    handlePointerMove,
    finishTouchDrag,
    cancelTouchDrag,
    openCabinetResource,
    RESOURCE_TYPE_LABELS,
    folderPageCount,
    setFolderPage,
    openCabinetOrganizer,
    toggleFolderEditMode,
    clearSelection,
    searchQuery,
    trayResources,
    handleResourceClick,
    activeFolderEntry,
    returnToCabinet,
    openOrganizer,
    detailTypeOptions,
    detailType,
    detailQuery,
    visibleDetailResources,
    detailResources,
    detailLimit,
    isOrganizerOpen,
    closeOrganizer,
    organizerDestination,
    organizerType,
    unclassifiedResourceCount,
    organizerTypeOptions,
    organizerResources,
    availableOrganizerResources,
    pinSelected,
    touchDrag,
    orderedCategories,
    renamingCategory,
    closeRename,
    saveRename,
    renameDraft,
    coverUrlDraft,
    folderEditError,
    handleEditCoverFile,
    restoreAutomaticCover,
  }
}
