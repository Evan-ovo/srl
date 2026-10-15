<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { confirmAction } from '../composables/UseConfirmDialog'
import { inboxConnection } from '../services/DiscordHandoffService'
import {
  acknowledgeDiscordResource,
  cancelDiscordResourceJob,
  deleteDiscordResourceJob,
  listDiscordResourceJobs,
  type DiscordResourceJob,
} from '../services/DiscordResourceInboxService'
import { loadDiscordSourceConnectionSettings } from '../services/DiscordSourceSettingsService'
import { taskCenter } from '../core/TaskCenter'

const jobs = ref<DiscordResourceJob[]>([])
const localTasks = ref(taskCenter.list())
const unsubscribeTasks = taskCenter.subscribe(() => {
  localTasks.value = taskCenter.list()
})
function localTask(job: DiscordResourceJob) {
  return localTasks.value.find((task) => task.operationId === `discord-resource-${job.id}`)
}
function jobLabel(job: DiscordResourceJob): string {
  const task = localTask(job)
  return task?.status === 'running' ? task.phase : labels[job.state]
}
const visibleJobs = computed(() => jobs.value.filter((job) => job.state !== 'imported'))
const completedJobs = computed(() => jobs.value.filter((job) => job.state === 'imported'))
const loading = ref(false)
const error = ref('')
const hasMore = ref(false)
const available = ref(false)
let disposed = false
let requested = false
const pending = computed(
  () => jobs.value.filter((job) => !['imported', 'failed', 'cancelled'].includes(job.state)).length,
)
const labels: Record<DiscordResourceJob['state'], string> = {
  queued: '待下载',
  downloading: '正在下载',
  importing: '正在导入',
  waiting_version: '待选历史版本',
  imported: '已导入',
  failed: '失败',
  cancelled: '已取消',
}
async function refresh(): Promise<void> {
  if (loading.value) {
    requested = true
    return
  }
  loading.value = true
  error.value = ''
  try {
    const settings = loadDiscordSourceConnectionSettings()
    available.value = Boolean(settings.inboxLibraryId && settings.inboxSecret)
    if (!available.value) {
      jobs.value = []
      return
    }
    const target = inboxConnection()
    const result = await listDiscordResourceJobs(target)
    if (disposed) return
    const rows = new Map([...result.jobs, ...result.recent].map((job) => [job.id, job]))
    jobs.value = [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20)
    hasMore.value = result.hasMore
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '资源下载状态读取失败'
  } finally {
    loading.value = false
    if (requested && !disposed) {
      requested = false
      void refresh()
    }
  }
}
function receive(): void {
  window.dispatchEvent(new Event('srl:receive-discord-resources'))
  void refresh()
}
async function retry(job: DiscordResourceJob): Promise<void> {
  try {
    const task = localTask(job)
    if (task?.status === 'failed' && task.retryable) {
      if (!(await taskCenter.retry(task.operationId)))
        throw new Error('重试未完成，请查看任务详情。')
      await refresh()
      return
    }
    await acknowledgeDiscordResource(job.id, 'queued', inboxConnection())
    receive()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '重试失败'
  }
}
async function cancel(job: DiscordResourceJob): Promise<void> {
  if (
    !(await confirmAction({
      title: `取消下载 ${job.name}？`,
      message: '取消后会停止这项云端下载并保留取消记录；确认后可在这里重试或清理记录。',
      confirmLabel: '取消下载',
    }))
  )
    return
  try {
    await cancelDiscordResourceJob(job.id, inboxConnection())
    error.value = ''
    await refresh()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '取消下载失败。'
    await refresh()
  }
}
async function skipVersion(job: DiscordResourceJob): Promise<void> {
  if (
    !(await confirmAction({
      title: `跳过 ${job.name} 的版本选择？`,
      message:
        '这会放弃本次导入并清理本机暂存文件；资源库中已有的资源不会删除。云端记录可在跳过后清理。',
      confirmLabel: '跳过并清理暂存',
    }))
  )
    return
  window.dispatchEvent(
    new CustomEvent('srl:cancel-discord-version-import', { detail: { id: job.id } }),
  )
}
async function remove(job: DiscordResourceJob): Promise<void> {
  try {
    await deleteDiscordResourceJob(job.id, inboxConnection())
    error.value = ''
    await refresh()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '清理云端任务失败。'
  }
}
function changed(): void {
  void refresh()
}
onMounted(() => {
  window.addEventListener('srl:discord-resources-updated', changed)
  window.addEventListener('srl:receive-discord-inbox', changed)
  void refresh()
})
onBeforeUnmount(() => {
  disposed = true
  unsubscribeTasks()
  window.removeEventListener('srl:discord-resources-updated', changed)
  window.removeEventListener('srl:receive-discord-inbox', changed)
})
</script>

<template>
  <section class="discord-downloads" aria-labelledby="discord-downloads-title" :aria-busy="loading">
    <header>
      <div>
        <div class="discord-downloads__heading">
          <strong id="discord-downloads-title">资源下载</strong>
          <span v-if="pending" class="discord-downloads__pending" role="status">
            {{ pending }}{{ hasMore ? '+' : '' }} 项待处理
          </span>
        </div>
        <p v-if="!available">先在帖子收件中配对这份资源库。</p>
      </div>
      <button
        type="button"
        aria-label="刷新领取"
        data-assistant-focus="inbox-resource-claim"
        :disabled="!available || loading"
        @click="receive"
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M19 8a8 8 0 0 0-13-2L3 9m0-5v5h5M5 16a8 8 0 0 0 13 2l3-3m0 5v-5h-5" />
        </svg>
        领取
      </button>
    </header>
    <p v-if="error" class="discord-downloads__error" role="alert">{{ error }}</p>
    <ul v-if="visibleJobs.length">
      <li v-for="job in visibleJobs" :key="job.id">
        <span class="discord-downloads__file-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M14 3H5v18h14V8l-5-5Zm0 0v5h5M8 12h8M8 16h5" />
          </svg>
        </span>
        <div class="discord-downloads__file">
          <span :title="job.name">{{ job.name }}</span>
          <small :data-state="job.state">{{ jobLabel(job) }}</small>
          <p v-if="job.error" class="discord-downloads__error">{{ job.error }}</p>
        </div>
        <button
          v-if="job.state === 'failed' || job.state === 'cancelled'"
          type="button"
          :aria-label="`重试 ${job.name}`"
          @click="retry(job)"
        >
          重试
        </button>
        <button
          v-if="
            (job.state === 'queued' || job.state === 'downloading') &&
            localTask(job)?.cancelable !== false
          "
          type="button"
          :aria-label="`取消 ${job.name}`"
          @click="cancel(job)"
        >
          取消
        </button>
        <button
          v-if="job.state === 'waiting_version'"
          type="button"
          :aria-label="`跳过 ${job.name}`"
          @click="skipVersion(job)"
        >
          跳过
        </button>
        <button
          v-if="job.state === 'failed' || job.state === 'cancelled'"
          type="button"
          :aria-label="`清理 ${job.name}`"
          @click="remove(job)"
        >
          清理
        </button>
      </li>
    </ul>
    <p v-else-if="!jobs.length && available && !error && !loading">暂无资源下载任务。</p>
    <details v-if="completedJobs.length" class="discord-downloads__history">
      <summary>已完成记录（{{ completedJobs.length }}）</summary>
      <ul>
        <li v-for="job in completedJobs" :key="job.id">
          <div class="discord-downloads__file">
            <span :title="job.name">{{ job.name }}</span
            ><small data-state="imported">已导入</small>
          </div>
        </li>
      </ul>
      <p>云端回执最长保留 7 天；已导入的本机资源不会自动删除。</p>
    </details>
    <details>
      <summary>下载说明</summary>
      <p>
        Discord 长按消息 → 应用 →
        下载资源到SRL（云端暂存）。下载后自动解析导入，进度也可在任务中心查看；成功后进入普通资源列表。
      </p>
      <p>
        Bot 临时回复没有“应用”入口时，可复制附件下载地址，执行 /下载直链
        链接:下载地址；不会保存帖子正文。
      </p>
      <p>
        目前支持 Discord 附件及消息中的 Discord CDN 直链。网页单文件上限 256 MiB，APK 上限 4
        GiB；资源包复用现有 ZIP 导入。
      </p>
      <p>
        iOS PWA 需保持页面打开；关闭后任务留在云端，回来再领取。APK
        领取后的下载可在原生队列继续；进程被结束后，解析与版本确认需重新打开应用。
      </p>
      <p>
        附件链接失效时，Bot 有原消息读取权限才能自动刷新；直接粘贴的临时链接过期需重新复制。任务保留
        7 天，失败可重试；重新发送同一文件及 APK 手动导入均按内容去重。
      </p>
    </details>
  </section>
</template>

<style scoped src="../styles/DiscordResourceDownloadPanel.css"></style>
