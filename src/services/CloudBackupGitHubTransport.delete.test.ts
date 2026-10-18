/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { githubFetch } from './CloudBackupGitHubTransport'
import { CloudBackupTransport } from './CloudBackupTransport'
import type { CloudBackupTransportContext } from './CloudBackupTransportContext'
import type { GitHubBackupConfig } from '../types/CloudBackup'
import { CloudBackupMetricsTracker } from './CloudBackupMetrics'
import { CloudRequestTimeoutError } from './CloudBackupHttp'

const config: GitHubBackupConfig = {
  provider: 'github',
  owner: 'example',
  repository: 'backups',
  retention: 2,
  autoBackup: false,
}
const path = '/releases/assets/42'
const absent = () => Response.json({ message: 'Not Found' }, { status: 404 })

function fixture() {
  const assets = new Map([[42, { id: 42 }]])
  const cloudFetch = vi.fn<CloudBackupTransportContext['cloudFetch']>()
  const context = {
    cloudFetch,
    activeMetrics: new CloudBackupMetricsTracker(),
    activeGitHubInventory: {
      key: 'example/backups',
      assets: new Map([[1, assets]]),
      releases: new Map(),
    },
  } as unknown as CloudBackupTransportContext
  return { context, cloudFetch, assets }
}

describe('GitHub asset deletion receipts', () => {
  it('confirms a real socket disconnect after the local server has deleted the asset', async () => {
    const requests: string[] = []
    let deleted = false
    const server = createServer((request, response) => {
      const target = new URL(new URL(request.url!, 'http://127.0.0.1').searchParams.get('url')!)
      requests.push(`${request.method} ${target.pathname}`)
      if (request.method === 'DELETE') {
        deleted = true
        response.destroy()
        return
      }
      response.setHeader('x-srl-cloud-proxy', '1')
      response.setHeader('content-type', 'application/json')
      response.statusCode = target.pathname.endsWith(path) && deleted ? 404 : 200
      response.end(
        JSON.stringify(response.statusCode === 404 ? { message: 'Not Found' } : { private: true }),
      )
    })
    await new Promise<void>((resolve, reject) =>
      server.once('error', reject).listen(0, '127.0.0.1', resolve),
    )
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing local server address')
    const originalFetch = globalThis.fetch
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      const requested = new URL(url, `http://127.0.0.1:${address.port}`)
      const upstream = new URL(requested.searchParams.get('url') ?? requested.toString())
      if (upstream.hostname !== 'api.github.com') throw new Error('Unexpected GitHub fixture target')
      const local = new URL('/github-fixture', `http://127.0.0.1:${address.port}`)
      local.searchParams.set('url', upstream.toString())
      return originalFetch(local, init)
    })
    class NetworkProbe extends CloudBackupTransport {
      deleteAsset() {
        return this.githubFetch(config, 'local-only-token', path, { method: 'DELETE' })
      }
    }
    try {
      await expect(new NetworkProbe().deleteAsset()).resolves.toMatchObject({ status: 204 })
      expect(deleted).toBe(true)
      expect(requests).toEqual([
        `DELETE /repos/example/backups${path}`,
        `GET /repos/example/backups${path}`,
        'GET /repos/example/backups/releases',
      ])
    } finally {
      vi.unstubAllGlobals()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('keeps successful deletion to one request', async () => {
    const { context, cloudFetch, assets } = fixture()
    cloudFetch.mockResolvedValueOnce(new Response(null, { status: 204 }))
    expect(
      (await githubFetch(context, config, 'test-token', path, { method: 'DELETE' })).status,
    ).toBe(204)
    expect(cloudFetch).toHaveBeenCalledOnce()
    expect(assets.has(42)).toBe(false)
  })

  it.each(['network', 'server', 'already-absent'])(
    'confirms deletion after a %s receipt without repeating DELETE',
    async (mode) => {
      const { context, cloudFetch, assets } = fixture()
      if (mode === 'network') cloudFetch.mockRejectedValueOnce(new TypeError('fetch failed'))
      else
        cloudFetch.mockResolvedValueOnce(
          mode === 'server' ? new Response(null, { status: 502 }) : absent(),
        )
      cloudFetch
        .mockResolvedValueOnce(absent())
        .mockResolvedValueOnce(Response.json({ private: true }))
      expect(
        (await githubFetch(context, config, 'test-token', path, { method: 'DELETE' })).status,
      ).toBe(204)
      expect(
        cloudFetch.mock.calls.map(([url, init]) => [new URL(url).pathname, init.method ?? 'GET']),
      ).toEqual([
        ['/repos/example/backups' + path, 'DELETE'],
        ['/repos/example/backups' + path, 'GET'],
        ['/repos/example/backups/releases', 'GET'],
      ])
      expect(assets.has(42)).toBe(false)
    },
  )

  it('reports a still-present file and keeps its inventory entry', async () => {
    const { context, cloudFetch, assets } = fixture()
    cloudFetch
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(Response.json({ id: 42 }))
    await expect(
      githubFetch(context, config, 'test-token', path, { method: 'DELETE' }),
    ).rejects.toThrow('远端文件仍然存在')
    expect(cloudFetch).toHaveBeenCalledTimes(2)
    expect(assets.has(42)).toBe(true)
  })

  it.each([401, 403, 404, 500])(
    'does not mistake lost release read access (%i) for successful deletion',
    async (status) => {
      const { context, cloudFetch, assets } = fixture()
      cloudFetch
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(absent())
        .mockResolvedValueOnce(Response.json({ message: 'Unavailable' }, { status }))
      await expect(
        githubFetch(context, config, 'test-token', path, { method: 'DELETE' }),
      ).rejects.toThrow('删除结果尚未确认')
      expect(assets.has(42)).toBe(true)
      expect(cloudFetch).toHaveBeenCalledTimes(3)
    },
  )

  it('does not treat a failed verification request as proof of deletion', async () => {
    const { context, cloudFetch } = fixture()
    cloudFetch
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('still offline'))
    await expect(
      githubFetch(context, config, 'test-token', path, { method: 'DELETE' }),
    ).rejects.toThrow('删除结果尚未确认')
    expect(cloudFetch).toHaveBeenCalledTimes(2)
  })

  it.each([401, 403, 429])(
    'keeps explicit HTTP %i failures without verification traffic',
    async (status) => {
      const { context, cloudFetch } = fixture()
      cloudFetch.mockResolvedValueOnce(Response.json({ message: 'Rejected' }, { status }))
      await expect(
        githubFetch(context, config, 'test-token', path, { method: 'DELETE' }),
      ).rejects.toMatchObject({ status })
      expect(cloudFetch).toHaveBeenCalledOnce()
    },
  )

  it('preserves caller cancellation without verification traffic', async () => {
    const { context, cloudFetch } = fixture()
    const controller = new AbortController()
    const reason = new DOMException('Stopped', 'AbortError')
    cloudFetch.mockImplementationOnce(async () => {
      controller.abort(reason)
      throw reason
    })
    await expect(
      githubFetch(context, config, 'test-token', path, {
        method: 'DELETE',
        signal: controller.signal,
      }),
    ).rejects.toBe(reason)
    expect(cloudFetch).toHaveBeenCalledOnce()
  })

  it('keeps website login failures distinct from repository token failures', async () => {
    const { context, cloudFetch } = fixture()
    cloudFetch.mockResolvedValueOnce(
      Response.json(
        { code: 'UNAUTHENTICATED' },
        { status: 401, headers: { 'x-srl-cloud-proxy': '1' } },
      ),
    )
    await expect(
      githubFetch(context, config, 'test-token', path, { method: 'DELETE' }),
    ).rejects.toMatchObject({
      code: 'SITE_UNAUTHENTICATED',
      message: expect.stringContaining('需要登录当前资源库网站'),
    })
    expect(cloudFetch).toHaveBeenCalledOnce()
  })

  it('verifies a timed-out deletion once without a write retry', async () => {
    const { context, cloudFetch } = fixture()
    cloudFetch
      .mockRejectedValueOnce(new CloudRequestTimeoutError(45000))
      .mockResolvedValueOnce(absent())
      .mockResolvedValueOnce(Response.json({ private: true }))
    await expect(
      githubFetch(context, config, 'test-token', path, { method: 'DELETE' }),
    ).resolves.toMatchObject({ status: 204 })
    expect(cloudFetch.mock.calls.filter(([, init]) => init.method === 'DELETE')).toHaveLength(1)
  })
})
