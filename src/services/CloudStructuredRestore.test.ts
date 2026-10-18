import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { AppDatabase } from '../database/AppDatabase'
import { IndexedDbArchiveStorage } from '../storage/IndexedDbArchiveStorage'
import { RESOURCE_TYPE, type Resource } from '../types/Resource'
import { isEncryptedResource, isEncryptedResourceSummary } from '../types/Vault'
import { RestoreService } from './RestoreService'
import { CommunitySourceRestoreService } from './CommunitySourceRestoreService'
import { MemoryRestoreStagingStore } from '../storage/RestoreStagingStore'
import { VaultService } from './VaultService'
import { createStructuredSnapshot } from './CloudStructuredSnapshot'
import { hashCloudBlob } from './CloudArchiveCodec'
import * as cloudCodec from './CloudArchiveCodec'
import {
  createGitHubObjectReader,
  listGitHub,
  readGitHubStructuredSnapshot,
  uploadGitHubStructuredBackup,
  confirmGitHubAssetSize,
} from './CloudBackupGitHubTransport'
import { createWebDavObjectReader } from './CloudBackupWebDavTransport'
import type { CloudBackupTransportContext, GitHubAsset } from './CloudBackupTransportContext'
import type { GitHubBundleManifest } from './GitHubBackupBundle'
import { CHAT_READER_APP_ID } from '../core/ChatReaderIdentity'
import { structuredPartIdentity } from './CloudBackupPolicy'
import { friendlyNetworkError, githubError } from './CloudBackupHttp'

async function resource(id: string): Promise<Resource> {
  const blob = new Blob([
    JSON.stringify({ spec: 'chara_card_v2', data: { name: id, description: id.repeat(1000) } }),
  ])
  return {
    id,
    type: RESOURCE_TYPE.CHARACTER_CARD,
    name: id,
    description: '',
    fileName: `${id}.json`,
    mimeType: 'application/json',
    fileSize: blob.size,
    contentHash: await hashCloudBlob(blob),
    favorite: false,
    categoryId: null,
    tags: [],
    metadata: {},
    originalBlob: blob,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('structured cloud restore', () => {
  it('reads a shared container inventory once per listing and never hides HTTP failures as an empty library', async () => {
    const a = await resource('listed')
    const snapshot = (await createStructuredSnapshot([a], [], [], { version: 1 })).snapshot
    const part = snapshot.resources[0]!.object.parts[0]!
    const readInventory = vi.fn(
      async () =>
        new Map([[structuredPartIdentity(part), { id: 101, name: part.name, size: a.fileSize }]]),
    )
    const read = vi.fn(async () => snapshot)
    const context = {
      getGitHubRelease: async (_c: unknown, _s: string, _create: boolean, tag: string) =>
        tag === 'srl-cloud-snapshots' ? { id: 10 } : undefined,
      listGitHubAssets: async () =>
        [1, 2, 3].map((id) => ({
          id,
          name: `snapshot-${id}.srlmanifest.v3.json.gz`,
          size: 1,
          created_at: '2026-10-17T00:00:00Z',
        })),
      readGitHubStructuredSnapshot: read,
      readGitHubPartInventory: readInventory,
    } as unknown as CloudBackupTransportContext
    const config = {
      provider: 'github' as const,
      owner: 'owner',
      repository: 'repo',
      retention: 2,
      autoBackup: false,
    }
    expect(await listGitHub(context, config, 'fixture')).toHaveLength(3)
    expect(readInventory).toHaveBeenCalledOnce()
    read.mockRejectedValue(Object.assign(new Error('manifest read denied'), { status: 404 }))
    await expect(listGitHub(context, config, 'fixture')).rejects.toMatchObject({ status: 404 })
  })

  it('names the failed manifest and retains the upstream 404 for diagnosis without guessing a replacement', async () => {
    const fetch = vi.fn(async () => {
      throw Object.assign(new Error('GET /releases/assets/570692951 → 404'), { status: 404 })
    })
    await expect(
      readGitHubStructuredSnapshot(
        { githubFetch: fetch } as unknown as CloudBackupTransportContext,
        { provider: 'github', owner: 'owner', repository: 'repo', retention: 2, autoBackup: false },
        'fixture',
        { id: '570692951', objectKey: 'snapshot.srlmanifest.v3.json.gz', size: 1, createdAt: 1 },
      ),
    ).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining('快照清单 snapshot.srlmanifest.v3.json.gz'),
    })
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('retains resource and chunk context when the response body disconnects', async () => {
    const a = await resource('body-disconnected')
    const object = (await createStructuredSnapshot([a], [], [], { version: 1 })).snapshot
      .resources[0]!.object
    const networkError = new TypeError('Failed to fetch')
    const download = vi.fn(async () => new Response('headers received'))
    const reader = await createGitHubObjectReader(
      {
        getGitHubRelease: async () => ({ id: 1 }),
        listGitHubAssets: async () => [{ id: 101, name: object.parts[0]!.name, size: a.fileSize }],
        githubFetch: download,
        readResponseBlob: async () => {
          throw networkError
        },
      } as unknown as CloudBackupTransportContext,
      { provider: 'github', owner: 'owner', repository: 'repo', retention: 2, autoBackup: false },
      'fixture',
    )
    const error = await reader(object).catch((error: unknown) => error)
    expect(error).toMatchObject({
      message: expect.stringContaining(a.fileName),
      cause: networkError,
    })
    expect((error as Error).message).toContain('附件 101')
    expect(friendlyNetworkError(error, 'github')).toBe(error)
    expect(download).toHaveBeenCalledOnce()
  })

  it('preserves manifest context if its body fails after receiving headers', async () => {
    const error = await readGitHubStructuredSnapshot(
      {
        githubFetch: async () => new Response('headers received'),
        readResponseBlob: async () => {
          throw new TypeError('Load failed')
        },
      } as unknown as CloudBackupTransportContext,
      { provider: 'github', owner: 'owner', repository: 'repo', retention: 2, autoBackup: false },
      'fixture',
      { id: '17', objectKey: 'snapshot.srlmanifest.v3.json.gz', size: 1, createdAt: 1 },
    ).catch((error: unknown) => error)
    expect(error).toMatchObject({ message: expect.stringContaining('快照清单 snapshot') })
    expect(friendlyNetworkError(error, 'github')).toBe(error)
  })

  it('distinguishes a download-host 404 from a GitHub API 404', () => {
    const error = githubError(
      404,
      {},
      '/releases/assets/101',
      'GET',
      new Headers({
        'x-srl-cloud-upstream': 'github-asset',
      }),
    )
    expect(error.message).toContain('附件下载服务器')
    expect(error.message).toContain('不代表附件已被删除')
    expect(friendlyNetworkError(new TypeError('Failed to fetch'), 'github').message).not.toContain(
      '直连',
    )
  })

  it('does not refresh attachment IDs when the API already returned a download address', async () => {
    const a = await resource('download-host-404')
    const object = (await createStructuredSnapshot([a], [], [], { version: 1 })).snapshot
      .resources[0]!.object
    const assets = vi.fn(async () => [{ id: 101, name: object.parts[0]!.name, size: a.fileSize }])
    const reader = await createGitHubObjectReader(
      {
        getGitHubRelease: async () => ({ id: 1 }),
        listGitHubAssets: assets,
        githubFetch: async () => {
          throw githubError(
            404,
            {},
            '/releases/assets/101',
            'GET',
            new Headers({
              'x-srl-cloud-upstream': 'github-asset',
            }),
          )
        },
      } as unknown as CloudBackupTransportContext,
      { provider: 'github', owner: 'owner', repository: 'repo', retention: 2, autoBackup: false },
      'fixture',
    )
    await expect(reader(object)).rejects.toMatchObject({
      status: 404,
      upstream: 'github-asset',
      message: expect.not.stringContaining('请核对目标和权限'),
    })
    expect(assets).toHaveBeenCalledOnce()
  })

  it.each([null, 'matching-digest'])(
    'repairs a starter chunk in its original container and preserves unrelated uploaded chunks: %s',
    async (digest) => {
      const created = await createStructuredSnapshot([await resource('repair')], [], [], {
        version: 1,
      })
      const plan = created.objectPlans[0]!
      const blob = created.chunks.get(plan.name)!
      const healthy = await createStructuredSnapshot([await resource('healthy')], [], [], {
        version: 1,
      })
      const healthyPlan = healthy.objectPlans[0]!
      created.objectPlans.push(healthyPlan)
      created.snapshot.resources.push(...healthy.snapshot.resources)
      const old = {
        id: 101,
        name: plan.name,
        size: plan.size,
        state: 'starter',
        digest: digest ? `sha256:${plan.hash}` : null,
      }
      const calls: string[] = []
      const fetch = vi.fn(async (_config, _secret, path: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${path}`)
        if (init?.method !== 'DELETE')
          throw Object.assign(new Error('starter download 404'), { status: 404 })
        return new Response(null, { status: 204 })
      })
      const upload = vi.fn(
        async (_config, _secret, releaseId: number, name: string, body: Blob) => {
          calls.push(`POST ${releaseId} ${name}`)
          return {
            id: 202,
            name,
            size: body.size,
            state: 'uploaded',
            digest: `sha256:${await hashCloudBlob(body)}`,
          }
        },
      )
      const context = {
        getGitHubRelease: async () => ({ id: 10 }),
        listGitHubObjectContainers: async () => [
          { id: 1, tag_name: 'srl-cloud-objects-0001' },
          { id: 2, tag_name: 'srl-cloud-objects-0002' },
        ],
        listGitHubAssets: async (_config: unknown, _secret: unknown, id: number) =>
          id === 1
            ? [old]
            : [
                {
                  id: 303,
                  name: healthyPlan.name,
                  size: healthyPlan.size,
                  digest: `sha256:${healthyPlan.hash}`,
                  state: 'uploaded',
                },
              ],
        githubFetch: fetch,
        materializeCloudObject: async () => blob,
        uploadGitHubAsset: upload,
        confirmGitHubAssetSize: async (_config: unknown, _secret: unknown, asset: GitHubAsset) =>
          asset,
        jobStore: {
          begin: async () => ({}),
          markObject: async () => {},
          complete: async () => {},
          fail: async () => {},
        },
      } as unknown as CloudBackupTransportContext
      await uploadGitHubStructuredBackup(
        context,
        { provider: 'github', owner: 'owner', repository: 'repo', retention: 2, autoBackup: false },
        'fixture',
        created,
      )
      expect(fetch).toHaveBeenCalledOnce()
      expect(calls[0]).toBe('DELETE /releases/assets/101')
      expect(upload.mock.calls[0]?.[2]).toBe(1)
      expect(upload).toHaveBeenCalledTimes(2)
      expect(created.snapshot.resources[0]!.object.parts[0]!.storage?.container).toBe(
        'srl-cloud-objects-0001',
      )
      const reader = await createGitHubObjectReader(
        {
          getGitHubRelease: async () => ({ id: 1 }),
          listGitHubAssets: async () => [{ ...old, id: 202, state: 'uploaded' }],
          githubFetch: async () => new Response(blob),
          readResponseBlob: (response: Response) => response.blob(),
        } as unknown as CloudBackupTransportContext,
        { provider: 'github', owner: 'owner', repository: 'repo', retention: 2, autoBackup: false },
        'fixture',
      )
      expect(await (await reader(created.snapshot.resources[0]!.object)).text()).toBe(
        await blob.text(),
      )
    },
  )

  it.each(['invalid-original', 'stopped'])(
    'does not delete a starter when its replacement is unavailable or stopped: %s',
    async (mode) => {
      const created = await createStructuredSnapshot([await resource('protect')], [], [], {
        version: 1,
      })
      const plan = created.objectPlans[0]!
      const controller = new AbortController()
      const fetch = vi.fn()
      const upload = vi.fn()
      const context = {
        signal: controller.signal,
        getGitHubRelease: async () => ({ id: 10 }),
        listGitHubObjectContainers: async () => [{ id: 1, tag_name: 'srl-cloud-objects-0001' }],
        listGitHubAssets: async () => [
          { id: 101, name: plan.name, size: plan.size, state: 'starter' },
        ],
        githubFetch: fetch,
        uploadGitHubAsset: upload,
        materializeCloudObject: async () => {
          if (mode === 'stopped') controller.abort(new DOMException('stopped', 'AbortError'))
          return mode === 'stopped' ? created.chunks.get(plan.name)! : new Blob(['invalid'])
        },
      } as unknown as CloudBackupTransportContext
      await expect(
        uploadGitHubStructuredBackup(
          context,
          {
            provider: 'github',
            owner: 'owner',
            repository: 'repo',
            retention: 2,
            autoBackup: false,
          },
          'fixture',
          created,
        ),
      ).rejects.toThrow(mode === 'stopped' ? 'stopped' : '拒绝覆盖')
      expect(fetch).not.toHaveBeenCalled()
      expect(upload).not.toHaveBeenCalled()
    },
  )

  it('identifies incomplete chunks before downloading and leaves other selections readable', async () => {
    const a = await resource('incomplete')
    const good = await resource('complete')
    const goodObject = (await createStructuredSnapshot([good], [], [], { version: 1 })).snapshot
      .resources[0]!.object
    const object = (await createStructuredSnapshot([a], [], [], { version: 1 })).snapshot
      .resources[0]!.object
    const download = vi.fn(async () => new Response(good.originalBlob))
    const reader = await createGitHubObjectReader(
      {
        getGitHubRelease: async () => ({ id: 1 }),
        listGitHubAssets: async () => [
          { id: 101, name: object.parts[0]!.name, size: a.fileSize, state: 'starter' },
          { id: 202, name: goodObject.parts[0]!.name, size: good.fileSize, state: 'uploaded' },
        ],
        githubFetch: download,
        readResponseBlob: (response: Response) => response.blob(),
      } as unknown as CloudBackupTransportContext,
      { provider: 'github', owner: 'owner', repository: 'repo', retention: 2, autoBackup: false },
      'fixture',
    )
    await expect(reader(object)).rejects.toThrow(/starter/)
    await expect(reader(object)).rejects.toThrow(a.fileName)
    expect(download).not.toHaveBeenCalled()
    expect(await (await reader(goodObject)).text()).toBe(await good.originalBlob.text())
    expect(download).toHaveBeenCalledOnce()
  })

  it('does not confirm a same-size starter asset even when it carries a matching digest', async () => {
    const network = vi.fn()
    const confirmed = await confirmGitHubAssetSize(
      { githubFetch: network } as unknown as CloudBackupTransportContext,
      { provider: 'github', owner: 'owner', repository: 'repo', retention: 2, autoBackup: false },
      'fixture',
      {
        id: 101,
        name: 'chunk',
        size: 4,
        state: 'starter',
        digest: `sha256:${'a'.repeat(64)}`,
        url: '',
        created_at: '',
      },
      4,
      'a'.repeat(64),
    )
    expect(confirmed).toBeUndefined()
    expect(network).not.toHaveBeenCalled()
  })

  it('never submits a manifest or reports success if every chunk upload remains starter', async () => {
    const created = await createStructuredSnapshot([await resource('unfinished-upload')], [], [], {
      version: 1,
    })
    const plan = created.objectPlans[0]!
    const complete = vi.fn()
    const failed = vi.fn()
    const remove = vi.fn(async () => new Response(null, { status: 204 }))
    const upload = vi.fn(async (_config, _secret, _release, name: string, blob: Blob) => ({
      id: 101,
      name,
      size: blob.size,
      state: 'starter',
      digest: `sha256:${plan.hash}`,
    }))
    const context = {
      getGitHubRelease: async () => ({ id: 10 }),
      listGitHubObjectContainers: async () => [{ id: 1, tag_name: 'srl-cloud-objects-0001' }],
      listGitHubAssets: async () => [],
      githubFetch: remove,
      materializeCloudObject: async () => created.chunks.get(plan.name)!,
      uploadGitHubAsset: upload,
      confirmGitHubAssetSize: (
        ...args: Parameters<CloudBackupTransportContext['confirmGitHubAssetSize']>
      ) => confirmGitHubAssetSize(context as unknown as CloudBackupTransportContext, ...args),
      jobStore: { begin: async () => ({}), markObject: async () => {}, complete, fail: failed },
    }
    await expect(
      uploadGitHubStructuredBackup(
        context as unknown as CloudBackupTransportContext,
        { provider: 'github', owner: 'owner', repository: 'repo', retention: 2, autoBackup: false },
        'fixture',
        created,
      ),
    ).rejects.toThrow('未提交快照清单')
    expect(upload).toHaveBeenCalledTimes(3)
    expect(upload.mock.calls.every((call) => call[3] === plan.name)).toBe(true)
    expect(remove).toHaveBeenCalledTimes(3)
    expect(complete).not.toHaveBeenCalled()
    expect(failed).toHaveBeenCalledOnce()
  })

  it.each([1, 3, 'byte-budget'] as const)(
    'prepares cloud resources with bounded concurrency %s and ordered staging progress',
    async (mode) => {
      const concurrency = mode === 'byte-budget' ? 1 : mode
      const records = await Promise.all(
        Array.from({ length: 6 }, (_, i) => resource(`pipeline-${i}`)),
      )
      const snapshot = (await createStructuredSnapshot(records, [], [], { version: 1 })).snapshot
      let release!: () => void
      const barrier = new Promise<void>((resolve) => {
        release = resolve
      })
      let active = 0
      let peak = 0
      const reader = vi.fn(async (object: GitHubBundleManifest) => {
        active++
        peak = Math.max(peak, active)
        await barrier
        active--
        return records.find((r) => r.fileName === object.fileName)!.originalBlob
      })
      const bodies: string[] = []
      const progress = vi.fn()
      const service = new RestoreService({
        replace: vi.fn(),
        restore: async (_categories, resources, _versions, hydrate, report) => {
          for (let i = 0; i < resources.length; i++) {
            report?.({ phase: 'prepare', completed: i, total: resources.length })
            bodies.push(await (await hydrate!(resources[i]!)).originalBlob.text())
            report?.({ phase: 'prepare', completed: i + 1, total: resources.length })
          }
          report?.({ phase: 'commit', completed: resources.length, total: resources.length })
        },
      })
      const operation = service.restoreStructured(snapshot, reader, [], [], 'pipeline', {
        concurrency: mode === 1 ? 1 : undefined,
        maxPreparedBytes: mode === 'byte-budget' ? records[0]!.fileSize : undefined,
        onProgress: progress,
      })
      try {
        await vi.waitFor(() => expect(active).toBe(concurrency))
      } finally {
        release()
      }
      await operation
      expect(peak).toBe(concurrency)
      expect(reader).toHaveBeenCalledTimes(6)
      expect(bodies).toEqual(await Promise.all(records.map((r) => r.originalBlob.text())))
      expect(progress).toHaveBeenCalledWith(
        expect.objectContaining({ phase: 'prepare', completed: 6, total: 6 }),
      )
      expect(progress).toHaveBeenLastCalledWith(
        expect.objectContaining({ phase: 'commit', completed: 6, total: 6 }),
      )
    },
  )

  it('stops scheduling on the first preparation failure, aborts peers and preserves the original cause', async () => {
    const records = await Promise.all(Array.from({ length: 6 }, (_, i) => resource(`stop-${i}`)))
    const snapshot = (await createStructuredSnapshot(records, [], [], { version: 1 })).snapshot
    const controller = new AbortController()
    const failure = new Error('fixture download interrupted')
    const reader = vi.fn(async (object: GitHubBundleManifest) => {
      if (object.fileName === records[1]!.fileName) throw failure
      return new Promise<Blob>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
          once: true,
        })
      })
    })
    const service = new RestoreService({
      replace: vi.fn(),
      restore: async (_categories, resources, _versions, hydrate) => {
        await hydrate!(resources[0]!)
      },
    })
    await expect(
      service.restoreStructured(snapshot, reader, [], [], 'stop', {
        signal: controller.signal,
        onFailure: (error) => controller.abort(error),
      }),
    ).rejects.toBe(failure)
    expect(controller.signal.aborted).toBe(true)
    expect(reader).toHaveBeenCalledTimes(3)
  })

  it('does not scan local history when restoring settings or resources without versions', async () => {
    const storage = { restore: vi.fn(), replace: vi.fn(), listRestoreVersionKeys: vi.fn() }
    const service = new RestoreService(storage)
    const existing = await resource('existing')
    await service.prepareStructured([], [], [], { version: 1 }, [existing], [], 'settings')
    await service.prepareStructured([existing], [], [], { version: 1 }, [existing], [], 'resource')
    expect(storage.listRestoreVersionKeys).not.toHaveBeenCalled()
    storage.listRestoreVersionKeys.mockResolvedValue([])
    await service.prepareStructured(
      [existing],
      [{ ...existing, id: 'history', versionGroupId: existing.id }],
      [],
      { version: 1 },
      [existing],
      [],
      'history',
    )
    expect(storage.listRestoreVersionKeys).toHaveBeenCalledExactlyOnceWith([existing.id])
  })

  it.each(['github', 'webdav'] as const)(
    '%s hashes an intact single-part original once and invalidates changed declarations',
    async (provider) => {
      const a = await resource('one')
      const object = (await createStructuredSnapshot([a], [], [], { version: 1 })).snapshot
        .resources[0]!.object
      const network = vi.fn(async () => new Response(a.originalBlob))
      const context = {
        getGitHubRelease: async () => ({ id: 1 }),
        listGitHubAssets: async () => [{ id: 101, name: object.parts[0]!.name, size: a.fileSize }],
        githubFetch: network,
        cloudFetch: network,
        readResponseBlob: (response: Response) => response.blob(),
      } as unknown as CloudBackupTransportContext
      const reader =
        provider === 'github'
          ? await createGitHubObjectReader(
              context,
              { provider, owner: 'owner', repository: 'repo', retention: 2, autoBackup: false },
              'token',
            )
          : createWebDavObjectReader(
              context,
              {
                provider,
                baseUrl: 'https://dav.example',
                folder: 'test',
                username: 'test',
                retention: 2,
                autoBackup: false,
              },
              'token',
            )
      const hash = vi.spyOn(cloudCodec, 'hashCloudBlob')
      try {
        expect(await (await reader(object)).text()).toBe(await a.originalBlob.text())
        expect(hash).toHaveBeenCalledOnce()
        await reader(object)
        expect(network).toHaveBeenCalledOnce()
        expect(hash).toHaveBeenCalledOnce()
        await expect(
          reader({
            ...object,
            parts: [{ ...object.parts[0]!, sha256: '0'.repeat(64) }],
            totalSha256: '0'.repeat(64),
          }),
        ).rejects.toThrow('分块校验失败')
        expect(network).toHaveBeenCalledTimes(2)
      } finally {
        hash.mockRestore()
      }
    },
  )

  it('refreshes a stale GitHub chunk ID once without relaxing SHA validation', async () => {
    const a = await resource('stale')
    const object = (await createStructuredSnapshot([a], [], [], { version: 1 })).snapshot
      .resources[0]!.object
    const assets = vi
      .fn()
      .mockResolvedValueOnce([{ id: 101, name: object.parts[0]!.name, size: a.fileSize }])
      .mockResolvedValue([{ id: 202, name: object.parts[0]!.name, size: a.fileSize }])
    const download = vi.fn(async (_config, _secret, path: string) => {
      if (path.endsWith('/101'))
        throw Object.assign(new Error('GET /releases/assets/101 → 404'), { status: 404 })
      return new Response(a.originalBlob)
    })
    const reader = await createGitHubObjectReader(
      {
        getGitHubRelease: async () => ({ id: 1 }),
        listGitHubAssets: assets,
        githubFetch: download,
        readResponseBlob: (r: Response) => r.blob(),
      } as unknown as CloudBackupTransportContext,
      { provider: 'github', owner: 'owner', repository: 'repo', retention: 2, autoBackup: false },
      'token',
    )
    expect(await (await reader(object)).text()).toBe(await a.originalBlob.text())
    expect(assets).toHaveBeenCalledTimes(2)
    expect(download.mock.calls.map((call) => call[2])).toEqual([
      '/releases/assets/101',
      '/releases/assets/202',
    ])
  })

  it.each([404, 401, 500])(
    'does not loop on an unresolved GitHub %i and reports the resource',
    async (status) => {
      const a = await resource('missing-card')
      const object = (await createStructuredSnapshot([a], [], [], { version: 1 })).snapshot
        .resources[0]!.object
      const assets = vi.fn(async () => [{ id: 101, name: object.parts[0]!.name, size: a.fileSize }])
      const download = vi.fn(async () => {
        throw Object.assign(new Error('upstream failed'), { status })
      })
      const reader = await createGitHubObjectReader(
        {
          getGitHubRelease: async () => ({ id: 1 }),
          listGitHubAssets: assets,
          githubFetch: download,
        } as unknown as CloudBackupTransportContext,
        { provider: 'github', owner: 'owner', repository: 'repo', retention: 2, autoBackup: false },
        'token',
      )
      await expect(reader(object)).rejects.toMatchObject({
        status,
        message: expect.stringContaining(a.fileName),
      })
      expect(download).toHaveBeenCalledOnce()
      expect(assets).toHaveBeenCalledTimes(status === 404 ? 2 : 1)
    },
  )
  it('returns reader data bound to the imported resource after an ID conflict', async () => {
    const database = new AppDatabase(`structured-reader-conflict-${crypto.randomUUID()}`)
    const storage = new IndexedDbArchiveStorage(database)
    const service = new RestoreService(storage, new MemoryRestoreStagingStore())
    const source = await resource('conflicting-id')
    const existing = { ...(await resource('different-body')), id: source.id }
    await storage.restore([], [existing])
    const snapshot = (
      await createStructuredSnapshot([source], [], [], {
        version: 1,
        chatReader: [
          {
            id: 'reader-state',
            appId: CHAT_READER_APP_ID,
            key: 'chat:' + source.id,
            value: { bookmark: 4 },
            updatedAt: 1,
          },
        ],
      })
    ).snapshot
    try {
      const report = await service.restoreStructured(
        snapshot,
        async () => source.originalBlob,
        [existing],
        [],
        'snapshot',
      )
      const imported = (await database.resources.toArray()).find(
        (row) => row.contentHash === source.contentHash,
      )!
      expect(imported.id).not.toBe(source.id)
      expect(report).toHaveProperty('portableData.chatReader.0.key', 'chat:' + imported.id)
      expect(snapshot.portableData.chatReader?.[0]?.key).toBe('chat:' + source.id)
    } finally {
      database.close()
      await database.delete()
    }
  })
  it('preserves the cloud hydration callback through the production CommunitySource restore owner', async () => {
    const database = new AppDatabase(`structured-production-owner-${crypto.randomUUID()}`)
    const storage = new IndexedDbArchiveStorage(database)
    const service = new CommunitySourceRestoreService(storage, new MemoryRestoreStagingStore(), {
      restoreBackup: vi.fn(),
      replaceAll: vi.fn(),
    })
    const source = await resource('production-owner')
    const snapshot = (await createStructuredSnapshot([source], [], [], { version: 1 })).snapshot
    const reader = vi.fn(async () => source.originalBlob)
    try {
      await service.restoreStructured(snapshot, reader, [], [], 'snapshot')
      expect(reader).toHaveBeenCalledTimes(1)
      const restored = (await database.resources.get(source.id))!
      expect(isEncryptedResource(restored)).toBe(false)
      if (!isEncryptedResource(restored) && 'originalBlob' in restored) {
        expect(await restored.originalBlob.text()).toBe(await source.originalBlob.text())
        expect(restored.originalBlob.size).toBe(source.fileSize)
        expect(restored.metadata).toHaveProperty('card.data.name', source.id)
      }
    } finally {
      database.close()
      await database.delete()
    }
  })

  it('does not commit placeholders or erase existing resources when the cloud reader fails', async () => {
    const database = new AppDatabase(`structured-owner-failure-${crypto.randomUUID()}`)
    const storage = new IndexedDbArchiveStorage(database)
    const sourceOwner = { restoreBackup: vi.fn(), replaceAll: vi.fn() }
    const service = new CommunitySourceRestoreService(
      storage,
      new MemoryRestoreStagingStore(),
      sourceOwner,
    )
    const existing = await resource('existing-local')
    const source = await resource('remote-candidate')
    await storage.restore([], [existing])
    const snapshot = (await createStructuredSnapshot([source], [], [], { version: 1 })).snapshot
    try {
      await expect(
        service.restoreStructured(
          snapshot,
          async () => {
            throw new Error('download interrupted')
          },
          [existing],
          [],
          'snapshot',
        ),
      ).rejects.toThrow('download interrupted')
      expect(await database.resources.count()).toBe(1)
      expect(await database.resources.get(source.id)).toBeUndefined()
      const retained = (await database.resources.get(existing.id))!
      expect(isEncryptedResource(retained)).toBe(false)
      if ('originalBlob' in retained)
        expect(await retained.originalBlob.text()).toBe(await existing.originalBlob.text())
      expect(await database.restoreStaging.count()).toBe(0)
      expect(sourceOwner.restoreBackup).not.toHaveBeenCalled()
      expect(sourceOwner.replaceAll).not.toHaveBeenCalled()
    } finally {
      database.close()
      await database.delete()
    }
  })

  it('hydrates and stages current/history records serially, skips duplicates and preserves remapped history', async () => {
    const database = new AppDatabase(`structured-serial-${crypto.randomUUID()}`)
    const storage = new IndexedDbArchiveStorage(database)
    const service = new RestoreService(storage)
    const a = await resource('a'),
      b = await resource('b')
    const version = { ...(await resource('old-b')), versionGroupId: b.id }
    const snapshot = (await createStructuredSnapshot([a, b], [version], [], { version: 1 }))
      .snapshot
    const blobs = new Map(
      [a, b, version].map((record) => [record.contentHash, record.originalBlob]),
    )
    await storage.restore([], [{ ...a, id: 'existing-a' }])
    let reads = 0
    const reader = vi.fn(async (object: GitHubBundleManifest) => {
      expect(await database.resources.count()).toBe(1)
      expect(await database.restoreStaging.count()).toBe(reads++)
      return blobs.get(object.totalSha256)!
    })
    try {
      const report = await service.restoreStructured(
        snapshot,
        reader,
        [{ ...a, id: 'existing-a' }],
        [],
        'snapshot',
        { concurrency: 1 },
      )
      expect(report).toMatchObject({
        restoredResources: 1,
        restoredVersions: 1,
        skippedDuplicates: 1,
      })
      expect(reader).toHaveBeenCalledTimes(2)
      expect(await database.resources.get('b')).toHaveProperty('metadata.card.data.name', 'b')
      const history = await database.resourceVersions.toArray()
      expect(history[0]).toMatchObject({
        versionGroupId: 'b',
        metadata: { card: { data: { name: 'old-b' } } },
      })
      expect(await database.restoreStaging.count()).toBe(0)
    } finally {
      database.close()
      await database.delete()
    }
  })

  it('never stages plaintext Web records when the local vault is enabled', async () => {
    const database = new AppDatabase(`structured-encrypted-${crypto.randomUUID()}`)
    const vault = new VaultService(database)
    await vault.initialize()
    await vault.enable('test-password')
    const storage = new IndexedDbArchiveStorage(database, vault)
    const source = await resource('private')
    let staged = 0
    database.restoreStaging.hook('creating', (_key, entry) => {
      staged++
      expect(isEncryptedResource(entry.record!.resource)).toBe(true)
      expect(entry.record).not.toHaveProperty('summary')
      expect(isEncryptedResourceSummary(entry.record!.listSummary)).toBe(true)
      expect(entry.record!.resource).not.toHaveProperty('metadata')
    })
    try {
      await storage.restore([], [{ ...source, originalBlob: new Blob([]) }], [], async () => source)
      expect(staged).toBe(1)
      const stored = (await database.resources.get(source.id))!
      expect(await (await vault.decodeResource(stored)).originalBlob.text()).toBe(
        await source.originalBlob.text(),
      )
    } finally {
      database.close()
      await database.delete()
    }
  })

  it.each(['github', 'webdav'] as const)(
    '%s keeps only the most recent downloaded part and still checks hashes',
    async (provider) => {
      const a = await resource('a'),
        b = await resource('b')
      const snapshot = (await createStructuredSnapshot([a, b], [], [], { version: 1 })).snapshot
      const calls = vi.fn(
        async (key: string) => new Response(key.includes('101') ? a.originalBlob : b.originalBlob),
      )
      const context = {
        getGitHubRelease: async () => ({ id: 1 }),
        listGitHubAssets: async () =>
          snapshot.resources.map((r, i) => ({
            id: 101 + i,
            name: r.object.parts[0]!.name,
            size: r.fileSize,
          })),
        githubFetch: (_config: unknown, _secret: string, url: string) => calls(url),
        cloudFetch: (url: string) => calls(url.includes(a.contentHash) ? '101' : '102'),
        readResponseBlob: (response: Response) => response.blob(),
      } as unknown as CloudBackupTransportContext
      const reader =
        provider === 'github'
          ? await createGitHubObjectReader(
              context,
              { provider, owner: 'owner', repository: 'repo', retention: 2, autoBackup: false },
              'token',
            )
          : createWebDavObjectReader(
              context,
              {
                provider,
                baseUrl: 'https://app.koofr.net/dav/Koofr',
                folder: 'test',
                username: 'test',
                retention: 2,
                autoBackup: false,
              },
              'token',
            )
      const first = snapshot.resources[0]!.object,
        second = snapshot.resources[1]!.object
      await reader(first)
      await reader(first)
      expect(calls).toHaveBeenCalledTimes(1)
      await reader(second)
      expect(await (await reader(first)).text()).toBe(await a.originalBlob.text())
      expect(calls).toHaveBeenCalledTimes(3)
      await expect(reader({ ...second, totalSha256: '0'.repeat(64) })).rejects.toThrow(
        '完整性校验失败',
      )
    },
  )
})
