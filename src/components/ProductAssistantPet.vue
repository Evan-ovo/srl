<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { createAsyncPanel } from '../core/AsyncPanel'
import { getAssistantNavigationTargets } from '../core/FeatureAppRegistry'
import { getAssistantVisibleScope } from '../core/ProductAssistantViewContext'
import { productAssistantWorkspaceService as workspace } from '../core/AppContainer'
import { useProductAssistantPreferences } from '../composables/UseProductAssistantPreferences'
import { captureAssistantPage } from '../services/ProductAssistantScreenshot'
import { confirmAction } from '../composables/UseConfirmDialog'
import {
  downloadAssistantPetAssets,
  loadAssistantPetAssets,
  releaseAssistantPetAssets,
  type AssistantPetAssetFile,
  type AssistantPetAssets,
} from '../services/ProductAssistantPetAssets'
import { assistantPetCue, type AssistantPetExpression } from '../core/ProductAssistantPetState'
import { assistantGuidanceAnchor } from '../core/ProductAssistantGuidance'
import { assistantHelpContext, visibleAssistantHelpContext } from '../core/ProductAssistantGuidance'
import {
  hasDiscordSetupBrowser,
  nativeDiscordSetupBrowser,
  discordSetupSession,
} from '../services/NativeDiscordSetupBrowser'
import { renderAssistantPetFrame } from '../services/ProductAssistantPetFrame'
import DiscordSetupHelp from './DiscordSetupHelp.vue'
import type { FeatureHubProps } from '../composables/UseFeatureHub'

const props = defineProps<
  Pick<
    FeatureHubProps,
    | 'theme'
    | 'layoutMode'
    | 'mobileCardOrientation'
    | 'mobileCardFitMode'
    | 'resourceCardHeightMode'
    | 'noImageResourceCoverMode'
    | 'uiFontScale'
    | 'customCss'
  > & {
    assistantBusy?: boolean
    navigate: (id: string, guide?: string) => Promise<void>
    hidden?: boolean
  }
>()
const emit = defineEmits<{
  activity: [value: boolean]
  'save-assistant-css': [value: string]
}>()
const AppearanceStudio = createAsyncPanel('蒜惹菈', () => import('./AppearanceStudio.vue'))
const preferences = useProductAssistantPreferences()
const button = ref<HTMLButtonElement>()
const bubble = ref<HTMLButtonElement>()
const dialog = ref<HTMLDialogElement>()
const open = ref(false)
const expanded = ref(false)
const visited = ref(false)
const held = ref(false)
const busy = ref(false)
const reducedMotion = ref(false)
const pageHidden = ref(document.hidden)
const expression = ref<AssistantPetExpression>()
const speech = ref('')
const travelling = ref(false)
const helpQuestion = ref(false)
const helpMenuOpen = ref(false)
const helpAvailable = computed(
  () => hasDiscordSetupBrowser() && assistantHelpContext.value === 'discord-bridge',
)
const petVisible = computed(() => !props.hidden || discordSetupSession.active)
const assistanceLayer = computed(() => helpAvailable.value || discordSetupSession.active)
const portal = shallowRef<HTMLElement | string>('body')
const idleSteps = [
  { pose: 'idle', duration: 10000 },
  { pose: 'walk', duration: 16000 },
  { pose: 'idle', duration: 8000 },
  { pose: 'sleep', duration: 20000 },
] as const
const idleStep = ref(0)
const pose = computed(() =>
  held.value
    ? 'lifted'
    : travelling.value
      ? 'walk'
      : expression.value && preferences.value.aiPetExpressions
        ? expression.value
        : props.assistantBusy || busy.value
          ? 'thinking'
          : open.value || speech.value
            ? 'chat'
            : idleSteps[idleStep.value]!.pose,
)
const canWander = computed(
  () =>
    !held.value &&
    !open.value &&
    !props.assistantBusy &&
    !busy.value &&
    !expression.value &&
    !speech.value &&
    !assistantGuidanceAnchor.value &&
    !reducedMotion.value &&
    !pageHidden.value &&
    !helpQuestion.value &&
    !discordSetupSession.active &&
    preferences.value.petWalkingAnimation !== false,
)
const running = computed(
  () =>
    pose.value === 'walk' &&
    preferences.value.petWalkingAnimation !== false &&
    !reducedMotion.value &&
    !pageHidden.value,
)
let idleTimer: ReturnType<typeof setTimeout> | undefined
let motionQuery: MediaQueryList | undefined
let alive = true
let cueTimer: ReturnType<typeof setTimeout> | undefined
function clearCue() {
  if (cueTimer) clearTimeout(cueTimer)
  cueTimer = undefined
  expression.value = undefined
  speech.value = ''
}
function say(text: string, pose?: AssistantPetExpression) {
  clearCue()
  expression.value = pose
  speech.value = text
  cueTimer = setTimeout(clearCue, 8000)
}
watch(assistantPetCue, (cue) => {
  if (!cue || pageHidden.value) return
  if (cue.expression && !preferences.value.aiPetExpressions) return
  if (assistantGuidanceAnchor.value) guideSpeech = cue.text
  say(cue.text, cue.expression)
})
watch(
  () => preferences.value.aiPetExpressions,
  (allowed) => {
    if (!allowed) clearCue()
  },
)
function stopIdle() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = undefined
}
function scheduleIdle() {
  if (!canWander.value) return
  idleTimer = setTimeout(() => {
    idleStep.value = (idleStep.value + 1) % idleSteps.length
    scheduleIdle()
  }, idleSteps[idleStep.value]!.duration)
}
watch(
  canWander,
  () => {
    stopIdle()
    idleStep.value = 0
    scheduleIdle()
  },
  { flush: 'sync' },
)
function syncMotion() {
  reducedMotion.value = motionQuery?.matches ?? false
  if (reducedMotion.value) travelling.value = false
}
function syncVisibility() {
  pageHidden.value = document.hidden
  if (pageHidden.value) {
    clearCue()
    travelling.value = false
  }
}
const position = ref({ x: 8, y: 100 })
const viewport = ref({ width: innerWidth, height: innerHeight })
const lookAllowed = computed(() => preferences.value.allowScreenshots !== false)
const error = ref('')
const petAssets = shallowRef<AssistantPetAssets>({})
const petAssetFile = computed<AssistantPetAssetFile>(() =>
  pose.value === 'idle' ? 'assistant-pet.png' : `assistant-pet-${pose.value}.png`,
)
const petImage = computed(() => petAssets.value[petAssetFile.value] || '')
const petRunStyle = computed(() => ({
  backgroundImage: petAssets.value['assistant-pet-run.png']
    ? `url("${petAssets.value['assistant-pet-run.png']}")`
    : undefined,
}))
let assetLoadId = 0
function installPetAssets(value: AssistantPetAssets) {
  releaseAssistantPetAssets(petAssets.value)
  petAssets.value = value
}
async function refreshPetAssets() {
  const id = ++assetLoadId
  try {
    const loaded = await loadAssistantPetAssets()
    if (!alive || id !== assetLoadId) {
      if (loaded) releaseAssistantPetAssets(loaded)
      return
    }
    installPetAssets(loaded ?? {})
  } catch {
    installPetAssets({})
  }
}
async function savePetAssetMode(mode: 'images' | 'svg') {
  await workspace.savePreferences({ ...workspace.preferences(), petAssetMode: mode })
}
async function initializePetAssets() {
  if (preferences.value.petAssetMode === 'svg') return
  await refreshPetAssets()
  if (!alive || Object.keys(petAssets.value).length) return
  // A pet mounted for a browser task uses local SVG while pictures are absent;
  // asset-download consent must not be hidden behind the native browser.
  if (discordSetupSession.active) return
  const accepted = await confirmAction({
    title: '蒜惹菈桌宠图片还没下载',
    message: '配套图片约 3.5 MiB。下载后可使用动态表情；清除图片后会改用轻量 SVG 悬浮球。',
    confirmLabel: '下载桌宠图片',
    cancelLabel: '先用 SVG 悬浮球',
  })
  if (!alive) return
  if (!accepted) {
    try {
      await savePetAssetMode('svg')
    } catch {
      error.value = '桌宠偏好保存失败'
    }
    return
  }
  try {
    say('正在下载我的桌宠图片，马上好哦～')
    await downloadAssistantPetAssets()
    if (alive) {
      await refreshPetAssets()
      await savePetAssetMode('images')
      clearCue()
    }
  } catch {
    if (alive) {
      try {
        await savePetAssetMode('svg')
      } catch {
        // Keep the SVG fallback even if the preference write is unavailable.
      }
      say('图片没下载成功，我先用小圆球陪你；可以在设置里重试。')
    }
  }
}
watch(
  () => preferences.value.petAssetMode,
  (mode) => {
    if (mode === 'svg') {
      assetLoadId++
      releaseAssistantPetAssets(petAssets.value)
      petAssets.value = {}
    }
  },
)
function refreshPetAssetsAfterDownload() {
  void refreshPetAssets()
}
let press:
  | { id: number; x: number; y: number; originX: number; originY: number; dragged: boolean }
  | undefined
let suppressClick = false
let lastTap = 0
let helpTapCount = 0
let helpTapStarted = 0
let guideSpeech = ''
const style = computed(() => ({
  left: `${position.value.x}px`,
  top: `${position.value.y}px`,
  '--pet-walk-range': `${Math.max(0, Math.min(48, position.value.x - 8))}px`,
  '--pet-travel-duration': `${travelDuration.value}ms`,
}))
const travelDuration = ref(0)
const bubbleBelow = computed(() => position.value.y < 88)
const bubbleStyle = computed(() => {
  const left = Math.max(8, Math.min(position.value.x + 44 - 95, viewport.value.width - 198))
  return {
    left: `${left}px`,
    top: `${bubbleBelow.value ? position.value.y + 96 : position.value.y - 8}px`,
    '--pet-tail-x': `${Math.max(18, Math.min(172, position.value.x + 44 - left))}px`,
  }
})
const dialogSize = ref({ width: 300, height: 340 })
const dialogPosition = ref({ x: 8, y: 8 })
const dialogAbove = ref(true)
let dialogBottom = innerHeight
const dialogStyle = computed(() =>
  expanded.value
    ? {
        left: '0px',
        top: '0px',
        width: `${viewport.value.width}px`,
        height: `${viewport.value.height}px`,
      }
    : {
        left: `${dialogPosition.value.x}px`,
        top: `${dialogPosition.value.y}px`,
        width: `${dialogSize.value.width}px`,
        height: `${dialogSize.value.height}px`,
      },
)
let resizing: { id: number; x: number; y: number; width: number; height: number } | undefined
function fitDialog() {
  const navigation = document.querySelector<HTMLElement>('.mobile-bottom-nav')
  const navigationTop = navigation?.getClientRects().length
    ? navigation.getBoundingClientRect().top
    : viewport.value.height
  dialogBottom = Math.min(viewport.value.height, navigationTop)
  dialogSize.value.width = Math.min(dialogSize.value.width, viewport.value.width - 16)
  dialogSize.value.height = Math.min(dialogSize.value.height, dialogBottom - 16)
  dialogPosition.value.x = Math.max(
    8,
    Math.min(dialogPosition.value.x, viewport.value.width - dialogSize.value.width - 8),
  )
  dialogPosition.value.y = Math.max(
    8,
    Math.min(dialogPosition.value.y, dialogBottom - dialogSize.value.height - 8),
  )
}
function placeDialog() {
  fitDialog()
  const above = position.value.y - 16
  const below = dialogBottom - position.value.y - 104
  dialogAbove.value = above >= below
  dialogSize.value.height = Math.min(dialogSize.value.height, Math.max(above, below))
  dialogPosition.value = {
    x: position.value.x + 44 - dialogSize.value.width / 2,
    y: dialogAbove.value ? position.value.y - dialogSize.value.height - 8 : position.value.y + 96,
  }
  fitDialog()
}
function resizeBy(width: number, height: number) {
  const maxWidth = viewport.value.width - dialogPosition.value.x - 8
  const maxHeight = dialogAbove.value
    ? position.value.y - 16
    : dialogBottom - position.value.y - 104
  dialogSize.value = {
    width: Math.max(Math.min(240, maxWidth), Math.min(width, maxWidth)),
    height: Math.max(Math.min(240, maxHeight), Math.min(height, maxHeight)),
  }
  placeDialog()
}
function startResize(event: PointerEvent) {
  if (event.button !== 0) return
  resizing = { id: event.pointerId, x: event.clientX, y: event.clientY, ...dialogSize.value }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}
function moveResize(event: PointerEvent) {
  if (!resizing || event.pointerId !== resizing.id) return
  resizeBy(
    resizing.width + event.clientX - resizing.x,
    resizing.height + (dialogAbove.value ? resizing.y - event.clientY : event.clientY - resizing.y),
  )
}
function endResize(event: PointerEvent) {
  if (resizing?.id !== event.pointerId) return
  const handle = event.currentTarget as HTMLElement
  if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId)
  resizing = undefined
  placeDialog()
}
function resizeWithKeyboard(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
  event.preventDefault()
  resizeBy(
    dialogSize.value.width +
      (event.key === 'ArrowLeft' ? -10 : event.key === 'ArrowRight' ? 10 : 0),
    dialogSize.value.height + (event.key === 'ArrowUp' ? -10 : event.key === 'ArrowDown' ? 10 : 0),
  )
}
function clamp() {
  viewport.value = { width: innerWidth, height: innerHeight }
  position.value.x = Math.max(8, Math.min(position.value.x, innerWidth - 96))
  position.value.y = Math.max(8, Math.min(position.value.y, innerHeight - 154))
  placeDialog()
}
function arrive(event?: TransitionEvent) {
  if (event && event.propertyName !== 'left' && event.propertyName !== 'top') return
  travelling.value = false
  if (guideSpeech) say(guideSpeech)
  guideSpeech = ''
}
async function goToFeature() {
  const anchor = assistantGuidanceAnchor.value
  if (!anchor) {
    clearCue()
    portal.value = 'body'
    travelling.value = false
    guideSpeech = ''
    return
  }
  close()
  clearCue()
  portal.value = anchor.element.closest<HTMLElement>('dialog[open]') ?? 'body'
  await nextTick()
  if (!alive || assistantGuidanceAnchor.value !== anchor || !anchor.element.isConnected) return
  guideSpeech = anchor.text
  say(guideSpeech)
  await nextTick()
  if (!alive || assistantGuidanceAnchor.value !== anchor || !anchor.element.isConnected) return
  const bubbleHeight = bubble.value?.getBoundingClientRect().height || 76
  const target = anchor.element.getBoundingClientRect()
  // Place beside the actual control; use the nearest available side rather
  // than putting the pet over its clickable area.
  const choices = [
    { x: target.right + 8, y: target.top },
    { x: target.left - 96, y: target.top },
    { x: target.right - 88, y: target.bottom + 8 },
    { x: target.right - 88, y: target.top - 96 },
    ...Array.from({ length: Math.ceil(innerHeight / 88) }, (_, index) => ({
      x: Math.max(8, Math.min(target.right - 88, innerWidth - 96)),
      y: target.bottom + 8 + index * 88,
    })),
  ]
  const controls = Array.from(
    document.querySelectorAll<HTMLElement>(
      'button,input,select,textarea,a[href],[contenteditable="true"]',
    ),
  )
    .filter(
      (element) =>
        element.getClientRects().length &&
        !element.closest('.assistant-pet,.assistant-pet-bubble,.assistant-pet-dialog'),
    )
    .map((element) => element.getBoundingClientRect())
  const next = choices.find(({ x, y }) => {
    if (x < 8 || x > innerWidth - 96 || y < 88 || y > innerHeight - 154) return false
    const bubbleX = Math.max(8, Math.min(x + 44 - 95, innerWidth - 198))
    const areas = [
      { left: x, right: x + 88, top: y, bottom: y + 88 },
      { left: bubbleX, right: bubbleX + 190, top: y - bubbleHeight - 8, bottom: y - 8 },
    ]
    return !controls.some((rect) =>
      areas.some(
        (area) =>
          area.left < rect.right &&
          area.right > rect.left &&
          area.top < rect.bottom &&
          area.bottom > rect.top,
      ),
    )
  })
  if (!next) {
    say('这里哦，按钮亮起来啦～')
    return
  }
  const distance = Math.hypot(position.value.x - next.x, position.value.y - next.y)
  travelDuration.value =
    reducedMotion.value || pageHidden.value || preferences.value.petWalkingAnimation === false
      ? 0
      : Math.min(1400, Math.max(400, distance * 2))
  travelling.value = travelDuration.value > 0 && distance > 1
  position.value = next
  clamp()
  if (!travelling.value) arrive()
}
watch(assistantGuidanceAnchor, () => void goToFeature())
onMounted(() => {
  void initializePetAssets()
  window.addEventListener('srl:assistant-pet-assets-updated', refreshPetAssetsAfterDownload)
  window.addEventListener('srl:discord-setup-quick-chat', openTaskChat)
  const saved = preferences.value.petPosition
  position.value = saved
    ? { x: saved.x * Math.max(1, innerWidth - 96), y: saved.y * Math.max(1, innerHeight - 154) }
    : { x: innerWidth - 104, y: innerHeight - 220 }
  clamp()
  motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  syncMotion()
  scheduleIdle()
  motionQuery.addEventListener('change', syncMotion)
  document.addEventListener('visibilitychange', syncVisibility)
  window.addEventListener('resize', clamp)
})
async function showChat() {
  if (held.value) return
  clearCue()
  visited.value = true
  placeDialog()
  open.value = true
  await nextTick()
  dialog.value?.show()
}
function openTaskChat() {
  if (!discordSetupSession.active || !discordSetupSession.assistantConversationId) return
  expanded.value = false
  void showChat()
}
function down(event: PointerEvent) {
  if (event.button !== 0) return
  const bounds = button.value!.getBoundingClientRect()
  position.value = { x: bounds.left, y: bounds.top }
  held.value = true
  travelling.value = false
  guideSpeech = ''
  suppressClick = false
  press = {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    originX: bounds.left,
    originY: bounds.top,
    dragged: false,
  }
  button.value?.setPointerCapture(event.pointerId)
}
function move(event: PointerEvent) {
  if (!press || press.id !== event.pointerId) return
  const x = event.clientX - press.x
  const y = event.clientY - press.y
  if (!press.dragged && Math.hypot(x, y) < 8) return
  press.dragged = true
  position.value = { x: press.originX + x, y: press.originY + y }
  clamp()
}
async function up(event: PointerEvent) {
  if (!press || press.id !== event.pointerId) return
  const dragged = press.dragged
  if (dragged) {
    lastTap = 0
    helpTapCount = 0
  }
  suppressClick ||= dragged
  press = undefined
  held.value = false
  if (button.value?.hasPointerCapture(event.pointerId))
    button.value.releasePointerCapture(event.pointerId)
  if (dragged) {
    try {
      await workspace.savePreferences({
        ...workspace.preferences(),
        petPosition: {
          x: position.value.x / Math.max(1, innerWidth - 96),
          y: position.value.y / Math.max(1, innerHeight - 154),
        },
      })
    } catch {
      error.value = '桌宠位置未保存'
    }
  }
}
function click(event: MouseEvent) {
  if (suppressClick) {
    suppressClick = false
    return
  }
  // Touch browsers do not consistently produce dblclick. Count two genuine
  // taps here; keyboard activation remains a single accessible operation.
  const now = performance.now()
  if (
    event.detail !== 0 &&
    helpAvailable.value &&
    visibleAssistantHelpContext() === 'discord-bridge'
  ) {
    if (!helpTapStarted || now - helpTapStarted > 900) {
      helpTapStarted = now
      helpTapCount = 0
    }
    lastTap = 0
    if (++helpTapCount === 3) {
      helpTapCount = 0
      helpTapStarted = 0
      close()
      clearCue()
      helpQuestion.value = true
    }
    return
  }
  if (event.detail === 0 || (lastTap && now - lastTap < 350)) {
    lastTap = 0
    void showChat()
  } else {
    lastTap = now
    say('我在呢～')
  }
}
function answerHelp(accepted: boolean) {
  helpQuestion.value = false
  if (accepted) helpMenuOpen.value = true
}
watch(assistantHelpContext, () => {
  helpTapCount = 0
  helpTapStarted = 0
  helpQuestion.value = false
  helpMenuOpen.value = false
})
let petFrameVersion = 0
watch(
  [button, petImage, pose, helpAvailable, () => discordSetupSession.active],
  async () => {
    if (!hasDiscordSetupBrowser() || (!helpAvailable.value && !discordSetupSession.active)) return
    const version = ++petFrameVersion
    await nextTick()
    if (!button.value) return
    try {
      const dataUrl = await renderAssistantPetFrame(button.value)
      if (dataUrl && alive && version === petFrameVersion)
        await nativeDiscordSetupBrowser.pet({ dataUrl })
    } catch {
      /* Keep the existing pet and the native window's visible fallback. */
    }
  },
  { flush: 'post', immediate: true },
)
function close() {
  resizing = undefined
  expanded.value = false
  dialog.value?.close()
  open.value = false
}
watch(
  () => discordSetupSession.browserVisible,
  (visible) => {
    if (visible) close()
  },
)
function assistantActivity(value: boolean) {
  busy.value = value
  emit('activity', value)
  if (value) clearCue()
}
watch(
  () => props.hidden,
  (hidden) => {
    if (hidden) close()
  },
)
function expand() {
  expanded.value = true
}
function backFromChat() {
  if (expanded.value) expanded.value = false
  else close()
}
async function navigateFromPet(id: string, guide?: string) {
  if (guide) await props.navigate(id, guide)
  else await props.navigate(id)
}
function contextScope() {
  return getAssistantVisibleScope()
}
async function capture(signal: AbortSignal) {
  const scope = contextScope()
  if (!lookAllowed.value || !scope) throw new Error('当前界面无法截图')
  return captureAssistantPage(scope, signal, true)
}
onBeforeUnmount(() => {
  alive = false
  assetLoadId++
  releaseAssistantPetAssets(petAssets.value)
  petAssets.value = {}
  stopIdle()
  clearCue()
  motionQuery?.removeEventListener('change', syncMotion)
  document.removeEventListener('visibilitychange', syncVisibility)
  window.removeEventListener('srl:assistant-pet-assets-updated', refreshPetAssetsAfterDownload)
  window.removeEventListener('srl:discord-setup-quick-chat', openTaskChat)
  dialog.value?.close()
  window.removeEventListener('resize', clamp)
})
</script>

<template>
  <Teleport :to="portal">
    <button
      v-show="petVisible"
      ref="button"
      class="assistant-pet"
      :class="{
        'assistant-pet--walk': pose === 'walk' && canWander,
        'assistant-pet--travelling': travelling,
        'assistant-pet--assistance': assistanceLayer,
      }"
      :data-pose="pose"
      :style="style"
      type="button"
      :aria-label="`${preferences.name}快捷对话`"
      @pointerdown="down"
      @pointermove="move"
      @pointerup="up"
      @pointercancel="up"
      @click="click"
      @transitionend="arrive"
      @contextmenu.prevent="showChat"
    >
      <span
        v-if="running && petAssets['assistant-pet-run.png']"
        class="assistant-pet-run"
        :style="petRunStyle"
        aria-hidden="true"
      />
      <img v-else-if="petImage" :src="petImage" alt="" draggable="false" />
      <svg
        v-else
        class="assistant-pet-orb"
        viewBox="0 0 88 88"
        role="img"
        :aria-label="`${preferences.name}桌宠悬浮球`"
      >
        <defs>
          <linearGradient id="assistant-pet-orb-fill" x1="12" y1="10" x2="76" y2="78">
            <stop stop-color="#eaf8ff" />
            <stop offset="1" stop-color="#9ad8e7" />
          </linearGradient>
        </defs>
        <path
          d="M17 35 19 17q1-7 8-2l10 8q7-2 14 0l10-8q7-5 8 2l2 18q8 11 2 25-8 18-29 18T15 60q-6-14 2-25Z"
          fill="url(#assistant-pet-orb-fill)"
          stroke="#267a89"
          stroke-width="3"
          stroke-linejoin="round"
        />
        <path d="m24 22 2 12 9-8m29-4-2 12-9-8" fill="none" stroke="#74b9ca" stroke-width="2" />
        <ellipse cx="32" cy="47" rx="2.7" ry="3.5" fill="#245c6a" />
        <ellipse cx="56" cy="47" rx="2.7" ry="3.5" fill="#245c6a" />
        <path
          d="M41 54q3 4 6 0m-12 5q9 10 18 0"
          fill="none"
          stroke="#245c6a"
          stroke-width="2.6"
          stroke-linecap="round"
        />
        <circle cx="23" cy="55" r="3.5" fill="#ef9db6" opacity=".8" />
        <circle cx="65" cy="55" r="3.5" fill="#ef9db6" opacity=".8" />
      </svg>
    </button>
    <div
      v-if="helpQuestion && petVisible && !pageHidden"
      class="assistant-pet-bubble assistant-pet-bubble--assistance assistant-pet-help-question"
      :class="{ 'assistant-pet-bubble--below': bubbleBelow }"
      :style="bubbleStyle"
      role="group"
      aria-label="需要我的帮助嘛？"
    >
      <span>需要我的帮助嘛？</span>
      <div>
        <button type="button" @click="answerHelp(true)">是</button
        ><button type="button" @click="answerHelp(false)">不是</button>
      </div>
    </div>
    <button
      v-else-if="speech && petVisible && !pageHidden && !travelling"
      ref="bubble"
      class="assistant-pet-bubble"
      :class="{
        'assistant-pet-bubble--below': bubbleBelow,
        'assistant-pet-bubble--assistance': assistanceLayer,
      }"
      :style="bubbleStyle"
      type="button"
      aria-label="打开详细对话"
      @click="showChat"
    >
      <span role="status">{{ speech }}</span>
    </button>
    <dialog
      v-if="visited"
      ref="dialog"
      class="assistant-pet-dialog"
      :class="{
        'assistant-pet-dialog--above': dialogAbove && !expanded,
        'assistant-pet-dialog--expanded': expanded,
      }"
      :style="dialogStyle"
      aria-label="蒜惹菈快捷对话"
      @cancel.prevent="close"
      @keydown.esc.stop.prevent="close"
    >
      <AppearanceStudio
        v-bind="props"
        assistant-only
        :compact="!expanded"
        :active="open"
        :navigation-targets="getAssistantNavigationTargets(true)"
        :navigate="navigateFromPet"
        :context-scope="contextScope"
        :capture-reference="lookAllowed ? capture : undefined"
        @back="backFromChat"
        @expand="expand"
        @assistant-activity="assistantActivity"
        @save-assistant-css="emit('save-assistant-css', $event)"
      />
      <p v-if="error" class="chat-error" role="alert">{{ error }}</p>
      <button
        v-if="!expanded"
        class="assistant-pet-resize"
        type="button"
        aria-label="调整快捷对话大小"
        title="拖动调整大小，方向键也可调整"
        @pointerdown.stop.prevent="startResize"
        @pointermove.stop.prevent="moveResize"
        @pointerup.stop="endResize"
        @pointercancel.stop="endResize"
        @keydown="resizeWithKeyboard"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
          <path d="m5 13 8-8m-3 8 3-3" />
        </svg>
      </button>
    </dialog>
    <DiscordSetupHelp v-model:open="helpMenuOpen" />
  </Teleport>
</template>

<style src="../styles/ProductAssistantPet.css"></style>
