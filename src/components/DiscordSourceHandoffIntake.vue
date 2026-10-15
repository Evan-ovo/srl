<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import { communitySourceService } from '../core/CommunitySourceRuntime'
import {
  discordInboxAutomationSettingsService,
  initializeVaultOnce,
  resourceService,
  vaultService,
} from '../core/LibraryContainer'
import { useTransientStatus } from '../composables/UseTransientStatus'
import {
  clearDiscordHandoffFromLocation,
  acknowledgeDiscordHandoff,
  acknowledgeDiscordInboxJob,
  acknowledgeDiscordInboxSourceBound,
  listDiscordInboxJobs,
  listDiscordInboxWaitingSources,
  parseDiscordHandoffLink,
  readDiscordHandoffFromLocation,
  receiveDiscordHandoff,
  receiveDiscordInboxJob,
  type DiscordHandoffRequest,
} from '../services/DiscordHandoffService'
import { loadDiscordSourceConnectionSettings } from '../services/DiscordSourceSettingsService'
import {
  notifyNativeDiscordInboxResult,
  readNativeDiscordInboxState,
} from '../services/NativeDiscordInboxService'
import { autoBindPostToRecentCard, markPostForNextPng } from '../services/DiscordInboxAutoBinding'
import { DEFAULT_DISCORD_INBOX_AUTOMATION_SETTINGS } from '../services/DiscordInboxAutomationSettings'
import {
  isWebDiscordInboxAvailable,
  isWebDiscordInboxPaused,
  webDiscordInboxSignal,
  registerWebInboxParticipant,
  type WebInboxCycle,
} from '../services/WebDiscordInboxSession'
import { installWebInboxNotificationNavigation } from '../services/WebDiscordInboxNotifications'
import type { NativeDeepLink } from '../core/NativeRuntime'
import type { ResourceCommunitySourceView } from '../types/CommunitySource'
import type { ResourceListSummary } from '../types/Resource'
import { isResourceGalleryImage } from '../types/ResourceGallery'
import { createAsyncPanel } from '../core/AsyncPanel'
const ResourcePicker = createAsyncPanel('关联资源', () => import('./ResourcePicker.vue'))

const pending = ref<ResourceCommunitySourceView>()
const resources = ref<ResourceListSummary[]>([])
const selectedResourceId = ref('')
const busy = ref(false)
const receiving = ref(false)
const errorMessage = ref('')
const pasteDialogOpen = ref(false)
const handoffLink = ref('')
const { statusMessage, showTransientStatus } = useTransientStatus()
let receiveQueue: Promise<void> = Promise.resolve()
let receiveOperations = 0
let inboxRun: Promise<void> | undefined
let inboxRequested = false
let unregisterWebInbox: (() => void) | undefined
let removeNotificationNavigation: (() => void) | undefined
let disposed = false
const queuedRequests = new Map<string, Promise<void>>()
const deferredRequests = new Map<string, DiscordHandoffRequest>()
const presentedManualReceipts = new Set<string>()
const attachmentJobs = new Map<string, { sourceId: string; messageId: string }>()
const boundSourceKeys = new Set<string>()
// Temporary-link tokens remain only in this mounted session, with a fixed receipt limit.
const manualWaitingDeliveries = new Map<
  string,
  {
    sourceKeyHash: string
    request: DiscordHandoffRequest
    delivery: NonNullable<HandoffEnvelope['delivery']>
  }
>()
let localizing = false
let waitingSourceScope = ''
let waitingSourceCursor: string | undefined
const deferredBindings: ResourceCommunitySourceView[] = []
type DeliveryState = 'saved' | 'waiting_binding'
type HandoffEnvelope = Awaited<ReturnType<typeof receiveDiscordHandoff>>

function receiptKey(workerUrl: string, libraryId: string | null | undefined, id: string): string {
  return JSON.stringify([workerUrl, libraryId ?? null, id])
}

function assertVaultUnlocked(): void {
  if (vaultService.getStatus().locked)
    throw new Error('保险库已锁定，云端任务尚未确认；解锁后继续领取。')
}

function assertInboxConnection(
  settings: ReturnType<typeof loadDiscordSourceConnectionSettings>,
): void {
  assertVaultUnlocked()
  const current = loadDiscordSourceConnectionSettings()
  if (
    current.workerBaseUrl !== settings.workerBaseUrl ||
    current.inboxLibraryId !== settings.inboxLibraryId ||
    current.inboxSecret !== settings.inboxSecret
  )
    throw new Error('本机收件目标或凭据已变更；请在原目标中确认已保存的任务。')
}

function enqueueReceive(operation: () => Promise<void>): Promise<void> {
  receiveOperations++
  const next = receiveQueue
    .then(() => (disposed ? undefined : operation()))
    .finally(() => {
      receiveOperations--
      if (!receiveOperations) startAttachmentLocalization()
    })
  receiveQueue = next.catch(() => undefined)
  return next
}

function publishInboxProgress(detail: {
  status: 'receiving' | 'ready' | 'locked' | 'error'
  busy: boolean
  received: number
  waitingBinding: number
  error?: string
}): void {
  window.dispatchEvent(new CustomEvent('srl:discord-inbox-updated', { detail }))
}

function inboxError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : ''
  if (cause instanceof Error && cause.name === 'QuotaExceededError')
    return '本机存储空间不足，未完成本机保存；云端任务尚未确认。'
  if (message.includes('云端确认未完成'))
    return '正文已保存在本机，云端确认未完成；稍后刷新会重试确认。'
  if (message.includes('过期'))
    return '云端任务已过期，或 Worker 尚未支持此功能；过期帖子需要重新保存。'
  if (['目标', '配对', '收件库', '另一份资源库'].some((value) => message.includes(value)))
    return '收件目标或配对状态不匹配，未向当前资源库保存新帖子；请检查默认目标。'
  if (message.includes('读回校验')) return '本机正文读回校验未完成，云端任务尚未确认，请稍后重试。'
  return '本轮领取未完成，未确认的帖子可在有效期内重试；请稍后刷新。'
}

function queueAttachments(sourceId: string, messageId: string): void {
  const key = JSON.stringify([sourceId, messageId])
  if (attachmentJobs.has(key)) return
  // Bodies are already durable. Keep only a bounded queue of attachment identities.
  if (attachmentJobs.size < 100) attachmentJobs.set(key, { sourceId, messageId })
  else showTransientStatus('正文已保存，其余附件可从来源内容按需获取。', 6_000)
}

function startAttachmentLocalization(): void {
  if (
    localizing ||
    disposed ||
    vaultService.getStatus().locked ||
    !attachmentJobs.size ||
    (isWebDiscordInboxAvailable() && isWebDiscordInboxPaused())
  )
    return
  localizing = true
  void (async () => {
    while (
      attachmentJobs.size &&
      !disposed &&
      !vaultService.getStatus().locked &&
      !(isWebDiscordInboxAvailable() && isWebDiscordInboxPaused())
    ) {
      const [key, job] = attachmentJobs.entries().next().value!
      const signal = webDiscordInboxSignal()
      try {
        if (signal)
          await communitySourceService.localizeSavedMessageAttachments(
            job.sourceId,
            job.messageId,
            signal,
          )
        else
          await communitySourceService.localizeSavedMessageAttachments(job.sourceId, job.messageId)
      } catch {
        if (!disposed) showTransientStatus('正文已保存，附件缓存未完成；可从来源内容重试。', 6_000)
      }
      if (signal?.aborted) break
      attachmentJobs.delete(key)
    }
  })().finally(() => {
    localizing = false
  })
}

function presentManualBinding(saved: ResourceCommunitySourceView): void {
  if (!pending.value || pending.value.source.id === saved.source.id) {
    pending.value = saved
    selectedResourceId.value = ''
  } else if (!deferredBindings.some((view) => view.source.id === saved.source.id)) {
    deferredBindings.push(saved)
  }
}

async function saveDelivery(
  envelope: HandoffEnvelope,
  acknowledge: (state: DeliveryState) => Promise<void>,
  automatic: boolean,
  workerUrl: string,
  onLocalSaved?: () => void,
): Promise<{ state: DeliveryState; sourceKeyHash: string }> {
  assertVaultUnlocked()
  const receiptId = envelope.delivery
    ? receiptKey(workerUrl, envelope.delivery.libraryId, envelope.delivery.id)
    : JSON.stringify([workerUrl, envelope.capture.canonicalUrl, envelope.capture.messageId])
  const retained =
    automatic && envelope.delivery?.libraryId
      ? await communitySourceService.getSavedNativeDiscordDelivery(
          envelope.capture,
          { ...envelope.delivery, libraryId: envelope.delivery.libraryId },
          workerUrl,
        )
      : undefined
  const saved =
    retained?.view ??
    (await communitySourceService.saveDiscordCapture(envelope.capture, {
      capturedAt: envelope.delivery?.capturedAt,
      deferAttachmentLocalization: true,
    }))
  if (!saved.messages.some((message) => message.messageId === envelope.capture.messageId))
    throw new Error('本机正文读回校验未完成，云端内容仍保留；请稍后重试。')
  onLocalSaved?.()
  if (!retained && automatic && envelope.delivery?.libraryId) {
    const automationSettings = await discordInboxAutomationSettingsService
      .load()
      .catch(() => ({ ...DEFAULT_DISCORD_INBOX_AUTOMATION_SETTINGS }))
    const starterContent =
      saved.messages.find((message) => message.kind === 'starter')?.content ?? ''
    try {
      const binding = await autoBindPostToRecentCard(
        communitySourceService,
        resourceService,
        saved.source,
        starterContent,
        automationSettings,
      )
      if (!binding)
        await markPostForNextPng(
          communitySourceService,
          saved.source.id,
          automationSettings.bindNextPng,
        )
    } catch {
      // A best-effort auto-match must never prevent an already verified post from being acknowledged.
    }
  }
  const existingBindings = await communitySourceService.getSourceUsage(saved.source.id)
  const state: DeliveryState = existingBindings.length ? 'saved' : 'waiting_binding'
  // Native still owns this unfinished media phase and its ACK. Foreground consumes the body only.
  if (retained?.attachmentState === 'pending') {
    if (!(await readNativeDiscordInboxState()))
      showTransientStatus(
        '正文和已有绑定已保存；附件收件已停止，请显式开启收件模式继续原断点。',
        6_000,
      )
    return { state, sourceKeyHash: saved.source.sourceKeyHash }
  }
  if (!retained?.notificationPosted && automatic && envelope.delivery?.libraryId)
    await notifyNativeDiscordInboxResult({
      kind: 'post',
      id: envelope.delivery.id,
      workerUrl,
      libraryId: envelope.delivery.libraryId,
      name: saved.source.title || envelope.capture.title || 'Discord 帖子',
      state,
      ...(retained ? { messageKey: retained.messageKey } : {}),
    })
  window.dispatchEvent(
    new CustomEvent('srl:community-sources-changed', {
      detail: { origin: 'discord-intake' },
    }),
  )
  let acknowledgementError: unknown
  if (envelope.delivery) {
    assertVaultUnlocked()
    try {
      await acknowledge(state)
    } catch {
      acknowledgementError = new Error(
        '正文已保存在本机，云端确认未完成；稍后刷新会重试确认，不会丢失已保存内容。',
      )
    }
  }
  const presentationKey = JSON.stringify([saved.source.id, receiptId])
  if (!automatic && !presentedManualReceipts.has(presentationKey)) {
    presentedManualReceipts.add(presentationKey)
    if (presentedManualReceipts.size > 100)
      presentedManualReceipts.delete(presentedManualReceipts.values().next().value!)
    if (existingBindings.length) showTransientStatus('已更新已有 Discord 来源')
    else {
      presentManualBinding(saved)
      try {
        await loadResources()
      } catch {
        errorMessage.value = '正文已保存，资源候选未能读取；可以稍后从待整理来源继续关联。'
      }
    }
  }
  if (acknowledgementError) throw acknowledgementError
  if (retained?.attachmentState !== 'complete')
    queueAttachments(saved.source.id, envelope.capture.messageId)
  return { state, sourceKeyHash: saved.source.sourceKeyHash }
}

const latestMessage = computed(() => pending.value?.messages.at(-1))
const title = computed(
  () => pending.value?.source.title || latestMessage.value?.authorName || 'Discord 来源',
)

async function loadResources(): Promise<void> {
  resources.value = (await resourceService.listResourceListSummaries()).filter(
    (resource) => !isResourceGalleryImage(resource),
  )
}

function receive(request: DiscordHandoffRequest): Promise<void> {
  const key = `${request.workerUrl}|${request.token}`
  if (queuedRequests.has(key)) return queuedRequests.get(key)!
  const operation = enqueueReceive(() => receiveManual(request, key))
  queuedRequests.set(key, operation)
  void operation.then(
    () => queuedRequests.delete(key),
    () => queuedRequests.delete(key),
  )
  return operation
}

async function receiveManual(request: DiscordHandoffRequest, key: string): Promise<void> {
  await initializeVaultOnce()
  if (vaultService.getStatus().locked) {
    deferredRequests.set(key, request)
    errorMessage.value = '先解锁本地保险库，再领取这条 Discord 来源；临时链接尚未消费。'
    return
  }
  deferredRequests.delete(key)
  receiving.value = true
  errorMessage.value = ''
  try {
    const envelope = await receiveDiscordHandoff(request)
    const delivery = envelope.delivery
    const { state, sourceKeyHash } = await saveDelivery(
      envelope,
      (state) =>
        delivery ? acknowledgeDiscordHandoff(request, delivery, state) : Promise.resolve(),
      false,
      request.workerUrl,
    )
    if (delivery && !delivery.libraryId) {
      if (sourceKeyHash && /^[a-f0-9]{64}$/iu.test(sourceKeyHash)) {
        const receiptId = JSON.stringify([
          sourceKeyHash,
          receiptKey(request.workerUrl, delivery.libraryId, delivery.id),
        ])
        if (state === 'saved') manualWaitingDeliveries.delete(receiptId)
        else if (manualWaitingDeliveries.has(receiptId) || manualWaitingDeliveries.size < 100)
          manualWaitingDeliveries.set(receiptId, { sourceKeyHash, request, delivery })
        else
          showTransientStatus(
            '正文已保存，临时链接状态回补达到本轮上限；关联后可再次打开链接确认。',
            6_000,
          )
      }
    }
    clearDiscordHandoffFromLocation()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '无法领取 Discord 来源'
    if (!errorMessage.value.includes('已经领取')) deferredRequests.set(key, request)
    clearDiscordHandoffFromLocation()
  } finally {
    receiving.value = false
  }
}

function receiveInbox(background?: WebInboxCycle, manual = false): Promise<void> {
  inboxRequested = true
  if (inboxRun) return inboxRun
  inboxRun = enqueueReceive(async () => {
    inboxRequested = false
    await receiveInboxBatch(background, manual)
  })
  const finish = () => {
    inboxRun = undefined
    if (inboxRequested && !disposed && !(isWebDiscordInboxAvailable() && isWebDiscordInboxPaused()))
      void receiveInbox()
  }
  void inboxRun.then(finish, () => {
    publishInboxProgress({
      status: 'error',
      busy: false,
      received: 0,
      waitingBinding: 0,
      error: '未能初始化本机资源库，云端内容尚未领取。',
    })
    finish()
  })
  return inboxRun
}

async function receiveInboxBatch(background?: WebInboxCycle, manual = false): Promise<void> {
  const halted = () =>
    Boolean(
      (background && !background.current()) ||
      (!manual && isWebDiscordInboxAvailable() && isWebDiscordInboxPaused()),
    )
  if (halted()) return
  await initializeVaultOnce()
  const settings = loadDiscordSourceConnectionSettings()
  let received = 0
  let waitingBinding = 0
  const progress = (status: 'receiving' | 'ready' | 'locked' | 'error', error?: string) =>
    publishInboxProgress({ status, busy: status === 'receiving', received, waitingBinding, error })
  if (vaultService.getStatus().locked) {
    if (settings.inboxLibraryId || manualWaitingDeliveries.size)
      progress('locked', '先解锁本地保险库，再领取云端帖子。云端内容仍保留。')
    return
  }
  try {
    await reconcileManualWaitingDeliveries()
  } catch {
    errorMessage.value = '来源已保存在本机，临时链接状态确认未完成；解锁或稍后刷新会再次确认。'
  }
  if (!settings.inboxLibraryId || !settings.inboxSecret) return
  progress('receiving')
  const seen = new Set<string>()
  let cursor: string | undefined
  let failedPosts = 0
  let lastFailure = ''
  let currentPost: { id: string; name: string } | undefined
  try {
    for (let batch = 0; batch < 5 && !disposed; batch++) {
      if (halted()) return
      assertInboxConnection(settings)
      const listing = await (background
        ? listDiscordInboxJobs(cursor, background.signal)
        : listDiscordInboxJobs(cursor))
      if (halted()) return
      const { jobs, hasMore } = listing
      const candidates = jobs.filter((job) => !seen.has(job.id)).slice(0, 20)
      if (!candidates.length) break
      for (const job of candidates) {
        if (disposed) break
        if (halted()) return
        if (vaultService.getStatus().locked) {
          progress('locked', '保险库已锁定，剩余帖子仍保留在云端，解锁后继续。')
          return
        }
        assertInboxConnection(settings)
        seen.add(job.id)
        currentPost = { id: job.id, name: job.title || 'Discord 帖子' }
        try {
          const envelope = await (background
            ? receiveDiscordInboxJob(job.id, background.signal)
            : receiveDiscordInboxJob(job.id))
          if (halted()) return
          assertInboxConnection(settings)
          if (envelope.delivery?.libraryId !== settings.inboxLibraryId)
            throw new Error('这条帖子属于其它收件库，未写入当前资源库。请检查默认目标。')
          const { state } = await saveDelivery(
            envelope,
            (value) => {
              assertInboxConnection(settings)
              return acknowledgeDiscordInboxJob(job.id, value, {
                workerUrl: settings.workerBaseUrl,
                libraryId: settings.inboxLibraryId!,
              })
            },
            true,
            settings.workerBaseUrl,
            () => {
              currentPost = undefined
            },
          )
          currentPost = undefined
          received++
          if (state === 'waiting_binding') waitingBinding++
          progress('receiving')
        } catch (error) {
          if (halted()) return
          if (disposed) return
          assertInboxConnection(settings)
          if (vaultService.getStatus().locked) throw error
          failedPosts++
          lastFailure = inboxError(error)
          if (currentPost)
            await notifyNativeDiscordInboxResult({
              kind: 'post',
              ...currentPost,
              workerUrl: settings.workerBaseUrl,
              libraryId: settings.inboxLibraryId!,
              state: 'failed',
            })
          currentPost = undefined
          progress('error', lastFailure)
        }
      }
      if (!hasMore) break
      const last = jobs.at(-1)!
      const next = `${last.createdAt}:${last.id}`
      if (next === cursor) break
      cursor = next
    }
    if (halted()) return
    await reconcileBoundSources(settings)
    if (failedPosts)
      progress(
        'error',
        `${failedPosts} 条帖子未完成，云端内容仍保留；其它帖子已继续处理。${lastFailure}`,
      )
    else progress(vaultService.getStatus().locked ? 'locked' : 'ready')
  } catch (error) {
    if (halted()) return
    if (currentPost)
      await notifyNativeDiscordInboxResult({
        kind: 'post',
        ...currentPost,
        workerUrl: settings.workerBaseUrl,
        libraryId: settings.inboxLibraryId!,
        state: 'failed',
      })
    if (vaultService.getStatus().locked)
      progress('locked', '保险库已锁定，剩余帖子仍保留在云端，解锁后继续。')
    else progress('error', inboxError(error))
  }
}

async function reconcileManualWaitingDeliveries(): Promise<void> {
  for (const [key, receipt] of manualWaitingDeliveries) {
    if (disposed || vaultService.getStatus().locked) return
    const bindings = await communitySourceService.getSourceUsageByKeyHash(receipt.sourceKeyHash)
    if (!bindings.length) continue
    if (disposed) return
    assertVaultUnlocked()
    await acknowledgeDiscordHandoff(receipt.request, receipt.delivery, 'saved')
    manualWaitingDeliveries.delete(key)
  }
}

function handleVisibilityChange(): void {
  if (
    document.visibilityState === 'visible' &&
    !(isWebDiscordInboxAvailable() && isWebDiscordInboxPaused())
  )
    handleInboxRequested()
}

function handleInboxRequested(event?: Event): void {
  if (
    isWebDiscordInboxAvailable() &&
    isWebDiscordInboxPaused() &&
    event?.type !== 'srl:receive-discord-inbox'
  )
    return
  for (const request of deferredRequests.values()) void receive(request)
  void receiveInbox(undefined, event?.type === 'srl:receive-discord-inbox')
}

async function reconcileBoundSources(
  settings: ReturnType<typeof loadDiscordSourceConnectionSettings>,
): Promise<void> {
  const expected = { workerUrl: settings.workerBaseUrl, libraryId: settings.inboxLibraryId! }
  const reconciled = new Set<string>()
  const scope = receiptKey(settings.workerBaseUrl, settings.inboxLibraryId, 'waiting-sources')
  if (waitingSourceScope !== scope) {
    waitingSourceScope = scope
    waitingSourceCursor = undefined
  }
  for (const key of boundSourceKeys) {
    if (disposed || vaultService.getStatus().locked || reconciled.size >= 100) return
    assertInboxConnection(settings)
    if ((await communitySourceService.getSourceUsageByKeyHash(key)).length) {
      assertInboxConnection(settings)
      await acknowledgeDiscordInboxSourceBound(key, expected)
    }
    reconciled.add(key)
    boundSourceKeys.delete(key)
  }
  if (reconciled.size >= 100) return
  for (let page = 0; page < 5 && !disposed; page++) {
    if (vaultService.getStatus().locked) return
    assertInboxConnection(settings)
    const listing = await listDiscordInboxWaitingSources(waitingSourceCursor)
    assertInboxConnection(settings)
    let lastKey = waitingSourceCursor
    for (const key of listing.sourceKeyHashes) {
      if (vaultService.getStatus().locked) return
      if (reconciled.size >= 100) {
        waitingSourceCursor = lastKey
        return
      }
      lastKey = key
      if (reconciled.has(key)) continue
      if ((await communitySourceService.getSourceUsageByKeyHash(key)).length) {
        assertInboxConnection(settings)
        await acknowledgeDiscordInboxSourceBound(key, expected)
      }
      reconciled.add(key)
    }
    waitingSourceCursor = listing.nextCursor ?? undefined
    if (!listing.nextCursor) break
  }
}

function handleSourceBound(event: Event): void {
  const key = event instanceof CustomEvent ? event.detail?.sourceKeyHash : undefined
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/iu.test(key)) return
  if (boundSourceKeys.size < 100) boundSourceKeys.add(key.toLowerCase())
  handleInboxRequested()
}

function handleSourcesChanged(event: Event): void {
  if (event instanceof CustomEvent && event.detail?.origin === 'discord-intake') return
  void receiveInbox()
}

function openPasteDialog(): void {
  errorMessage.value = ''
  handoffLink.value = ''
  pasteDialogOpen.value = true
}

function submitPastedHandoff(): void {
  const request = parseDiscordHandoffLink(handoffLink.value)
  if (!request) {
    errorMessage.value = '链接无效，请粘贴 Discord Bridge 提供的 HTTPS 领取链接。'
    return
  }
  pasteDialogOpen.value = false
  void receive(request)
}

function handleVaultUnlocked(): void {
  for (const request of deferredRequests.values()) void receive(request)
  void receiveInbox()
}

function handleNativeDeepLink(event: Event): void {
  if (!(event instanceof CustomEvent)) return
  const link = event.detail as NativeDeepLink | undefined
  if (!link || link.kind !== 'discordSource') return
  void receive({ workerUrl: link.workerUrl, token: link.token })
}

async function bindExisting(): Promise<void> {
  const view = pending.value
  const resource = resources.value.find((item) => item.id === selectedResourceId.value)
  if (!view || !resource || busy.value) return
  busy.value = true
  errorMessage.value = ''
  try {
    await communitySourceService.bindSource(resource.id, view.source.id)
    showTransientStatus(`已关联到“${resource.name}”`)
    pending.value = deferredBindings.shift()
    selectedResourceId.value = ''
    window.dispatchEvent(new Event('srl:community-sources-changed'))
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '来源关联失败'
  } finally {
    busy.value = false
  }
}

async function createLinkResource(): Promise<void> {
  const view = pending.value
  if (!view || busy.value) return
  busy.value = true
  errorMessage.value = ''
  try {
    const [result] = await resourceService.importLinks([view.source.canonicalUrl])
    if (!result || result.status === 'failed' || result.status === 'versionCandidate') {
      throw new Error(result?.status === 'failed' ? result.message : '创建链接资源失败')
    }
    await communitySourceService.bindSource(result.resource.id, view.source.id)
    await loadResources()
    showTransientStatus(
      result.status === 'duplicate'
        ? `发现已有同链接资源，已关联到“${result.resource.name}”`
        : `已创建“${result.resource.name}”并关联来源`,
    )
    pending.value = deferredBindings.shift()
    window.dispatchEvent(new Event('srl:community-sources-changed'))
    window.dispatchEvent(new Event('srl:library-changed'))
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '创建链接资源失败'
  } finally {
    busy.value = false
  }
}

function keepForLater(): void {
  if (!pending.value) return
  showTransientStatus('已保存在本机，稍后可从来源高级设置继续整理。')
  pending.value = deferredBindings.shift()
  selectedResourceId.value = ''
}

onMounted(() => {
  removeNotificationNavigation = installWebInboxNotificationNavigation()
  if (isWebDiscordInboxAvailable())
    unregisterWebInbox = registerWebInboxParticipant('posts', async (cycle) => {
      await inboxRun
      if (!cycle.current()) return
      startAttachmentLocalization()
      await receiveInbox(cycle)
    })
  window.addEventListener('srl:native-deep-link', handleNativeDeepLink)
  window.addEventListener('srl:vault-unlocked', handleVaultUnlocked)
  window.addEventListener('srl:open-discord-handoff-paste', openPasteDialog)
  window.addEventListener('srl:receive-discord-inbox', handleInboxRequested)
  window.addEventListener('online', handleInboxRequested)
  window.addEventListener('srl:community-sources-changed', handleSourcesChanged)
  window.addEventListener('srl:community-source-bound', handleSourceBound)
  document.addEventListener('visibilitychange', handleVisibilityChange)
  const fromLocation = readDiscordHandoffFromLocation()
  if (fromLocation) void receive(fromLocation)
  if (!(isWebDiscordInboxAvailable() && isWebDiscordInboxPaused())) void receiveInbox()
})

onBeforeUnmount(() => {
  disposed = true
  unregisterWebInbox?.()
  removeNotificationNavigation?.()
  manualWaitingDeliveries.clear()
  window.removeEventListener('srl:native-deep-link', handleNativeDeepLink)
  window.removeEventListener('srl:vault-unlocked', handleVaultUnlocked)
  window.removeEventListener('srl:open-discord-handoff-paste', openPasteDialog)
  window.removeEventListener('srl:receive-discord-inbox', handleInboxRequested)
  window.removeEventListener('online', handleInboxRequested)
  window.removeEventListener('srl:community-sources-changed', handleSourcesChanged)
  window.removeEventListener('srl:community-source-bound', handleSourceBound)
  document.removeEventListener('visibilitychange', handleVisibilityChange)
})
</script>

<template>
  <Teleport to="body">
    <div v-if="receiving" class="discord-intake-status" role="status">正在领取 Discord 来源…</div>

    <div
      v-if="pasteDialogOpen"
      class="discord-intake-overlay mobile-dialog-viewport"
      role="presentation"
      @click.self="pasteDialogOpen = false"
    >
      <section
        class="discord-intake discord-intake--paste"
        role="dialog"
        aria-modal="true"
        aria-labelledby="discord-intake-paste-title"
      >
        <header>
          <div>
            <small>DISCORD SOURCE</small>
            <h2 id="discord-intake-paste-title">领取 Discord 分享</h2>
          </div>
          <button type="button" aria-label="关闭" @click="pasteDialogOpen = false">×</button>
        </header>
        <p class="discord-intake__paste-help">
          在 Discord Bridge 页面复制临时链接后，回到这个 PWA 粘贴。领取内容会保存到当前 PWA
          的资源库。
        </p>
        <label class="discord-intake__paste-field">
          <span>临时领取链接</span>
          <textarea
            v-model="handoffLink"
            rows="3"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            placeholder="粘贴 https://…/open/… 链接"
          />
        </label>
        <p
          v-if="errorMessage"
          class="discord-intake__message discord-intake__message--error"
          role="alert"
        >
          {{ errorMessage }}
        </p>
        <footer>
          <button type="button" @click="pasteDialogOpen = false">取消</button>
          <button
            class="button button--primary"
            type="button"
            :disabled="!handoffLink.trim()"
            @click="submitPastedHandoff"
          >
            领取并保存到本机
          </button>
        </footer>
      </section>
    </div>

    <div
      v-if="pending"
      class="discord-intake-overlay mobile-dialog-viewport"
      role="presentation"
      @click.self="keepForLater"
    >
      <section
        class="discord-intake"
        role="dialog"
        aria-modal="true"
        aria-labelledby="discord-intake-title"
      >
        <header>
          <div>
            <small>DISCORD SOURCE</small>
            <h2 id="discord-intake-title">保存 Discord 来源</h2>
          </div>
          <button type="button" aria-label="稍后整理" @click="keepForLater">×</button>
        </header>

        <section class="discord-intake__source">
          <strong>{{ title }}</strong>
          <span v-if="latestMessage">{{ latestMessage.authorName }}</span>
          <p>
            {{
              latestMessage?.content
                ? latestMessage.content.replace(/\s+/gu, ' ').slice(0, 220) +
                  (latestMessage.content.length > 220 ? '…' : '')
                : '这条消息主要包含 Embed 或附件。完整数据已经保存到本机。'
            }}
          </p>
          <small>完整正文已经先保存到本机；这里仅显示预览。</small>
        </section>

        <section class="discord-intake__bind">
          <ResourcePicker
            title="关联已有资源"
            :resources="resources"
            :model-value="selectedResourceId ? [selectedResourceId] : []"
            :multiple="false"
            :show-actions="false"
            :disabled="busy"
            @update:model-value="selectedResourceId = $event[0] ?? ''"
          />

          <button
            class="button button--primary"
            type="button"
            :disabled="busy || !selectedResourceId"
            @click="bindExisting"
          >
            {{ busy ? '正在保存…' : '关联所选资源' }}
          </button>
        </section>

        <footer>
          <button type="button" :disabled="busy" @click="createLinkResource">创建链接资源</button>
          <button type="button" :disabled="busy" @click="keepForLater">稍后整理</button>
        </footer>

        <p
          v-if="errorMessage"
          class="discord-intake__message discord-intake__message--error"
          role="alert"
        >
          {{ errorMessage }}
        </p>
      </section>
    </div>

    <p v-if="statusMessage" class="discord-intake-toast" role="status">{{ statusMessage }}</p>
    <p
      v-if="errorMessage && !pending"
      class="discord-intake-toast discord-intake-toast--error"
      role="alert"
    >
      {{ errorMessage }}
    </p>
  </Teleport>
</template>

<style scoped src="../styles/DiscordSourceHandoffIntake.css"></style>
