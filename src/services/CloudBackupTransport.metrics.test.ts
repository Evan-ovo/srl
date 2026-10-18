/** @vitest-environment node */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloudBackupTransport } from './CloudBackupTransport'
import { CloudBackupMetricsTracker } from './CloudBackupMetrics'
import { mapWithConcurrency } from './CloudBackupHttp'

class Probe extends CloudBackupTransport {
  metrics = new CloudBackupMetricsTracker()
  constructor() {
    super()
    this.transportState.activeMetrics = this.metrics
  }
  async send(blob: Blob): Promise<void> {
    const response = await this.cloudFetch(
      'https://uploads.github.com/test',
      { method: 'POST', body: blob },
      'github',
    )
    await response.text()
  }
  replaceMetrics(): CloudBackupMetricsTracker {
    const replacement = new CloudBackupMetricsTracker()
    this.transportState.activeMetrics = replacement
    return replacement
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('cloud accepted upload metrics', () => {
  it('does not count a whole file before the response arrives', async () => {
    let resolve: (response: Response) => void = () => undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((done) => (resolve = done))),
    )
    const transport = new Probe()
    const body = new Blob(['actual accepted data'])
    const operation = transport.send(body)
    expect(transport.metrics.snapshot().uploadedBytes).toBe(0)
    resolve(new Response('accepted', { status: 201, headers: { 'x-srl-cloud-proxy': '1' } }))
    await operation
    expect(transport.metrics.snapshot().uploadedBytes).toBe(body.size)
  })

  it('does not add a rejected or failed attempt to accepted upload bytes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('rejected', {
            status: 503,
            headers: { 'x-srl-cloud-proxy': '1' },
          }),
      ),
    )
    const transport = new Probe()
    await transport.send(new Blob(['data']))
    expect(transport.metrics.snapshot().uploadedBytes).toBe(0)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      }),
    )
    await expect(transport.send(new Blob(['data']))).rejects.toThrow('offline')
    expect(transport.metrics.snapshot().uploadedBytes).toBe(0)
    expect(transport.metrics.snapshot().httpRequestCount).toBe(2)
  })

  it('keeps late request accounting attached to its original metrics owner', async () => {
    let resolve: (response: Response) => void = () => undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((done) => (resolve = done))),
    )
    const transport = new Probe()
    const body = new Blob(['data'])
    const operation = transport.send(body)
    const next = transport.replaceMetrics()
    resolve(new Response('accepted', { headers: { 'x-srl-cloud-proxy': '1' } }))
    await operation
    expect(transport.metrics.snapshot().uploadedBytes).toBe(body.size)
    expect(next.snapshot().uploadedBytes).toBe(0)
    expect(next.snapshot().networkMs).toBe(0)
  })
})

describe('bounded cloud worker failure lifecycle', () => {
  it('stops scheduling new objects on failure and waits for already started workers', async () => {
    let release: () => void = () => undefined
    const pending = new Promise<void>((resolve) => (release = resolve))
    const seen: number[] = []
    let settled = false
    const operation = mapWithConcurrency([1, 2, 3, 4], 2, async (item) => {
      seen.push(item)
      if (item === 1) throw new Error('first failure')
      await pending
    })
    const caught = operation.catch((error: unknown) => {
      settled = true
      return error
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(seen).toEqual([1, 2])
    expect(settled).toBe(false)
    release()
    expect(await caught).toEqual(new Error('first failure'))
    expect(seen).toEqual([1, 2])
  })

  it('handles falsy rejection reasons and still drains only the active batch', async () => {
    const seen: number[] = []
    await expect(
      mapWithConcurrency([1, 2, 3], 1, async (item) => {
        seen.push(item)
        throw null
      }),
    ).rejects.toBeNull()
    expect(seen).toEqual([1])
    await expect(mapWithConcurrency([], 3, async () => undefined)).resolves.toBeUndefined()
  })
})
