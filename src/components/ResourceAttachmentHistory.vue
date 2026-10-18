<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { resourceAttachmentService as attachments, recycleBinService } from '../core/AppContainer'
import { confirmAction } from '../composables/UseConfirmDialog'
import { taskCenter } from '../core/TaskCenter'
import type { Resource, ResourceSummary } from '../types/Resource'
import { downloadBlob, formatBackupDate, formatBytes } from '../utils/LibraryFormatting'
import FeatureAppHeader from './FeatureAppHeader.vue'
import AttachmentDocumentPreview from './AttachmentDocumentPreview.vue'
import '../styles/ResourceAttachments.css'

const props = defineProps<{ ownerId: string; attachment: ResourceSummary }>()
const emit = defineEmits<{ close: []; changed: [] }>()
const root = ref<HTMLElement>()
const items = ref<ResourceSummary[]>([])
const selected = ref<Resource>()
const page = ref(1)
const pages = computed(() => Math.max(1, Math.ceil(items.value.length / 30)))
const visible = computed(() => items.value.slice((page.value - 1) * 30, page.value * 30))
const busy = ref(false)
const error = ref('')
const status = ref('')
const canStop = ref(false)
let deletion: AbortController | undefined
let disposed = false
let previousFocus: HTMLElement | null = null
function stopPacking() {
  deletion?.abort()
  canStop.value = false
}

async function run(action: () => Promise<void>) {
  if (busy.value || disposed) return
  busy.value = true
  error.value = ''
  try {
    await action()
  } catch (cause) {
    if (!disposed) error.value = cause instanceof Error ? cause.message : '历史版本操作失败'
  } finally {
    busy.value = false
  }
}
async function refresh() {
  const rows = await attachments.history(props.ownerId, props.attachment.id)
  if (disposed) return
  items.value = rows
  page.value = Math.min(page.value, pages.value)
}
async function preview(item: ResourceSummary) {
  await run(async () => {
    const resource = await attachments.getHistory(props.ownerId, props.attachment.id, item.id)
    if (!disposed) {
      selected.value = resource
      status.value = ''
    }
  })
}
async function exportVersion(item: ResourceSummary) {
  await run(async () => {
    const resource =
      selected.value?.id === item.id
        ? selected.value
        : await attachments.getHistory(props.ownerId, props.attachment.id, item.id)
    if (disposed) return
    await downloadBlob(resource.originalBlob, resource.fileName)
    if (!disposed) status.value = '历史版本已导出'
  })
}
async function remove(item: ResourceSummary) {
  if (busy.value || disposed) return
  const confirmed = await confirmAction({
    title: '删除历史版本',
    centered: true,
    danger: true,
    message: `将“${item.fileName}”的此历史版本移入回收站；当前附件不受影响。`,
    confirmLabel: '移入回收站',
  })
  if (!confirmed || disposed) return
  await run(async () => {
    deletion = new AbortController()
    const signal = deletion.signal
    canStop.value = true
    let finished: (() => void) | undefined
    const settled = new Promise<void>((resolve) => {
      finished = resolve
    })
    const operation = taskCenter.start({
      name: '附件历史移入回收站',
      phase: '打包历史版本',
      cancelable: true,
      cancel: () => {
        deletion?.abort()
        return settled
      },
    })
    try {
      await recycleBinService.moveAttachmentVersionToRecycleBin(
        props.ownerId,
        props.attachment.id,
        item.id,
        {
          signal,
          onProgress: (progress) => {
            canStop.value = progress.phase === 'archive' && !signal.aborted
            taskCenter.update(operation, {
              phase: progress.phase === 'archive' ? '打包历史版本' : '保存并移除历史版本',
              cancelable: canStop.value,
            })
            if (progress.writtenBytes !== undefined)
              taskCenter.updateTransfer(operation, { transferredBytes: progress.writtenBytes })
          },
        },
      )
      taskCenter.complete(operation)
    } catch (cause) {
      if (
        signal.aborted &&
        (cause === signal.reason ||
          (typeof cause === 'object' &&
            cause !== null &&
            'name' in cause &&
            cause.name === 'AbortError'))
      ) {
        taskCenter.cancelled(operation)
        if (!disposed) status.value = '已停止，历史版本保留'
        return
      }
      taskCenter.fail(operation, cause)
      throw cause
    } finally {
      canStop.value = false
      deletion = undefined
      finished?.()
    }
    if (disposed) return
    if (selected.value?.id === item.id) selected.value = undefined
    emit('changed')
    await refresh()
    if (!disposed) status.value = '历史版本已移入回收站'
  })
}
function back() {
  if (busy.value) return
  error.value = ''
  status.value = ''
  if (selected.value) selected.value = undefined
  else emit('close')
}
function trapTab(event: KeyboardEvent) {
  const controls = [
    ...(root.value?.querySelectorAll<HTMLElement>(
      'button:not(:disabled),a[href],select:not(:disabled),iframe',
    ) ?? []),
  ].filter((el) => el.getClientRects().length)
  const first = controls[0],
    last = controls.at(-1)
  if (
    document.activeElement === root.value ||
    (event.shiftKey ? document.activeElement === first : document.activeElement === last)
  ) {
    event.preventDefault()
    ;(event.shiftKey ? last : first)?.focus()
  }
}
onMounted(() => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  root.value?.focus({ preventScroll: true })
  void run(refresh)
})
onBeforeUnmount(() => {
  disposed = true
  deletion?.abort()
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
})
defineExpose({ requestBack: back })
</script>

<template>
  <Teleport to="body">
    <section
      ref="root"
      class="resource-attachments"
      role="dialog"
      aria-modal="true"
      aria-label="附件历史版本"
      tabindex="-1"
      data-srl-controls
      @keydown.esc.stop="back"
      @keydown.tab="trapTab"
    >
      <FeatureAppHeader
        :title="selected?.fileName || `历史版本（${items.length}）`"
        layout="panel"
        back-label="返回上一级"
        :back-disabled="busy"
        @back="back"
      >
        <template v-if="selected" #actions>
          <button type="button" :disabled="busy" @click="exportVersion(selected)">导出</button>
          <button type="button" :disabled="busy" @click="remove(selected)">删除</button>
        </template>
      </FeatureAppHeader>
      <p v-if="error" class="resource-attachments__message" role="alert">{{ error }}</p>
      <p v-if="busy" class="resource-attachments__message" role="status">正在处理…</p>
      <button v-if="canStop" type="button" @click="stopPacking">停止打包</button>
      <p v-else-if="status" class="resource-attachments__message" role="status">{{ status }}</p>
      <p class="resource-attachments__message">
        {{ selected ? '历史版本 · 只读' : attachment.fileName }}
      </p>
      <AttachmentDocumentPreview v-if="selected" :key="selected.id" :resource="selected" />
      <div v-else class="resource-attachments__body">
        <p v-if="!items.length && !busy" class="resource-attachments__empty">
          暂无历史版本。修改正文或替换文件后，旧文件会保存在这里。
        </p>
        <ul class="resource-attachments__list">
          <li v-for="item in visible" :key="item.id">
            <button
              type="button"
              class="resource-attachments__file"
              :disabled="busy"
              :aria-label="`预览历史版本 ${item.fileName}`"
              @click="preview(item)"
            >
              <span
                ><strong>{{ item.fileName }}</strong
                ><small
                  >{{ formatBackupDate(item.versionImportedAt ?? item.updatedAt) }} ·
                  {{
                    item.fileSize < 1024 ? `${item.fileSize} B` : formatBytes(item.fileSize)
                  }}</small
                ></span
              >
            </button>
            <button
              type="button"
              class="resource-attachments__more"
              :disabled="busy"
              :aria-label="`导出历史版本 ${item.fileName}`"
              @click="exportVersion(item)"
            >
              导出
            </button>
            <button
              type="button"
              class="resource-attachments__more"
              :disabled="busy"
              :aria-label="`删除历史版本 ${item.fileName}`"
              @click="remove(item)"
            >
              删除
            </button>
          </li>
        </ul>
      </div>
      <nav
        v-if="!selected && pages > 1"
        class="attachment-preview__toolbar"
        aria-label="历史版本翻页"
      >
        <button type="button" :disabled="busy || page === 1" @click="page--">上一页</button>
        <span>{{ page }} / {{ pages }}</span>
        <button type="button" :disabled="busy || page === pages" @click="page++">下一页</button>
      </nav>
    </section>
  </Teleport>
</template>
