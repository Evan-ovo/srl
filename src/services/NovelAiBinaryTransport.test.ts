import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { createHash } from 'node:crypto'
import { FrontendWorkshopImageGenerationService } from './FrontendWorkshopImageGenerationService'
import { requestNovelAiBinary } from './NovelAiBinaryTransport'

const ENDPOINT = 'https://image.novelai.net/ai/generate-image'
const PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF2cAAAAASUVORK5CYII=',
    'base64',
  ),
)
const HIGH_BYTES = Uint8Array.from({ length: 4096 }, (_, index) => (index * 73) % 256)

function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}

function android(originalFetch?: typeof fetch) {
  const nativeWindow = {
    Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
    CapacitorWebFetch: originalFetch,
  }
  vi.stubGlobal('window', nativeWindow)
  return nativeWindow
}

function response(bytes: Uint8Array<ArrayBuffer>) {
  return new Response(bytes, {
    headers: {
      'content-type': 'binary/octet-stream',
      'content-disposition': 'attachment; filename=images.zip',
    },
  })
}

async function streamedZip() {
  const archive = new JSZip().file('metadata', HIGH_BYTES).file('image', PNG)
  return Uint8Array.from(
    await archive.generateAsync({ type: 'uint8array', streamFiles: true, compression: 'DEFLATE' }),
  )
}

function generate(request: typeof fetch, signal?: AbortSignal) {
  const service = new FrontendWorkshopImageGenerationService(request)
  return service.generate(
    { ...service.defaultConfig('novelai'), apiKey: 'local-test-key' },
    { prompt: 'local fixture only', negativePrompt: 'private negative', seed: 42 },
    { signal },
  )
}

beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => null })
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('NovelAI Android binary transport', () => {
  it('bypasses the text-converting patch and delivers an unchanged descriptor ZIP to JSZip', async () => {
    const bytes = await streamedZip()
    const original = vi.fn<typeof fetch>(async () => response(bytes))
    android(original)
    // Reproduce the damaging UTF-8 round trip of the existing POST bridge.
    const patched = vi.fn<typeof fetch>(async () => new Response(new TextDecoder().decode(bytes)))
    const result = await generate(patched)
    expect(result.dataUrl).toBe(`data:image/png;base64,${Buffer.from(PNG).toString('base64')}`)
    expect(original).toHaveBeenCalledOnce()
    expect(original.mock.calls[0][0]).toBe(ENDPOINT)
    expect(patched).not.toHaveBeenCalled()
    expect(console.info).toHaveBeenCalledExactlyOnceWith(
      '[NovelAI transport]',
      'novelAiTransport=capacitor-original-fetch',
    )
  })

  it.each([
    ['every byte value', HIGH_BYTES],
    ['invalid UTF-8', new Uint8Array([0x00, 0x80, 0xff, 0xc0, 0xef, 0x0d, 0x0a, 0xff, 0x80])],
  ])(
    'preserves %s byte-for-byte without consuming or rebuilding the Response',
    async (_, bytes) => {
      const originalResponse = response(bytes)
      const text = vi.spyOn(originalResponse, 'text')
      const original = vi.fn<typeof fetch>(async () => originalResponse)
      const nativeWindow = android(original)
      const patched = vi.fn<typeof fetch>()
      const init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: new AbortController().signal,
      }
      const received = await requestNovelAiBinary(patched, ENDPOINT, init)
      expect(received.response).toBe(originalResponse)
      expect(received.response.bodyUsed).toBe(false)
      expect(original.mock.contexts[0]).toBe(nativeWindow)
      expect(original.mock.calls[0][1]).toBe(init)
      const actual = new Uint8Array(await received.response.arrayBuffer())
      expect(actual).toEqual(bytes)
      expect(sha256(actual)).toBe(sha256(bytes))
      expect(Buffer.from(actual).includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false)
      expect(text).not.toHaveBeenCalled()
      expect(patched).not.toHaveBeenCalled()
    },
  )

  it('preserves a real multi-entry data-descriptor ZIP and its SHA-256', async () => {
    const bytes = await streamedZip()
    const header = new DataView(bytes.buffer)
    expect(header.getUint16(6, true) & 8).toBe(8)
    expect(header.getUint32(18, true)).toBe(0)
    expect(header.getUint32(22, true)).toBe(0)
    expect(Buffer.from(bytes).includes(Buffer.from([0x50, 0x4b, 0x07, 0x08]))).toBe(true)
    android(vi.fn<typeof fetch>(async () => response(bytes)))
    const { response: received } = await requestNovelAiBinary(vi.fn(), ENDPOINT, { method: 'POST' })
    const actual = new Uint8Array(await received.arrayBuffer())
    expect(actual).toEqual(bytes)
    expect(sha256(actual)).toBe(sha256(bytes))
    const archive = await JSZip.loadAsync(actual, { checkCRC32: true })
    expect(await archive.file('metadata')!.async('uint8array')).toEqual(HIGH_BYTES)
    expect(await archive.file('image')!.async('uint8array')).toEqual(PNG)
  })

  it.each(['web', 'ios'])('keeps the supplied fetch on %s', async (platform) => {
    const unused = vi.fn<typeof fetch>()
    vi.stubGlobal('window', {
      Capacitor: { isNativePlatform: () => platform !== 'web', getPlatform: () => platform },
      CapacitorWebFetch: unused,
    })
    const suppliedResponse = response(PNG)
    const supplied = vi.fn<typeof fetch>(async () => suppliedResponse)
    const received = await requestNovelAiBinary(supplied, ENDPOINT, { method: 'POST' })
    expect(received.response).toBe(suppliedResponse)
    expect(supplied).toHaveBeenCalledOnce()
    expect(unused).not.toHaveBeenCalled()
  })

  it.each(['openai'] as const)(
    'does not take over Android %s requests or replace global fetch',
    async (provider) => {
      const original = vi.fn<typeof fetch>()
      const nativeWindow = android(original)
      const existing = vi.fn<typeof fetch>(async () =>
        Response.json({ data: [{ b64_json: Buffer.from(PNG).toString('base64') }] }),
      )
      vi.stubGlobal('fetch', existing)
      const service = new FrontendWorkshopImageGenerationService(existing)
      await service.generate(
        { ...service.defaultConfig(provider), apiKey: 'local-test-key' },
        { prompt: 'local fixture only' },
      )
      expect(existing).toHaveBeenCalledOnce()
      expect(original).not.toHaveBeenCalled()
      expect(globalThis.fetch).toBe(existing)
      expect(nativeWindow.CapacitorWebFetch).toBe(original)
      expect(console.info).not.toHaveBeenCalled()
    },
  )

  it.each([
    'nai-diffusion-3',
    'nai-diffusion-4-full',
    'nai-diffusion-4-5-full',
    'nai-diffusion-5-full',
  ])('keeps the entire Web/Android request contract identical for %s', async (model) => {
    const web = vi.fn<typeof fetch>(async () => response(PNG))
    const original = vi.fn<typeof fetch>(async () => response(PNG))
    vi.stubGlobal('window', undefined)
    const service = new FrontendWorkshopImageGenerationService(web)
    const config = { ...service.defaultConfig('novelai'), model, apiKey: 'local-test-key' }
    const request = {
      prompt: 'local fixture only',
      negativePrompt: 'private negative',
      seed: 42,
      novelAiQualityMode: 'standard' as const,
      novelAiUcPreset: 'heavy',
    }
    const options = { signal: new AbortController().signal }
    await service.generate(config, request, options)
    android(original)
    await service.generate(config, request, options)
    expect(original.mock.calls[0]).toEqual(web.mock.calls[0])
    expect(web).toHaveBeenCalledOnce()
    expect(original).toHaveBeenCalledOnce()
  })

  it.each([
    [401, 'auth', false],
    [403, 'auth', false],
    [429, 'rate_limit', true],
    [500, 'server', true],
  ] as const)(
    'preserves HTTP %i classification without retry',
    async (status, category, retryable) => {
      const original = vi.fn<typeof fetch>(async () =>
        Response.json({ message: 'upstream unavailable' }, { status }),
      )
      android(original)
      const patched = vi.fn<typeof fetch>()
      await expect(generate(patched)).rejects.toMatchObject({
        diagnostic: { httpStatus: status, category, retryable },
      })
      expect(original).toHaveBeenCalledOnce()
      expect(patched).not.toHaveBeenCalled()
    },
  )

  it('does not retry CORS/network failures through the damaging native bridge or expose raw errors', async () => {
    const original = vi.fn<typeof fetch>(async () => {
      throw new TypeError('private native error with local-test-key')
    })
    android(original)
    const patched = vi.fn<typeof fetch>()
    await expect(generate(patched)).rejects.toMatchObject({ diagnostic: { category: 'network' } })
    expect(original).toHaveBeenCalledOnce()
    expect(patched).not.toHaveBeenCalled()
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toMatch(
      /private native error|local-test-key/u,
    )
  })

  it('fails safely when the installed bridge does not expose original fetch', async () => {
    android()
    const patched = vi.fn<typeof fetch>()
    await expect(requestNovelAiBinary(patched, ENDPOINT, { method: 'POST' })).rejects.toThrow(
      '原始 WebView fetch 不可用',
    )
    expect(patched).not.toHaveBeenCalled()
  })

  it.each(['before fetch', 'during fetch', 'during body'] as const)(
    'propagates AbortSignal cancellation %s',
    async (stage) => {
      const controller = new AbortController()
      if (stage === 'before fetch') controller.abort()
      let receivedSignal: AbortSignal | null | undefined
      let bodyReady!: () => void
      const ready = new Promise<void>((resolve) => {
        bodyReady = resolve
      })
      const original = vi.fn<typeof fetch>(async (_url, init) => {
        receivedSignal = init?.signal
        receivedSignal?.throwIfAborted()
        if (stage === 'during body') {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(stream) {
                receivedSignal?.addEventListener(
                  'abort',
                  () => stream.error(receivedSignal?.reason),
                  { once: true },
                )
                bodyReady()
              },
            }),
          )
        }
        return new Promise<Response>((_resolve, reject) => {
          receivedSignal?.addEventListener('abort', () => reject(receivedSignal?.reason), {
            once: true,
          })
        })
      })
      android(original)
      const patched = vi.fn<typeof fetch>()
      const pending = generate(patched, controller.signal)
      const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      if (stage === 'during body') await ready
      controller.abort()
      await assertion
      if (stage === 'before fetch') {
        expect(receivedSignal).toBeUndefined()
        expect(original).not.toHaveBeenCalled()
      } else {
        expect(receivedSignal).toBe(controller.signal)
        expect(original).toHaveBeenCalledOnce()
      }
      expect(patched).not.toHaveBeenCalled()
      expect(console.warn).not.toHaveBeenCalled()
    },
  )

  it('adds the selected path to ZIP failures without exposing JSZip error contents', async () => {
    android(vi.fn<typeof fetch>(async () => response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))))
    await expect(generate(vi.fn())).rejects.toMatchObject({
      diagnostic: {
        category: 'response_parse',
        responseBody: expect.stringContaining('transport=capacitor-original-fetch'),
      },
    })
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toMatch(
      /local-test-key|local fixture only|private negative/u,
    )
  })
})
