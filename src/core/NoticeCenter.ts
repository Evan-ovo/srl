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
  return notice.completed === true || (notice.type === 'success' && notice.actions.length === 0)
}

export class NoticeCenter {
  private readonly notices = new Map<string, NoticeRecord>()
  private readonly listeners = new Set<() => void>()

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
    const persistent = (input.persistent ?? input.type === 'error') || input.type === 'data-risk'
    this.notices.set(id, {
      id,
      type: input.type,
      message: input.message,
      details: input.details,
      createdAt,
      persistent,
      completed: input.completed,
      actions: input.actions ?? [],
    })
    this.publish()
    if (!persistent)
      window.setTimeout(() => {
        if (this.notices.get(id)?.createdAt === createdAt) this.dismiss(id)
      }, input.durationMs ?? 4000)
    return id
  }

  dismiss(id: string): void {
    if (this.notices.delete(id)) this.publish()
  }

  dismissCompleted(): void {
    const completed = [...this.notices.values()]
      .filter(isCompletedNotice)
      .map((notice) => notice.id)
    if (!completed.length) return
    for (const id of completed) this.notices.delete(id)
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
}

export const noticeCenter = new NoticeCenter()
