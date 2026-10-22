<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { SRL_BACK_REQUEST_EVENT, type SrlBackRequestDetail } from '../composables/UseBackStack'

export interface ActionSheetAction {
  id: string
  label: string
  description?: string
  danger?: boolean
  disabled?: boolean
  selected?: boolean
}

const props = withDefaults(
  defineProps<{
    open: boolean
    title: string
    description?: string
    actions: readonly ActionSheetAction[]
    aboveTutorial?: boolean
    centered?: boolean
  }>(),
  { description: undefined, aboveTutorial: false, centered: false },
)

const emit = defineEmits<{
  'update:open': [value: boolean]
  select: [action: ActionSheetAction]
}>()

const panel = ref<HTMLElement>()
let returnFocus: HTMLElement | undefined

function close(): void {
  emit('update:open', false)
}

function select(action: ActionSheetAction): void {
  if (action.disabled) return
  emit('select', action)
  close()
}

function onKeydown(event: KeyboardEvent): void {
  if (!props.open) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopImmediatePropagation()
    close()
  } else if (event.key === 'Tab') {
    const controls = Array.from(
      panel.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
    )
    const first = controls[0]
    const last = controls.at(-1)
    if (
      first &&
      last &&
      (!panel.value?.contains(document.activeElement) ||
        (event.shiftKey && document.activeElement === first) ||
        (!event.shiftKey && document.activeElement === last))
    ) {
      event.preventDefault()
      ;(event.shiftKey ? last : first).focus()
    }
  }
}

function onBackRequest(event: Event): void {
  if (!props.open) return
  const detail = (event as CustomEvent<SrlBackRequestDetail>).detail
  if (detail.handled) return
  detail.handled = true
  event.stopImmediatePropagation()
  close()
}

watch(
  () => props.open,
  (open) => {
    document.documentElement.classList.toggle('srl-action-sheet-open', open)
    if (open) {
      returnFocus =
        document.activeElement instanceof HTMLElement ? document.activeElement : undefined
      void nextTick(() => panel.value?.focus({ preventScroll: true }))
    } else {
      void nextTick(() => {
        if (
          returnFocus?.isConnected &&
          (document.activeElement === document.body ||
            panel.value?.contains(document.activeElement))
        )
          returnFocus.focus({ preventScroll: true })
        returnFocus = undefined
      })
    }
  },
  { immediate: true },
)

window.addEventListener('keydown', onKeydown, true)
window.addEventListener(SRL_BACK_REQUEST_EVENT, onBackRequest, true)
onBeforeUnmount(() => {
  document.documentElement.classList.remove('srl-action-sheet-open')
  window.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener(SRL_BACK_REQUEST_EVENT, onBackRequest, true)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="action-sheet">
      <div
        v-if="open"
        class="action-sheet"
        :class="{
          'action-sheet--tutorial-help': aboveTutorial,
          'action-sheet--centered': centered,
        }"
        role="presentation"
      >
        <div class="action-sheet__backdrop" aria-hidden="true" @click="close" />
        <section
          ref="panel"
          class="action-sheet__panel"
          role="dialog"
          aria-modal="true"
          :aria-label="title"
          tabindex="-1"
        >
          <header>
            <div>
              <h2>{{ title }}</h2>
              <p v-if="description">{{ description }}</p>
            </div>
            <button type="button" aria-label="关闭操作面板" @click="close">×</button>
          </header>
          <div class="action-sheet__actions">
            <button
              v-for="action in actions"
              :key="action.id"
              type="button"
              :class="{
                'action-sheet__action--danger': action.danger,
                'action-sheet__action--selected': action.selected,
              }"
              :disabled="action.disabled"
              :aria-pressed="action.selected"
              @click="select(action)"
            >
              <strong
                >{{ action.label }}<span v-if="action.selected" aria-hidden="true">✓</span></strong
              >
              <small v-if="action.description">{{ action.description }}</small>
            </button>
          </div>
          <slot />
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.action-sheet {
  position: fixed;
  z-index: 1200;
  inset: var(--visual-viewport-offset-top, 0px) 0 auto;
  height: var(--app-viewport-height, 100dvh);
  display: grid;
  align-items: end;
  padding: max(1rem, var(--safe-top)) max(1rem, var(--safe-right)) 0 max(1rem, var(--safe-left));
  isolation: isolate;
}

.action-sheet__backdrop {
  position: fixed;
  z-index: 0;
  inset: 0;
  background: var(--overlay-background);
  backdrop-filter: blur(4px);
}
.action-sheet--tutorial-help {
  z-index: 1240;
}
.action-sheet--centered {
  align-items: center;
  padding-bottom: max(1rem, var(--safe-bottom));
}
.action-sheet--centered .action-sheet__panel {
  padding-bottom: 0;
  border-radius: var(--dialog-radius, var(--glass-radius-panel));
}

.action-sheet__panel {
  position: relative;
  z-index: 1;
  width: min(100%, 34rem);
  max-height: min(78dvh, 42rem, 100%);
  margin: 0 auto;
  overflow: auto;
  padding-bottom: var(--safe-bottom);
  border-radius: var(--dialog-radius, var(--glass-radius-panel))
    var(--dialog-radius, var(--glass-radius-panel)) 0 0;
}

.action-sheet header {
  display: flex;
  gap: 1rem;
  align-items: start;
  justify-content: space-between;
  padding: 1rem 1rem 0.75rem;
}

.action-sheet h2,
.action-sheet p {
  margin: 0;
}

.action-sheet p {
  margin-top: 0.25rem;
  color: var(--color-ink-soft);
}

.action-sheet header > button {
  min-width: 2.75rem;
  min-height: 2.75rem;
  border: 0;
  background: var(--button-background, transparent);
  font-size: 1.5rem;
}

.action-sheet__actions {
  display: grid;
  gap: 0.5rem;
  padding: 0 0.75rem 0.75rem;
}

.action-sheet__actions > button {
  display: grid;
  min-height: 3.25rem;
  padding: 0.7rem 0.85rem;
  text-align: left;
}

.action-sheet__actions small {
  margin-top: 0.15rem;
  color: var(--color-ink-soft);
}

.action-sheet__actions strong {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.75rem;
  overflow-wrap: anywhere;
}
.action-sheet__actions > .action-sheet__action--selected {
  border-color: var(--selection-border, var(--color-accent));
  background: var(--selection-background, var(--color-accent-soft, var(--color-surface-raised)));
  color: var(--selection-color, var(--color-ink));
}

.action-sheet__actions > .action-sheet__action--danger {
  color: var(--color-danger);
}

.action-sheet-enter-active,
.action-sheet-leave-active {
  transition: opacity 160ms ease;
}

.action-sheet-enter-from,
.action-sheet-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .action-sheet-enter-active,
  .action-sheet-leave-active {
    transition-duration: 0.01ms;
  }
}

@media (min-width: 768px) {
  .action-sheet {
    align-items: center;
    padding-bottom: max(1rem, var(--safe-bottom));
  }

  .action-sheet__panel {
    padding-bottom: 0;
    border-radius: var(--dialog-radius, var(--glass-radius-panel));
  }
}
</style>
