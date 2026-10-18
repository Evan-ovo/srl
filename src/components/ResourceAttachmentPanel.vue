<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { resourceAttachmentService as attachments, recycleBinService } from '../core/AppContainer'
import { taskCenter } from '../core/TaskCenter'
import { dirtyStateRegistry } from '../core/DirtyStateRegistry'
import { chooseAction, confirmAction } from '../composables/UseConfirmDialog'
import type { Resource, ResourceSummary } from '../types/Resource'
import {
  attachmentFormat,
  attachmentTextFile,
  readAttachmentText,
} from '../services/AttachmentDocument'
import { openAttachmentWord, type WordTextEditor } from '../services/AttachmentWordEditing'
import { formatBytes, downloadBlob } from '../utils/LibraryFormatting'
import FeatureAppHeader from './FeatureAppHeader.vue'
import ActionSheet, { type ActionSheetAction } from './ActionSheet.vue'
import AttachmentDocumentPreview from './AttachmentDocumentPreview.vue'
import ResourceAttachmentHistory from './ResourceAttachmentHistory.vue'
import '../styles/ResourceAttachments.css'

const props = defineProps<{ resource: Resource; initialItems: ResourceSummary[] }>()
const emit = defineEmits<{ close: []; changed: [items: ResourceSummary[], ids: string[]] }>()
const root = ref<HTMLElement>()
let previousFocus: HTMLElement | null = null
const items = ref(props.initialItems)
const current = ref<Resource>()
const query = ref('')
const page = ref(1)
const mode = ref<'list' | 'view' | 'text' | 'rename'>('list')
const wordEditor = shallowRef<WordTextEditor>()
const wordValues = ref<string[]>([])
const text = ref('')
const originalText = ref('')
const name = ref('')
const busy = ref(false)
const error = ref('')
const status = ref('')
const menu = ref<ResourceSummary>()
const menuOpen = ref(false)
const historyTarget = ref<ResourceSummary>()
const historyPanel = ref<InstanceType<typeof ResourceAttachmentHistory>>()
const picker = ref<HTMLInputElement>()
const replacePicker = ref<HTMLInputElement>()
const replacing = ref<ResourceSummary>()
const importing = ref(false)
const paused = ref(false)
let disposed = false
let controller: AbortController | undefined
let operation = ''
let continueImport: (() => void) | undefined
let requestFinished: (() => void) | undefined
let revision = 0
const filtered = computed(() =>
  items.value.filter((item) =>
    item.fileName.toLocaleLowerCase().includes(query.value.toLocaleLowerCase()),
  ),
)
const pageItems = computed(() => filtered.value.slice((page.value - 1) * 30, page.value * 30))
const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / 30)))
const dirty = computed(
  () =>
    (mode.value === 'text' &&
      (wordEditor.value
        ? wordValues.value.some(
            (value, index) => value !== wordEditor.value!.fields[index]!.original,
          )
        : text.value !== originalText.value)) ||
    (mode.value === 'rename' && name.value !== current.value?.fileName),
)
watch(query, () => {
  page.value = 1
})
watch(dirty, () => dirtyStateRegistry.changed())
const unregister = dirtyStateRegistry.register({
  featureId: `resource-attachments:${props.resource.id}`,
  label: '附件编辑',
  isDirty: () => dirty.value,
  save: async () => {
    if (!(await save())) throw new Error(error.value || '附件未保存')
  },
  discard: () => {
    text.value = originalText.value
    wordEditor.value = undefined
    wordValues.value = []
    name.value = current.value?.fileName ?? ''
  },
})
const actions = computed<ActionSheetAction[]>(() => [
  { id: 'open', label: '查看' },
  ...(['word', 'txt'].includes(attachmentFormat(menu.value?.fileName ?? ''))
    ? [{ id: 'edit', label: '编辑文本' }]
    : []),
  { id: 'rename', label: '重命名' },
  { id: 'replace', label: '替换文件' },
  { id: 'export', label: '导出' },
  { id: 'history', label: '历史版本' },
  { id: 'delete', label: '删除', danger: true },
])
function trapTab(event: KeyboardEvent) {
  const controls = [
    ...(root.value?.querySelectorAll<HTMLElement>(
      'button:not(:disabled),input:not([hidden]):not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],iframe',
    ) ?? []),
  ].filter((element) => element.getClientRects().length)
  const first = controls[0],
    last = controls.at(-1)
  if (!controls.length) {
    event.preventDefault()
    return
  }
  if (
    event.shiftKey &&
    (document.activeElement === first || document.activeElement === root.value)
  ) {
    event.preventDefault()
    last?.focus()
  } else if (
    !event.shiftKey &&
    (document.activeElement === last || document.activeElement === root.value)
  ) {
    event.preventDefault()
    first?.focus()
  }
}
onMounted(() => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  root.value?.focus({ preventScroll: true })
})
function showMenu(item?: ResourceSummary) {
  menu.value = item
  menuOpen.value = true
}
async function closeHistory() {
  historyTarget.value = undefined
  await nextTick()
  root.value?.focus({ preventScroll: true })
}
function message(cause: unknown) {
  return cause instanceof Error ? cause.message : '操作失败，请重试'
}
async function refresh(ids: string[]) {
  const rows = await attachments.list(props.resource.id)
  if (disposed) return
  items.value = rows
  page.value = Math.min(page.value, pages.value)
  emit('changed', rows, ids)
}
async function run(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await action()
    return true
  } catch (cause) {
    if (!disposed) error.value = message(cause)
    return false
  } finally {
    if (!disposed) busy.value = false
  }
}
async function open(item: ResourceSummary, action: 'open' | 'edit' | 'rename' = 'open') {
  const token = ++revision
  await run(async () => {
    const file = await attachments.get(props.resource.id, item.id)
    if (disposed || token !== revision) return
    current.value = file
    name.value = file.fileName
    if (action === 'edit') await startEdit()
    else mode.value = action === 'rename' ? 'rename' : 'view'
  })
}
async function startEdit() {
  const file = current.value
  if (!file) return
  if (!['word', 'txt'].includes(attachmentFormat(file.fileName)))
    throw new Error('此格式仅支持阅读，不能编辑正文')
  const token = revision
  const input = new File([file.originalBlob], file.fileName, { type: file.mimeType })
  if (attachmentFormat(file.fileName) === 'word') {
    const editor = await openAttachmentWord(input)
    if (disposed || token !== revision) return
    wordEditor.value = editor
    wordValues.value = editor.fields.map((field) => field.text)
  } else {
    const value = await readAttachmentText(input)
    if (disposed || token !== revision) return
    wordEditor.value = undefined
    text.value = originalText.value = value
  }
  mode.value = 'text'
}
function updateWord(index: number, event: Event) {
  const input = event.target as HTMLTextAreaElement
  try {
    wordEditor.value?.setText(index, input.value)
    wordValues.value[index] = input.value
    error.value = ''
  } catch (cause) {
    input.value = wordValues.value[index] ?? ''
    error.value = message(cause)
  }
}
async function editCurrent() {
  await run(startEdit)
}
async function save(): Promise<boolean> {
  if (!current.value) return false
  return Boolean(
    await run(async () => {
      const file = current.value!
      if (mode.value === 'rename') await attachments.rename(props.resource.id, file.id, name.value)
      else
        current.value = await attachments.replace(
          props.resource.id,
          file.id,
          wordEditor.value
            ? await wordEditor.value.file()
            : attachmentTextFile(file.fileName, text.value),
          file.contentHash,
        )
      originalText.value = text.value
      mode.value = 'view'
      wordEditor.value = undefined
      wordValues.value = []
      current.value = await attachments.get(props.resource.id, file.id)
      name.value = current.value.fileName
      await refresh([file.id])
      status.value = '附件已保存'
    }),
  )
}
async function requestBack() {
  if (busy.value) return
  if (historyTarget.value) {
    historyPanel.value?.requestBack()
    return
  }
  if (menuOpen.value) {
    menuOpen.value = false
    return
  }
  const leavingMode = mode.value
  if (dirty.value) {
    const answer = await chooseAction({
      title: '附件有未保存修改',
      centered: true,
      message: '离开前可以保存或放弃修改。',
      confirmLabel: '保存',
      alternativeLabel: '放弃修改',
      cancelLabel: '继续编辑',
    })
    if (disposed || answer === 'cancel') return
    if (answer === 'confirm' && !(await save())) return
    text.value = originalText.value
    wordEditor.value = undefined
    wordValues.value = []
    name.value = current.value?.fileName ?? ''
  }
  revision++
  error.value = ''
  if (leavingMode === 'text' || leavingMode === 'rename') mode.value = 'view'
  else if (leavingMode === 'view') {
    mode.value = 'list'
    current.value = undefined
  } else emit('close')
}
function pauseImport() {
  paused.value = true
  taskCenter.update(operation, { phase: '正在暂停，等待当前文件完成' })
}
function resumeImport() {
  if (!paused.value || controller?.signal.aborted) return
  paused.value = false
  continueImport?.()
  continueImport = undefined
}
function stopImport() {
  controller?.abort()
  continueImport?.()
  taskCenter.update(operation, { phase: '正在停止，保留已导入附件', cancelable: false })
}
async function importFiles(event: Event) {
  const input = event.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  if (!files.length || busy.value) return
  const ids: string[] = []
  controller = new AbortController()
  const signal = controller.signal
  const stopped = new Promise<void>((resolve) => {
    requestFinished = resolve
  })
  importing.value = true
  paused.value = false
  operation = taskCenter.start({
    name: '导入资源附件',
    cancelable: true,
    cancel: () => {
      stopImport()
      return stopped
    },
    action: { label: '继续导入', required: false, run: resumeImport },
  })
  await run(async () => {
    try {
      for (const [index, file] of files.entries()) {
        if (paused.value && !signal.aborted) {
          taskCenter.update(operation, { phase: `已暂停 · ${ids.length}/${files.length}` })
          await new Promise<void>((resolve) => {
            continueImport = resolve
          })
        }
        signal.throwIfAborted()
        taskCenter.update(operation, {
          phase: file.name,
          itemProgress: { completed: index, total: files.length },
        })
        const resource = await attachments.add(props.resource.id, file, signal)
        ids.push(resource.id)
      }
      taskCenter.complete(operation)
      status.value = `已导入 ${ids.length} 个附件`
    } catch (cause) {
      if (signal.aborted) {
        taskCenter.cancelled(operation)
        status.value = `已停止，保留 ${ids.length} 个附件`
      } else {
        taskCenter.fail(operation, cause)
        throw cause
      }
    } finally {
      importing.value = false
      paused.value = false
      requestFinished?.()
      requestFinished = undefined
      if (ids.length) await refresh(ids)
    }
  })
}
async function replaceFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  const previous = replacing.value
  replacing.value = undefined
  if (!file || !previous || disposed) return
  await run(async () => {
    current.value = await attachments.replace(
      props.resource.id,
      previous.id,
      file,
      previous.contentHash,
    )
    await refresh([previous.id])
    status.value = '附件已替换'
  })
}
async function exportFile(item: ResourceSummary) {
  await run(async () => {
    const file = await attachments.get(props.resource.id, item.id)
    await downloadBlob(file.originalBlob, file.fileName)
    status.value = '附件已导出'
  })
}
async function selectAction(action: ActionSheetAction) {
  const item = menu.value
  if (!item) return
  menuOpen.value = false
  if (action.id === 'replace') {
    if (busy.value || disposed) return
    replacing.value = item
    error.value = ''
    // Keep the file picker in the menu's user gesture; read and validate after selection.
    replacePicker.value?.click()
    return
  }
  if (['open', 'edit', 'rename'].includes(action.id))
    return open(item, action.id as 'open' | 'edit' | 'rename')
  if (action.id === 'export') return exportFile(item)
  if (action.id === 'history') {
    historyTarget.value = item
    return
  }
  if (
    action.id === 'delete' &&
    (await confirmAction({
      title: '删除附件',
      centered: true,
      message: `将“${item.fileName}”移入回收站，之后可以恢复。`,
      confirmLabel: '移入回收站',
      danger: true,
    }))
  ) {
    if (disposed) return
    await run(async () => {
      await attachments.get(props.resource.id, item.id)
      await recycleBinService.moveToRecycleBin([item.id])
      if (current.value?.id === item.id) {
        current.value = undefined
        mode.value = 'list'
      }
      await refresh([item.id])
      status.value = '附件已移入回收站'
    })
  }
}
onBeforeUnmount(() => {
  disposed = true
  revision++
  stopImport()
  unregister()
  void nextTick(() => {
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
  })
})
defineExpose({ requestBack })
</script>

<template>
  <Teleport to="body">
    <section
      v-show="!historyTarget"
      ref="root"
      tabindex="-1"
      class="resource-attachments"
      role="dialog"
      aria-modal="true"
      aria-label="资源附件"
      data-srl-controls
      @keydown.esc.stop="requestBack"
      @keydown.tab="trapTab"
    >
      <FeatureAppHeader
        :title="mode === 'list' ? `附件（${items.length}）` : current?.fileName || '附件'"
        layout="panel"
        back-label="返回上一级"
        :back-disabled="busy"
        @back="requestBack"
      >
        <template #actions>
          <button
            v-if="mode === 'list'"
            type="button"
            class="feature-header-action feature-header-action--icon"
            aria-label="导入附件"
            title="导入附件"
            :disabled="busy"
            @click="picker?.click()"
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M12 5v14M5 12h14"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              />
            </svg>
          </button>
          <button
            v-else-if="mode === 'text' || mode === 'rename'"
            type="button"
            class="is-primary"
            :disabled="busy || !dirty"
            @click="save"
          >
            保存
          </button>
          <template v-else>
            <button
              v-if="current && ['txt', 'word'].includes(attachmentFormat(current.fileName))"
              type="button"
              :disabled="busy"
              @click="editCurrent"
            >
              编辑文本
            </button>
            <button type="button" :disabled="busy" aria-label="附件操作" @click="showMenu(current)">
              更多
            </button>
          </template>
        </template>
      </FeatureAppHeader>
      <input
        ref="picker"
        type="file"
        multiple
        hidden
        aria-label="导入附件文件"
        @change="importFiles"
      />
      <input
        ref="replacePicker"
        type="file"
        hidden
        aria-label="替换附件文件"
        @cancel="replacing = undefined"
        @change="replaceFile"
      />
      <p v-if="error" class="resource-attachments__message" role="alert">{{ error }}</p>
      <p v-if="status" class="resource-attachments__message" role="status">{{ status }}</p>
      <div v-if="importing" class="resource-attachments__progress">
        <span>{{ paused ? '正在暂停 / 已暂停' : '正在导入附件' }}</span>
        <button type="button" @click="paused ? resumeImport() : pauseImport()">
          {{ paused ? '继续' : '暂停' }}
        </button>
        <button type="button" @click="stopImport">停止</button>
      </div>
      <template v-if="mode === 'list'">
        <div class="resource-attachments__search">
          <input v-model="query" type="search" aria-label="搜索附件" placeholder="搜索附件名称" />
        </div>
        <div class="resource-attachments__body">
          <p v-if="!items.length" class="resource-attachments__empty">
            还没有附件，点击右上角 + 导入文件。
          </p>
          <p v-else-if="!filtered.length">没有匹配的附件。</p>
          <ul class="resource-attachments__list">
            <li v-for="item in pageItems" :key="item.id">
              <button
                type="button"
                class="resource-attachments__file"
                :disabled="busy"
                @click="open(item)"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h6" />
                </svg>
                <span
                  ><strong>{{ item.fileName }}</strong
                  ><small
                    >{{ item.fileName.split('.').at(-1)?.toUpperCase() }} ·
                    {{ formatBytes(item.fileSize) }}</small
                  ></span
                >
              </button>
              <button
                type="button"
                class="resource-attachments__more"
                :aria-label="`${item.fileName} 的操作`"
                :disabled="busy"
                @click="showMenu(item)"
              >
                ⋯
              </button>
            </li>
          </ul>
        </div>
        <nav v-if="pages > 1" class="attachment-preview__toolbar" aria-label="附件翻页">
          <button type="button" :disabled="page === 1" @click="page--">上一页</button
          ><span>{{ page }} / {{ pages }}</span
          ><button type="button" :disabled="page === pages" @click="page++">下一页</button>
        </nav>
      </template>
      <div
        v-else-if="mode === 'text'"
        class="resource-attachments__body resource-attachments__editor"
      >
        <div v-if="wordEditor" class="resource-attachments__word-editor">
          <p>仅修改段内文字，保留字体、图片、表格和原有段落结构。</p>
          <label v-for="(field, index) in wordEditor.fields" :key="index">
            <span>第 {{ field.paragraph }} 段</span>
            <textarea
              :value="wordValues[index]"
              :aria-label="`Word 正文第 ${index + 1} 段`"
              :disabled="busy"
              rows="3"
              @input="updateWord(index, $event)"
            ></textarea>
          </label>
        </div>
        <textarea
          v-else
          v-model="text"
          aria-label="附件文本内容"
          :disabled="busy"
          spellcheck="false"
        ></textarea>
      </div>
      <form v-else-if="mode === 'rename'" class="resource-attachments__body" @submit.prevent="save">
        <label class="field"
          ><span>文件名</span><input v-model="name" aria-label="附件文件名" :disabled="busy"
        /></label>
      </form>
      <AttachmentDocumentPreview
        v-else-if="current"
        :key="`${current.id}:${current.contentHash}:${current.fileName}`"
        :resource="current"
      />
      <ActionSheet
        v-model:open="menuOpen"
        :title="menu?.fileName || '附件操作'"
        :actions="actions"
        centered
        @select="selectAction"
      />
    </section>
    <ResourceAttachmentHistory
      v-if="historyTarget"
      :key="`${resource.id}:${historyTarget.id}`"
      ref="historyPanel"
      :owner-id="resource.id"
      :attachment="historyTarget"
      @close="closeHistory"
      @changed="refresh([historyTarget!.id])"
    />
  </Teleport>
</template>
