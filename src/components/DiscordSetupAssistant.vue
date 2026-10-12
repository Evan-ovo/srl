<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import DiscordSetupHelp from './DiscordSetupHelp.vue'
import { discordSetupService } from '../core/AppContainer'
import { hasDiscordSetupBrowser } from '../services/NativeDiscordSetupBrowser'
import { setupStep, type DiscordSetupState } from '../services/DiscordSetupWorkflow'
const available = hasDiscordSetupBrowser()
const state = ref<DiscordSetupState>()
const menuOpen = ref(false)
const active = computed(() => state.value && state.value.step !== 'done')
const busy = ref(false)
const error = ref('')
async function refresh() {
  if (available) state.value = await discordSetupService.current()
}
async function run(operation: () => Promise<unknown>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await operation()
    await refresh()
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : '当前步骤未完成'
  } finally {
    busy.value = false
  }
}
function continueSetup() {
  menuOpen.value = true
}
onMounted(() => {
  if (!available) return
  void refresh().catch(() => {
    error.value = '配置步骤读取失败'
  })
  window.addEventListener('srl:discord-setup-changed', refresh)
})
onBeforeUnmount(() => window.removeEventListener('srl:discord-setup-changed', refresh))
</script>
<template>
  <section v-if="available" class="discord-setup-assistant" aria-label="蒜惹菈网页协助">
    <div class="discord-setup-assistant__row">
      <div class="discord-setup-assistant__copy">
        <strong>蒜惹菈网页协助</strong>
        <p>
          {{
            active && state
              ? `${state.mode === 'economy' ? '省 Token 模式' : '代理模式'} · ${setupStep(state.step).title}`
              : state?.step === 'done'
                ? '本次连接与命令检查通过；请到 Discord 实际使用一次命令'
                : '配置 Discord Bridge · 登录与密钥由你填写'
          }}
        </p>
      </div>
      <div class="discord-setup-assistant__actions">
        <button
          type="button"
          class="discord-setup-assistant__continue"
          :disabled="busy"
          @click="continueSetup"
        >
          <span>{{ busy ? '处理中' : active ? '继续' : '开始协助' }}</span>
        </button>
        <button
          type="button"
          class="discord-setup-assistant__more"
          aria-label="网页协助更多选项"
          :disabled="busy"
          @click="menuOpen = true"
        >
          ⋯
        </button>
      </div>
    </div>
    <button
      v-if="active && state && state.step !== 'diagnose' && setupStep(state.step).site === 'local'"
      type="button"
      :disabled="busy"
      @click="run(() => discordSetupService.next())"
    >
      本步完成，核验并继续
    </button>
    <p v-if="error" class="discord-setup-assistant__error" role="alert">{{ error }}</p>
    <DiscordSetupHelp v-model:open="menuOpen" />
  </section>
</template>
<style scoped>
.discord-setup-assistant {
  padding: 10px 0;
  border-bottom: 1px solid var(--color-line);
}
.discord-setup-assistant__row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.discord-setup-assistant__copy {
  flex: 1;
  min-width: 0;
}
.discord-setup-assistant strong {
  font-size: 14px;
  font-weight: 600;
}
.discord-setup-assistant p {
  overflow-wrap: anywhere;
  margin: 3px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--color-ink-soft);
}
.discord-setup-assistant__actions {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: 4px;
}
.discord-setup-assistant button {
  min-height: 44px;
  border: 0;
  padding: 4px;
  background: var(--button-background, transparent);
  color: var(--button-color, var(--color-ink));
  cursor: pointer;
}
.discord-setup-assistant__continue span {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 34px;
  padding: 0 10px;
  font-size: 14px;
  background: var(--color-accent-soft);
  color: var(--color-accent);
  border: 1px solid var(--color-line);
  border-radius: 8px;
}
.discord-setup-assistant__more {
  width: 44px;
  font-size: 22px;
}
.discord-setup-assistant button:disabled {
  opacity: 0.6;
  cursor: default;
}
.discord-setup-assistant p.discord-setup-assistant__error {
  color: var(--color-danger);
}
</style>
