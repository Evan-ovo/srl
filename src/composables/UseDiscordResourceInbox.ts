import { Capacitor } from '@capacitor/core'
import { onBeforeUnmount, onMounted, watch, type Ref } from 'vue'
import {
  communitySourceService,
  discordInboxAutomationSettingsService,
  initializeVaultOnce,
  resourceService,
} from '../core/LibraryContainer'
import {
  autoBindIncomingCardBatch,
  beginIncomingCardBindingBatch,
  flushDeferredPostBindings,
} from '../services/DiscordInboxAutoBinding'
import { noticeCenter } from '../core/NoticeCenter'
import { taskCenter } from '../core/TaskCenter'
import { requestNativeNotifications } from '../core/NativeSecurity'
import {
  DiscordInboxTaskExpiredError,
  inboxConnection,
  type DiscordInboxTarget,
} from '../services/DiscordHandoffService'
import {
  acknowledgeDiscordResource,
  downloadWebDiscordResource,
  listDiscordResourceJobs,
  readDiscordResourceJob,
  type DiscordResourceJob,
} from '../services/DiscordResourceInboxService'
import {
  isNativeDiscordInboxRunning,
  notifyNativeDiscordInboxResult,
} from '../services/NativeDiscordInboxService'
import {
  cloudWebResourceBatch,
  allowDiscordAttachmentRetry,
  cleanupCompletedCloudDiscordResource,
  readCloudDiscordResource,
  stageCloudDiscordResource,
  type SharedFileBatch,
} from '../utils/ShareTargetIntake'
import type { VaultStatus } from '../types/Vault'
import { RESOURCE_TYPE, type ResourceListSummary } from '../types/Resource'
import {
  isWebDiscordInboxRunning,
  isWebDiscordInboxPaused,
  pauseWebDiscordInbox,
  webDiscordInboxSignal,
  registerWebInboxParticipant,
  type WebInboxCycle,
} from '../services/WebDiscordInboxSession'

interface WebResourceCycle {
  target: DiscordInboxTarget
  automatic: boolean
  jobs: DiscordResourceJob[]
  resourceIds: Set<string>
  hasMore: boolean
  finishBindingBatch: (discard?: boolean) => void
  background?: boolean
}

interface ActiveResource {
  job: Pick<DiscordResourceJob, 'id' | 'name'>
  automatic: boolean
  target: DiscordInboxTarget
  taskId: string
  controller: AbortController
  delivered: boolean
  imported: boolean
  failed?: boolean
  waitingVersion?: boolean
  waitingAcknowledgement?: Promise<void>
  cancelRequested?: boolean
  confirm?: () => Promise<void>
  confirming?: Promise<void>
  staging?: SharedFileBatch
  webCycle?: WebResourceCycle
  nativeOutcome?: Awaited<ReturnType<typeof readCloudDiscordResource>>['nativeImportOutcome']
  nativeAckSettled?: boolean
  processing?: Promise<void>
  finishProcessing?: () => void
}

/** Transport coordination only: every file and decision goes through the existing share importer. */
export function useDiscordResourceInbox(
  vault: Ref<VaultStatus>,
  receive: (batch: SharedFileBatch) => void,
  refreshNativeResources?: () => Promise<void>,
) {
  const active = new Map<string, ActiveResource>()
  const nativeReads = new Map<string, ReturnType<typeof readCloudDiscordResource>>()
  const native = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
  let disposed = false
  let running = false
  let requested = false
  let requestedAutomatic = true
  let nativeTimer: number | undefined
  let readingNative = false
  let notificationPermissionChecked = false
  let webCycle: WebResourceCycle | undefined
  const pendingWebCycles: WebResourceCycle[] = []
  let unregisterWebInbox: (() => void) | undefined
  const webBusy = () =>
    [...active.values()].some((entry) => !entry.imported && !entry.failed && !entry.waitingVersion)
  const visible = () =>
    document.visibilityState !== 'hidden' ||
    (native && isNativeDiscordInboxRunning()) ||
    (!native && isWebDiscordInboxRunning())

  function changed(): void {
    window.dispatchEvent(new Event('srl:discord-resources-updated'))
  }
  function targetCurrent(target: DiscordInboxTarget): boolean {
    try {
      const current = inboxConnection()
      return current.workerUrl === target.workerUrl && current.libraryId === target.libraryId
    } catch {
      return false
    }
  }
  function readNativeResource(id: string, target: DiscordInboxTarget) {
    const key = JSON.stringify([target.workerUrl, target.libraryId, id])
    const pending = nativeReads.get(key)
    if (pending) return pending
    const operation = readCloudDiscordResource({ id, ...target }).finally(() => {
      nativeReads.delete(key)
    })
    nativeReads.set(key, operation)
    return operation
  }
  async function state(
    entry: ActiveResource,
    value: Parameters<typeof acknowledgeDiscordResource>[1],
    error?: string,
  ) {
    await acknowledgeDiscordResource(entry.job.id, value, entry.target, error)
    changed()
  }
  async function notifyResult(
    entry: ActiveResource,
    value: 'imported' | 'duplicate' | 'waiting_version' | 'cancelled' | 'failed',
  ): Promise<void> {
    const notification = notifyNativeDiscordInboxResult({
      kind: 'resource',
      id: entry.job.id,
      ...entry.target,
      name: entry.job.name,
      state: value,
    })
    if (native) await notification
    else void notification.catch(() => undefined)
  }
  async function failure(entry: ActiveResource, reason: unknown): Promise<void> {
    if (!native && !entry.imported && isWebDiscordInboxPaused() && entry.staging) {
      // Preserve the original file and existing hash/alias checkpoints; only explicit resume redelivers it.
      entry.delivered = false
      taskCenter.cancelled(entry.taskId)
      changed()
      return
    }
    const message = reason instanceof Error ? reason.message : String(reason || '资源下载失败')
    if (!taskCenter.list().some((task) => task.operationId === entry.taskId))
      startEntryTask(entry, entry.imported ? '已导入，云端确认未完成' : '导入未完成')
    if (entry.imported) {
      taskCenter.fail(entry.taskId, '资源已导入，云端确认或暂存清理未完成，可重试确认。')
      if (native) active.delete(entry.job.id)
      releaseWebDownload(entry)
      changed()
      return
    }
    taskCenter.fail(entry.taskId, message)
    if (!native) {
      finishWebFailure(entry, message)
      return
    }
    await notifyResult(entry, 'failed')
    active.delete(entry.job.id)
    const confirmation = (entry.waitingAcknowledgement ?? Promise.resolve())
      .then(() => state(entry, 'failed', message))
      .then(
        () => true,
        () => false,
      )
    void confirmation
    noticeCenter.push({ id: entry.taskId, type: 'error', message: `${entry.job.name}：${message}` })
    changed()
  }

  function finishWebFailure(entry: ActiveResource, message: string): void {
    if (entry.failed) return
    entry.failed = true
    releaseWebDownload(entry, false)
    // Keep the local terminal receipt until ACK succeeds so a stale cloud listing cannot
    // download the failed file again. Neither ACK nor OS notification owns the import slot.
    const confirmation = state(entry, 'failed', message).then(
      () => {
        if (active.get(entry.job.id) === entry) active.delete(entry.job.id)
      },
      () => {
        if (!disposed && active.get(entry.job.id) === entry)
          taskCenter.update(entry.taskId, { phase: '本机处理已结束，云端状态确认未完成' })
      },
    )
    entry.confirming = confirmation
    void confirmation.finally(() => {
      if (entry.confirming === confirmation) entry.confirming = undefined
    })
    void notifyResult(entry, 'failed').catch(() => undefined)
    noticeCenter.push({ id: entry.taskId, type: 'error', message: `${entry.job.name}：${message}` })
    changed()
    void request(entry.automatic)
  }

  async function finishNativeImport(
    entry: ActiveResource,
    outcome: NonNullable<
      Awaited<ReturnType<typeof readCloudDiscordResource>>['nativeImportOutcome']
    >,
  ): Promise<boolean> {
    if (!['imported', 'duplicate_file', 'duplicate_card'].includes(outcome.state ?? ''))
      return false
    entry.nativeOutcome = outcome
    if (entry.imported) {
      // A later binding receipt releases the original staging without replaying the import.
      if (!outcome.automaticBindingPending && entry.nativeAckSettled && !entry.confirming)
        await entry.confirm?.()
      return true
    }
    entry.imported = true
    taskCenter.update(entry.taskId, { phase: '后台已导入资源库' })
    // Android writes directly to SQLite, bypassing the foreground import owner's refresh.
    // Publish committed local data before a slow/offline cloud acknowledgement.
    if (refreshNativeResources) {
      try {
        await refreshNativeResources()
      } catch {
        noticeCenter.push({
          id: 'discord-native-library-refresh',
          type: 'warning',
          message: '后台导入已完成，但资源列表刷新失败；请重新打开资源库查看。',
        })
      }
    }
    taskCenter.complete(entry.taskId)
    taskCenter.dismiss(entry.taskId)
    try {
      entry.confirm = async () => {
        if (entry.confirming) return entry.confirming
        const confirmation = (async () => {
          let expired = false
          try {
            if (!entry.nativeAckSettled && entry.nativeOutcome?.cloudAckPending !== false)
              await state(entry, 'imported')
            entry.nativeAckSettled = true
          } catch (error) {
            // A verified native commit outlives its cloud task. Expiry ends this receipt,
            // while authentication, network and unrelated HTTP failures remain retryable.
            if (!(error instanceof DiscordInboxTaskExpiredError) || error.kind !== 'resource')
              throw error
            expired = true
            entry.nativeAckSettled = true
          }
          if (!expired && !outcome.notificationPosted) {
            const resultState = outcome.state === 'imported' ? 'imported' : 'duplicate'
            await notifyResult(entry, resultState)
            outcome.notificationPosted = true
          }
          // Completion events can update this receipt after the background binding batch settles.
          const bindingPending = entry.nativeOutcome?.automaticBindingPending
          if (!bindingPending) await cleanupCompletedCloudDiscordResource(entry.job.id)
          taskCenter.update(entry.taskId, { phase: '后台已导入资源库' })
          taskCenter.complete(entry.taskId)
          taskCenter.dismiss(entry.taskId)
          if (!bindingPending) active.delete(entry.job.id)
          noticeCenter.dismiss(entry.taskId)
          changed()
        })()
        entry.confirming = confirmation
        try {
          await confirmation
        } finally {
          entry.confirming = undefined
        }
      }
      await entry.confirm()
    } catch (error) {
      startEntryTask(entry, '已导入，云端确认未完成')
      taskCenter.fail(entry.taskId, '资源已在后台导入，云端确认失败；打开收件箱后可重试确认。')
      noticeCenter.push({
        id: entry.taskId,
        type: 'warning',
        message: error instanceof Error ? error.message : '后台导入成功，但云端确认失败。',
      })
      changed()
    }
    return true
  }

  function deliver(entry: ActiveResource, original: SharedFileBatch): void {
    if (entry.delivered) return
    if (disposed || vault.value.locked || !targetCurrent(entry.target)) {
      releaseNativeClaim(original)
      return
    }
    entry.delivered = true
    entry.staging = original
    entry.confirm = () => confirmImport(entry, original)
    taskCenter.update(entry.taskId, { phase: '已下载，等待解析导入', cancelable: false })
    let waiting = 0
    let failed = false
    let skipped = false
    let cancelled = false
    let importedItems = 0
    let duplicateItems = 0
    const batch: SharedFileBatch = {
      ...original,
      taskOperationId: entry.taskId,
      automaticCloud: entry.automatic,
      deferAutomaticBinding: Boolean(entry.webCycle),
      canProcess:
        !native && entry.webCycle?.background
          ? () => isWebDiscordInboxRunning() && targetCurrent(entry.target) && !vault.value.locked
          : undefined,
      route: 'resource',
      onProcessingStarted: () => {
        entry.processing = new Promise<void>((resolve) => {
          entry.finishProcessing = resolve
        })
      },
      onProcessingSettled: () => {
        entry.finishProcessing?.()
        entry.processing = undefined
        entry.finishProcessing = undefined
        if (!native && waiting) {
          entry.waitingVersion = true
          void request(entry.automatic)
        }
      },
      // Explicit cloud command chooses resources; a retained file does not open the route picker.
      recoveryId: original.recoveryId || entry.taskId,
      onCancel: async () => {
        await entry.waitingAcknowledgement
        await state(entry, 'cancelled', '用户取消了中断的资源解析。')
        await original.acknowledge()
        cancelled = true
        taskCenter.cancelled(entry.taskId)
        await notifyResult(entry, 'cancelled')
        active.delete(entry.job.id)
        releaseWebDownload(entry)
        changed()
      },
      onItemComplete: async (result) => {
        if (
          entry.webCycle &&
          (result.status === 'imported' || result.status === 'duplicate') &&
          result.resource.type === RESOURCE_TYPE.CHARACTER_CARD
        )
          entry.webCycle.resourceIds.add(result.resource.versionGroupId || result.resource.id)
        if (result.status === 'failed') failed = true
        if (result.status === 'imported') importedItems += 1
        if (result.status === 'duplicate') duplicateItems += 1
        if (result.status === 'versionCandidate') {
          waiting += 1
          taskCenter.update(entry.taskId, {
            phase: native ? '等待确认历史版本' : '等待确认历史版本，处理后继续领取',
          })
          await notifyResult(entry, 'waiting_version')
          const confirmation = (
            native
              ? state(entry, 'waiting_version')
              : (entry.waitingAcknowledgement ?? Promise.resolve()).then(() =>
                  state(entry, 'waiting_version'),
                )
          ).catch(() => {
            noticeCenter.push({
              id: entry.taskId,
              type: 'warning',
              message: '文件已下载并等待版本选择，云端状态尚未确认；请完成本机选择。',
            })
          })
          if (!native) entry.waitingAcknowledgement = confirmation
        }
      },
      onVersionResolved: async (hash, resourceId) => {
        waiting = Math.max(0, waiting - 1)
        if (!hash) skipped = true
        else importedItems += 1
        if (hash && resourceId) entry.webCycle?.resourceIds.add(resourceId)
      },
      onFailure: (message) => failure(entry, message),
      acknowledge: async () => {
        if (cancelled) return
        if (waiting) return
        if (failed || skipped) {
          const message =
            importedItems + duplicateItems > 0
              ? skipped
                ? '部分资源已保存；已跳过其余版本选择。'
                : '部分资源已保存；其余资源解析或导入失败，可重试。'
              : skipped
                ? '已跳过版本导入，文件未新增。'
                : '资源解析或导入失败。'
          if (!native && !skipped) {
            taskCenter.fail(entry.taskId, message)
            finishWebFailure(entry, message)
            return
          }
          if (skipped) {
            taskCenter.cancelled(entry.taskId)
            await notifyResult(entry, 'cancelled')
          } else {
            taskCenter.fail(entry.taskId, '资源未全部导入，请重试。')
            await notifyResult(entry, 'failed')
          }
          const confirmation = (entry.waitingAcknowledgement ?? Promise.resolve())
            .then(() => state(entry, skipped ? 'cancelled' : 'failed', message))
            .then(() => true)
            .catch(() => {
              noticeCenter.push({
                type: 'warning',
                message: '本机处理已结束，云端状态尚未确认，暂存文件仍保留。',
              })
              return false
            })
          const confirmed = native ? false : await confirmation
          active.delete(entry.job.id)
          releaseWebDownload(entry, confirmed)
          changed()
          return
        }
        // This callback is invoked only after the importer commits all items/decisions.
        entry.imported = true
        await notifyResult(
          entry,
          duplicateItems > 0 && importedItems === 0 ? 'duplicate' : 'imported',
        )
        if (native) {
          // Release the shared importer now. Keep this entry and staging until cloud ACK succeeds.
          void entry.confirm!().catch(() => undefined)
        } else await entry.confirm!()
      },
    }
    receive(batch)
  }
  function confirmImport(entry: ActiveResource, original: SharedFileBatch): Promise<void> {
    if (entry.confirming) return entry.confirming
    if (taskCenter.list().find((task) => task.operationId === entry.taskId)?.status === 'failed')
      startEntryTask(entry, '已导入，正在确认云端')
    const operation = (async () => {
      try {
        taskCenter.update(entry.taskId, { phase: '已导入，正在确认云端' })
        await entry.waitingAcknowledgement
        await state(entry, 'imported')
        await original.acknowledge()
        taskCenter.update(entry.taskId, { phase: '已导入资源库' })
        taskCenter.complete(entry.taskId)
        if (native && document.visibilityState !== 'hidden') taskCenter.dismiss(entry.taskId)
        active.delete(entry.job.id)
        releaseWebDownload(entry)
        noticeCenter.dismiss(entry.taskId)
        changed()
      } catch (error) {
        const message = '资源已导入，云端确认或暂存清理未完成，可重试确认。'
        if (
          !taskCenter
            .list()
            .some((task) => task.operationId === entry.taskId && task.status === 'running')
        )
          startEntryTask(entry, '已导入，云端确认未完成')
        taskCenter.fail(entry.taskId, message)
        if (!native) releaseWebDownload(entry)
        changed()
        if (!native) throw error
        throw new Error(message, { cause: error })
      } finally {
        entry.confirming = undefined
      }
    })()
    entry.confirming = operation
    return operation
  }
  function releaseNativeClaim(batch: SharedFileBatch): void {
    // Undo only this session's delivery claim; retain every staged file and checkpoint.
    for (const token of batch.nativeShareTokens ?? []) allowDiscordAttachmentRetry(token)
  }
  function releaseWebDownload(entry: ActiveResource, resume = true): void {
    if (native) return
    // The remote source remains available for failed/skipped imports; retain hash checkpoints,
    // but release this completed attachment before admitting another Web download.
    if (entry.staging) entry.staging.files.length = 0
    entry.staging = undefined
    if (resume) void request(entry.automatic)
  }

  async function settleWebCycle(cycle: WebResourceCycle): Promise<void> {
    if (!targetCurrent(cycle.target)) return
    try {
      const settings = await discordInboxAutomationSettingsService.load()
      const bindings = await flushDeferredPostBindings(
        communitySourceService,
        resourceService,
        settings,
      )
      const resources: ResourceListSummary[] = []
      // Reload only the final lightweight records: later containers/versions may change the
      // current name, author or PNG representation without changing the logical resource ID.
      for (const id of cycle.automatic && (settings.bindForeground || cycle.background)
        ? cycle.resourceIds
        : []) {
        if (disposed || vault.value.locked || !targetCurrent(cycle.target)) return
        const summary = await resourceService.getResourceListSummary(id)
        if (summary) resources.push(summary)
      }
      if (disposed || vault.value.locked || !targetCurrent(cycle.target)) return
      if (resources.length)
        bindings.push(
          ...(await autoBindIncomingCardBatch(communitySourceService, resources, settings)),
        )
      for (const binding of bindings)
        window.dispatchEvent(
          new CustomEvent('srl:community-sources-changed', {
            detail: { origin: 'discord-auto-binding', sourceId: binding.sourceId },
          }),
        )
    } catch {
      // Binding remains best effort; a completed local import must not be rolled back.
    }
  }

  async function settleWebCycles(): Promise<void> {
    if (webCycle || webBusy()) return
    // A waiting decision releases transport, but remains part of its original logical batch.
    // Release every ready cohort's scan barrier together before flushing deferred post scans.
    if ([...active.values()].some((entry) => entry.webCycle && !entry.imported && !entry.failed))
      return
    const cycles = pendingWebCycles.splice(0)
    for (const cycle of cycles) cycle.finishBindingBatch()
    for (const cycle of cycles) await settleWebCycle(cycle)
  }

  async function readNative(): Promise<void> {
    if (readingNative || disposed || vault.value.locked) return
    readingNative = true
    try {
      for (const entry of active.values()) {
        if (entry.delivered || entry.imported || !targetCurrent(entry.target)) continue
        try {
          const result = await readNativeResource(entry.job.id, entry.target)
          // A completion event can deliver this entry while its progress read is in flight.
          if (entry.delivered) continue
          if (await finishNativeImport(entry, result.nativeImportOutcome ?? {})) continue
          if (result.cancelled) {
            await state(entry, 'cancelled', '下载已取消，附件暂存仍保留，可重试。')
            taskCenter.cancelled(entry.taskId)
            active.delete(entry.job.id)
            continue
          }
          if (result.error) throw new Error(result.error)
          if (result.active === false && !result.batch?.files.length)
            throw new Error('下载任务已中断，暂存文件仍保留；请点“重试”继续下载。')
          taskCenter.updateTransfer(entry.taskId, {
            transferredBytes: result.transferredBytes,
            totalBytes: result.totalBytes && result.totalBytes > 0 ? result.totalBytes : undefined,
          })
          if (result.batch?.files.length) {
            deliver(entry, result.batch)
          }
        } catch (error) {
          await failure(entry, error)
        }
      }
    } finally {
      readingNative = false
      scheduleNative()
    }
  }
  function scheduleNative(): void {
    if (nativeTimer !== undefined) clearTimeout(nativeTimer)
    nativeTimer = undefined
    // Only active native transfers need progress snapshots; no idle cloud polling.
    if (
      native &&
      !disposed &&
      document.visibilityState !== 'hidden' &&
      [...active.values()].some(
        (entry) => !entry.delivered && !entry.imported && targetCurrent(entry.target),
      )
    )
      nativeTimer = window.setTimeout(() => void readNative(), 1_000)
  }

  function createEntry(
    job: ActiveResource['job'],
    target: DiscordInboxTarget,
    automatic: boolean,
  ): ActiveResource | undefined {
    if (active.has(job.id) || active.size >= 100) return
    const controller = new AbortController()
    const taskId = `discord-resource-${job.id}`
    const entry: ActiveResource = {
      job,
      automatic,
      target,
      taskId,
      controller,
      delivered: false,
      imported: false,
      webCycle: native ? undefined : webCycle,
    }
    active.set(job.id, entry)
    startEntryTask(entry, native ? '正在读取本机收件状态' : '准备下载')
    return entry
  }
  function startEntryTask(entry: ActiveResource, phase: string): void {
    const { job, target, taskId, controller } = entry
    taskCenter.start({
      operationId: taskId,
      name: `云端资源：${job.name}`,
      phase,
      background: true,
      action: {
        label: '查看收件箱',
        run: () => {
          window.dispatchEvent(
            new CustomEvent('srl:native-deep-link', { detail: { kind: 'inbox' } }),
          )
        },
      },
      cancelable: !native,
      cancel: () => controller.abort(new DOMException('用户已取消下载', 'AbortError')),
      retry: async () => {
        if (entry.imported && entry.confirm) {
          await entry.confirm()
          return
        }
        if (entry.failed) await entry.confirming
        if (entry.staging) releaseNativeClaim(entry.staging)
        await acknowledgeDiscordResource(job.id, 'queued', target)
        if (entry.failed && active.get(job.id) === entry) active.delete(job.id)
        await request(entry.automatic)
      },
    })
  }

  async function accept(
    job: DiscordResourceJob,
    target: DiscordInboxTarget,
    automatic: boolean,
  ): Promise<void> {
    const entry = createEntry(job, target, automatic)
    if (!entry) return
    const { taskId, controller } = entry
    try {
      if (!native) taskCenter.update(taskId, { phase: '正在下载' })
      if (native) {
        if (!notificationPermissionChecked) {
          notificationPermissionChecked = true
          const granted = await requestNativeNotifications().catch(() => false)
          if (!granted)
            noticeCenter.push({
              type: 'info',
              message: '系统通知未开启，下载状态仍可在资源下载和任务中心查看。',
            })
        }
        // A native receive session may have finished this file while the WebView was absent.
        // Use its target-checked staging before an expiring CDN link is needed again.
        const retained = await readNativeResource(job.id, target).catch(() => undefined)
        if (
          retained?.nativeImportOutcome &&
          (await finishNativeImport(entry, retained.nativeImportOutcome))
        )
          return
        if (retained?.batch?.files.length) {
          deliver(entry, retained.batch)
          return
        }
        if (retained?.active) {
          // The original WorkManager attempt owns its partial bytes and parsing checkpoint.
          scheduleNative()
          return
        }
        if (entry.delivered) return
        taskCenter.update(taskId, { phase: '正在下载' })
        await state(entry, 'downloading')
        const fresh = await readDiscordResourceJob(job.id, target)
        await stageCloudDiscordResource({
          id: job.id,
          libraryId: target.libraryId,
          workerUrl: target.workerUrl,
          url: fresh.url,
          automaticAutoBinding: entry.automatic,
        })
        scheduleNative()
      } else {
        await state(entry, 'downloading')
        const file = await downloadWebDiscordResource(
          job,
          target,
          controller.signal,
          (bytes, total) =>
            taskCenter.updateTransfer(taskId, { transferredBytes: bytes, totalBytes: total }),
        )
        controller.signal.throwIfAborted()
        if (
          !targetCurrent(target) ||
          vault.value.locked ||
          disposed ||
          (automatic && isWebDiscordInboxPaused())
        )
          throw new DOMException('下载领取已暂停', 'AbortError')
        await state(entry, 'importing')
        entry.staging = cloudWebResourceBatch(file, taskId, entry.automatic)
        deliver(entry, entry.staging)
      }
    } catch (error) {
      if (
        controller.signal.aborted ||
        (error instanceof DOMException && error.name === 'AbortError')
      ) {
        active.delete(job.id)
        taskCenter.cancelled(taskId)
        if (!entry.cancelRequested) {
          const paused =
            document.visibilityState === 'hidden' ||
            vault.value.locked ||
            disposed ||
            isWebDiscordInboxPaused()
          await state(entry, paused ? 'queued' : 'cancelled').catch(() => undefined)
          // Pausing a download does not finish that member of the logical batch.
          if (paused && entry.webCycle === webCycle) entry.webCycle?.jobs.unshift(job)
        }
      } else await failure(entry, error)
    }
  }

  async function receiveNativeCompletion(id: string): Promise<void> {
    if (disposed || vault.value.locked || active.get(id)?.delivered) return
    try {
      await initializeVaultOnce()
      if (disposed || vault.value.locked) return
      const connection = inboxConnection()
      const target = { workerUrl: connection.workerUrl, libraryId: connection.libraryId }
      // Native staging checks the stored worker/library and payload size before returning a file.
      // A completed file must not wait for the separate network queue/progress acknowledgement.
      const result = await readNativeResource(id, target)
      if (
        result.nativeImportOutcome?.state === 'imported' ||
        result.nativeImportOutcome?.state === 'duplicate_file' ||
        result.nativeImportOutcome?.state === 'duplicate_card'
      ) {
        const existing = active.get(id)
        const entry =
          existing ??
          createEntry({ id, name: result.nativeImportOutcome.name || '云端角色卡' }, target, true)
        if (entry) await finishNativeImport(entry, result.nativeImportOutcome)
        return
      }
      if (!result.batch?.files.length) return
      if (disposed || vault.value.locked || !targetCurrent(target)) {
        releaseNativeClaim(result.batch)
        return
      }
      const existing = active.get(id)
      const entry = existing ?? createEntry({ id, name: result.batch.files[0]!.name }, target, true)
      if (entry && targetCurrent(entry.target)) deliver(entry, result.batch)
      else releaseNativeClaim(result.batch)
    } catch {
      // Missing/foreign staging stays with its original target; normal queue recovery remains available.
    }
  }

  async function snapshotWebCycle(
    target: DiscordInboxTarget,
    automatic: boolean,
  ): Promise<WebResourceCycle | undefined> {
    const jobs: DiscordResourceJob[] = []
    const seen = new Set<string>()
    let cursor: string | undefined
    let hasMore = false
    // Read only queue metadata before downloading. A later-page failure leaves the whole
    // snapshot unclaimed rather than presenting a partial cohort as a unique match.
    for (let page = 0; page < 5; page += 1) {
      if (disposed || vault.value.locked || !visible() || !targetCurrent(target)) return
      const result = await listDiscordResourceJobs(
        target,
        cursor,
        isWebDiscordInboxRunning() ? webDiscordInboxSignal() : undefined,
      )
      for (const job of result.jobs)
        if (!seen.has(job.id) && !active.has(job.id)) {
          seen.add(job.id)
          jobs.push(job)
        }
      hasMore = result.hasMore && result.jobs.length > 0
      if (!hasMore) break
      const last = result.jobs.at(-1)!
      const next = `${last.createdAt}:${last.id}`
      if (cursor === next) {
        hasMore = false // An older Worker may ignore pagination; do not repeat its first page.
        break
      }
      cursor = next
    }
    if (disposed || vault.value.locked || !targetCurrent(target)) return
    if (!jobs.length && pendingWebCycles.length) return
    return {
      target,
      automatic,
      jobs,
      resourceIds: new Set(),
      hasMore,
      finishBindingBatch: beginIncomingCardBindingBatch(),
    }
  }

  async function request(automatic = true): Promise<void> {
    requested = true
    requestedAutomatic = automatic
    if (running || disposed) return
    running = true
    try {
      await initializeVaultOnce()
      do {
        requested = false
        const automaticRequest = requestedAutomatic
        if (
          vault.value.locked ||
          !visible() ||
          (!native && automaticRequest && isWebDiscordInboxPaused())
        )
          break
        let target: DiscordInboxTarget
        try {
          const connection = inboxConnection()
          target = { workerUrl: connection.workerUrl, libraryId: connection.libraryId }
        } catch {
          break
        }
        for (const entry of active.values()) {
          if (targetCurrent(entry.target)) continue
          entry.controller.abort()
          active.delete(entry.job.id)
          taskCenter.fail(
            entry.taskId,
            '当前配对已改变，未向新目标导入；原生已领取的文件仍在原目标暂存。',
          )
        }
        if (!native) {
          if (webCycle && !targetCurrent(webCycle.target)) {
            webCycle.finishBindingBatch(true)
            webCycle = undefined
          }
          for (let index = pendingWebCycles.length - 1; index >= 0; index -= 1) {
            if (targetCurrent(pendingWebCycles[index]!.target)) continue
            pendingWebCycles[index]!.finishBindingBatch(true)
            pendingWebCycles.splice(index, 1)
          }
          // A single attachment owns all importer callbacks, including every item inside a ZIP.
          // Keep at most one downloaded Web attachment until its import/decisions finish.
          for (const entry of active.values())
            if (!entry.delivered && entry.staging) deliver(entry, entry.staging)
          if (webBusy()) break
          await settleWebCycles()
          webCycle ??= await snapshotWebCycle(target, automaticRequest)
          if (!webCycle) break
          if (isWebDiscordInboxRunning()) webCycle.background = true
          const cycle = webCycle
          while (cycle.jobs.length && !disposed) {
            if (
              vault.value.locked ||
              !visible() ||
              !targetCurrent(cycle.target) ||
              (automaticRequest && isWebDiscordInboxPaused())
            )
              break
            await accept(cycle.jobs.shift()!, cycle.target, cycle.automatic)
            if (webBusy()) break
          }
          if (
            webBusy() ||
            cycle.jobs.length ||
            vault.value.locked ||
            !visible() ||
            (automaticRequest && isWebDiscordInboxPaused())
          )
            break
          pendingWebCycles.push(cycle)
          webCycle = undefined
          await settleWebCycles()
          // Preserve the existing 100-job bound per cohort, with later arrivals in another cohort.
          if (cycle.hasMore) {
            requested = true
            requestedAutomatic = cycle.automatic
          }
          continue
        }
        const handled = new Set<string>()
        let cursor: string | undefined
        for (let page = 0; page < 5 && !disposed; page += 1) {
          const result = await listDiscordResourceJobs(target, cursor)
          const jobs = result.jobs.filter((job) => !active.has(job.id) && !handled.has(job.id))
          for (const job of jobs) {
            if (vault.value.locked || !visible() || !targetCurrent(target)) break
            handled.add(job.id)
            await accept(job, target, automaticRequest)
          }
          if (!result.hasMore || !result.jobs.length) break
          const last = result.jobs.at(-1)!
          const next = `${last.createdAt}:${last.id}`
          if (cursor === next) break // An older Worker may ignore pagination; do not loop its first page.
          cursor = next
        }
        await readNative()
      } while (requested && !disposed)
    } catch (error) {
      // Older Workers remain usable for post saving; the panel explains the missing resource update.
      window.dispatchEvent(
        new CustomEvent('srl:discord-resources-error', {
          detail: error instanceof Error ? error.message : '资源下载队列读取失败',
        }),
      )
    } finally {
      running = false
      changed()
    }
  }

  function visibility(): void {
    if (document.visibilityState !== 'hidden') {
      if (native)
        for (const task of taskCenter.list())
          if (task.operationId.startsWith('discord-resource-') && task.status === 'completed')
            taskCenter.dismiss(task.operationId)
      void request()
      scheduleNative()
    } else {
      if (!native && !isWebDiscordInboxRunning())
        for (const entry of active.values()) if (!entry.delivered) entry.controller.abort()
      scheduleNative()
    }
  }
  function wake(event?: Event): void {
    if (native && event?.type === 'srl:native-active') {
      visibility()
      return
    }
    // A claimed native download may finish while the WebView is still alive in the background.
    // Deliver that retained file through the existing background import owner without polling new jobs.
    const detail = (event as CustomEvent<{ cloud?: boolean; token?: string }> | undefined)?.detail
    const id =
      detail?.cloud === true && /^discord-url-[a-f0-9-]{36}$/u.test(detail.token || '')
        ? detail.token!.slice('discord-url-'.length)
        : undefined
    if (native && id && event?.type === 'srl:native-share-download-completed')
      void receiveNativeCompletion(id)
    else if (native && event?.type.startsWith('srl:native-share-download-')) void readNative()
    void request(event?.type !== 'srl:receive-discord-resources')
  }
  function cancelRequested(event: Event): void {
    const id = (event as CustomEvent<{ id?: string }>).detail?.id
    if (!id || !/^[a-f\d-]{36}$/u.test(id)) return
    const entry = active.get(id)
    if (!entry || entry.delivered) return
    entry.cancelRequested = true
    entry.controller.abort(new DOMException('用户取消了云端资源下载', 'AbortError'))
    active.delete(id)
    taskCenter.cancelled(entry.taskId)
    changed()
  }
  const events = [
    'srl:receive-discord-resources',
    'srl:receive-discord-inbox',
    'srl:native-active',
    'srl:native-share-download-completed',
    'srl:native-share-download-failed',
    'online',
  ]
  async function webPoll(cycle: WebInboxCycle): Promise<void> {
    if (cycle.current()) await request()
  }
  function webStateChanged(): void {
    if (native || isWebDiscordInboxRunning()) return
    for (const entry of active.values()) {
      if (!entry.automatic || entry.imported) continue
      if (!entry.delivered) entry.controller.abort(new DOMException('收件已暂停', 'AbortError'))
      else taskCenter.cancel(entry.taskId)
    }
  }
  watch(
    () => vault.value.locked,
    (locked) => {
      if (!locked) void request()
      else if (!native) {
        if (isWebDiscordInboxRunning()) pauseWebDiscordInbox('保险库已锁定，请解锁后手动继续收件。')
        for (const entry of active.values()) if (!entry.delivered) entry.controller.abort()
      }
    },
  )
  onMounted(() => {
    if (!native)
      unregisterWebInbox = registerWebInboxParticipant('resources', webPoll, async () => {
        await Promise.all([...active.values()].map((entry) => entry.processing))
      })
    window.addEventListener('srl:web-inbox-state', webStateChanged)
    for (const event of events) window.addEventListener(event, wake)
    window.addEventListener('srl:discord-resource-cancelled', cancelRequested)
    document.addEventListener('visibilitychange', visibility)
    void request()
  })
  onBeforeUnmount(() => {
    disposed = true
    unregisterWebInbox?.()
    window.removeEventListener('srl:web-inbox-state', webStateChanged)
    webCycle?.finishBindingBatch(true)
    webCycle = undefined
    for (const cycle of pendingWebCycles) cycle.finishBindingBatch(true)
    pendingWebCycles.length = 0
    if (nativeTimer !== undefined) clearTimeout(nativeTimer)
    for (const entry of active.values()) entry.controller.abort()
    for (const event of events) window.removeEventListener(event, wake)
    window.removeEventListener('srl:discord-resource-cancelled', cancelRequested)
    document.removeEventListener('visibilitychange', visibility)
  })
  return { request }
}
