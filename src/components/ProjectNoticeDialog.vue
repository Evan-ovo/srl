<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

// SRL-PUBLIC-SYNC: BEGIN PUBLIC-ONLY id=public-network-disclosure-import
import PublicNetworkDisclosure from './PublicNetworkDisclosure.vue'
// SRL-PUBLIC-SYNC: END PUBLIC-ONLY id=public-network-disclosure-import
import { isAndroidApk } from '../core/AndroidAppUpdate'
import {
  getAutomaticApkUpdateChecks,
  setAutomaticApkUpdateChecks,
} from '../services/BrowserDevicePreferences'

import { triggerNativeHaptic } from '../core/NativeHaptics'

const props = defineProps<{
  open: boolean
  review?: boolean
}>()

const emit = defineEmits<{
  acknowledged: []
}>()

const nativeApk = isAndroidApk()
const automaticUpdates = ref(getAutomaticApkUpdateChecks())
const preferenceError = ref('')
const READING_SECONDS = 5
const SCROLL_END_TOLERANCE_PX = 6
const secondsRemaining = ref(READING_SECONDS)
const reachedEnd = ref(false)
const dialog = ref<HTMLElement>()
const body = ref<HTMLElement>()
let countdownTimer: number | undefined

const canAcknowledge = computed(
  () => props.review || (secondsRemaining.value === 0 && reachedEnd.value),
)
const confirmLabel = computed(() => {
  if (props.review) return '关闭说明'
  if (canAcknowledge.value) return '我已阅读，进入资源库'
  if (!reachedEnd.value && secondsRemaining.value > 0)
    return `请阅读并滑至底部 · ${secondsRemaining.value} 秒`
  if (!reachedEnd.value) return '请滑至底部继续'
  return `请阅读 ${secondsRemaining.value} 秒`
})
const readingHint = computed(() => {
  if (props.review) return '此处仅查看说明，不会重新授权或更改设置。'
  if (canAcknowledge.value) return '已记录本次说明版本，可在设置中随时重看。'
  if (!reachedEnd.value) return '请完整阅读并滑动到正文底部。'
  return '已阅读到正文底部，请等待倒计时结束。'
})

function clearCountdown(): void {
  if (countdownTimer !== undefined) window.clearInterval(countdownTimer)
  countdownTimer = undefined
}

function startCountdown(): void {
  clearCountdown()
  secondsRemaining.value = READING_SECONDS
  countdownTimer = window.setInterval(() => {
    secondsRemaining.value = Math.max(0, secondsRemaining.value - 1)
    if (secondsRemaining.value === 0) clearCountdown()
  }, 1000)
}

function checkReachedEnd(): void {
  const element = body.value
  if (!element || reachedEnd.value || element.scrollHeight <= 0 || element.clientHeight <= 0) return
  if (element.scrollHeight - element.scrollTop - element.clientHeight <= SCROLL_END_TOLERANCE_PX)
    reachedEnd.value = true
}

async function resetReadingState(): Promise<void> {
  reachedEnd.value = false
  automaticUpdates.value = getAutomaticApkUpdateChecks()
  preferenceError.value = ''
  if (!props.review) startCountdown()
  await nextTick()
  if (body.value) body.value.scrollTop = 0
  checkReachedEnd()
  dialog.value?.focus({ preventScroll: true })
}

function preventDismiss(event: KeyboardEvent): void {
  if (!props.open || event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  if (props.review) acknowledge()
}

function acknowledge(): void {
  if (!canAcknowledge.value) return
  if (!props.review && nativeApk && automaticUpdates.value !== getAutomaticApkUpdateChecks()) {
    try {
      setAutomaticApkUpdateChecks(automaticUpdates.value)
    } catch {
      preferenceError.value = '未能保存选择，请重试或取消勾选后继续。'
      return
    }
  }
  triggerNativeHaptic('confirm')
  emit('acknowledged')
}

watch(
  () => props.open,
  (open) => {
    if (open) void resetReadingState()
    else clearCountdown()
  },
)

onMounted(() => {
  window.addEventListener('keydown', preventDismiss, true)
  window.addEventListener('resize', checkReachedEnd)
  if (props.open) void resetReadingState()
})

onUnmounted(() => {
  clearCountdown()
  window.removeEventListener('keydown', preventDismiss, true)
  window.removeEventListener('resize', checkReachedEnd)
})
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="project-notice__overlay" role="presentation">
      <section
        ref="dialog"
        class="project-notice"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-notice-title"
        aria-describedby="project-notice-description"
        tabindex="-1"
      >
        <header class="project-notice__header">
          <span class="project-notice__seal" aria-hidden="true">SRL</span>
          <div>
            <p>READ BEFORE ENTERING</p>
            <h1 id="project-notice-title">使用前说明</h1>
          </div>
        </header>

        <div
          id="project-notice-description"
          ref="body"
          class="project-notice__body"
          tabindex="0"
          @scroll.passive="checkReachedEnd"
        >
          <!-- SRL-PUBLIC-SYNC: BEGIN REPLACE id=project-notice-lead -->
          <p class="project-notice__lead">
            SRL 是一个本地优先的 SillyTavern 资源工具。使用前请了解数据边界与使用责任。
          </p>
          <!-- SRL-PUBLIC-SYNC: END REPLACE id=project-notice-lead -->

          <!-- SRL-PUBLIC-SYNC: BEGIN REPLACE id=project-notice-privacy -->
          <PublicNetworkDisclosure />
          <!-- SRL-PUBLIC-SYNC: END REPLACE id=project-notice-privacy -->

          <section v-if="nativeApk && !review">
            <h2>更新偏好</h2>
            <label class="project-notice__option">
              <input v-model="automaticUpdates" type="checkbox" />
              <span
                ><strong>自动检查 APK 更新</strong
                ><small
                  >可选，默认关闭；开启后在启动、回到前台或联网时检查，12
                  小时内最多一次。关闭后仍可在设置中手动检查。</small
                ></span
              >
            </label>
            <p v-if="preferenceError" role="alert">{{ preferenceError }}</p>
          </section>

          <!-- SRL-PUBLIC-SYNC: BEGIN REPLACE id=project-notice-source-terms -->
          <section>
            <h2>源码与费用</h2>
            <p>
              本项目源码不收取购买费、授权费或激活费。第三方自行提供的服务器、部署或技术支持可能产生独立费用；请遵守
              LICENSE 与 NOTICE。
            </p>
          </section>
          <!-- SRL-PUBLIC-SYNC: END REPLACE id=project-notice-source-terms -->

          <section>
            <h2>使用责任</h2>
            <p>
              SRL
              仅提供资源管理、预览、转换、生成、备份与扩展运行等工具能力。用户自行导入、创建、生成、修改、发布或传播的内容，以及自行安装的第三方
              APP、插件、脚本和外部服务，由相应内容提供者或实际使用者自行负责。
            </p>
            <p>
              SRL
              作者不会主动控制、审核或认可用户通过本工具处理的全部内容，也不代表相关第三方内容的立场。请勿利用
              SRL 从事违反适用法律、侵犯他人权益、恶意攻击服务或影响其他用户正常使用的行为。
            </p>
          </section>
        </div>

        <footer class="project-notice__footer">
          <p aria-live="polite">{{ readingHint }}</p>
          <button type="button" :disabled="!canAcknowledge" @click="acknowledge">
            {{ confirmLabel }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
