import { onBeforeUnmount, shallowRef, watch } from 'vue'
import { normalizeUiViews } from '../core/UiCustomization'
import { createEditableUiView } from '../core/UiViewStarter'
import { readUiViewPreview, updateUiViewPreview } from '../core/UiViewPreview'
import { compileCustomUiView, customUiSourceKey } from '../services/UiCustomizationService'
import { confirmAction } from './UseConfirmDialog'
import type { CustomCssPreset, CustomCssScope } from '../types/BrowserPreferences'
import type { CustomUiView, UiViewSnapshot, UiViewAction } from '../types/UiCustomization'
import type { AppearanceScope } from '../core/AppearanceScopes'
import type { AssistantExecution, AssistantRequest } from '../services/ProductAssistantService'

export interface AssistantVueCommand {
  action: 'vue'
  operation: 'read' | 'write' | 'preview' | 'apply'
  scope: string
  path?: string
  code?: string
  entry?: string
  revision?: string
}
export interface AssistantUiPreview {
  id: string
  scope: AppearanceScope
  revision: string
  view: CustomUiView
  prepared: { key: string; source: string }
  snapshot: UiViewSnapshot
  css: string
  live: boolean
  state: 'loading' | 'ready' | 'failed'
  error?: string
  environment: string
}
interface Bindings {
  draft(): CustomCssPreset
  scopes(): AppearanceScope[]
  write(previous: CustomCssPreset, next: CustomCssPreset): void
  apply(
    scope: AppearanceScope,
    revision: string,
    request: AssistantRequest,
    signal: AbortSignal,
  ): Promise<AssistantExecution>
  css(): string
  previewCss(): string
  remote(): boolean
  theme(): string
  active(): boolean
}
export const snapshotUiViews = (views: CustomCssPreset['views']) =>
  Object.fromEntries(
    Object.entries(views ?? {}).map(([key, view]) => [
      key,
      view && { ...view, files: view.files.map((file) => ({ ...file })) },
    ]),
  )

/** Adapts the existing view draft/compiler/preview owners to assistant tools. No storage owner. */
export function useAssistantUiCustomization(host: Bindings) {
  const preview = shallowRef<AssistantUiPreview>()
  let alive = true
  let generation = 0
  let applying: AbortController | undefined
  let prepared: { scope: string; revision: string; view: CustomUiView; source: string } | undefined
  let pending: { id: string; resolve(): void; reject(error: Error): void } | undefined
  const check = (signal: AbortSignal, version: number) => {
    if (!alive || !host.active() || signal.aborted || generation !== version)
      throw new DOMException('Vue操作已停止或目标已变化', 'AbortError')
  }
  async function revision(scope: string, preset = host.draft()) {
    const bytes = new TextEncoder().encode(
      JSON.stringify([preset.id, scope, preset.views?.[scope as CustomCssScope] ?? null]),
    )
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
  }
  function close() {
    ++generation
    applying?.abort()
    pending?.reject(new DOMException('Vue预览已关闭', 'AbortError'))
    pending = undefined
    preview.value = undefined
    prepared = undefined
  }
  function status(id: string, error?: string) {
    if (preview.value?.id !== id) return
    preview.value = {
      ...preview.value,
      state: error ? 'failed' : 'ready',
      ...(error ? { error } : {}),
    }
    if (pending?.id === id) {
      if (error) pending.reject(new Error(error))
      else pending.resolve()
      pending = undefined
    }
  }
  function invoke(action: UiViewAction) {
    if (!preview.value) throw new Error('预览已关闭')
    preview.value = {
      ...preview.value,
      snapshot: updateUiViewPreview(preview.value.snapshot, action),
    }
  }
  // Matches the editor's policy lifecycle: enabling network must discard a real-page snapshot.
  watch(
    () => [host.remote(), host.theme(), host.active()],
    () => close(),
    { flush: 'sync' },
  )
  watch(
    () => preview.value && host.scopes().some((item) => item.value === preview.value!.scope.value),
    (available) => {
      if (available === false) close()
    },
    { flush: 'sync' },
  )
  const environment = () => JSON.stringify([host.theme(), host.remote(), host.css()])
  async function execute(
    command: AssistantVueCommand,
    request: AssistantRequest,
    signal: AbortSignal,
  ): Promise<AssistantExecution> {
    const version = generation
    check(signal, version)
    const scope = host.scopes().find((item) => item.value === command.scope)
    if (!scope) throw new Error('该APP界面当前不可用，请先安装')
    const previous = host.draft()
    if (request.presetId !== previous.id) throw new Error('预设已变化，请重新读取Vue')
    const key = await revision(scope.value, previous)
    check(signal, version)
    if (command.operation !== 'read' && command.revision !== key)
      throw new Error('Vue草稿已变化，请重新读取，未覆盖手动修改')
    const view = previous.views?.[scope.value] ?? createEditableUiView(scope.title)
    const path = command.path ?? view.entryPath
    if (command.operation === 'read') {
      const file = view.files.find((item) => item.path === path)
      if (!file || file.encoding)
        throw new Error('只能读取目录中的文本源码文件，不能读取二进制素材')
      if (file.contents.length > 40_000)
        throw new Error('该源码文件超过AI单文件40000字符预算，请先拆分')
      return {
        text: '已读取界面源码',
        showInChat: false,
        data: {
          scope: scope.value,
          revision: key,
          exists: Boolean(previous.views?.[scope.value]),
          enabled: view.enabled,
          entry: view.entryPath,
          path,
          code: file.contents,
          files: view.files.map((item) => ({
            path: item.path,
            binary: item.encoding === 'base64',
            characters: item.contents.length,
          })),
          networkAllowed: host.remote(),
          hint: '这是当前预设的界面源码，未创建时返回可编辑模板。读取数据不授权运行或改宿主业务；保留其它文件/APP/CSS，用Page.js或srlUi委托原操作。',
        },
      }
    }
    if (command.operation === 'write') {
      const candidate = {
        ...previous,
        scopedCss: { ...previous.scopedCss },
        views: snapshotUiViews(previous.views),
      }
      const nextView = { ...view, files: view.files.map((file) => ({ ...file })) }
      const index = nextView.files.findIndex((item) => item.path === path)
      if (index >= 0 && nextView.files[index]!.encoding)
        throw new Error('不能把二进制素材替换为文本')
      const file = { path, contents: command.code ?? '' }
      if (index >= 0) nextView.files[index] = file
      else nextView.files.push(file)
      if (command.entry) nextView.entryPath = command.entry
      candidate.views![scope.value] = nextView
      candidate.views = normalizeUiViews(candidate.views)
      const validated = candidate.views[scope.value]!
      const source = await compileCustomUiView(validated)
      check(signal, version)
      if ((await revision(scope.value)) !== key)
        throw new Error('编译期间Vue已变化，未覆盖手动修改')
      const nextRevision = await revision(scope.value, candidate)
      check(signal, version)
      close()
      host.write(previous, candidate)
      prepared = { scope: scope.value, revision: nextRevision, view: validated, source }
      return {
        text: `已修改${scope.title}的${path}草稿；入口编译通过，尚未应用。`,
        status: 'Vue草稿已修改',
        data: {
          scope: scope.value,
          revision: nextRevision,
          path,
          entry: validated.entryPath,
          compiled: true,
          applied: false,
        },
      }
    }
    if (command.operation === 'apply') {
      const evidence = preview.value
      if (
        !evidence ||
        evidence.scope.value !== scope.value ||
        evidence.revision !== key ||
        evidence.environment !== environment() ||
        evidence.state !== 'ready'
      )
        throw new Error('请先预览当前版本Vue并处理运行错误；源码/主题/网络或样式变化后需要重验')
      const lease = new AbortController()
      applying = lease
      const abort = () => lease.abort()
      signal.addEventListener('abort', abort, { once: true })
      try {
        if (signal.aborted) abort()
        const result = await host.apply(scope, key, request, lease.signal)
        if (lease.signal.aborted)
          return { text: 'Vue操作已停止；已完成的草稿或试用仍可撤销', ok: false, cancelled: true }
        applying = undefined
        if (result.ok !== false) close()
        return result
      } finally {
        signal.removeEventListener('abort', abort)
        if (applying === lease) applying = undefined
      }
    }
    if (
      preview.value?.scope.value === scope.value &&
      preview.value.revision === key &&
      preview.value.environment === environment() &&
      preview.value.state === 'ready'
    ) {
      return {
        text: '当前源码预览仍可用',
        data: {
          scope: scope.value,
          revision: key,
          compiled: true,
          runtimeReady: true,
          businessTested: false,
          visualReviewed: false,
          reused: true,
        },
      }
    }
    const source =
      prepared?.scope === scope.value && prepared.revision === key
        ? prepared.source
        : await compileCustomUiView(view)
    check(signal, version)
    if (
      host.remote() &&
      !(await confirmAction(
        {
          title: '联网预览源码',
          message: '该源码可以访问HTTPS网站；预览仅提供示例界面，不提供真实资源和业务操作。',
          confirmLabel: '联网预览',
        },
        signal,
      ))
    )
      return { text: '已取消联网预览', ok: false, cancelled: true }
    check(signal, version)
    if ((await revision(scope.value)) !== key) throw new Error('预览期间Vue已变化，请重新读取')
    check(signal, version)
    close()
    const id = crypto.randomUUID()
    const snapshot = readUiViewPreview(scope.value, scope.title, !host.remote())
    const done = new Promise<void>((resolve, reject) => {
      pending = { id, resolve, reject }
    })
    preview.value = {
      id,
      scope,
      revision: key,
      view,
      prepared: { key: customUiSourceKey(view), source },
      snapshot: snapshot.snapshot,
      css: host.previewCss(),
      live: snapshot.live,
      state: 'loading',
      environment: environment(),
    }
    const currentGeneration = generation
    const abort = () => {
      if (preview.value?.id === id) close()
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      if (signal.aborted) abort()
      try {
        await done
      } catch (error) {
        if (
          !signal.aborted &&
          (error instanceof Error || error instanceof DOMException) &&
          error.name === 'AbortError'
        )
          return { text: 'Vue预览已取消，草稿保留，未应用', ok: false, cancelled: true }
        throw error
      }
      check(signal, currentGeneration)
      if ((await revision(scope.value)) !== key || preview.value?.environment !== environment())
        throw new Error('预览期间源码或环境已变化，需要重验')
      check(signal, currentGeneration)
      return {
        text: `已打开${scope.title}的Vue预览；编译与启动通过，预览动作不执行真实业务。`,
        status: 'Vue预览已打开',
        data: {
          scope: scope.value,
          revision: key,
          compiled: true,
          runtimeReady: true,
          kind: snapshot.live ? 'current-readonly' : 'example',
          businessTested: false,
          visualReviewed: false,
        },
      }
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }
  onBeforeUnmount(() => {
    alive = false
    close()
    prepared = undefined
  })
  const dismiss = () => {
    preview.value = undefined
    prepared = undefined
  }
  return { preview, execute, close, dismiss, status, invoke, revision }
}
