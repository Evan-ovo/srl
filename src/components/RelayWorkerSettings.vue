<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from 'vue'
import {
  checkRelayWorker,
  loadRelayWorkerBaseUrl,
  resolveRelayWorkerTarget,
  saveRelayWorkerBaseUrl,
  useDeviceRelayStatus,
} from '../services/RelayWorkerSettingsService'
import RelayWorkerDeployGuidePage from './RelayWorkerDeployGuidePage.vue'

const address = ref('')
const current = ref('')
const message = ref('')
const checking = ref(false)
const showGuide = ref(false)
const help = ref<HTMLButtonElement | null>(null)
const deviceRelayStatus = useDeviceRelayStatus()
let checkAbort: AbortController | undefined
onBeforeUnmount(() => checkAbort?.abort())
function readCurrent() {
  try {
    address.value = loadRelayWorkerBaseUrl()
    const target = resolveRelayWorkerTarget(address.value)
    // SRL-PUBLIC-SYNC: BEGIN REPLACE id=public-relayworkersettings-vue-1
    current.value = target.custom ? `自建中继 · ${target.origin}` : '未配置'
    // SRL-PUBLIC-SYNC: END REPLACE id=public-relayworkersettings-vue-1
  } catch (error) {
    current.value = '配置无效，已停止中继请求'
    message.value = error instanceof Error ? error.message : '无法读取中继设置'
  }
}
readCurrent()
function save(value = address.value) {
  try {
    address.value = saveRelayWorkerBaseUrl(value)
    readCurrent()
    // SRL-PUBLIC-SYNC: BEGIN REPLACE id=public-relayworkersettings-vue-2
    message.value = address.value
      ? '自部署 Worker 已保存在本机；连接失败不会改走其他中继'
      : '已清除自部署 Worker；Koofr 中继与加密暂存当前不可用'
    // SRL-PUBLIC-SYNC: END REPLACE id=public-relayworkersettings-vue-2
  } catch (error) {
    message.value = error instanceof Error ? error.message : '保存失败'
  }
}
async function check() {
  if (checking.value) {
    checkAbort?.abort()
    return
  }
  checking.value = true
  checkAbort = new AbortController()
  message.value = '正在检查…'
  try {
    await checkRelayWorker(address.value, checkAbort.signal)
    message.value = deviceRelayStatus.value.enabled
      ? 'SRL Worker 检测通过，中继码已开启；酒馆端需填写相同地址'
      : 'SRL Worker 检测通过；请保存该地址以开启中继码'
  } catch (error) {
    message.value = checkAbort.signal.aborted
      ? '检查已取消'
      : error instanceof Error
        ? error.message
        : '无法访问中继，请检查地址和部署状态'
  } finally {
    checking.value = false
    checkAbort = undefined
  }
}
async function closeGuide() {
  showGuide.value = false
  await nextTick()
  help.value?.focus()
}
</script>

<template>
  <section class="settings-section relay-worker-settings" aria-label="中继服务">
    <header>
      <!-- SRL-PUBLIC-SYNC: BEGIN REPLACE id=public-relayworkersettings-vue-3 -->
      <h3>自部署 Worker</h3>
      <!-- SRL-PUBLIC-SYNC: END REPLACE id=public-relayworkersettings-vue-3 -->
      <button ref="help" type="button" aria-label="查看自部署中继教程" @click="showGuide = true">
        部署教程
      </button>
    </header>
    <p class="relay-worker-settings__current">当前使用：{{ current }}</p>
    <label>
      <!-- SRL-PUBLIC-SYNC: BEGIN REPLACE id=public-relayworkersettings-vue-4 -->
      <strong>SRL Worker 地址</strong>
      <!-- SRL-PUBLIC-SYNC: END REPLACE id=public-relayworkersettings-vue-4 -->
      <!-- SRL-PUBLIC-SYNC: BEGIN REPLACE id=public-relayworkersettings-vue-5 -->
      <input
        v-model="address"
        type="url"
        autocomplete="off"
        spellcheck="false"
        placeholder="https://your-worker.workers.dev"
        aria-label="自建 Worker 地址"
      />
      <!-- SRL-PUBLIC-SYNC: END REPLACE id=public-relayworkersettings-vue-5 -->
    </label>
    <p>
      <!-- SRL-PUBLIC-SYNC: BEGIN REPLACE id=public-relayworkersettings-vue-6 -->
      Public 不提供公共中继。部署自己的 SRL-Worker-Public 后填写 HTTPS
      根地址，用于酒馆设备码中继、加密暂存和网页 Koofr
      中继。设备码中继需检查通过后使用；酒馆端需填写相同地址，Discord 设置独立。Android
      云盘直连保持。
      <!-- SRL-PUBLIC-SYNC: END REPLACE id=public-relayworkersettings-vue-6 -->
    </p>
    <p>
      仅填写自己部署、可信的 HTTPS 根地址。Koofr
      凭据会经过所选中继；自建连接失败不会自动回退官方。地址仅保存在本机，不随资源备份导出。
    </p>
    <div class="relay-worker-settings__actions">
      <button type="button" @click="check">
        {{ checking ? '取消检查' : '检查连接' }}
      </button>
      <button type="button" @click="save()">保存</button>
      <!-- SRL-PUBLIC-SYNC: BEGIN REPLACE id=public-relayworkersettings-vue-7 -->
      <button type="button" @click="save('')">清除地址</button>
      <!-- SRL-PUBLIC-SYNC: END REPLACE id=public-relayworkersettings-vue-7 -->
    </div>
    <p v-if="message" role="status">{{ message }}</p>
    <RelayWorkerDeployGuidePage v-if="showGuide" @close="closeGuide" />
  </section>
</template>

<style scoped>
.relay-worker-settings {
  min-width: 0;
}
.relay-worker-settings p {
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--color-ink-soft);
  overflow-wrap: anywhere;
}
.relay-worker-settings label {
  display: grid;
  gap: 0.5rem;
  font-size: 0.8rem;
}
.relay-worker-settings input {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  min-height: 2.75rem;
  padding: 0.6rem;
  font: inherit;
  font-size: 1rem;
}
.relay-worker-settings__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.relay-worker-settings button {
  min-height: var(--size-touch);
  padding: 0.4rem 0.7rem;
  cursor: pointer;
}
</style>
