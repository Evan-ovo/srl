<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

import { isCompletedNotice, noticeCenter, type NoticeRecord } from '../core/NoticeCenter'
import { isAutoClearingTask, taskCenter, type TaskRecord } from '../core/TaskCenter'

const props = withDefaults(
  defineProps<{
    suppressFocused?: boolean
    inlineTaskNames?: string[]
    hiddenTaskNames?: string[]
    hiddenNoticeIds?: string[]
  }>(),
  {
    suppressFocused: false,
    inlineTaskNames: () => [],
    hiddenTaskNames: () => [],
    hiddenNoticeIds: () => [],
  },
)

const tasks = ref<TaskRecord[]>([])
const noticeRecords = ref<NoticeRecord[]>([])
const notices = computed(() =>
  noticeRecords.value.filter((notice) => !props.hiddenNoticeIds.includes(notice.id)),
)
const open = ref(false)
const selectedView = ref<'tasks' | 'notices'>('tasks')
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | undefined
let unsubscribeTasks: (() => void) | undefined
let unsubscribeNotices: (() => void) | undefined

const inline = computed(() => props.inlineTaskNames.length > 0)
const displayedTasks = computed(() =>
  tasks.value.filter((task) => !props.hiddenTaskNames.includes(task.name)),
)
const activeTasks = computed(() =>
  displayedTasks.value.filter(
    (task) =>
      task.status === 'running' && (!inline.value || props.inlineTaskNames.includes(task.name)),
  ),
)
const centeredImportTask = computed(() =>
  activeTasks.value.find(
    (task) =>
      task.name.startsWith('导入') ||
      task.name.startsWith('识别分享') ||
      task.name === '恢复备份' ||
      task.name === '备份预检' ||
      task.name === '导出备份' ||
      task.name === '移入回收站' ||
      task.name === '彻底删除回收站资源' ||
      task.name === '清空回收站' ||
      task.name === '恢复历史版本',
  ),
)
const visibleTasks = computed(() =>
  displayedTasks.value
    .filter(
      (task) =>
        !isCompletedTask(task) &&
        (task.status === 'running' || task.status === 'failed' || task.actionLabel),
    )
    .slice(0, 8),
)
function isCompletedTask(task: TaskRecord): boolean {
  return task.status === 'completed' && task.phase !== '下载完成，可继续导入'
}
const recentCompletedTasks = computed(() => displayedTasks.value.filter(isAutoClearingTask))
const completedTasks = computed(() =>
  displayedTasks.value.filter((task) => isCompletedTask(task) && !isAutoClearingTask(task)),
)
const pendingNotices = computed(() => notices.value.filter((notice) => !isCompletedNotice(notice)))
const completedNotices = computed(() => notices.value.filter(isCompletedNotice))
const activityGroups = computed(() => {
  const groups =
    selectedView.value === 'tasks'
      ? [
          {
            title: '任务',
            completed: false,
            tasks: visibleTasks.value,
            notices: [] as NoticeRecord[],
          },
          {
            title: '刚刚结束',
            completed: false,
            tasks: recentCompletedTasks.value,
            notices: [] as NoticeRecord[],
          },
          {
            title: '需要后续操作',
            completed: true,
            tasks: completedTasks.value,
            notices: [] as NoticeRecord[],
          },
        ]
      : [
          {
            title: '通知',
            completed: false,
            tasks: [] as TaskRecord[],
            notices: pendingNotices.value.slice(0, 8),
          },
          {
            title: '已完成通知',
            completed: true,
            tasks: [] as TaskRecord[],
            notices: completedNotices.value,
          },
        ]
  return groups.filter((group) => group.tasks.length || group.notices.length)
})
const visible = computed(() =>
  inline.value
    ? activeTasks.value.length > 0
    : visibleTasks.value.length > 0 ||
      recentCompletedTasks.value.length > 0 ||
      completedTasks.value.length > 0 ||
      notices.value.length > 0,
)
const persistentNoticeCount = computed(
  () => pendingNotices.value.filter((notice) => notice.persistent).length,
)
const completedNoticeCount = computed(() => completedNotices.value.length)
const completedTaskCount = computed(() => completedTasks.value.length)
function dismissCompletedActivity(): void {
  if (selectedView.value === 'tasks') taskCenter.dismissCompleted()
  else noticeCenter.dismissCompleted()
}
const summary = computed(() => {
  if (open.value && selectedView.value === 'notices') return `通知 ${notices.value.length} 条`
  const active = activeTasks.value[0]
  if (active) return `${active.name} · ${active.phase}`
  const failed = visibleTasks.value.find((task) => task.status === 'failed')
  if (failed) return `${failed.name} · 失败`
  const justCompleted = recentCompletedTasks.value[0]
  if (justCompleted)
    return `${justCompleted.name} · ${justCompleted.status === 'cancelled' ? '已取消' : '已完成'}`
  if (notices.value.length) return `通知 ${notices.value.length} 条`
  return `已完成 ${completedTaskCount.value} 项`
})

function refreshTasks(): void {
  tasks.value = taskCenter.list()
}

function refreshNotices(): void {
  noticeRecords.value = noticeCenter.list()
}

function bytes(value: number): string {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GiB`
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${Math.round(value)} B`
}

function elapsed(task: TaskRecord): string {
  const seconds = Math.max(0, Math.floor((now.value - task.startedAt) / 1000))
  if (seconds < 60) return `已运行 ${seconds} 秒`
  return `已运行 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}

function waitingForProgress(task: TaskRecord): boolean {
  return task.status === 'running' && now.value - task.updatedAt >= 15_000
}

function stalled(task: TaskRecord): boolean {
  const transfer = task.transfer
  return Boolean(
    task.status === 'running' &&
    transfer &&
    (transfer.totalBytes === undefined || transfer.transferredBytes < transfer.totalBytes) &&
    now.value - transfer.lastProgressAt >= 15_000,
  )
}

function transferDescription(task: TaskRecord): string {
  const transfer = task.transfer
  if (!transfer) return ''
  const size = `${bytes(transfer.transferredBytes)}${transfer.totalBytes === undefined ? '' : ` / ${bytes(transfer.totalBytes)}`}`
  if (stalled(task)) return `${size} · 暂无新的传输进展，正在等待`
  const speed = transfer.bytesPerSecond
  const remaining = transfer.remainingSeconds
  return `${size}${speed === undefined ? '' : ` · ${bytes(speed)}/s`}${remaining === undefined ? '' : ` · 本阶段预计剩余约 ${Math.ceil(remaining)} 秒`}`
}

watch(
  () => visible.value && (open.value || centeredImportTask.value !== undefined),
  (enabled) => {
    if (clock !== undefined) clearInterval(clock)
    clock = undefined
    now.value = Date.now()
    if (enabled) clock = setInterval(() => (now.value = Date.now()), 1_000)
  },
)

async function runNoticeAction(action: NoticeRecord['actions'][number]): Promise<void> {
  open.value = false
  try {
    await action.run()
  } catch (error) {
    noticeCenter.push({
      type: 'error',
      message: error instanceof Error ? error.message : '通知操作未完成，请重试。',
    })
  }
}

async function runTaskAction(task: TaskRecord): Promise<void> {
  open.value = false
  try {
    await taskCenter.open(task.operationId)
  } catch (error) {
    noticeCenter.push({
      id: `task-action:${task.operationId}`,
      type: 'error',
      message: error instanceof Error ? error.message : '无法打开任务，原任务已保留。',
    })
  }
}

onMounted(() => {
  refreshTasks()
  refreshNotices()
  unsubscribeTasks = taskCenter.subscribe(refreshTasks)
  unsubscribeNotices = noticeCenter.subscribe(refreshNotices)
})

onUnmounted(() => {
  if (clock !== undefined) clearInterval(clock)
  unsubscribeTasks?.()
  unsubscribeNotices?.()
})
</script>

<template>
  <aside
    v-if="visible"
    class="activity-center"
    :class="{ 'is-open': open, 'activity-center--inline': inline }"
    aria-live="polite"
  >
    <button
      v-if="!inline"
      class="activity-center__trigger"
      type="button"
      :aria-expanded="open"
      aria-controls="srl-activity-panel"
      @click="open = !open"
    >
      <span class="activity-center__signal" :class="{ 'is-running': activeTasks.length }"></span>
      <span>{{ summary }}</span>
      <strong v-if="activeTasks.length">{{ activeTasks.length }}</strong>
      <strong v-else-if="persistentNoticeCount">{{ persistentNoticeCount }}</strong>
    </button>

    <section v-if="open && !inline" id="srl-activity-panel" class="activity-center__panel">
      <header>
        <div>
          <strong>{{ selectedView === 'tasks' ? '任务' : '通知' }}</strong>
        </div>
        <div class="activity-center__header-actions">
          <button
            v-if="selectedView === 'tasks' ? recentCompletedTasks.length : completedNoticeCount"
            type="button"
            @click="dismissCompletedActivity"
          >
            {{ selectedView === 'tasks' ? '清理已结束任务' : '清理已完成通知' }}
          </button>
          <button type="button" aria-label="收起任务与通知" @click="open = false">×</button>
        </div>
      </header>

      <nav class="activity-center__tabs" aria-label="任务和通知分类">
        <button
          type="button"
          :aria-pressed="selectedView === 'tasks'"
          @click="selectedView = 'tasks'"
        >
          任务
          <span>{{ visibleTasks.length + recentCompletedTasks.length + completedTaskCount }}</span>
        </button>
        <button
          type="button"
          :aria-pressed="selectedView === 'notices'"
          @click="selectedView = 'notices'"
        >
          通知 <span>{{ notices.length }}</span>
        </button>
      </nav>

      <component
        :is="group.completed ? 'details' : 'div'"
        v-for="group in activityGroups"
        :key="String(group.completed)"
        :class="{ 'activity-center__completed': group.completed }"
      >
        <summary v-if="group.completed">
          已完成（{{ selectedView === 'tasks' ? completedTaskCount : completedNoticeCount }}）
        </summary>
        <div v-if="group.tasks.length" class="activity-center__group">
          <h3>{{ group.title }}</h3>
          <article v-for="task in group.tasks" :key="task.operationId" class="activity-card">
            <div>
              <strong>{{ task.name }}</strong
              ><small>{{ task.phase }}</small>
            </div>
            <small v-if="task.status === 'running'" class="activity-card__elapsed">{{
              elapsed(task)
            }}</small>
            <small v-if="waitingForProgress(task)" class="activity-card__waiting">
              当前步骤超过 15 秒没有新进度；大文件解析或写入可能较久，请等待结果或检查存储空间。
            </small>
            <progress
              v-if="task.status === 'running' || task.progress !== undefined"
              :value="task.progress"
              :aria-label="`${task.name}：${task.phase}`"
              max="1"
            ></progress>
            <p v-if="task.transfer" class="activity-card__transfer" aria-live="off">
              {{ transferDescription(task) }}
            </p>
            <p v-if="task.error">{{ task.error }}</p>
            <footer>
              <button v-if="task.actionLabel" type="button" @click="runTaskAction(task)">
                {{ task.actionLabel }}
              </button>
              <button
                v-if="task.status === 'running' && task.cancelable"
                type="button"
                @click="taskCenter.cancel(task.operationId)"
              >
                取消
              </button>
              <button
                v-if="task.status === 'failed' && task.retryable"
                type="button"
                @click="taskCenter.retry(task.operationId)"
              >
                重试
              </button>
              <button
                v-if="task.status !== 'running'"
                type="button"
                @click="taskCenter.dismiss(task.operationId)"
              >
                移除
              </button>
            </footer>
          </article>
        </div>

        <div v-if="group.notices.length" class="activity-center__group">
          <h3>{{ group.title }}</h3>
          <article
            v-for="notice in group.notices"
            :key="notice.id"
            class="activity-card"
            :class="`is-${notice.type}`"
          >
            <div>
              <strong>{{ notice.message }}</strong
              ><small>{{ notice.type }}</small>
            </div>
            <details v-if="notice.details">
              <summary>查看详情</summary>
              <p>{{ notice.details }}</p>
            </details>
            <footer>
              <button
                v-for="action in notice.actions"
                :key="action.label"
                type="button"
                @click="runNoticeAction(action)"
              >
                {{ action.label }}
              </button>
              <button type="button" @click="noticeCenter.dismiss(notice.id)">关闭</button>
            </footer>
          </article>
        </div>
      </component>
    </section>

    <section
      v-if="centeredImportTask && (inline || (!open && !suppressFocused))"
      class="activity-center__focused-progress"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <header>
        <span class="activity-center__signal is-running"></span>
        <strong>{{ centeredImportTask.name }}</strong>
        <span v-if="centeredImportTask.itemProgress">
          {{ centeredImportTask.itemProgress.completed }} /
          {{ centeredImportTask.itemProgress.total }} 项
        </span>
        <span v-else-if="centeredImportTask.progress !== undefined">
          {{ Math.round(centeredImportTask.progress * 100) }}%
        </span>
      </header>
      <progress
        :value="centeredImportTask.progress"
        :aria-label="`${centeredImportTask.name}：${centeredImportTask.phase}`"
        max="1"
      ></progress>
      <p>{{ centeredImportTask.phase }}</p>
      <small v-if="centeredImportTask.transfer">{{
        transferDescription(centeredImportTask)
      }}</small>
      <small>{{ elapsed(centeredImportTask) }}</small>
      <small v-if="waitingForProgress(centeredImportTask)" class="activity-center__focused-waiting">
        当前步骤超过 15 秒没有新进度，仍在处理中
      </small>
    </section>
  </aside>
</template>

<style scoped src="../styles/ProjectActivityCenter.css"></style>
