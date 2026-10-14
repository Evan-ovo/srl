<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { confirmAction, useConfirmDialogState } from '../composables/UseConfirmDialog'
import { SRL_BACK_REQUEST_EVENT, type SrlBackRequestDetail } from '../composables/UseBackStack'
import { externalAppService } from '../core/AppContainer'
import { ExternalAppTrialSession } from '../services/ExternalAppTrialSession'
import {
  EXTERNAL_APP_PERMISSION_LABELS,
  EXTERNAL_APP_RUNTIME_MODE,
  type ExternalAppRuntimeMode,
  type ExternalAppPermission,
  type ExternalAppPreview,
  type InstalledExternalApp,
  type InstalledExternalAppSummary,
  type RetainedExternalAppData,
} from '../types/ExternalApp'
import { downloadBlob } from '../utils/LibraryFormatting'
import { getCapacitorPlatform } from '../utils/CapacitorDetection'
import {
  OPAQUE_PREVIEW_DOCUMENT_URL,
  seedOpaquePreviewDocument,
} from '../utils/OpaquePreviewDocument'
import FeatureAppHeader from './FeatureAppHeader.vue'
import ActionSheet, { type ActionSheetAction } from './ActionSheet.vue'

const emit = defineEmits<{
  back: []
  changed: []
  installed: [appId: string]
  open: [appId: string]
  'shared-files-consumed': []
  busy: [value: boolean]
  'preview-cancelled': []
}>()

const props = defineProps<{
  sharedFiles?: File[]
}>()
const { activeDialog: confirmation, respond: respondToConfirmation } = useConfirmDialogState()

const apps = ref<InstalledExternalAppSummary[]>([])
const retainedData = ref<RetainedExternalAppData[]>([])
const installing = ref(false)
const notice = ref('')
const errorMessage = ref('')
const fileInput = ref<HTMLInputElement>()
const preview = ref<ExternalAppPreview>()
const previewFiles = ref<File[]>([])
const previewFrame = ref<HTMLIFrameElement>()
const previewRuntimeMode = ref<ExternalAppRuntimeMode>(EXTERNAL_APP_RUNTIME_MODE.ISOLATED)
const headerMoreOpen = ref(false)
const selectedPermissions = ref<ExternalAppPermission[]>([])
const previewName = ref('')
const previewIcon = ref('')
const dragActive = ref(false)
const actionApp = ref<InstalledExternalApp>()
const actionHealth = ref<Awaited<ReturnType<typeof externalAppService.getHealth>>>()
const folderInput = ref<HTMLInputElement>()
const iconInput = ref<HTMLInputElement>()
const previewIconInput = ref<HTMLInputElement>()
const actionName = ref('')
const actionIcon = ref('')
const sourcePath = ref('')
const sourceText = ref('')
const actionPermissions = ref<ExternalAppPermission[]>([])
const originalPreview = ref<ExternalAppPreview>()
const updateAppId = ref('')
const previewEntry = ref('')
const showPreview = ref(false)
const trialHtml = ref('')
const trialGeneration = ref(0)
const trialStatus = ref('')
const trialError = ref('')
const trialMessages = ref<string[]>([])
const trialLoading = ref('')
const installedApp = ref<InstalledExternalAppSummary>()
const actionSection = ref<
  'overview' | 'more' | 'data' | 'identity' | 'permissions' | 'runtime' | 'source' | 'health'
>('overview')
const actionHistory = ref<Array<typeof actionSection.value>>([])
const actionMode = ref<ExternalAppRuntimeMode>(EXTERNAL_APP_RUNTIME_MODE.ISOLATED)
const actionBusy = ref(false)
const overlayPanel = ref<HTMLElement>()
const trialSession = new ExternalAppTrialSession({
  permissions: () => selectedPermissions.value,
  active: () => showPreview.value,
  running: () => {
    trialStatus.value = '试运行中'
  },
  diagnostic: (level, message) => {
    trialMessages.value = [...trialMessages.value.slice(-9), message]
    if (level === 'error') {
      trialError.value = message
      trialStatus.value = '试运行异常'
    }
  },
  notify: (message) => {
    trialMessages.value = [...trialMessages.value.slice(-9), message]
  },
  loading: (label) => {
    trialLoading.value = label
  },
})
let overlayReturnFocus: HTMLElement | undefined

const appDataStorageLocation = computed(() =>
  getCapacitorPlatform() === 'android' ? '当前 APK 的应用私有存储' : '当前浏览器的本机站点存储',
)
const editablePaths = computed(() =>
  Object.keys(actionApp.value?.packageFiles ?? {}).filter(
    (path) => path !== 'manifest.json' && /\.(?:html?|css|js|mjs|json)$/i.test(path),
  ),
)
const htmlEntries = computed(() =>
  Object.keys(preview.value?.packageFiles ?? {}).filter((path) => /\.html?$/i.test(path)),
)
const installLabel = computed(() =>
  !preview.value?.previousInstallation
    ? '安装 APP'
    : preview.value.contentChanged
      ? '更新 APP'
      : '重新安装',
)
const sectionTitles = {
  overview: 'APP 管理',
  more: '更多操作',
  data: '数据与卸载',
  identity: '名称与图标',
  permissions: '权限管理',
  runtime: '运行设置',
  source: '源码编辑',
  health: '运行诊断',
}
const permissionDecisions = { once: '仅同意这次', always: '已记住授权', denied: '已拒绝' }
const draftChanged = computed(() => {
  const app = actionApp.value
  if (!app) return false
  if (actionSection.value === 'identity')
    return actionName.value !== app.manifest.name || actionIcon.value !== (app.iconDataUrl ?? '')
  if (actionSection.value === 'permissions')
    return (
      [...actionPermissions.value].sort().join() !==
      [...(app.allowedPermissions ?? app.grantedPermissions ?? app.manifest.permissions ?? [])]
        .sort()
        .join()
    )
  if (actionSection.value === 'runtime')
    return actionMode.value !== (app.runtimeMode ?? EXTERNAL_APP_RUNTIME_MODE.ISOLATED)
  return (
    actionSection.value === 'source' &&
    sourceText.value !==
      (sourcePath.value ? new TextDecoder().decode(app.packageFiles?.[sourcePath.value]) : '')
  )
})

async function reload(): Promise<void> {
  apps.value = await externalAppService.list()
  retainedData.value = await externalAppService.listRetainedData()
}

async function openAppActions(app: InstalledExternalAppSummary): Promise<void> {
  if (installing.value || actionBusy.value || preview.value || actionApp.value) return
  await runAction(async () => {
    const fullApp = await externalAppService.get(app.id)
    if (!fullApp) {
      errorMessage.value = '这个第三方 APP 已被卸载。'
      return
    }
    actionApp.value = fullApp
    actionSection.value = 'overview'
    actionHistory.value = []
    actionMode.value = fullApp.runtimeMode ?? EXTERNAL_APP_RUNTIME_MODE.ISOLATED
    actionName.value = fullApp.manifest.name
    actionIcon.value = fullApp.iconDataUrl ?? ''
    actionPermissions.value = [
      ...(fullApp.allowedPermissions ??
        fullApp.grantedPermissions ??
        fullApp.manifest.permissions ??
        []),
    ]
    actionHealth.value = undefined
    actionHealth.value = await externalAppService.getHealth(app.id)
  })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

onMounted(() => {
  void reload().catch((error: unknown) => {
    errorMessage.value = error instanceof Error ? error.message : '无法读取 APP 列表'
  })
  window.addEventListener('keydown', handleOverlayKeydown, true)
  window.addEventListener(SRL_BACK_REQUEST_EVENT, handleOverlayBack, true)
})

onBeforeUnmount(() => {
  stopPreview()
  document.documentElement.classList.remove('external-app-manager-open')
  window.removeEventListener('keydown', handleOverlayKeydown, true)
  window.removeEventListener(SRL_BACK_REQUEST_EVENT, handleOverlayBack, true)
})

watch(
  () => Boolean(preview.value || actionApp.value),
  (open) => {
    document.documentElement.classList.toggle('external-app-manager-open', open)
    if (open) {
      overlayReturnFocus =
        document.activeElement instanceof HTMLElement ? document.activeElement : undefined
      void nextTick(() => overlayPanel.value?.focus({ preventScroll: true }))
    } else {
      overlayReturnFocus?.focus({ preventScroll: true })
      overlayReturnFocus = undefined
    }
  },
)

function handleOverlayKeydown(event: KeyboardEvent): void {
  if (
    event.key === 'Tab' &&
    (preview.value || actionApp.value) &&
    !confirmation.value &&
    !document.body.classList.contains('modal-open')
  ) {
    const panel = overlayPanel.value
    const controls = Array.from(
      panel?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, iframe',
      ) ?? [],
    ).filter((control) => control.getClientRects().length > 0)
    const first = controls[0]
    const last = controls[controls.length - 1]
    if (
      first &&
      last &&
      ((event.shiftKey && (document.activeElement === first || document.activeElement === panel)) ||
        (!event.shiftKey && (document.activeElement === last || document.activeElement === panel)))
    ) {
      event.preventDefault()
      ;(event.shiftKey ? last : first).focus()
    }
    return
  }
  if (
    event.key !== 'Escape' ||
    (!preview.value && !actionApp.value) ||
    headerMoreOpen.value ||
    confirmation.value ||
    document.body.classList.contains('modal-open')
  )
    return
  event.preventDefault()
  event.stopImmediatePropagation()
  void closeOverlay()
}

function handleOverlayBack(event: Event): void {
  const detail = (event as CustomEvent<SrlBackRequestDetail>).detail
  if (
    !detail ||
    detail.handled ||
    (!preview.value && !actionApp.value) ||
    headerMoreOpen.value ||
    document.body.classList.contains('modal-open')
  )
    return
  detail.handled = true
  event.stopImmediatePropagation()
  if (confirmation.value) {
    respondToConfirmation('cancel')
    return
  }
  void closeOverlay()
}

async function leaveSection(): Promise<boolean> {
  return (
    !draftChanged.value ||
    (await confirmAction({
      title: '放弃未保存的更改',
      message: '当前更改尚未保存。放弃这些更改吗？',
      confirmLabel: '放弃更改',
    }))
  )
}

async function closeOverlay(): Promise<void> {
  if (installing.value || actionBusy.value) return
  if (preview.value) {
    cancelPreview()
    return
  }
  if (!(await leaveSection())) return
  if (actionSection.value !== 'overview') {
    actionSection.value = actionHistory.value.pop() ?? 'overview'
    void nextTick(() => overlayPanel.value?.focus({ preventScroll: true }))
    return
  }
  actionApp.value = undefined
  errorMessage.value = ''
}

function openApp(app: InstalledExternalApp | InstalledExternalAppSummary): void {
  if (!app.enabled) return
  actionApp.value = undefined
  emit('open', app.id)
}

async function runAction(operation: () => Promise<void>): Promise<void> {
  if (actionBusy.value) return
  actionBusy.value = true
  errorMessage.value = ''
  notice.value = ''
  try {
    await operation()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '操作失败，请重试'
  } finally {
    actionBusy.value = false
  }
}

async function refreshAction(): Promise<void> {
  await reload()
  const app = actionApp.value
  if (!app) return
  const summary = apps.value.find((item) => item.id === app.id)
  if (summary) actionApp.value = { ...app, ...summary }
  else actionApp.value = undefined
}

function openSection(section: typeof actionSection.value): void {
  const app = actionApp.value
  if (!app || actionBusy.value) return
  actionName.value = app.manifest.name
  actionIcon.value = app.iconDataUrl ?? ''
  actionPermissions.value = [
    ...(app.allowedPermissions ?? app.grantedPermissions ?? app.manifest.permissions ?? []),
  ]
  actionMode.value = app.runtimeMode ?? EXTERNAL_APP_RUNTIME_MODE.ISOLATED
  if (section === 'source') {
    sourcePath.value = editablePaths.value.includes(app.manifest.entry)
      ? app.manifest.entry
      : (editablePaths.value[0] ?? '')
    sourceText.value = sourcePath.value
      ? new TextDecoder().decode(app.packageFiles?.[sourcePath.value])
      : ''
  }
  actionHistory.value.push(actionSection.value)
  actionSection.value = section
  void nextTick(() => overlayPanel.value?.focus({ preventScroll: true }))
  errorMessage.value = ''
  notice.value = ''
}

function choosePackage(): void {
  fileInput.value?.click()
}

function chooseFolder(): void {
  folderInput.value?.click()
}

const headerMoreActions: readonly ActionSheetAction[] = [
  { id: 'file', label: '导入文件', description: 'HTML、ZIP 或 .srlapp' },
  { id: 'folder', label: '导入文件夹', description: '选择完整的第三方 APP 文件夹' },
]

function selectHeaderMore(action: ActionSheetAction): void {
  if (action.id === 'file') choosePackage()
  else if (action.id === 'folder') chooseFolder()
}

function handleDragOver(event: DragEvent): void {
  event.preventDefault()
  dragActive.value = true
}

function handleDragLeave(): void {
  dragActive.value = false
}

async function handleDrop(event: DragEvent): Promise<void> {
  event.preventDefault()
  dragActive.value = false
  const files = Array.from(event.dataTransfer?.files ?? [])
  if (files.length) await inspectFiles(files)
}

async function handlePaste(event: ClipboardEvent): Promise<void> {
  const files = Array.from(event.clipboardData?.files ?? [])
  if (!files.length) return
  event.preventDefault()
  await inspectFiles(files)
}

async function inspectPackage(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  await inspectFiles(files)
}

async function inspectFiles(files: File[]): Promise<boolean> {
  if (!files.length || installing.value || actionBusy.value || preview.value || actionApp.value)
    return false
  installing.value = true
  notice.value = ''
  errorMessage.value = ''
  preview.value = undefined
  previewFiles.value = []
  previewRuntimeMode.value = EXTERNAL_APP_RUNTIME_MODE.ISOLATED
  try {
    preview.value = await externalAppService.inspect(files.length === 1 ? files[0] : files)
    originalPreview.value = preview.value
    updateAppId.value = ''
    previewEntry.value = preview.value.manifest.entry
    installedApp.value = undefined
    previewRuntimeMode.value =
      preview.value.previousInstallation?.runtimeMode ?? EXTERNAL_APP_RUNTIME_MODE.ISOLATED
    selectedPermissions.value = [...preview.value.requestedPermissions]
    previewName.value = preview.value.manifest.name
    previewIcon.value = preview.value.iconDataUrl ?? ''
    previewFiles.value = files
    notice.value = ''
    return true
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '无法预览 APP 安装包'
    return false
  } finally {
    installing.value = false
  }
}

watch(
  () => props.sharedFiles,
  (files) => {
    if (!files?.length) return
    void inspectFiles([...files]).then((valid) => {
      if (valid) emit('shared-files-consumed')
    })
  },
  { immediate: true },
)

async function confirmInstall(): Promise<void> {
  if (!previewFiles.value.length || !preview.value || installing.value) return
  installing.value = true
  emit('busy', true)
  errorMessage.value = ''
  try {
    const previous = (await externalAppService.list()).find(
      (app) => app.id === preview.value!.manifest.id,
    )
    if (
      previous &&
      !(await confirmAction({
        title: '更新第三方 APP',
        message: `将“${previous.manifest.name}”从${previous.manifest.version}更新为${preview.value.manifest.version}。保留应用数据，按本次选择重新授权。`,
        confirmLabel: '确认更新',
        cancelLabel: '继续查看',
        centered: true,
      }))
    )
      return
    const normalizedName = previewName.value.trim()
    if (!normalizedName) throw new Error('APP 名称不能为空')
    preview.value.manifest.name = normalizedName.slice(0, 80)
    preview.value.iconDataUrl = previewIcon.value
    preview.value.allowedPermissions = [...selectedPermissions.value]
    const installed = await externalAppService.install(preview.value, previewRuntimeMode.value)
    await reload()
    emit('changed')
    stopPreview()
    preview.value = undefined
    originalPreview.value = undefined
    previewFiles.value = []
    notice.value = `已安装“${installed.manifest.name}”。现在可在“功能”中作为第三方 APP 打开。`
    installedApp.value = apps.value.find((app) => app.id === installed.id)
    emit('installed', installed.id)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '安装 APP 失败'
  } finally {
    installing.value = false
    emit('busy', false)
  }
}

function cancelPreview(): void {
  emit('preview-cancelled')
  stopPreview()
  preview.value = undefined
  previewFiles.value = []
  selectedPermissions.value = []
  previewName.value = ''
  previewIcon.value = ''
  notice.value = ''
  errorMessage.value = ''
  originalPreview.value = undefined
}

async function configureInstall(): Promise<void> {
  const original = originalPreview.value
  if (!original || installing.value) return
  installing.value = true
  errorMessage.value = ''
  stopPreview()
  try {
    preview.value = await externalAppService.configurePreview(original, {
      updateAppId: updateAppId.value || undefined,
      entry: previewEntry.value,
    })
    previewRuntimeMode.value =
      preview.value.previousInstallation?.runtimeMode ?? EXTERNAL_APP_RUNTIME_MODE.ISOLATED
  } catch (error) {
    updateAppId.value =
      preview.value?.previousInstallation?.id === original.manifest.id
        ? ''
        : (preview.value?.previousInstallation?.id ?? '')
    previewEntry.value = preview.value?.manifest.entry ?? original.manifest.entry
    errorMessage.value = error instanceof Error ? error.message : '无法配置安装目标'
  } finally {
    installing.value = false
  }
}

async function saveAllowedPermissions(app: InstalledExternalApp): Promise<void> {
  await externalAppService.setAllowedPermissions(app.id, actionPermissions.value)
  const refreshed = await externalAppService.get(app.id)
  if (refreshed) actionApp.value = refreshed
  await reload()
  notice.value = 'APP 权限范围已更新；被关闭的权限立即失效。'
  emit('changed')
}

async function revokeAppPermissions(app: InstalledExternalApp): Promise<void> {
  await externalAppService.revokePersistentPermission(app.id)
  await refreshAction()
  notice.value = `已撤销“${app.manifest.name}”的后续权限授权；下次调用会重新询问。`
}

async function exportApp(app: InstalledExternalApp): Promise<void> {
  const file = await externalAppService.exportPackage(app.id)
  await downloadBlob(file, file.name)
  notice.value = `已导出“${app.manifest.name}”的 .srlapp 包。`
}

async function exportPreviewPackage(): Promise<void> {
  if (!preview.value || installing.value) return
  installing.value = true
  errorMessage.value = ''
  try {
    preview.value.manifest.name =
      previewName.value.trim().slice(0, 80) || preview.value.manifest.name
    preview.value.iconDataUrl = previewIcon.value
    const file = await externalAppService.exportPreviewPackage(preview.value)
    await downloadBlob(file, file.name)
    notice.value = '已生成 .srlapp 安装包；尚未安装到本机。'
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '无法生成安装包'
  } finally {
    installing.value = false
  }
}

function connectPreview(): void {
  trialSession.disconnect()
  const target = previewFrame.value?.contentWindow
  if (!target) return
  if (
    previewRuntimeMode.value === EXTERNAL_APP_RUNTIME_MODE.TRUSTED_COMPATIBLE &&
    previewFrame.value &&
    seedOpaquePreviewDocument(previewFrame.value, trialHtml.value)
  )
    return
  trialSession.connect(target)
}

function stopPreview(): void {
  showPreview.value = false
  trialSession.disconnect()
  trialHtml.value = ''
  trialLoading.value = ''
}

function startPreview(): void {
  if (!preview.value) return
  stopPreview()
  trialError.value = ''
  trialMessages.value = []
  trialStatus.value = '正在加载试运行页面'
  try {
    trialHtml.value =
      previewRuntimeMode.value === EXTERNAL_APP_RUNTIME_MODE.TRUSTED_COMPATIBLE
        ? preview.value.compatibleRuntimeHtml
        : preview.value.runtimeHtml
    showPreview.value = true
    trialGeneration.value += 1
  } catch (error) {
    trialError.value = error instanceof Error ? error.message : '无法构建试运行页面'
    trialStatus.value = '无法试运行'
  }
}

watch(previewRuntimeMode, () => {
  if (showPreview.value) startPreview()
})

function choosePreviewIcon(): void {
  previewIconInput.value?.click()
}

async function readPreviewIcon(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (!file.type.startsWith('image/') || file.size > 1024 * 1024) {
    errorMessage.value = '请选择不超过 1 MiB 的图片文件'
    return
  }
  errorMessage.value = ''
  try {
    previewIcon.value = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result ?? ''))
      reader.onerror = () => reject(new Error('无法读取图标图片'))
      reader.readAsDataURL(file)
    })
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '无法读取图标图片'
  }
}

async function selectSourceFile(app: InstalledExternalApp, event: Event): Promise<void> {
  const input = event.target as HTMLSelectElement
  if (!(await leaveSection())) {
    input.value = sourcePath.value
    return
  }
  sourcePath.value = input.value
  sourceText.value = sourcePath.value
    ? new TextDecoder().decode(app.packageFiles?.[sourcePath.value])
    : ''
}

async function saveSourceFile(app: InstalledExternalApp): Promise<void> {
  if (!sourcePath.value) return
  errorMessage.value = ''
  try {
    const updated = await externalAppService.updateSourceFile(
      app.id,
      sourcePath.value,
      sourceText.value,
    )
    actionApp.value = updated
    await reload()
    notice.value = `已保存 ${sourcePath.value}；APP 运行代码已重新构建，持久权限会重新确认。`
    emit('changed')
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '保存 APP 源码失败'
  }
}

async function savePresentation(app: InstalledExternalApp): Promise<void> {
  errorMessage.value = ''
  try {
    await externalAppService.updatePresentation(app.id, actionName.value, actionIcon.value)
    await reload()
    const refreshed = await externalAppService.get(app.id)
    if (refreshed) actionApp.value = refreshed
    notice.value = 'APP 名称和图标已保存。'
    emit('changed')
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '保存 APP 外观失败'
  }
}

function chooseAppIcon(): void {
  iconInput.value?.click()
}

async function readAppIcon(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (!file.type.startsWith('image/')) {
    errorMessage.value = '请选择图片文件'
    return
  }
  if (file.size > 1024 * 1024) {
    errorMessage.value = '图标图片不能超过 1 MiB'
    return
  }
  errorMessage.value = ''
  try {
    actionIcon.value = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result ?? ''))
      reader.onerror = () => reject(new Error('无法读取图标图片'))
      reader.readAsDataURL(file)
    })
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '无法读取图标图片'
  }
}

async function toggleApp(app: InstalledExternalApp): Promise<void> {
  errorMessage.value = ''
  try {
    await externalAppService.setEnabled(app.id, !app.enabled)
    await refreshAction()
    emit('changed')
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '更新 APP 状态失败'
  }
}

async function saveRuntimeMode(app: InstalledExternalApp): Promise<void> {
  await externalAppService.setRuntimeMode(app.id, actionMode.value)
  const refreshed = await externalAppService.get(app.id)
  if (refreshed) actionApp.value = refreshed
  await reload()
  notice.value = '运行模式已保存；可返回管理首页打开 APP 测试，资源权限会按需重新询问。'
  emit('changed')
}

async function exportAppData(appId: string): Promise<void> {
  const file = await externalAppService.exportData(appId)
  await downloadBlob(file, file.name)
  notice.value = '已导出 APP 数据。文件可能包含此 APP 保存的私有内容，请自行保管。'
}

async function clearRetainedData(data: RetainedExternalAppData): Promise<void> {
  if (
    !(await confirmAction({
      title: '清除已卸载 APP 的数据',
      message: `清除 ${data.appId} 的 ${data.dataEntries} 项数据（${formatBytes(data.dataBytes)}）吗？清除后无法通过重装恢复，资源库不受影响。`,
      confirmLabel: '清除数据',
      danger: true,
    }))
  )
    return
  await externalAppService.clearRetainedData(data.appId)
  await reload()
  notice.value = '已清除所选 APP 的保留数据。'
}

async function uninstallApp(app: InstalledExternalApp): Promise<void> {
  const confirmed = await confirmAction({
    title: '卸载第三方 APP',
    message: `卸载“${app.manifest.name}”吗？只会移除 APP；它的本地数据会保留，资源库不受影响。`,
    confirmLabel: '卸载 APP',
    danger: true,
  })
  if (!confirmed) return
  errorMessage.value = ''
  try {
    await externalAppService.uninstall(app.id)
    await reload()
    emit('changed')
    actionApp.value = undefined
    notice.value = `已卸载“${app.manifest.name}”，本地数据仍保留。`
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '卸载 APP 失败'
  }
}

async function clearAppData(app: InstalledExternalApp): Promise<void> {
  const confirmed = await confirmAction({
    title: '清除 APP 数据',
    message: `清除“${app.manifest.name}”保存的本地数据吗？此操作无法撤销，不会删除 APP，也不会影响资源库。`,
    confirmLabel: '清除数据',
    danger: true,
  })
  if (!confirmed) return
  errorMessage.value = ''
  try {
    await externalAppService.clearData(app.id)
    actionHealth.value = await externalAppService.getHealth(app.id)
    notice.value = `已清除“${app.manifest.name}”的本地数据。`
    await reload()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '清除 APP 数据失败'
  }
}
</script>

<template>
  <main
    class="external-app-manager"
    data-srl-controls
    :class="{ 'external-app-manager--dragging': dragActive }"
    tabindex="0"
    @dragover="handleDragOver"
    @dragleave="handleDragLeave"
    @drop="handleDrop"
    @paste="handlePaste"
  >
    <FeatureAppHeader title="扩展" back-label="返回功能桌面" @back="emit('back')">
      <template #actions>
        <button
          class="feature-header-action external-app-manager__add"
          type="button"
          aria-label="添加第三方 APP"
          data-assistant-focus="extensions-import"
          :disabled="installing || actionBusy || !!preview || !!actionApp"
          @click="headerMoreOpen = true"
        >
          添加 APP
        </button>
      </template>
    </FeatureAppHeader>
    <ActionSheet
      v-model:open="headerMoreOpen"
      title="添加第三方 APP"
      :actions="headerMoreActions"
      @select="selectHeaderMore"
    />
    <input
      ref="fileInput"
      class="external-app-manager__file"
      type="file"
      accept=".srlapp,.zip,.html,.htm,application/zip,text/html"
      multiple
      @change="inspectPackage"
    />
    <input
      ref="folderInput"
      class="external-app-manager__file"
      type="file"
      multiple
      webkitdirectory
      @change="inspectPackage"
    />
    <input
      ref="previewIconInput"
      class="external-app-manager__file"
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
      @change="readPreviewIcon"
    />
    <input
      ref="iconInput"
      class="external-app-manager__file"
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
      @change="readAppIcon"
    />
    <section
      v-if="!preview && !actionApp && (notice || errorMessage || installing || actionBusy)"
      class="external-app-manager__notice"
      aria-live="polite"
    >
      <p v-if="installing" role="status">正在检查安装文件…</p>
      <p v-else-if="actionBusy" role="status">正在处理…</p>
      <p v-if="notice" class="external-app-manager__notice--success" role="status">{{ notice }}</p>
      <p v-if="errorMessage" class="external-app-manager__notice--error" role="alert">
        {{ errorMessage }}
      </p>
      <div v-if="installedApp" class="external-app-manager__success-actions">
        <button type="button" :disabled="!installedApp.enabled" @click="openApp(installedApp)">
          打开 APP
        </button>
        <button type="button" @click="emit('back')">返回功能桌面</button>
        <span v-if="!installedApp.enabled">此 APP 保持禁用，可在管理中重新启用。</span>
      </div>
    </section>
    <section v-if="apps.length" class="external-app-manager__list" aria-label="已安装第三方 APP">
      <button
        v-for="app in apps"
        :key="app.id"
        class="external-app-card"
        :class="{ 'external-app-card--disabled': !app.enabled }"
        type="button"
        :disabled="installing || actionBusy || !!preview || !!actionApp"
        @click="openAppActions(app)"
      >
        <img v-if="app.iconDataUrl" class="external-app-card__icon" :src="app.iconDataUrl" alt="" />
        <span v-else class="external-app-card__badge" aria-hidden="true">{{
          app.manifest.name.slice(0, 1)
        }}</span>
        <span class="external-app-card__copy"
          ><strong>{{ app.manifest.name }}</strong
          ><small
            >v{{ app.manifest.version }} · {{ app.enabled ? '已启用' : '已禁用' }}</small
          ></span
        >
        <span class="external-app-card__manage">管理</span>
      </button>
    </section>
    <section v-else-if="!installing" class="external-app-manager__empty">
      <strong>还没有第三方 APP</strong>
      <p>添加 HTML、静态网页 ZIP、文件夹或 .srlapp 安装包。</p>
      <button type="button" :disabled="actionBusy" @click="choosePackage">选择安装文件</button>
    </section>
    <details v-if="retainedData.length" class="external-app-manager__retained">
      <summary>已卸载 APP 的保留数据（{{ retainedData.length }}）</summary>
      <p>重装相同 APP ID 后可继续使用。导出数据不包含 APP 代码。</p>
      <article v-for="data in retainedData" :key="data.appId">
        <div>
          <code>{{ data.appId }}</code
          ><small>{{ data.dataEntries }} 项 · {{ formatBytes(data.dataBytes) }}</small>
        </div>
        <div class="external-app-manager__button-row">
          <button
            type="button"
            :disabled="installing || actionBusy || !!preview || !!actionApp"
            @click="runAction(() => exportAppData(data.appId))"
          >
            导出数据</button
          ><button
            class="external-app-manager__danger"
            type="button"
            :disabled="installing || actionBusy || !!preview || !!actionApp"
            @click="runAction(() => clearRetainedData(data))"
          >
            清除数据
          </button>
        </div>
      </article>
    </details>
    <Teleport to="body">
      <div v-if="preview" class="external-app-manager__overlay" @click.self="closeOverlay">
        <section
          ref="overlayPanel"
          class="external-app-manager__panel external-app-manager__preview"
          data-srl-controls
          data-srl-dialog
          role="dialog"
          aria-modal="true"
          aria-label="安装确认"
          tabindex="-1"
        >
          <FeatureAppHeader
            title="安装确认"
            layout="panel"
            back-label="取消安装"
            :back-disabled="installing"
            @back="closeOverlay"
          />
          <div class="external-app-manager__panel-body">
            <div class="external-app-manager__app-summary">
              <img v-if="previewIcon" :src="previewIcon" alt="" />
              <div>
                <h2>{{ previewName || preview.manifest.name }}</h2>
                <p>
                  v{{ preview.manifest.version
                  }}{{ preview.manifest.author ? ` · ${preview.manifest.author}` : '' }}
                </p>
              </div>
            </div>
            <p v-if="preview.manifest.description" class="external-app-manager__description">
              {{ preview.manifest.description }}
            </p>
            <section
              v-if="preview.generatedManifest"
              class="external-app-manager__field-group"
              aria-label="安装目标"
            >
              <label
                ><span>安装方式</span
                ><select v-model="updateAppId" :disabled="installing" @change="configureInstall">
                  <option value="">按当前网页身份安装</option>
                  <option v-for="app in apps" :key="app.id" :value="app.id">
                    更新“{{ app.manifest.name }}” · v{{ app.manifest.version }}
                  </option>
                </select></label
              >
              <label v-if="htmlEntries.length > 1"
                ><span>启动页面</span
                ><select v-model="previewEntry" :disabled="installing" @change="configureInstall">
                  <option v-for="entry in htmlEntries" :key="entry" :value="entry">
                    {{ entry }}
                  </option>
                </select></label
              >
              <p>网页内容变化后会生成新身份；需要延续旧数据时，请选择更新已有 APP。</p>
            </section>
            <section
              v-if="preview.previousInstallation"
              class="external-app-manager__update-summary"
              aria-label="版本变化"
            >
              <strong>{{ preview.contentChanged ? '将更新已有 APP' : '此安装包已安装' }}</strong>
              <p>
                {{ preview.previousInstallation.name }}：v{{
                  preview.previousInstallation.version
                }}
                → v{{ preview.manifest.version }}
              </p>
              <p>保留已有 APP 数据及启用状态，旧代码将被替换。</p>
              <p v-if="preview.contentChanged">包内容已变化；实际调用时会重新确认已记住的授权。</p>
              <p v-if="preview.addedPermissions?.length">
                新增或重新申请：{{
                  preview.addedPermissions
                    .map((permission) => EXTERNAL_APP_PERMISSION_LABELS[permission])
                    .join('、')
                }}
              </p>
            </section>
            <section class="external-app-manager__runtime-mode" aria-label="运行模式">
              <h3>运行模式</h3>
              <label
                ><input
                  v-model="previewRuntimeMode"
                  type="radio"
                  :value="EXTERNAL_APP_RUNTIME_MODE.ISOLATED"
                  :disabled="installing"
                /><span
                  ><strong>标准隔离</strong
                  ><small>仅使用本地文件，阻止外部资源和网络。</small></span
                ></label
              >
              <label
                ><input
                  v-model="previewRuntimeMode"
                  type="radio"
                  :value="EXTERNAL_APP_RUNTIME_MODE.TRUSTED_COMPATIBLE"
                  :disabled="installing"
                /><span
                  ><strong>信任兼容</strong
                  ><small
                    >允许 HTTPS 外部资源和网络。第三方站点可能收到请求；仍无法直接访问 SRL
                    账号和数据。</small
                  ></span
                ></label
              >
            </section>
            <section
              v-if="preview.requestedPermissions.length"
              class="external-app-manager__permissions"
              aria-label="APP 能力范围"
            >
              <h3>允许 APP 申请的能力</h3>
              <p>勾选的是能力上限。访问资源、文件或设备时仍会显示具体请求；关闭后不能申请。</p>
              <div class="external-app-manager__permission-list">
                <label v-for="permission in preview.requestedPermissions" :key="permission"
                  ><input
                    v-model="selectedPermissions"
                    type="checkbox"
                    :value="permission"
                    :disabled="installing"
                  /><span>{{ EXTERNAL_APP_PERMISSION_LABELS[permission] }}</span></label
                >
              </div>
            </section>
            <p v-else class="external-app-manager__muted">未申请资源库、文件或设备能力。</p>
            <section
              v-if="
                preview.compatibility.some((item) =>
                  ['external-or-absolute-path', 'session-storage', 'isolated-persistence'].includes(
                    item.code,
                  ),
                )
              "
              class="external-app-manager__compatibility"
              aria-label="运行注意事项"
            >
              <h3>运行注意事项</h3>
              <p
                v-for="item in preview.compatibility.filter((item) =>
                  ['external-or-absolute-path', 'session-storage', 'isolated-persistence'].includes(
                    item.code,
                  ),
                )"
                :key="item.code"
              >
                {{ item.message }}
              </p>
            </section>
            <div class="external-app-manager__trial-toolbar">
              <button
                type="button"
                :disabled="installing"
                @click="showPreview ? stopPreview() : startPreview()"
              >
                {{ showPreview ? '结束试运行' : '试运行' }}</button
              ><span>不访问真实资源，不保存数据。</span>
            </div>
            <section
              v-if="showPreview || trialError"
              class="external-app-manager__trial"
              aria-label="安装前试运行"
            >
              <p role="status">{{ trialLoading || trialStatus }}</p>
              <p v-if="trialError" class="external-app-manager__notice--error" role="alert">
                {{ trialError }}
              </p>
              <iframe
                v-if="showPreview"
                :key="trialGeneration"
                ref="previewFrame"
                :srcdoc="
                  previewRuntimeMode === EXTERNAL_APP_RUNTIME_MODE.TRUSTED_COMPATIBLE
                    ? undefined
                    : trialHtml
                "
                :src="
                  previewRuntimeMode === EXTERNAL_APP_RUNTIME_MODE.TRUSTED_COMPATIBLE
                    ? OPAQUE_PREVIEW_DOCUMENT_URL
                    : undefined
                "
                sandbox="allow-scripts"
                referrerpolicy="no-referrer"
                :title="`${preview.manifest.name} 安装前试运行`"
                @load="connectPreview"
                @error="trialError = '试运行页面加载失败'"
              />
              <details v-if="trialMessages.length">
                <summary>试运行消息（{{ trialMessages.length }}）</summary>
                <p v-for="(message, index) in trialMessages" :key="index">{{ message }}</p>
              </details>
              <p>需要真实资源或设备的功能，请安装后测试。试运行成功不代表所有功能均兼容。</p>
            </section>
            <details class="external-app-manager__install-identity">
              <summary>名称与图标</summary>
              <div class="external-app-manager__field-group">
                <label
                  ><span>名称</span
                  ><input v-model="previewName" maxlength="80" :disabled="installing"
                /></label>
                <button type="button" :disabled="installing" @click="choosePreviewIcon">
                  更换图标图片
                </button>
                <details>
                  <summary>使用图片 URL</summary>
                  <label
                    ><span>图标 URL</span
                    ><input
                      v-model="previewIcon"
                      inputmode="url"
                      placeholder="保持默认或输入 HTTPS 图片 URL"
                      :disabled="installing"
                  /></label>
                  <p>链接图标只用于本机显示；导出安装包请上传图片。</p>
                </details>
              </div>
            </details>
            <details class="external-app-manager__package-details">
              <summary>安装文件与检查详情</summary>
              <p>入口：{{ preview.manifest.entry }}</p>
              <p>
                {{ Object.keys(preview.packageFiles ?? {}).length }} 个文件 ·
                {{ formatBytes(preview.packageBytes) }}
              </p>
              <p>APP ID：{{ preview.manifest.id }}</p>
              <p
                v-for="item in preview.compatibility.filter(
                  (item) =>
                    ![
                      'external-or-absolute-path',
                      'session-storage',
                      'isolated-persistence',
                    ].includes(item.code),
                )"
                :key="item.code"
              >
                {{ item.message }}
              </p>
              <button
                v-if="preview.sourceKind !== 'srlapp'"
                type="button"
                :disabled="installing"
                @click="exportPreviewPackage"
              >
                生成 .srlapp 安装包
              </button>
            </details>
          </div>
          <footer class="external-app-manager__panel-footer">
            <p v-if="notice" role="status">{{ notice }}</p>
            <p v-if="errorMessage" class="external-app-manager__notice--error" role="alert">
              {{ errorMessage }}
            </p>
            <div class="external-app-manager__preview-actions">
              <button type="button" :disabled="installing" @click="cancelPreview">取消</button
              ><button
                class="external-app-manager__confirm"
                type="button"
                :disabled="installing || !previewName.trim()"
                @click="confirmInstall"
              >
                {{ installing ? '正在处理…' : installLabel }}
              </button>
            </div>
          </footer>
        </section>
      </div>
      <div v-if="actionApp" class="external-app-manager__overlay" @click.self="closeOverlay">
        <section
          ref="overlayPanel"
          class="external-app-manager__panel external-app-manager__action-sheet"
          data-srl-controls
          data-srl-dialog
          role="dialog"
          aria-modal="true"
          :aria-label="`${actionApp.manifest.name} · ${sectionTitles[actionSection]}`"
          tabindex="-1"
        >
          <FeatureAppHeader
            :title="sectionTitles[actionSection]"
            layout="panel"
            :back-label="
              actionSection === 'overview'
                ? '关闭 APP 管理'
                : actionHistory.at(-1) === 'more'
                  ? '返回更多操作'
                  : '返回 APP 管理'
            "
            :back-disabled="actionBusy"
            @back="closeOverlay"
          />
          <div class="external-app-manager__panel-body">
            <div v-if="actionSection === 'overview'" class="external-app-manager__app-summary">
              <img v-if="actionApp.iconDataUrl" :src="actionApp.iconDataUrl" alt="" />
              <span v-else class="external-app-card__badge" aria-hidden="true">{{
                actionApp.manifest.name.slice(0, 1)
              }}</span>
              <div>
                <h2>{{ actionApp.manifest.name }}</h2>
                <p>
                  v{{ actionApp.manifest.version }} · {{ actionApp.enabled ? '已启用' : '已禁用' }}
                </p>
              </div>
            </div>
            <template v-if="actionSection === 'overview'">
              <p
                v-if="actionHealth?.disabledByWatchdog"
                class="external-app-manager__notice--error"
              >
                多次运行异常后已自动停用。可查看诊断，再决定是否重新启用。
              </p>
              <div class="external-app-manager__launch-actions">
                <button
                  class="external-app-manager__confirm"
                  type="button"
                  :disabled="!actionApp.enabled || actionBusy"
                  @click="openApp(actionApp)"
                >
                  打开 APP</button
                ><button
                  type="button"
                  :disabled="actionBusy"
                  @click="runAction(() => toggleApp(actionApp!))"
                >
                  {{ actionApp.enabled ? '禁用 APP' : '启用 APP' }}
                </button>
              </div>
              <div class="external-app-manager__menu" aria-label="APP 操作">
                <button type="button" :disabled="actionBusy" @click="openSection('more')">
                  <span>更多操作<small>名称、权限、运行与源码</small></span>
                  <span aria-hidden="true">›</span>
                </button>
                <button type="button" :disabled="actionBusy" @click="openSection('data')">
                  <span
                    >数据与卸载<small
                      >{{ formatBytes(actionHealth?.dataBytes ?? 0) }} ·
                      {{ actionHealth?.dataEntries ?? 0 }} 项数据</small
                    ></span
                  >
                  <span aria-hidden="true">›</span>
                </button>
              </div>
            </template>
            <section
              v-else-if="actionSection === 'more'"
              id="external-app-more-options"
              class="external-app-manager__menu"
              aria-label="更多操作"
            >
              <button type="button" :disabled="actionBusy" @click="openSection('identity')">
                名称与图标 <span>›</span>
              </button>
              <button type="button" :disabled="actionBusy" @click="openSection('permissions')">
                权限管理 <span>›</span>
              </button>
              <button type="button" :disabled="actionBusy" @click="openSection('runtime')">
                运行设置 <span>›</span>
              </button>
              <button
                v-if="editablePaths.length"
                type="button"
                :disabled="actionBusy"
                @click="openSection('source')"
              >
                源码编辑 <span>›</span>
              </button>
              <button type="button" :disabled="actionBusy" @click="openSection('health')">
                运行诊断 <span>›</span>
              </button>
              <button
                type="button"
                :disabled="actionBusy"
                @click="runAction(() => exportApp(actionApp!))"
              >
                导出为 .srlapp
              </button>
            </section>
            <section
              v-else-if="actionSection === 'data'"
              id="external-app-data-options"
              class="external-app-manager__data"
              aria-label="数据与卸载"
            >
              <div class="external-app-manager__data-size">
                <strong>{{ formatBytes(actionHealth?.dataBytes ?? 0) }}</strong
                ><span>{{ actionHealth?.dataEntries ?? 0 }} 项 APP 数据</span>
              </div>
              <p class="external-app-manager__muted">数据存放在本机。以下操作均不影响资源库。</p>
              <div class="external-app-manager__menu">
                <button
                  type="button"
                  :disabled="actionBusy"
                  @click="runAction(() => exportAppData(actionApp!.id))"
                >
                  <span>导出 APP 数据<small>保存为 JSON 文件</small></span
                  ><span aria-hidden="true">↓</span>
                </button>
                <button
                  class="external-app-manager__danger"
                  type="button"
                  :disabled="actionBusy"
                  @click="runAction(() => clearAppData(actionApp!))"
                >
                  <span>清除 APP 数据<small>重置此 APP，无法撤销</small></span
                  ><span aria-hidden="true">›</span>
                </button>
                <button
                  class="external-app-manager__danger"
                  type="button"
                  :disabled="actionBusy"
                  @click="runAction(() => uninstallApp(actionApp!))"
                >
                  <span>卸载 APP（保留数据）<small>移除程序，重新安装后可继续使用数据</small></span
                  ><span aria-hidden="true">›</span>
                </button>
              </div>
            </section>
            <section
              v-else-if="actionSection === 'identity'"
              class="external-app-manager__identity external-app-manager__field-group"
              aria-label="APP 名称和图标"
            >
              <label
                ><span>名称</span><input v-model="actionName" maxlength="80" :disabled="actionBusy"
              /></label>
              <div class="external-app-manager__icon-picker">
                <img v-if="actionIcon" :src="actionIcon" alt="当前图标" /><button
                  type="button"
                  :disabled="actionBusy"
                  @click="chooseAppIcon"
                >
                  更换图标图片
                </button>
              </div>
              <details>
                <summary>使用图片 URL</summary>
                <label
                  ><span>图标 URL</span
                  ><input
                    v-model="actionIcon"
                    inputmode="url"
                    placeholder="https://…"
                    :disabled="actionBusy"
                /></label>
                <p>链接图标只用于本机显示；导出安装包请上传图片。</p>
              </details>
              <button
                type="button"
                :disabled="actionBusy || !draftChanged"
                @click="runAction(() => savePresentation(actionApp!))"
              >
                保存名称与图标
              </button>
            </section>
            <section
              v-else-if="actionSection === 'permissions'"
              class="external-app-manager__permission-editor"
              aria-label="APP 权限"
            >
              <h3>允许申请的能力</h3>
              <p>关闭后禁止对应调用；勾选不等于已授权。访问资源、文件或设备时会显示具体请求。</p>
              <div
                v-if="actionApp.manifest.permissions?.length"
                class="external-app-manager__permission-list"
              >
                <label v-for="permission in actionApp.manifest.permissions" :key="permission"
                  ><input
                    v-model="actionPermissions"
                    type="checkbox"
                    :value="permission"
                    :disabled="actionBusy"
                  /><span>{{ EXTERNAL_APP_PERMISSION_LABELS[permission] }}</span></label
                >
              </div>
              <p v-else>作者未声明额外能力。</p>
              <button
                type="button"
                :disabled="actionBusy || !draftChanged"
                @click="runAction(() => saveAllowedPermissions(actionApp!))"
              >
                保存能力范围
              </button>
              <h3>已记住的授权</h3>
              <ul v-if="actionApp.persistentPermissionGrants?.length">
                <li v-for="permission in actionApp.persistentPermissionGrants" :key="permission">
                  {{ EXTERNAL_APP_PERMISSION_LABELS[permission] }}
                </li>
              </ul>
              <p v-else>没有已记住的授权。</p>
              <button
                type="button"
                :disabled="actionBusy || !actionApp.persistentPermissionGrants?.length"
                @click="runAction(() => revokeAppPermissions(actionApp!))"
              >
                撤销已记住的授权
              </button>
              <details v-if="actionApp.permissionAudit?.length">
                <summary>最近权限记录（{{ actionApp.permissionAudit.length }}）</summary>
                <ul>
                  <li v-for="(entry, index) in actionApp.permissionAudit" :key="index">
                    {{ permissionDecisions[entry.decision] }} ·
                    {{ EXTERNAL_APP_PERMISSION_LABELS[entry.permission] }} · {{ entry.summary }}
                  </li>
                </ul>
              </details>
            </section>
            <section
              v-else-if="actionSection === 'runtime'"
              class="external-app-manager__runtime-mode"
              aria-label="运行设置"
            >
              <label
                ><input
                  v-model="actionMode"
                  type="radio"
                  :value="EXTERNAL_APP_RUNTIME_MODE.ISOLATED"
                  :disabled="actionBusy"
                /><span
                  ><strong>标准隔离</strong
                  ><small>仅使用本地文件，阻止外部资源和网络。</small></span
                ></label
              >
              <label
                ><input
                  v-model="actionMode"
                  type="radio"
                  :value="EXTERNAL_APP_RUNTIME_MODE.TRUSTED_COMPATIBLE"
                  :disabled="actionBusy"
                /><span
                  ><strong>信任兼容</strong
                  ><small
                    >允许 HTTPS 外部资源和网络；第三方站点可能收到请求。不会获得 SRL
                    账号和数据。</small
                  ></span
                ></label
              >
              <p>切换模式保留 APP 数据，并清除已记住的授权。保存后可返回管理首页打开 APP 测试。</p>
              <button
                type="button"
                :disabled="actionBusy || !draftChanged"
                @click="runAction(() => saveRuntimeMode(actionApp!))"
              >
                保存运行模式
              </button>
            </section>
            <section
              v-else-if="actionSection === 'source'"
              class="external-app-manager__source"
              aria-label="源码编辑"
            >
              <p>修改后重新构建运行代码，清除已记住的授权。导出的安装包会包含你的修改。</p>
              <label
                ><span>文件</span
                ><select
                  :value="sourcePath"
                  :disabled="actionBusy"
                  @change="selectSourceFile(actionApp, $event)"
                >
                  <option v-for="path in editablePaths" :key="path" :value="path">
                    {{ path }}
                  </option>
                </select></label
              >
              <textarea
                v-model="sourceText"
                aria-label="APP 文件源码"
                spellcheck="false"
                :disabled="actionBusy"
              />
              <button
                type="button"
                :disabled="actionBusy || !draftChanged"
                @click="runAction(() => saveSourceFile(actionApp!))"
              >
                保存源码
              </button>
            </section>
            <section
              v-else-if="actionSection === 'health'"
              class="external-app-manager__health"
              aria-label="APP 存储和健康状态"
            >
              <p>
                {{
                  actionApp.runtimeMode === EXTERNAL_APP_RUNTIME_MODE.TRUSTED_COMPATIBLE
                    ? '信任兼容模式'
                    : '标准隔离模式'
                }}
              </p>
              <p>安装文件 {{ formatBytes(actionHealth?.packageBytes ?? 0) }}</p>
              <p>
                APP 数据 {{ formatBytes(actionHealth?.dataBytes ?? 0) }} /
                {{ formatBytes(actionHealth?.dataLimitBytes ?? 1024 * 1024) }} ·
                {{ actionHealth?.dataEntries ?? 0 }} 项
              </p>
              <p>
                数据保存在{{ appDataStorageLocation }}。普通网页的 localStorage/sessionStorage
                只在当前打开期间有效，长期数据需要使用 srlApp.storage。
              </p>
              <p v-if="actionHealth?.lastLaunchedAt">
                最近启动：{{ new Date(actionHealth.lastLaunchedAt).toLocaleString() }}
              </p>
              <p v-if="actionHealth?.lastError" class="external-app-manager__notice--error">
                最近异常（连续 {{ actionHealth.consecutiveFailures }} 次）：{{
                  actionHealth.lastError
                }}
              </p>
              <p v-else>暂无记录到的运行异常。</p>
              <p>
                缺少素材请重新导入完整 ZIP
                或文件夹；外部资源被阻止时可调整运行模式；脚本报错可查看源码或联系 APP 作者。
              </p>
            </section>
          </div>
          <footer
            v-if="notice || errorMessage || actionBusy"
            class="external-app-manager__panel-footer"
            aria-live="polite"
          >
            <p v-if="notice" role="status">{{ notice }}</p>
            <p v-if="errorMessage" class="external-app-manager__notice--error" role="alert">
              {{ errorMessage }}
            </p>
            <p v-if="actionBusy" role="status">正在处理…</p>
          </footer>
        </section>
      </div>
    </Teleport>
  </main>
</template>

<style scoped src="../styles/ExternalAppManager.css"></style>
<style>
html.external-app-manager-open {
  overflow: hidden;
}
</style>
