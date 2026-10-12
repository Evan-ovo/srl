import { Capacitor, CapacitorHttp } from '@capacitor/core'

/** APK same-origin URLs otherwise hit Capacitor's bundled asset server, not the relay. */
export async function tavernHttpFetch(
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> {
  const appOrigin = typeof window === 'undefined' ? undefined : window.location.origin
  const url = new URL(input instanceof Request ? input.url : String(input), appOrigin)
  if (url.pathname.startsWith('/api/bridge/') && url.origin !== appOrigin) {
    const headers = new Headers(init.headers)
    headers.delete('Authorization')
    headers.delete('Cookie')
    headers.delete('X-CSRF-Token')
    init = { ...init, headers, credentials: 'omit', redirect: 'error' }
  }
  if (!Capacitor.isNativePlatform()) return fetch(input, init)
  if (
    !url.pathname.startsWith('/api/bridge/') &&
    !url.pathname.startsWith('/api/plugins/srl-bridge/')
  )
    throw new Error('不是酒馆中继地址')
  if (init.signal?.aborted) throw new DOMException('已取消传输', 'AbortError')
  let data: unknown = init.body
  let dataType: 'file' | undefined
  if (init.body instanceof Blob) {
    if (init.body.size > 256 * 1024 + 28) throw new Error('暂存分块超过大小限制')
    const bytes = new Uint8Array(await init.body.arrayBuffer())
    let binary = ''
    for (let offset = 0; offset < bytes.length; offset += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
    data = btoa(binary)
    dataType = 'file'
  } else if (typeof init.body === 'string') {
    data = JSON.parse(init.body)
  }
  const headers = Object.fromEntries(new Headers(init.headers).entries())
  const download = url.pathname.endsWith('/parcels/download')
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('已取消传输', 'AbortError'))
    init.signal?.addEventListener('abort', abort, { once: true })
    if (init.signal?.aborted) {
      abort()
      return
    }
    void CapacitorHttp.request({
      url: url.href,
      method: init.method || 'POST',
      headers,
      disableRedirects: init.redirect === 'error',
      data,
      ...(dataType ? { dataType } : {}),
      connectTimeout: 15_000,
      readTimeout: 45_000,
      responseType: download ? 'arraybuffer' : 'text',
    })
      .then((result) => {
        const outputHeaders = new Headers(result.headers)
        outputHeaders.delete('set-cookie')
        outputHeaders.delete('set-cookie2')
        let body: BodyInit | null =
          typeof result.data === 'string' ? result.data : JSON.stringify(result.data)
        if (
          download &&
          result.status >= 200 &&
          result.status < 300 &&
          typeof result.data === 'string'
        )
          body = Uint8Array.from(atob(result.data), (char) => char.charCodeAt(0))
        if ([204, 205, 304].includes(result.status)) body = null
        resolve(new Response(body, { status: result.status, headers: outputHeaders }))
      }, reject)
      .catch(reject)
      .finally(() => init.signal?.removeEventListener('abort', abort))
  })
}
