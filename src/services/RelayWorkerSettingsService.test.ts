/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CloudBackupTransport } from './CloudBackupTransport'
import { TavernBridgeService } from './TavernBridgeService'
import {
  acquireRelayWorkerTarget,
  checkRelayWorker,
  getDeviceRelayStatus,
  loadRelayWorkerBaseUrl,
  normalizeRelayWorkerBaseUrl,
  relayWorkerEndpoint,
  resolveRelayWorkerTarget,
  saveRelayWorkerBaseUrl,
} from './RelayWorkerSettingsService'

const key = 'srl.publicWorker.baseUrl.v1'
const healthyWorker = (url: unknown) =>
  new Response(
    JSON.stringify({
      ok: true,
      service: String(url).endsWith('/api/bridge/health')
        ? 'srl-bridge-cloudflare'
        : 'srl-koofr-worker',
    }),
  )
async function verifyWorker() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => healthyWorker(url)),
  )
  await checkRelayWorker('https://worker.example')
}
beforeEach(() => localStorage.clear())
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('optional relay target', () => {
  it('requires a configured Public worker and persists it through the existing settings owner', () => {
    expect(resolveRelayWorkerTarget().origin).toBe('')
    expect(resolveRelayWorkerTarget().custom).toBe(false)
    expect(() => acquireRelayWorkerTarget()).toThrow('配置自己的 SRL Worker')
    saveRelayWorkerBaseUrl(' worker.example/ ')
    expect(loadRelayWorkerBaseUrl()).toBe('https://worker.example')
    expect(localStorage.getItem(key)).toBe('https://worker.example')
    expect(relayWorkerEndpoint('/api/bridge/join').href).toBe(
      'https://worker.example/api/bridge/join',
    )
    saveRelayWorkerBaseUrl('')
    expect(resolveRelayWorkerTarget().custom).toBe(false)
  })
  it.each([
    'http://worker.example',
    'https://user:secret@worker.example',
    'https://worker.example/api',
    'https://worker.example?q=1',
    'https://worker.example/#x',
  ])('rejects unsafe configuration %s without replacing the current target', (value) => {
    saveRelayWorkerBaseUrl('https://worker.example')
    expect(() => saveRelayWorkerBaseUrl(value)).toThrow()
    expect(loadRelayWorkerBaseUrl()).toBe('https://worker.example')
  })
  it('does not turn a corrupted or unreadable saved address into an official request', () => {
    localStorage.setItem(key, 'https://worker.example/private')
    expect(() => resolveRelayWorkerTarget()).toThrow('不能包含')
    expect(() => acquireRelayWorkerTarget()).toThrow()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage denied')
    })
    expect(() => resolveRelayWorkerTarget()).toThrow('storage denied')
  })
  it('blocks target changes during work and releases the guard exactly once', () => {
    saveRelayWorkerBaseUrl('https://worker.example')
    const lease = acquireRelayWorkerTarget()
    try {
      expect(() => saveRelayWorkerBaseUrl('')).toThrow('先断开')
      expect(() => relayWorkerEndpoint('//other.example/api', lease.target)).toThrow()
    } finally {
      lease.release()
      lease.release()
    }
    expect(saveRelayWorkerBaseUrl('')).toBe('')
    expect(normalizeRelayWorkerBaseUrl('http://127.0.0.1:5190/')).toBe('http://127.0.0.1:5190')
  })
  it('checks the selected endpoint without cookies or redirects and does not save an unverified draft', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL, _options?: RequestInit) =>
      healthyWorker(url),
    )
    vi.stubGlobal('fetch', fetcher)
    await checkRelayWorker('https://worker.example')
    expect(String(fetcher.mock.calls[0]![0])).toBe('https://worker.example/api/cloud/health')
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ credentials: 'omit', redirect: 'error' })
    expect(loadRelayWorkerBaseUrl()).toBe('')
    expect(getDeviceRelayStatus().enabled).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(String(fetcher.mock.calls[1]![0])).toBe('https://worker.example/api/bridge/health')
    saveRelayWorkerBaseUrl('https://worker.example')
    expect(getDeviceRelayStatus().enabled).toBe(true)
  })
  it('rejects a relay response pointing elsewhere before a participant token can be forwarded', async () => {
    saveRelayWorkerBaseUrl('https://worker.example')
    await verifyWorker()
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          pairCode: '123456',
          participantToken: 'private-participant',
          relayBase: 'https://other.example/api/bridge/',
        }),
      ),
    )
    vi.stubGlobal('fetch', fetcher)
    const service = new TavernBridgeService()
    try {
      await expect(service.joinSecureRelay('AB23CD45')).rejects.toThrow('不一致')
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(String(fetcher.mock.calls[0]![0])).toBe('https://worker.example/api/bridge/join')
      expect(saveRelayWorkerBaseUrl('')).toBe('')
    } finally {
      service.destroy()
    }
  })
  it('does not reconnect after a cancelled join returns late', async () => {
    saveRelayWorkerBaseUrl('https://worker.example')
    await verifyWorker()
    let finish!: (r: Response) => void
    const fetcher = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    )
    vi.stubGlobal('fetch', fetcher)
    const service = new TavernBridgeService()
    const joining = service.joinSecureRelay('AB23CD45')
    const failed = expect(joining).rejects.toThrow()
    service.disconnect()
    finish(
      new Response(
        JSON.stringify({
          pairCode: '123456',
          participantToken: 'private-participant',
          relayBase: '/api/bridge/',
        }),
      ),
    )
    await failed
    expect(service.getState().status).toBe('idle')
    expect(fetcher).toHaveBeenCalledOnce()
    expect(saveRelayWorkerBaseUrl('')).toBe('')
    service.destroy()
  })
  it('joins the selected relay and holds its target until disconnect', async () => {
    saveRelayWorkerBaseUrl('https://worker.example')
    await verifyWorker()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            pairCode: '123456',
            participantToken: 'private-participant',
            relayBase: 'https://worker.example/api/bridge/',
            reliableDelivery: true,
          }),
        ),
      ),
    )
    const service = new TavernBridgeService()
    const connect = vi
      .spyOn(
        service as unknown as { connectHttpRelay: (...args: unknown[]) => void },
        'connectHttpRelay',
      )
      .mockImplementation(() => {})
    try {
      await service.joinSecureRelay('AB23CD45')
      expect(connect).toHaveBeenCalledWith(
        'https://worker.example/api/bridge/',
        'AB23CD45',
        'private-participant',
        '123456',
        'https://worker.example',
        true,
      )
      expect(() => saveRelayWorkerBaseUrl('')).toThrow('先断开')
      service.disconnect()
      expect(saveRelayWorkerBaseUrl('')).toBe('')
    } finally {
      service.destroy()
    }
  })
})

describe('self-hosted device code access', () => {
  it('blocks default and unchecked custom targets before any join request', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const service = new TavernBridgeService()
    try {
      await expect(service.joinSecureRelay('AB23CD45')).rejects.toThrow(
        '中继码功能已停用，请自部署worker',
      )
      saveRelayWorkerBaseUrl('https://worker.example')
      await expect(service.joinSecureRelay('AB23CD45')).rejects.toThrow('检测通过')
      expect(fetcher).not.toHaveBeenCalled()
    } finally {
      service.destroy()
    }
  })

  it('invalidates a successful check on address change, clearing, and failed recheck', async () => {
    saveRelayWorkerBaseUrl('https://worker.example')
    await verifyWorker()
    expect(getDeviceRelayStatus().enabled).toBe(true)
    saveRelayWorkerBaseUrl('https://other.example')
    expect(getDeviceRelayStatus().enabled).toBe(false)
    saveRelayWorkerBaseUrl('https://worker.example')
    expect(getDeviceRelayStatus().enabled).toBe(false)
    await verifyWorker()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await expect(checkRelayWorker('https://worker.example')).rejects.toThrow('offline')
    expect(getDeviceRelayStatus().enabled).toBe(false)
    await verifyWorker()
    saveRelayWorkerBaseUrl('')
    expect(getDeviceRelayStatus().enabled).toBe(false)
  })

  it.each([false, 'missing', 'invalid'])(
    'does not enable a Worker with an unavailable bridge interface: %s',
    async (state) => {
      saveRelayWorkerBaseUrl('https://worker.example')
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url) =>
          String(url).endsWith('/api/bridge/health')
            ? new Response(
                JSON.stringify({
                  ok: true,
                  service: state === 'invalid' ? 'other-service' : 'srl-bridge-cloudflare',
                  deviceCodeEnabled: state,
                }),
                { status: state === 'missing' ? 404 : 200 },
              )
            : healthyWorker(url),
        ),
      )
      await expect(checkRelayWorker('https://worker.example')).rejects.toThrow()
      expect(getDeviceRelayStatus().enabled).toBe(false)
    },
  )

  it('rejects cancelled and stale successful checks', async () => {
    saveRelayWorkerBaseUrl('https://worker.example')
    let finish!: (response: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) =>
        String(url).endsWith('/api/bridge/health')
          ? new Promise<Response>((resolve) => {
              finish = resolve
            })
          : healthyWorker(url),
      ),
    )
    const abort = new AbortController()
    const checking = checkRelayWorker('https://worker.example', abort.signal)
    const failed = expect(checking).rejects.toThrow()
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    abort.abort()
    finish(healthyWorker('https://worker.example/api/bridge/health'))
    await failed
    expect(getDeviceRelayStatus().enabled).toBe(false)
    const stale = checkRelayWorker('https://worker.example')
    const staleFailure = expect(stale).rejects.toThrow('变化')
    const previous = finish
    await vi.waitFor(() => expect(finish).not.toBe(previous))
    saveRelayWorkerBaseUrl('https://other.example')
    finish(healthyWorker('https://worker.example/api/bridge/health'))
    await staleFailure
    expect(getDeviceRelayStatus().enabled).toBe(false)
  })
})

class CloudRelayProbe extends CloudBackupTransport {
  run(action: () => Promise<void>) {
    return this.withRelayWorkerTarget('webdav', action)
  }
  request() {
    return this.cloudFetch(
      'https://app.koofr.net/dav/Koofr/backup',
      { headers: { Authorization: 'Basic test-fixture' } },
      'webdav',
    )
  }
}
it('pins every cloud request to the original target, keeps Koofr authorization, and never retries official on failure', async () => {
  saveRelayWorkerBaseUrl('https://worker.example')
  const fetcher = vi
    .fn()
    .mockImplementation(async () => new Response('', { headers: { 'x-srl-cloud-proxy': '1' } }))
  vi.stubGlobal('fetch', fetcher)
  const probe = new CloudRelayProbe()
  await probe.run(async () => {
    await probe.request()
    expect(() => saveRelayWorkerBaseUrl('')).toThrow()
    // Simulate another tab editing its own local setting during a multi-request job.
    localStorage.setItem(key, 'https://other.example')
    await probe.request()
  })
  expect(
    fetcher.mock.calls.every(([url]) => String(url).startsWith('https://worker.example/')),
  ).toBe(true)
  expect(new Headers(fetcher.mock.calls[0]![1].headers).get('Authorization')).toBe(
    'Basic test-fixture',
  )
  expect(fetcher.mock.calls[0]![1]).toMatchObject({ credentials: 'omit', redirect: 'error' })
  saveRelayWorkerBaseUrl('https://worker.example')
  fetcher.mockReset().mockRejectedValue(new TypeError('custom offline'))
  await expect(
    probe.run(async () => {
      await probe.request()
    }),
  ).rejects.toThrow('自建中继')
  expect(fetcher).toHaveBeenCalledOnce()
  expect(String(fetcher.mock.calls[0]![0])).toContain('https://worker.example/')
  expect(saveRelayWorkerBaseUrl('')).toBe('')
})
