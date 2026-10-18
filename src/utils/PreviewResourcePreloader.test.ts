// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

const nativeMocks = vi.hoisted(() => ({
  available: vi.fn(() => false),
  download: vi.fn(),
  configure: vi.fn(async () => true),
}))

vi.mock('../services/NativePreviewAsset', () => ({
  isNativePreviewAssetAvailable: nativeMocks.available,
  downloadNativePreviewAsset: nativeMocks.download,
  configureNativePreviewDownloadConcurrency: nativeMocks.configure,
}))

import {
  collectPreviewRemoteResourceUrls,
  preloadPreviewDocumentResources,
} from './PreviewResourcePreloader'

describe('PreviewResourcePreloader', () => {
  afterEach(() => {
    nativeMocks.available.mockReturnValue(false)
    nativeMocks.download.mockReset()
    nativeMocks.configure.mockClear()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function mockObjectUrls(): {
    create: ReturnType<typeof vi.fn>
    revoke: ReturnType<typeof vi.fn>
  } {
    const create = vi.fn(() => `blob:https://srl.example/${crypto.randomUUID()}`)
    const revoke = vi.fn()
    vi.stubGlobal(
      'URL',
      Object.assign(window.URL, { createObjectURL: create, revokeObjectURL: revoke }),
    )
    return { create, revoke }
  }

  it.each([
    [false, false, 4],
    [false, true, 6],
    [true, false, 3],
    [true, true, 6],
  ])('原生=%s 加速=%s 时并发严格限制为 %s，结束后资源可释放', async (native, increased, limit) => {
    nativeMocks.available.mockReturnValue(native)
    mockObjectUrls()
    const pending: Array<() => void> = []
    let started = 0
    const response = (url: string) => {
      started++
      return new Promise((resolve) =>
        pending.push(() =>
          resolve(
            native
              ? {
                  resourceUrl: 'file:/' + url,
                  resolvedUrl: url,
                  contentType: 'image/png',
                  size: 1,
                  cached: false,
                }
              : new Response('image', { headers: { 'content-type': 'image/png' } }),
          ),
        ),
      )
    }
    nativeMocks.download.mockImplementation(response)
    vi.stubGlobal('fetch', vi.fn(response))
    const source = Array.from(
      { length: 12 },
      (_, index) => '<img src="https://cdn.example/' + index + '.png">',
    ).join('')
    const task = preloadPreviewDocumentResources(source, undefined, {
      increaseDownloadConcurrency: increased,
    })
    await vi.waitFor(() => expect(started).toBe(limit))
    expect(pending).toHaveLength(limit)
    const initial = pending.splice(0)
    initial[0]()
    await vi.waitFor(() => expect(started).toBe(limit + 1))
    initial.slice(1).forEach((finish) => finish())
    while (started < 12 || pending.length) {
      pending.splice(0).forEach((finish) => finish())
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const result = await task
    expect(result.loaded).toBe(12)
    if (native) expect(nativeMocks.configure).toHaveBeenCalledWith(increased)
    result.release()
  })

  it('收集预览文档内图片、srcset、背景与字体的远程资源', () => {
    const urls = collectPreviewRemoteResourceUrls(
      `<!doctype html><html><head><style>@font-face{src:url('https://cdn.example/font.woff2')}.card{background:url(https://cdn.example/bg.png)}</style></head><body><img src="https://cdn.example/cover.png"><img srcset="https://cdn.example/one.png 1x, https://cdn.example/two.png 2x"></body></html>`,
    )

    expect(urls).toEqual([
      'https://cdn.example/cover.png',
      'https://cdn.example/one.png',
      'https://cdn.example/two.png',
      'https://cdn.example/font.woff2',
      'https://cdn.example/bg.png',
    ])
  })

  it('按需登记保留图片候选与视频封面，媒体流不进入整文件缓存且图片片段共用 URL', () => {
    expect(
      collectPreviewRemoteResourceUrls(
        '<img src="https://cdn.example/sprite.svg#one"><img src="https://cdn.example/sprite.svg#two"><video src="https://cdn.example/large.mp4" poster="https://cdn.example/poster.png"><source src="https://cdn.example/fallback.webm"></video><audio src="https://cdn.example/audio.mp3"></audio>',
        true,
      ),
    ).toEqual(['https://cdn.example/sprite.svg', 'https://cdn.example/poster.png'])
  })

  it('递归收集并改写 TavernHelper iframe srcdoc 内的展示素材', async () => {
    const source = `<iframe srcdoc='<img src="https://cdn.example/nested-cover.png">'></iframe>`
    expect(collectPreviewRemoteResourceUrls(source)).toEqual([
      'https://cdn.example/nested-cover.png',
    ])
    mockObjectUrls()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('image', { status: 200, headers: { 'content-type': 'image/png' } }),
      ),
    )

    const result = await preloadPreviewDocumentResources(source)

    expect(result.loaded).toBe(1)
    expect(result.document).toContain('data:image/png;base64,')
    expect(result.document).not.toContain('https://cdn.example/nested-cover.png')
  })

  it('只预下载展示资源，并把相对路径解析为预览文档的公开来源', () => {
    const urls = collectPreviewRemoteResourceUrls(
      '<base href="https://cdn.example/theme/"><link rel="stylesheet" href="main.css"><link rel="preconnect" href="https://ignored.example"><img src="cover.png"><audio src="sound.mp3"><script src="https://ignored.example/app.js"></script><iframe src="https://ignored.example/embed"></iframe>',
    )

    expect(urls).toEqual([
      'https://cdn.example/theme/cover.png',
      'https://cdn.example/theme/sound.mp3',
      'https://cdn.example/theme/main.css',
    ])
  })

  it('全部下载结束后才返回替换为 Blob URL 的文档，并报告失败项', async () => {
    const objectUrls = mockObjectUrls()
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/missing.png')) return new Response('', { status: 404 })
      return new Response('image', {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const progress: string[] = []

    const result = await preloadPreviewDocumentResources(
      '<!doctype html><img src="https://cdn.example/ready.png"><img src="https://cdn.example/missing.png">',
      (state) => progress.push(`${state.completed}/${state.total}/${state.failed}`),
    )

    expect(result.total).toBe(2)
    expect(result.loaded).toBe(1)
    expect(result.failedUrls).toEqual(['https://cdn.example/missing.png'])
    expect(result.document).toContain('blob:https://srl.example/')
    expect(result.document).toContain('https://cdn.example/missing.png')
    expect(result.failures).toEqual([
      { url: 'https://cdn.example/missing.png', reason: '资源请求失败（404）' },
    ])
    expect(progress.at(-1)).toBe('2/2/1')
    result.release()
    expect(objectUrls.revoke).toHaveBeenCalledOnce()
  })

  it('保留 @import 语法，只替换已下载的样式资源地址', async () => {
    mockObjectUrls()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('body{}', { status: 200, headers: { 'content-type': 'text/css' } }),
      ),
    )

    const result = await preloadPreviewDocumentResources(
      '<!doctype html><style>@import "https://cdn.example/theme.css";</style>',
    )

    expect(result.document).toContain('@import url("blob:https://srl.example/')
  })

  it('会预下载样式表内的相对图片，并在 Blob CSS 中改写为 Blob URL', async () => {
    const objectUrls = mockObjectUrls()
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/theme.css')) {
        return new Response('.card{background:url("./cover.png")}', {
          status: 200,
          headers: { 'content-type': 'text/css' },
        })
      }
      return new Response('image', {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await preloadPreviewDocumentResources(
      '<!doctype html><link rel="stylesheet" href="https://cdn.example/assets/theme.css">',
    )

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://cdn.example/assets/theme.css',
      'https://cdn.example/assets/cover.png',
    ])
    expect(result.total).toBe(2)
    expect(result.loaded).toBe(2)
    expect(result.document).toContain('blob:https://srl.example/')
    expect(objectUrls.create).toHaveBeenCalledTimes(2)
    const cssObjectUrl = new DOMParser()
      .parseFromString(result.document, 'text/html')
      .querySelector('link')
      ?.getAttribute('href')
    expect(cssObjectUrl).toMatch(/^blob:https:\/\/srl\.example\//)
    const rewrittenCssBlob = objectUrls.create.mock.calls[1]?.[0] as Blob
    expect(await rewrittenCssBlob.text()).toContain('blob:https://srl.example/')
  })

  it('晚到的 CSS 新增素材仍填满空闲下载槽位', async () => {
    mockObjectUrls()
    let completeCss!: (response: Response) => void
    const imageCompletions: Array<() => void> = []
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/theme.css'))
        return new Promise<Response>((resolve) => {
          completeCss = resolve
        })
      if (url.includes('/nested'))
        return new Promise<Response>((resolve) => {
          imageCompletions.push(() =>
            resolve(new Response('image', { headers: { 'content-type': 'image/png' } })),
          )
        })
      return Promise.resolve(new Response('image', { headers: { 'content-type': 'image/png' } }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = preloadPreviewDocumentResources(
      '<link rel="stylesheet" href="https://cdn.example/theme.css"><img src="https://cdn.example/first.png"><img src="https://cdn.example/second.png">',
    )
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    completeCss(
      new Response(
        'body{background:url("./nested1.png")}div{background:url("./nested2.png")}p{background:url("./nested3.png")}',
        { headers: { 'content-type': 'text/css' } },
      ),
    )
    await vi.waitFor(() => expect(imageCompletions).toHaveLength(3))
    for (const complete of imageCompletions) complete()
    expect((await result).loaded).toBe(6)
  })

  it('样式表优先于等待中的图片，原生传输收到取消信号', async () => {
    nativeMocks.available.mockReturnValue(true)
    // The native cache URL is a fixture, so materialize it locally as well.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('image')))
    nativeMocks.download.mockImplementation(async (url: string) => ({
      resourceUrl: `https://app.example/cache/${url.split('/').at(-1)}`,
      resolvedUrl: url,
      contentType: url.endsWith('.css') ? 'text/css' : 'image/png',
      text: url.endsWith('.css') ? 'body{}' : undefined,
      size: 5,
      cached: false,
    }))
    mockObjectUrls()
    const controller = new AbortController()
    await preloadPreviewDocumentResources(
      '<img src="https://cdn.example/a.png"><link rel="stylesheet" href="https://cdn.example/theme.css">',
      undefined,
      { signal: controller.signal },
    )
    expect(nativeMocks.download.mock.calls[0]![0]).toBe('https://cdn.example/theme.css')
    expect(nativeMocks.download.mock.calls.every((call) => call[2] === controller.signal)).toBe(
      true,
    )
  })

  it('APK 原生 HTTP 拦截响应仍按真正的 CDN 地址解析 CSS 相对资源', async () => {
    mockObjectUrls()
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/theme.css')) {
        return Object.defineProperty(
          new Response('.card{background:url("./cover.png")}', {
            status: 200,
            headers: { 'content-type': 'text/css' },
          }),
          'url',
          {
            value:
              'https://srl.example.com/_capacitor_http_interceptor_?u=https%3A%2F%2Fcdn.example%2Fassets%2Ftheme.css',
          },
        )
      }
      return new Response('image', {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await preloadPreviewDocumentResources(
      '<link rel="stylesheet" href="https://cdn.example/assets/theme.css">',
    )

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://cdn.example/assets/theme.css',
      'https://cdn.example/assets/cover.png',
    ])
    expect(result.failedUrls).toEqual([])
    expect(result.loaded).toBe(2)
  })

  it('APK 使用原生文件缓存地址，不再把图片经 WebView fetch 和 Base64 桥接', async () => {
    nativeMocks.available.mockReturnValue(true)
    nativeMocks.download.mockResolvedValue({
      resourceUrl: 'https://srl.example.com/_capacitor_file_/data/user/0/cache/cover.png',
      resolvedUrl: 'https://cdn.example/cover.png',
      contentType: 'image/png',
      size: 5,
      cached: false,
    })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await preloadPreviewDocumentResources(
      '<img src="https://cdn.example/cover.png">',
    )

    expect(nativeMocks.download).toHaveBeenCalledWith(
      'https://cdn.example/cover.png',
      12 * 1024 * 1024,
      undefined,
    )
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.failedUrls).toEqual([])
    expect(result.document).toContain('/_capacitor_file_/data/user/0/cache/cover.png')
  })

  it('APK 内同源随包素材经 WebView 读取为 blob，不绕过本地资源映射请求线上站点', async () => {
    nativeMocks.available.mockReturnValue(true)
    const objectUrls = mockObjectUrls()
    const sourceUrl = `${window.location.origin}/images/opening-cover.png`
    const fetchMock = vi.fn(
      async () => new Response('image', { status: 200, headers: { 'content-type': 'image/png' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await preloadPreviewDocumentResources(`<img src="${sourceUrl}">`)

    expect(fetchMock).toHaveBeenCalledWith(
      sourceUrl,
      expect.objectContaining({ credentials: 'omit' }),
    )
    expect(nativeMocks.download).not.toHaveBeenCalled()
    expect(result.failedUrls).toEqual([])
    expect(result.document).toContain('blob:https://srl.example/')
    expect(objectUrls.create).toHaveBeenCalledOnce()
  })

  it('APK 保持 Catbox 原始外链，不按图床改写传输地址', async () => {
    nativeMocks.available.mockReturnValue(true)
    nativeMocks.download.mockResolvedValue({
      resourceUrl: 'https://srl.example.com/_capacitor_file_/data/user/0/cache/catbox.png',
      resolvedUrl: 'https://files.catbox.moe/abc123.png',
      contentType: 'image/png',
      size: 5,
      cached: false,
    })

    const result = await preloadPreviewDocumentResources(
      '<img src="https://files.catbox.moe/abc123.png">',
    )

    expect(nativeMocks.download).toHaveBeenCalledWith(
      'https://files.catbox.moe/abc123.png',
      12 * 1024 * 1024,
      undefined,
    )
    expect(result.document).toContain('/_capacitor_file_/data/user/0/cache/catbox.png')
    expect(result.failedUrls).toEqual([])
  })

  it('使用与网页直连等价的来源策略，避免 Android 预下载被防盗链误拒绝', async () => {
    mockObjectUrls()
    const fetchMock = vi.fn(async () =>
      Promise.resolve(
        new Response('image', { status: 200, headers: { 'content-type': 'image/png' } }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await preloadPreviewDocumentResources('<img src="https://cdn.example/cover.png">')

    expect(fetchMock).toHaveBeenCalledWith(
      'https://cdn.example/cover.png',
      expect.objectContaining({
        credentials: 'omit',
        referrerPolicy: 'strict-origin-when-cross-origin',
      }),
    )
  })

  it('取消后中断正在进行的预下载，不把取消项记为资源失败', async () => {
    let observedSignal: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            observedSignal = init.signal ?? undefined
            observedSignal?.addEventListener('abort', () =>
              reject(new DOMException('已取消', 'AbortError')),
            )
          }),
      ),
    )
    const controller = new AbortController()
    const pending = preloadPreviewDocumentResources(
      '<img src="https://cdn.example/cover.png">',
      undefined,
      { signal: controller.signal },
    )
    await vi.waitFor(() => expect(observedSignal).toBeDefined())
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
