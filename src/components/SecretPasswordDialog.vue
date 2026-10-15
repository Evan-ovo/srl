<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import '../styles/ConfirmDialog.css'
import {
  secretPasswordRequest,
  resolveSecretPassword,
} from '../composables/UseSecretPasswordPrompt'
const password = ref('')
const error = ref('')
const modal = ref<HTMLDialogElement>()
onMounted(() => {
  const element = modal.value
  if (!element) return
  try {
    element.showModal()
    if (element.open) return
  } catch {
    /* Use the existing confirmation fallback on older WebViews. */
  }
  element.classList.add(
    'confirm-dialog__overlay--safety-layer',
    'confirm-dialog__overlay--fallback',
  )
  element.setAttribute('open', '')
})
function submit() {
  if (password.value.length < 8) {
    error.value = '密码至少需要 8 个字符'
    return
  }
  resolveSecretPassword(password.value)
}
onBeforeUnmount(() => {
  modal.value?.close?.()
  password.value = ''
  resolveSecretPassword()
})
</script>
<template>
  <Teleport to="body"
    ><dialog
      ref="modal"
      class="editor-overlay confirm-dialog__overlay"
      @cancel.prevent="resolveSecretPassword()"
      @click.self="resolveSecretPassword()"
    >
      <section class="editor-sheet" role="dialog" aria-modal="true" aria-label="密钥密码">
        <header class="editor-sheet__header">
          <h2>密钥密码</h2>
          <button class="editor-sheet__close" aria-label="取消" @click="resolveSecretPassword()">
            ×
          </button>
        </header>
        <form class="editor-form" @submit.prevent="submit">
          <p>{{ secretPasswordRequest?.message }}</p>
          <label class="field"
            ><span>密码</span
            ><input
              v-model="password"
              class="field__control"
              type="password"
              autocomplete="off"
              required
          /></label>
          <p v-if="error" role="alert">{{ error }}</p>
          <button class="button button--primary" type="submit">继续</button
          ><button class="button button--quiet" type="button" @click="resolveSecretPassword()">
            取消
          </button>
        </form>
      </section>
    </dialog></Teleport
  >
</template>
