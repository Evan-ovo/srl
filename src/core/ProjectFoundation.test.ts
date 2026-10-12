/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest'

import { DirtyStateRegistry } from './DirtyStateRegistry'
import { MutationGuard } from './MutationGuard'
import { NoticeCenter } from './NoticeCenter'
import { ReferenceIndex } from './ReferenceIndex'
import { TaskCenter } from './TaskCenter'

describe('project foundation', () => {
  it('deduplicates an in-flight mutation and shares its operationId/result', async () => {
    const guard = new MutationGuard()
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const mutation = vi.fn(async ({ operationId }: { operationId: string }) => {
      await gate
      return operationId
    })
    const first = guard.run('import:file-a', mutation)
    const second = guard.run('import:file-a', mutation)
    release()
    expect(await first).toBe(await second)
    expect(mutation).toHaveBeenCalledOnce()
  })

  it('keeps dirty state until save/discard actually resolves it', async () => {
    const registry = new DirtyStateRegistry()
    let dirty = true
    registry.register({
      featureId: 'persona',
      label: '人设',
      isDirty: () => dirty,
      save: async () => {
        dirty = false
      },
      discard: () => {
        dirty = false
      },
    })
    expect(registry.hasDirtyState()).toBe(true)
    await expect(registry.resolve('persona', 'save')).resolves.toBe(true)
    expect(registry.hasDirtyState()).toBe(false)
  })

  it('persists error/data-risk notices and exposes task cancel/retry metadata', async () => {
    vi.useFakeTimers()
    const notices = new NoticeCenter()
    const errorId = notices.push({ type: 'error', message: '失败' })
    const infoId = notices.push({ type: 'info', message: '完成', durationMs: 10 })
    await vi.advanceTimersByTimeAsync(20)
    expect(notices.list().map((notice) => notice.id)).toEqual([errorId])
    expect(notices.list().some((notice) => notice.id === infoId)).toBe(false)
    vi.useRealTimers()

    const tasks = new TaskCenter()
    const cancel = vi.fn()
    const id = tasks.start({ name: '恢复', cancelable: true, cancel })
    tasks.update(id, { phase: '校验', progress: 2 })
    expect(tasks.list()[0]?.progress).toBe(1)
    expect(tasks.cancel(id)).toBe(true)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('reports strong/weak/ui references before deletion', () => {
    const index = new ReferenceIndex()
    index.replaceOwner('workshop-project', 'l1', [
      {
        ownerType: 'workshop-project',
        ownerId: 'l1',
        targetType: 'resource',
        targetId: 'r1',
        label: '工作台资源引用',
        strength: 'weak',
      },
    ])
    expect(index.impacts('resource', 'r1')).toMatchObject([{ ownerId: 'l1', strength: 'weak' }])
    index.removeOwner('workshop-project', 'l1')
    expect(index.impacts('resource', 'r1')).toEqual([])
  })
})
