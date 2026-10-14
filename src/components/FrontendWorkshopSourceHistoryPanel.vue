<script setup lang="ts">
import { ref, shallowRef, watch } from 'vue'

import {
  frontendWorkshopSourceCheckpointService,
  frontendWorkshopSourceDocumentService,
  frontendWorkshopSourceHistoryService,
} from '../core/FrontendWorkshopContainer'
import {
  FrontendWorkshopSourceCheckpointStaleError,
  type FrontendWorkshopSourceCheckpoint,
} from '../services/FrontendWorkshopSourceCheckpointService'
import { FrontendWorkshopSourceRevisionConflictError } from '../services/FrontendWorkshopSourceDocumentService'
import { FrontendWorkshopSourceHistoryStaleError } from '../services/FrontendWorkshopSourceHistoryService'
import type { FrontendWorkshopSourceDocument } from '../types/FrontendWorkshopSourceDocument'

const props = defineProps<{
  sourceDocument: FrontendWorkshopSourceDocument
  externalBusy?: boolean
}>()

const emit = defineEmits<{
  busyChange: [busy: boolean]
  revisionAccepted: [source?: FrontendWorkshopSourceDocument, message?: string]
}>()

type SourceHistoryDirection = 'undo' | 'redo'

const checkpoints = shallowRef<readonly FrontendWorkshopSourceCheckpoint[]>([])
const selectedCheckpointId = ref('')
const historyStatus = shallowRef(frontendWorkshopSourceHistoryService.status(''))
const busy = ref(false)
const error = ref('')
const status = ref('')

watch(
  () =>
    [
      props.sourceDocument.projectId,
      props.sourceDocument.revision,
      props.sourceDocument.createdAt,
    ] as const,
  () => refreshOwnerState(),
  { immediate: true },
)

function refreshOwnerState(): void {
  const source = props.sourceDocument
  const currentStatus = frontendWorkshopSourceHistoryService.status(source.projectId)
  if (
    currentStatus.expectedRevision !== undefined &&
    currentStatus.expectedRevision !== source.revision
  ) {
    frontendWorkshopSourceHistoryService.clearProject(source.projectId)
  }
  historyStatus.value = frontendWorkshopSourceHistoryService.status(source.projectId)
  frontendWorkshopSourceCheckpointService.reconcileProject(source.projectId, source.createdAt)
  checkpoints.value = frontendWorkshopSourceCheckpointService.list(source.projectId)
  if (!checkpoints.value.some((checkpoint) => checkpoint.id === selectedCheckpointId.value))
    selectedCheckpointId.value = checkpoints.value.at(-1)?.id ?? ''
}

function setBusy(value: boolean): void {
  busy.value = value
  emit('busyChange', value)
}

async function recoverConflict(message: string): Promise<void> {
  const projectId = props.sourceDocument.projectId
  frontendWorkshopSourceHistoryService.clearProject(projectId)
  const latest = await frontendWorkshopSourceDocumentService.get(projectId)
  if (props.sourceDocument.projectId !== projectId) return
  historyStatus.value = frontendWorkshopSourceHistoryService.status(projectId)
  if (latest) {
    frontendWorkshopSourceCheckpointService.reconcileProject(projectId, latest.createdAt)
    checkpoints.value = frontendWorkshopSourceCheckpointService.list(projectId)
  } else {
    frontendWorkshopSourceCheckpointService.clearProject(projectId)
    checkpoints.value = []
    selectedCheckpointId.value = ''
  }
  status.value = latest ? message : 'Source 已不存在，编辑历史已清空'
  emit('revisionAccepted', latest, status.value)
}

async function runHistoryAction(direction: SourceHistoryDirection): Promise<void> {
  if (busy.value || props.externalBusy) return
  const source = props.sourceDocument
  const currentStatus = frontendWorkshopSourceHistoryService.status(source.projectId)
  historyStatus.value = currentStatus
  if (
    (direction === 'undo' && !currentStatus.canUndo) ||
    (direction === 'redo' && !currentStatus.canRedo)
  )
    return
  setBusy(true)
  error.value = ''
  status.value = direction === 'undo' ? '撤销中' : '重做中'
  try {
    const next =
      direction === 'undo'
        ? await frontendWorkshopSourceHistoryService.undo(source.projectId)
        : await frontendWorkshopSourceHistoryService.redo(source.projectId)
    if (!next || props.sourceDocument.projectId !== source.projectId) return
    historyStatus.value = frontendWorkshopSourceHistoryService.status(source.projectId)
    status.value =
      direction === 'undo' ? '已撤销；预览已按新 revision 重建' : '已重做；预览已按新 revision 重建'
    emit('revisionAccepted', next, status.value)
  } catch (cause) {
    if (
      cause instanceof FrontendWorkshopSourceRevisionConflictError ||
      cause instanceof FrontendWorkshopSourceHistoryStaleError
    )
      await recoverConflict('Source 已被更新，编辑历史已清空，请重新操作')
    else error.value = cause instanceof Error ? cause.message : 'Source 历史操作失败'
  } finally {
    setBusy(false)
  }
}

async function createCheckpoint(): Promise<void> {
  if (busy.value || props.externalBusy) return
  const source = props.sourceDocument
  setBusy(true)
  error.value = ''
  status.value = '保存检查点中'
  try {
    const checkpoint = await frontendWorkshopSourceCheckpointService.create(source.projectId, {
      expectedRevision: source.revision,
      expectedSourceCreatedAt: source.createdAt,
    })
    refreshOwnerState()
    selectedCheckpointId.value = checkpoint.id
    status.value = `已保存检查点：${checkpoint.label}`
  } catch (cause) {
    if (
      cause instanceof FrontendWorkshopSourceRevisionConflictError ||
      cause instanceof FrontendWorkshopSourceCheckpointStaleError
    )
      await recoverConflict('Source 已被更新，请确认最新内容后再保存检查点')
    else error.value = cause instanceof Error ? cause.message : 'Source 检查点创建失败'
  } finally {
    setBusy(false)
  }
}

async function restoreCheckpoint(): Promise<void> {
  if (busy.value || props.externalBusy || !selectedCheckpointId.value) return
  const source = props.sourceDocument
  setBusy(true)
  error.value = ''
  status.value = '恢复检查点中'
  try {
    const restored = await frontendWorkshopSourceCheckpointService.restore(
      source.projectId,
      selectedCheckpointId.value,
      { expectedRevision: source.revision, expectedSourceCreatedAt: source.createdAt },
    )
    if (!restored.changed) {
      refreshOwnerState()
      status.value = `当前已是检查点：${restored.checkpoint.label}`
      return
    }
    selectedCheckpointId.value = restored.checkpoint.id
    status.value = `已恢复检查点：${restored.checkpoint.label}；可撤销，预览已按新 revision 重建`
    emit('revisionAccepted', restored.document, status.value)
  } catch (cause) {
    if (
      cause instanceof FrontendWorkshopSourceRevisionConflictError ||
      cause instanceof FrontendWorkshopSourceHistoryStaleError ||
      cause instanceof FrontendWorkshopSourceCheckpointStaleError
    )
      await recoverConflict('Source 已被更新，请确认最新内容后再恢复检查点')
    else error.value = cause instanceof Error ? cause.message : 'Source 检查点恢复失败'
  } finally {
    setBusy(false)
  }
}
</script>

<template>
  <div class="frontend-workshop-source-history-panel" data-srl-controls>
    <div class="frontend-workshop-source-history-panel__checkpoints" aria-label="Source 检查点">
      <button type="button" :disabled="busy || externalBusy" @click="createCheckpoint">
        保存点
      </button>
      <select
        v-model="selectedCheckpointId"
        aria-label="Source 检查点"
        :disabled="busy || externalBusy || checkpoints.length === 0"
      >
        <option value="">无检查点</option>
        <option v-for="checkpoint in checkpoints" :key="checkpoint.id" :value="checkpoint.id">
          {{ checkpoint.label }} · r{{ checkpoint.sourceRevision }}
        </option>
      </select>
      <button
        type="button"
        :disabled="busy || externalBusy || !selectedCheckpointId"
        @click="restoreCheckpoint"
      >
        恢复
      </button>
    </div>
    <div class="frontend-workshop-source-history-panel__actions" aria-label="Source 编辑历史">
      <button
        type="button"
        :disabled="busy || externalBusy || !historyStatus.canUndo"
        @click="runHistoryAction('undo')"
      >
        撤销
      </button>
      <button
        type="button"
        :disabled="busy || externalBusy || !historyStatus.canRedo"
        @click="runHistoryAction('redo')"
      >
        重做
      </button>
    </div>
    <small v-if="error" class="frontend-workshop-source-history-panel__error" role="alert">
      {{ error }}
    </small>
    <small v-else-if="status" class="frontend-workshop-source-history-panel__status" role="status">
      {{ status }}
    </small>
  </div>
</template>

<style scoped src="../styles/FrontendWorkshopSourceHistoryPanel.css"></style>
