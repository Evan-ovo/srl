export {
  type TavernBridgeStatus,
  type TavernBridgeImportResult,
  type TavernBridgeState,
} from './TavernBridgeTransferOperations'
import {
  handlePortMessage,
  sendFiles,
  type TavernBridgeTransferOperationsContext,
  type TavernBridgeStatus,
  type TavernBridgeImportResult,
  type TavernBridgeState,
  type IncomingTransfer,
  type PendingPull,
  type PendingList,
  throwIfAborted,
  withAbortSignal,
} from './TavernBridgeTransferOperations'
import { tavernHttpFetch } from './TavernHttpTransport'
import { acquireDeviceRelayTarget, relayWorkerEndpoint } from './RelayWorkerSettingsService'
import { supportsBridgeGzip } from '../utils/BridgeCompression'
import { isCapacitorApp } from '../utils/CapacitorDetection'
import {
  canUseLocalTavernDirect,
  LOCAL_TAVERN_ORIGIN,
  type LocalTavernDirectSession,
  removeLocalTavernDirectFile,
} from './LanDirectService'
import {
  bridgeInvitation,
  isTavernEnvelope,
  tavernEnvelope,
  type TavernConflictPolicy,
  type TavernResourceItem,
  type TavernResourceKind,
} from './TavernBridgeProtocol'
import { LOCAL_TAVERN_RELAY_BASE, TavernHttpRelayPort } from './TavernHttpRelayPort'
import { TavernChunkSender } from './TavernChunkSender'
import { TavernDirectoryService } from './TavernDirectoryService'
import {
  BrowserTavernDirectory,
  chooseBrowserTavernDirectory,
  supportsBrowserTavernDirectory,
} from '../storage/TavernDirectoryStorage'
import {
  chooseNativeTavernDirectory,
  supportsNativeTavernDirectory,
} from '../storage/NativeTavernDirectoryStorage'

export { TavernHttpRelayPort } from './TavernHttpRelayPort'

const PULL_IDLE_TIMEOUT_MS = 120_000
const PULL_ABSOLUTE_TIMEOUT_MS = 30 * 60_000
const LIST_IDLE_TIMEOUT_MS = 180_000

export class TavernBridgeService extends EventTarget {
  private directory?: TavernDirectoryService
  private invitation = bridgeInvitation()
  private state: TavernBridgeState = {
    status: this.invitation ? 'discovering' : 'idle',
    detail: this.invitation ? '正在寻找打开此页面的酒馆' : '输入酒馆设备码，或选择本机酒馆目录',
    pairCode: this.invitation?.pairCode ?? '',
    tavernOrigin: this.invitation?.tavernOrigin ?? '',
    bridgeVersion: '',
    tavernVersion: '',
    transport: 'none',
    capabilities: [],
  }
  private port?: MessagePort | TavernHttpRelayPort
  private helloTimer?: number
  private relayWindow?: Window
  private relayOrigin = ''
  private secureJoinAbort?: AbortController
  private relayWorkerRelease?: () => unknown
  private messageChain = Promise.resolve()
  private readonly pendingLists = new Map<string, PendingList>()
  private readonly pendingPulls = new Map<string, PendingPull>()
  private readonly pendingSends = new Map<
    string,
    { resolve: (value: TavernBridgeImportResult) => void; reject: (error: Error) => void }
  >()
  private readonly pendingAvatarChecks = new Map<
    string,
    { resolve: (ids: Set<string>) => void; reject: (error: Error) => void }
  >()
  private readonly pendingLocalDirectSessions = new Map<
    string,
    { resolve: (value: LocalTavernDirectSession) => void; reject: (error: Error) => void }
  >()
  private readonly incoming = new Map<string, IncomingTransfer>()
  private readonly cancelledPulls = new Set<string>()
  private readonly chunkSender = new TavernChunkSender((payload) =>
    this.send('file-chunk', { ...payload }, [payload.data]),
  )
  private peerCapabilities: string[] = []
  private localDirectEnabled = false

  constructor() {
    super()
    if (typeof window !== 'undefined') {
      window.addEventListener('message', this.handleWindowMessage)
      if (this.invitation) this.startDiscovery()
    }
  }

  hasInvitation(): boolean {
    return Boolean(this.invitation)
  }

  canBindDirectory(): boolean {
    return supportsNativeTavernDirectory() || supportsBrowserTavernDirectory()
  }

  async bindDirectory(reuse = true): Promise<void> {
    const storage = supportsNativeTavernDirectory()
      ? await chooseNativeTavernDirectory(reuse)
      : await chooseBrowserTavernDirectory(reuse)
    const directory = new TavernDirectoryService(storage)
    await directory.validate()
    if (storage instanceof BrowserTavernDirectory) await storage.remember()
    this.disconnect('正在绑定酒馆目录')
    this.directory = directory
    this.peerCapabilities = [...directory.capabilities]
    this.state = {
      ...this.state,
      transport: 'directory',
      tavernOrigin: storage.name,
      bridgeVersion: '本地目录',
      capabilities: [...directory.capabilities],
    }
    this.setState('connected', `已绑定 ${storage.name}；写回前请关闭酒馆，写入后下次启动生效`)
  }

  openDeviceRelay(joinUrl: string, tavernOrigin: string): void {
    const join = new URL(joinUrl)
    const origin = new URL(tavernOrigin)
    if (
      !['http:', 'https:'].includes(join.protocol) ||
      origin.origin !== tavernOrigin ||
      join.origin !== tavernOrigin
    ) {
      throw new Error('酒馆中继地址无效')
    }
    this.disconnect('正在建立设备码连接')
    // Capacitor 原生应用无法操作弹窗，不能离开当前页面；
    // 引导用户在酒馆互传页使用"输入设备码"方式连接。
    if (isCapacitorApp()) {
      throw new Error('原生应用不支持同浏览器配对窗口，请使用"输入酒馆显示的设备码"方式连接。')
    }
    const relayWindow = window.open(
      join.href,
      `srl-device-relay-${Date.now()}`,
      'popup,width=520,height=680',
    )
    if (!relayWindow) throw new Error('浏览器阻止了中继窗口')
    this.relayWindow = relayWindow
    this.relayOrigin = tavernOrigin
    this.setState('discovering', '正在通过酒馆中继连接；资源库会保留在当前页面')
    window.setTimeout(() => {
      if (this.state.status === 'discovering' && !this.invitation) {
        this.setState(
          'error',
          '没有收到新版酒馆中继响应；请确认页面扩展和服务端插件都是 0.3.11 或更新版本、酒馆地址没有把 http 写成 https，并允许本站打开弹出窗口。',
        )
      }
    }, 12_000)
  }

  getState(): TavernBridgeState {
    return { ...this.state, capabilities: [...this.state.capabilities] }
  }

  setLocalTavernDirectEnabled(enabled: boolean): boolean {
    this.localDirectEnabled = enabled && canUseLocalTavernDirect()
    return this.localDirectEnabled
  }

  isLocalTavernDirectAvailable(): boolean {
    return (
      this.localDirectEnabled &&
      canUseLocalTavernDirect() &&
      this.peerCapabilities.includes('local-direct-v1')
    )
  }

  async joinSecureRelay(codeValue: string): Promise<void> {
    const code = codeValue.trim().toUpperCase()
    if (!/^[2-9A-HJ-NP-Z]{8}$/u.test(code)) throw new Error('设备码格式无效')
    const worker = acquireDeviceRelayTarget()
    this.disconnect('正在连接 HTTPS 安全中继')
    const joinAbort = new AbortController()
    this.secureJoinAbort = joinAbort
    let connected = false
    try {
      // SRL-PUBLIC-SYNC: BEGIN WORKER-URL id=tavern-device-relay
      const endpoint = relayWorkerEndpoint('/api/bridge/join', worker.target)
      // SRL-PUBLIC-SYNC: END WORKER-URL id=tavern-device-relay
      let response: Response
      try {
        response = await tavernHttpFetch(endpoint.href, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
          signal: joinAbort.signal,
          redirect: 'error',
          cache: 'no-store',
        })
      } catch {
        throw new Error('无法连接资源库的 HTTPS 中继，请检查网络或服务器是否已更新')
      }
      joinAbort.signal.throwIfAborted()
      const result = (await response.json().catch(() => ({}))) as {
        error?: string
        pairCode?: string
        participantToken?: string
        relayBase?: string
        reliableDelivery?: boolean
        message?: string
      }
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error(
            result.error || result.message || '设备码不存在或已过期，请在酒馆重新生成',
          )
        }
        throw new Error(
          result.error || result.message || `HTTPS 中继连接失败（HTTP ${response.status}）`,
        )
      }
      if (
        typeof result.pairCode !== 'string' ||
        typeof result.participantToken !== 'string' ||
        typeof result.relayBase !== 'string'
      ) {
        throw new Error('HTTPS 中继返回的数据不完整，请更新云服务器')
      }
      // SRL-PUBLIC-SYNC: BEGIN WORKER-URL id=tavern-relay-origin
      joinAbort.signal.throwIfAborted()
      const relayBase = new URL(result.relayBase, worker.target.origin)
      if (
        relayBase.origin !== worker.target.origin ||
        !relayBase.pathname.startsWith('/api/bridge/') ||
        relayBase.username ||
        relayBase.password ||
        relayBase.search ||
        relayBase.hash
      )
        throw new Error('中继响应地址与所选 Worker 不一致')
      // SRL-PUBLIC-SYNC: END WORKER-URL id=tavern-relay-origin
      this.connectHttpRelay(
        relayBase.href,
        code,
        result.participantToken,
        result.pairCode,
        relayBase.origin,
        result.reliableDelivery === true,
      )
      this.relayWorkerRelease = worker.release
      connected = true
    } finally {
      if (this.secureJoinAbort === joinAbort) this.secureJoinAbort = undefined
      if (!connected) worker.release()
    }
  }

  async connectLocalTavern(): Promise<void> {
    if (!canUseLocalTavernDirect()) throw new Error('本机酒馆一键连接仅支持 Android APK')
    this.disconnect('正在请求本机酒馆连接')
    let response: Response
    let csrfToken: string
    try {
      const csrfResponse = await fetch(new URL('/csrf-token', LOCAL_TAVERN_ORIGIN).href, {
        cache: 'no-store',
        credentials: 'include',
      })
      if (!csrfResponse.ok) throw new Error(`获取酒馆 CSRF 令牌失败（HTTP ${csrfResponse.status}）`)
      const responseToken = (await csrfResponse.json())?.token
      if (typeof responseToken !== 'string' || !responseToken)
        throw new Error('酒馆没有返回有效的 CSRF 令牌')
      csrfToken = responseToken
      response = await fetch(new URL('local-pair/requests', LOCAL_TAVERN_RELAY_BASE).href, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ srlUrl: window.location.href }),
        cache: 'no-store',
        credentials: 'include',
      })
    } catch {
      throw new Error('未发现本机酒馆；请先在同一台设备启动 http://127.0.0.1:8000')
    }
    const result = (await response.json().catch(() => ({}))) as {
      code?: string
      participantToken?: string
      relayBase?: string
      error?: string
    }
    if (!response.ok) {
      if (response.status === 404) {
        throw new Error('本机酒馆服务端插件未安装或版本过旧；请更新到 SRL Bridge 0.3.22 后重启酒馆')
      }
      throw new Error(result.error || `本机酒馆连接请求失败（HTTP ${response.status}）`)
    }
    const code = typeof result.code === 'string' ? result.code : ''
    const token = typeof result.participantToken === 'string' ? result.participantToken : ''
    const relayBase = new URL(String(result.relayBase ?? ''), LOCAL_TAVERN_ORIGIN)
    if (
      !/^[2-9A-HJ-NP-Z]{8}$/u.test(code) ||
      !/^[A-Za-z0-9_-]{32,}$/u.test(token) ||
      relayBase.href !== LOCAL_TAVERN_RELAY_BASE
    ) {
      throw new Error('本机酒馆返回的连接会话无效')
    }
    const port = new TavernHttpRelayPort(relayBase.href, { code, token, csrfToken })
    port.onmessage = (portEvent) => {
      this.messageChain = this.messageChain
        .then(() => this.handlePortMessage(portEvent.data))
        .catch((error) => this.failConnection(error, '本机连接处理失败'))
    }
    port.onerror = (error) => this.failConnection(error, '本机酒馆连接已断开')
    this.invitation = null
    this.port = port
    this.localDirectEnabled = true
    this.state = {
      ...this.state,
      pairCode: '',
      tavernOrigin: LOCAL_TAVERN_ORIGIN,
      bridgeVersion: '',
      tavernVersion: '',
      transport: 'local-direct',
      capabilities: [],
    }
    port.start()
    this.setState(
      'discovering',
      '已请求本机酒馆连接；请在酒馆“SRL 酒馆互传”扩展点击“允许本机 APK 连接”',
    )
  }

  private startDiscovery(): void {
    if (this.invitation?.participantToken && this.invitation.relayBase) {
      this.startRelayFromInvitation()
      return
    }
    // Capacitor 原生应用无法使用 window.opener/parent，必须用设备码中继
    if (isCapacitorApp()) {
      this.setState('error', '原生应用无法使用窗口通信，请使用”设备码中继”连接酒馆。')
      return
    }
    if (this.helloTimer) window.clearInterval(this.helloTimer)
    this.setState('discovering', '正在连接酒馆中继')
    this.sendHello()
    this.helloTimer = window.setInterval(() => this.sendHello(), 800)
    window.setTimeout(() => {
      if (this.state.status === 'discovering') {
        this.setState(
          'error',
          '没有找到酒馆窗口。移动端或酒馆安全头可能切断了窗口连接；请优先改用”设备码中继”，并确认酒馆服务端插件已安装。',
        )
      }
    }, 12_000)
  }

  private sendHello(): void {
    const host = this.relayWindow ?? (window.parent !== window ? window.parent : window.opener)
    if (!this.invitation || !host || ('closed' in host && host.closed)) return
    host.postMessage(
      tavernEnvelope('srl-hello', { channel: this.invitation.channel }),
      this.invitation.tavernOrigin,
    )
  }

  private startRelayFromInvitation(): void {
    const invitation = this.invitation
    if (!invitation?.participantToken || !invitation.relayBase) return
    try {
      this.connectHttpRelay(
        invitation.relayBase,
        invitation.channel.slice('relay-'.length),
        invitation.participantToken,
        invitation.pairCode,
        invitation.tavernOrigin,
      )
      this.removeRelayUrlParams()
    } catch (error) {
      this.setState('error', error instanceof Error ? error.message : '设备码中继初始化失败')
    }
  }

  private connectHttpRelay(
    relayBaseValue: string,
    code: string,
    token: string,
    pairCode: string,
    tavernOrigin: string,
    reliableDelivery = false,
  ): void {
    const relayBase = new URL(relayBaseValue, tavernOrigin)
    if (relayBase.origin !== tavernOrigin) throw new Error('中继地址来源不一致')
    if (!/^[2-9A-HJ-NP-Z]{8}$/u.test(code)) throw new Error('设备码格式无效')
    if (!/^\d{6}$/u.test(pairCode)) throw new Error('配对码格式无效')
    if (this.helloTimer) window.clearInterval(this.helloTimer)
    this.port?.close()
    const directPort = new TavernHttpRelayPort(relayBase.href, { code, token, reliableDelivery })
    directPort.onmessage = (portEvent) => {
      this.messageChain = this.messageChain
        .then(() => this.handlePortMessage(portEvent.data))
        .catch((error) => this.failConnection(error, '通信处理失败'))
      return this.messageChain
    }
    directPort.onrecovery = (recovering) => {
      if (this.port === directPort)
        this.setState(
          this.state.status,
          recovering
            ? '网络暂时中断，正在恢复传输；请保持页面在前台'
            : this.state.status === 'connected'
              ? '网络已恢复，继续传输'
              : '请核对酒馆中的六位配对码',
        )
    }
    directPort.onerror = (error) => this.failConnection(error, '设备码中继已断开')
    this.invitation = {
      channel: `relay-${code}`,
      pairCode,
      tavernOrigin,
      relayBase: relayBase.href,
      participantToken: token,
    }
    this.state = {
      ...this.state,
      pairCode,
      tavernOrigin,
      transport: 'relay',
    }
    this.port = directPort
    directPort.start()
    this.setState('pairing', '请核对酒馆扩展中显示的六位数字')
  }

  private removeRelayUrlParams(): void {
    if (typeof history === 'undefined') return
    const url = new URL(window.location.href)
    let changed = false
    for (const key of ['srlBridge', 'pair', 'stOrigin', 'relayBase', 'relayToken']) {
      if (url.searchParams.has(key)) {
        url.searchParams.delete(key)
        changed = true
      }
    }
    if (changed) history.replaceState(history.state, '', url.href)
  }

  private readonly handleWindowMessage = (event: MessageEvent): void => {
    const message = event.data
    if (
      !this.invitation &&
      this.relayWindow &&
      event.origin === this.relayOrigin &&
      isTavernEnvelope(message) &&
      message.type === 'relay-invitation' &&
      typeof message.channel === 'string' &&
      /^relay-[2-9A-HJ-NP-Z]{8}$/u.test(message.channel) &&
      typeof message.pairCode === 'string' &&
      /^\d{6}$/u.test(message.pairCode)
    ) {
      this.invitation = {
        channel: message.channel,
        pairCode: message.pairCode,
        tavernOrigin: event.origin,
      }
      if (event.source && 'postMessage' in event.source) {
        this.relayWindow = event.source as Window
      }
      this.state = {
        ...this.state,
        pairCode: message.pairCode,
        tavernOrigin: event.origin,
      }
      // 中继窗口仍在时必须通过窗口转发。线上 SRL 是 HTTPS，而本机酒馆通常是 HTTP；
      // 若在这里直接 fetch 酒馆的 relay API，Android/iOS 会按混合内容拦截并报 Failed to fetch。
      this.startDiscovery()
      return
    }
    const host = this.relayWindow ?? (window.parent !== window ? window.parent : window.opener)
    if (!this.invitation || event.origin !== this.invitation.tavernOrigin || event.source !== host)
      return
    if (
      !isTavernEnvelope(message) ||
      message.type !== 'st-port' ||
      message.channel !== this.invitation.channel ||
      message.pairCode !== this.invitation.pairCode ||
      !event.ports[0]
    ) {
      return
    }
    if (this.helloTimer) window.clearInterval(this.helloTimer)
    this.port?.close()
    const messagePort = event.ports[0]
    this.port = messagePort
    this.state = {
      ...this.state,
      tavernVersion: typeof message.tavernVersion === 'string' ? message.tavernVersion : '',
      transport: 'window',
      capabilities: Array.isArray(message.capabilities)
        ? message.capabilities.filter((value): value is string => typeof value === 'string')
        : [],
    }
    messagePort.onmessage = (portEvent) => {
      this.messageChain = this.messageChain
        .then(() => this.handlePortMessage(portEvent.data))
        .catch((error) => this.failConnection(error, '通信处理失败'))
    }
    messagePort.start()
    this.setState('pairing', '请核对酒馆扩展中显示的六位数字')
  }

  accept(): void {
    if (!this.invitation || !this.port) throw new Error('酒馆通信通道尚未准备好')
    this.send('srl-accept', {
      pairCode: this.invitation.pairCode,
      capabilities: [
        'catalog-pages-v1',
        'catalog-kind-filter-v1',
        'pull-cancel-v1',
        'pull-progress-v1',
        ...(supportsBridgeGzip() ? ['gzip'] : []),
      ],
    })
  }

  async listResources(
    kind?: 'chat' | 'character' | 'userPersona',
    options: { signal?: AbortSignal } = {},
  ): Promise<TavernResourceItem[]> {
    throwIfAborted(options.signal)
    if (kind === 'chat' && !this.peerCapabilities.includes('chat-archive-v1'))
      throw new Error('此连接不支持聊天归档，请使用配套测试版酒馆扩展')
    if (this.directory) {
      const items = await this.directory.listResources(
        kind === 'character' || kind === 'userPersona' ? kind : undefined,
      )
      throwIfAborted(options.signal)
      return items
    }
    this.assertConnected()
    if (!this.peerCapabilities.includes('catalog-pages-v1'))
      throw new Error('酒馆扩展不支持大型资源清单，请更新酒馆互传扩展后重试')
    const requestId = crypto.randomUUID()
    let resolveList!: (items: TavernResourceItem[]) => void
    let rejectList!: (error: Error) => void
    const pendingPromise = new Promise<TavernResourceItem[]>((resolve, reject) => {
      resolveList = resolve
      rejectList = reject
    })
    const pending: PendingList = {
      items: [],
      resolve: resolveList,
      reject: rejectList,
      pages: new Map(),
      idleTimer: 0,
      absoluteTimer: 0,
    }
    this.pendingLists.set(requestId, pending)
    this.touchList(requestId)
    pending.absoluteTimer = window.setTimeout(
      () => this.failList(requestId, '读取酒馆资源超过 30 分钟，请检查酒馆目录状态'),
      PULL_ABSOLUTE_TIMEOUT_MS,
    )
    const canFilterByKind = this.peerCapabilities.includes('catalog-kind-filter-v1')
    const requestKind = kind === 'chat' || canFilterByKind ? kind : undefined
    void this.send('list-request', {
      requestId,
      ...(requestKind ? { kind: requestKind } : {}),
    }).catch((error) =>
      this.failList(requestId, error instanceof Error ? error.message : '发送资源清单请求失败'),
    )
    return withAbortSignal(pendingPromise, options.signal).finally(() => {
      if (options.signal?.aborted) this.failList(requestId, '资源库已取消读取清单')
    })
  }

  async checkUserAvatarIds(
    ids: string[],
    options: { signal?: AbortSignal } = {},
  ): Promise<Set<string>> {
    throwIfAborted(options.signal)
    if (this.directory) {
      const result = await this.directory.checkUserAvatarIds(ids)
      throwIfAborted(options.signal)
      return result
    }
    this.assertConnected()
    if (!this.peerCapabilities.includes('persona-avatar-check-v1')) {
      throw new Error('酒馆页面扩展不支持头像核对，请更新扩展后重试')
    }
    const requestId = crypto.randomUUID()
    const pending = new Promise<Set<string>>((resolve, reject) => {
      this.pendingAvatarChecks.set(requestId, { resolve, reject })
    })
    void this.send('persona-avatar-check-request', { requestId, avatarIds: ids }).catch((error) =>
      this.pendingAvatarChecks.get(requestId)?.reject(error),
    )
    return withAbortSignal(
      this.withTimeout(pending, requestId, this.pendingAvatarChecks, '核对酒馆头像超时'),
      options.signal,
    ).finally(() => {
      if (options.signal?.aborted) this.pendingAvatarChecks.delete(requestId)
    })
  }

  async pullResources(
    items: TavernResourceItem[],
    options: { signal?: AbortSignal; exportBatchId?: string } = {},
  ): Promise<File[]> {
    throwIfAborted(options.signal)
    if (
      items.some(
        (item) =>
          item.kind === 'chat' &&
          item.readingScriptIds !== undefined &&
          (!Array.isArray(item.readingScriptIds) ||
            item.readingScriptIds.length > 8 ||
            item.readingScriptIds.some(
              (id) =>
                typeof id !== 'string' ||
                id.length > 512 ||
                !/^(scriptGlobal|scriptPreset):.+$/.test(id),
            )),
      )
    )
      throw new Error('请选择最多 8 份全局或预设阅读脚本')
    if (
      items.some(
        (item) =>
          item.kind === 'chat' &&
          (item.readingScriptIds?.length || item.carryReadingScripts === false),
      ) &&
      (this.directory || !this.peerCapabilities.includes('chat-reading-scripts-v1'))
    )
      throw new Error('附带阅读脚本需要新版酒馆互传扩展的实时连接')
    if (this.directory) {
      const files = await this.directory.pullResources(items, options.exportBatchId)
      throwIfAborted(options.signal)
      return files
    }
    this.assertConnected()
    if (
      !this.peerCapabilities.includes('pull-cancel-v1') ||
      !this.peerCapabilities.includes('pull-progress-v1')
    )
      throw new Error('酒馆扩展不支持接收取消与进度续时，请更新酒馆互传扩展后重试')
    const requestId = crypto.randomUUID()
    let resolvePull!: (files: File[]) => void
    let rejectPull!: (error: Error) => void
    const result = new Promise<File[]>((resolve, reject) => {
      resolvePull = resolve
      rejectPull = reject
    })
    const pending: PendingPull = {
      files: [],
      resolve: resolvePull,
      reject: rejectPull,
      idleTimer: 0,
      absoluteTimer: 0,
    }
    this.pendingPulls.set(requestId, pending)
    this.touchPull(requestId)
    pending.absoluteTimer = window.setTimeout(
      () => this.failPull(requestId, '从酒馆接收资源超过 30 分钟，已停止本次传输', true),
      PULL_ABSOLUTE_TIMEOUT_MS,
    )
    void this.send('pull-request', {
      requestId,
      ...(options.exportBatchId && this.peerCapabilities.includes('pull-export-batch-v1')
        ? { exportBatchId: options.exportBatchId }
        : {}),
      items: items.map(({ id, kind, readingScriptIds, carryReadingScripts }) => ({
        id,
        ...(kind === 'chat' && carryReadingScripts !== undefined ? { carryReadingScripts } : {}),
        ...(kind === 'chat' && readingScriptIds?.length
          ? { readingScriptIds: [...readingScriptIds] }
          : {}),
      })),
      localDirect: this.isLocalTavernDirectAvailable(),
    }).catch((error) =>
      this.failPull(requestId, error instanceof Error ? error.message : '发送取回请求失败', false),
    )
    const onAbort = (): void =>
      this.failPull(
        requestId,
        options.signal?.reason instanceof Error
          ? options.signal.reason.message
          : '资源库已取消接收',
        true,
      )
    options.signal?.addEventListener('abort', onAbort, { once: true })
    return result.finally(() => options.signal?.removeEventListener('abort', onAbort))
  }

  async sendFiles(
    files: Array<{
      file: File
      kind: TavernResourceKind
      displayName: string
      targetName?: string
      operationId?: string
    }>,
    conflictPolicy: TavernConflictPolicy,
    onProgress?: (completed: number, total: number, detail?: string) => void,
    options: { signal?: AbortSignal } = {},
  ): Promise<TavernBridgeImportResult[]> {
    return sendFiles(this.transferContext(), files, conflictPolicy, onProgress, options)
  }

  private async handlePortMessage(message: unknown): Promise<void> {
    return handlePortMessage(this.transferContext(), message)
  }

  private touchPull(requestId: string): void {
    const pending = this.pendingPulls.get(requestId)
    if (!pending) return
    window.clearTimeout(pending.idleTimer)
    pending.idleTimer = window.setTimeout(
      () => this.failPull(requestId, '从酒馆接收资源连续 120 秒没有进度，已停止后续接收', true),
      PULL_IDLE_TIMEOUT_MS,
    )
  }

  private touchList(requestId: string): void {
    const pending = this.pendingLists.get(requestId)
    if (!pending) return
    window.clearTimeout(pending.idleTimer)
    pending.idleTimer = window.setTimeout(
      () => this.failList(requestId, '读取酒馆资源连续 180 秒没有进度，请检查酒馆连接'),
      LIST_IDLE_TIMEOUT_MS,
    )
  }

  private finishList(requestId: string): void {
    const pending = this.pendingLists.get(requestId)
    if (!pending) return
    this.pendingLists.delete(requestId)
    window.clearTimeout(pending.idleTimer)
    window.clearTimeout(pending.absoluteTimer)
    pending.resolve(
      pending.pageCount === undefined
        ? pending.items
        : Array.from(
            { length: pending.pageCount },
            (_, index) => pending.pages.get(index) ?? [],
          ).flat(),
    )
  }

  private failList(requestId: string, message: string): void {
    const pending = this.pendingLists.get(requestId)
    if (!pending) return
    this.pendingLists.delete(requestId)
    window.clearTimeout(pending.idleTimer)
    window.clearTimeout(pending.absoluteTimer)
    pending.reject(new Error(message))
  }

  private clearPullTimers(pending?: PendingPull): void {
    if (!pending) return
    window.clearTimeout(pending.idleTimer)
    window.clearTimeout(pending.absoluteTimer)
  }

  private failPull(requestId: string, message: string, notifyPeer: boolean): void {
    const pending = this.pendingPulls.get(requestId)
    if (!pending) return
    this.pendingPulls.delete(requestId)
    this.clearPullTimers(pending)
    this.clearIncomingForRequest(requestId)
    pending.files.length = 0
    if (notifyPeer) {
      this.rememberCancelledPull(requestId)
      void this.send('pull-cancel', { requestId, reason: message }).catch(() => undefined)
    }
    pending.reject(new Error(message))
  }

  private clearIncomingForRequest(requestId: string): void {
    for (const [transferId, transfer] of this.incoming) {
      if (transfer.meta.requestId !== requestId) continue
      this.incoming.delete(transferId)
      if (transfer.localDirectSession) void removeLocalTavernDirectFile(transfer.localDirectSession)
    }
  }

  private rememberCancelledPull(requestId: string): void {
    this.cancelledPulls.add(requestId)
    while (this.cancelledPulls.size > 64) {
      const oldest = this.cancelledPulls.values().next().value as string | undefined
      if (!oldest) break
      this.cancelledPulls.delete(oldest)
    }
    window.setTimeout(() => this.cancelledPulls.delete(requestId), PULL_ABSOLUTE_TIMEOUT_MS)
  }

  async finishPullBatch(exportBatchId: string): Promise<void> {
    this.directory?.finishPullBatch(exportBatchId)
    if (this.port && this.peerCapabilities.includes('pull-export-batch-v1'))
      await this.send('pull-batch-end', { exportBatchId })
  }

  disconnect(detail = '连接已断开'): void {
    this.secureJoinAbort?.abort()
    this.secureJoinAbort = undefined
    this.relayWorkerRelease?.()
    this.relayWorkerRelease = undefined
    this.directory = undefined
    if (this.helloTimer) window.clearInterval(this.helloTimer)
    this.port?.close()
    this.port = undefined
    this.relayWindow?.close()
    this.relayWindow = undefined
    this.relayOrigin = ''
    this.invitation = null
    this.peerCapabilities = []
    this.localDirectEnabled = false
    this.rejectPending(new Error(detail))
    this.state = {
      ...this.state,
      pairCode: '',
      tavernOrigin: '',
      bridgeVersion: '',
      tavernVersion: '',
      transport: 'none',
      capabilities: [],
    }
    this.setState('idle', detail)
  }

  private failConnection(reason: unknown, fallback: string): void {
    if (this.state.status === 'idle') return
    const error = reason instanceof Error ? reason : new Error(fallback)
    this.port?.close()
    this.port = undefined
    this.rejectPending(error)
    this.relayWorkerRelease?.()
    this.relayWorkerRelease = undefined
    this.setState('error', error.message)
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingLists.values()) {
      window.clearTimeout(pending.idleTimer)
      window.clearTimeout(pending.absoluteTimer)
      pending.reject(error)
    }
    for (const pending of this.pendingPulls.values()) {
      this.clearPullTimers(pending)
      pending.files.length = 0
      pending.reject(error)
    }
    for (const pending of this.pendingSends.values()) pending.reject(error)
    for (const pending of this.pendingAvatarChecks.values()) pending.reject(error)
    for (const pending of this.pendingLocalDirectSessions.values()) pending.reject(error)
    this.pendingLists.clear()
    this.pendingPulls.clear()
    this.pendingSends.clear()
    this.pendingAvatarChecks.clear()
    this.pendingLocalDirectSessions.clear()
    this.incoming.clear()
    this.cancelledPulls.clear()
    this.chunkSender.cancel(error)
  }

  private send(
    type: string,
    payload: Record<string, unknown> = {},
    transfer: Transferable[] = [],
  ): Promise<void> {
    if (!this.port) throw new Error('尚未连接酒馆扩展')
    const envelope = tavernEnvelope(type, payload)
    if (this.port instanceof TavernHttpRelayPort) {
      if (type === 'file-chunk') return this.port.postFileChunk(envelope)
      return this.port.postMessage(envelope)
    }
    this.port.postMessage(envelope, transfer)
    return Promise.resolve()
  }

  private assertConnected(): void {
    if (this.state.status !== 'connected' || !this.port) throw new Error('请先完成酒馆配对')
  }

  private async requestLocalDirectSession(signal?: AbortSignal): Promise<LocalTavernDirectSession> {
    const requestId = crypto.randomUUID()
    const pending = new Promise<LocalTavernDirectSession>((resolve, reject) => {
      this.pendingLocalDirectSessions.set(requestId, { resolve, reject })
    })
    void this.send('local-direct-session-request', { requestId }).catch((error) =>
      this.pendingLocalDirectSessions.get(requestId)?.reject(error),
    )
    return withAbortSignal(
      this.withTimeout(
        pending,
        requestId,
        this.pendingLocalDirectSessions,
        '创建本机直传会话超时',
        15_000,
      ),
      signal,
    )
  }

  private setState(status: TavernBridgeStatus, detail: string): void {
    this.state = { ...this.state, status, detail }
    this.dispatchEvent(new CustomEvent<TavernBridgeState>('state', { detail: this.getState() }))
  }

  private async withTimeout<T, P>(
    promise: Promise<T>,
    id: string,
    pending: Map<string, P>,
    message: string,
    timeout = 30_000,
  ): Promise<T> {
    let timer = 0
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = window.setTimeout(() => reject(new Error(message)), timeout)
        }),
      ])
    } finally {
      window.clearTimeout(timer)
      pending.delete(id)
    }
  }

  destroy(): void {
    this.disconnect()
    window.removeEventListener('message', this.handleWindowMessage)
  }

  private transferContext(): TavernBridgeTransferOperationsContext {
    const readDirectory = () => this.directory
    const writeDirectory = (value: TavernBridgeTransferOperationsContext['directory']) => {
      this.directory = value
    }
    const readPeerCapabilities = () => this.peerCapabilities
    const writePeerCapabilities = (
      value: TavernBridgeTransferOperationsContext['peerCapabilities'],
    ) => {
      this.peerCapabilities = value
    }
    const readState = () => this.state
    const writeState = (value: TavernBridgeTransferOperationsContext['state']) => {
      this.state = value
    }
    return {
      get directory() {
        return readDirectory()
      },
      set directory(value) {
        writeDirectory(value)
      },
      assertConnected: this.assertConnected.bind(this),
      isLocalTavernDirectAvailable: this.isLocalTavernDirectAvailable.bind(this),
      pendingSends: this.pendingSends,
      get peerCapabilities() {
        return readPeerCapabilities()
      },
      set peerCapabilities(value) {
        writePeerCapabilities(value)
      },
      requestLocalDirectSession: this.requestLocalDirectSession.bind(this),
      send: this.send.bind(this),
      chunkSender: this.chunkSender,
      withTimeout: this.withTimeout.bind(this),
      cancelledPulls: this.cancelledPulls,
      get state() {
        return readState()
      },
      set state(value) {
        writeState(value)
      },
      setState: this.setState.bind(this),
      pendingLocalDirectSessions: this.pendingLocalDirectSessions,
      pendingLists: this.pendingLists,
      touchList: this.touchList.bind(this),
      finishList: this.finishList.bind(this),
      pendingAvatarChecks: this.pendingAvatarChecks,
      touchPull: this.touchPull.bind(this),
      incoming: this.incoming,
      pendingPulls: this.pendingPulls,
      clearPullTimers: this.clearPullTimers.bind(this),
      failPull: this.failPull.bind(this),
      failList: this.failList.bind(this),
      disconnect: this.disconnect.bind(this),
    }
  }
}

/**
 * 互传服务单例。
 *
 * 刻意不放进 AppContainer：互传只在“功能 → 酒馆互传”页面用到，
 * 放在这里可以让整个互传实现跟随 TavernBridgeCenter 一起按需加载，
 * 不进入登录后立即拉取的公共容器分包。
 */
export const tavernBridgeService = new TavernBridgeService()
