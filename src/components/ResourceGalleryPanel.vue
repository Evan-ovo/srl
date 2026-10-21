<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useTemplateRef, watch } from 'vue'
import { resourceGalleryService as gallery, resourceService } from '../core/AppContainer'
import { platform } from '../core/PlatformService'
import { nativeFileSource } from '../core/NativeFileSource'
import { RESOURCE_TYPE_LABELS, type Resource, type ResourceSummary } from '../types/Resource'
import {
  galleryImageUrl,
  resourceCoverId,
  type ResourceGalleryQuery,
  type ResourceGalleryQuality,
} from '../types/ResourceGallery'
import { useLoadedObjectUrl } from '../composables/UseLoadedObjectUrl'
import { confirmAction } from '../composables/UseConfirmDialog'
import ActionSheet, { type ActionSheetAction } from './ActionSheet.vue'
import ResourceImageAdd from './ResourceImageAdd.vue'
import ResourceImageViewer from './ResourceImageViewer.vue'
import ResourceGalleryTile from './ResourceGalleryTile.vue'
import '../styles/ResourceGallery.css'

const props = defineProps<{ resource: Resource }>()
const emit = defineEmits<{ saved: [resource: Resource]; count: [count: number] }>()
const page = ref<Awaited<ReturnType<typeof gallery.list>>>({
  items: [],
  total: 0,
  galleryCount: 0,
  page: 1,
  pageCount: 1,
  categories: [],
  availableCategories: [],
})
const query = ref<ResourceGalleryQuery>({
  search: '',
  category: '',
  source: '',
  sort: 'newest',
  page: 1,
})
const busy = ref(false)
const loadingGallery = ref(false)
const error = ref('')
const notice = ref('')
const editor = ref<'' | 'add' | 'classify' | 'edit' | 'batch' | 'category'>('')
const imageInput = useTemplateRef<{ hasDraft: boolean }>('imageInput')
const editingId = ref('')
const editName = ref('')
const editDescription = ref('')
const chosenCategories = ref<string[]>([])
const newCategory = ref('')
const importedIds = ref<string[]>([])
const editorPanel = ref<HTMLElement>()
const categoryOptions = computed(() => [
  ...new Set([...page.value.availableCategories, ...chosenCategories.value]),
])
const typeLabel = computed(() => RESOURCE_TYPE_LABELS[props.resource.type])
const editorTitle = computed(() =>
  editor.value
    ? {
        add: '添加图片',
        classify: `选择分类 · ${importedIds.value.length} 张`,
        edit: '编辑图片',
        batch: `分类 · ${selected.value.size} 张`,
        category: `管理分类 · ${typeLabel.value}`,
      }[editor.value]
    : '',
)
let previousFocus: HTMLElement | null = null
watch(editor, async (value, previous) => {
  if (value) {
    if (!previous)
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    await nextTick()
    editorPanel.value?.focus({ preventScroll: true })
  } else {
    newCategory.value = ''
    previousFocus?.focus({ preventScroll: true })
  }
})
function toggleCategory(category: string) {
  chosenCategories.value = chosenCategories.value.includes(category)
    ? chosenCategories.value.filter((c) => c !== category)
    : [...chosenCategories.value, category]
}
async function createCategory() {
  const value = newCategory.value.trim()
  if (!value || busy.value) return
  await run(async (owner) => {
    const saved = await gallery.createCategory(owner, value)
    if (props.resource.id !== owner) return
    if (editor.value === 'category') selectManagedCategory(saved)
    else chosenCategories.value = [...new Set([...chosenCategories.value, saved])]
    newCategory.value = ''
    notice.value = '分类已新建'
  })
}
function createCategoryOnEnter(event: KeyboardEvent): void {
  if (event.isComposing) return
  event.preventDefault()
  void createCategory()
}
function editorKey(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.stopPropagation()
    void closeEditor()
    return
  }
  if (event.key !== 'Tab') return
  const controls = [
    ...(editorPanel.value?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)',
    ) || []),
  ].filter((el) => el.getClientRects().length)
  const first = controls[0],
    last = controls.at(-1)
  if (
    event.shiftKey &&
    (document.activeElement === first || document.activeElement === editorPanel.value)
  ) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first?.focus()
  }
}
function classifyImages(ids: string[]) {
  importedIds.value = [...new Set(ids)]
  chosenCategories.value = []
  newCategory.value = ''
  editor.value = 'classify'
}
const categoryFrom = ref('')
const categoryTo = ref('')
const selected = ref(new Set<string>())
const selecting = ref(false)
const menuImage = ref<ResourceSummary>()
const moreOpen = ref(false)
const filterOpen = ref<'' | 'category' | 'source' | 'sort'>('')
const categoryLabel = computed(() =>
  query.value.category === '__unclassified__' ? '未分类' : query.value.category || '全部分类',
)
const sourceLabels = { '': '全部来源', local: '本地图片', url: '图片链接' } as const
const sortLabels = { newest: '最新添加', oldest: '最早添加', name: '名称排序' } as const
const filterTitle = computed(
  () => ({ category: '图片分类', source: '图片来源', sort: '图片排序', '': '' })[filterOpen.value],
)
const filterActions = computed<ActionSheetAction[]>(() => {
  const kind = filterOpen.value
  if (!kind) return []
  const options =
    kind === 'category'
      ? [
          ['', '全部分类'],
          ['__unclassified__', '未分类'],
          ...page.value.categories.map((c) => [c, c]),
        ]
      : Object.entries(kind === 'source' ? sourceLabels : sortLabels)
  return options.map(([value, label]) => ({
    id: `value:${value}`,
    label: label!,
    selected: query.value[kind] === value,
  }))
})
function selectFilter(action: ActionSheetAction) {
  const value = action.id.slice(6)
  if (filterOpen.value === 'category') query.value.category = value
  if (filterOpen.value === 'source') query.value.source = value as ResourceGalleryQuery['source']
  if (filterOpen.value === 'sort') query.value.sort = value as ResourceGalleryQuery['sort']
  query.value.page = 1
  filterOpen.value = ''
}
const viewerId = ref('')
const viewerName = ref('')
const viewerNativeSource = ref<string>()
const viewerNavigating = ref(false)
const { previewUrl, replacePreview, releasePreview, confirmPreviewLoaded } = useLoadedObjectUrl()
const viewerIndex = computed(() => page.value.items.findIndex((r) => r.id === viewerId.value))
const viewerPosition = computed(
  () => (page.value.page - 1) * (query.value.pageSize || 30) + viewerIndex.value + 1,
)
let revision = 0
let loadRevision = 0
let viewRevision = 0

async function load() {
  const token = ++loadRevision
  loadingGallery.value = true
  const owner = props.resource.id
  try {
    const result = await gallery.list(owner, query.value)
    if (token !== loadRevision || owner !== props.resource.id) return
    page.value = result
    emit('count', result.galleryCount)
  } catch (cause) {
    if (token === loadRevision) error.value = message(cause)
  } finally {
    if (token === loadRevision) loadingGallery.value = false
  }
}
function message(cause: unknown) {
  return cause instanceof Error ? cause.message : '操作失败，请重试'
}
async function run(action: (owner: string) => Promise<void>) {
  if (busy.value) return
  const owner = props.resource.id
  const token = revision
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    await action(owner)
  } catch (cause) {
    if (token === revision) error.value = message(cause)
  } finally {
    if (token === revision) {
      try {
        await load()
        const resource = await resourceService.get(owner)
        if (resource && token === revision) emit('saved', resource)
      } catch (cause) {
        if (token === revision && !error.value) error.value = message(cause)
      } finally {
        if (token === revision) busy.value = false
      }
    }
  }
}
watch(
  () => props.resource.id,
  () => {
    revision++
    busy.value = false
    query.value = { search: '', category: '', source: '', sort: 'newest', page: 1 }
    selected.value = new Set()
    editor.value = ''
    filterOpen.value = ''
    menuImage.value = undefined
    error.value = ''
    notice.value = ''
    closeViewer()
    void load()
  },
  { immediate: true },
)
watch(
  query,
  () => {
    selected.value = new Set()
    void load()
  },
  { deep: true },
)
onBeforeUnmount(() => {
  revision++
  loadRevision++
  viewRevision++
})

async function addFiles(files: File[], quality: ResourceGalleryQuality) {
  const token = revision
  await run(async (owner) => {
    const completed: string[] = []
    const failures: string[] = []
    for (const file of files) {
      if (token !== revision) break
      try {
        const image = await gallery.addFile(owner, file, [], true, quality)
        completed.push(image.id)
      } catch (cause) {
        failures.push(`${file.name}：${message(cause)}`)
      }
      if (token === revision)
        notice.value = `${completed.length + failures.length} / ${files.length}`
    }
    if (token !== revision) return
    notice.value = `已处理 ${completed.length} 张${failures.length ? `，失败 ${failures.length} 张` : ''}`
    error.value = failures.join('\n')
    if (completed.length) classifyImages(completed)
  })
}
async function addUrl(url: string, download: boolean, quality: ResourceGalleryQuality) {
  await run(async (owner) => {
    const image = await gallery.addUrl(owner, url, download, [], true, quality)
    if (props.resource.id !== owner) return
    classifyImages([image.id])
    notice.value = download ? '本地副本已保存' : '图片链接已保存'
  })
}
function toggle(id: string) {
  const next = new Set(selected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selected.value = next
}
async function setCover(image: ResourceSummary) {
  await run(async (owner) => {
    await gallery.setCover(owner, image.id)
    if (props.resource.id !== owner) return
    notice.value = '封面已更新'
  })
}
function closeViewer() {
  viewRevision++
  viewerId.value = ''
  releasePreview()
}
async function view(image: ResourceSummary) {
  const token = ++viewRevision
  const owner = props.resource.id
  try {
    const full = await gallery.getImage(owner, image.id)
    if (token !== viewRevision) return
    replacePreview(galleryImageUrl(full) || URL.createObjectURL(full.originalBlob))
    viewerNativeSource.value = galleryImageUrl(full)
      ? undefined
      : nativeFileSource(full.originalBlob)
    viewerName.value = full.name
    viewerId.value = full.id
  } catch (cause) {
    if (token === viewRevision) error.value = message(cause)
  }
}
async function nextImage(offset: number) {
  if (viewerNavigating.value) return
  const owner = props.resource.id
  const token = viewRevision
  viewerNavigating.value = true
  try {
    let item: ResourceSummary | undefined = page.value.items[viewerIndex.value + offset]
    if (!item) {
      const nextPage = page.value.page + offset
      if (nextPage < 1 || nextPage > page.value.pageCount) return
      const result = await gallery.list(owner, { ...query.value, page: nextPage })
      if (owner !== props.resource.id || token !== viewRevision || !viewerId.value) return
      item = offset > 0 ? result.items[0] : result.items.at(-1)
      page.value = result
      query.value.page = result.page
    }
    if (item) await view(item)
  } catch (cause) {
    if (owner === props.resource.id) error.value = message(cause)
  } finally {
    viewerNavigating.value = false
  }
}

async function download(image: ResourceSummary) {
  await run(async (owner) => {
    const full = await gallery.getImage(owner, image.id)
    const url = galleryImageUrl(full)
    let blob = full.originalBlob
    if (url) {
      const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' })
      if (!response.ok) throw new Error(`下载失败（${response.status}）`)
      blob = await response.blob()
      if (!blob.type.startsWith('image/')) throw new Error('链接没有返回图片')
    }
    await platform.share.blob(
      blob,
      url
        ? `${full.name.replace(/\.[^.]+$/, '')}.${blob.type.split('/')[1] || 'png'}`
        : full.fileName,
    )
  })
}
async function remove(ids: string[]) {
  if (!ids.length) return
  if (
    !(await confirmAction({
      title: `移除 ${ids.length} 张图片`,
      message: '移除图库记录及本地图片，当前封面会保留。此操作不能撤销。',
      confirmLabel: '移除',
      danger: true,
    }))
  )
    return
  await run(async (owner) => {
    await gallery.remove(owner, ids)
    if (props.resource.id !== owner) return
    selected.value = new Set()
    notice.value = '已移除'
  })
}
async function menuAction(action: ActionSheetAction) {
  const image = menuImage.value
  menuImage.value = undefined
  if (!image) return
  if (action.id === 'cover') await setCover(image)
  if (action.id === 'download') await download(image)
  if (action.id === 'remove') await remove([image.id])
  if (action.id === 'edit') {
    editingId.value = image.id
    editName.value = image.name
    editDescription.value = image.description
    chosenCategories.value = [...image.tags]
    newCategory.value = ''
    editor.value = 'edit'
  }
}
async function saveEditor() {
  if (newCategory.value.trim()) {
    await createCategory()
    if (error.value) return
  }
  await run(async (owner) => {
    if (editor.value === 'classify')
      await gallery.setCategories(owner, importedIds.value, chosenCategories.value, true)
    if (editor.value === 'edit')
      await gallery.edit(owner, editingId.value, {
        name: editName.value,
        description: editDescription.value,
        tags: chosenCategories.value,
      })
    if (editor.value === 'batch')
      await gallery.setCategories(owner, [...selected.value], chosenCategories.value)
    if (editor.value === 'category') {
      if (!categoryFrom.value) throw new Error('请选择分类')
      if (!categoryTo.value.trim()) throw new Error('请输入分类名称')
      await gallery.renameCategory(owner, categoryFrom.value, categoryTo.value)
      query.value.category = ''
    }
    if (props.resource.id !== owner) return
    editor.value = ''
    notice.value = '已保存'
  })
}
async function deleteCategory() {
  const category = categoryFrom.value
  if (!category || busy.value) return
  if (
    !(await confirmAction({
      title: '删除分类',
      message: `从所有${typeLabel.value}的图库中移除“${category}”分类，保留图片和其他分类。`,
      confirmLabel: '删除分类',
      danger: true,
    }))
  )
    return
  await run(async (owner) => {
    await gallery.renameCategory(owner, category, '')
    if (query.value.category === category) query.value.category = ''
    categoryFrom.value = ''
    categoryTo.value = ''
    notice.value = '分类已删除，图片已保留'
  })
}
function selectManagedCategory(category: string) {
  categoryFrom.value = category
  categoryTo.value = category
}
function more(action: ActionSheetAction) {
  if (action.id === 'select') selecting.value = !selecting.value
  if (action.id === 'categories') {
    editor.value = 'category'
    categoryFrom.value = page.value.availableCategories.includes(query.value.category || '')
      ? query.value.category!
      : ''
    categoryTo.value = categoryFrom.value
  }
}
function toggleAdd() {
  if (editor.value === 'add') {
    void closeEditor()
    return
  }
  editor.value = 'add'
  error.value = ''
  notice.value = ''
  chosenCategories.value = []
  newCategory.value = ''
}
function startBatch() {
  editor.value = 'batch'
  chosenCategories.value = []
  newCategory.value = ''
}
function finishSelection() {
  selecting.value = false
  selected.value = new Set()
}
async function closeEditor() {
  if (busy.value) return
  const before = page.value.items.find((image) => image.id === editingId.value)
  const changed =
    editor.value === 'edit'
      ? before &&
        (editName.value !== before.name ||
          editDescription.value !== before.description ||
          JSON.stringify(chosenCategories.value) !== JSON.stringify(before.tags) ||
          Boolean(newCategory.value.trim()))
      : editor.value === 'category'
        ? categoryTo.value !== categoryFrom.value || Boolean(newCategory.value.trim())
        : Boolean(
            chosenCategories.value.length || newCategory.value.trim() || imageInput.value?.hasDraft,
          )
  if (
    changed &&
    !(await confirmAction({
      title: '放弃图片编辑？',
      message:
        editor.value === 'classify' ? '图片已保存，尚未应用的分类将丢失。' : '未保存的修改将丢失。',
      confirmLabel: '放弃修改',
    }))
  )
    return
  editor.value = ''
}
defineExpose({
  busy,
  editing: computed(() => Boolean(editor.value || viewerId.value)),
  requestBack: () => {
    if (busy.value) return
    if (viewerId.value) closeViewer()
    else void closeEditor()
  },
})
</script>
<template>
  <div
    class="resource-gallery"
    :aria-busy="busy || loadingGallery"
    @keydown.enter="
      !$event.isComposing &&
      ($event.target as HTMLElement).tagName === 'INPUT' &&
      $event.preventDefault()
    "
  >
    <div class="resource-gallery__controls">
      <div class="resource-gallery__toolbar">
        <input
          v-model="query.search"
          class="field__control"
          type="search"
          aria-label="搜索图库"
          placeholder="搜索图片或备注"
          @input="query.page = 1"
        />
        <button class="button button--primary" type="button" :disabled="busy" @click="toggleAdd">
          添加
        </button>
        <button
          class="button button--quiet"
          type="button"
          aria-label="图库更多操作"
          :disabled="busy"
          @click="moreOpen = true"
        >
          ⋯
        </button>
      </div>
      <div v-if="page.galleryCount" class="resource-gallery__filters">
        <button
          v-for="filter in [
            {
              key: 'category' as const,
              label: categoryLabel,
              name: '图片分类',
            },
            {
              key: 'source' as const,
              label: sourceLabels[query.source || ''],
              name: '图片来源',
            },
            {
              key: 'sort' as const,
              label: sortLabels[query.sort || 'newest'],
              name: '图片排序',
            },
          ]"
          :key="filter.key"
          type="button"
          class="button button--quiet resource-gallery__filter"
          :aria-label="`${filter.name}：${filter.label}`"
          :title="filter.label"
          aria-haspopup="dialog"
          :aria-expanded="filterOpen === filter.key"
          :disabled="busy"
          @click="filterOpen = filter.key"
        >
          <span>{{ filter.label }}</span>
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path
              d="m4 6 4 4 4-4"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </div>
    </div>
    <Teleport to="body">
      <div
        v-if="editor"
        class="editor-overlay resource-gallery-dialog"
        role="presentation"
        @click.self="closeEditor"
      >
        <section
          ref="editorPanel"
          class="editor-sheet resource-gallery__editor"
          role="dialog"
          aria-modal="true"
          :aria-label="editorTitle"
          tabindex="-1"
          @keydown="editorKey"
        >
          <header class="resource-gallery__bar">
            <strong class="resource-gallery__title">{{ editorTitle }}</strong>
            <button
              class="editor-sheet__close"
              type="button"
              aria-label="关闭图片编辑"
              :disabled="busy"
              @click="closeEditor"
            >
              ×
            </button>
          </header>
          <template v-if="editor === 'edit'"
            ><label class="field"
              ><span class="field__label">名称</span
              ><input v-model="editName" class="field__control" maxlength="160" /></label
            ><label class="field"
              ><span class="field__label">备注</span
              ><textarea
                v-model="editDescription"
                class="field__control"
                maxlength="5000"
                rows="2"
              /></label
          ></template>
          <div
            v-if="['edit', 'batch', 'classify'].includes(editor)"
            class="resource-gallery__categories"
          >
            <span class="field__label">{{ typeLabel }}图库分类</span>
            <div
              v-if="categoryOptions.length"
              class="resource-gallery__category-options"
              role="group"
              aria-label="选择已有分类"
            >
              <button
                v-for="category in categoryOptions"
                :key="category"
                class="button button--quiet"
                type="button"
                :aria-pressed="chosenCategories.includes(category)"
                :disabled="busy"
                @click="toggleCategory(category)"
              >
                <span>{{ category }}</span
                ><span v-if="chosenCategories.includes(category)" aria-hidden="true">✓</span>
              </button>
            </div>
            <div class="resource-gallery__new-category">
              <input
                v-model="newCategory"
                class="field__control"
                aria-label="新建分类名称"
                placeholder="新分类名称"
                maxlength="60"
                :disabled="busy"
                @keydown.enter="createCategoryOnEnter"
              />
              <button
                class="button"
                type="button"
                :disabled="busy || !newCategory.trim()"
                @click="createCategory"
              >
                新建分类
              </button>
            </div>
          </div>
          <template v-if="editor === 'category'">
            <div class="resource-gallery__new-category">
              <input
                v-model="newCategory"
                class="field__control"
                aria-label="新建分类名称"
                placeholder="输入新分类名称"
                maxlength="60"
                :disabled="busy"
                @keydown.enter="createCategoryOnEnter"
              />
              <button
                class="button"
                type="button"
                :disabled="busy || !newCategory.trim()"
                @click="createCategory"
              >
                新建分类
              </button>
            </div>
            <div
              v-if="page.availableCategories.length"
              class="resource-gallery__category-options"
              role="group"
              aria-label="要修改的分类"
            >
              <button
                v-for="category in page.availableCategories"
                :key="category"
                class="button button--quiet"
                type="button"
                :aria-pressed="categoryFrom === category"
                :disabled="busy"
                @click="selectManagedCategory(category)"
              >
                <span>{{ category }}</span
                ><span v-if="categoryFrom === category" aria-hidden="true">✓</span>
              </button>
            </div>
            <p v-else class="resource-gallery__status">暂无分类</p>
            <input
              v-if="page.availableCategories.length"
              v-model="categoryTo"
              class="field__control"
              aria-label="重命名所选分类"
              placeholder="重命名所选分类"
              :disabled="busy || !categoryFrom"
              maxlength="60"
            />
          </template>
          <ResourceImageAdd
            v-if="editor === 'add'"
            ref="imageInput"
            :busy="busy"
            multiple
            @files="addFiles"
            @url="addUrl"
          />
          <div
            v-else-if="editor !== 'category' || page.availableCategories.length"
            class="resource-gallery__bar resource-gallery__editor-actions"
          >
            <button
              v-if="editor === 'classify'"
              class="button button--quiet"
              type="button"
              :disabled="busy"
              @click="closeEditor"
            >
              稍后分类
            </button>
            <button
              v-if="editor === 'category'"
              class="button button--danger"
              type="button"
              :disabled="busy || !categoryFrom"
              @click="deleteCategory"
            >
              删除分类
            </button>
            <button
              class="button button--primary"
              type="button"
              :disabled="
                busy ||
                (editor === 'category' &&
                  (!categoryFrom || !categoryTo.trim() || categoryTo.trim() === categoryFrom))
              "
              @click="saveEditor"
            >
              {{ editor === 'category' ? '保存名称' : editor === 'classify' ? '完成' : '保存' }}
            </button>
          </div>
          <p v-if="error" class="resource-gallery__status resource-gallery__error" role="alert">
            {{ error }}
          </p>
          <p v-if="notice" class="resource-gallery__status" role="status">{{ notice }}</p>
        </section>
      </div>
    </Teleport>
    <div v-if="selecting" class="resource-gallery__bar">
      <span class="resource-gallery__title">已选 {{ selected.size }}</span>
      <button
        class="button button--quiet"
        type="button"
        @click="selected = new Set(page.items.map((r) => r.id))"
      >
        本页全选
      </button>
      <button class="button" type="button" :disabled="busy || !selected.size" @click="startBatch">
        分类
      </button>
      <button
        class="button"
        type="button"
        :disabled="busy || !selected.size"
        @click="remove([...selected])"
      >
        移除
      </button>
      <button class="button button--quiet" type="button" @click="finishSelection">完成</button>
    </div>
    <p
      v-if="error && !editor"
      class="resource-gallery__status resource-gallery__error"
      role="alert"
    >
      {{ error }}
    </p>
    <p v-if="notice && !editor" class="resource-gallery__status" role="status">{{ notice }}</p>
    <div v-if="page.items.length" class="resource-gallery__grid">
      <ResourceGalleryTile
        v-for="image in page.items"
        :key="image.id"
        :image="image"
        :disabled="loadingGallery || busy"
        :selected="selected.has(image.id)"
        :selecting="selecting"
        :cover="resourceCoverId(resource) === image.id"
        @open="view(image)"
        @select="toggle(image.id)"
        @menu="menuImage = image"
      />
    </div>
    <div v-else-if="!editor" class="resource-gallery__empty">
      <span>{{ page.galleryCount ? '没有匹配的图片' : '还没有图片' }}</span
      ><button v-if="!page.galleryCount" class="button" type="button" @click="editor = 'add'">
        添加图片
      </button>
    </div>
    <div v-if="page.pageCount > 1" class="resource-gallery__bar resource-gallery__pages">
      <button
        class="button"
        type="button"
        :disabled="page.page <= 1"
        @click="query.page = page.page - 1"
      >
        上一页</button
      ><small>{{ page.page }} / {{ page.pageCount }}</small
      ><button
        class="button"
        type="button"
        :disabled="page.page >= page.pageCount"
        @click="query.page = page.page + 1"
      >
        下一页
      </button>
    </div>
    <ActionSheet
      :open="Boolean(filterOpen)"
      :title="filterTitle"
      :actions="filterActions"
      @update:open="!$event && (filterOpen = '')"
      @select="selectFilter"
    />
    <ActionSheet
      :open="Boolean(menuImage)"
      :title="menuImage?.name || '图片'"
      :actions="[
        { id: 'edit', label: '编辑名称、备注与分类' },
        { id: 'cover', label: '设为封面' },
        { id: 'download', label: '下载图片' },
        { id: 'remove', label: '移除图片', danger: true },
      ]"
      @update:open="!$event && (menuImage = undefined)"
      @select="menuAction"
    />
    <ActionSheet
      v-model:open="moreOpen"
      title="图库"
      :actions="[
        { id: 'select', label: selecting ? '退出多选' : '多选整理' },
        { id: 'categories', label: '管理分类' },
      ]"
      @select="more"
    />
    <ResourceImageViewer
      v-if="viewerId && previewUrl"
      :src="previewUrl"
      :native-source="viewerNativeSource"
      :name="viewerName"
      :position="`${viewerPosition} / ${page.total}`"
      :loading="viewerNavigating"
      :has-previous="viewerPosition > 1"
      :has-next="viewerPosition < page.total"
      @close="closeViewer"
      @previous="nextImage(-1)"
      @next="nextImage(1)"
      @loaded="confirmPreviewLoaded"
    />
  </div>
</template>
