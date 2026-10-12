<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { externalAppSdkService, externalAppService } from '../core/AppContainer'
import { SRL_BACK_REQUEST_EVENT, type SrlBackRequestDetail } from '../composables/UseBackStack'
import { usePreviewBudget } from '../composables/UsePreviewBudget'
import type { ExternalAppResourceSnapshot } from '../services/ExternalAppSdkService'
import { ExternalAppToolSession } from '../services/ExternalAppToolSession'
import { customToolMethodPermissions } from '../services/ExternalAppTools'
import { RESOURCE_TYPE_LABELS } from '../types/Resource'
import {
  EXTERNAL_APP_PERMISSION,
  EXTERNAL_APP_PERMISSION_LABELS,
  type ExternalAppPermission,
  type InstalledExternalApp,
  type InstalledExternalAppSummary,
  type ExternalAppToolDescriptor,
} from '../types/ExternalApp'
import FeatureAppHeader from './FeatureAppHeader.vue'
import ChatReaderStartup from './ChatReaderStartup.vue'
import {
  chatReaderAppearance,
  readChatReaderColors,
  rememberChatReaderColors,
} from '../utils/ChatReaderAppearance'
import { CHAT_READER_APP_ID } from '../core/ChatReaderIdentity'
import { APPLIED_CSS_CHANGED_EVENT } from '../core/AppearanceScopes'
import {
  OPAQUE_PREVIEW_DOCUMENT_URL,
  resetOpaquePreviewDocument,
  seedOpaquePreviewDocument,
} from '../utils/OpaquePreviewDocument'
import { downloadBlob } from '../utils/LibraryFormatting'

const ChatReaderFullPreview = defineAsyncComponent(() => import('./ChatReaderFullPreview.vue'))
const chatPreview = ref<{
  source: string
  title: string
  remote: boolean
  snapshot: import('../utils/RenderCompatibilityRuntime').ArchivedMessageSnapshot
}>()

const props = defineProps<{
  appId: string
  official?: boolean
  assistantTool?: ExternalAppToolDescriptor
}>()
const emit = defineEmits<{ back: [] }>()
const isBuiltinReader = computed(
  () => props.official === true && props.appId === CHAT_READER_APP_ID,
)
let builtinReaderVerified = false
async function readerUiCss() {
  if (!isBuiltinReader.value) return ''
  const { readAppliedAppFrameCss } = await import('../services/AppearanceScopeService')
  return readAppliedAppFrameCss('chatReader')
}
async function syncReaderUiCss() {
  if (!isBuiltinReader.value) return
  const nonce = sessionNonce
  const css = await readerUiCss()
  if (!isBuiltinReader.value || nonce !== sessionNonce) return
  port?.postMessage({
    type: 'srl:reader-appearance',
    nonce,
    css,
  })
}
const readerPage = ref<'roles' | 'chats' | 'reader'>('roles')
const readerReady = ref(false)
const readerCover = ref(false)
const readerColors = ref(readChatReaderColors())
const startupColors = readChatReaderColors()
const readerAppearance = computed(() =>
  chatReaderAppearance(readerReady.value ? readerColors.value : startupColors),
)

function readerAction(action: 'back' | 'search' | 'cover'): void {
  if (action === 'back' && !port) {
    emit('back')
    return
  }
  port?.postMessage({ type: 'srl:reader-action', nonce: sessionNonce, action })
}

const app = ref<InstalledExternalApp>()
// A data document has a fresh opaque origin. Never combine this sandbox with host-origin srcdoc/blob.
// Compatible nested previews may share their own origin, while the library stays cross-origin.
const compatibleDocumentUrl = computed(() =>
  app.value?.runtimeMode === 'trustedCompatible' ? OPAQUE_PREVIEW_DOCUMENT_URL : undefined,
)

const errorMessage = ref('')
const notice = ref('')
const frame = ref<HTMLIFrameElement>()
const previewHost = ref<HTMLElement>()
const isFullscreen = ref(false)
const immersiveHint = ref(false)
const exitHandleVisible = ref(false)
const hostTitle = ref('')
const loadingLabel = ref('')
const fileInput = ref<HTMLInputElement>()
const resourcePicker = ref<{
  items: ExternalAppResourceSnapshot[]
  resolve: (resource: ExternalAppResourceSnapshot) => void
  reject: (reason: Error) => void
}>()
const resourceQuery = ref('')
const { previewEnabled } = usePreviewBudget(
  'external-app',
  computed(() => Boolean(app.value)),
  previewHost,
  () => isBuiltinReader.value,
)
const permissionRequest = ref<{
  appId: string
  permission: ExternalAppPermission
  method: string
  summary: string
  resolve: () => void
  reject: (reason: Error) => void
}>()
const permissionDialog = ref<HTMLDialogElement>()
watch(
  permissionRequest,
  (request) => {
    if (request) permissionDialog.value?.showModal()
  },
  { flush: 'post' },
)
const diagnostics = ref<Array<{ level: 'warn' | 'error'; message: string }>>([])
let port: MessagePort | undefined
const toolSession = new ExternalAppToolSession()
async function invokeTool(
  tool: ExternalAppToolDescriptor,
  args: string,
  signal: AbortSignal,
): Promise<unknown> {
  if (tool.appId !== props.appId || tool.id !== props.assistantTool?.id)
    throw new Error('工具不属于当前工作区')
  const current = await externalAppService.requireCustomTool(tool.id, tool.fingerprint)
  const result = await toolSession.invoke(current, args, signal)
  await externalAppService.requireCustomTool(tool.id, tool.fingerprint)
  return result
}
defineExpose({ invokeTool })
let sessionNonce = ''
let lastRequestSequence = 0
let startupTimer: number | undefined
let holdTimer: number | undefined
let exitHandleTimer: number | undefined
let pendingFilePick:
  | {
      accept: string
      multiple: boolean
      resolve: (files: File[]) => void
      reject: (reason: Error) => void
    }
  | undefined
const HOST_REQUEST_TIMEOUT_MS = 15_000
const STARTUP_TIMEOUT_MS = 12_000
const MAX_FILE_PICK_COUNT = 10
const MAX_FILE_PICK_BYTES = 25 * 1024 * 1024
const requestTimes: number[] = []
const SDK_REQUEST_WINDOW_MS = 10_000
const SDK_REQUEST_LIMIT = 60
const runtimeLabel = computed(() =>
  app.value
    ? `${props.official ? '内置 APP' : '本机 .srlapp'} · v${app.value.manifest.version}`
    : '正在准备阅读工作区',
)
const filteredPickableResources = computed(() => {
  const keyword = resourceQuery.value.trim().toLocaleLowerCase()
  return (resourcePicker.value?.items ?? []).filter(
    (resource) =>
      !keyword ||
      resource.name.toLocaleLowerCase().includes(keyword) ||
      resource.tags.some((tag) => tag.toLocaleLowerCase().includes(keyword)),
  )
})

async function load(): Promise<void> {
  readerReady.value = false
  errorMessage.value = ''
  notice.value = ''
  const next = await externalAppService.get(props.appId)
  if (props.assistantTool && next?.packageFingerprint !== props.assistantTool.fingerprint) {
    toolSession.close()
    errorMessage.value = 'APP 安装版本已变化，请返回聊天重新查询工具。'
    return
  }
  if (!next) {
    toolSession.close()
    app.value = undefined
    errorMessage.value = props.official
      ? '读了么未能加载，请返回 APP 管理重新下载。'
      : '这个第三方 APP 已被卸载。'
    return
  }
  if (!next.enabled) {
    toolSession.close()
    app.value = undefined
    errorMessage.value = props.official
      ? '读了么当前已停用，请返回后重新打开。'
      : '这个第三方 APP 当前已禁用。'
    return
  }
  app.value = next
  builtinReaderVerified = isBuiltinReader.value && externalAppService.isBuiltinReader(next)
  diagnostics.value = []
  hostTitle.value = ''
  loadingLabel.value = isBuiltinReader.value ? '正在打开读了么…' : '正在启动 APP…'
  setFullscreen(!props.assistantTool && next.manifest.immersive === true)
  if (next.manifest.orientation && next.manifest.orientation !== 'auto') {
    void screen.orientation?.lock(next.manifest.orientation).catch(() => {
      notice.value = '此设备未允许锁定屏幕方向，APP 将继续跟随系统方向。'
    })
  }
  if (startupTimer !== undefined) window.clearTimeout(startupTimer)
  clearHoldGesture()
  hideExitHandle()
  startupTimer = window.setTimeout(() => {
    if (loadingLabel.value && app.value?.id === next.id) {
      errorMessage.value = props.official
        ? '读了么启动超时，请返回后重新打开。'
        : '第三方 APP 启动超时：未在 12 秒内完成加载。可返回扩展管理后查看诊断或重新启动。'
      void externalAppService.recordRuntimeError(next.id, errorMessage.value)
    }
  }, STARTUP_TIMEOUT_MS)
  await externalAppService.recordLaunch(next.id)
}

function enforceSdkRateLimit(): void {
  const now = Date.now()
  while (requestTimes[0] !== undefined && now - requestTimes[0] > SDK_REQUEST_WINDOW_MS) {
    requestTimes.shift()
  }
  if (requestTimes.length >= SDK_REQUEST_LIMIT) {
    throw new Error('APP 请求过于频繁，已暂时限流以保护资源库；请稍后重试')
  }
  requestTimes.push(now)
}

async function reply(
  requestId: unknown,
  ok: boolean,
  value?: unknown,
  error?: string,
): Promise<void> {
  port?.postMessage({
    type: 'srl:response',
    nonce: sessionNonce,
    id: requestId,
    ok,
    ...(ok ? { value } : { error }),
  })
}

async function handleRequest(event: MessageEvent): Promise<void> {
  const request = event.data
  if (
    !request ||
    request.type !== 'srl:request' ||
    request.nonce !== sessionNonce ||
    typeof request.id !== 'string' ||
    !Number.isSafeInteger(request.sequence) ||
    request.sequence <= lastRequestSequence
  )
    return
  lastRequestSequence = request.sequence
  const current = app.value ? await externalAppService.getSummary(app.value.id) : undefined
  if (!current?.enabled) {
    await reply(request.id, false, undefined, 'APP 已被禁用')
    return
  }
  if (
    current.packageFingerprint !== app.value?.packageFingerprint ||
    current.runtimeMode !== app.value?.runtimeMode
  ) {
    await reply(request.id, false, undefined, 'APP 版本或运行模式已变化，请重新打开')
    return
  }
  try {
    enforceSdkRateLimit()
    if (props.assistantTool) {
      await externalAppService.requireCustomTool(
        props.assistantTool.id,
        props.assistantTool.fingerprint,
      )
      if (
        customToolMethodPermissions(request.method).some(
          (permission) => !props.assistantTool!.permissions.includes(permission),
        )
      )
        throw new Error('该接口超出当前工具声明的权限范围')
    }
    const task = (async () => {
      switch (request.method) {
        case 'storage.get':
          await reply(
            request.id,
            true,
            await externalAppService.getData(current.id, request.payload?.key),
          )
          return
        case 'storage.set':
          await externalAppService.setData(current.id, request.payload?.key, request.payload?.value)
          await reply(request.id, true, null)
          return
        case 'storage.remove':
          await externalAppService.removeData(current.id, request.payload?.key)
          await reply(request.id, true, null)
          return
        case 'sdk.capabilities':
          await reply(request.id, true, {
            ...(await externalAppSdkService.capabilities(
              current.id,
              props.assistantTool?.permissions,
            )),
            runtime: {
              builtinReader: isBuiltinReader.value,
              readerUiCss: await readerUiCss(),
              network: current.runtimeMode === 'trustedCompatible',
              sessionStorage: true,
              locks: true,
              fullscreen: true,
              haptics: Boolean(navigator.vibrate),
              filePicker: true,
              textShare: true,
              customTools: 'srl-app-tools@1',
            },
          })
          return
        case 'resources.list':
          await ensurePermission(
            current,
            EXTERNAL_APP_PERMISSION.RESOURCES_LIBRARY_READ,
            request.method,
            '读取资源库的轻量摘要；不会读取原始文件内容。',
          )
          await reply(
            request.id,
            true,
            await externalAppSdkService.list(current.id, request.payload, sessionNonce),
          )
          return
        case 'resources.get':
          await ensurePermission(
            current,
            EXTERNAL_APP_PERMISSION.RESOURCES_LIBRARY_READ,
            request.method,
            '定位指定资源，并读取其资源摘要。',
          )
          await ensurePermission(
            current,
            EXTERNAL_APP_PERMISSION.RESOURCES_CONTENT_READ,
            request.method,
            '读取指定资源的结构化 metadata；不会交出原始 Blob 或数据库对象。',
          )
          await reply(
            request.id,
            true,
            await externalAppSdkService.get(current.id, request.payload?.id),
          )
          return
        case 'chat.search':
        case 'chat.chapters':
        case 'chat.variables':
        case 'chat.style':
          await ensurePermission(
            current,
            EXTERNAL_APP_PERMISSION.RESOURCES_LIBRARY_READ,
            request.method,
            '定位指定聊天记录。',
          )
          await ensurePermission(
            current,
            EXTERNAL_APP_PERMISSION.RESOURCES_CONTENT_READ,
            request.method,
            '读取指定聊天的有限章节摘录、已保存变量差异，或所选美化的聊天 CSS。',
          )
          await reply(
            request.id,
            true,
            request.method === 'chat.variables'
              ? await externalAppSdkService.chatVariables(current.id, request.payload)
              : request.method === 'chat.chapters'
                ? await externalAppSdkService.chatChapters(current.id, request.payload)
                : request.method === 'chat.style'
                  ? await externalAppSdkService.readerStyle(current.id, request.payload)
                  : await externalAppSdkService.searchChat(current.id, request.payload),
          )
          return
        case 'chat.preview':
        case 'chat.read':
        case 'resources.thumbnail': {
          await ensurePermission(
            current,
            EXTERNAL_APP_PERMISSION.RESOURCES_LIBRARY_READ,
            request.method,
            '定位资源库中已保存的聊天记录或角色卡。',
          )
          await ensurePermission(
            current,
            EXTERNAL_APP_PERMISSION.RESOURCES_CONTENT_READ,
            request.method,
            '分批读取聊天原文，或读取角色卡缩略头像；不会复制整库。',
          )
          if (request.payload?.remote === true) {
            if (current.runtimeMode !== 'trustedCompatible')
              throw new Error('远程资源需要信任兼容模式')
            await ensurePermission(
              current,
              EXTERNAL_APP_PERMISSION.NETWORK_HTTPS,
              request.method,
              '加载该楼层内容中引用的远程图片、媒体或样式。',
            )
          }
          const value =
            request.method !== 'resources.thumbnail'
              ? await externalAppSdkService.readChat(
                  current.id,
                  request.method === 'chat.preview'
                    ? { ...request.payload, limit: 1 }
                    : request.payload,
                )
              : await externalAppSdkService.thumbnail(current.id, request.payload?.id)
          if (request.method === 'chat.preview' && value && 'messages' in value) {
            const entry = value.messages[0]
            if (!entry) throw new Error('该楼层不存在')
            chatPreview.value = {
              source: entry.displaySource,
              snapshot: entry.snapshot,
              title: `第 ${entry.index + 1} 楼`,
              remote: request.payload?.remote === true,
            }
            await reply(request.id, true, null)
          } else await reply(request.id, true, value)
          return
        }
        case 'chat.bind': {
          await ensurePermission(
            current,
            EXTERNAL_APP_PERMISSION.RESOURCES_LIBRARY_READ,
            request.method,
            '查找待绑定的聊天与角色。',
          )
          const source = await externalAppSdkService.list(current.id, {
            types: ['chat'],
            limit: 50,
          })
          const title =
            source.items.find((item) => item.id === request.payload?.id)?.name ??
            String(request.payload?.id)
          await ensurePermission(
            current,
            EXTERNAL_APP_PERMISSION.RESOURCES_WRITE,
            request.method,
            `将聊天“${title}”绑定到所选角色卡（${String(request.payload?.characterId)}），替换该聊天原有的角色关联。聊天原件不变。`,
          )
          await externalAppSdkService.bindChat(current.id, request.payload)
          await reply(request.id, true, null)
          return
        }
        case 'resources.pick':
          await ensurePermission(
            current,
            EXTERNAL_APP_PERMISSION.RESOURCES_SELECTED_READ,
            request.method,
            '打开资源选择器；只有你亲自选中的一项会交给 APP。',
          )
          if (
            props.assistantTool?.permissions.includes(
              EXTERNAL_APP_PERMISSION.RESOURCES_CONTENT_READ,
            )
          )
            await ensurePermission(
              current,
              EXTERNAL_APP_PERMISSION.RESOURCES_CONTENT_READ,
              request.method,
              '读取你选中资源的结构化内容，不交出原始文件或数据库对象。',
            )
          await reply(request.id, true, await requestResourcePick(current.id, request.payload))
          return
        case 'resources.update': {
          const updatePreview = await externalAppSdkService.describeUpdate(
            current.id,
            request.payload,
          )
          const details = updatePreview.changes.length
            ? updatePreview.changes
                .map(
                  (change) =>
                    `${change.field}：${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`,
                )
                .join('\n')
            : '请求不会改变字段值。'
          await ensurePermission(
            current,
            EXTERNAL_APP_PERMISSION.RESOURCES_WRITE,
            request.method,
            `修改“${updatePreview.resource.name}”的普通字段：\n${details}`,
          )
          await reply(
            request.id,
            true,
            await externalAppSdkService.update(current.id, request.payload),
          )
          return
        }
        case 'ui.notify': {
          const message =
            typeof request.payload?.message === 'string'
              ? request.payload.message.trim().slice(0, 240)
              : ''
          if (!message) throw new Error('通知内容不能为空')
          notice.value = message
          await reply(request.id, true, null)
          return
        }
        case 'ui.title': {
          const title =
            typeof request.payload?.title === 'string' ? request.payload.title.trim() : ''
          if (!title || title.length > 80) throw new Error('标题必须为 1 到 80 个字符')
          hostTitle.value = title
          await reply(request.id, true, null)
          return
        }
        case 'ui.loading': {
          const label =
            typeof request.payload?.label === 'string' ? request.payload.label.trim() : ''
          if (label.length > 120) throw new Error('加载提示不能超过 120 个字符')
          loadingLabel.value = label
          if (isBuiltinReader.value && !label) {
            rememberChatReaderColors(readerColors.value)
            readerReady.value = true
          }
          await reply(request.id, true, null)
          return
        }
        case 'device.vibrate': {
          await ensurePermission(
            current,
            EXTERNAL_APP_PERMISSION.DEVICE_HAPTICS,
            request.method,
            '触发一次不超过 300 毫秒的短震动反馈。',
          )
          const duration = Number(request.payload?.duration)
          if (!Number.isInteger(duration) || duration < 10 || duration > 300) {
            throw new Error('震动时长必须在 10 到 300 毫秒之间')
          }
          navigator.vibrate?.(duration)
          await reply(request.id, true, null)
          return
        }
        case 'files.pick': {
          await ensurePermission(
            current,
            EXTERNAL_APP_PERMISSION.FILES_IMPORT_EXPORT,
            request.method,
            '打开系统文件选择器；只有你亲自选中的文件会交给 APP。',
          )
          const accept =
            typeof request.payload?.accept === 'string' ? request.payload.accept.slice(0, 240) : ''
          const multiple = request.payload?.multiple === true
          const files = await requestFiles(accept, multiple)
          await reply(request.id, true, files)
          return
        }
        case 'files.share': {
          await ensurePermission(
            current,
            EXTERNAL_APP_PERMISSION.FILES_IMPORT_EXPORT,
            request.method,
            '将 APP 明确提供的文本导出到系统分享/保存面板。',
          )
          const name = typeof request.payload?.name === 'string' ? request.payload.name.trim() : ''
          const text = typeof request.payload?.text === 'string' ? request.payload.text : undefined
          if (!name || name.length > 120 || text === undefined || text.length > 512 * 1024) {
            throw new Error('分享内容无效或过大')
          }
          await downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), name)
          await reply(request.id, true, null)
          return
        }
        case 'ui.readerNavigation': {
          if (!isBuiltinReader.value) throw new Error('此接口仅供内置读了么使用')
          const page = request.payload?.page
          if (!['roles', 'chats', 'reader'].includes(page)) throw new Error('阅读页面无效')
          readerPage.value = page
          readerCover.value = request.payload?.cover === true
          const colors = request.payload?.colors
          for (const key of ['paper', 'ink', 'muted', 'line', 'accent', 'soft']) {
            const value = colors?.[key]
            if (typeof value === 'string' && /^#[\da-f]{6}$/iu.test(value))
              readerColors.value[key] = value
          }
          if (readerReady.value) rememberChatReaderColors(readerColors.value)
          await reply(request.id, true, null)
          return
        }
        case 'ui.consumeBack':
          await reply(request.id, true, null)
          return
        case 'ui.exitFullscreen':
          if (isBuiltinReader.value && readerPage.value === 'roles') emit('back')
          else if (isBuiltinReader.value) readerAction('back')
          else setFullscreen(false)
          await reply(request.id, true, null)
          return
        default:
          await reply(request.id, false, undefined, '不支持的 APP 接口')
      }
    })()
    await Promise.race([
      task,
      new Promise<never>((_resolve, reject) =>
        window.setTimeout(() => reject(new Error('APP 接口调用超时')), HOST_REQUEST_TIMEOUT_MS),
      ),
    ])
  } catch (error) {
    await reply(
      request.id,
      false,
      undefined,
      error instanceof Error ? error.message : 'APP 接口调用失败',
    )
  }
}

function requestFiles(accept: string, multiple: boolean): Promise<File[]> {
  if (pendingFilePick) return Promise.reject(new Error('已有文件选择请求正在等待'))
  return new Promise((resolve, reject) => {
    pendingFilePick = { accept, multiple, resolve, reject }
    const input = fileInput.value
    if (!input) {
      pendingFilePick = undefined
      reject(new Error('文件选择器不可用'))
      return
    }
    input.accept = accept
    input.multiple = multiple
    input.click()
  })
}

function completeFilePick(event: Event): void {
  const input = event.target as HTMLInputElement
  const pending = pendingFilePick
  pendingFilePick = undefined
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (!pending) return
  if (!files.length) {
    pending.reject(new Error('你取消了文件选择'))
    return
  }
  if (files.length > MAX_FILE_PICK_COUNT || files.some((file) => file.size > MAX_FILE_PICK_BYTES)) {
    pending.reject(new Error('一次最多选择 10 个文件，且单个文件不能超过 25 MiB'))
    return
  }
  pending.resolve(files)
}

async function ensurePermission(
  current: InstalledExternalAppSummary,
  permission: ExternalAppPermission,
  method: string,
  summary: string,
): Promise<void> {
  if (!(await externalAppService.hasPermission(current.id, permission))) {
    throw new Error('此权限未在安装时授权；可在第三方 APP 管理中重新安装并授权')
  }
  if (props.assistantTool && !props.assistantTool.permissions.includes(permission))
    throw new Error('该权限超出当前工具声明的范围')
  // A build-shipped, byte-matched reader uses the host's ordinary read permissions.
  // Remote reads still require its remote-resources switch and the declared network grant.
  if (
    isBuiltinReader.value &&
    builtinReaderVerified &&
    !props.assistantTool &&
    (permission === EXTERNAL_APP_PERMISSION.RESOURCES_LIBRARY_READ ||
      permission === EXTERNAL_APP_PERMISSION.RESOURCES_CONTENT_READ ||
      permission === EXTERNAL_APP_PERMISSION.NETWORK_HTTPS)
  )
    return
  if (await externalAppService.hasPersistentPermission(current.id, permission)) return
  await new Promise<void>((resolve, reject) => {
    permissionRequest.value = {
      appId: current.id,
      permission,
      method,
      summary,
      resolve,
      reject,
    }
  })
}

async function decidePermission(decision: 'once' | 'always' | 'denied'): Promise<void> {
  const pending = permissionRequest.value
  if (!pending) return
  permissionRequest.value = undefined
  await externalAppService.recordPermissionDecision(pending.appId, {
    permission: pending.permission,
    method: pending.method,
    decision,
    summary: pending.summary,
  })
  if (decision === 'denied') {
    pending.reject(new Error('你拒绝了这次资源库权限请求'))
    return
  }
  if (decision === 'always') {
    await externalAppService.grantPersistentPermission(pending.appId, pending.permission)
    notice.value = `已允许该 APP 后续使用“${EXTERNAL_APP_PERMISSION_LABELS[pending.permission]}”。`
  }
  pending.resolve()
}

async function requestResourcePick(
  appId: string,
  payload: unknown,
): Promise<ExternalAppResourceSnapshot> {
  const items = await externalAppSdkService.listPickable(appId, payload)
  if (!items.length) throw new Error('没有可供选择的资源')
  resourceQuery.value = ''
  return new Promise<ExternalAppResourceSnapshot>((resolve, reject) => {
    resourcePicker.value = { items, resolve, reject }
  })
}

async function chooseResource(resourceId: string): Promise<void> {
  const picker = resourcePicker.value
  const current = app.value
  if (!picker || !current) return
  try {
    const selected = await externalAppSdkService.getPicked(
      current.id,
      resourceId,
      !props.assistantTool ||
        props.assistantTool.permissions.includes(EXTERNAL_APP_PERMISSION.RESOURCES_CONTENT_READ),
    )
    resourcePicker.value = undefined
    picker.resolve(selected)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '无法读取所选资源'
  }
}

function cancelResourcePick(): void {
  const picker = resourcePicker.value
  resourcePicker.value = undefined
  picker?.reject(new Error('你取消了资源选择'))
}

async function copyDiagnostics(): Promise<void> {
  const current = app.value
  const lines = [
    `APP：${current?.manifest.name ?? '未知 APP'}`,
    `版本：${current?.manifest.version ?? '未知'}`,
    `运行模式：${current?.runtimeMode === 'trustedCompatible' ? '信任兼容' : '标准隔离'}`,
    `状态：${errorMessage.value || '运行中'}`,
    ...diagnostics.value.map((item) => `${item.level} · ${item.message}`),
  ]
  try {
    await navigator.clipboard.writeText(lines.join('\n'))
    notice.value = '运行诊断已复制。'
  } catch {
    errorMessage.value = '无法访问剪贴板；请展开诊断后手动复制。'
  }
}

function clearHoldGesture(): void {
  if (holdTimer !== undefined) window.clearTimeout(holdTimer)
  holdTimer = undefined
}

function hideExitHandle(): void {
  exitHandleVisible.value = false
  if (exitHandleTimer !== undefined) window.clearTimeout(exitHandleTimer)
  exitHandleTimer = undefined
}

function beginHoldGesture(): void {
  if (!isFullscreen.value) return
  clearHoldGesture()
  holdTimer = window.setTimeout(() => {
    holdTimer = undefined
    exitHandleVisible.value = true
    if (exitHandleTimer !== undefined) window.clearTimeout(exitHandleTimer)
    exitHandleTimer = window.setTimeout(hideExitHandle, 3000)
  }, 1500)
}

function exitFromHandle(): void {
  hideExitHandle()
  setFullscreen(false)
  emit('back')
}

function connect(): void {
  if (
    app.value?.runtimeMode === 'trustedCompatible' &&
    frame.value &&
    seedOpaquePreviewDocument(frame.value, app.value.runtimeHtml)
  ) {
    readerReady.value = false
    if (isBuiltinReader.value) loadingLabel.value = '正在打开读了么…'
    return
  }
  port?.close()
  const target = frame.value?.contentWindow
  if (!target) return
  const channel = new MessageChannel()
  port = channel.port1
  externalAppSdkService.releaseListSession(sessionNonce)
  sessionNonce = crypto.randomUUID()
  toolSession.connect(port, sessionNonce)
  lastRequestSequence = 0
  port.onmessage = (event) => {
    const diagnostic = event.data
    if (toolSession.handle(diagnostic)) return
    if (
      diagnostic?.nonce === sessionNonce &&
      (diagnostic?.type === 'srl:host-hold-start' || diagnostic?.type === 'srl:hold-start')
    ) {
      if (!isBuiltinReader.value) beginHoldGesture()
      return
    }
    if (
      diagnostic?.nonce === sessionNonce &&
      (diagnostic?.type === 'srl:host-hold-end' || diagnostic?.type === 'srl:hold-end')
    ) {
      clearHoldGesture()
      return
    }
    if (
      diagnostic?.type === 'srl:diagnostic' &&
      (diagnostic.level === 'warn' || diagnostic.level === 'error')
    ) {
      const message = typeof diagnostic.message === 'string' ? diagnostic.message : 'APP 运行异常'
      diagnostics.value = [
        {
          level: diagnostic.level,
          message,
        },
        ...diagnostics.value,
      ].slice(0, 50)
      if (diagnostic.level === 'error' && !errorMessage.value) {
        errorMessage.value = `${props.official ? '读了么' : '第三方 APP'}初始化失败：${message}`
      }
      if (diagnostic.level === 'error' && app.value) {
        void externalAppService.recordRuntimeError(app.value.id, message).then((health) => {
          if (health?.disabledByWatchdog) {
            errorMessage.value = props.official
              ? '读了么连续运行异常，已暂停；请返回后重新打开。'
              : 'APP 已连续发生 3 次运行异常，已自动停用；可在扩展管理中重新启用。'
            app.value = undefined
            toolSession.close()
            port?.close()
          }
        })
      }
      return
    }
    void handleRequest(event)
  }
  port.start()
  target.postMessage({ type: 'srl:connect', protocolVersion: 2, nonce: sessionNonce }, '*', [
    channel.port2,
  ])
  target.postMessage({ type: 'srl:fullscreen', enabled: isFullscreen.value }, '*')
  if (startupTimer !== undefined) window.clearTimeout(startupTimer)
  startupTimer = undefined
  if (!isBuiltinReader.value) loadingLabel.value = ''
  if (app.value) void externalAppService.recordHealthyLaunch(app.value.id)
}

function setFullscreen(value: boolean): void {
  if (isFullscreen.value === value) return
  // Teleport reparenting reloads the frame's data URL. Its new bootstrap needs HTML again.
  if (frame.value && app.value?.runtimeMode === 'trustedCompatible')
    resetOpaquePreviewDocument(frame.value)
  isFullscreen.value = value
  immersiveHint.value = value && !isBuiltinReader.value
  clearHoldGesture()
  if (!value) hideExitHandle()
  document.body.classList.toggle('external-app-fullscreen', value)
  frame.value?.contentWindow?.postMessage({ type: 'srl:fullscreen', enabled: value }, '*')
}

function toggleFullscreen(): void {
  setFullscreen(!isFullscreen.value)
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && chatPreview.value) {
    event.preventDefault()
    event.stopImmediatePropagation()
    chatPreview.value = undefined
    return
  }
  if (event.key === 'Escape' && resourcePicker.value) {
    event.preventDefault()
    cancelResourcePick()
    return
  }
  if (event.key === 'Escape' && permissionRequest.value) {
    event.preventDefault()
    void decidePermission('denied')
    return
  }
  if (event.key === 'Escape' && isFullscreen.value) {
    event.preventDefault()
    // The host owns immersive exit; a sandboxed APP cannot consume or suppress it.
    event.stopImmediatePropagation()
    if (isBuiltinReader.value) readerAction('back')
    else setFullscreen(false)
  }
}

function handleBackRequest(event: Event): void {
  if (chatPreview.value && event instanceof CustomEvent) {
    const detail = event.detail as SrlBackRequestDetail | undefined
    if (detail && !detail.handled) {
      detail.handled = true
      event.preventDefault()
      event.stopImmediatePropagation()
      chatPreview.value = undefined
    }
    return
  }
  if (!isFullscreen.value || !(event instanceof CustomEvent)) return
  const detail = event.detail as SrlBackRequestDetail | undefined
  if (!detail || detail.handled) return
  detail.handled = true
  event.preventDefault()
  event.stopImmediatePropagation()
  if (isBuiltinReader.value) readerAction('back')
  else setFullscreen(false)
}

onMounted(() => {
  void load()
  window.addEventListener(APPLIED_CSS_CHANGED_EVENT, syncReaderUiCss)
  window.addEventListener('keydown', handleKeydown, { capture: true })
  window.addEventListener(SRL_BACK_REQUEST_EVENT, handleBackRequest, { capture: true })
})

watch(
  () => props.appId,
  () => {
    void load()
  },
)

onBeforeUnmount(() => {
  externalAppSdkService.releaseListSession(sessionNonce)
  toolSession.close()
  window.removeEventListener(APPLIED_CSS_CHANGED_EVENT, syncReaderUiCss)
  document.body.classList.remove('external-app-fullscreen')
  window.removeEventListener('keydown', handleKeydown, { capture: true })
  window.removeEventListener(SRL_BACK_REQUEST_EVENT, handleBackRequest, { capture: true })
  port?.close()
  if (startupTimer !== undefined) window.clearTimeout(startupTimer)
  try {
    screen.orientation?.unlock?.()
  } catch {
    // 部分 WebView 不提供方向解锁；离开后仍可由系统方向继续接管。
  }
  pendingFilePick?.reject(new Error('APP 工作区已关闭'))
  pendingFilePick = undefined
  cancelResourcePick()
  if (permissionRequest.value) {
    permissionRequest.value.reject(new Error('APP 工作区已关闭'))
    permissionRequest.value = undefined
  }
})
</script>

<template>
  <main
    ref="previewHost"
    :class="{ 'external-app-host--fullscreen': isFullscreen }"
    class="external-app-host"
  >
    <ChatReaderStartup v-if="isBuiltinReader && !app && !errorMessage" />
    <FeatureAppHeader
      v-if="!isFullscreen && (!isBuiltinReader || errorMessage)"
      :title="hostTitle || app?.manifest.name || (isBuiltinReader ? '读了么' : '第三方 APP')"
      :back-label="
        assistantTool ? '停止工具并返回聊天' : official ? '返回功能桌面' : '返回扩展管理'
      "
      :layout="assistantTool ? 'panel' : 'page'"
      @back="emit('back')"
    >
      <template #actions>
        <button
          v-if="!assistantTool"
          class="external-app-host__fullscreen-toggle"
          type="button"
          :aria-pressed="isFullscreen"
          aria-label="全屏预览"
          title="全屏预览"
          @click="toggleFullscreen"
        >
          {{ isFullscreen ? '退出' : '全屏' }}
        </button>
      </template>
    </FeatureAppHeader>
    <section v-if="!isFullscreen" class="external-app-host__feedback" aria-live="polite">
      <p v-if="notice" class="external-app-host__notice">{{ notice }}</p>
      <p v-if="errorMessage" class="external-app-host__error" role="alert">
        {{ errorMessage }}
      </p>
      <details v-if="diagnostics.length || errorMessage" class="external-app-host__diagnostics">
        <summary>运行诊断（{{ diagnostics.length }}）</summary>
        <button type="button" @click="copyDiagnostics">复制诊断</button>
        <ul>
          <li v-for="(diagnostic, index) in diagnostics" :key="`${index}-${diagnostic.message}`">
            {{ diagnostic.level }} · {{ diagnostic.message }}
          </li>
        </ul>
      </details>
    </section>
    <Teleport :disabled="!isFullscreen" to="body">
      <section
        v-if="app"
        v-show="!chatPreview"
        class="external-app-host__workspace"
        :class="{
          'external-app-host__workspace--immersive': isFullscreen,
          'external-app-host__workspace--builtin-reader': isBuiltinReader,
          'external-app-host__workspace--starting': isBuiltinReader && !readerReady,
        }"
        :style="{
          '--external-app-splash': app.manifest.splashColor || 'var(--color-accent)',
          ...(isBuiltinReader ? readerAppearance : {}),
        }"
        :aria-label="official ? '读了么阅读工作区' : '第三方 APP 独立工作区'"
        :data-reader-page="isBuiltinReader ? readerPage : undefined"
        :aria-busy="isBuiltinReader && !readerReady"
      >
        <FeatureAppHeader
          v-if="isBuiltinReader && readerPage !== 'reader'"
          :title="readerPage === 'roles' ? '读了么' : '聊天记录'"
          :back-label="readerPage === 'roles' ? '返回功能桌面' : '返回角色列表'"
          @back="readerAction('back')"
        >
          <template #actions>
            <button
              class="external-app-host__reader-action"
              type="button"
              aria-label="搜索"
              @click="readerAction('search')"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="10.5" cy="10.5" r="6.5" />
                <path d="m16 16 5 5" />
              </svg>
            </button>
            <button
              class="external-app-host__reader-action"
              type="button"
              aria-label="角色沉浸背景"
              :aria-pressed="readerCover"
              @click="readerAction('cover')"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="3" />
                <circle cx="8" cy="8" r="1.5" />
                <path d="m3 17 6-6 4 4 3-3 5 5" />
              </svg>
            </button>
          </template>
        </FeatureAppHeader>
        <header v-if="!isFullscreen" class="external-app-host__runtime">
          <span><i aria-hidden="true"></i>独立工作区</span>
          <em>{{ runtimeLabel }} · {{ app.manifest.orientation || 'auto' }}</em>
        </header>
        <iframe
          v-if="previewEnabled"
          ref="frame"
          class="external-app-host__frame"
          :inert="isBuiltinReader && !readerReady"
          :srcdoc="app.runtimeMode === 'trustedCompatible' ? undefined : app.runtimeHtml"
          :src="compatibleDocumentUrl"
          :sandbox="
            app.runtimeMode === 'trustedCompatible'
              ? 'allow-scripts allow-same-origin'
              : 'allow-scripts'
          "
          referrerpolicy="no-referrer"
          :title="`${app.manifest.name} ${official ? '内置 APP' : '第三方 APP'}`"
          @load="connect"
        ></iframe>
        <p v-else class="external-app-host__loading" role="status">
          APP 已暂停，回到当前页面后自动恢复
        </p>
        <p v-if="loadingLabel && !errorMessage" class="external-app-host__loading" role="status">
          {{ loadingLabel }}
        </p>
        <p v-if="isFullscreen && immersiveHint" class="external-app-host__immersive-hint">
          <span class="external-app-host__desktop-exit">按 Esc 退出全屏</span>
          <span class="external-app-host__touch-exit">长按 1.5 秒显示返回</span>
        </p>
      </section>
    </Teleport>
    <input
      ref="fileInput"
      class="external-app-host__file-input"
      type="file"
      @change="completeFilePick"
    />
    <button
      v-if="isFullscreen && exitHandleVisible && !isBuiltinReader"
      class="external-app-host__exit-handle"
      type="button"
      aria-label="退出第三方 APP"
      @click="exitFromHandle"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
    </button>
    <p v-if="isFullscreen && errorMessage" class="external-app-host__fullscreen-error" role="alert">
      {{ errorMessage }}
      <button v-if="isBuiltinReader" type="button" class="button" @click="emit('back')">
        返回功能桌面
      </button>
    </p>
    <Teleport to="body">
      <section
        v-if="resourcePicker"
        class="external-app-resource-picker mobile-dialog-viewport"
        role="dialog"
        aria-modal="true"
        aria-labelledby="external-app-resource-picker-title"
        @click.self="cancelResourcePick"
      >
        <div class="external-app-resource-picker__panel">
          <header>
            <div>
              <small>USER CONFIRMATION</small>
              <h2 id="external-app-resource-picker-title">选择要交给 APP 的资源</h2>
              <p>APP 只能读取你这次确认选择的资源；不会自动看到你的整库内容。</p>
            </div>
            <button type="button" aria-label="取消资源选择" @click="cancelResourcePick">×</button>
          </header>
          <input v-model="resourceQuery" type="search" placeholder="按名称或标签查找资源" />
          <div class="external-app-resource-picker__list" aria-label="可选择资源">
            <button
              v-for="resource in filteredPickableResources"
              :key="resource.id"
              type="button"
              @click="chooseResource(resource.id)"
            >
              <span>{{ RESOURCE_TYPE_LABELS[resource.type] }}</span>
              <strong>{{ resource.name }}</strong>
              <em>{{ resource.tags.length ? resource.tags.join(' · ') : '无标签' }}</em>
            </button>
            <p v-if="!filteredPickableResources.length">没有匹配的资源。</p>
          </div>
          <footer><button type="button" @click="cancelResourcePick">取消</button></footer>
        </div>
      </section>
      <dialog
        v-if="permissionRequest"
        ref="permissionDialog"
        class="external-app-permission"
        role="dialog"
        aria-modal="true"
        aria-labelledby="external-app-permission-title"
        @cancel.prevent="decidePermission('denied')"
        @click.self="decidePermission('denied')"
      >
        <div class="external-app-permission__panel">
          <header>
            <div>
              <small>RESOURCE LIBRARY PERMISSION</small>
              <h2 id="external-app-permission-title">允许此请求吗？</h2>
            </div>
            <button type="button" aria-label="拒绝权限请求" @click="decidePermission('denied')">
              ×
            </button>
          </header>
          <p>
            <strong>{{ app?.manifest.name || '第三方 APP' }}</strong>
            请求：{{ EXTERNAL_APP_PERMISSION_LABELS[permissionRequest.permission] }}
          </p>
          <pre>{{ permissionRequest.summary }}</pre>
          <p class="external-app-permission__note">
            “后续始终允许”只适用于此 APP 的当前安装包和这一类权限；更新包或新权限会再次询问。
          </p>
          <footer>
            <button type="button" @click="decidePermission('denied')">不同意</button>
            <button type="button" @click="decidePermission('once')">仅同意这次</button>
            <button
              class="external-app-permission__always"
              type="button"
              @click="decidePermission('always')"
            >
              以后允许此权限
            </button>
          </footer>
        </div>
      </dialog>
      <ChatReaderFullPreview
        v-if="chatPreview"
        v-bind="chatPreview"
        @close="chatPreview = undefined"
      />
    </Teleport>
  </main>
</template>

<style scoped src="../styles/ExternalAppHost.css"></style>
