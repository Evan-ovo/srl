<script setup lang="ts">
import { onUnmounted, ref } from 'vue'
import { confirmAction } from '../composables/UseConfirmDialog'
import { beginLocalDataReset, LOCAL_DATA_RESET_PHRASE } from '../core/LocalDataReset'
import { platform } from '../core/PlatformService'
import { taskCenter } from '../core/TaskCenter'

const busy = ref(false)
const error = ref('')
const lifetime = new AbortController()
onUnmounted(() => lifetime.abort())
function requireIdle(): void {
  if (taskCenter.list().some((task) => task.status === 'running'))
    throw new Error('请先在“任务与通知”中停止或完成正在进行的任务，再清除本机数据。')
}
async function reset(): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    requireIdle()
    if (
      !(await confirmAction(
        {
          title: '清除所有本机内容？',
          message:
            '将永久清除本机资源、历史版本、回收站、APP 程序与使用数据、帖子、生图和工坊项目、设置及本机凭据，恢复初始状态。\n\n云端备份和账号保留，自行导出的文件保留。清理后可能需要重新登录，恢复资料需使用之前的备份。\n\n清理开始后不可撤销；下一步还必须手动输入完整确认句子。',
          confirmLabel: '继续',
          danger: true,
          centered: true,
        },
        lifetime.signal,
      ))
    )
      return
    if (
      !(await confirmAction(
        {
          title: '手动输入确认',
          message: '本机 SRL 数据将永久清除。云端备份和账号保留。',
          requiredText: LOCAL_DATA_RESET_PHRASE,
          confirmLabel: '清除全部本机数据',
          danger: true,
          centered: true,
        },
        lifetime.signal,
      ))
    )
      return
    if (lifetime.signal.aborted) return
    requireIdle()
    if (platform.update.isAndroidApk())
      await platform.maintenance.clearLocalData(LOCAL_DATA_RESET_PHRASE)
    else beginLocalDataReset(LOCAL_DATA_RESET_PHRASE)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '未能完成本机数据清理'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="settings-section local-data-reset-controls" aria-label="恢复初始状态">
    <button class="settings-action-row" type="button" :disabled="busy" @click="reset">
      <span
        ><strong>一键清除所有内容</strong><small>恢复本机初始状态，保留云端备份和账号</small></span
      >
    </button>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.local-data-reset-controls > button {
  border: 1px solid color-mix(in srgb, var(--color-danger) 28%, var(--color-line));
  border-radius: var(--radius-control);
  padding: 1rem;
  background: color-mix(in srgb, var(--color-danger) 5%, var(--color-surface-raised));
  box-shadow: none;
  color: var(--color-danger);
}
.local-data-reset-controls strong {
  color: var(--color-danger);
}
.local-data-reset-controls small {
  margin-top: 0.3rem;
  line-height: 1.6;
}
</style>
