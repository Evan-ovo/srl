<script setup lang="ts">
import '../styles/ConfirmDialog.css'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { defineAsyncComponent } from 'vue'

import { useConfirmDialogState, type ConfirmDialogResponse } from '../composables/UseConfirmDialog'
import { SRL_BACK_REQUEST_EVENT, type SrlBackRequestDetail } from '../composables/UseBackStack'
import { triggerNativeHaptic } from '../core/NativeHaptics'
import { matchesConfirmationText } from '../utils/ConfirmationText'

const { activeDialog, respond } = useConfirmDialogState()
const modal = ref<HTMLDialogElement>()
const confirmButton = ref<HTMLButtonElement>()
const cancelButton = ref<HTMLButtonElement>()
const dialogPanel = ref<HTMLElement>()
const SecretProtectionSettings = defineAsyncComponent(
  () => import('./SecretProtectionSettings.vue'),
)
const secretReady = ref(false)
const confirmationText = ref('')
const composing = ref(false)
const textReady = computed(
  () =>
    !activeDialog.value?.requiredText ||
    (!composing.value &&
      matchesConfirmationText(confirmationText.value, activeDialog.value.requiredText)),
)
// SRL-PUBLIC-SYNC: BEGIN REPLACE id=assistant-token-review-dialog-state
const TokenReview = defineAsyncComponent(() => import('./ProductAssistantTokenReview.vue'))
const tokenReview = ref<{ closeDetail: () => void }>()
const detailsOpen = ref(false)
// SRL-PUBLIC-SYNC: END REPLACE id=assistant-token-review-dialog-state
let returnFocus: HTMLElement | undefined

function openModal(element: HTMLDialogElement | undefined): void {
  if (!element || element.open) return
  // Some embedded WebViews return successfully from showModal() without reliably
  // placing the confirmation above their surrounding app sheet.
  element.classList.add('confirm-dialog__overlay--safety-layer')
  try {
    if (typeof element.showModal === 'function') {
      element.showModal()
      if (element.open) return
    }
  } catch {
    // Some embedded WebViews expose showModal but fail to enter the top layer.
  }
  element.classList.add('confirm-dialog__overlay--fallback')
  element.setAttribute('open', '')
}

// 危险操作默认聚焦取消，避免回车误确认；普通操作聚焦确认。
watch(
  activeDialog,
  async (dialog, previous) => {
    detailsOpen.value = false
    secretReady.value = false
    confirmationText.value = ''
    composing.value = false
    if (!dialog) {
      await nextTick()
      if (!activeDialog.value && returnFocus?.isConnected)
        returnFocus.focus({ preventScroll: true })
      returnFocus = undefined
      return
    }
    if (!previous)
      returnFocus =
        document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    await nextTick()
    openModal(modal.value)
    ;(dialog.danger ? cancelButton.value : confirmButton.value)?.focus({ preventScroll: true })
  },
  { immediate: true },
)

function handleKeydown(event: KeyboardEvent): void {
  if (!activeDialog.value) return
  if (event.key === 'Tab') {
    const buttons = Array.from(
      dialogPanel.value?.querySelectorAll<HTMLElement | SVGElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"], summary',
      ) ?? [],
    )
    const first = buttons[0]
    const last = buttons.at(-1)
    if (
      first &&
      last &&
      (!dialogPanel.value?.contains(document.activeElement) ||
        (event.shiftKey && document.activeElement === first) ||
        (!event.shiftKey && document.activeElement === last))
    ) {
      event.preventDefault()
      ;(event.shiftKey ? last : first).focus()
    }
    event.stopImmediatePropagation()
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopImmediatePropagation()
    cancelOrReturn()
  }
}
function cancelOrReturn(): void {
  if (detailsOpen.value) {
    tokenReview.value?.closeDetail()
    return
  }
  respond('cancel')
}

function respondWithHaptic(response: ConfirmDialogResponse): void {
  if (response === 'confirm' && !textReady.value) return
  if (response === 'confirm' && activeDialog.value?.secretUnlock && !secretReady.value) return
  if (response === 'confirm')
    triggerNativeHaptic(activeDialog.value?.danger ? 'warning' : 'confirm')
  respond(response, confirmationText.value)
}
function handleBack(event: Event): void {
  if (!activeDialog.value || !(event instanceof CustomEvent)) return
  const detail = event.detail as SrlBackRequestDetail
  detail.handled = true
  event.stopImmediatePropagation()
  cancelOrReturn()
}
onMounted(() => {
  window.addEventListener('keydown', handleKeydown, true)
  window.addEventListener(SRL_BACK_REQUEST_EVENT, handleBack, true)
})
onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown, true)
  window.removeEventListener(SRL_BACK_REQUEST_EVENT, handleBack, true)
  if (typeof modal.value?.close === 'function') modal.value.close()
})
</script>

<template>
  <Teleport to="body">
    <dialog
      v-if="activeDialog"
      ref="modal"
      class="confirm-dialog__overlay"
      :class="{ 'is-centered': activeDialog.centered }"
      @cancel.prevent="cancelOrReturn"
      @click.self="cancelOrReturn"
    >
      <section
        ref="dialogPanel"
        class="confirm-dialog"
        :class="{ 'confirm-dialog--typed': activeDialog.requiredText }"
        role="alertdialog"
        aria-modal="true"
        :aria-label="activeDialog.title"
      >
        <!-- SRL-PUBLIC-SYNC: BEGIN REPLACE id=assistant-token-review-dialog-content -->
        <span v-if="activeDialog.requiredText" class="confirm-dialog__warning"
          >最后一步 · 无法撤销</span
        >
        <h3 v-if="!detailsOpen">{{ activeDialog.title }}</h3>
        <TokenReview
          v-if="activeDialog.tokenReview"
          :key="activeDialog.id"
          ref="tokenReview"
          :review="activeDialog.tokenReview"
          @details="detailsOpen = $event"
        />
        <p v-else>{{ activeDialog.message }}</p>
        <label v-if="activeDialog.requiredText" class="confirm-dialog__typed">
          <span class="confirm-dialog__field-label">请手动输入以下确认句子</span>
          <span class="confirm-dialog__phrase">{{ activeDialog.requiredText }}</span>
          <textarea
            v-model="confirmationText"
            aria-label="手动输入确认句子"
            aria-describedby="confirm-dialog-typing-hint"
            placeholder="在此手动输入完整句子"
            rows="3"
            autocomplete="off"
            autocapitalize="off"
            :spellcheck="false"
            @paste.prevent
            @drop.prevent
            @compositionstart="composing = true"
            @compositionend="composing = false"
          />
          <small id="confirm-dialog-typing-hint"
            >需手动输入，不支持粘贴；标点、空格、大小写与全半角不影响确认。</small
          >
        </label>
        <SecretProtectionSettings
          v-if="activeDialog.secretUnlock"
          :key="activeDialog.id"
          unlock-only
          @ready="secretReady = true"
        />
        <!-- SRL-PUBLIC-SYNC: END REPLACE id=assistant-token-review-dialog-content -->
        <footer
          v-if="!detailsOpen"
          :class="{ 'confirm-dialog__choices': activeDialog.additionalLabel }"
        >
          <button ref="cancelButton" type="button" @click="respondWithHaptic('cancel')">
            {{ activeDialog.cancelLabel }}
          </button>
          <button
            v-if="activeDialog.alternativeLabel"
            type="button"
            @click="respondWithHaptic('alternative')"
          >
            {{ activeDialog.alternativeLabel }}
          </button>
          <button
            v-if="activeDialog.additionalLabel"
            type="button"
            @click="respondWithHaptic('additional')"
          >
            {{ activeDialog.additionalLabel }}
          </button>
          <button
            ref="confirmButton"
            type="button"
            class="confirm-dialog__confirm"
            :disabled="(activeDialog.secretUnlock && !secretReady) || !textReady"
            :class="{ 'confirm-dialog__confirm--danger': activeDialog.danger }"
            @click="respondWithHaptic('confirm')"
          >
            {{ activeDialog.confirmLabel }}
          </button>
        </footer>
      </section>
    </dialog>
  </Teleport>
</template>
