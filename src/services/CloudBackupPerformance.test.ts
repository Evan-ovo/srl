/** @vitest-environment node */
import { IDBFactory } from 'fake-indexeddb'
import { JSDOM } from 'jsdom'
import type { CreatedStructuredSnapshot } from './CloudStructuredSnapshot'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloudBackupTransport } from './CloudBackupTransport'
import { hashCloudBlob } from './CloudArchiveCodec'
import { CloudBackupMetricsTracker } from './CloudBackupMetrics'
import type { GitHubBackupConfig } from '../types/CloudBackup'
import type { GitHubBundleManifest } from './GitHubBackupBundle'
import { listRetentionBackups, prune } from './CloudBackupRetentionOperations'
import type { CloudBackupSnapshotOperationsContext } from './CloudBackupSnapshotOperations'
import type { CloudBackupConfig } from '../types/CloudBackup'
import { listWebDav } from './CloudBackupWebDavTransport'
import type { CloudBackupTransportContext } from './CloudBackupTransportContext'

const config: GitHubBackupConfig = {
  provider: 'github',
  owner: 'owner',
  repository: 'backups',
  autoBackup: false,
  retention: 7,
}
const proxyJson = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'x-srl-cloud-proxy': '1' } })
const proxyResponse = (body: BodyInit | null, init?: ResponseInit) => {
  const headers = new Headers(init?.headers)
  headers.set('x-srl-cloud-proxy', '1')
  return new Response(body, { ...init, headers })
}
const upstreamUrl = (target: string | URL) => {
  const requestUrl = new URL(String(target), 'https://srl.example')
  return new URL(requestUrl.searchParams.get('url') ?? requestUrl.toString())
}
class Probe extends CloudBackupTransport {
  constructor() {
    super()
    this.transportState.activeMetrics = new CloudBackupMetricsTracker()
  }
  upload(snapshot: CreatedStructuredSnapshot) {
    return this.uploadGitHubStructuredBackup(config, 'fixture', snapshot)
  }
  listDav() {
    return this.listWebDavObjects(
      {
        provider: 'webdav',
        baseUrl: 'https://app.koofr.net/dav/Koofr',
        folder: 'backups',
        username: 'fixture',
        retention: 7,
        autoBackup: false,
      },
      'fixture',
    )
  }
  listContainers() {
    return this.listGitHubObjectContainers(config, 'fixture')
  }
  listDavBackups(progress?: (message: string) => void) {
    return this.listWebDav(
      {
        provider: 'webdav',
        baseUrl: 'https://app.koofr.net/dav/Koofr',
        folder: 'backups',
        username: 'fixture',
        retention: 7,
        autoBackup: false,
      },
      'fixture',
      progress,
    )
  }
  listAssets(id: number, target = config) {
    return this.listGitHubAssets(target, 'fixture', id)
  }
  partInventory(parts: GitHubBundleManifest['parts']) {
    return this.readGitHubPartInventory(config, 'fixture', parts)
  }
  confirm() {
    return this.confirmGitHubAssetSize(
      config,
      'fixture',
      {
        id: 1,
        name: 'manifest',
        size: 10,
        digest: `sha256:${'a'.repeat(64)}`,
        state: 'uploaded',
        url: '',
        created_at: '',
      },
      10,
      'a'.repeat(64),
    )
  }
  remove(id: number) {
    return this.githubFetch(config, 'fixture', `/releases/assets/${id}`, { method: 'DELETE' })
  }
}
afterEach(() => vi.unstubAllGlobals())
describe('Koofr list failures', () => {
  const target: CloudBackupConfig = {
    provider: 'webdav',
    baseUrl: 'https://dav.example.com',
    folder: 'backups',
    username: 'fixture',
    retention: 7,
    autoBackup: false,
  }
  const objects = ['one', 'two'].map((id) => ({
    objectKey: `snapshots/${id}.srlmanifest.v3.json.gz`,
    size: 10,
    createdAt: 1,
  }))
  it('reads real gzip manifests through the transport and reports download and decode stages', async () => {
    const dom = new JSDOM('')
    vi.stubGlobal('DOMParser', dom.window.DOMParser)
    vi.stubGlobal('window', { Capacitor: { isNativePlatform: () => true } })
    const { encodeStructuredSnapshot } = await import('./CloudStructuredSnapshot')
    const blob = await encodeStructuredSnapshot({
      format: 'srl-structured-cloud-snapshot',
      version: 3,
      createdAt: '2026-10-08T00:00:00.000Z',
      resources: [],
      versions: [],
      categories: [],
      portableData: { version: 1 },
    })
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PROPFIND') {
        const isSnapshots = _url.endsWith('/snapshots')
        return new Response(
          '<d:multistatus xmlns:d="DAV:">' +
            (isSnapshots
              ? objects
                  .map(
                    ({ objectKey }) =>
                      `<d:response><d:href>/${objectKey}</d:href>` +
                      `<d:propstat><d:prop><d:getcontentlength>${blob.size}</d:getcontentlength></d:prop>` +
                      '</d:propstat></d:response>',
                  )
                  .join('')
              : '') +
            '</d:multistatus>',
          { status: 207 },
        )
      }
      return new Response(blob, { headers: { 'Content-Type': 'application/gzip' } })
    })
    vi.stubGlobal('fetch', fetch)
    const progress = vi.fn()
    try {
      expect(await new Probe().listDavBackups(progress)).toHaveLength(2)
      expect(fetch).toHaveBeenCalledTimes(5)
      expect(progress).toHaveBeenCalledWith(expect.stringContaining('正在下载快照清单'))
      expect(progress).toHaveBeenCalledWith(expect.stringContaining('正在解压并解析快照清单'))
      expect(progress).toHaveBeenLastCalledWith('正在校验云端快照 2 / 2…')
    } finally {
      dom.window.close()
    }
  })
  it('ends a stalled gzip manifest read on the metadata idle deadline and allows a fresh read', async () => {
    vi.useFakeTimers()
    const dom = new JSDOM('')
    vi.stubGlobal('DOMParser', dom.window.DOMParser)
    vi.stubGlobal('window', { Capacitor: { isNativePlatform: () => true } })
    let stalled = true
    const getSignals: Array<AbortSignal | null | undefined> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'PROPFIND')
          return new Response(
            '<d:multistatus xmlns:d="DAV:">' +
              (url.endsWith('/snapshots')
                ? `<d:response><d:href>/${objects[0]!.objectKey}</d:href>` +
                  '<d:propstat><d:prop><d:getcontentlength>10</d:getcontentlength></d:prop>' +
                  '</d:propstat></d:response>'
                : '') +
              '</d:multistatus>',
            { status: 207 },
          )
        getSignals.push(init?.signal)
        return stalled
          ? new Response(new ReadableStream(), { headers: { 'Content-Type': 'application/gzip' } })
          : Response.json({
              format: 'srl-structured-cloud-snapshot',
              version: 3,
              createdAt: '2026-10-08T00:00:00.000Z',
              resources: [],
              versions: [],
              categories: [],
              portableData: { version: 1 },
            })
      }),
    )
    try {
      const probe = new Probe()
      const first = probe.listDavBackups().catch((error) => error)
      await vi.advanceTimersByTimeAsync(0)
      expect(getSignals).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(45_000)
      expect(await first).toMatchObject({ name: 'CloudRequestTimeoutError' })
      expect(getSignals[0]?.aborted).toBe(true)
      stalled = false
      expect(await probe.listDavBackups()).toHaveLength(1)
    } finally {
      vi.useRealTimers()
      dom.window.close()
    }
  })
  it.each([
    new TypeError('Failed to fetch'),
    Object.assign(new Error('Koofr HTTP 401'), { status: 401 }),
    new Error('对象级云备份清单 JSON 无效'),
  ])('never reports an empty remote list after manifest read failure: %s', async (error) => {
    const context = {
      listWebDavObjects: vi.fn(async () => objects),
      readWebDavStructuredSnapshot: vi.fn(async () => {
        throw error
      }),
    } as unknown as CloudBackupTransportContext
    await expect(listWebDav(context, target, 'fixture')).rejects.toThrow()
  })
  it('retains a valid snapshot and reports the other failed manifest explicitly', async () => {
    const context = {
      listWebDavObjects: vi.fn(async () => objects),
      readWebDavStructuredSnapshot: vi.fn(async (_config, _secret, key) => {
        if (key === objects[1]!.objectKey) throw new Error('对象级云备份清单 JSON 无效')
        return { resources: [], versions: [], createdAt: '', portableData: { version: 1 } }
      }),
    } as unknown as CloudBackupTransportContext
    const warnings = vi.fn()
    expect(await listWebDav(context, target, 'fixture', undefined, warnings)).toMatchObject([
      { objectKey: objects[0]!.objectKey },
    ])
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining(objects[1]!.objectKey))
  })
})
describe('cloud inventory reuse', () => {
  it('finds sorted object containers from one release-list request, including gaps', async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL) =>
      proxyJson([
        { id: 3, tag_name: 'srl-cloud-objects-0003', assets: [] },
        { id: 9, tag_name: 'unrelated', assets: [] },
        { id: 1, tag_name: 'srl-cloud-objects-0001', assets: [] },
      ]),
    )
    vi.stubGlobal('fetch', fetch)
    expect((await new Probe().listContainers()).map((item) => item.id)).toEqual([1, 3])
    expect(fetch).toHaveBeenCalledOnce()
    expect(upstreamUrl(String(fetch.mock.calls[0]?.[0])).pathname).toContain('/releases')
    expect(upstreamUrl(String(fetch.mock.calls[0]?.[0])).search).toBe('?per_page=10&page=1')
  })
  it('keeps several container inventories, updates deletions and invalidates a different destination', async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'DELETE'
        ? proxyResponse(null, { status: 204 })
        : proxyJson([{ id: 1, name: 'object', size: 10, url: '', created_at: '' }]),
    )
    vi.stubGlobal('fetch', fetch)
    const probe = new Probe()
    await probe.listAssets(1)
    await probe.listAssets(2)
    await probe.listAssets(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    await probe.remove(1)
    expect(await probe.listAssets(1)).toEqual([])
    expect(await probe.listAssets(2)).toEqual([])
    expect(fetch).toHaveBeenCalledTimes(3)
    await probe.listAssets(1, { ...config, repository: 'another' })
    expect(fetch).toHaveBeenCalledTimes(4)
  })
  it('accepts a complete upload response without a redundant manifest GET', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('extra request')
    })
    vi.stubGlobal('fetch', fetch)
    expect(await new Probe().confirm()).toMatchObject({ id: 1, size: 10 })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('retention waits and deletion boundaries', () => {
  it('deep GitHub maintenance reclaims only eligible unreferenced chunks from the scanned inventory', async () => {
    const sharedName = `srl-chunk--sha256-${'a'.repeat(64)}`
    const orphanName = `srl-chunk--sha256-${'b'.repeat(64)}`
    const tag = 'srl-cloud-objects-0001'
    const orphanIdentity = `${tag}\u0000${orphanName}`
    const fetch = vi.fn(async () => new Response(null, { status: 204 }))
    const clear = vi.fn(async () => undefined)
    const context = {
      listRetentionBackups: vi.fn(async () => [
        { id: 'kept', kind: 'githubSnapshot', objectKey: 'kept' },
      ]),
      readGitHubStructuredSnapshot: vi.fn(async () => ({
        portableData: { version: 1 },
        resources: [
          {
            object: {
              parts: [
                {
                  name: sharedName,
                  size: 1,
                  sha256: 'a'.repeat(64),
                  storage: { kind: 'github-release', container: tag, objectKey: sharedName },
                },
              ],
            },
          },
        ],
        versions: [],
      })),
      getGitHubRelease: vi.fn(async (_config, _secret, _create, target) =>
        target === tag ? { id: 20 } : undefined,
      ),
      listGitHubAssets: vi.fn(async () => [
        { id: 100, name: sharedName },
        { id: 101, name: orphanName },
        { id: 102, name: 'user-file.bin' },
      ]),
      githubFetch: fetch,
      transportState: {
        jobStore: {
          pendingOrphans: vi.fn(async () => []),
          eligibleOrphans: vi.fn(async (_scope, candidates: Set<string>) => {
            expect([...candidates]).toEqual([orphanIdentity])
            return [...candidates]
          }),
          clearOrphan: clear,
        },
      },
    } as unknown as CloudBackupSnapshotOperationsContext
    expect(await prune(context, config, 'fixture', undefined, true)).toBe(0)
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledWith(config, 'fixture', '/releases/assets/101', {
      method: 'DELETE',
    })
    expect(clear).toHaveBeenCalledWith('github:owner/backups', orphanIdentity)
  })
  const davConfig: CloudBackupConfig = {
    provider: 'webdav',
    baseUrl: 'https://dav.example.com',
    folder: 'backups',
    username: 'fixture',
    retention: 1,
    autoBackup: false,
  }
  it.each(['github', 'webdav'] as const)(
    '%s completes every expired-manifest deletion before reclaiming chunks and reports real progress',
    async (provider) => {
      const target = provider === 'github' ? { ...config, retention: 1 } : davConfig
      const backups = ['new', 'old-1', 'old-2', 'old-3', 'old-4'].map((id, index) => ({
        id,
        objectKey: `${id}.srlmanifest.v3.json.gz`,
        createdAt: 5 - index,
        size: 1,
        kind: provider === 'github' ? 'githubSnapshot' : 'webdavSnapshot',
      }))
      const snapshot: CreatedStructuredSnapshot['snapshot'] = {
        format: 'srl-structured-cloud-snapshot',
        version: 3,
        createdAt: '',
        resources: [],
        versions: [],
        categories: [],
        portableData: { version: 1 },
      }
      const chunks = ['a', 'b', 'c'].map((letter, index) => ({
        id: 100 + index,
        name: `srl-chunk--sha256-${letter.repeat(64)}`,
        size: 1,
        url: '',
        created_at: '',
      }))
      const pending = chunks.map(({ name }) =>
        provider === 'github' ? `srl-cloud-objects-0001\u0000${name}` : `objects/${name}`,
      )
      let release!: () => void
      const barrier = new Promise<void>((resolve) => (release = resolve))
      let active = 0
      let peak = 0
      let completedSnapshots = 0
      const deletedChunks: string[] = []
      const remove = async (identity: string): Promise<Response> => {
        if (identity.includes('old-')) {
          active += 1
          peak = Math.max(peak, active)
          await barrier
          active -= 1
          completedSnapshots += 1
        } else {
          expect(completedSnapshots).toBe(4)
          deletedChunks.push(identity)
        }
        return new Response(null, { status: 204 })
      }
      const clear = vi.fn(async () => undefined)
      const read = vi.fn(async () => snapshot)
      const context = {
        listRetentionBackups: vi.fn(async () => backups),
        readGitHubStructuredSnapshot: read,
        readWebDavStructuredSnapshot: read,
        githubFetch: vi.fn(async (_config, _secret, path) => remove(path)),
        deleteWebDavObject: vi.fn(async (_config, _secret, key) => {
          await remove(key)
        }),
        getGitHubRelease: vi.fn(async () => ({ id: 20 })),
        listGitHubAssets: vi.fn(async () => chunks),
        transportState: {
          jobStore: {
            pendingOrphans: vi.fn(async () => pending),
            eligibleOrphans: vi.fn(async () => pending),
            clearOrphan: clear,
          },
        },
      } as unknown as CloudBackupSnapshotOperationsContext
      const progress = vi.fn()
      const operation = prune(
        context,
        target,
        'fixture',
        backups[0]!.objectKey,
        false,
        snapshot,
        progress,
      )
      try {
        await vi.waitFor(() => expect(active).toBe(3))
        expect(deletedChunks).toHaveLength(0)
      } finally {
        release()
      }
      expect(await operation).toBe(4)
      expect(peak).toBe(3)
      expect(read).toHaveBeenCalledTimes(4)
      expect(deletedChunks).toHaveLength(3)
      expect(clear).toHaveBeenCalledTimes(3)
      expect(progress).toHaveBeenCalledWith('备份已提交成功；正在核对快照引用（5/5）…')
      expect(progress).toHaveBeenCalledWith('备份已提交成功；正在清理过期快照（4/4）…')
      expect(progress).toHaveBeenCalledWith('备份已提交成功；正在处理无引用内容对象（3/3）…')
      expect(progress).toHaveBeenLastCalledWith('备份已提交成功；旧快照维护完成。')
    },
  )
  it('reads legacy and snapshot asset lists concurrently', async () => {
    let release!: () => void
    const barrier = new Promise<void>((resolve) => (release = resolve))
    const listAssets = vi.fn(async () => {
      await barrier
      return []
    })
    const context = {
      getGitHubRelease: vi.fn(async (_config, _secret, _create, tag) => ({
        id: tag === 'srl-cloud-snapshots' ? 10 : 20,
      })),
      listGitHubAssets: listAssets,
    } as unknown as CloudBackupSnapshotOperationsContext
    const operation = listRetentionBackups(context, config, 'fixture')
    try {
      await vi.waitFor(() => expect(listAssets).toHaveBeenCalledTimes(2))
    } finally {
      release()
      await operation
    }
  })
  it.each(['github', 'webdav'] as const)(
    '%s drains in-flight snapshot deletions after an error and never starts chunk reclamation',
    async (provider) => {
      const target = provider === 'github' ? { ...config, retention: 1 } : davConfig
      const backups = ['new', 'old-1', 'old-2', 'old-3', 'old-4'].map((id, index) => ({
        id,
        objectKey: `${id}.srlmanifest.v3.json.gz`,
        createdAt: 5 - index,
        size: 1,
        kind: provider === 'github' ? 'githubSnapshot' : 'webdavSnapshot',
      }))
      const snapshot = {
        format: 'srl-structured-cloud-snapshot',
        version: 3,
        createdAt: '',
        resources: [],
        versions: [],
        categories: [],
        portableData: { version: 1 },
      }
      const eligible = vi.fn(async () => [])
      let release!: () => void
      const barrier = new Promise<void>((resolve) => (release = resolve))
      const deletions: string[] = []
      const remove = vi.fn(async (identity: string) => {
        deletions.push(identity)
        if (identity.includes('old-1')) throw new Error('fixture delete refused')
        await barrier
        return new Response(null, { status: 204 })
      })
      const context = {
        listRetentionBackups: vi.fn(async () => backups),
        readGitHubStructuredSnapshot: vi.fn(async () => snapshot),
        readWebDavStructuredSnapshot: vi.fn(async () => snapshot),
        githubFetch: vi.fn(async (_config, _secret, path) => remove(path)),
        deleteWebDavObject: vi.fn(async (_config, _secret, key) => remove(key)),
        transportState: {
          jobStore: {
            pendingOrphans: vi.fn(async () => ['srl-chunk--sha256-' + 'a'.repeat(64)]),
            eligibleOrphans: eligible,
          },
        },
      } as unknown as CloudBackupSnapshotOperationsContext
      const progress = vi.fn()
      let settled = false
      const operation = prune(
        context,
        target,
        'fixture',
        undefined,
        false,
        undefined,
        progress,
      ).then(
        () => {
          settled = true
          return undefined
        },
        (error) => {
          settled = true
          return error
        },
      )
      try {
        await vi.waitFor(() => expect(deletions).toHaveLength(3))
        expect(settled).toBe(false)
        expect(eligible).not.toHaveBeenCalled()
      } finally {
        release()
      }
      const failure = await operation
      expect(failure).toMatchObject({
        stage: 'snapshots',
        deletedSnapshots: 2,
        cause: { message: 'fixture delete refused' },
      })
      expect(failure.message).toContain('fixture delete refused')
      expect(deletions).toHaveLength(3)
      expect(eligible).not.toHaveBeenCalled()
      expect(progress).toHaveBeenCalledWith('正在核对快照引用（5/5）…')
      expect(progress).not.toHaveBeenCalledWith('旧快照维护完成。')
    },
  )
})

describe('bounded remote preparation', () => {
  it('checks distinct referenced containers concurrently without duplicate reads', async () => {
    let active = 0
    let peak = 0
    let release!: () => void
    const barrier = new Promise<void>((resolve) => (release = resolve))
    const fetch = vi.fn(async (target: string) => {
      active += 1
      peak = Math.max(peak, active)
      await barrier
      active -= 1
      const path = upstreamUrl(target).pathname
      if (path.includes('/tags/')) {
        return proxyJson({ id: Number(path.slice(-4)), tag_name: path.split('/').at(-1) })
      }
      const id = Number(/releases\/(\d+)/u.exec(path)![1])
      return proxyJson([{ id, name: `part-${id}`, size: 1, url: '', created_at: '' }])
    })
    vi.stubGlobal('fetch', fetch)
    const parts = [1, 2, 3, 4, 1].map((id) => ({
      name: `part-${id}`,
      size: 1,
      sha256: 'a'.repeat(64),
      storage: {
        kind: 'github-release' as const,
        container: `srl-cloud-objects-${String(id).padStart(4, '0')}`,
        objectKey: `part-${id}`,
      },
    }))
    const operation = new Probe().partInventory(parts)
    try {
      await vi.waitFor(() => expect(active).toBe(3))
    } finally {
      release()
      await operation
    }
    expect((await operation).size).toBe(4)
    expect(peak).toBe(3)
    expect(fetch).toHaveBeenCalledTimes(8)
  })
  it('lists object containers with pagination and loads asset inventories at most three at a time', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    const containers = Array.from({ length: 12 }, (_, index) => ({
      id: index + 1,
      tag_name: `srl-cloud-objects-${String(index + 1).padStart(4, '0')}`,
      assets: [],
    }))
    let active = 0
    let peak = 0
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const listingPages: number[] = []
    let uploadedManifest: Record<string, unknown> | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (target: string, init?: RequestInit) => {
        const url = upstreamUrl(target)
        if (url.pathname.endsWith('/releases/tags/srl-cloud-snapshots'))
          return proxyJson({ id: 100, tag_name: 'srl-cloud-snapshots', assets: [] })
        if (url.pathname.endsWith('/releases')) {
          const page = Number(url.searchParams.get('page'))
          listingPages.push(page)
          return proxyJson(containers.slice((page - 1) * 10, page * 10))
        }
        if (init?.method === 'POST') {
          const body = init.body as Blob
          uploadedManifest = {
            id: 1000,
            name: url.searchParams.get('name'),
            size: body.size,
            digest: `sha256:${await hashCloudBlob(body)}`,
            state: 'uploaded',
            created_at: new Date().toISOString(),
          }
          return proxyJson(uploadedManifest)
        }
        active += 1
        peak = Math.max(peak, active)
        await barrier
        active -= 1
        return proxyJson([])
      }),
    )
    const snapshot: CreatedStructuredSnapshot = {
      snapshot: {
        format: 'srl-structured-cloud-snapshot',
        version: 3,
        createdAt: new Date().toISOString(),
        resources: [],
        versions: [],
        categories: [],
        portableData: { version: 1 },
      },
      chunks: new Map(),
      nativeSources: new Map(),
      objectPlans: [],
      totalSize: 0,
      partCount: 0,
      localReadBytes: 0,
      descriptorUpdates: [],
    }
    const operation = new Probe().upload(snapshot)
    await vi.waitFor(() => expect(active).toBe(3))
    release()
    await operation
    expect(peak).toBe(3)
    expect(listingPages).toEqual([1, 2])
  })
  it('enumerates Koofr directories concurrently and reuses the same-operation inventory', async () => {
    const dom = new JSDOM('')
    vi.stubGlobal('DOMParser', dom.window.DOMParser)
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    let active = 0
    const fetch = vi.fn(async () => {
      active += 1
      await barrier
      active -= 1
      return new Response(
        '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/object.bin</d:href><d:propstat><d:prop><d:getcontentlength>4</d:getcontentlength></d:prop></d:propstat></d:response></d:multistatus>',
        { status: 207, headers: { 'x-srl-cloud-proxy': '1' } },
      )
    })
    vi.stubGlobal('fetch', fetch)
    try {
      const probe = new Probe()
      const operation = probe.listDav()
      await vi.waitFor(() => expect(active).toBe(3))
      release()
      const result = await operation
      expect(result.map((entry) => entry.objectKey)).toEqual([
        'object.bin',
        'objects/object.bin',
        'snapshots/object.bin',
      ])
      expect(await probe.listDav()).toEqual(result)
      expect(fetch).toHaveBeenCalledTimes(3)
    } finally {
      dom.window.close()
    }
  })
})
