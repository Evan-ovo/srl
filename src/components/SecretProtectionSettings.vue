<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { secretResourceService } from '../services/SecretResourceService'
import {
  clearNativeSecretRecovery,
  getNativeSecretRecoveryState,
  isNativeSecurityAvailable,
  type NativeSecretRecoveryState,
} from '../core/NativeSecurity'
const native = isNativeSecurityAvailable()
const props = defineProps<{ unlockOnly?: boolean }>()
const emit = defineEmits<{ ready: [] }>()
const configured = ref(false)
const unlocked = ref(false)
const editing = ref(false)
const password = ref('')
const confirmation = ref('')
const recovered = ref('')
const busy = ref(true)
const readFailed = ref(false)
const message = ref('')
const recovery = ref<NativeSecretRecoveryState | null>(null)
const section = ref<HTMLElement | null>(null)
const pendingPasswordAction = computed(() =>
  editing.value && (password.value || confirmation.value)
    ? configured.value
      ? '解锁统一密码并完成'
      : '保存统一密码并完成'
    : '',
)
async function refresh() {
  try {
    configured.value = await secretResourceService.hasPassword()
    readFailed.value = false
  } catch (error) {
    readFailed.value = true
    throw error
  }
  unlocked.value = secretResourceService.isUnlocked()
  if (native) recovery.value = await getNativeSecretRecoveryState().catch(() => null)
}
async function run(action: () => Promise<void>) {
  if (busy.value) return false
  busy.value = true
  message.value = ''
  recovered.value = ''
  try {
    await action()
    await refresh()
    if (unlocked.value) emit('ready')
    return true
  } catch (error) {
    message.value = error instanceof Error ? error.message : '操作未完成'
    return false
  } finally {
    busy.value = false
  }
}
onMounted(async () => {
  try {
    await refresh()
    if (props.unlockOnly) editing.value = !unlocked.value
    if (unlocked.value) emit('ready')
  } catch (error) {
    message.value = `读取密码设置失败：${error instanceof Error ? error.message : '请稍后手动重新读取'}`
  } finally {
    busy.value = false
  }
})
onBeforeUnmount(() => {
  password.value = ''
  confirmation.value = ''
  recovered.value = ''
})
function lock() {
  secretResourceService.lock()
  unlocked.value = false
  recovered.value = ''
  password.value = ''
  message.value = '统一密码已锁定'
}
async function reread() {
  await run(async () => {})
  if (props.unlockOnly && !readFailed.value) editing.value = !unlocked.value
}
async function save() {
  if (readFailed.value) return false
  return run(async () => {
    if (!configured.value && password.value !== confirmation.value)
      throw new Error('两次密码不一致')
    if (configured.value) await secretResourceService.unlock(password.value)
    else await secretResourceService.setPassword(password.value)
    password.value = ''
    confirmation.value = ''
    editing.value = false
    message.value = '统一密码已解锁，本次使用有效；关闭页面后需重新解锁。'
  })
}
async function finishPendingPassword(): Promise<boolean> {
  if (busy.value) return false
  if (!pendingPasswordAction.value) return true
  const saved = (await save()) && configured.value && unlocked.value
  if (!saved) section.value?.scrollIntoView?.({ block: 'start' })
  return saved
}
defineExpose({ pendingPasswordAction, busy, finishPendingPassword })
async function enableRecovery() {
  await run(async () => {
    await secretResourceService.enableRecovery(password.value)
    password.value = ''
    message.value = '已开启本机指纹找回'
  })
}
async function recover() {
  await run(async () => {
    recovered.value = await secretResourceService.recoverPassword()
    message.value = '已找回原统一密码并解锁。离开设置后不再显示。'
  })
}
</script>
<template>
  <section
    ref="section"
    class="settings-section secret-protection-settings"
    aria-label="密钥统一密码"
  >
    <header>
      <h3>密钥统一密码</h3>
      <span>{{
        readFailed ? '读取失败' : busy ? '正在读取' : configured ? '已设置' : '未设置'
      }}</span>
    </header>
    <p>
      密码加密为可选功能，在密钥卡中选择开启。已加密的卡片共用此密码，导出和云备份保留各卡片的保护方式。
    </p>
    <button
      v-if="readFailed"
      class="button button--quiet"
      type="button"
      :disabled="busy"
      @click="reread"
    >
      重新读取密码设置
    </button>
    <div v-if="!unlockOnly && !readFailed" class="secret-protection-settings__actions">
      <button
        class="button button--quiet"
        type="button"
        :disabled="busy"
        @click="editing = !editing"
      >
        {{ editing ? '收起' : configured ? '解锁统一密码' : '设置统一密码' }}
      </button>
      <button
        v-if="unlocked"
        class="button button--quiet"
        type="button"
        :disabled="busy"
        @click="lock"
      >
        锁定统一密码
      </button>
    </div>
    <form v-if="editing && !readFailed" @submit.prevent="save">
      <label class="field"
        ><span>{{ configured ? '统一密码' : '设置统一密码' }}</span
        ><input
          v-model="password"
          class="field__control"
          type="password"
          minlength="8"
          maxlength="512"
          :autocomplete="configured ? 'current-password' : 'new-password'"
          required
          :disabled="busy"
      /></label>
      <label v-if="!configured" class="field"
        ><span>再次输入统一密码</span
        ><input
          v-model="confirmation"
          class="field__control"
          type="password"
          minlength="8"
          maxlength="512"
          autocomplete="new-password"
          required
          :disabled="busy"
      /></label>
      <p v-if="!configured">至少 8 位。请保存好密码；网页端不能通过指纹找回。</p>
      <button class="button button--primary" type="submit" :disabled="busy">
        {{ configured ? '解锁' : '保存统一密码' }}
      </button>
    </form>
    <template v-if="native && configured && !unlockOnly && !readFailed">
      <p>
        指纹找回仅限此
        APK、此设备。需提前开启；卸载应用或更改系统指纹后可能失效。恢复材料不进入云备份。
      </p>
      <template v-if="recovery">
        <p v-if="recovery.status === 'invalid'" role="status">
          本机指纹恢复记录不完整或密钥不可用，请使用原统一密码重新绑定。原密码和资料未修改。
        </p>
        <div
          v-if="!recovery.enabled && recovery.available"
          class="secret-protection-settings__recovery"
        >
          <label v-if="!editing" class="field"
            ><span>验证原统一密码以开启指纹找回</span
            ><input
              v-model="password"
              class="field__control"
              type="password"
              autocomplete="current-password"
              :disabled="busy"
          /></label>
          <button
            class="button button--quiet"
            type="button"
            :disabled="busy || !password"
            @click="enableRecovery"
          >
            开启指纹找回
          </button>
        </div>
        <div v-if="recovery.enabled" class="secret-protection-settings__actions">
          <button
            class="button button--primary"
            type="button"
            :disabled="busy || !recovery.available"
            @click="recover"
          >
            忘记密码？指纹找回
          </button>
          <button
            class="button button--quiet"
            type="button"
            :disabled="busy"
            @click="
              run(async () => {
                await clearNativeSecretRecovery()
                message = '已关闭本机指纹找回，统一密码不变'
              })
            "
          >
            关闭指纹找回
          </button>
        </div>
        <p v-if="!recovery.available">请先在安卓系统中录入可用的指纹或强生物识别。</p>
      </template>
      <p v-else>当前 APK 尚不支持指纹找回，请更新 APK。</p>
    </template>
    <label v-if="recovered" class="field"
      ><span>找回的统一密码</span
      ><input :value="recovered" class="field__control" readonly autocomplete="off"
    /></label>
    <p v-if="message" role="status">{{ message }}</p>
  </section>
</template>
<style scoped>
.secret-protection-settings form,
.secret-protection-settings__recovery {
  display: grid;
  gap: 12px;
}
.secret-protection-settings__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.secret-protection-settings .field {
  display: grid;
  gap: 6px;
  min-width: 0;
}
.secret-protection-settings .field__control {
  width: 100%;
  min-width: 0;
  min-height: 44px;
  box-sizing: border-box;
}
.secret-protection-settings p {
  margin: 0;
  color: var(--color-ink-soft);
  font-size: 0.8rem;
  overflow-wrap: anywhere;
}
</style>
