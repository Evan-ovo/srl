/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ native: false, request: vi.fn() }))
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => mocks.native,
    getPlatform: () => (mocks.native ? 'android' : 'web'),
  },
  CapacitorHttp: { request: mocks.request },
  registerPlugin: () => ({}),
}))
import { selfHostedFileList } from './HostedApiTransport'
beforeEach(() => {
  vi.clearAllMocks()
  mocks.native = false
})
describe('self-hosted list transport', () => {
  it('discards a native response received after the caller closes the page', async () => {
    mocks.native = true
    let finish!: (result: unknown) => void
    mocks.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const controller = new AbortController()
    const pending = selfHostedFileList(
      vi.fn<typeof fetch>(),
      new URL('https://files.example/api/manage/list'),
      { authorization: 'Bearer example-token', signal: controller.signal },
    )
    controller.abort()
    finish({ status: 200, data: '{"files":[]}', headers: {} })
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
  it('uses native HTTP for the bounded list without following redirects', async () => {
    mocks.native = true
    mocks.request.mockResolvedValue({
      status: 200,
      data: '{"files":[]}',
      headers: { 'content-type': 'application/json' },
    })
    const web = vi.fn<typeof fetch>()
    const response = await selfHostedFileList(
      web,
      new URL('https://files.example/api/manage/list?count=50'),
      { authorization: 'Bearer example-token' },
    )
    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        disableRedirects: true,
        headers: { Authorization: 'Bearer example-token', Accept: 'application/json' },
      }),
    )
    expect(await response.json()).toEqual({ files: [] })
    expect(web).not.toHaveBeenCalled()
  })
  it.each([
    'http://files.example/api/manage/list',
    'https://files.example/api/manage/list?action=rebuild',
    'https://files.example/api/manage/delete/a',
    'https://u:p@files.example/api/manage/list',
  ])('rejects non-list targets: %s', async (target) => {
    const web = vi.fn<typeof fetch>()
    await expect(
      selfHostedFileList(web, new URL(target), { authorization: 'Bearer example-token' }),
    ).rejects.toThrow()
    expect(web).not.toHaveBeenCalled()
    expect(mocks.request).not.toHaveBeenCalled()
  })
})
