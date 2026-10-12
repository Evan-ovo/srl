export { preparePersonaSendPlans, preparePersonaAvatarPlans } from './UseTavernPersonaSendPlans'
import type {
  TavernBridgeCenterProps,
  TavernReceiveFilter,
  TransferQueueItem,
  PersonaAvatarMode,
  PersonaAvatarPlan,
  PersonaSendPlan,
} from '../types/TavernBridgeCenter'

import { confirmAction } from '../composables/UseConfirmDialog'

import { browserStorageService, exportService, resourceService } from '../core/AppContainer'
import type { TavernSendContent } from '../types/BrowserPreferences'

import { tavernConnectionStore, type TavernConnectionSnapshot } from '../core/TavernConnectionStore'

import { prepareChatReturn, type ChatReturnPlan } from '../services/TavernChatReturn'

import type {
  TavernConflictPolicy,
  TavernResourceItem,
  TavernResourceKind,
} from '../services/TavernBridgeProtocol'

import { tavernBridgeService } from '../services/TavernBridgeService'
import { getDeviceRelayStatus } from '../services/RelayWorkerSettingsService'

import { RESOURCE_TYPE, type ResourceSummary } from '../types/Resource'

import { BRIDGE_EXTENSION_VERSION } from '../utils/BridgeInstall'

import { mapPersonaCharacterVariantsForTavern } from '../utils/TavernPersonaTransfer'

export interface UseTavernTransferActionsContext {
  sendContent: import('vue').Ref<TavernSendContent>
  activeAbortController: import('vue').ShallowRef<AbortController | null, AbortController | null>
  canCancelTransfer: import('vue').Ref<boolean, boolean>
  progress: import('vue').Ref<string, string>
  busy: import('vue').Ref<boolean, boolean>
  error: import('vue').Ref<string, string>
  reports: import('vue').Ref<string[], string[]>
  state: import('vue').Ref<
    {
      negotiated: {
        upload: import('../core/TavernCapabilities').TavernCapabilityMode
        setCurrentCharacter: import('../core/TavernCapabilities').TavernCapabilityMode
        setPersona: import('../core/TavernCapabilities').TavernCapabilityMode
        switchPreset: import('../core/TavernCapabilities').TavernCapabilityMode
        enableWorldInfo: import('../core/TavernCapabilities').TavernCapabilityMode
        enableRegex: import('../core/TavernCapabilities').TavernCapabilityMode
        openChat: import('../core/TavernCapabilities').TavernCapabilityMode
        sceneSwitcher: import('../core/TavernCapabilities').TavernCapabilityMode
      }
      inventory: {
        id: string
        kind: TavernResourceKind
        name: string
        fileName: string
        detail: string
        contentHash?: string | undefined
        updatedAt?: number | undefined
        size?: number | undefined
        sizeLabel?: string | undefined
      }[]
      chatInventoryLoaded: boolean
      lastSyncAt?: number | undefined
      status: import('../services/TavernBridgeTransferOperations').TavernBridgeStatus
      detail: string
      pairCode: string
      tavernOrigin: string
      bridgeVersion: string
      tavernVersion: string
      transport: import('../services/TavernBridgeTransferOperations').TavernBridgeTransport
      capabilities: string[]
    },
    | TavernConnectionSnapshot
    | {
        negotiated: {
          upload: import('../core/TavernCapabilities').TavernCapabilityMode
          setCurrentCharacter: import('../core/TavernCapabilities').TavernCapabilityMode
          setPersona: import('../core/TavernCapabilities').TavernCapabilityMode
          switchPreset: import('../core/TavernCapabilities').TavernCapabilityMode
          enableWorldInfo: import('../core/TavernCapabilities').TavernCapabilityMode
          enableRegex: import('../core/TavernCapabilities').TavernCapabilityMode
          openChat: import('../core/TavernCapabilities').TavernCapabilityMode
          sceneSwitcher: import('../core/TavernCapabilities').TavernCapabilityMode
        }
        inventory: {
          id: string
          kind: TavernResourceKind
          name: string
          fileName: string
          detail: string
          contentHash?: string | undefined
          updatedAt?: number | undefined
          size?: number | undefined
          sizeLabel?: string | undefined
        }[]
        chatInventoryLoaded: boolean
        lastSyncAt?: number | undefined
        status: import('../services/TavernBridgeTransferOperations').TavernBridgeStatus
        detail: string
        pairCode: string
        tavernOrigin: string
        bridgeVersion: string
        tavernVersion: string
        transport: import('../services/TavernBridgeTransferOperations').TavernBridgeTransport
        capabilities: string[]
      }
  >
  tavernItems: import('vue').Ref<
    {
      id: string
      kind: TavernResourceKind
      name: string
      fileName: string
      detail: string
      contentHash?: string | undefined
      updatedAt?: number | undefined
      size?: number | undefined
      sizeLabel?: string | undefined
    }[],
    | TavernResourceItem[]
    | {
        id: string
        kind: TavernResourceKind
        name: string
        fileName: string
        detail: string
        contentHash?: string | undefined
        updatedAt?: number | undefined
        size?: number | undefined
        sizeLabel?: string | undefined
      }[]
  >
  refreshTavernResources: (kind?: 'chat') => Promise<void>
  localDirectEnabled: import('vue').Ref<boolean, boolean>
  deviceCode: import('vue').Ref<string, string>
  selectedTavernIds: import('vue').Ref<Set<string>>
  includeChatScripts: import('vue').Ref<boolean>
  tavernReceiveFilter: import('vue').Ref<TavernReceiveFilter, TavernReceiveFilter>
  tavernReceiveFilters: import('vue').ComputedRef<
    { key: TavernReceiveFilter; label: string; count: number }[]
  >
  lastTransferDirection: 'pull' | 'send'
  disposed: boolean
  emit: ((event: 'back') => void) &
    ((event: 'import-files', files: File[], onComplete?: (() => void) | undefined) => void)
  transferQueue: import('vue').Ref<TransferQueueItem[]>
  recordReport: (entry: string) => void
  transferOrigin: string
  beginTransfer: () => AbortSignal
  runPullQueue: (items: TavernResourceItem[], signal?: AbortSignal) => Promise<void>
  endTransfer: () => void
  failedTransferKeys: import('vue').ComputedRef<string[]>
  supportedLocalResources: import('vue').ComputedRef<ResourceSummary[]>
  confirmDirectoryWrite: () => Promise<boolean>
  preparePersonaSendPlans: (
    summaries: ResourceSummary[],
    signal?: AbortSignal,
  ) => Promise<Map<string, PersonaSendPlan> | null>
  preparePersonaAvatarPlans: (
    summaries: ResourceSummary[],
    personaPlans?: Map<string, PersonaSendPlan>,
    signal?: AbortSignal,
  ) => Promise<Map<string, PersonaAvatarPlan> | null>
  runSendQueue: (
    summaries: ResourceSummary[],
    avatarPlans?: Map<string, PersonaAvatarPlan>,
    personaPlans?: Map<string, PersonaSendPlan>,
    signal?: AbortSignal,
  ) => Promise<void>
  selectedLocalIds: import('vue').Ref<Set<string>>
  chatReturnPlans: Map<string, ChatReturnPlan>
  includeChatRegex: import('vue').Ref<boolean, boolean>
  conflictPolicy: import('vue').Ref<TavernConflictPolicy, TavernConflictPolicy>
  props: Readonly<
    TavernBridgeCenterProps &
      Required<Pick<TavernBridgeCenterProps, 'categories' | 'initialLocalIds'>>
  >
  personaAvatarMode: import('vue').Ref<PersonaAvatarMode, PersonaAvatarMode>
  canCheckPersonaAvatars: import('vue').ComputedRef<boolean>
  bridgeKind: (resource: ResourceSummary) => TavernResourceKind
}
export function beginTransfer(operations: UseTavernTransferActionsContext): AbortSignal {
  const controller = new AbortController()
  operations.activeAbortController.value = controller
  operations.canCancelTransfer.value = true
  return controller.signal
}

export function endTransfer(operations: UseTavernTransferActionsContext): void {
  operations.activeAbortController.value = null
  operations.canCancelTransfer.value = false
}

export function cancelTransfer(operations: UseTavernTransferActionsContext): void {
  operations.activeAbortController.value?.abort(new DOMException('已取消当前传输', 'AbortError'))
  operations.progress.value = '正在停止当前传输并清理未完成数据…'
}

export async function bindDirectory(
  operations: UseTavernTransferActionsContext,
  reuse = true,
): Promise<void> {
  if (operations.busy.value) return
  operations.busy.value = true
  operations.error.value = ''
  try {
    await tavernBridgeService.bindDirectory(reuse)
    await tavernConnectionStore.refreshInventory()
  } catch (reason) {
    if (!(reason instanceof DOMException && reason.name === 'AbortError')) {
      operations.error.value = reason instanceof Error ? reason.message : '无法绑定酒馆目录'
    }
  } finally {
    operations.busy.value = false
  }
}

export function recordReport(operations: UseTavernTransferActionsContext, entry: string): void {
  const stamp = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  operations.reports.value = browserStorageService.appendBridgeTransferLog([`[${stamp}] ${entry}`])
}

export function handleState(operations: UseTavernTransferActionsContext, event: Event): void {
  operations.state.value = (event as CustomEvent<TavernConnectionSnapshot>).detail
  operations.tavernItems.value = operations.state.value.inventory
  if (
    operations.state.value.status === 'connected' &&
    !operations.tavernItems.value.length &&
    !operations.state.value.lastSyncAt
  ) {
    void operations.refreshTavernResources()
  }
}

export function setLocalDirectEnabled(operations: UseTavernTransferActionsContext): void {
  tavernBridgeService.setLocalTavernDirectEnabled(operations.localDirectEnabled.value)
}

export function acceptPairing(operations: UseTavernTransferActionsContext): void {
  operations.error.value = ''
  try {
    tavernBridgeService.accept()
    operations.progress.value = '已确认配对码，等待酒馆完成连接…'
  } catch (reason) {
    operations.error.value = reason instanceof Error ? reason.message : '无法确认配对'
  }
}

export async function joinDeviceRelay(operations: UseTavernTransferActionsContext): Promise<void> {
  operations.error.value = ''
  if (operations.busy.value) return
  const relayStatus = getDeviceRelayStatus()
  if (!relayStatus.enabled) {
    await confirmAction({
      title: '中继码',
      message: relayStatus.message,
      confirmLabel: '知道了',
      centered: true,
    })
    return
  }
  const code = operations.deviceCode.value.trim().toUpperCase()
  if (!/^[2-9A-HJ-NP-Z]{8}$/u.test(code)) {
    operations.error.value = '请输入酒馆显示的 8 位设备码'
    return
  }
  operations.busy.value = true
  try {
    operations.progress.value = '正在通过 HTTPS 安全中继连接酒馆…'
    await tavernBridgeService.joinSecureRelay(code)
    operations.progress.value = '已找到酒馆，请核对两端显示的六位确认码'
  } catch (reason) {
    operations.progress.value = ''
    operations.error.value =
      reason instanceof Error
        ? reason.message
        : '无法连接 HTTPS 酒馆中继，请确认云服务器和酒馆扩展均已更新。'
  } finally {
    operations.busy.value = false
  }
}

export async function connectLocalTavern(
  operations: UseTavernTransferActionsContext,
): Promise<void> {
  operations.error.value = ''
  if (operations.busy.value) return
  operations.busy.value = true
  try {
    operations.progress.value = '正在请求本机酒馆；请稍后在酒馆扩展确认…'
    await tavernBridgeService.connectLocalTavern()
    operations.localDirectEnabled.value = true
  } catch (reason) {
    operations.progress.value = ''
    operations.error.value = reason instanceof Error ? reason.message : '无法连接本机酒馆'
  } finally {
    operations.busy.value = false
  }
}

export function disconnectTavern(operations: UseTavernTransferActionsContext): void {
  tavernBridgeService.disconnect('已手动断开酒馆连接')
  operations.tavernItems.value = []
  operations.selectedTavernIds.value = new Set()
  operations.localDirectEnabled.value = false
  operations.error.value = ''
  operations.progress.value = '已断开；可用本机连接或设备码重新连接。'
}

export async function refreshTavernResources(
  operations: UseTavernTransferActionsContext,
  kind?: 'chat',
): Promise<void> {
  if (operations.busy.value || operations.state.value.status !== 'connected') return
  operations.busy.value = true
  operations.error.value = ''
  operations.progress.value = '正在读取酒馆资源目录…'
  try {
    operations.tavernItems.value = await tavernConnectionStore.refreshInventory(kind)
    if (kind) operations.tavernReceiveFilter.value = kind
    operations.selectedTavernIds.value = new Set(
      Array.from(operations.selectedTavernIds.value).filter((id) =>
        operations.tavernItems.value.some((item) => item.id === id),
      ),
    )
    if (
      operations.tavernItems.value.length > 24 &&
      operations.tavernReceiveFilter.value === 'all' &&
      operations.tavernReceiveFilters.value[1]
    ) {
      operations.tavernReceiveFilter.value = operations.tavernReceiveFilters.value[1].key
    }
    operations.progress.value = kind
      ? `已读取 ${operations.tavernItems.value.filter((item) => item.kind === kind).length} 条已保存聊天；接收时随附所属角色卡`
      : `已读取 ${operations.tavernItems.value.length} 项酒馆资源`
  } catch (reason) {
    operations.error.value = reason instanceof Error ? reason.message : '无法读取酒馆资源'
  } finally {
    operations.busy.value = false
  }
}

export async function runPullQueue(
  operations: UseTavernTransferActionsContext,
  items: TavernResourceItem[],
  signal?: AbortSignal,
): Promise<void> {
  operations.lastTransferDirection = 'pull'
  operations.busy.value = true
  operations.error.value = ''
  let files: File[] = []
  let receivedEntries: TransferQueueItem[] = []
  let batchBytes = 0
  let receivedCount = 0
  let done = 0
  const exportBatchId = items.length > 1 ? crypto.randomUUID() : undefined
  const importBatch = async (): Promise<void> => {
    if (!files.length || operations.disposed) return
    const batch = files
    const entries = receivedEntries
    files = []
    receivedEntries = []
    batchBytes = 0
    await new Promise<void>((resolve) => operations.emit('import-files', batch, resolve))
    for (const entry of entries) {
      entry.status = 'done'
      entry.detail = '已导入处理，请查看资源库提示'
    }
    const remainingSelection = new Set(operations.selectedTavernIds.value)
    for (const entry of entries) remainingSelection.delete(entry.key)
    operations.selectedTavernIds.value = remainingSelection
  }
  try {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!
      if (operations.disposed || signal?.aborted) break
      const entry = operations.transferQueue.value.find((queued) => queued.key === item.id)
      if (!entry) continue
      entry.status = 'active'
      operations.progress.value = `正在接收 ${done + 1} / ${items.length}：${item.name}`
      try {
        const [file] = await tavernBridgeService.pullResources(
          [
            {
              ...item,
              readingScriptIds: entry.readingScriptIds,
              carryReadingScripts: entry.carryReadingScripts,
            },
          ],
          { signal, exportBatchId },
        )
        if (!file) throw new Error('酒馆没有返回文件，资源可能已被删除')
        files.push(file)
        batchBytes += file.size
        receivedCount += 1
        receivedEntries.push(entry)
        entry.detail = '已接收，等待分批导入'
      } catch (reason) {
        if (signal?.aborted) {
          entry.status = 'pending'
          entry.detail = '已取消，未完成的资源可重试'
          for (const remaining of items.slice(index + 1)) {
            const queued = operations.transferQueue.value.find(
              (candidate) => candidate.key === remaining.id,
            )
            if (queued && queued.status !== 'done') queued.detail = '已取消，尚未开始'
          }
          break
        }
        entry.status = 'failed'
        entry.detail = reason instanceof Error ? reason.message : '接收失败'
        const message = entry.detail
        const transportFailed =
          operations.state.value.status !== 'connected' ||
          /超时|连接已断开|通信通道|中继|分块确认/u.test(message)
        if (transportFailed) {
          for (const remaining of items.slice(index + 1)) {
            const queued = operations.transferQueue.value.find(
              (candidate) => candidate.key === remaining.id,
            )
            if (queued && queued.status !== 'done') {
              queued.status = 'pending'
              queued.detail = '上一项传输中断，尚未尝试；恢复连接后可继续'
            }
          }
          break
        }
      }
      done += 1
      if (files.length >= 25 || batchBytes >= 64 * 1024 * 1024) await importBatch()
    }
    await importBatch()
    const failed = operations.transferQueue.value.filter((item) => item.status === 'failed').length
    const paused = operations.transferQueue.value.filter((item) => item.status === 'pending').length
    operations.progress.value = signal?.aborted
      ? `已取消：已接收 ${receivedCount} 项；未完成项可重试`
      : failed
        ? `接收暂停：已接收 ${receivedCount} 项、失败 ${failed} 项${paused ? `、未尝试 ${paused} 项` : ''}；可重试失败和未完成项`
        : `已从酒馆取回 ${receivedCount} 项；资源已分批交给导入，结果会在底部通知中显示`
    operations.recordReport(
      `从酒馆接收 ${receivedCount} 项${failed || paused ? `（失败 ${failed}、未尝试 ${paused}）` : ''}`,
    )
    tavernConnectionStore.recordSync(operations.tavernItems.value)
  } finally {
    if (exportBatchId)
      await tavernBridgeService.finishPullBatch(exportBatchId).catch(() => undefined)
    operations.busy.value = false
  }
}

export async function pullFromTavern(operations: UseTavernTransferActionsContext): Promise<void> {
  const items = operations.tavernItems.value.filter((item) =>
    operations.selectedTavernIds.value.has(item.id),
  )
  if (!items.length || operations.busy.value) return
  operations.lastTransferDirection = 'pull'
  operations.transferOrigin = operations.state.value.tavernOrigin
  operations.transferQueue.value = items.map((item) => ({
    key: item.id,
    name: item.name,
    label: '取回',
    status: 'pending',
    detail: '',
    ...(item.kind === 'chat'
      ? {
          carryReadingScripts: operations.includeChatScripts.value,
          readingScriptIds: [],
        }
      : {}),
  }))
  const signal = operations.beginTransfer()
  try {
    await operations.runPullQueue(items, signal)
  } finally {
    operations.endTransfer()
  }
}

export async function retryFailedTransfers(
  operations: UseTavernTransferActionsContext,
): Promise<void> {
  if (operations.busy.value || !operations.failedTransferKeys.value.length) return
  if (operations.state.value.status !== 'connected') {
    operations.error.value = '请先重新连接原来的酒馆'
    return
  }
  if (operations.transferOrigin !== operations.state.value.tavernOrigin) {
    operations.error.value = '当前连接与上次任务的目标不同，请重新选择资源发起传输'
    return
  }
  const keys = new Set(operations.failedTransferKeys.value)
  if (operations.lastTransferDirection === 'pull') {
    const items = operations.tavernItems.value.filter((item) => keys.has(item.id))
    if (!items.length) {
      operations.error.value = '失败的条目已不在酒馆目录中，请刷新目录后重新选择'
      return
    }
    for (const entry of operations.transferQueue.value)
      if (keys.has(entry.key)) entry.status = 'pending'
    const signal = operations.beginTransfer()
    try {
      await operations.runPullQueue(items, signal)
    } finally {
      operations.endTransfer()
    }
  } else {
    const summaries = operations.supportedLocalResources.value.filter((resource) =>
      keys.has(resource.id),
    )
    if (!summaries.length) {
      operations.error.value = '失败的条目已不在本地列表中'
      return
    }
    if (!(await operations.confirmDirectoryWrite())) return
    let avatarPlans: Map<string, PersonaAvatarPlan>
    let personaPlans: Map<string, PersonaSendPlan>
    operations.busy.value = true
    const signal = operations.beginTransfer()
    try {
      const prepared = await operations.preparePersonaSendPlans(summaries, signal)
      if (!prepared) return
      personaPlans = prepared
      const avatars = await operations.preparePersonaAvatarPlans(summaries, personaPlans, signal)
      if (!avatars) return
      avatarPlans = avatars
      if (operations.state.value.status !== 'connected')
        throw new Error('酒馆连接已断开，请重新连接后重试')
      for (const entry of operations.transferQueue.value)
        if (keys.has(entry.key)) entry.status = 'pending'
      await operations.runSendQueue(summaries, avatarPlans, personaPlans, signal)
    } catch (reason) {
      if (signal.aborted) operations.progress.value = '已取消发送；未完成项可重试'
      else operations.error.value = reason instanceof Error ? reason.message : '无法核对酒馆头像'
    } finally {
      operations.endTransfer()
      operations.busy.value = false
    }
  }
}

export async function confirmDirectoryWrite(
  operations: UseTavernTransferActionsContext,
): Promise<boolean> {
  if (operations.state.value.transport !== 'directory') return true
  return confirmAction({
    title: '写入本地酒馆目录',
    message: `目标：${operations.state.value.tavernOrigin}。请先关闭酒馆页面和程序，避免它保存旧设置覆盖本次修改。覆盖前会保存原文件到 .srl-backups，写入后下次启动生效。`,
    confirmLabel: '酒馆已关闭，继续',
  })
}

export async function sendToTavern(operations: UseTavernTransferActionsContext): Promise<void> {
  const summaries = operations.supportedLocalResources.value.filter((resource) =>
    operations.selectedLocalIds.value.has(resource.id),
  )
  if (!summaries.length || operations.busy.value) return
  operations.busy.value = true
  const signal = operations.beginTransfer()
  operations.transferQueue.value = summaries.map((summary) => ({
    key: summary.id,
    name: summary.name,
    label: '发送',
    content: operations.sendContent.value,
    syncCharacterTags:
      operations.sendContent.value === 'modified' &&
      browserStorageService.getModifiedResourceSyncTags(),
    status: 'pending',
    detail: '等待发送前核对',
    operationId: crypto.randomUUID(),
  }))
  operations.progress.value = `正在准备发送 ${summaries.length} 项：核对同名资源和传输方式`
  try {
    if (!(await operations.confirmDirectoryWrite())) return
    if (summaries.some((resource) => resource.type === RESOURCE_TYPE.CHAT)) {
      if (!operations.state.value.capabilities.includes('chat-import-v1'))
        throw new Error('请先更新酒馆互传扩展：当前版本不支持聊天回传')
      const inventory = await tavernBridgeService.listResources(undefined, { signal })
      operations.chatReturnPlans.clear()
      for (const summary of summaries.filter((item) => item.type === RESOURCE_TYPE.CHAT)) {
        const chat = await resourceService.get(summary.id)
        if (!chat) throw new Error('聊天记录已不存在')
        operations.chatReturnPlans.set(
          chat.id,
          await prepareChatReturn(
            chat,
            resourceService,
            inventory,
            operations.includeChatRegex.value,
          ),
        )
      }
      if (
        !(await confirmAction({
          title: '确认导入聊天记录',
          message:
            [...operations.chatReturnPlans]
              .map(
                ([id, plan]) =>
                  `${summaries.find((item) => item.id === id)!.name} → ${plan.targetLabel}`,
              )
              .join('\n') +
            '\n\n聊天会作为新记录导入，不切换当前聊天，不覆盖原记录。' +
            (operations.includeChatRegex.value
              ? '\n配套正则会添加为目标角色的停用正则；不修改全局或预设正则，需在酒馆选择启用。'
              : '\n只导入聊天记录，酒馆原有正则保持不变。'),
          confirmLabel: '确认目标并导入',
        }))
      )
        return
    }
    const scriptCount = summaries.filter(
      (resource) => resource.type === RESOURCE_TYPE.SCRIPT,
    ).length
    if (
      scriptCount &&
      !(await confirmAction({
        title: '发送助手脚本',
        message: `所选中包含 ${scriptCount} 个酒馆助手脚本。脚本会以“全部停用”状态进入酒馆的全局脚本库，需要你在酒馆助手中确认内容后手动启用；不会自动运行任何代码。
接收端页面扩展需为 ${BRIDGE_EXTENSION_VERSION} 或更高版本。`,
        confirmLabel: '以停用状态发送',
      }))
    ) {
      return
    }
    if (
      operations.conflictPolicy.value === 'overwrite' &&
      !(await confirmAction({
        title: '覆盖同名资源',
        message: '覆盖模式会替换酒馆中的同名资源。SRL 内的原文件不会改变，确定继续吗？',
        confirmLabel: '覆盖发送',
        danger: true,
      }))
    ) {
      return
    }
    let avatarPlans: Map<string, PersonaAvatarPlan>
    let personaPlans: Map<string, PersonaSendPlan>
    try {
      const prepared = await operations.preparePersonaSendPlans(summaries, signal)
      if (!prepared) return
      personaPlans = prepared
      const avatars = await operations.preparePersonaAvatarPlans(summaries, personaPlans, signal)
      if (!avatars) return
      avatarPlans = avatars
    } catch (reason) {
      operations.error.value = reason instanceof Error ? reason.message : '无法核对酒馆头像'
      return
    }
    if (operations.state.value.status !== 'connected') {
      operations.error.value = '酒馆连接已断开，请重新连接后重试'
      return
    }
    operations.lastTransferDirection = 'send'
    operations.transferOrigin = operations.state.value.tavernOrigin
    if (signal.aborted) throw signal.reason
    await operations.runSendQueue(summaries, avatarPlans, personaPlans, signal)
  } catch (reason) {
    if (signal.aborted) {
      for (const entry of operations.transferQueue.value) {
        if (entry.status !== 'done') {
          entry.status = 'pending'
          entry.detail = '已取消，未完成资源可重试'
        }
      }
      operations.progress.value = '已取消发送；未完成项可重试'
    } else {
      operations.error.value = reason instanceof Error ? reason.message : '发送失败'
    }
  } finally {
    operations.endTransfer()
    operations.busy.value = false
  }
}

export async function runSendQueue(
  operations: UseTavernTransferActionsContext,
  summaries: ResourceSummary[],
  avatarPlans = new Map<string, PersonaAvatarPlan>(),
  personaPlans = new Map<string, PersonaSendPlan>(),
  signal?: AbortSignal,
): Promise<void> {
  operations.lastTransferDirection = 'send'
  operations.busy.value = true
  operations.error.value = ''
  let sentCount = 0
  const content = operations.sendContent.value
  const syncCharacterTags =
    content === 'modified' && browserStorageService.getModifiedResourceSyncTags()
  const transferredCharacterAvatars = new Set<string>()
  try {
    for (let index = 0; index < summaries.length; index += 1) {
      if (signal?.aborted) {
        for (const remaining of summaries.slice(index)) {
          const queued = operations.transferQueue.value.find((item) => item.key === remaining.id)
          if (queued && queued.status !== 'done') {
            queued.status = 'pending'
            queued.detail = '已取消，尚未发送；可重试'
          }
        }
        break
      }
      const summary = summaries[index]!
      const entry = operations.transferQueue.value.find((queued) => queued.key === summary.id)
      if (!entry) continue
      if (
        (entry.content ?? 'original') !== content ||
        (entry.syncCharacterTags ?? false) !== syncCharacterTags
      ) {
        // Changed payloads must not reuse a receiver's acknowledgement of an older operation.
        entry.operationId = crypto.randomUUID()
      }
      entry.content = content
      entry.syncCharacterTags = syncCharacterTags
      entry.status = 'active'
      operations.progress.value = `正在发送 ${index + 1} / ${summaries.length}：${summary.name}`
      const personaPlan = personaPlans.get(summary.id)
      if (personaPlan?.skip) {
        entry.status = 'done'
        entry.detail = '酒馆已有相同人设，已跳过'
        continue
      }
      let avatarDetail = ''
      const personaTransferDetails: string[] = []
      let roleCardImported = false
      try {
        const resource = await resourceService.get(summary.id)
        if (!resource) throw new Error('资源已不存在')
        const chatPlan = operations.chatReturnPlans.get(resource.id)
        if (resource.type === RESOURCE_TYPE.CHAT && !chatPlan)
          throw new Error('请重新选择聊天并确认接收角色')
        const avatarPlan = avatarPlans.get(summary.id)
        if (
          summary.type === RESOURCE_TYPE.USER_PERSONA &&
          operations.personaAvatarMode.value !== 'none' &&
          !avatarPlan
        ) {
          avatarDetail = '没有已缓存封面；仅传人设'
        }
        if (avatarPlan) {
          if (avatarPlan.exists && operations.personaAvatarMode.value === 'missing') {
            avatarDetail = '酒馆同名头像已保留'
          } else {
            const [avatarResult] = await tavernBridgeService.sendFiles(
              [
                {
                  file: avatarPlan.file,
                  kind: 'userAvatar',
                  displayName: avatarPlan.avatarId,
                  targetName: avatarPlan.avatarId,
                },
              ],
              operations.personaAvatarMode.value === 'replace' ? 'overwrite' : 'skip',
              undefined,
              { signal },
            )
            avatarDetail =
              avatarResult?.status === 'skipped'
                ? '酒馆同名头像已保留'
                : `头像${avatarResult?.status === 'overwritten' ? '已替换' : '已上传'}`
          }
        }
        let personaFile = personaPlan?.file
        if (summary.type === RESOURCE_TYPE.USER_PERSONA) {
          const characterTargets = new Map(
            Array.from(personaPlan?.characterTargets ?? [], ([personaAvatar, mappings]) => [
              personaAvatar,
              new Map(mappings),
            ]),
          )
          if (personaPlan?.sendMissingCharacters) {
            for (const missing of personaPlan.missingCharacters ?? []) {
              if (transferredCharacterAvatars.has(missing.avatarId)) {
                const mappings = characterTargets.get(missing.personaAvatar) ?? new Map()
                mappings.set(missing.sourceId, missing.avatarId)
                characterTargets.set(missing.personaAvatar, mappings)
                continue
              }
              if (!missing.file) {
                personaTransferDetails.push(
                  `${missing.name}角色卡文件不在资源库，只保留全局/已匹配设定`,
                )
                continue
              }
              try {
                let file = missing.file
                if (content === 'modified' && missing.resourceId) {
                  const card = await resourceService.get(missing.resourceId)
                  if (!card) throw new Error('待补传角色卡已不存在')
                  file = await exportService.createTavernTransferFile(
                    card,
                    content,
                    resourceService,
                    missing.avatarId,
                    { syncCharacterTags },
                  )
                }
                const [cardResult] = await tavernBridgeService.sendFiles(
                  [
                    {
                      file,
                      kind: 'character',
                      displayName: `${missing.name} · 角色卡`,
                      operationId: `${entry.operationId}:character:${missing.avatarId}`,
                    },
                  ],
                  'skip',
                  undefined,
                  { signal },
                )
                if (cardResult?.status === 'created' || cardResult?.status === 'overwritten') {
                  transferredCharacterAvatars.add(missing.avatarId)
                  roleCardImported = true
                  const mappings = characterTargets.get(missing.personaAvatar) ?? new Map()
                  mappings.set(missing.sourceId, missing.avatarId)
                  characterTargets.set(missing.personaAvatar, mappings)
                  personaTransferDetails.push(`${missing.name}角色卡已传入`)
                } else {
                  personaTransferDetails.push(`${missing.name}角色卡未导入，已跳过对应专属设定`)
                }
              } catch (reason) {
                if (signal?.aborted) throw reason
                const message = reason instanceof Error ? reason.message : '角色卡发送失败'
                personaTransferDetails.push(`${missing.name}角色卡未导入：${message}`)
              }
            }
          } else if (personaPlan?.missingCharacters?.length) {
            personaTransferDetails.push('按选择跳过酒馆缺少的角色卡专属设定')
          }
          const personaSourceFile =
            personaFile ??
            (await exportService.createTavernTransferFile(resource, content, resourceService))
          const personaBackup = JSON.parse(await personaSourceFile.text())
          const mappedBackup = mapPersonaCharacterVariantsForTavern(personaBackup, characterTargets)
          personaFile = new File([JSON.stringify(mappedBackup, null, 2)], personaSourceFile.name, {
            type: 'application/json',
          })
        }
        if (personaPlan?.skipPersona) {
          entry.status = 'done'
          entry.detail = [
            '酒馆已有相同人设，未重复写入',
            roleCardImported ? '缺少的角色卡已补传' : '',
            ...personaTransferDetails,
          ]
            .filter(Boolean)
            .join(' · ')
          if (roleCardImported) sentCount += 1
          continue
        }
        const transferFile =
          personaFile ??
          (await exportService.createTavernTransferFile(
            resource,
            content,
            resourceService,
            undefined,
            { syncCharacterTags },
          ))
        const [result] = await tavernBridgeService.sendFiles(
          [
            {
              file: transferFile,
              kind: operations.bridgeKind(summary),
              displayName: summary.name,
              operationId: entry.operationId,
              targetName: chatPlan
                ? chatPlan.avatar
                : typeof resource.metadata.extractedFromCharacterName === 'string'
                  ? resource.metadata.extractedFromCharacterName
                  : typeof resource.metadata.extractedFromPresetName === 'string'
                    ? resource.metadata.extractedFromPresetName
                    : typeof resource.metadata.sourceName === 'string'
                      ? resource.metadata.sourceName
                      : undefined,
            },
          ],
          chatPlan
            ? 'copy'
            : personaPlan?.forceOverwritePersona
              ? 'overwrite'
              : personaPlan?.file
                ? 'skip'
                : operations.conflictPolicy.value,
          (_completed, _total, detail) => {
            if (detail) operations.progress.value = detail
          },
          { signal },
        )
        if (resource.type === RESOURCE_TYPE.CHARACTER_CARD && result?.status !== 'skipped') {
          transferredCharacterAvatars.add(transferFile.name)
        }
        if (chatPlan?.regexFile) {
          avatarDetail = '聊天已导入'
          await tavernBridgeService.sendFiles(
            [
              {
                file: chatPlan.regexFile,
                kind: 'regexCharacter',
                displayName: '聊天配套正则（停用）',
                targetName: chatPlan.avatar,
                operationId: entry.operationId + ':regex',
              },
            ],
            'copy',
            undefined,
            { signal },
          )
          avatarDetail = '配套正则已添加，保持停用'
        }
        entry.status = 'done'
        entry.detail = [
          result?.status === 'skipped'
            ? '已跳过相同或同名资源'
            : operations.state.value.transport === 'directory'
              ? '已写入并校验，下次启动酒馆生效'
              : '酒馆已确认导入',
          avatarDetail,
          ...personaTransferDetails,
        ]
          .filter(Boolean)
          .join(' · ')
        if (result?.status !== 'skipped') sentCount += 1
      } catch (reason) {
        if (signal?.aborted) {
          entry.status = 'pending'
          entry.detail = ['已取消，未完成人设可重试', ...personaTransferDetails]
            .filter(Boolean)
            .join(' · ')
          for (const remaining of summaries.slice(index + 1)) {
            const queued = operations.transferQueue.value.find((item) => item.key === remaining.id)
            if (queued && queued.status !== 'done') {
              queued.status = 'pending'
              queued.detail = '已取消，尚未发送；可重试'
            }
          }
          break
        }
        entry.status = 'failed'
        const message = reason instanceof Error ? reason.message : '发送失败'
        entry.detail = [
          avatarDetail,
          ...personaTransferDetails,
          message.includes('暂不支持')
            ? `${message}；助手脚本互传需要页面扩展 ${BRIDGE_EXTENSION_VERSION}+，请在酒馆扩展管理中点击更新`
            : message,
        ]
          .filter(Boolean)
          .join(' · ')
      }
    }
    const failed = operations.transferQueue.value.filter((item) => item.status === 'failed').length
    if (sentCount) operations.selectedLocalIds.value = new Set()
    if (sentCount) {
      operations.tavernItems.value = await tavernConnectionStore
        .refreshInventory()
        .catch(() => operations.tavernItems.value)
    }
    operations.recordReport(`发送 ${sentCount} 项到酒馆${failed ? `（${failed} 项失败）` : ''}`)
    operations.progress.value = signal?.aborted
      ? `已取消：已发送 ${sentCount} 项；未完成项可重试`
      : failed
        ? `发送完成：成功 ${sentCount} 项、失败 ${failed} 项；失败项可单独重试`
        : operations.state.value.transport === 'directory'
          ? `已写入 ${sentCount} 项到酒馆目录；下次启动酒馆后生效`
          : `已发送 ${sentCount} 项到酒馆；如果酒馆界面未刷新，请在酒馆内刷新对应列表`
  } finally {
    operations.busy.value = false
  }
}
