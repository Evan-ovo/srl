<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import ActionSheet, { type ActionSheetAction } from './ActionSheet.vue'
import { discordSetupService } from '../core/AppContainer'
import { discordSetupSession } from '../services/AssistantBrowserRuntime'
import {
  setupStep,
  setupContinueLabel,
  type DiscordSetupState,
  type DiscordSetupTask,
} from '../services/DiscordSetupWorkflow'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()
const stage = ref<'resume' | 'experience' | 'update' | 'mode'>('experience')
const task = ref<DiscordSetupTask>('configure')
const previous = ref<DiscordSetupState>()
const restarting = ref(false)
let revision = 0
let keepNextClose = false
const readFailed = ref(false)
const busy = ref(false)
const committing = ref(false)
const error = ref('')
const experience: readonly ActionSheetAction[] = [
  { id: 'update', label: '之前配置过 Discord Bridge，这次只是更新' },
  { id: 'configure', label: '之前从未配过 Discord Bridge' },
  { id: 'diagnose', label: '已经配置过，但有问题，帮我排查' },
]
const updates: readonly ActionSheetAction[] = [
  { id: 'update-worker', label: '仅更新 Worker' },
  { id: 'update-commands-only', label: '仅更新指令（Worker 已经更新过）' },
  { id: 'update-commands', label: '更新指令（Worker 也还未更新）' },
]
const resumeActions: readonly ActionSheetAction[] = [
  { id: 'resume', label: '继续上次配置' },
  { id: 'restart', label: '重新开始' },
]
const modes: readonly ActionSheetAction[] = [
  {
    id: 'economy',
    label: '省 Token 模式',
    description: '本机固定步骤、模板与格式检查，不调用 AI 操作网页；三个值由你填写。',
  },
  {
    id: 'agent',
    label: '代理模式',
    description:
      '查看权限并确认后开启：AI 自主填写普通表单、创建配置、提交部署；四项参数本机回填，秘密由你手填。',
  },
]
const actions = computed(() =>
  (stage.value === 'mode'
    ? modes.filter((action) => task.value !== 'diagnose' || action.id === 'agent')
    : stage.value === 'resume'
      ? [
          ...resumeActions.map((action) =>
            action.id === 'resume' && previous.value
              ? { ...action, label: setupContinueLabel(previous.value.step) }
              : action,
          ),
          ...(previous.value?.mode === 'agent' && discordSetupSession.agentRunning
            ? [{ id: 'pause', label: '暂停网页协助' }]
            : []),
        ]
      : stage.value === 'experience'
        ? experience
        : updates
  ).map((action) => ({
    ...action,
    ...(stage.value === 'mode' && task.value === 'diagnose'
      ? {
          description:
            '确认权限后检查当前配置；按实际问题沿同一对话修复，登录和授权由你完成，秘密不发送给模型。',
        }
      : {}),
    disabled: busy.value || readFailed.value,
  })),
)
watch(
  () => props.open,
  async (open) => {
    const currentRevision = ++revision
    if (open) {
      stage.value = 'experience'
      error.value = ''
      readFailed.value = false
      previous.value = undefined
      restarting.value = false
      keepNextClose = false
      busy.value = true
      try {
        const saved = await discordSetupService.current()
        if (revision !== currentRevision) return
        if (saved && saved.step !== 'done') {
          previous.value = saved
          stage.value = 'resume'
        }
      } catch {
        if (revision === currentRevision) {
          readFailed.value = true
          error.value = '上次配置读取失败，请关闭后重试'
        }
      } finally {
        if (revision === currentRevision) busy.value = false
      }
    }
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  revision++
})
function setOpen(open: boolean) {
  if (!open && keepNextClose) {
    keepNextClose = false
    return
  }
  if (!committing.value) emit('update:open', open)
}
async function choose(action: ActionSheetAction) {
  if (busy.value) return
  if (action.id === 'restart') {
    keepNextClose = true
    restarting.value = true
    stage.value = 'experience'
    return
  }
  if (action.id === 'update') {
    keepNextClose = true
    stage.value = 'update'
    return
  }
  if (
    action.id !== 'resume' &&
    action.id !== 'pause' &&
    action.id !== 'economy' &&
    action.id !== 'agent'
  ) {
    keepNextClose = true
    task.value = action.id as DiscordSetupTask
    stage.value = 'mode'
    return
  }
  busy.value = true
  committing.value = true
  error.value = ''
  try {
    const result =
      action.id === 'pause'
        ? await discordSetupService.pauseAgent()
        : action.id === 'resume'
          ? await discordSetupService.resume()
          : restarting.value
            ? await discordSetupService.restart(task.value, action.id as 'economy' | 'agent')
            : await discordSetupService.start(
                task.value,
                undefined,
                action.id as 'economy' | 'agent',
              )
    if (result && 'cancelled' in result && result.cancelled) return
    emit('update:open', false)
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : '网页协助未开始，请检查当前步骤'
  } finally {
    busy.value = false
    committing.value = false
  }
}
</script>
<template>
  <ActionSheet
    :open="open"
    above-tutorial
    centered
    :title="
      stage === 'mode'
        ? task === 'diagnose'
          ? '开启配置排查'
          : '选择部署协助模式'
        : stage === 'resume'
          ? previous?.step === 'diagnose'
            ? '继续上次排查？'
            : '继续上次配置？'
          : stage === 'experience'
            ? '这次需要怎样的帮助？'
            : '这次更新什么？'
    "
    :description="
      error ||
      (busy
        ? '正在读取配置步骤…'
        : stage === 'resume' && previous
          ? `上次停在：${setupStep(previous.step).title}。${previous.step === 'diagnose' ? '先在同一对话检查本机连接；需要网页修复时再打开对应网页。' : ''}重新开始只重置协助进度，已有数据库、部署与本机参数会保留。`
          : undefined)
    "
    :actions="actions"
    @update:open="setOpen"
    @select="choose"
  />
</template>
