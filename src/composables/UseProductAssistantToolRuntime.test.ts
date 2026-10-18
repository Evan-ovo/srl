/** @vitest-environment jsdom */
import { beforeEach, expect, it, vi } from 'vitest'
const { confirm } = vi.hoisted(() => ({ confirm: vi.fn() }))
vi.mock('../core/AppContainer', () => ({ externalAppService: {} }))
vi.mock('./UseConfirmDialog', () => ({ confirmAction: confirm }))
import { executeAssistantViewTool } from './UseProductAssistantToolRuntime'
const command = { action: 'view-current-ui', answer: '' } as never
const request = { canCaptureCurrent: true } as never
beforeEach(() => confirm.mockReset())
it('does not capture or attach an image after rejection or a late approval following stop', async () => {
  const capture = vi.fn()
  const controller = new AbortController()
  confirm.mockResolvedValueOnce(false)
  expect(
    await executeAssistantViewTool(
      command,
      request,
      controller.signal,
      () => true,
      () => ({}) as never,
      undefined,
      capture,
    ),
  ).toMatchObject({ cancelled: true })
  let accept!: (value: boolean) => void
  confirm.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        accept = resolve
      }),
  )
  const pending = executeAssistantViewTool(
    command,
    request,
    controller.signal,
    () => true,
    () => ({}) as never,
    undefined,
    capture,
  )
  controller.abort()
  accept(true)
  expect(await pending).toMatchObject({ cancelled: true })
  expect(capture).not.toHaveBeenCalled()
})
it('shows the actual AI target and rejects a destination change before taking the image', async () => {
  let accept!: (value: boolean) => void
  confirm.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        accept = resolve
      }),
  )
  const capture = vi.fn()
  let config = { url: 'https://api.example/v1', model: 'one' } as never
  const pending = executeAssistantViewTool(
    command,
    request,
    new AbortController().signal,
    () => true,
    () => ({}) as never,
    undefined,
    capture,
    () => config,
  )
  expect(confirm.mock.calls[0]![0].message).toContain('https://api.example（one）')
  config = { url: 'https://other.example/v1', model: 'two' } as never
  accept(true)
  await expect(pending).rejects.toThrow('目标已变化')
  expect(capture).not.toHaveBeenCalled()
})

it('withholds an already captured image when screenshot permission is revoked during capture', async () => {
  confirm.mockResolvedValueOnce(true)
  let finish!: (image: never) => void
  let allowed = true
  const capture = vi.fn(
    () =>
      new Promise<never>((resolve) => {
        finish = resolve
      }),
  )
  const pending = executeAssistantViewTool(
    command,
    request,
    new AbortController().signal,
    () => true,
    () => ({}) as never,
    undefined,
    capture,
    undefined,
    () => allowed,
  )
  await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1))
  allowed = false
  finish({ dataUrl: 'data:image/png;base64,fixture' } as never)
  const result = await pending
  expect(result.cancelled).toBe(true)
  expect(result.modelImage).toBeUndefined()
})
