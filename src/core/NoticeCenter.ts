export type NoticeType = 'success' | 'info' | 'warning' | 'error' | 'data-risk'

export interface NoticeAction {
  label: string
  run: () => void | Promise<void>
}

export interface NoticeRecord {
  id: string
  type: NoticeType
  message: string
  details?: string
  createdAt: number
  persistent: boolean
  completed?: boolean
  actions: NoticeAction[]
}

export function isCompletedNotice(notice: NoticeRecord): boolean {
  if (notice.type === 'error' || notice.type === 'data-risk') return false
  return notice.completed === true || (notice.type === 'success' && notice.actions.length === 0)
}

export const COMPLETED_NOTICE_RETENTION_MS = 5_000

export class NoticeCenter {
  private readonly notices = new Map<string, NoticeRecord>()
  private readonly listeners = new Set<() => void>()
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>()

  push(
    input: Omit<NoticeRecord, 'id' | 'createdAt' | 'persistent' | 'actions'> & {
      id?: string
      persistent?: boolean
      actions?: NoticeAction[]
      durationMs?: number
    },
  ): string {
    const id = input.id ?? crypto.randomUUID()
    const createdAt = Date.now()
    this.clearExpiry(id)
    const notice: NoticeRecord = {
      id,
      type: input.type,
      message: input.message,
      details: input.details,
      createdAt,
      persistent: (input.persistent ?? input.type === 'error') || input.type === 'data-risk',
      completed: input.completed,
      actions: input.actions ?? [],
    }
    const completed = isCompletedNotice(notice)
    if (completed) notice.persistent = false
    this.notices.set(id, notice)
    if (!notice.persistent)
      this.expiryTimers.set(
        id,
        setTimeout(
          () => {
            if (this.notices.get(id) === notice) this.dismiss(id)
          },
          input.durationMs ?? (completed ? COMPLETED_NOTICE_RETENTION_MS : 4000),
        ),
      )
    this.publish()
    return id
  }

  dismiss(id: string): void {
    this.clearExpiry(id)
    if (this.notices.delete(id)) this.publish()
  }

  dismissCompleted(): void {
    const completed = [...this.notices.values()]
      .filter(isCompletedNotice)
      .map((notice) => notice.id)
    if (!completed.length) return
    for (const id of completed) {
      this.clearExpiry(id)
      this.notices.delete(id)
    }
    this.publish()
  }

  list(): NoticeRecord[] {
    return [...this.notices.values()].sort((left, right) => right.createdAt - left.createdAt)
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }

  private clearExpiry(id: string): void {
    const timer = this.expiryTimers.get(id)
    if (timer !== undefined) clearTimeout(timer)
    this.expiryTimers.delete(id)
  }
}

export const noticeCenter = new NoticeCenter()
