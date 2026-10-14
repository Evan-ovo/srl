<script setup lang="ts">
import previewSampleCss from '../styles/AppearancePreview.css?inline'
// SRL-PUBLIC-SYNC: BEGIN REPLACE id=appearance-vue-lifecycle-imports
import { computed, onMounted, ref, watch } from 'vue'
// SRL-PUBLIC-SYNC: END REPLACE id=appearance-vue-lifecycle-imports
import { nextTick, onBeforeUnmount } from 'vue'
import {
  appearanceScopes,
  compileAppearancePreset,
  parseAppearancePreset,
  type AppearanceScope,
} from '../core/AppearanceScopes'
// SRL-PUBLIC-SYNC: BEGIN PUBLIC-ONLY id=appearance-official-scope-import
import { isOfficialAppId } from '../types/OfficialApp'
// SRL-PUBLIC-SYNC: END PUBLIC-ONLY id=appearance-official-scope-import
import { createAsyncPanel } from '../core/AsyncPanel'
import { validateAssistantCss } from '../services/ProductAssistantService'
import type {
  AssistantContext,
  AssistantReply,
  AssistantRequest,
  AssistantExecution,
  AssistantNavigationTarget,
} from '../services/ProductAssistantService'
import { appearanceTransaction } from '../core/AppearanceSafety'
import { isSafeModeActive } from '../core/SafeStartup'
import { ASSISTANT_FEATURE_GUIDES } from '../core/ProductAssistantKnowledge'
import { getAssistantVisibleScope } from '../core/ProductAssistantViewContext'
import { captureAssistantPage } from '../services/ProductAssistantScreenshot'
import { captureAssistantComparison } from '../services/ProductAssistantAppearanceComparison'
import {
  inspectAssistantAppearance,
  verifyAssistantAppearance,
} from '../services/ProductAssistantAppearanceInspection'

import { confirmAction } from '../composables/UseConfirmDialog'
import { usePreviewBudget } from '../composables/UsePreviewBudget'
import { usePreviewPolicy } from '../composables/UsePreviewPolicy'
import FeatureAppHeader from './FeatureAppHeader.vue'
import AppearanceOriginalCssActions from './AppearanceOriginalCssActions.vue'
import AppearanceUiEditor from './AppearanceUiEditor.vue'
import AppearanceCodeReference from './AppearanceCodeReference.vue'
import { normalizeUiViews } from '../core/UiCustomization'
import { readUiViewPreviewCss } from '../core/UiViewPreview'
import {
  useAssistantUiCustomization,
  snapshotUiViews,
} from '../composables/UseAssistantUiCustomization'
import type { CustomUiViews, UiApplyOptions } from '../types/UiCustomization'
import {
  BrowserStorageService,
  CABINET_COLUMN_OPTIONS,
  type CabinetColumns,
  type CustomCssPreset,
  type CustomCssScope,
  type LayoutMode,
  type MobileCardOrientation,
  type MobileCardFitMode,
  type ResourceCardHeightMode,
  type NoImageResourceCoverMode,
  type UiFontScale,
} from '../services/BrowserStorageService'
import { downloadBlob } from '../utils/LibraryFormatting'
import { sanitizeCssForPreview } from '../utils/PreviewSafety'
import { runAssistantPageScript } from '../services/ProductAssistantScript'

const props = withDefaults(
  defineProps<{
    theme: 'light' | 'dark'
    layoutMode: LayoutMode
    mobileCardOrientation?: MobileCardOrientation
    mobileCardFitMode?: MobileCardFitMode
    resourceCardHeightMode?: ResourceCardHeightMode
    noImageResourceCoverMode?: NoImageResourceCoverMode
    uiFontScale: UiFontScale
    customCss: string
    assistantOnly?: boolean
    navigationTargets?: AssistantNavigationTarget[]
    navigate?: (id: string, guide?: string) => Promise<void>
    compact?: boolean
    active?: boolean
    backgroundTask?: boolean
    contextScope?: () => AppearanceScope | undefined
    captureReference?: (
      signal: AbortSignal,
    ) => Promise<import('../services/ProductAssistantService').AssistantImage>
  }>(),
  {
    mobileCardOrientation: 'mixed',
    mobileCardFitMode: 'contain',
    resourceCardHeightMode: 'natural',
    noImageResourceCoverMode: 'cover',
    navigationTargets: undefined,
    navigate: undefined,
    contextScope: undefined,
    captureReference: undefined,
    active: true,
  },
)
const emit = defineEmits<{
  back: []
  expand: []
  'update:theme': [value: 'light' | 'dark']
  'update:layoutMode': [value: LayoutMode]
  'update:mobileCardOrientation': [value: MobileCardOrientation]
  'update:mobileCardFitMode': [value: MobileCardFitMode]
  'update:resourceCardHeightMode': [value: ResourceCardHeightMode]
  'update:noImageResourceCoverMode': [value: NoImageResourceCoverMode]
  'update:uiFontScale': [value: UiFontScale]
  'save-css': [value: string, options?: UiApplyOptions]
  'save-assistant-css': [value: string, options?: UiApplyOptions]
  'assistant-visibility': [value: boolean]
  'assistant-activity': [value: boolean]
}>()

const storage = new BrowserStorageService()
// SRL-PUBLIC-SYNC: BEGIN REPLACE id=appearance-assistant-layout-state
const ProductAssistant = createAsyncPanel('AI 助手', () => import('./OfficialAssistantGate.vue'))
const AssistantUiPreview = createAsyncPanel('Vue预览', () => import('./AssistantUiPreview.vue'))
const assistantOpen = ref(Boolean(props.assistantOnly))
const assistantVisited = ref(assistantOpen.value)
watch(
  assistantOpen,
  (open) => {
    if (open) assistantVisited.value = true
    emit('assistant-visibility', open)
  },
  { immediate: true },
)
onBeforeUnmount(() => emit('assistant-visibility', false))
// SRL-PUBLIC-SYNC: END REPLACE id=appearance-assistant-layout-state
const previewPolicy = usePreviewPolicy()
const copyStatus = ref('')
const isPreviewOpen = ref(false)
const previewHost = ref<HTMLElement>()
const { previewEnabled } = usePreviewBudget('appearance-preview', isPreviewOpen, previewHost)
const importInput = ref<HTMLInputElement>()
const cabinetColumns = ref<CabinetColumns>(storage.getCabinetColumns())
const isCardOrientationDialogOpen = ref(false)

const cabinetDensities: Array<{
  value: CabinetColumns
  title: string
  description: string
}> = [
  { value: 2, title: '舒展', description: '每页 6 个' },
  { value: 3, title: '均衡', description: '每页 9 个' },
  { value: 4, title: '标准', description: '每页 12 个' },
]

const fontScales: Array<{ value: UiFontScale; title: string }> = [
  { value: 'small', title: '紧凑' },
  { value: 'standard', title: '标准' },
  { value: 'large', title: '放大' },
]

const layouts: Array<{
  value: LayoutMode
  eyebrow: string
  title: string
  description: string
  cells: number
}> = [
  {
    value: 'grid',
    eyebrow: 'BROWSE',
    title: '卡片浏览',
    description: '突出角色封面与视觉识别，适合慢慢翻看收藏。',
    cells: 6,
  },
  {
    value: 'list',
    eyebrow: 'SCAN',
    title: '紧凑列表',
    description: '同屏查看更多名称、类型与归档信息，适合快速查找。',
    cells: 5,
  },
  {
    value: 'split',
    eyebrow: 'MANAGE',
    title: '分栏管理',
    description: '桌面端同时查看资源列表与详情，适合集中整理。',
    cells: 7,
  },
]

const cardOrientations: Array<{
  value: MobileCardOrientation
  title: string
  description: string
}> = [
  { value: 'portrait', title: '全部竖版', description: '封面统一为 2:3' },
  { value: 'landscape', title: '全部横版', description: '封面统一为 3:2' },
  { value: 'mixed', title: '混合比例', description: '角色卡竖版，其它资源横版' },
]

const cardFitModes: Array<{
  value: MobileCardFitMode
  title: string
  description: string
}> = [
  { value: 'contain', title: '完整显示', description: '图片完整保留，空白处留边' },
  { value: 'cover', title: '填满预览框', description: '空白处铺满，边缘可能被裁切' },
]

const cardHeightModes: Array<{
  value: ResourceCardHeightMode
  title: string
  description: string
}> = [
  { value: 'natural', title: '各自高度', description: '保留当前紧凑显示' },
  {
    value: 'uniform',
    title: '统一按最长内容',
    description: '按当前页最长内容等高；名称、文件名、作者、简介、分类和标签完整显示',
  },
  {
    value: 'fixed',
    title: '统一按固定长度',
    description: '有封面按设定长度；无封面至少竖版 14rem、横版 12rem，内容多时延长以免裁字',
  },
]

const noImageResourceCoverModes: Array<{
  value: NoImageResourceCoverMode
  title: string
  description: string
}> = [
  {
    value: 'cover',
    title: '全部资源固定占位封面',
    description: '所有无图资源都保留封面区域和所选比例',
  },
  {
    value: 'character-only',
    title: '仅角色卡固定占位封面',
    description: '无图角色卡保留封面，其它无图资源紧凑显示',
  },
  { value: 'compact', title: '全部紧凑显示', description: '无图资源不显示占位封面，节省列表空间' },
]

const scopes = appearanceScopes()

function selectCabinetColumns(value: CabinetColumns): void {
  if (!CABINET_COLUMN_OPTIONS.includes(value)) return
  cabinetColumns.value = storage.setCabinetColumns(value)
}

function selectLayout(value: LayoutMode): void {
  emit('update:layoutMode', value)
  if (value === 'grid') isCardOrientationDialogOpen.value = true
}

function selectCardOrientation(value: MobileCardOrientation): void {
  emit('update:mobileCardOrientation', value)
}

function createPreset(name = '我的样式', css = ''): CustomCssPreset {
  const now = new Date().toISOString()
  return {
    id: crypto.randomUUID(),
    name,
    globalCss: css,
    scopedCss: {},
    createdAt: now,
    updatedAt: now,
  }
}

function clonePreset(value: CustomCssPreset): CustomCssPreset {
  return {
    ...value,
    scopedCss: { ...(value.scopedCss ?? {}) },
    ...(value.views ? { views: normalizeUiViews(value.views) } : {}),
  }
}

const storedPresets = storage.getCustomUiPresets()
const activeStoredId = storage.getActiveCustomUiPresetId()
const initialPreset =
  storedPresets.find((item) => item.id === activeStoredId) ??
  storedPresets[0] ??
  createPreset('我的样式', props.customCss)
const presets = ref(storedPresets)
const activePresetId = ref(initialPreset.id)
const draft = ref(clonePreset(initialPreset))
const activeScope = ref<CustomCssScope>('library')
const previewCss = ref(props.customCss)

const activeScopedCss = computed({
  get: () => draft.value.scopedCss[activeScope.value] ?? '',
  set: (value: string) => {
    draft.value.scopedCss[activeScope.value] = value
  },
})
// SRL-PUBLIC-SYNC: BEGIN REPLACE id=appearance-official-scope-availability
const installedIds = ref(new Set<string>())
const installationsLoaded = ref(false)
const installationError = ref('')
async function refreshInstalledIds(): Promise<void> {
  installationsLoaded.value = false
  installationError.value = ''
  try {
    const { officialAppService } = await import('../core/OfficialAppRuntime')
    installedIds.value = new Set((await officialAppService.list()).map((app) => app.id))
    installationsLoaded.value = true
  } catch {
    installationError.value = '暂时无法读取安装状态；已有样式仍保留。'
  }
}
onMounted(() => void refreshInstalledIds())
watch(
  () => props.active,
  (active, previous) => {
    if (active && previous === false) void refreshInstalledIds()
  },
)
function available(scope: AppearanceScope): boolean {
  return !scope.appId || !isOfficialAppId(scope.appId) || installedIds.value.has(scope.appId)
}
// SRL-PUBLIC-SYNC: END REPLACE id=appearance-official-scope-availability
const activeScopes = computed(() => scopes.filter(available))
const inactiveScopes = computed<AppearanceScope[]>(() => [
  ...scopes.filter((scope) => !available(scope)),
  ...Object.keys(draft.value.scopedCss ?? {})
    .filter((key) => !scopes.some((scope) => scope.value === key))
    .map((key) => ({
      value: key as CustomCssScope,
      title: `未识别界面（${key}）`,
      selector: '',
      hint: '保留数据供未来版本恢复；当前不应用',
    })),
])
const selectedScope = computed(() =>
  [...activeScopes.value, ...inactiveScopes.value].find(
    (scope) => scope.value === activeScope.value,
  ),
)
const savedDraft = computed(() => presets.value.find((item) => item.id === draft.value.id))
const hasUnsavedChanges = computed(() => {
  const saved = savedDraft.value
  if (!saved) return true
  return (
    saved.name !== draft.value.name ||
    saved.globalCss !== draft.value.globalCss ||
    JSON.stringify(saved.scopedCss ?? {}) !== JSON.stringify(draft.value.scopedCss ?? {}) ||
    JSON.stringify(saved.views ?? {}) !== JSON.stringify(draft.value.views ?? {})
  )
})
const presetState = computed(() => {
  if (!savedDraft.value) return '未保存'
  if (hasUnsavedChanges.value) return '待保存'
  return '已保存'
})
const hasCssContent = computed(
  () =>
    Boolean(draft.value.globalCss.trim()) ||
    Object.values(draft.value.scopedCss ?? {}).some((value) => Boolean(value?.trim())) ||
    Object.keys(draft.value.views ?? {}).length > 0,
)

const compilePreset = compileAppearancePreset

function flash(message: string): void {
  copyStatus.value = message
  window.setTimeout(() => {
    if (copyStatus.value === message) copyStatus.value = ''
  }, 2600)
}

async function selectPreset(event: Event): Promise<void> {
  const select = event.target as HTMLSelectElement
  const id = select.value
  if (
    hasUnsavedChanges.value &&
    hasCssContent.value &&
    !(await confirmAction({
      title: '切换预设',
      message: '当前 CSS 还有未保存修改。放弃修改并切换预设？',
      confirmLabel: '放弃并切换',
      danger: true,
    }))
  ) {
    select.value = activePresetId.value
    return
  }
  const selected = presets.value.find((item) => item.id === id)
  if (!selected) return
  if (!(await confirmViewScripts(selected.views))) {
    select.value = activePresetId.value
    return
  }
  activePresetId.value = id
  draft.value = clonePreset(selected)
  storage.setActiveCustomUiPresetId(id)
  applyPreset(selected, compilePreset(selected))
  flash(`已切换到「${selected.name}」`)
}

async function newPreset(): Promise<void> {
  if (presets.value.length >= 30) {
    flash('最多保存 30 个预设，请先删除不用的样式')
    return
  }
  if (
    hasUnsavedChanges.value &&
    hasCssContent.value &&
    !(await confirmAction({
      title: '新建预设',
      message: '当前 CSS 还有未保存修改。放弃修改并新建预设？',
      confirmLabel: '放弃并新建',
      danger: true,
    }))
  ) {
    return
  }
  const next = createPreset(`新样式 ${presets.value.length + 1}`)
  activePresetId.value = next.id
  draft.value = next
  flash('已新建草稿，保存后才会加入预设库')
}

function saveAsNewPreset(): void {
  if (presets.value.length >= 30) {
    flash('最多保存 30 个预设，请先删除不用的样式')
    return
  }
  const now = new Date().toISOString()
  draft.value = {
    ...clonePreset(draft.value),
    id: crypto.randomUUID(),
    name: `${draft.value.name.trim() || '未命名样式'} 副本`,
    createdAt: now,
    updatedAt: now,
  }
  activePresetId.value = draft.value.id
  savePreset()
}

// SRL-PUBLIC-SYNC: BEGIN REPLACE id=appearance-preset-persistence
function persistPreset(candidate: CustomCssPreset, apply = true): boolean {
  const cleanName = candidate.name.trim() || '未命名样式'
  const saved = {
    ...clonePreset(candidate),
    name: cleanName,
    updatedAt: new Date().toISOString(),
  }
  const index = presets.value.findIndex((item) => item.id === saved.id)
  if (index < 0 && presets.value.length >= 30) {
    flash('最多保存 30 个预设，请先删除不用的样式')
    return false
  }
  const next = [...presets.value]
  if (index >= 0) next[index] = saved
  else next.push(saved)
  storage.setCustomUiPresets(next)
  const stored = storage.getCustomUiPresets().find((item) => item.id === saved.id)
  if (!stored || JSON.stringify(stored) !== JSON.stringify(saved)) {
    flash('预设未保存成功，请检查本机存储空间；草稿仍保留')
    return false
  }
  presets.value = next
  activePresetId.value = saved.id
  draft.value = clonePreset(saved)
  storage.setActiveCustomUiPresetId(saved.id)
  if (apply) applyPreset(saved, compilePreset(saved))
  flash(`「${saved.name}」已保存${apply ? '，请确认保留试用样式' : ''}`)
  return true
}

async function confirmViewScripts(views?: CustomUiViews, signal?: AbortSignal): Promise<boolean> {
  const enabled = Object.entries(views ?? {}).filter(([, view]) => view?.enabled)
  if (!enabled.length) return true
  const current = storage.getCustomUiViews()
  if (
    enabled.every(
      ([key, view]) => JSON.stringify(current[key as CustomCssScope]) === JSON.stringify(view),
    )
  )
    return true
  return confirmAction(
    {
      title: '应用自定义界面',
      message: `将运行 ${enabled.length} 个界面的自定义源码。脚本可读取这些页面当前显示的非敏感内容，并调用原有界面操作；不提供数据库或凭据访问。${previewPolicy.value.allowRemoteResources ? '已允许 HTTPS 网络，源码可以发送它读取的界面内容。' : '网络访问关闭。'}可在保护提示中撤销，或点“恢复原界面”。`,
      confirmLabel: '运行并试用',
      danger: true,
    },
    signal,
  )
}
function applyPreset(preset: CustomCssPreset, css: string) {
  if (preset.views || Object.keys(storage.getCustomUiViews()).length)
    emit('save-css', css, { views: preset.views ?? {} })
  else emit('save-css', css)
}
async function savePreset(): Promise<void> {
  if (await confirmViewScripts(draft.value.views)) persistPreset(draft.value)
}
// SRL-PUBLIC-SYNC: END REPLACE id=appearance-preset-persistence
function getAssistantContext(): AssistantContext {
  const visible = props.contextScope ? props.contextScope() : getAssistantVisibleScope()
  return {
    presetId: draft.value.id,
    comparisonId: assistantUndo.value?.comparisonId,
    appliedCss: storage.getCustomUiCss(),
    globalCss: draft.value.globalCss,
    scopes: activeScopes.value.map((scope) => ({ ...scope })),
    css: Object.fromEntries(
      activeScopes.value.map((scope) => [scope.value, draft.value.scopedCss[scope.value] ?? '']),
    ),
    uiViews: snapshotUiViews(draft.value.views),
    canCustomizeVue: true,
    currentScope: visible?.value ?? (props.assistantOnly ? '' : activeScope.value),
    pageContext: visible ? { title: visible.title, scope: visible.value } : undefined,
    canCaptureCurrent: Boolean(visible),
    mountedScopes: activeScopes.value
      .filter((scope) => document.querySelector(scope.selector))
      .map((scope) => scope.value),
    navigationTargets: props.navigationTargets,
  }
}
async function captureCurrentReference(signal: AbortSignal) {
  if (props.captureReference) return props.captureReference(signal)
  const visible = getAssistantVisibleScope()
  if (!visible) throw new Error('当前界面无法截图，请先打开要查看的界面')
  return captureAssistantPage(visible, signal, true)
}
const assistantUndo = ref<{
  draft: CustomCssPreset
  before: string
  after: string
  comparisonId?: string
  beforeViews?: CustomUiViews
  afterViews?: CustomUiViews
  draftOnly?: boolean
  draftAfter?: CustomCssPreset
}>()
const vueTools = useAssistantUiCustomization({
  draft: () => clonePreset(draft.value),
  scopes: () => activeScopes.value,
  css: () => storage.getCustomUiCss(),
  previewCss: () => readUiViewPreviewCss(previewPolicy.value.allowRemoteResources),
  remote: () => previewPolicy.value.allowRemoteResources,
  theme: () => props.theme,
  active: () => props.active,
  write: (previous, next) => {
    if (JSON.stringify(previous) !== JSON.stringify(draft.value))
      throw new Error('编译期间草稿已变化，未覆盖其它修改')
    assistantUndo.value = {
      draft: previous,
      draftAfter: clonePreset(next),
      draftOnly: true,
      before: storage.getCustomUiCss(),
      after: storage.getCustomUiCss(),
    }
    draft.value = next
  },
  apply: applyAssistantVue,
})
async function applyAssistantVue(
  scope: AppearanceScope,
  revision: string,
  request: AssistantRequest,
  signal: AbortSignal,
): Promise<AssistantExecution> {
  if (appearanceTransaction.hasPendingViewTrial())
    throw new Error('请先保留或恢复当前Vue试用，再应用下一次修改')
  if (request.appliedCss !== storage.getCustomUiCss())
    throw new Error('应用CSS已变化，请重新读取；未覆盖其它修改')
  if (
    request.uiViews !== undefined &&
    JSON.stringify(request.uiViews) !== JSON.stringify(draft.value.views ?? {})
  )
    throw new Error('Vue草稿已变化，请重新读取')
  const current = draft.value.views?.[scope.value]
  if (!current) throw new Error('请先写入Vue草稿')
  const view = { ...current, enabled: true }
  const beforeViews = storage.getCustomUiViews()
  const nextViews = normalizeUiViews({ ...beforeViews, [scope.value]: view })
  if (JSON.stringify(nextViews) === JSON.stringify(beforeViews))
    return {
      text: '该版本Vue已应用',
      data: { revision, applied: true, reused: true, trial: false },
    }
  if (!(await confirmViewScripts({ [scope.value]: view }, signal)))
    return { text: '已取消Vue试用，源码草稿保留', ok: false, cancelled: true }
  if (signal.aborted) throw new DOMException('已停止', 'AbortError')
  const candidate = clonePreset(draft.value)
  candidate.views = { ...candidate.views, [scope.value]: view }
  const previous = {
    draft:
      assistantUndo.value?.draftOnly &&
      JSON.stringify(assistantUndo.value.draftAfter) === JSON.stringify(draft.value)
        ? clonePreset(assistantUndo.value.draft)
        : clonePreset(draft.value),
    before: request.appliedCss,
    after: request.appliedCss,
    beforeViews,
    afterViews: nextViews,
  }
  // The native preview must leave the top layer before showing the protected live trial.
  vueTools.dismiss()
  await nextTick()
  const comparison = await captureAssistantComparison(scope, signal, async () => {
    if (signal.aborted) throw new DOMException('已停止', 'AbortError')
    if (
      (await vueTools.revision(scope.value)) !== revision ||
      storage.getCustomUiCss() !== previous.before ||
      JSON.stringify(storage.getCustomUiViews()) !== JSON.stringify(beforeViews)
    )
      throw new Error('确认或截图期间外观已变化，未覆盖其它修改')
    if (signal.aborted) throw new DOMException('已停止', 'AbortError')
    emit('save-assistant-css', previous.after, { views: nextViews })
    if (
      storage.getCustomUiCss() !== previous.after ||
      JSON.stringify(storage.getCustomUiViews()) !== JSON.stringify(nextViews)
    )
      throw new Error('Vue试用未能应用，草稿保留')
    assistantUndo.value = previous
    draft.value = candidate
    await nextTick()
  })
  if (assistantUndo.value) assistantUndo.value.comparisonId = comparison.id
  if (JSON.stringify(storage.getCustomUiViews()) !== JSON.stringify(nextViews))
    return {
      text: 'Vue试用已恢复，源码草稿保留',
      ok: false,
      cancelled: true,
      data: { revision: await vueTools.revision(scope.value), applied: false },
    }
  return {
    text: `已启用${scope.title}的Vue试用；请在保护提示中保留，不确认会自动恢复。`,
    status: 'Vue正在试用',
    comparison,
    data: {
      revision: await vueTools.revision(scope.value),
      applied: true,
      trial: true,
      businessTested: false,
      visualReviewed: false,
    },
  }
}
function saveAssistantPreset(): string {
  const isExistingPreset = presets.value.some((item) => item.id === draft.value.id)
  if (!persistPreset(clonePreset(draft.value), false)) throw new Error(copyStatus.value)
  return isExistingPreset
    ? `已更新当前预设「${draft.value.name}」。`
    : `已保存当前预设「${draft.value.name}」。`
}

function saveAssistantPresetAsNew(name: string): string {
  const candidate = clonePreset(draft.value)
  candidate.id = crypto.randomUUID()
  candidate.name = name.trim().slice(0, 80) || 'AI 美化'
  candidate.createdAt = new Date().toISOString()
  if (!persistPreset(candidate, false)) throw new Error(copyStatus.value)
  return `已另存为新预设「${candidate.name}」。原预设仍保留。`
}
async function executeAssistantReply(
  reply: AssistantReply,
  request: AssistantRequest,
  signal: AbortSignal,
): Promise<AssistantExecution> {
  if (signal.aborted) throw new DOMException('已停止', 'AbortError')
  if (reply.action === 'vue') return vueTools.execute(reply, request, signal)
  if (reply.action === 'browser') throw new Error('通用网页协助由主聊天执行器处理')
  if (reply.action === 'run-page-script') {
    if (!request.canRunPageScripts)
      throw new Error('页面脚本权限已关闭，请在小助手设置中开启后再运行。')
    const result = await runAssistantPageScript(reply.code, signal)
    return {
      text: reply.answer,
      status: '页面脚本已运行',
      data: result === undefined ? { completed: true } : { result },
    }
  }
  if (reply.action === 'answer') return { text: reply.answer }
  if (reply.action === 'keep-comparison' || reply.action === 'undo-comparison') {
    if (!assistantUndo.value || assistantUndo.value.comparisonId !== reply.id)
      throw new Error('这次美化已不是当前可撤销的修改')
    if (storage.getCustomUiCss() !== assistantUndo.value.after)
      throw new Error('样式已被其它操作修改，未覆盖新的修改')
    if (
      assistantUndo.value.afterViews &&
      JSON.stringify(storage.getCustomUiViews()) !== JSON.stringify(assistantUndo.value.afterViews)
    )
      throw new Error('Vue试用已恢复或被其它操作修改，不能保留旧版本')
    if (reply.action === 'undo-comparison')
      return executeAssistantReply({ action: 'undo', answer: '撤销美化' }, request, signal)
    appearanceTransaction.keep()
    return { text: '已保留当前美化。', status: '已保留美化' }
  }
  if (
    reply.action === 'app' ||
    reply.action === 'task-skills' ||
    reply.action === 'resource-references' ||
    reply.action === 'online' ||
    reply.action === 'discord-setup' ||
    reply.action === 'custom-tools' ||
    reply.action === 'navigate' ||
    reply.action === 'view-current-ui' ||
    reply.action === 'remember-preference' ||
    reply.action === 'pet-expression'
  )
    throw new Error('APP 和自定义工具由聊天中的扩展服务处理')
  if (reply.action === 'diagnose') {
    const guide = ASSISTANT_FEATURE_GUIDES.find((item) => item.id === reply.feature)
    if (!guide) throw new Error('未知功能；不能诊断登录或认证')
    const context = getAssistantContext()
    const style = document.getElementById('srl-custom-ui-style') as HTMLStyleElement | null
    const applied = storage.getCustomUiCss()
    const scoped = draft.value.scopedCss[activeScope.value] ?? ''
    const data: Record<string, unknown> = {
      readOnly: true,
      scope: guide.scope
        ? {
            value: guide.scope,
            available: context.scopes.some((item) => item.value === guide.scope),
            mounted: context.mountedScopes?.includes(guide.scope) ?? false,
          }
        : undefined,
      appInstallation: {
        state: installationsLoaded.value
          ? 'checked'
          : installationError.value
            ? 'failed'
            : 'loading',
        availableRegions: context.scopes.map(({ value, title, appId }) => ({
          value,
          title,
          appId,
        })),
        unavailableRegions: scopes
          .filter((scope) => !available(scope))
          .map(({ value, title }) => ({ value, title })),
      },
      notChecked: [
        '资源原件、资源查询条件、远端网络和凭据未读取',
        '源码、错误堆栈和实体设备未检查',
      ],
    }
    if (guide.id === 'appearance') {
      data.appearance = {
        safeMode: isSafeModeActive(),
        selectedScope: activeScope.value,
        selectedScopeAvailable: context.scopes.some((item) => item.value === activeScope.value),
        selectedScopeMounted: context.mountedScopes?.includes(activeScope.value) ?? false,
        hasScopedDraft: Boolean(scoped.trim()),
        hasGlobalDraft: Boolean(draft.value.globalCss.trim()),
        hasAppliedCss: Boolean(applied.trim()),
        draftMatchesApplied: compilePreset(draft.value) === applied,
        hasUnsavedChanges: hasUnsavedChanges.value,
        draftSaved: Boolean(savedDraft.value),
        styleElementPresent: Boolean(style),
        styleHasCss: Boolean(style?.textContent?.trim()),
        styleDisabled: style?.sheet?.disabled ?? style?.disabled ?? false,
        presetCount: presets.value.length,
      }
      data.notChecked = [
        '未验证每个 CSS 选择器是否匹配或视觉效果正确',
        '未挂载区域的截图和实体设备未检查',
      ]
    }
    return { text: `已只读检查${guide.title}`, data }
  }
  if (reply.action === 'presets') {
    return {
      text: '已读取预设列表',
      data: {
        presets: storage.getCustomUiPresets().map((item) => ({
          id: item.id,
          name: item.name,
          scopes: Object.keys(item.scopedCss).filter((key) =>
            Boolean(item.scopedCss[key as CustomCssScope]?.trim()),
          ),
        })),
      },
    }
  }
  if (reply.action === 'undo') {
    if (
      request.presetId !== draft.value.id ||
      JSON.stringify(request.css) !== JSON.stringify(getAssistantContext().css) ||
      (request.globalCss !== undefined && request.globalCss !== draft.value.globalCss)
    )
      throw new Error('CSS 草稿已变化，未覆盖手动修改')
    const previous = assistantUndo.value
    if (!previous) throw new Error('当前对话没有可撤销的美化修改')
    const applied = storage.getCustomUiCss()
    if (applied !== previous.after && applied !== previous.before)
      throw new Error('应用样式已被其它操作修改，未覆盖新的修改')
    if (
      request.uiViews !== undefined &&
      JSON.stringify(request.uiViews) !== JSON.stringify(draft.value.views ?? {})
    )
      throw new Error('Vue草稿已变化，未覆盖手动修改')
    const views = JSON.stringify(storage.getCustomUiViews())
    if (
      previous.beforeViews &&
      views !== JSON.stringify(previous.beforeViews) &&
      views !== JSON.stringify(previous.afterViews)
    )
      throw new Error('Vue已被其它操作修改，未覆盖新的修改')
    if (previous.draftOnly && JSON.stringify(previous.draftAfter) !== JSON.stringify(draft.value))
      throw new Error('草稿已被其它操作修改，未覆盖新的修改')
    const needsRuntimeUndo =
      !previous.draftOnly &&
      applied === previous.after &&
      (!previous.afterViews || views === JSON.stringify(previous.afterViews))
    if (needsRuntimeUndo && !appearanceTransaction.undo())
      throw new Error('回退记录已失效，请在外观中选择原预设')
    draft.value = clonePreset(previous.draft)
    activePresetId.value = draft.value.id
    storage.setActiveCustomUiPresetId(
      presets.value.some((item) => item.id === draft.value.id) ? draft.value.id : '',
    )
    assistantUndo.value = undefined
    return {
      text: '已撤销刚才的美化，恢复修改前的样式。已保存的预设仍保留。',
      status: '已撤销美化',
    }
  }
  if (request.presetId !== draft.value.id) throw new Error('当前预设已经变化，请重新说明需求')
  if (
    ['style', 'global-style', 'save', 'save-as-new', 'apply-preset'].includes(reply.action) &&
    appearanceTransaction.hasPendingViewTrial()
  )
    throw new Error('请先在保护提示中保留或恢复Vue试用，再继续修改或保存')
  if (request.globalCss !== undefined && request.globalCss !== draft.value.globalCss)
    throw new Error('全局 CSS 草稿已变化，未覆盖手动修改')
  if (
    (reply.action === 'style' ||
      reply.action === 'global-style' ||
      reply.action === 'save' ||
      reply.action === 'save-as-new' ||
      reply.action === 'apply-preset') &&
    request.appliedCss !== storage.getCustomUiCss()
  )
    throw new Error('应用样式已被其它操作修改，未覆盖新的修改；请重新发送需求')
  if (reply.action === 'save' || reply.action === 'save-as-new') {
    if (
      request.uiViews !== undefined &&
      JSON.stringify(request.uiViews) !== JSON.stringify(draft.value.views ?? {})
    )
      throw new Error('Vue草稿已变化，未保存未经本轮读取的修改')
    if (JSON.stringify(request.css) !== JSON.stringify(getAssistantContext().css))
      throw new Error('CSS 草稿已变化，未保存未经本轮确认的修改')
    const text =
      reply.action === 'save' ? saveAssistantPreset() : saveAssistantPresetAsNew(reply.name)
    return { text, status: text }
  }
  if (reply.action === 'global-style') {
    if (request.globalCss !== draft.value.globalCss)
      throw new Error('全局 CSS 草稿已变化，未覆盖手动修改；请重新发送需求')
    const scope = activeScopes.value.find((item) => item.value === request.currentScope)
    if (!scope) throw new Error('请先打开一个可识别的界面，再应用全局样式以便对比效果')
    const candidate = clonePreset(draft.value)
    candidate.globalCss = reply.css === '' ? '' : validateAssistantCss(reply.css, { global: true })
    const compiled = compilePreset(candidate)
    const previous = {
      draft: clonePreset(draft.value),
      before: storage.getCustomUiCss(),
      after: compiled,
      beforeViews: storage.getCustomUiViews(),
      afterViews: storage.getCustomUiViews(),
    }
    const comparison = await captureAssistantComparison(scope, signal, async () => {
      if (
        storage.getCustomUiCss() !== previous.before ||
        draft.value.globalCss !== request.globalCss
      )
        throw new Error('截图期间样式已变化，未覆盖新的修改')
      if (compiled !== previous.before) {
        emit('save-assistant-css', compiled)
        if (storage.getCustomUiCss() !== compiled)
          throw new Error('样式未能应用，请检查本机存储或安全模式；草稿未覆盖')
        assistantUndo.value = previous
      }
      draft.value = candidate
      await nextTick()
    })
    if (compiled !== previous.before && assistantUndo.value)
      assistantUndo.value.comparisonId = comparison.id
    return {
      text: reply.answer,
      status: '已应用到全局样式',
      comparison,
      data: {
        verification: verifyAssistantAppearance(scope, props.theme, reply.css, true),
        comparison: {
          id: comparison.id,
          beforeCaptured: Boolean(comparison.before),
          afterCaptured: Boolean(comparison.after),
          captureError: comparison.captureError,
        },
      },
    }
  }
  const scope = activeScopes.value.find((item) => item.value === reply.scope)
  if (!scope) throw new Error('该界面当前不可用，请先安装对应 APP')
  if (reply.action === 'inspect') {
    return { text: `已检查${scope.title}`, data: inspectAssistantAppearance(scope, props.theme) }
  }
  if (reply.action === 'apply-preset') {
    const preset = storage.getCustomUiPresets().find((item) => item.id === reply.id)
    if (!preset) throw new Error('预设不存在，请重新读取列表')
    const css = preset.scopedCss[scope.value]
    if (typeof css !== 'string' || !css.trim())
      throw new Error('该预设没有所选区域的局部样式；全局样式不会被 AI 套用')
    return executeAssistantReply(
      {
        action: 'style',
        scope: scope.value,
        css: validateAssistantCss(css),
        answer: `已套用「${preset.name}」的${scope.title}样式。`,
      },
      request,
      signal,
    )
  }
  const text = reply.answer
  let status: string | undefined
  if (reply.action === 'style') {
    if ((request.css[scope.value] ?? '') !== (draft.value.scopedCss[scope.value] ?? ''))
      throw new Error('CSS 草稿已变化，未覆盖手动修改；请重新发送需求')
    const candidate = clonePreset(draft.value)
    candidate.scopedCss[scope.value] = reply.css === '' ? '' : validateAssistantCss(reply.css)
    const compiled = compilePreset(candidate)
    const previous = {
      draft: clonePreset(draft.value),
      before: storage.getCustomUiCss(),
      after: compiled,
      beforeViews: storage.getCustomUiViews(),
      afterViews: storage.getCustomUiViews(),
    }
    const comparison = await captureAssistantComparison(scope, signal, async () => {
      if (
        storage.getCustomUiCss() !== previous.before ||
        JSON.stringify(request.css) !== JSON.stringify(getAssistantContext().css)
      )
        throw new Error('截图期间样式已变化，未覆盖新的修改')
      if (compiled !== previous.before) {
        emit('save-assistant-css', compiled)
        if (storage.getCustomUiCss() !== compiled)
          throw new Error('样式未能应用，请检查本机存储或安全模式；草稿未覆盖')
        assistantUndo.value = previous
      }
      draft.value = candidate
      activeScope.value = scope.value
      await nextTick()
    })
    if (compiled !== previous.before && assistantUndo.value)
      assistantUndo.value.comparisonId = comparison.id
    status = `已应用到${scope.title}`
    return {
      text,
      status,
      comparison,
      data: {
        verification: verifyAssistantAppearance(scope, props.theme, reply.css),
        comparison: {
          id: comparison.id,
          beforeCaptured: Boolean(comparison.before),
          afterCaptured: Boolean(comparison.after),
          captureError: comparison.captureError,
        },
      },
    }
  }
  await nextTick()
  try {
    return {
      text,
      status: status ?? `已截取${scope.title}`,
      image: await captureAssistantPage(scope, signal),
    }
  } catch (error) {
    return {
      ok: false,
      status,
      text: `${text}\n\n截图未完成：${error instanceof Error ? error.message : '渲染失败'}。没有生成替代效果图。`,
    }
  }
}

function backFromAppearance(): void {
  if (assistantOpen.value && !props.assistantOnly) {
    assistantOpen.value = false
    return
  }
  emit('back')
}

async function deletePreset(): Promise<void> {
  if (!presets.value.some((item) => item.id === draft.value.id)) {
    const next = presets.value[0] ?? createPreset()
    activePresetId.value = next.id
    draft.value = clonePreset(next)
    flash('未保存草稿已放弃')
    return
  }
  const deletePresetConfirmed = await confirmAction({
    title: '删除 CSS 预设',
    message: `删除 CSS 预设「${draft.value.name}」？导出的文件不受影响。`,
    confirmLabel: '删除',
    danger: true,
  })
  if (!deletePresetConfirmed) return
  presets.value = presets.value.filter((item) => item.id !== draft.value.id)
  storage.setCustomUiPresets(presets.value)
  const next = presets.value[0] ?? createPreset()
  activePresetId.value = next.id
  draft.value = clonePreset(next)
  storage.setActiveCustomUiPresetId(presets.value.length ? next.id : '')
  applyPreset(next, presets.value.length ? compilePreset(next) : '')
  flash('预设已删除')
}

function preview(): void {
  previewCss.value = compilePreset(draft.value)
  isPreviewOpen.value = true
}

async function clearDraft(): Promise<void> {
  if (
    hasCssContent.value &&
    !(await confirmAction({
      title: '清空草稿',
      message: '清空当前草稿里的全部 CSS？保存的预设不会立即改变。',
      confirmLabel: '清空',
      danger: true,
    }))
  ) {
    return
  }
  draft.value.globalCss = ''
  draft.value.scopedCss = {}
  flash('草稿已清空，尚未保存')
}

async function exportPreset(): Promise<void> {
  const css = `/* SRL 外观预设：${draft.value.name || '未命名样式'} */\n${compilePreset(draft.value)}\n`
  await downloadBlob(
    new Blob([css], { type: 'text/css;charset=utf-8' }),
    `${(draft.value.name || 'srl-style').replace(/[\\/:*?"<>|]/g, '-')}.css`,
  )
  flash('CSS 文件已导出，可以直接分享')
}

function exportEditablePreset(): void {
  downloadBlob(
    new Blob(
      [
        JSON.stringify(
          { format: 'srl-appearance-preset', version: 1, preset: draft.value },
          null,
          2,
        ),
      ],
      { type: 'application/json' },
    ),
    `${(draft.value.name || '外观预设').replace(/[\\/:*?"<>|]/g, '-')}.srl-style.json`,
  )
  flash('可编辑预设已导出，包含未安装 APP 的局部样式')
}

async function importPresets(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const selectedFiles = Array.from(input.files ?? [])
  const files = selectedFiles.slice(0, Math.max(0, 30 - presets.value.length))
  const prepared: CustomCssPreset[] = []
  try {
    for (const file of files) {
      if (file.size > (/\.json$/iu.test(file.name) ? 30 : 2) * 1024 * 1024)
        throw new Error('外观文件超过源码与素材预算')
      const text = await file.text()
      const imported = /\.json$/i.test(file.name)
        ? parseAppearancePreset(JSON.parse(text))
        : createPreset(file.name.replace(/\.css$/i, '') || '导入样式', text)
      prepared.push(imported)
    }
  } catch (error) {
    flash(error instanceof Error ? error.message : '预设导入失败')
    input.value = ''
    return
  }
  for (const imported of prepared) {
    presets.value.push(imported)
    activePresetId.value = imported.id
    draft.value = clonePreset(imported)
  }
  if (files.length) {
    storage.setCustomUiPresets(presets.value)
    storage.setActiveCustomUiPresetId(activePresetId.value)
    applyPreset(draft.value, compilePreset(draft.value))
    flash(
      selectedFiles.length === files.length
        ? `已导入 ${files.length} 个 CSS 预设`
        : `已导入 ${files.length} 个，预设库上限为 30 个`,
    )
  }
  input.value = ''
}

const previewDocument = computed(() => {
  const css = sanitizeCssForPreview(previewCss.value, {
    allowExternalResources: previewPolicy.value.allowRemoteResources,
    preserveLength: true,
  })
  const csp = previewPolicy.value.allowRemoteResources
    ? "default-src 'none'; style-src 'unsafe-inline' https: http:; img-src data: https: http:; font-src data: https: http:; script-src 'none'"
    : "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; script-src 'none'"
  const featurePage = selectedScope.value?.appId ?? 'home'
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${previewSampleCss}${css}</style></head><body><div class="app-shell"><aside class="sidebar"><strong>SRL</strong><span>全部资源</span><span>角色卡</span><span>世界书</span></aside><main class="library resource-detail-sheet feature-hub layout-settings-page" data-feature-page="${featurePage}"><span hidden data-official-app-ready="${featurePage}"></span><div class="toolbar"><input value="搜索名称或文件名"><button>导入</button></div><section class="resource-grid"><article class="resource-card"><i></i><strong>示例角色</strong><small>角色卡 · 收藏</small></article><article class="resource-card"><i></i><strong>城市设定</strong><small>世界书 · 12 条</small></article><article class="resource-card"><strong>界面正则</strong><small>正则 · HTML / CSS</small></article></section></main></div></body></html>`
})
</script>

<template>
  <section
    ref="previewHost"
    class="appearance-studio"
    :class="{ 'appearance-studio--chat': assistantOpen }"
  >
    <FeatureAppHeader v-if="!assistantOpen" title="外观" @back="backFromAppearance">
      <template #status>
        <span class="feature-header-status">本机生效</span>
      </template>
      <!-- SRL-PUBLIC-SYNC: BEGIN REPLACE id=appearance-assistant-header-actions -->
      <template #actions>
        <button
          v-if="!assistantOpen && props.assistantOnly"
          class="feature-header-action"
          type="button"
          @click="assistantOpen = true"
        >
          让 AI 修改
        </button>
      </template>
      <!-- SRL-PUBLIC-SYNC: END REPLACE id=appearance-assistant-header-actions -->
    </FeatureAppHeader>
    <ProductAssistant
      v-if="props.assistantOnly && assistantVisited && selectedScope"
      v-show="assistantOpen"
      :get-context="getAssistantContext"
      :execute="executeAssistantReply"
      :navigate="navigate"
      :compact="compact"
      :visible="active && assistantOpen"
      :background-task="backgroundTask"
      :capture-reference="captureCurrentReference"
      @expand="emit('expand')"
      @activity="emit('assistant-activity', $event)"
      @back="backFromAppearance"
    >
      <template #task-preview><slot name="task-preview" /></template>
    </ProductAssistant>
    <div v-show="!assistantOpen" class="appearance-studio__grid">
      <section class="appearance-panel">
        <header>
          <div>
            <h2>界面明暗</h2>
          </div>
        </header>
        <div class="settings-theme" role="radiogroup" aria-label="选择界面主题">
          <button
            type="button"
            role="radio"
            :aria-checked="theme === 'light'"
            :class="{ 'settings-theme__option--active': theme === 'light' }"
            @click="emit('update:theme', 'light')"
          >
            <span class="settings-theme__sample settings-theme__sample--light"></span
            ><strong>浅色档案</strong>
          </button>
          <button
            type="button"
            role="radio"
            :aria-checked="theme === 'dark'"
            :class="{ 'settings-theme__option--active': theme === 'dark' }"
            @click="emit('update:theme', 'dark')"
          >
            <span class="settings-theme__sample settings-theme__sample--dark"></span
            ><strong>深色档案</strong>
          </button>
        </div>
      </section>

      <section class="appearance-panel appearance-panel--font-scale">
        <header>
          <div>
            <h2>文字大小</h2>
          </div>
          <span>不会缩放整个页面</span>
        </header>
        <div class="font-scale-options" role="radiogroup" aria-label="文字大小">
          <button
            v-for="option in fontScales"
            :key="option.value"
            type="button"
            role="radio"
            :data-font-scale="option.value"
            :aria-checked="uiFontScale === option.value"
            :class="{ 'is-active': uiFontScale === option.value }"
            @click="emit('update:uiFontScale', option.value)"
          >
            <span class="font-scale-option__sample" aria-hidden="true">字</span>
            <span
              ><strong>{{ option.title }}</strong></span
            >
            <i aria-hidden="true">{{ uiFontScale === option.value ? '✓' : '' }}</i>
          </button>
        </div>
      </section>

      <section class="appearance-panel appearance-panel--layout">
        <header>
          <div>
            <h2>资源排版</h2>
          </div>
          <span>不会改变筛选</span>
        </header>
        <div class="layout-settings__options" role="radiogroup" aria-label="资源排版">
          <button
            v-for="layout in layouts"
            :key="layout.value"
            type="button"
            class="layout-option"
            :class="{ 'layout-option--active': layoutMode === layout.value }"
            role="radio"
            :aria-checked="layoutMode === layout.value"
            @click="selectLayout(layout.value)"
          >
            <span
              class="layout-option__preview"
              :class="`layout-option__preview--${layout.value}`"
              aria-hidden="true"
              ><i v-for="cell in layout.cells" :key="cell"></i
            ></span>
            <span class="layout-option__copy"
              ><small>{{ layout.eyebrow }}</small
              ><strong>{{ layout.title }}</strong
              ><span>{{ layout.description }}</span></span
            >
            <span class="layout-option__check" aria-hidden="true">{{
              layoutMode === layout.value ? '✓' : ''
            }}</span>
          </button>
        </div>
      </section>

      <section class="appearance-panel appearance-panel--cabinet">
        <header>
          <div>
            <h2>收藏柜布局</h2>
          </div>
          <span>固定三行</span>
        </header>
        <p>文件夹少可以放大图标，收藏多则保留四列。分页、空位和拖动会自动适配。</p>
        <div class="cabinet-density" role="radiogroup" aria-label="收藏柜每行图标数量">
          <button
            v-for="density in cabinetDensities"
            :key="density.value"
            type="button"
            role="radio"
            :data-cabinet-columns="density.value"
            :aria-checked="cabinetColumns === density.value"
            :class="{ 'is-active': cabinetColumns === density.value }"
            @click="selectCabinetColumns(density.value)"
          >
            <span
              class="cabinet-density__preview"
              :style="{ '--density-columns': density.value }"
              aria-hidden="true"
            >
              <i v-for="cell in density.value * 3" :key="cell"></i>
            </span>
            <strong>{{ density.value }} 列 · {{ density.title }}</strong>
            <small>{{ density.description }}</small>
            <b aria-hidden="true">{{ cabinetColumns === density.value ? '✓' : '' }}</b>
          </button>
        </div>
      </section>

      <section class="appearance-panel appearance-panel--code">
        <header>
          <h2>自定义 CSS</h2>
          <AppearanceCodeReference />
          <AppearanceOriginalCssActions class="appearance-code-tools" />
        </header>

        <section class="appearance-preset-manager">
          <header>
            <div>
              <strong>预设库</strong><span>{{ presets.length }} / 30 份保存在本机</span>
            </div>
            <i :class="{ 'is-dirty': hasUnsavedChanges }">{{ presetState }}</i>
          </header>
          <div class="appearance-preset-fields">
            <label
              ><span>正在编辑</span
              ><select :value="activePresetId" @change="selectPreset">
                <option v-if="!savedDraft" :value="draft.id">{{ draft.name }}（未保存）</option>
                <option v-for="preset in presets" :key="preset.id" :value="preset.id">
                  {{ preset.name }}
                </option>
              </select></label
            >
            <label
              ><span>预设名称</span
              ><input v-model="draft.name" maxlength="40" placeholder="例如：夜间玻璃风"
            /></label>
          </div>
          <div class="appearance-preset-tools">
            <button type="button" class="appearance-action-hit" @click="newPreset">
              <span class="appearance-action-face"><b>＋</b><span>新建空白预设</span></span>
            </button>
            <button type="button" class="appearance-action-hit" @click="importInput?.click()">
              <span class="appearance-action-face"><b>↑</b><span>导入 CSS / 预设</span></span>
            </button>
            <button type="button" class="appearance-action-hit" @click="exportPreset">
              <span class="appearance-action-face"><b>↓</b><span>导出 CSS</span></span>
            </button>
            <button type="button" class="appearance-action-hit" @click="exportEditablePreset">
              <span class="appearance-action-face"><b>↓</b><span>导出可编辑预设</span></span>
            </button>
          </div>
          <input
            ref="importInput"
            data-appearance-preset-import
            hidden
            type="file"
            accept=".css,.json,text/css,application/json"
            multiple
            @change="importPresets"
          />
        </section>

        <label class="appearance-code-editor"
          ><span>全局 CSS <small>会作用于整个应用</small></span
          ><textarea
            v-model="draft.globalCss"
            spellcheck="false"
            placeholder="例如：:root { --color-accent: #7d4be2; }"
          ></textarea>
        </label>

        <details class="appearance-advanced">
          <summary data-assistant-focus="appearance-css">
            <span><strong>按界面编辑 CSS / 源码</strong></span>
          </summary>
          <div
            class="appearance-scope-tabs"
            role="tablist"
            aria-label="选择要装修的界面"
            data-assistant-focus="appearance-scope"
          >
            <button
              v-for="scope in activeScopes"
              :key="scope.value"
              type="button"
              role="tab"
              :aria-selected="activeScope === scope.value"
              :class="{ 'is-active': activeScope === scope.value }"
              @click="activeScope = scope.value"
            >
              {{ scope.title }}<i v-if="draft.scopedCss[scope.value]">●</i>
            </button>
          </div>
          <p v-if="installationError" role="status">{{ installationError }}</p>
          <p v-else-if="!installationsLoaded" role="status">正在读取 APP 安装状态…</p>
          <details v-if="inactiveScopes.length" class="appearance-inactive-scopes">
            <summary>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="4" y="4" width="16" height="16" rx="4" />
                <path d="M8 12h8m-4-4v8" /></svg
              ><span>未安装 APP</span><small>{{ inactiveScopes.length }}</small
              ><span class="appearance-inactive-scopes__chevron" aria-hidden="true">⌄</span>
            </summary>
            <div class="appearance-scope-tabs" role="tablist" aria-label="未安装 APP 的样式">
              <button
                v-for="scope in inactiveScopes"
                :key="scope.value"
                type="button"
                role="tab"
                :aria-selected="activeScope === scope.value"
                :class="{ 'is-active': activeScope === scope.value }"
                @click="activeScope = scope.value"
              >
                {{ scope.title }}<i v-if="draft.scopedCss[scope.value]">●</i>
              </button>
            </div>
          </details>
          <div class="appearance-scope-editor__header">
            <strong>{{ selectedScope?.title }}专用 CSS</strong>
            <AppearanceOriginalCssActions v-if="selectedScope" :scope="selectedScope" />
          </div>
          <label class="appearance-code-editor">
            <small
              >未修改的样式沿用全局；用 :scope 设置局部变量。公共弹窗请在全局 CSS 中修改。</small
            >
            <textarea
              v-model="activeScopedCss"
              spellcheck="false"
              placeholder="在此填写本界面的自定义 CSS"
            ></textarea>
          </label>
          <AppearanceUiEditor
            v-if="selectedScope?.selector"
            :scope="activeScope"
            :title="selectedScope.title"
            :views="draft.views ?? {}"
            :css="compilePreset(draft)"
            @update:views="draft.views = $event"
          />
        </details>

        <div class="appearance-code-actions">
          <span role="status">{{ copyStatus }}</span>
          <button type="button" class="appearance-action-hit" @click="preview">
            <span class="appearance-action-face">保存前预览</span>
          </button>
          <button type="button" class="appearance-action-hit" @click="clearDraft">
            <span class="appearance-action-face">清空草稿</span>
          </button>
          <button type="button" class="appearance-action-hit" @click="deletePreset">
            <span class="appearance-action-face">{{ savedDraft ? '删除预设' : '放弃草稿' }}</span>
          </button>
          <button
            v-if="savedDraft"
            type="button"
            class="appearance-action-hit"
            @click="saveAsNewPreset"
          >
            <span class="appearance-action-face">另存为新预设</span>
          </button>
          <button
            class="button--primary appearance-action-hit"
            type="button"
            :disabled="!hasUnsavedChanges"
            data-assistant-focus="appearance-save"
            @click="savePreset"
          >
            <span class="appearance-action-face">{{
              hasUnsavedChanges ? '保存并应用' : '已保存'
            }}</span>
          </button>
        </div>
      </section>

      <section v-if="isPreviewOpen" class="appearance-panel appearance-panel--preview">
        <header>
          <div>
            <small>PREVIEW</small>
            <h2>保存前预览</h2>
          </div>
          <button type="button" @click="isPreviewOpen = false">关闭预览</button>
        </header>
        <iframe
          v-if="previewEnabled"
          :key="previewCss"
          :srcdoc="previewDocument"
          sandbox=""
          title="自定义 CSS 隔离预览"
        ></iframe>
        <p v-else role="status">预览资源已暂停，回到当前区域后恢复。</p>
      </section>
    </div>

    <Teleport to="body">
      <div
        v-if="isCardOrientationDialogOpen"
        class="editor-overlay appearance-card-orientation-overlay"
        role="presentation"
        @click.self="isCardOrientationDialogOpen = false"
      >
        <section
          class="editor-sheet appearance-card-orientation"
          role="dialog"
          aria-modal="true"
          aria-labelledby="appearance-card-orientation-title"
        >
          <header>
            <div>
              <small>CARD BROWSING</small>
              <h2 id="appearance-card-orientation-title">卡片浏览外观</h2>
            </div>
            <button
              type="button"
              aria-label="关闭卡片方向选择"
              @click="isCardOrientationDialogOpen = false"
            >
              ×
            </button>
          </header>
          <section class="appearance-card-setting">
            <h3>资源卡片高度 · 全部资源</h3>
            <p>最长模式按当前页内容等高；固定模式按比例设置长度并收起超出内容。</p>
            <div role="radiogroup" aria-label="资源卡片高度">
              <button
                v-for="mode in cardHeightModes"
                :key="String(mode.value)"
                type="button"
                role="radio"
                :aria-checked="resourceCardHeightMode === mode.value"
                :class="{ 'is-active': resourceCardHeightMode === mode.value }"
                @click="emit('update:resourceCardHeightMode', mode.value)"
              >
                <span
                  ><strong>{{ mode.title }}</strong
                  ><small>{{ mode.description }}</small></span
                >
                <b aria-hidden="true">{{ resourceCardHeightMode === mode.value ? '✓' : '' }}</b>
              </button>
            </div>
          </section>
          <section class="appearance-card-setting">
            <h3>无图资源封面</h3>
            <div role="radiogroup" aria-label="无图资源封面显示方式">
              <button
                v-for="mode in noImageResourceCoverModes"
                :key="mode.value"
                type="button"
                role="radio"
                :aria-checked="noImageResourceCoverMode === mode.value"
                :class="{ 'is-active': noImageResourceCoverMode === mode.value }"
                @click="emit('update:noImageResourceCoverMode', mode.value)"
              >
                <span
                  ><strong>{{ mode.title }}</strong
                  ><small>{{ mode.description }}</small></span
                >
                <b aria-hidden="true">{{ noImageResourceCoverMode === mode.value ? '✓' : '' }}</b>
              </button>
            </div>
          </section>
          <section class="appearance-card-setting">
            <h3>手机端封面方向</h3>
            <div role="radiogroup" aria-label="手机卡片封面比例">
              <button
                v-for="orientation in cardOrientations"
                :key="orientation.value"
                type="button"
                role="radio"
                :aria-checked="mobileCardOrientation === orientation.value"
                :class="{ 'is-active': mobileCardOrientation === orientation.value }"
                @click="selectCardOrientation(orientation.value)"
              >
                <span
                  ><strong>{{ orientation.title }}</strong
                  ><small>{{ orientation.description }}</small></span
                >
                <b aria-hidden="true">{{
                  mobileCardOrientation === orientation.value ? '✓' : ''
                }}</b>
              </button>
            </div>
            <div
              class="appearance-card-orientation__fit"
              role="radiogroup"
              aria-label="卡片图片显示方式"
            >
              <strong>图片显示方式</strong>
              <button
                v-for="mode in cardFitModes"
                :key="mode.value"
                type="button"
                role="radio"
                :aria-checked="mobileCardFitMode === mode.value"
                :class="{ 'is-active': mobileCardFitMode === mode.value }"
                @click="emit('update:mobileCardFitMode', mode.value)"
              >
                <span
                  ><strong>{{ mode.title }}</strong
                  ><small>{{ mode.description }}</small></span
                >
                <b aria-hidden="true">{{ mobileCardFitMode === mode.value ? '✓' : '' }}</b>
              </button>
            </div>
          </section>
        </section>
      </div>
    </Teleport>
    <AssistantUiPreview
      v-if="vueTools.preview.value"
      :preview="vueTools.preview.value"
      @close="vueTools.close"
      @ready="(id) => vueTools.status(id)"
      @error="(id, message) => vueTools.status(id, message)"
      @action="vueTools.invoke"
    />
  </section>
</template>

<style src="../styles/AppearanceStudio.css"></style>
