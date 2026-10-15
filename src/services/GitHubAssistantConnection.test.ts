import { describe, expect, it, vi } from 'vitest'
import { GitHubAssistantConnection } from './GitHubAssistantConnection'

describe('GitHub local connection lifetime', () => {
  it('does not open a second executor when the native capability is unavailable', async () => {
    const plugin = { status: vi.fn(), authorize: vi.fn(), execute: vi.fn(), cancel: vi.fn() }
    const connection = new GitHubAssistantConnection(plugin, () => false)
    expect(await connection.status()).toEqual({ connected: false })
    await expect(connection.authorize(new AbortController().signal)).rejects.toThrow('原网页')
    expect(plugin.authorize).not.toHaveBeenCalled()
  })
  it('cancels the matching native request and discards a late authorization result', async () => {
    let finish!: (value: { connected: boolean; login: string }) => void
    const plugin = {
      status: vi.fn(),
      authorize: vi.fn(
        (_options: { requestId: string }) =>
          new Promise<{ connected: boolean; login: string }>((resolve) => {
            finish = resolve
          }),
      ),
      execute: vi.fn(),
      cancel: vi.fn(async () => {}),
    }
    const connection = new GitHubAssistantConnection(plugin, () => true)
    const controller = new AbortController()
    const running = connection.authorize(controller.signal)
    const rejected = expect(running).rejects.toThrow()
    controller.abort()
    finish({ connected: true, login: 'tester' })
    await rejected
    expect(plugin.cancel).toHaveBeenCalledExactlyOnceWith(plugin.authorize.mock.calls[0]![0])
    controller.abort()
    expect(plugin.cancel).toHaveBeenCalledTimes(1)
  })
  it('an already paused request never starts authorization or a write', async () => {
    const plugin = { status: vi.fn(), authorize: vi.fn(), execute: vi.fn(), cancel: vi.fn() }
    const connection = new GitHubAssistantConnection(plugin, () => true)
    const controller = new AbortController()
    controller.abort()
    await expect(
      connection.execute(
        'save',
        { repository: 'tester/bridge', content: 'local-only' },
        controller.signal,
      ),
    ).rejects.toThrow()
    expect(plugin.execute).not.toHaveBeenCalled()
  })
})
