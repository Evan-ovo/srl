import { acquireWebBackgroundAudio } from '../services/WebBackgroundKeepAlive'

export type TaskStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export interface TaskTransferProgress {
  transferredBytes: number
  totalBytes?: number
  bytesPerSecond?: number
  remainingSeconds?: number
  lastProgressAt: number
}

export interface TaskItemProgress {
  completed: number
  total: number
}

export interface TaskRecord {
  operationId: string
  name: string
  phase: string
  progress?: number
  itemProgress?: TaskItemProgress
  transfer?: TaskTransferProgress
  cancelable: boolean
  retryable?: boolean
  actionLabel?: string
  actionRequired?: boolean
  /** Indicates an automatically scheduled/background-origin task, not whether Android may keep it running when unfocused. */
  background: boolean
  status: TaskStatus
  error?: string
  startedAt: number
  updatedAt: number
}

export interface StartTaskOptions {
  operationId?: string
  name: string
  phase?: string
  cancelable?: boolean
  background?: boolean
  /** Temporary web media retention for actual work, never for restored terminal cards. */
  keepAlive?: boolean
  /** A returned Promise acknowledges the owner's safe stop; synchronous return values stay ignored. */
  cancel?: () => unknown
  retry?: () => Promise<unknown>
  action?: { label: string; run: () => void | Promise<void>; required?: boolean }
}

export const COMPLETED_TASK_RETENTION_MS = 5_000

export function isAutoClearingTask(task: TaskRecord): boolean {
  return (
    (task.status === 'completed' || task.status === 'cancelled') &&
    task.phase !== '下载完成，可继续导入' &&
    (!task.actionLabel || task.actionRequired === false)
  )
}

export class TaskCenter {
  private readonly tasks = new Map<string, TaskRecord>()
  private readonly actions = new Map<
    string,
    Pick<StartTaskOptions, 'cancel' | 'retry' | 'action'>
  >()
  private readonly opening = new Set<string>()
  private readonly listeners = new Set<() => void>()
  private readonly transferSamples = new Map<string, Array<{ at: number; bytes: number }>>()
  private readonly transferPublishedAt = new Map<string, number>()
  private readonly retrying = new Set<string>()
  private readonly completedCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly keepAliveReleases = new Map<string, () => void>()

  start(options: StartTaskOptions): string {
    const operationId = options.operationId ?? crypto.randomUUID()
    const now = Date.now()
    const release = options.keepAlive ? acquireWebBackgroundAudio() : undefined
    this.keepAliveReleases.get(operationId)?.()
    this.keepAliveReleases.delete(operationId)
    if (release) this.keepAliveReleases.set(operationId, release)
    this.clearTransfer(operationId)
    this.clearCompletedCleanup(operationId)
    this.tasks.set(operationId, {
      operationId,
      name: options.name,
      phase: options.phase ?? '准备中',
      cancelable: options.cancelable === true,
      retryable: typeof options.retry === 'function',
      actionLabel: options.action?.label,
      actionRequired: options.action ? options.action.required !== false : false,
      background: options.background === true,
      status: 'running',
      startedAt: now,
      updatedAt: now,
    })
    this.actions.set(operationId, {
      cancel: options.cancel,
      retry: options.retry,
      action: options.action,
    })
    this.publish()
    return operationId
  }

  update(
    operationId: string,
    changes: Partial<Pick<TaskRecord, 'phase' | 'progress' | 'itemProgress' | 'cancelable'>>,
  ): void {
    const task = this.tasks.get(operationId)
    if (!task || task.status !== 'running') return
    if (changes.phase !== undefined && changes.phase !== task.phase) {
      this.clearTransfer(operationId)
      task.transfer = undefined
      task.progress = undefined
    }
    Object.assign(task, changes, { updatedAt: Date.now() })
    if (task.progress !== undefined) {
      task.progress = Number.isFinite(task.progress)
        ? Math.min(1, Math.max(0, task.progress))
        : undefined
    }
    this.publish()
  }

  /** 只接收实际已完成的字节数；传输完成不代表校验、归档或保存已完成。 */
  updateTransfer(
    operationId: string,
    progress: { transferredBytes: number; totalBytes?: number },
  ): void {
    const task = this.tasks.get(operationId)
    if (!task || task.status !== 'running' || !Number.isFinite(progress.transferredBytes)) return
    const now = Date.now()
    const bytes = Math.max(0, progress.transferredBytes)
    const total =
      progress.totalBytes !== undefined && Number.isFinite(progress.totalBytes)
        ? Math.max(bytes, progress.totalBytes, 0)
        : undefined
    let samples = this.transferSamples.get(operationId)
    if (!samples || bytes < (task.transfer?.transferredBytes ?? 0)) {
      samples = [{ at: now, bytes }]
      this.transferSamples.set(operationId, samples)
    }
    const firstUpdate = task.transfer === undefined
    const advanced = firstUpdate || bytes > task.transfer!.transferredBytes
    const lastProgressAt = advanced ? now : task.transfer!.lastProgressAt
    const lastSample = samples[samples.length - 1]!
    if (now - lastSample.at >= 250) samples.push({ at: now, bytes })
    while (samples.length > 1 && samples[1]!.at < now - 5_000) samples.shift()
    const first = samples[0]!
    const elapsed = now - first.at
    const speed =
      elapsed >= 500 ? Math.max(0, ((bytes - first.bytes) * 1_000) / elapsed) : undefined
    task.transfer = {
      transferredBytes: bytes,
      totalBytes: total,
      bytesPerSecond: speed,
      remainingSeconds:
        total !== undefined && speed ? Math.max(0, (total - bytes) / speed) : undefined,
      lastProgressAt,
    }
    task.progress = total && total > 0 ? Math.min(1, bytes / total) : undefined
    task.updatedAt = now
    // 字节回调可以很密集，但不按每个输入块刷新整个 Vue 任务列表。
    if (
      firstUpdate ||
      now - (this.transferPublishedAt.get(operationId) ?? 0) >= 250 ||
      (advanced && total !== undefined && bytes >= total)
    ) {
      this.transferPublishedAt.set(operationId, now)
      this.publish()
    }
  }

  complete(operationId: string): void {
    this.settle(operationId, 'completed')
  }

  fail(operationId: string, error: unknown): void {
    this.settle(
      operationId,
      'failed',
      error instanceof Error ? error.message : String(error || '任务失败'),
    )
  }

  cancelled(operationId: string): void {
    this.settle(operationId, 'cancelled')
  }

  cancel(operationId: string): boolean {
    const task = this.tasks.get(operationId)
    if (!task || task.status !== 'running' || !task.cancelable) return false
    const stopped = this.actions.get(operationId)?.cancel?.()
    if (
      typeof stopped === 'object' &&
      stopped !== null &&
      'then' in stopped &&
      typeof stopped.then === 'function'
    ) {
      this.update(operationId, { cancelable: false })
      void Promise.resolve(stopped as PromiseLike<unknown>).then(
        () => {
          if (this.tasks.get(operationId) === task) this.cancelled(operationId)
        },
        (error) => {
          if (this.tasks.get(operationId) === task) this.fail(operationId, error)
        },
      )
    } else this.cancelled(operationId)
    return true
  }

  setAction(operationId: string, action?: StartTaskOptions['action']): void {
    const task = this.tasks.get(operationId),
      handlers = this.actions.get(operationId)
    if (!task || !handlers) return
    handlers.action = action
    task.actionLabel = action?.label
    task.actionRequired = action ? action.required !== false : false
    this.scheduleCompletedCleanup(task)
    this.publish()
  }

  async retry(operationId: string): Promise<boolean> {
    const task = this.tasks.get(operationId)
    const retry = this.actions.get(operationId)?.retry
    if (!task || task.status !== 'failed' || !retry || this.retrying.has(operationId)) return false
    this.retrying.add(operationId)
    task.retryable = false
    this.publish()
    try {
      await retry()
      return true
    } catch (error) {
      if (this.tasks.get(operationId) === task && task.status === 'failed') {
        task.error = error instanceof Error ? error.message : String(error || '重试失败')
      }
      return false
    } finally {
      this.retrying.delete(operationId)
      if (this.tasks.get(operationId) === task) task.retryable = true
      this.publish()
    }
  }

  list(): TaskRecord[] {
    return [...this.tasks.values()].sort((left, right) => right.updatedAt - left.updatedAt)
  }

  async open(operationId: string): Promise<boolean> {
    const action = this.actions.get(operationId)?.action
    if (!this.tasks.has(operationId) || !action || this.opening.has(operationId)) return false
    this.opening.add(operationId)
    try {
      await action.run()
      return true
    } finally {
      this.opening.delete(operationId)
    }
  }

  active(): TaskRecord[] {
    return this.list().filter((task) => task.status === 'running')
  }

  dismiss(operationId: string): void {
    if (this.tasks.get(operationId)?.status === 'running') return
    this.tasks.delete(operationId)
    this.actions.delete(operationId)
    this.clearTransfer(operationId)
    this.clearCompletedCleanup(operationId)
    this.publish()
  }

  dismissCompleted(): void {
    const completed = [...this.tasks.values()]
      .filter(isAutoClearingTask)
      .map((task) => task.operationId)
    if (!completed.length) return
    for (const operationId of completed) {
      this.tasks.delete(operationId)
      this.actions.delete(operationId)
      this.clearTransfer(operationId)
      this.clearCompletedCleanup(operationId)
    }
    this.publish()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private settle(operationId: string, status: TaskStatus, error?: string): void {
    const task = this.tasks.get(operationId)
    // 取消后迟到的 resolve/reject 不能重新写成成功或失败。
    if (!task || task.status !== 'running') return
    Object.assign(task, {
      status,
      error,
      cancelable: false,
      updatedAt: Date.now(),
      progress: status === 'completed' ? 1 : task.progress,
    })
    this.keepAliveReleases.get(operationId)?.()
    this.keepAliveReleases.delete(operationId)
    this.clearTransfer(operationId)
    this.scheduleCompletedCleanup(task)
    this.publish()
  }

  private scheduleCompletedCleanup(task: TaskRecord): void {
    this.clearCompletedCleanup(task.operationId)
    if (!isAutoClearingTask(task)) return
    const updatedAt = task.updatedAt
    this.completedCleanupTimers.set(
      task.operationId,
      setTimeout(() => {
        const current = this.tasks.get(task.operationId)
        if (current === task && isAutoClearingTask(current) && current.updatedAt === updatedAt)
          this.dismiss(task.operationId)
      }, COMPLETED_TASK_RETENTION_MS),
    )
  }

  private clearCompletedCleanup(operationId: string): void {
    const timer = this.completedCleanupTimers.get(operationId)
    if (timer !== undefined) clearTimeout(timer)
    this.completedCleanupTimers.delete(operationId)
  }

  private clearTransfer(operationId: string): void {
    this.transferSamples.delete(operationId)
    this.transferPublishedAt.delete(operationId)
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }
}

export const taskCenter = new TaskCenter()
