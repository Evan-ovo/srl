<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { BrowserStorageService } from '../services/BrowserStorageService'
import { compileAppearancePreset } from '../core/AppearanceScopes'
import { createProtectedHost } from '../core/AppearanceSafety'
import { confirmViewScripts } from '../composables/UseCustomUiViews'
import { useConfirmDialogState } from '../composables/UseConfirmDialog'
import { SRL_BACK_REQUEST_EVENT, type SrlBackRequestDetail } from '../composables/UseBackStack'
import type { CustomUiViews, UiApplyOptions } from '../types/UiCustomization'
import recoveryCss from '../styles/RecoveryControls.css?inline'
import compactControlsCss from '../styles/AppearanceOriginalCssActions.css?inline'
import foundationCss from '../styles/Foundation.css?inline'
import glassCss from '../styles/GlassRefinement.css?inline'

const props = defineProps<{ views: CustomUiViews }>()
const emit = defineEmits<{
  close: []
  'save-css': [css: string, options: UiApplyOptions]
}>()
const storage = new BrowserStorageService()
const presets = ref(storage.getCustomUiPresets())
const selected = ref(storage.getActiveCustomUiPresetId() || presets.value[0]?.id || '')
const enabled = computed(() => Object.values(props.views).some((view) => view?.enabled))
const busy = ref(false)
const error = ref('')
const portal = shallowRef<ShadowRoot>()
const dialog = ref<HTMLDialogElement>()
const { activeDialog } = useConfirmDialogState()
const lifetime = new AbortController()
let host: HTMLElement | undefined

function close() {
  lifetime.abort()
  dialog.value?.close()
  emit('close')
}
function apply(css: string, options: UiApplyOptions) {
  // Leave the native top layer before the existing 15-second trial controls appear.
  close()
  emit('save-css', css, options)
}
async function switchPreset() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const library = storage.getCustomUiPresets()
    const preset = library.find((item) => item.id === selected.value)
    if (!preset) {
      presets.value = library
      error.value = '预设已不存在，请重新选择'
      return
    }
    const allowed = await confirmViewScripts(preset.views, lifetime.signal)
    if (!allowed || lifetime.signal.aborted) return
    apply(compileAppearancePreset(preset), { presetId: preset.id, views: preset.views ?? {} })
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '预设切换失败'
  } finally {
    busy.value = false
  }
}
function recover(mode: 'vue' | 'default') {
  if (!busy.value) apply('', { recovery: mode })
}
function back(event: Event) {
  if (activeDialog.value || !dialog.value?.open || !(event instanceof CustomEvent)) return
  const detail = event.detail as SrlBackRequestDetail
  detail.handled = true
  event.stopImmediatePropagation()
  close()
}
onMounted(async () => {
  const layer = createProtectedHost('srl-appearance-quick-menu')
  host = layer.host
  // The protected host resets ordinary inherited properties; native controls still follow theme.
  host.style.setProperty('color-scheme', 'inherit', 'important')
  portal.value = layer.root
  await nextTick()
  if (lifetime.signal.aborted) return
  dialog.value?.showModal()
  window.addEventListener(SRL_BACK_REQUEST_EVENT, back, true)
})
onBeforeUnmount(() => {
  lifetime.abort()
  window.removeEventListener(SRL_BACK_REQUEST_EVENT, back, true)
  dialog.value?.close()
  host?.remove()
})
</script>

<template>
  <Teleport v-if="portal" :to="portal">
    <component :is="'style'">{{
      foundationCss + glassCss + recoveryCss + compactControlsCss
    }}</component>
    <dialog
      ref="dialog"
      class="appearance-quick-menu"
      data-srl-controls
      data-srl-dialog
      aria-label="外观快捷切换"
      @cancel.prevent="close"
    >
      <header>
        <h2>外观</h2>
        <button
          type="button"
          class="feature-header-action"
          aria-label="关闭外观快捷切换"
          @click="close"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg>
        </button>
      </header>
      <div class="appearance-quick-menu__preset">
        <select
          v-model="selected"
          class="field__control"
          aria-label="切换预设"
          :disabled="busy || !presets.length"
        >
          <option v-if="!presets.length" value="">预设库暂无预设</option>
          <option v-else value="" disabled>选择预设库中的预设</option>
          <option v-for="preset in presets" :key="preset.id" :value="preset.id">
            {{ preset.name }}
          </option>
        </select>
        <button
          type="button"
          class="appearance-action-hit button--primary"
          aria-label="应用此预设"
          data-apply-preset
          :disabled="busy || !selected"
          @click="switchPreset"
        >
          <span class="appearance-action-face">应用</span>
        </button>
      </div>
      <footer>
        <button
          type="button"
          class="appearance-action-hit"
          :disabled="busy || !enabled"
          @click="recover('vue')"
        >
          <span class="appearance-action-face">关闭 Vue</span>
        </button>
        <button
          type="button"
          class="appearance-action-hit"
          :disabled="busy"
          @click="recover('default')"
        >
          <span class="appearance-action-face">恢复默认预设</span>
        </button>
      </footer>
      <p v-if="error" role="alert">{{ error }}</p>
    </dialog>
  </Teleport>
</template>
