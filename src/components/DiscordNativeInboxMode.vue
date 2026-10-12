<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import {
  isNativeDiscordInboxAvailable,
  readNativeDiscordInboxState,
  startNativeDiscordInbox,
  stopNativeDiscordInbox,
} from '../services/NativeDiscordInboxService'
const available = isNativeDiscordInboxAvailable()
const running = ref(false)
const busy = ref(false)
const error = ref('')
function state(event: Event) {
  running.value = (event as CustomEvent<{ running: boolean }>).detail.running
}
async function toggle() {
  busy.value = true
  error.value = ''
  try {
    if (running.value) await stopNativeDiscordInbox()
    else await startNativeDiscordInbox()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '收件模式无法启动，请更新 APK。'
  } finally {
    busy.value = false
  }
}
onMounted(() => {
  if (!available) return
  window.addEventListener('srl:cloud-inbox-state', state)
  void readNativeDiscordInboxState()
    .then((value) => {
      running.value = value
    })
    .catch(() => {
      error.value = '开启收件模式需要更新 APK。'
    })
})
onBeforeUnmount(() => window.removeEventListener('srl:cloud-inbox-state', state))
</script>
<template>
  <section v-if="available" class="native-inbox-mode">
    <div>
      <strong>后台收件</strong
      ><button type="button" :disabled="busy" :aria-pressed="running" @click="toggle">
        {{ busy ? (running ? '正在停止…' : '正在启动…') : running ? '停止收件' : '开启收件模式' }}
      </button>
    </div>
    <p>
      开启后每 30 秒检查云端，显示常驻通知；最长约 5
      小时，系统也可能提前暂停。下载失败、版本确认和帖子待绑定可从通知返回。
    </p>
    <p>应用被结束后文件仍保留，重新打开继续解析导入。</p>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.native-inbox-mode {
  padding: 16px 0;
  border-bottom: 1px solid var(--color-line);
}
.native-inbox-mode > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.native-inbox-mode button {
  appearance: none;
  min-height: 44px;
  padding: 8px 12px;
  font: inherit;
  font-size: 13px;
  font-weight: 550;
  cursor: pointer;
}
.native-inbox-mode p {
  color: var(--color-ink-soft);
  margin: 8px 0 0;
  font-size: 13px;
}
.native-inbox-mode [role='alert'] {
  color: var(--color-danger);
}
</style>
