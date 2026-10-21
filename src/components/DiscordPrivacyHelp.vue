<script setup lang="ts">
import '../styles/ConfirmDialog.css'
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { SRL_BACK_REQUEST_EVENT, type SrlBackRequestDetail } from '../composables/UseBackStack'
import { DISCORD_BRIDGE_PRIVACY_POLICY_URL } from '../services/DiscordBridgeDeployService'

const opened = ref(false)
const trigger = ref<HTMLButtonElement>()
const dialog = ref<HTMLDialogElement>()

async function open(): Promise<void> {
  opened.value = true
  await nextTick()
  if (typeof dialog.value?.showModal === 'function') dialog.value.showModal()
  else dialog.value?.setAttribute('open', '')
}
function close(): void {
  if (!opened.value) return
  opened.value = false
  dialog.value?.close?.()
  void nextTick(() => {
    if (trigger.value?.isConnected) trigger.value.focus({ preventScroll: true })
  })
}
function back(event: Event): void {
  if (!opened.value || !(event instanceof CustomEvent)) return
  ;(event.detail as SrlBackRequestDetail).handled = true
  event.stopImmediatePropagation()
  close()
}
onMounted(() => window.addEventListener(SRL_BACK_REQUEST_EVENT, back, true))
onBeforeUnmount(() => {
  window.removeEventListener(SRL_BACK_REQUEST_EVENT, back, true)
  dialog.value?.close?.()
})
</script>

<template>
  <button
    ref="trigger"
    class="discord-privacy-help"
    type="button"
    aria-label="隐私说明与 Discord 配置"
    aria-haspopup="dialog"
    :aria-expanded="opened"
    @click="open"
  >
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.5-2.5 2-2.5 3.5" stroke-linecap="round" />
      <circle cx="12" cy="16" r=".8" fill="currentColor" stroke="none" />
    </svg>
  </button>
  <Teleport to="body">
    <dialog
      v-if="opened"
      ref="dialog"
      class="confirm-dialog__overlay is-centered confirm-dialog__overlay--safety-layer discord-privacy-dialog"
      aria-label="隐私说明与 Discord 配置"
      @cancel.stop.prevent="close"
      @close="close"
      @click.self="close"
    >
      <section class="confirm-dialog discord-privacy-dialog__panel">
        <header>
          <h3>隐私说明与 Discord 配置</h3>
          <button type="button" aria-label="关闭隐私说明" autofocus @click="close">×</button>
        </header>
        <div class="discord-privacy-dialog__body">
          <p>
            选中的内容经你自己的 Cloudflare 暂存后保存到本机；本地副本和历史版本不会随 Discord
            原帖删除而自动删除，导出和备份需另行管理。
          </p>
          <p>
            个人自用不必公开真名或个人账号。核对说明符合自己的部署后，发布可公开阅读的说明页面，
            打开同一个 Discord App 的 General Information，将说明链接填入 Privacy Policy URL， 点击
            Save Changes（保存更改）并确认保存成功；向他人提供服务前还需补充有效的私密数据请求渠道。
          </p>
          <a :href="DISCORD_BRIDGE_PRIVACY_POLICY_URL" target="_blank" rel="noopener noreferrer">
            查看隐私与数据处理说明模板
          </a>
        </div>
        <footer><button type="button" @click="close">关闭</button></footer>
      </section>
    </dialog>
  </Teleport>
</template>

<style scoped>
.discord-privacy-help {
  display: inline-flex;
  width: 1.5rem;
  min-width: 1.5rem;
  height: 1.5rem;
  min-height: 1.5rem;
  align-items: center;
  justify-content: center;
  margin: 0 0 0 0.125rem;
  padding: 0.375rem;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--color-ink-soft);
  box-shadow: none;
  vertical-align: middle;
  cursor: pointer;
}
.discord-privacy-help:hover,
.discord-privacy-help:focus-visible {
  color: var(--color-accent);
}
.discord-privacy-help:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}
.discord-privacy-help svg {
  display: block;
  width: 0.75rem;
  height: 0.75rem;
  flex: none;
}
.discord-privacy-dialog[open]:not(:modal) {
  background: var(--overlay-background);
}
.discord-privacy-dialog__panel {
  border: 1px solid var(--dialog-border, var(--color-line));
  border-radius: var(--dialog-radius, var(--radius-panel));
  background: var(--dialog-background, var(--color-surface));
  box-shadow: var(--dialog-shadow, var(--glass-shadow));
}
.discord-privacy-dialog__panel > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.discord-privacy-dialog__panel h3 {
  margin: 0;
  font-size: 0.9375rem;
  line-height: 1.5;
}
.discord-privacy-dialog__panel > header button {
  min-width: 2rem;
  min-height: 2rem;
  padding: 0;
  font-size: 1.25rem;
}
.discord-privacy-dialog__body {
  margin: 0.625rem 0 0.875rem;
  font-size: 0.8125rem;
  line-height: 1.75;
  overflow-wrap: anywhere;
}
.discord-privacy-dialog__body p {
  margin: 0 0 0.75rem;
}
.discord-privacy-dialog__body a {
  color: var(--color-accent);
  text-decoration: underline;
}
</style>
