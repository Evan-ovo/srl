/** @vitest-environment node */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { it } from 'vitest'
import {
  CLOUD_METADATA_TIMEOUT_MS,
  CLOUD_TRANSFER_MIN_TIMEOUT_MS,
  CloudRequestTimeoutError,
  fetchWithDeadline,
  readCloudResponseText,
  readCloudResponseBlob,
} from './CloudBackupHttp'

async function withFakeNetwork(
  run: (timers: Map<number, { callback: () => void; delay: number }>) => Promise<void>,
): Promise<void> {
  const oldFetch = globalThis.fetch
  const oldSet = globalThis.setTimeout
  const oldClear = globalThis.clearTimeout
  const timers = new Map<number, { callback: () => void; delay: number }>()
  let next = 0
  globalThis.setTimeout = ((callback: () => void, delay: number) => {
    const id = ++next
    timers.set(id, { callback, delay })
    return id
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((id: number) => timers.delete(id)) as unknown as typeof clearTimeout
  try {
    await run(timers)
  } finally {
    globalThis.fetch = oldFetch
    globalThis.setTimeout = oldSet
    globalThis.clearTimeout = oldClear
  }
}

it('keeps caller cancellation connected after headers and aborts a blocked body', async () => {
  await withFakeNetwork(async (timers) => {
    let signal: AbortSignal | null | undefined
    let cancelled = false
    globalThis.fetch = async (_url, init) => {
      signal = init?.signal
      return new Response(
        new ReadableStream({
          cancel: () => {
            cancelled = true
          },
        }),
      )
    }
    const controller = new AbortController()
    const response = await fetchWithDeadline('https://example.invalid/file', {
      signal: controller.signal,
    })
    const text = response.text()
    const rejected = assert.rejects(text, /cancel after headers/)
    controller.abort(new Error('cancel after headers'))
    await rejected
    assert.equal(signal?.aborted, true)
    assert.equal(cancelled, true)
    assert.equal(timers.size, 0)
  })
})

it('reports streamed download bytes without another request and preserves body failures', async () => {
  const progress: number[] = []
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('first'))
      controller.enqueue(new TextEncoder().encode('second'))
      controller.close()
    },
  })
  const result = await readCloudResponseBlob(new Response(body), 11, (bytes) =>
    progress.push(bytes),
  )
  assert.equal(await result.text(), 'firstsecond')
  assert.equal(progress.at(-1), 11)
  await assert.rejects(
    readCloudResponseBlob(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError('download body interrupted'))
          },
        }),
      ),
      11,
      () => undefined,
    ),
    /download body interrupted/,
  )
})

it('enforces the body deadline and aborts the transport, not only the waiting promise', async () => {
  await withFakeNetwork(async (timers) => {
    let signal: AbortSignal | null | undefined
    globalThis.fetch = async (_url, init) => {
      signal = init?.signal
      return new Response(new ReadableStream())
    }
    const response = await fetchWithDeadline('https://example.invalid/file', {})
    const rejected = assert.rejects(response.blob(), CloudRequestTimeoutError)
    assert.equal(timers.size, 1)
    ;[...timers.values()][0]!.callback()
    await rejected
    assert.equal(signal?.aborted, true)
    assert.equal(timers.size, 0)
  })
})

it('uses the existing metadata idle deadline for gzip manifests without changing large transfer deadlines', async () => {
  await withFakeNetwork(async (timers) => {
    let signal: AbortSignal | null | undefined
    globalThis.fetch = async (_url, init) => {
      signal = init?.signal
      return new Response(new ReadableStream(), {
        headers: { 'Content-Type': 'application/gzip', 'Content-Length': '3145728' },
      })
    }
    const response = await fetchWithDeadline(
      'https://example.invalid/snapshot.json.gz',
      {},
      'metadata',
    )
    const rejected = assert.rejects(response.blob(), CloudRequestTimeoutError)
    assert.equal([...timers.values()][0]?.delay, CLOUD_METADATA_TIMEOUT_MS)
    ;[...timers.values()][0]!.callback()
    await rejected
    assert.equal(signal?.aborted, true)
    assert.equal(timers.size, 0)
  })
})

it('does not eagerly drain large responses and refreshes the idle deadline on new bytes', async () => {
  await withFakeNetwork(async (timers) => {
    let pulls = 0
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              pulls += 1
              if (pulls <= 2) controller.enqueue(new Uint8Array([pulls]))
              else controller.close()
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { 'Content-Type': 'application/octet-stream' } },
      )
    const response = await fetchWithDeadline('https://example.invalid/file', {})
    assert.equal(pulls, 0)
    assert.equal([...timers.values()][0]?.delay, CLOUD_TRANSFER_MIN_TIMEOUT_MS)
    const firstTimer = [...timers.keys()][0]
    const reader = response.body!.getReader()
    assert.deepEqual((await reader.read()).value, new Uint8Array([1]))
    assert.notEqual([...timers.keys()][0], firstTimer)
    assert.deepEqual((await reader.read()).value, new Uint8Array([2]))
    assert.equal((await reader.read()).done, true)
    assert.equal(timers.size, 0)
    reader.releaseLock()
  })
})

it('preserves response status, headers, URL and cloning while supporting JSON reads', async () => {
  await withFakeNetwork(async (timers) => {
    globalThis.fetch = async () => {
      const result = new Response('{"ok":true}', { status: 201, headers: { 'X-Test': 'kept' } })
      Object.defineProperty(result, 'url', { value: 'https://example.invalid/final' })
      return result
    }
    const response = await fetchWithDeadline('https://example.invalid/file', {})
    const copy = response.clone()
    assert.equal(response.status, 201)
    assert.equal(response.headers.get('X-Test'), 'kept')
    assert.equal(response.url, 'https://example.invalid/final')
    assert.equal(copy.url, response.url)
    const [left, right] = await Promise.all([response.json(), copy.json()])
    assert.deepEqual(left, { ok: true })
    assert.deepEqual(right, left)
    assert.equal(timers.size, 0)
  })
})

it('cleans bodyless requests and rejects pre-aborted calls without invoking fetch', async () => {
  await withFakeNetwork(async (timers) => {
    let calls = 0
    globalThis.fetch = async () => {
      calls += 1
      return new Response(null, { status: 204 })
    }
    const response = await fetchWithDeadline('https://example.invalid/file', { method: 'HEAD' })
    assert.equal(response.status, 204)
    assert.equal(timers.size, 0)
    const controller = new AbortController()
    controller.abort(new Error('pre-aborted'))
    await assert.rejects(
      fetchWithDeadline('https://example.invalid/file', { signal: controller.signal }),
      /pre-aborted/,
    )
    assert.equal(calls, 1)
  })
})

it('bounds header waits even when a fetch implementation ignores AbortSignal', async () => {
  await withFakeNetwork(async (timers) => {
    globalThis.fetch = () => new Promise<Response>(() => undefined)
    const rejected = assert.rejects(
      fetchWithDeadline('https://example.invalid/file', {}),
      CloudRequestTimeoutError,
    )
    assert.equal([...timers.values()][0]?.delay, CLOUD_METADATA_TIMEOUT_MS)
    ;[...timers.values()][0]!.callback()
    await rejected
    assert.equal(timers.size, 0)
  })
})

it('aborts the underlying request when metadata text reading expires', async () => {
  await withFakeNetwork(async (timers) => {
    let signal: AbortSignal | null | undefined
    globalThis.fetch = async (_url, init) => {
      signal = init?.signal
      return new Response(new ReadableStream())
    }
    const response = await fetchWithDeadline('https://example.invalid/file', {})
    const rejected = assert.rejects(readCloudResponseText(response), CloudRequestTimeoutError)
    ;[...timers.values()].at(-1)!.callback()
    await rejected
    assert.equal(signal?.aborted, true)
    assert.equal(timers.size, 0)
  })
})

it('propagates synchronous fetch failures without leaving timers or rejected cleanup promises', async () => {
  await withFakeNetwork(async (timers) => {
    globalThis.fetch = () => {
      throw new Error('sync failure')
    }
    await assert.rejects(fetchWithDeadline('https://example.invalid/file', {}), /sync failure/)
    assert.equal(timers.size, 0)
  })
})

it('cancels a real HTTP response after receiving headers', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream' })
    response.write('first chunk')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const controller = new AbortController()
    const response = await fetchWithDeadline(`http://127.0.0.1:${address.port}/slow`, {
      signal: controller.signal,
    })
    const rejected = assert.rejects(response.blob(), /real cancellation/)
    controller.abort(new Error('real cancellation'))
    await rejected
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})
