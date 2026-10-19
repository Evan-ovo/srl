/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FrontendWorkshopImageHostingService } from './FrontendWorkshopImageHostingService'

beforeEach(() => localStorage.clear())
async function fixture(body: unknown, status = 200) {
  const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }))
  const credentials = {
    read: vi.fn(async () => ''),
    save: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  }
  const service = new FrontendWorkshopImageHostingService(request, credentials)
  await service.saveSelfHostedConfiguration({
    origin: 'https://files.example/upload?uploadChannel=s3',
    token: `imgbed_${'a'.repeat(64)}`,
    remember: false,
  })
  return { service, request }
}

describe('self-hosted remote files', () => {
  it('reads one bounded page directly from the saved origin with types and encoded file links', async () => {
    const { service, request } = await fixture({
      files: [
        {
          name: 'folder/photo #1.png',
          metadata: { FileType: 'image/png', FileSizeBytes: 123, TimeStamp: '1754020094217' },
        },
        { name: 'folder/music.mp3', metadata: { 'File-Mime': 'audio/mpeg', 'File-Size': '2048' } },
        { name: 'folder/movie.mp4', metadata: { FileType: 'video/mp4' } },
        {
          name: 'folder/archive.zip',
          metadata: { FileType: 'application/zip', FileName: '归档.zip' },
        },
      ],
      directories: ['folder/sub', '../outside', 'elsewhere'],
      totalCount: 101,
    })
    const abort = new AbortController()
    const page = await service.listSelfHosted({
      start: 50,
      directory: 'folder',
      search: 'photo',
      type: 'other',
      signal: abort.signal,
    })
    expect(request).toHaveBeenCalledTimes(1)
    const [input, init] = request.mock.calls[0]!
    const url = new URL(String(input))
    expect(url.origin + url.pathname).toBe('https://files.example/api/manage/list')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      start: '50',
      count: '50',
      dir: 'folder',
      search: 'photo',
      fileType: 'other',
      recursive: 'true',
    })
    expect(init).toMatchObject({
      method: 'GET',
      signal: abort.signal,
      credentials: 'omit',
      redirect: 'error',
    })
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer imgbed_${'a'.repeat(64)}`)
    expect(page.files.map((file) => file.type)).toEqual(['image', 'audio', 'video', 'other'])
    expect(page.files[0]?.url).toBe('https://files.example/file/folder/photo%20%231.png')
    expect(page.files[3]?.name).toBe('归档.zip')
    expect(page.files[2]?.sizeBytes).toBeNull()
    expect(page.directories).toEqual(['folder/sub'])
    expect(page.total).toBe(101)
  })

  it('uses the direct file count when browsing a single directory', async () => {
    const { service } = await fixture({
      files: [],
      directories: [],
      totalCount: 999,
      directFileCount: 3,
    })
    expect((await service.listSelfHosted({ recursive: false })).total).toBe(3)
  })

  it.each([401, 403])(
    'reports list permission failures (%s) without claiming the directory is empty',
    async (status) => {
      const { service } = await fixture({}, status)
      await expect(service.listSelfHosted()).rejects.toThrow('list 权限')
    },
  )

  it('rejects upload-only auth codes before making a request', async () => {
    const { service, request } = await fixture({})
    await service.saveSelfHostedConfiguration({
      origin: 'https://files.example',
      token: 'upload-only',
      remember: false,
      authMode: 'auth-code',
    })
    await expect(service.listSelfHosted()).rejects.toThrow('AUTH_CODE 只能上传')
    expect(request).not.toHaveBeenCalled()
  })

  it.each([
    { files: [{ name: '../secret', metadata: {} }] },
    { files: [], isIndexedResponse: false },
    { files: Array.from({ length: 51 }, () => ({ name: 'file.zip' })) },
  ])('rejects unsafe paths or an unpaged index response', async (payload) => {
    const { service } = await fixture(payload)
    await expect(service.listSelfHosted()).rejects.toThrow()
  })

  it('preserves an aborted request instead of misreporting CORS', async () => {
    const { service, request } = await fixture({})
    const controller = new AbortController()
    request.mockImplementationOnce(async () => {
      controller.abort()
      throw new DOMException('aborted', 'AbortError')
    })
    await expect(service.listSelfHosted({ signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
})
