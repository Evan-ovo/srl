import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CategoryService } from './CategoryService'
import { CloudBackupService } from './CloudBackupService'
import type { CreatedStructuredSnapshot, StructuredSnapshot } from './CloudStructuredSnapshot'
import type { ExportService } from './ExportService'
import type { ResourceService } from './ResourceService'
import { RestoreService } from './RestoreService'
import { RESOURCE_TYPE, type Resource } from '../types/Resource'
import type { GitHubBackupConfig, WebDavBackupConfig } from '../types/CloudBackup'
import type { ArchivePortableData, PreparedRestore } from '../types/Backup'
import { noticeCenter } from '../core/NoticeCenter'
import { taskCenter } from '../core/TaskCenter'
import { waitForCloudRetry } from './CloudBackupHttp'
import { hashCloudBlob } from './CloudArchiveCodec'
import {
  decodeStructuredSnapshot,
  createStructuredSnapshot,
  encodeStructuredSnapshot,
} from './CloudStructuredSnapshot'
import { ExportService as ArchiveExporter } from './ExportService'
import type { CloudDownloadProgress } from './CloudBackupTransport'
import { CloudBackupMaintenanceError } from './CloudBackupRetentionOperations'

class MemoryStorage implements Storage {
  private values = new Map<string, string>()
  get length() {
    return this.values.size
  }
  clear() {
    this.values.clear()
  }
  getItem(key: string) {
    return this.values.get(key) ?? null
  }
  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null
  }
  removeItem(key: string) {
    this.values.delete(key)
  }
  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
}

const githubConfig: GitHubBackupConfig = {
  provider: 'github',
  owner: 'owner',
  repository: 'private-backups',
  retention: 7,
  autoBackup: false,
}
const webDavConfig: WebDavBackupConfig = {
  provider: 'webdav',
  baseUrl: 'https://app.koofr.net/dav/Koofr',
  folder: 'SRL-Backups',
  username: 'user@example.com',
  retention: 7,
  autoBackup: false,
}

function createService(
  resourceService = {} as ResourceService,
  categoryService = {} as CategoryService,
  exportService = {} as ExportService,
  restoreService = {} as RestoreService,
): CloudBackupService {
  return new CloudBackupService(resourceService, categoryService, exportService, restoreService)
}

function githubRepositoryResponse(status = 200, isPrivate = true): Response {
  return new Response(
    JSON.stringify(
      status === 200
        ? {
            full_name: 'owner/private-backups',
            private: isPrivate,
            permissions: { push: true },
          }
        : { message: status === 401 ? 'Bad credentials' : 'forbidden' },
    ),
    { status, headers: { 'x-srl-cloud-proxy': '1' } },
  )
}

function cloudResource(hash: string, id = 'resource-1'): Resource {
  const blob = new Blob([hash.slice(0, 8)], { type: 'application/octet-stream' })
  return {
    id,
    type: RESOURCE_TYPE.OTHER,
    name: id,
    description: '',
    fileName: `${id}.bin`,
    mimeType: blob.type,
    fileSize: blob.size,
    contentHash: hash,
    favorite: false,
    categoryId: null,
    tags: [],
    metadata: {},
    originalBlob: blob,
    createdAt: 1,
    updatedAt: 1,
  }
}

function createdSnapshot(hashes = ['a'.repeat(64)]): CreatedStructuredSnapshot {
  const chunks = new Map<string, Blob>()
  const nativeSources = new Map<
    string,
    { kind: 'range'; contentHash: string; offset: number; size: number }
  >()
  const resources = hashes.map((hash, index) => {
    const blob = new Blob([`object-${index}`], { type: 'application/octet-stream' })
    const name = `srl-chunk--sha256-${hash}`
    chunks.set(name, blob)
    nativeSources.set(name, { kind: 'range', contentHash: hash, offset: 0, size: blob.size })
    const resource = cloudResource(hash, `resource-${index}`)
    const { originalBlob: _originalBlob, thumbnailBlob: _thumbnailBlob, ...record } = resource
    return {
      ...record,
      fileSize: blob.size,
      object: {
        format: 'srl-github-backup-bundle' as const,
        version: 2 as const,
        createdAt: '2026-08-26T00:00:00.000Z',
        fileName: `resource-${index}.bin`,
        totalSize: blob.size,
        totalSha256: hash,
        parts: [{ name, size: blob.size, sha256: hash }],
      },
    }
  }) as StructuredSnapshot['resources']
  const snapshot: StructuredSnapshot = {
    format: 'srl-structured-cloud-snapshot',
    version: 3,
    createdAt: '2026-08-26T00:00:00.000Z',
    categories: [],
    resources,
    versions: [],
    portableData: { version: 1 },
    objectContract: { algorithm: 'SHA-256', immutable: true, naming: 'srl-chunk--sha256-{hash}' },
  }
  return {
    snapshot,
    chunks,
    nativeSources,
    objectPlans: [...chunks].map(([name, blob]) => ({
      name,
      hash: name.slice('srl-chunk--sha256-'.length),
      size: blob.size,
      blob,
      source: nativeSources.get(name)!,
      contentType: 'application/octet-stream',
    })),
    totalSize: [...chunks.values()].reduce((total, blob) => total + blob.size, 0),
    partCount: chunks.size,
    localReadBytes: 0,
    descriptorUpdates: [],
  }
}

describe('CloudBackupService V3', () => {
  it.each(['github', 'webdav'] as const)(
    'lists and restores settings-only %s snapshots with the selected remapped reader data',
    async (provider) => {
      const snapshot = createdSnapshot([]).snapshot
      snapshot.portableData = {
        version: 1,
        chatReader: [],
        assistantData: [],
        credentials: { version: 1, cloudBackup: { github: 'fixture-secret' } },
      }
      const remapped: ArchivePortableData = {
        ...snapshot.portableData,
        chatReader: [
          {
            id: 'reader-state',
            appId: 'com.srl.duleme',
            key: 'chat:remapped-id',
            value: {},
            updatedAt: 1,
          },
        ],
      }
      const restored = vi.fn().mockResolvedValue({ restoredResources: 0, portableData: remapped })
      const imported = vi.fn()
      const filter = vi.fn(async (data: ArchivePortableData) => data)
      const service = new CloudBackupService(
        { listResourceListSummaries: vi.fn(async () => []) } as unknown as ResourceService,
        { list: vi.fn(async () => []) } as unknown as CategoryService,
        {} as ExportService,
        { restoreStructured: restored } as unknown as RestoreService,
        undefined,
        imported,
      )
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(githubRepositoryResponse()))
      await service.importPortableCredentials({ [provider]: 'token' })
      await service.saveConfig(provider === 'github' ? githubConfig : webDavConfig, '')
      const readSnapshot = vi.fn().mockResolvedValue(snapshot)
      Object.assign(service, {
        readGitHubStructuredSnapshot: readSnapshot,
        readWebDavStructuredSnapshot: readSnapshot,
        createGitHubObjectReader: vi.fn().mockResolvedValue(vi.fn()),
        createWebDavObjectReader: vi.fn(),
      })
      const item = {
        id: '1',
        objectKey: 'snapshot.srlmanifest.v3.json.gz',
        size: 1,
        createdAt: 1,
        kind: provider === 'github' ? ('githubSnapshot' as const) : ('webdavSnapshot' as const),
      }
      expect(await service.listBackupRestoreContents(item)).toEqual({
        resources: [],
        portableScopeIds: ['extra.chatReader', 'extra.assistantData', 'extra.credentials'],
      })
      expect(readSnapshot).toHaveBeenCalledOnce()
      expect(await service.restoreBackup(item, filter, [], false, ['extra.chatReader'])).toBe(0)
      expect(filter).toHaveBeenCalledWith({ version: 1, chatReader: remapped.chatReader })
      expect(imported).toHaveBeenCalledWith({ version: 1, chatReader: remapped.chatReader })
      expect(restored.mock.calls[0]?.[0].resources).toEqual([])
      expect(readSnapshot).toHaveBeenCalledOnce()
      expect(snapshot.portableData.credentials).toBeDefined()
    },
  )
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.stubGlobal('localStorage', new MemoryStorage())
    // SRL-PUBLIC-SYNC: PUBLIC-ONLY id=koofr-worker-test-fixture
    localStorage.setItem('srl.publicWorker.baseUrl.v1', 'https://worker.example')
    vi.stubGlobal('sessionStorage', new MemoryStorage())
    vi.stubGlobal('indexedDB', new IDBFactory())
  })

  it.each([false, true])(
    'streams actual download byte deltas through the scoped transport and respects caller cancellation (stop=%s)',
    async (stop) => {
      const blob = new Blob([new Uint8Array(512 * 1024).fill(42)])
      const resource = {
        ...cloudResource(await hashCloudBlob(blob)),
        originalBlob: blob,
        fileSize: blob.size,
      }
      const created = await createStructuredSnapshot([resource], [], [], { version: 1 })
      const key = 'snapshots/download.srlmanifest.v3.json.gz'
      const manifest = await encodeStructuredSnapshot(created.snapshot)
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          const target = new URL(String(url), 'https://srl.example')
          const upstream = target.searchParams.get('url') ?? target.toString()
          if (upstream.endsWith(key))
            return new Response(manifest, { headers: { 'x-srl-cloud-proxy': '1' } })
          const name = upstream.split('/').at(-1)!
          const part = created.chunks.get(name)
          if (!part) throw new Error('Unexpected fixture request')
          if (!stop) return new Response(part.stream(), { headers: { 'x-srl-cloud-proxy': '1' } })
          const data = new Uint8Array(await part.arrayBuffer())
          return new Response(
            new ReadableStream({
              async start(controller) {
                controller.enqueue(data.subarray(0, 64 * 1024))
                await gate
                controller.enqueue(data.subarray(64 * 1024))
                controller.close()
              },
            }),
            { headers: { 'x-srl-cloud-proxy': '1' } },
          )
        }),
      )
      const service = createService(undefined, undefined, new ArchiveExporter())
      await service.importPortableCredentials({ webdav: 'fixture-password' })
      await service.saveConfig(webDavConfig, '')
      const controller = new AbortController()
      const reports: CloudDownloadProgress[] = []
      const pending = service.downloadBackup(
        { id: 'download', kind: 'webdavSnapshot', objectKey: key, size: blob.size, createdAt: 1 },
        undefined,
        undefined,
        { signal: controller.signal, onProgress: (state) => reports.push(state) },
      )
      if (stop) {
        const reason = new DOMException('stopped', 'AbortError')
        const rejected = expect(pending).rejects.toBe(reason)
        await vi.waitFor(() =>
          expect(reports.some((state) => state.receivedBytes === 64 * 1024)).toBe(true),
        )
        controller.abort(reason)
        await rejected
        release()
        expect(reports.every((state) => state.completed === 0)).toBe(true)
      } else {
        const archive = await pending
        expect(reports.at(-1)).toMatchObject({
          phase: 'archive',
          completed: 1,
          total: 1,
          receivedBytes: blob.size,
          writtenBytes: archive.size,
        })
        expect(archive.size).toBeGreaterThan(0)
      }
    },
  )

  it('passes the normalized selected resource IDs to plaintext companion preparation', async () => {
    const personal = await import('./PersonalResourceBackup')
    const copies = vi
      .spyOn(personal, 'cloudPlainSecretCopies')
      .mockRejectedValueOnce(new Error('fixture copy boundary'))
    const resources = {} as ResourceService
    const service = createService(resources)
    await expect(
      service.createBackup(
        {
          ...githubConfig,
          contentSelection: {
            resourceIds: ['only-secret'],
            personalResources: { secret: true },
            plaintextSecretCopy: true,
          },
        },
        'fixture',
      ),
    ).rejects.toThrow('fixture copy boundary')
    expect(copies).toHaveBeenCalledWith(
      expect.objectContaining(githubConfig),
      resources,
      expect.objectContaining({ secret: true, resourceIds: ['only-secret'] }),
    )
  })

  it.each(['github', 'webdav'] as const)(
    'releases the backup lock after %s inventory failure so the same instance can retry',
    async (provider) => {
      const service = createService(
        {
          listSummaries: vi.fn(async () => []),
          listVersions: vi.fn(async () => []),
          listVersionSummaries: vi.fn(async () => []),
        } as unknown as ResourceService,
        { list: vi.fn(async () => []) } as unknown as CategoryService,
      ) as unknown as {
        createBackup: CloudBackupService['createBackup']
        getSnapshot: CloudBackupService['getSnapshot']
        getTransportContext: (
          signal?: AbortSignal,
          beginCommit?: () => void,
        ) => import('./CloudBackupTransportContext').CloudBackupTransportContext
        getGitHubRelease: ReturnType<typeof vi.fn>
        listGitHubObjectContainers: ReturnType<typeof vi.fn>
        listGitHubAssets: ReturnType<typeof vi.fn>
        uploadGitHubAsset: ReturnType<typeof vi.fn>
        ensureWebDavFolder: ReturnType<typeof vi.fn>
        listWebDavObjects: ReturnType<typeof vi.fn>
        uploadWebDavObject: ReturnType<typeof vi.fn>
        prune: ReturnType<typeof vi.fn>
      }
      service.getGitHubRelease = vi.fn(async (_config, _secret, _create, tag) => ({
        id: tag === 'srl-cloud-snapshots' ? 10 : 20,
        tag_name: tag,
      }))
      service.listGitHubAssets = vi.fn(async () => [])
      service.uploadGitHubAsset = vi.fn(async (_config, _secret, _id, name, blob: Blob) => ({
        id: 30,
        name,
        size: blob.size,
        digest: `sha256:${await hashCloudBlob(blob)}`,
        state: 'uploaded',
        created_at: new Date().toISOString(),
      }))
      service.ensureWebDavFolder = vi.fn(async () => undefined)
      service.uploadWebDavObject = vi.fn(async () => undefined)
      const inventory = vi
        .fn()
        .mockRejectedValueOnce(new Error('fixture inventory interrupted'))
        .mockResolvedValue([])
      service.listGitHubObjectContainers = inventory
      service.listWebDavObjects = inventory
      service.prune = vi.fn(async () => 0)
      const context = service.getTransportContext()
      service.getTransportContext = (signal, beginCommit) =>
        ({
          ...context,
          signal,
          beginCommit,
          getGitHubRelease: service.getGitHubRelease,
          listGitHubObjectContainers: service.listGitHubObjectContainers,
          listGitHubAssets: service.listGitHubAssets,
          uploadGitHubAsset: service.uploadGitHubAsset,
          ensureWebDavFolder: service.ensureWebDavFolder,
          listWebDavObjects: service.listWebDavObjects,
          uploadWebDavObject: service.uploadWebDavObject,
        }) as unknown as import('./CloudBackupTransportContext').CloudBackupTransportContext
      const config = provider === 'github' ? githubConfig : webDavConfig
      await expect(service.createBackup(config, 'fixture')).rejects.toThrow(
        'fixture inventory interrupted',
      )
      expect(service.getSnapshot().status.lastError).toContain('fixture inventory interrupted')
      expect(service.uploadGitHubAsset).not.toHaveBeenCalled()
      expect(service.uploadWebDavObject).not.toHaveBeenCalled()
      await expect(service.createBackup(config, 'fixture')).resolves.toMatchObject({
        kind: provider === 'github' ? 'githubSnapshot' : 'webdavSnapshot',
      })
      expect(inventory).toHaveBeenCalledTimes(2)
      expect(service.getSnapshot().status.lastError).toBeUndefined()
    },
  )

  it('persists a Web credential in encrypted IndexedDB without localStorage/sessionStorage plaintext', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => githubRepositoryResponse()),
    )
    const first = createService()
    await first.saveConfig(githubConfig, 'saved-token')
    expect(localStorage.getItem('srl.cloudBackup.settings.v1')).not.toContain('saved-token')
    expect(localStorage.getItem('srl.cloudBackup.localSecrets.v1')).toBeNull()
    expect(sessionStorage.getItem('srl.cloudBackup.secret.github')).toBeNull()

    const reopened = createService()
    await reopened.initializeCredentials()
    expect(reopened.getSnapshot().credentials.github).toBe('valid')
    await expect(reopened.testConnection(githubConfig)).resolves.toContain('私有仓库')
  })

  it('在上传社区内容前能够识别公开 GitHub 仓库', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(githubRepositoryResponse(200, false)))
    const service = createService()

    await expect(service.inspectGitHubRepository(githubConfig, 'token')).resolves.toMatchObject({
      fullName: 'owner/private-backups',
      isPrivate: false,
      canWrite: true,
    })
  })

  it('同一仓库的社区内容首次校验后复用私有状态', async () => {
    const resource = cloudResource('a'.repeat(64))
    resource.contentHash = await crypto.subtle
      .digest('SHA-256', await resource.originalBlob.arrayBuffer())
      .then((value) =>
        [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
      )
    const resourceService = {
      listSummaries: vi.fn(async () => [resource]),
      listVersions: vi.fn(async () => []),
      listVersionSummaries: vi.fn(async () => []),
      get: vi.fn(async () => resource),
      updateBackupDescriptor: vi.fn(async () => undefined),
    } as unknown as ResourceService
    const categoryService = { list: vi.fn(async () => []) } as unknown as CategoryService
    const fetchMock = vi.fn().mockResolvedValue(githubRepositoryResponse())
    vi.stubGlobal('fetch', fetchMock)
    const service = new CloudBackupService(
      resourceService,
      categoryService,
      {} as ExportService,
      {} as RestoreService,
      async () => ({
        version: 1,
        communitySources: {
          data: { version: 1, sources: [], messages: [], bindings: [] },
          attachments: [],
        },
      }),
    ) as unknown as {
      saveConfig: CloudBackupService['saveConfig']
      createBackup: CloudBackupService['createBackup']
      uploadGitHubStructuredBackup: ReturnType<typeof vi.fn>
      prune: ReturnType<typeof vi.fn>
      reuseUnchangedStructuredBackup: ReturnType<typeof vi.fn>
    }
    const config = { ...githubConfig, contentSelection: { communitySources: true } }
    await service.saveConfig(config, 'token')
    service.uploadGitHubStructuredBackup = vi.fn(async () => ({
      id: 'manifest-1',
      objectKey: 'snapshot.srlmanifest.v3.json.gz',
      size: resource.fileSize,
      createdAt: Date.now(),
      kind: 'githubSnapshot',
    }))
    service.prune = vi.fn(async () => 0)
    await service.createBackup()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    service.reuseUnchangedStructuredBackup = vi.fn(async () => ({
      id: 'manifest-1',
      objectKey: 'snapshot.srlmanifest.v3.json.gz',
      size: resource.fileSize,
      createdAt: Date.now(),
      kind: 'githubSnapshot',
    }))
    await service.createBackup()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('公开 GitHub 仓库会在社区内容上传前被服务层阻断', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(githubRepositoryResponse(200, false)))
    const service = createService()

    await expect(
      service.createBackup(
        { ...githubConfig, contentSelection: { communitySources: true } },
        'token',
      ),
    ).rejects.toThrow('已阻止上传 Discord 社区内容')
  })

  it('always confirms a GitHub asset with a remote GET even when POST reports the expected size', async () => {
    const service = createService() as unknown as {
      confirmGitHubAssetSize: (
        config: GitHubBackupConfig,
        secret: string,
        asset: unknown,
        size: number,
        hash?: string,
      ) => Promise<unknown>
      githubFetch: ReturnType<typeof vi.fn>
    }
    const asset = {
      id: 17,
      name: 'object.bin',
      size: 4,
      created_at: '2026-08-26T00:00:00.000Z',
      url: '',
    }
    service.githubFetch = vi.fn(async () => new Response(JSON.stringify(asset)))

    await expect(service.confirmGitHubAssetSize(githubConfig, 'token', asset, 4)).resolves.toEqual(
      asset,
    )
    expect(service.githubFetch).toHaveBeenCalledOnce()
    expect(service.githubFetch).toHaveBeenCalledWith(githubConfig, 'token', '/releases/assets/17')
  })

  it('rejects a same-size GitHub asset whose server SHA-256 differs from the planned object', async () => {
    const service = createService() as unknown as {
      confirmGitHubAssetSize: (
        config: GitHubBackupConfig,
        secret: string,
        asset: unknown,
        size: number,
        hash?: string,
      ) => Promise<unknown>
      githubFetch: ReturnType<typeof vi.fn>
    }
    const expectedHash = 'a'.repeat(64)
    const asset = {
      id: 18,
      name: 'srl-chunk--sha256-' + expectedHash,
      size: 4,
      state: 'uploaded',
      digest: `sha256:${'b'.repeat(64)}`,
      created_at: '2026-08-26T00:00:00.000Z',
      url: '',
    }
    service.githubFetch = vi.fn(async () => new Response(JSON.stringify(asset)))

    await expect(
      service.confirmGitHubAssetSize(githubConfig, 'token', asset, 4, expectedHash),
    ).resolves.toBeUndefined()
    expect(service.githubFetch).toHaveBeenCalledOnce()
  })

  it('deletes expired manifests before starting an orphan grace period', async () => {
    let now = Date.parse('2026-08-26T00:00:00.000Z')
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const service = createService() as unknown as {
      prune: (config: GitHubBackupConfig, secret: string) => Promise<number>
      listRetentionBackups: ReturnType<typeof vi.fn>
      readGitHubStructuredSnapshot: ReturnType<typeof vi.fn>
      getGitHubRelease: ReturnType<typeof vi.fn>
      listGitHubAssets: ReturnType<typeof vi.fn>
      githubFetch: ReturnType<typeof vi.fn>
    }
    const current = {
      id: '1',
      objectKey: 'current.srlmanifest.v3.json.gz',
      size: 1,
      createdAt: 2,
      kind: 'githubSnapshot' as const,
    }
    const expired = {
      ...current,
      id: '2',
      objectKey: 'expired.srlmanifest.v3.json.gz',
      createdAt: 1,
    }
    service.listRetentionBackups = vi
      .fn()
      .mockResolvedValueOnce([current, expired])
      .mockResolvedValue([current])
    service.readGitHubStructuredSnapshot = vi.fn(async () => ({
      format: 'srl-structured-cloud-snapshot',
      version: 3,
      createdAt: '2026-08-26T00:00:00.000Z',
      categories: [],
      resources: [],
      versions: [],
      portableData: { version: 1 },
    }))
    service.getGitHubRelease = vi.fn(async (_config, _secret, _create, tag) =>
      tag === 'srl-cloud-objects-0001' ? { id: 41 } : undefined,
    )
    service.listGitHubAssets = vi.fn(async () => [
      {
        id: 99,
        name: `srl-chunk--sha256-${'a'.repeat(64)}`,
        size: 4,
        created_at: '2020-01-01T00:00:00.000Z',
        url: '',
      },
    ])
    service.githubFetch = vi.fn(async () => new Response(null, { status: 204 }))

    await expect(service.prune({ ...githubConfig, retention: 1 }, 'token')).resolves.toBe(1)
    expect(service.githubFetch).toHaveBeenCalledTimes(1)
    expect(service.githubFetch.mock.calls[0]?.[2]).toBe('/releases/assets/2')

    now += 24 * 60 * 60 * 1000
    await expect(service.prune({ ...githubConfig, retention: 1 }, 'token')).resolves.toBe(0)
    // Normal automatic maintenance does not enumerate unrelated remote chunks.
    expect(service.githubFetch).toHaveBeenCalledTimes(1)
    expect(service.listGitHubAssets).not.toHaveBeenCalled()
  })

  it('never collects a chunk still referenced by an expired history snapshot', async () => {
    const partHash = 'b'.repeat(64)
    const service = createService() as unknown as {
      prune: (config: GitHubBackupConfig, secret: string) => Promise<number>
      listRetentionBackups: ReturnType<typeof vi.fn>
      readGitHubStructuredSnapshot: ReturnType<typeof vi.fn>
      getGitHubRelease: ReturnType<typeof vi.fn>
      listGitHubAssets: ReturnType<typeof vi.fn>
      githubFetch: ReturnType<typeof vi.fn>
    }
    const current = {
      id: 'current',
      objectKey: 'current.srlmanifest.v3.json.gz',
      size: 1,
      createdAt: 2,
      kind: 'githubSnapshot' as const,
    }
    const expired = {
      ...current,
      id: 'expired',
      objectKey: 'older.srlmanifest.v3.json.gz',
      createdAt: 1,
    }
    service.listRetentionBackups = vi.fn(async () => [current, expired])
    service.readGitHubStructuredSnapshot = vi.fn(async (_config, _secret, item) => ({
      format: 'srl-structured-cloud-snapshot',
      version: 3,
      createdAt: '2026-08-26T00:00:00.000Z',
      categories: [],
      resources: [],
      versions:
        item.id === 'expired'
          ? [
              {
                id: 'historical-version',
                fileSize: 4,
                contentHash: partHash,
                object: {
                  format: 'srl-github-backup-bundle',
                  version: 2,
                  createdAt: '2026-08-26T00:00:00.000Z',
                  fileName: 'small.json',
                  totalSize: 4,
                  totalSha256: partHash,
                  parts: [{ name: `srl-chunk--sha256-${partHash}`, size: 4, sha256: partHash }],
                },
              },
            ]
          : [],
      portableData: { version: 1 },
    }))
    service.getGitHubRelease = vi.fn(async (_config, _secret, _create, tag) =>
      tag === 'srl-cloud-objects-0001' ? { id: 41 } : undefined,
    )
    service.listGitHubAssets = vi.fn(async () => [
      { id: 99, name: `srl-chunk--sha256-${partHash}`, size: 4, created_at: '', url: '' },
    ])
    service.githubFetch = vi.fn(async () => new Response(null, { status: 204 }))

    await expect(service.prune({ ...githubConfig, retention: 1 }, 'token')).resolves.toBe(1)

    expect(service.githubFetch).toHaveBeenCalledTimes(1)
    expect(service.githubFetch).toHaveBeenCalledWith(
      { ...githubConfig, retention: 1 },
      'token',
      '/releases/assets/expired',
      { method: 'DELETE' },
    )
  })

  it('atomically keeps the old credential when a replacement fails validation', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(githubRepositoryResponse())
      .mockResolvedValueOnce(githubRepositoryResponse(401))
      .mockResolvedValueOnce(githubRepositoryResponse())
    vi.stubGlobal('fetch', fetchMock)
    const service = createService()
    await service.saveConfig(githubConfig, 'old-token')
    await expect(service.saveConfig(githubConfig, 'bad-new-token')).rejects.toThrow(/401/)
    expect(service.getSnapshot().credentials.github).toBe('valid')
    await service.testConnection(githubConfig)
    expect(new Headers(fetchMock.mock.calls.at(-1)?.[1]?.headers).get('authorization')).toBe(
      'Bearer old-token',
    )
  })

  it('invalidates GitHub only on 401, not on 403, 404, or network errors', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(githubRepositoryResponse())
      .mockResolvedValueOnce(githubRepositoryResponse(403))
      .mockResolvedValueOnce(
        new Response('{}', { status: 404, headers: { 'x-srl-cloud-proxy': '1' } }),
      )
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(githubRepositoryResponse(401))
    vi.stubGlobal('fetch', fetchMock)
    const service = createService()
    await service.saveConfig(githubConfig, 'saved-token')
    // SRL-PUBLIC-SYNC: BEGIN REPLACE id=public-cloudbackupservice-test-ts-2
    for (const expected of [/403/, /404/, /没有收到 GitHub 请求/]) {
      // SRL-PUBLIC-SYNC: END REPLACE id=public-cloudbackupservice-test-ts-2
      await expect(service.testConnection(githubConfig)).rejects.toThrow(expected)
      expect(service.getSnapshot().credentials.github).toBe('valid')
    }
    await expect(service.testConnection(githubConfig)).rejects.toThrow(/401/)
    expect(service.getSnapshot().credentials.github).toBe('invalid')
  })

  it('invalidates Koofr only on a confirmed 401', async () => {
    const response = (status: number) =>
      new Response(status === 204 ? null : '', {
        status,
        headers: { 'X-SRL-Cloud-Proxy': '1' },
      })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(405))
      .mockResolvedValueOnce(response(405))
      .mockResolvedValueOnce(response(405))
      .mockResolvedValueOnce(response(201))
      .mockResolvedValueOnce(response(204))
      .mockResolvedValueOnce(response(403))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(response(401))
    vi.stubGlobal('fetch', fetchMock)
    const service = createService()
    await service.saveConfig(webDavConfig, 'saved-password')
    await expect(service.testConnection(webDavConfig)).rejects.toThrow(/403/)
    expect(service.getSnapshot().credentials.webdav).toBe('valid')
    await expect(service.testConnection(webDavConfig)).rejects.toThrow(
      // SRL-PUBLIC-SYNC: BEGIN REPLACE id=koofr-worker-error-assertion
      /自建中继未完成 Koofr 请求/,
      // SRL-PUBLIC-SYNC: END REPLACE id=koofr-worker-error-assertion
    )
    expect(service.getSnapshot().credentials.webdav).toBe('valid')
    await expect(service.testConnection(webDavConfig)).rejects.toThrow(/401/)
    expect(service.getSnapshot().credentials.webdav).toBe('invalid')
  })

  // SRL-PUBLIC-SYNC: BEGIN REPLACE id=public-cloudbackupservice-test-ts-4
  it('routes Web GitHub API and release asset requests through the configured Worker', async () => {
    // SRL-PUBLIC-SYNC: END REPLACE id=public-cloudbackupservice-test-ts-4
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('{}', { status: 201, headers: { 'x-srl-cloud-proxy': '1' } })),
    )
    vi.stubGlobal('fetch', fetchMock)
    const service = createService() as unknown as {
      cloudFetch: (url: string, init: RequestInit, provider: 'github') => Promise<Response>
    }
    const body = new Blob([new Uint8Array([1, 2, 3])])
    await service.cloudFetch(
      'https://uploads.github.com/repos/owner/repo/releases/1/assets',
      { method: 'POST', body },
      'github',
    )
    expect(fetchMock).toHaveBeenCalledOnce()
    // SRL-PUBLIC-SYNC: BEGIN REPLACE id=public-cloudbackupservice-test-ts-5
    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      'https://worker.example/api/cloud/proxy/github?url=',
    )
    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe('omit')
    // SRL-PUBLIC-SYNC: END REPLACE id=public-cloudbackupservice-test-ts-5
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toBeInstanceOf(Headers)
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Headers).get('X-SRL-Content-Length')).toBe('3')
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(body)

    await service.cloudFetch('https://api.github.com/repos/owner/repo', {}, 'github')
    // SRL-PUBLIC-SYNC: BEGIN REPLACE id=public-cloudbackupservice-test-ts-6
    expect(fetchMock.mock.calls[1]?.[0]).toContain(
      'https://worker.example/api/cloud/proxy/github?url=',
    )
    expect(fetchMock.mock.calls[1]?.[1]?.credentials).toBe('omit')
  })

  it('keeps Web GitHub requests direct until the user configures a Worker', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('{}', { status: 200 })),
    )
    vi.stubGlobal('fetch', fetchMock)
    localStorage.removeItem('srl.publicWorker.baseUrl.v1')
    const service = createService() as unknown as {
      cloudFetch: (url: string, init: RequestInit, provider: 'github') => Promise<Response>
    }

    await service.cloudFetch('https://api.github.com/repos/owner/repo', {}, 'github')

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.github.com/repos/owner/repo')
    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBeUndefined()
    // SRL-PUBLIC-SYNC: END REPLACE id=public-cloudbackupservice-test-ts-6
  })

  it('deletes a same-name incomplete GitHub chunk only when the local SHA-256 matches', async () => {
    const blob = new Blob(['valid chunk bytes'])
    const hash = await hashCloudBlob(blob)
    const name = `srl-chunk--sha256-${hash}`
    const service = createService() as unknown as {
      cloudFetch: ReturnType<typeof vi.fn>
      githubFetch: ReturnType<typeof vi.fn>
      listGitHubAssets: ReturnType<typeof vi.fn>
      uploadGitHubAsset: (
        config: GitHubBackupConfig,
        secret: string,
        releaseId: number,
        name: string,
        blob: Blob,
        contentType: string,
      ) => Promise<unknown>
    }
    service.cloudFetch = vi.fn(
      async () => new Response('{"message":"already_exists"}', { status: 422 }),
    )
    service.githubFetch = vi.fn(async () => new Response(null, { status: 204 }))
    service.listGitHubAssets = vi.fn(async () => [
      {
        id: 73,
        name,
        size: blob.size - 1,
        created_at: '2026-10-16T00:00:00.000Z',
        url: '',
      },
    ])

    await expect(
      service.uploadGitHubAsset(githubConfig, 'token', 41, name, blob, 'application/octet-stream'),
    ).rejects.toThrow('已删除残缺附件，正在重试上传')
    expect(service.githubFetch).toHaveBeenCalledWith(githubConfig, 'token', '/releases/assets/73', {
      method: 'DELETE',
    })
  })

  it('rechecks GitHub assets after an already-exists response is not yet visible', async () => {
    const blob = new Blob(['already uploaded chunk'])
    const name = `srl-chunk--sha256-${await hashCloudBlob(blob)}`
    const service = createService() as unknown as {
      cloudFetch: ReturnType<typeof vi.fn>
      listGitHubAssets: ReturnType<typeof vi.fn>
      uploadGitHubAsset: (
        config: GitHubBackupConfig,
        secret: string,
        releaseId: number,
        name: string,
        blob: Blob,
        contentType: string,
      ) => Promise<{ id: number; name: string; size: number; state: string }>
    }
    service.cloudFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            message: 'Validation Failed',
            errors: [{ resource: 'ReleaseAsset', code: 'already_exists', field: 'name' }],
          }),
          { status: 422 },
        ),
    )
    service.listGitHubAssets = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 74,
          name,
          size: blob.size,
          digest: `sha256:${await hashCloudBlob(blob)}`,
          state: 'uploaded',
          created_at: '2026-10-17T00:00:00.000Z',
          url: '',
        },
      ])

    await expect(
      service.uploadGitHubAsset(githubConfig, 'token', 41, name, blob, 'application/octet-stream'),
    ).resolves.toMatchObject({ id: 74, name, size: blob.size, state: 'uploaded' })
    expect(service.listGitHubAssets).toHaveBeenCalledTimes(2)
  })

  // SRL-PUBLIC-SYNC: BEGIN REPLACE id=koofr-worker-proxy-test
  it('sends Web Koofr through the configured Worker proxy with the original binary body', async () => {
    localStorage.setItem('srl.publicWorker.baseUrl.v1', 'https://worker.example')
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('', {
        status: 201,
        headers: { 'X-SRL-Cloud-Proxy': '1' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const service = createService() as unknown as {
      cloudFetch: (url: string, init: RequestInit, provider: 'webdav') => Promise<Response>
    }
    const body = new Blob([new Uint8Array([4, 5, 6])])
    await service.cloudFetch(
      'https://app.koofr.net/dav/Koofr/SRL-Backups/objects/a',
      { method: 'PUT', body },
      'webdav',
    )
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      'https://worker.example/api/cloud/proxy/koofr?url=',
    )
    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe('omit')
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(body)
  })
  // SRL-PUBLIC-SYNC: END REPLACE id=koofr-worker-proxy-test

  it('rotates GitHub immutable object containers at the 900-object threshold', async () => {
    const service = createService() as unknown as {
      getGitHubRelease: ReturnType<typeof vi.fn>
      listGitHubObjectContainers: ReturnType<typeof vi.fn>
      listGitHubAssets: ReturnType<typeof vi.fn>
      uploadGitHubAsset: ReturnType<typeof vi.fn>
      confirmGitHubAssetSize: ReturnType<typeof vi.fn>
      uploadGitHubStructuredBackup: (
        config: GitHubBackupConfig,
        secret: string,
        snapshot: CreatedStructuredSnapshot,
      ) => Promise<unknown>
    }
    service.listGitHubObjectContainers = vi.fn(async () => [
      { id: 20, tag_name: 'srl-cloud-objects-0001' },
    ])
    let secondContainerCreated = false
    let nextAssetId = 0
    service.getGitHubRelease = vi.fn(async (_config, _secret, create, tag) => {
      if (tag === 'srl-cloud-snapshots') return { id: 10 }
      if (tag === 'srl-cloud-objects-0001') return { id: 20 }
      if (tag === 'srl-cloud-objects-0002' && create) {
        secondContainerCreated = true
        return { id: 30 }
      }
      return undefined
    })
    service.listGitHubAssets = vi.fn(async (_config, _secret, releaseId: number) =>
      releaseId === 20
        ? Array.from({ length: 899 }, (_, index) => ({
            id: index + 1,
            name: `old-${index}`,
            size: 1,
            created_at: '2026-08-01T00:00:00Z',
          }))
        : [],
    )
    service.uploadGitHubAsset = vi.fn(async (_config, _secret, releaseId, name, blob) => ({
      id: ++nextAssetId,
      name,
      size: blob.size,
      digest: `sha256:${/^srl-chunk--sha256-([a-f0-9]{64})$/u.exec(String(name))?.[1] ?? (await hashCloudBlob(blob))}`,
      state: 'uploaded',
      created_at: '2026-08-26T00:00:00Z',
      releaseId,
    }))
    service.confirmGitHubAssetSize = vi.fn(async (_config, _secret, asset) => asset)
    await service.uploadGitHubStructuredBackup(
      githubConfig,
      'token',
      createdSnapshot(['a'.repeat(64), 'b'.repeat(64)]),
    )
    expect(secondContainerCreated).toBe(true)
    expect(
      service.uploadGitHubAsset.mock.calls
        .filter((call) => String(call[3]).startsWith('srl-chunk--sha256-'))
        .map((call) => call[2]),
    ).toEqual([20, 30])
    expect(service.confirmGitHubAssetSize).toHaveBeenCalledOnce()
  })

  it('never commits the GitHub manifest when the current object still fails', async () => {
    const service = createService() as unknown as {
      getGitHubRelease: ReturnType<typeof vi.fn>
      listGitHubObjectContainers: ReturnType<typeof vi.fn>
      listGitHubAssets: ReturnType<typeof vi.fn>
      uploadGitHubAsset: ReturnType<typeof vi.fn>
      uploadGitHubStructuredBackup: (
        config: GitHubBackupConfig,
        secret: string,
        snapshot: CreatedStructuredSnapshot,
      ) => Promise<unknown>
    }
    service.getGitHubRelease = vi.fn(async (_config, _secret, create, tag) => {
      if (tag === 'srl-cloud-snapshots') return { id: 10 }
      if (tag === 'srl-cloud-objects-0001') return create ? { id: 20 } : undefined
      return undefined
    })
    service.listGitHubAssets = vi.fn(async () => [])
    service.listGitHubObjectContainers = vi.fn(async () => [])
    service.uploadGitHubAsset = vi.fn(async () => {
      throw new Error('network down')
    })
    await expect(
      service.uploadGitHubStructuredBackup(githubConfig, 'token', createdSnapshot()),
    ).rejects.toThrow('未提交快照清单')
    expect(service.uploadGitHubAsset).toHaveBeenCalledTimes(3)
  })

  it('commits a Koofr snapshot manifest only after all objects are verified', async () => {
    const calls: string[] = []
    const service = createService() as unknown as {
      ensureWebDavFolder: ReturnType<typeof vi.fn>
      listWebDavObjects: ReturnType<typeof vi.fn>
      uploadWebDavObject: ReturnType<typeof vi.fn>
      uploadWebDavStructuredBackup: (
        config: WebDavBackupConfig,
        secret: string,
        snapshot: CreatedStructuredSnapshot,
      ) => Promise<unknown>
    }
    service.ensureWebDavFolder = vi.fn(async () => undefined)
    service.listWebDavObjects = vi.fn(async () => [])
    service.uploadWebDavObject = vi.fn(async (_config, _secret, key) => {
      calls.push(key)
    })
    await service.uploadWebDavStructuredBackup(webDavConfig, 'password', createdSnapshot())
    expect(calls[0]).toMatch(/^objects\/srl-chunk--sha256-/)
    expect(calls.at(-1)).toMatch(/^snapshots\/.*\.srlmanifest\.v3\.json\.gz$/)
  })

  it.each(['snapshots', 'objects'] as const)(
    'preserves the committed backup and %s maintenance result',
    async (stage) => {
      const resource = cloudResource('a'.repeat(64))
      const service = createService(
        {
          listSummaries: vi.fn(async () => [resource]),
          listVersions: vi.fn(async () => []),
          listVersionSummaries: vi.fn(async () => []),
          get: vi.fn(async () => resource),
        } as unknown as ResourceService,
        { list: vi.fn(async () => []) } as unknown as CategoryService,
      )
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(githubRepositoryResponse()))
      await service.saveConfig(githubConfig, 'token')
      const maintenance = new CloudBackupMaintenanceError(
        stage,
        1,
        2,
        'github',
        new Error('Connection interrupted'),
      )
      Object.assign(service, {
        buildStructuredBackup: vi.fn(async () => createdSnapshot()),
        uploadGitHubStructuredBackup: vi.fn(async () => ({
          id: 'committed',
          objectKey: 'snapshot.srlmanifest.v3.json.gz',
          size: 1,
          createdAt: Date.now(),
          kind: 'githubSnapshot',
        })),
        prune: vi.fn(async () => {
          throw maintenance
        }),
      })
      await expect(service.createBackup()).resolves.toMatchObject({
        id: 'committed',
        maintenanceWarning: `新对象快照已上传成功；${maintenance.message}`,
      })
    },
  )

  it('uses the no-op reuse path when the local fingerprint is unchanged', async () => {
    const resource = cloudResource('a'.repeat(64))
    resource.contentHash = await crypto.subtle
      .digest('SHA-256', await resource.originalBlob.arrayBuffer())
      .then((value) =>
        [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
      )
    const resourceService = {
      listSummaries: vi.fn(async () => [resource]),
      listVersions: vi.fn(async () => []),
      listVersionSummaries: vi.fn(async () => []),
      get: vi.fn(async () => resource),
      updateBackupDescriptor: vi.fn(async () => undefined),
    } as unknown as ResourceService
    const categoryService = { list: vi.fn(async () => []) } as unknown as CategoryService
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(githubRepositoryResponse()))
    const service = createService(resourceService, categoryService) as unknown as {
      saveConfig: CloudBackupService['saveConfig']
      createBackup: CloudBackupService['createBackup']
      uploadGitHubStructuredBackup: ReturnType<typeof vi.fn>
      prune: ReturnType<typeof vi.fn>
      reuseUnchangedStructuredBackup: ReturnType<typeof vi.fn>
    }
    await service.saveConfig(githubConfig, 'token')
    service.uploadGitHubStructuredBackup = vi.fn(async () => ({
      id: 'manifest-1',
      objectKey: 'snapshot.srlmanifest.v3.json.gz',
      size: resource.fileSize,
      createdAt: Date.now(),
      kind: 'githubSnapshot',
    }))
    service.prune = vi.fn(async () => 0)
    await service.createBackup()
    expect(service.prune).toHaveBeenCalledWith(
      expect.objectContaining(githubConfig),
      'token',
      'snapshot.srlmanifest.v3.json.gz',
      false,
      expect.objectContaining({ version: 3 }),
      expect.any(Function),
    )
    service.reuseUnchangedStructuredBackup = vi.fn(async () => ({
      id: 'manifest-1',
      objectKey: 'snapshot.srlmanifest.v3.json.gz',
      size: resource.fileSize,
      createdAt: Date.now(),
      kind: 'githubSnapshot',
    }))
    const second = await service.createBackup()
    expect(second.unchanged).toBe(true)
    expect(resourceService.listSummaries).toHaveBeenCalledTimes(2)
    expect(resourceService.listVersionSummaries).toHaveBeenCalledTimes(2)
    expect(categoryService.list).toHaveBeenCalledTimes(2)
    expect(service.uploadGitHubStructuredBackup).toHaveBeenCalledOnce()
    expect(resourceService.get).toHaveBeenCalledOnce()
  })

  it('restores V3 resources directly without materializing a giant ZIP', async () => {
    const resource = cloudResource('a'.repeat(64))
    const restore = {
      prepare: vi.fn(),
      restoreStructured: vi.fn(async () => ({ restoredResources: 1 })),
    } as unknown as RestoreService
    const service = createService(
      { listResourceListSummaries: vi.fn(async () => []) } as unknown as ResourceService,
      { list: vi.fn(async () => []) } as unknown as CategoryService,
      {} as ExportService,
      restore,
    ) as unknown as {
      saveConfig: CloudBackupService['saveConfig']
      restoreBackup: CloudBackupService['restoreBackup']
      readGitHubStructuredSnapshot: ReturnType<typeof vi.fn>
      createGitHubObjectReader: ReturnType<typeof vi.fn>
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(githubRepositoryResponse()))
    await service.saveConfig(githubConfig, 'token')
    service.readGitHubStructuredSnapshot = vi.fn(async () => createdSnapshot().snapshot)
    service.createGitHubObjectReader = vi.fn(async () => async () => resource.originalBlob)
    await expect(
      service.restoreBackup({
        id: '1',
        objectKey: 'snapshot.srlmanifest.v3.json.gz',
        size: resource.fileSize,
        createdAt: Date.now(),
        kind: 'githubSnapshot',
      }),
    ).resolves.toBe(1)
    expect(restore.restoreStructured).toHaveBeenCalledWith(
      expect.objectContaining({ version: 3 }),
      expect.any(Function),
      [],
      [],
      expect.any(String),
      expect.objectContaining({ signal: expect.any(AbortSignal), onFailure: expect.any(Function) }),
    )
    expect(restore.prepare).not.toHaveBeenCalled()
  })

  it.each([true, false])(
    'honors gallery selection through the cloud ZIP importer (%s)',
    async (includeGallery) => {
      const owner = cloudResource('a'.repeat(64))
      const image = {
        ...cloudResource('b'.repeat(64), 'gallery'),
        metadata: {
          assetKind: 'resource-gallery-image',
          galleryOwnerId: owner.id,
          galleryVisible: true,
        },
      }
      const catalog = { other: ['预览图', '空分类'] }
      const prepared = {
        resources: [owner, image],
        versions: [],
        categories: [],
        preview: { mode: 'full', createdAt: new Date().toISOString() },
        portableData: {
          version: 1,
          resourceGalleryCategories: catalog,
          appearance: { theme: 'dark' },
        },
      } as unknown as PreparedRestore
      const restore = {
        prepare: vi.fn(async () => prepared),
        restore: vi.fn(async (plan: PreparedRestore) => ({
          restoredResources: plan.resources.length,
        })),
      }
      const imported = vi.fn(async (_data: ArchivePortableData) => {})
      const service = new CloudBackupService(
        { listResourceListSummaries: vi.fn(async () => []) } as unknown as ResourceService,
        { list: vi.fn(async () => []) } as unknown as CategoryService,
        {} as ExportService,
        restore as unknown as RestoreService,
        undefined,
        imported,
      )
      vi.spyOn(service, 'downloadBackup').mockResolvedValue(new Blob(['archive']))
      await service.restoreBackup(
        { id: 'zip', objectKey: 'backup.zip', size: 7, createdAt: 1 },
        undefined,
        [owner.id],
        includeGallery,
      )
      expect(restore.restore.mock.calls[0]![0].resources.map((r) => r.id)).toEqual(
        includeGallery ? [owner.id, image.id] : [owner.id],
      )
      expect(imported).toHaveBeenCalledOnce()
      expect(imported.mock.calls[0]![0].resourceGalleryCategories).toEqual(
        includeGallery ? catalog : undefined,
      )
      expect(imported.mock.calls[0]![0].appearance).toEqual({ theme: 'dark' })
      expect(prepared.portableData?.resourceGalleryCategories).toEqual(catalog)
    },
  )

  it('lists every V3 resource and filters cloud restore by unique resource ID', async () => {
    const first = 'a'.repeat(64)
    const second = 'b'.repeat(64)
    const snapshot = createdSnapshot([first, first, second]).snapshot
    snapshot.resources[1] = { ...snapshot.resources[1]!, id: 'same-content-different-resource' }
    const restore = {
      restoreStructured: vi.fn(async () => ({ restoredResources: 1 })),
    } as unknown as RestoreService
    const service = createService(
      { listResourceListSummaries: vi.fn(async () => []) } as unknown as ResourceService,
      { list: vi.fn(async () => []) } as unknown as CategoryService,
      {} as ExportService,
      restore,
    ) as unknown as {
      saveConfig: CloudBackupService['saveConfig']
      listBackupResources: CloudBackupService['listBackupResources']
      restoreBackup: CloudBackupService['restoreBackup']
      readGitHubStructuredSnapshot: ReturnType<typeof vi.fn>
      createGitHubObjectReader: ReturnType<typeof vi.fn>
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(githubRepositoryResponse()))
    await service.saveConfig(githubConfig, 'token')
    service.readGitHubStructuredSnapshot = vi.fn(async () => snapshot)
    service.createGitHubObjectReader = vi.fn(async () => async () => new Blob(['object']))

    const item = {
      id: '1',
      objectKey: 'snapshot.srlmanifest.v3.json.gz',
      size: 1,
      createdAt: Date.now(),
      kind: 'githubSnapshot' as const,
    }
    const listed = await service.listBackupResources(item)
    expect(listed.map((resource) => resource.id)).toEqual([
      snapshot.resources[0]!.id,
      'same-content-different-resource',
      snapshot.resources[2]!.id,
    ])

    await service.restoreBackup(item, undefined, ['same-content-different-resource'])
    expect(restore.restoreStructured).toHaveBeenCalledWith(
      expect.objectContaining({
        resources: [
          expect.objectContaining({ id: 'same-content-different-resource', contentHash: first }),
        ],
        versions: [],
      }),
      expect.any(Function),
      [],
      [],
      expect.any(String),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })
})

describe('cloud restore selection session', () => {
  function session(importer?: (data: ArchivePortableData) => Promise<void>) {
    const resources = vi.fn(async () => [] as Resource[])
    const restore = {
      prepare: vi.fn(),
      restore: vi.fn(async () => ({ restoredResources: 1 })),
      restoreStructured: vi.fn(async () => ({ restoredResources: 1 })),
    }
    const service = new CloudBackupService(
      { listResourceListSummaries: resources } as unknown as ResourceService,
      { list: vi.fn(async () => []) } as unknown as CategoryService,
      {} as ExportService,
      restore as unknown as RestoreService,
      undefined,
      importer,
    )
    const state = { config: { ...githubConfig }, secret: 'fixture' }
    const snapshot = vi.fn(async () => createdSnapshot().snapshot)
    const download = vi.fn(async () => new Blob(['zip']))
    Object.assign(service, {
      initializeCredentials: async () => undefined,
      getActiveConfig: () => state.config,
      requireSecret: () => state.secret,
      readGitHubStructuredSnapshot: snapshot,
      createGitHubObjectReader: async () => vi.fn(),
      downloadBackup: download,
    })
    const item = {
      id: '1',
      objectKey: 'snapshot.srlmanifest.v3.json.gz',
      kind: 'githubSnapshot' as const,
      size: 1,
      createdAt: 1,
    }
    return { service, state, snapshot, download, restore, resources, item }
  }

  it('coalesces concurrent preview reads, reuses the manifest for import, then releases it', async () => {
    const { service, snapshot, restore, item } = session()
    const [first, second] = await Promise.all([
      service.listBackupRestoreContents(item),
      service.listBackupRestoreContents(item),
    ])
    expect(first).toBe(second)
    expect(snapshot).toHaveBeenCalledOnce()
    await service.restoreBackup(item)
    expect(snapshot).toHaveBeenCalledOnce()
    expect(restore.restoreStructured).toHaveBeenCalledOnce()
    await service.listBackupRestoreContents(item)
    expect(snapshot).toHaveBeenCalledTimes(2)
    await service.clearRestorePreview()
  })

  it.each(['target', 'credential'] as const)(
    'rejects an old selection after its %s changes',
    async (change) => {
      const { service, state, restore, snapshot, item } = session()
      await service.listBackupRestoreContents(item)
      if (change === 'target') state.config.repository = 'another-backup'
      else state.secret = 'new-credential'
      await expect(service.restoreBackup(item)).rejects.toThrow('已变化')
      expect(restore.restoreStructured).not.toHaveBeenCalled()
      await service.listBackupRestoreContents(item)
      expect(snapshot).toHaveBeenCalledTimes(2)
      await service.clearRestorePreview()
    },
  )

  it('does not retain failed reads or expose late preview results after closing', async () => {
    const { service, snapshot, item } = session()
    snapshot.mockRejectedValueOnce(new Error('read failed'))
    await expect(service.listBackupRestoreContents(item)).rejects.toThrow('read failed')
    let finish!: (snapshot: StructuredSnapshot) => void
    snapshot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const pending = service.listBackupRestoreContents(item)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const closing = service.clearRestorePreview()
    finish(createdSnapshot().snapshot)
    await rejected
    await closing
    await service.listBackupRestoreContents(item)
    expect(snapshot).toHaveBeenCalledTimes(3)
    await service.clearRestorePreview()
  })

  it('downloads and extracts a ZIP once, remapping preview conflict IDs after metadata replanning', async () => {
    const { service, download, restore, item } = session()
    const dispose = vi.fn()
    const source = cloudResource('a'.repeat(64), 'preview-conflict')
    const fresh = { ...source, id: 'commit-conflict' }
    const prepared: PreparedRestore = {
      resources: [source],
      versions: [],
      categories: [],
      sourceResourceIds: [['archived-id', source.id]],
      preview: {
        fileName: 'backup.zip',
        mode: 'full',
        createdAt: '',
        archiveResourceCount: 1,
        resourcesToAdd: 1,
        duplicatesToSkip: 0,
        conflictsToPreserve: 1,
        categoriesToCreate: 0,
        categoriesToReuse: 0,
      },
      dispose,
    }
    prepared.replan = vi.fn(async (): Promise<PreparedRestore> => ({
      ...prepared,
      resources: [fresh],
      sourceResourceIds: [['archived-id', fresh.id]],
    }))
    restore.prepare.mockResolvedValue(prepared)
    const zip = { ...item, kind: 'single' as const, objectKey: 'backup.zip' }
    const listed = await service.listBackupRestoreContents(zip)
    expect(listed.resources[0]?.id).toBe(source.id)
    expect(dispose).not.toHaveBeenCalled()
    await service.restoreBackup(zip, undefined, [source.id])
    expect(download).toHaveBeenCalledOnce()
    expect(restore.prepare).toHaveBeenCalledOnce()
    expect(prepared.replan).toHaveBeenCalledOnce()
    expect(restore.restore).toHaveBeenCalledWith(
      expect.objectContaining({ resources: [fresh] }),
      undefined,
      undefined,
    )
  })

  it('retains successful resource descriptors for ID remapping and album ancestors during failed-item retry', async () => {
    vi.stubGlobal('localStorage', new MemoryStorage())
    vi.stubGlobal('sessionStorage', new MemoryStorage())
    const { service, snapshot, restore, item } = session()
    const original = createdSnapshot(['a'.repeat(64), 'b'.repeat(64)]).snapshot
    original.version = 5
    original.portableData.generatedImageAlbum = [
      { item: { id: 'grandparent' } },
      { item: { id: 'parent', generationManifest: { parentImageId: 'grandparent' } } },
      { item: { id: 'child', generationManifest: { parentImageId: 'parent' } } },
      { item: { id: 'unrelated' } },
    ] as unknown as NonNullable<ArchivePortableData['generatedImageAlbum']>
    snapshot.mockResolvedValue(original)
    await service.restoreBackup(item, undefined, undefined, true, undefined, undefined, {
      retryFailures: [
        {
          kind: 'resource',
          id: original.resources[0]!.id,
          fileName: 'failed.bin',
          error: 'offline',
        },
        { kind: 'album', id: 'child', fileName: 'child.png', error: 'offline' },
      ],
    })
    const selected = (restore.restoreStructured.mock.calls[0] as unknown as [StructuredSnapshot])[0]
    expect(selected.resources.map((row) => row.id)).toEqual(original.resources.map((row) => row.id))
    expect(selected.portableData.generatedImageAlbum?.map((entry) => entry.item.id)).toEqual([
      'grandparent',
      'parent',
      'child',
    ])
  })

  it('retries a failed original through the real shared planner without rereading successful originals', async () => {
    vi.stubGlobal('localStorage', new MemoryStorage())
    vi.stubGlobal('sessionStorage', new MemoryStorage())
    const { service, snapshot, resources, item } = session()
    const originals = await Promise.all(
      ['failed', 'saved'].map(async (id) => {
        const originalBlob = new Blob([id])
        return {
          ...cloudResource(await hashCloudBlob(originalBlob), id),
          originalBlob,
          fileSize: originalBlob.size,
        }
      }),
    )
    snapshot.mockResolvedValue(
      (await createStructuredSnapshot(originals, [], [], { version: 1 })).snapshot,
    )
    const saved: Resource[] = []
    resources.mockImplementation(async () => saved)
    let fail = true
    const read = vi.fn(async (object: import('./GitHubBackupBundle').GitHubBundleManifest) => {
      if (fail && object.fileName === originals[0]!.fileName) throw new Error('offline')
      return originals.find((row) => row.fileName === object.fileName)!.originalBlob
    })
    Object.assign(service, {
      createGitHubObjectReader: async () => read,
      restoreService: new RestoreService({
        replace: vi.fn(),
        restore: async (_categories, rows, _versions, hydrate) => {
          const ready = await Promise.all(rows.map((row) => (hydrate ? hydrate(row) : row)))
          saved.push(...ready)
        },
      }),
    })
    const committed = vi.fn()
    expect(
      await service.restoreBackup(item, undefined, undefined, true, undefined, committed),
    ).toBe(1)
    const failures = committed.mock.calls.at(-1)![0].failures
    expect(failures).toHaveLength(1)
    fail = false
    read.mockClear()
    expect(
      await service.restoreBackup(item, undefined, undefined, true, undefined, undefined, {
        retryFailures: failures,
      }),
    ).toBe(1)
    expect(read).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ fileName: originals[0]!.fileName }),
    )
    expect(saved).toHaveLength(2)
  })

  it('releases retained ZIP staging when closing the selection', async () => {
    const { service, restore, item } = session()
    const dispose = vi.fn()
    restore.prepare.mockResolvedValue({ resources: [], versions: [], categories: [], dispose })
    await service.listBackupRestoreContents({ ...item, kind: 'single', objectKey: 'backup.zip' })
    await service.clearRestorePreview()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('retries only additional data after resources committed, without rereading or reimporting originals', async () => {
    const importer = vi
      .fn()
      .mockRejectedValueOnce(new Error('settings failed'))
      .mockResolvedValue(undefined)
    const { service, snapshot, restore, item } = session(importer)
    await service.listBackupRestoreContents(item)
    const committed = vi.fn()
    await expect(
      service.restoreBackup(item, undefined, undefined, true, undefined, committed),
    ).resolves.toBe(1)
    expect(committed).toHaveBeenLastCalledWith(
      expect.objectContaining({
        failures: [expect.objectContaining({ kind: 'portableData', error: 'settings failed' })],
      }),
    )
    await expect(service.restoreBackup(item, undefined, [])).rejects.toThrow('保持原选择')
    await expect(service.restoreBackup(item)).resolves.toBe(1)
    expect(snapshot).toHaveBeenCalledOnce()
    expect(restore.restoreStructured).toHaveBeenCalledOnce()
    expect(importer).toHaveBeenCalledTimes(2)
  })
})

describe('cloud retention no-op', () => {
  it('reuses the committed manifest while checking expired snapshots', async () => {
    const service = createService() as unknown as {
      prune: (
        config: GitHubBackupConfig,
        secret: string,
        protectedObjectKey: string,
        deep: boolean,
        snapshot: StructuredSnapshot,
      ) => Promise<number>
      listRetentionBackups: ReturnType<typeof vi.fn>
      readGitHubStructuredSnapshot: ReturnType<typeof vi.fn>
      githubFetch: ReturnType<typeof vi.fn>
    }
    const current = {
      id: 'recent',
      objectKey: 'recent.srlmanifest.v3.json.gz',
      kind: 'githubSnapshot' as const,
      createdAt: 2,
      size: 10,
    }
    const expired = { ...current, id: 'expired', objectKey: 'expired.json.gz', createdAt: 1 }
    const snapshot: StructuredSnapshot = {
      format: 'srl-structured-cloud-snapshot',
      version: 3,
      createdAt: '2026-10-08T00:00:00.000Z',
      categories: [],
      resources: [],
      versions: [],
      portableData: { version: 1 },
    }
    service.listRetentionBackups = vi.fn(async () => [current, expired])
    service.readGitHubStructuredSnapshot = vi.fn(async (_config, _secret, item) => {
      if (item.id === current.id) throw new Error('unnecessary committed-manifest download')
      return snapshot
    })
    service.githubFetch = vi.fn(async () => new Response(null, { status: 204 }))
    expect(
      await service.prune(
        { ...githubConfig, retention: 1 },
        'token',
        current.objectKey,
        false,
        snapshot,
      ),
    ).toBe(1)
    expect(service.readGitHubStructuredSnapshot).toHaveBeenCalledOnce()
    expect(service.readGitHubStructuredSnapshot.mock.calls[0]?.[2]).toEqual(expired)
    expect(service.githubFetch).toHaveBeenCalledWith(
      { ...githubConfig, retention: 1 },
      'token',
      '/releases/assets/expired',
      { method: 'DELETE' },
    )
  })
  it('does not download retained manifests when no snapshot expired and no orphan is pending', async () => {
    const service = createService() as unknown as {
      prune: (config: GitHubBackupConfig, secret: string) => Promise<number>
      listRetentionBackups: ReturnType<typeof vi.fn>
      readGitHubStructuredSnapshot: ReturnType<typeof vi.fn>
    }
    service.listRetentionBackups = vi.fn(async () => [
      {
        id: 'recent',
        objectKey: 'recent.srlmanifest.v3.json.gz',
        kind: 'githubSnapshot',
        createdAt: 1,
        size: 10,
      },
    ])
    service.readGitHubStructuredSnapshot = vi.fn(async () => {
      throw new Error('unnecessary download')
    })
    expect(await service.prune(githubConfig, 'token')).toBe(0)
    expect(service.readGitHubStructuredSnapshot).not.toHaveBeenCalled()
  })
})

it('stops during preparation, rejects overlapping work, and releases the lock only after the original step settles', async () => {
  let finish!: (value: never[]) => void
  const summaries = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    .mockResolvedValue([])
  const service = createService(
    {
      listSummaries: summaries,
      listVersions: vi.fn(async () => []),
      listVersionSummaries: vi.fn(async () => []),
    } as unknown as ResourceService,
    { list: vi.fn(async () => []) } as unknown as CategoryService,
  )
  const upload = vi.fn(async () => ({
    id: 'fixture',
    objectKey: 'fixture',
    kind: 'githubSnapshot',
  }))
  Object.assign(service, { uploadGitHubStructuredBackup: upload, prune: vi.fn(async () => 0) })
  const pending = service.createBackup(githubConfig, 'fixture')
  const failure = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(summaries).toHaveBeenCalledTimes(1))
  const stopping = service.cancelActiveWebBackup()
  await expect(service.createBackup(githubConfig, 'fixture')).rejects.toThrow('已有云备份')
  expect(upload).not.toHaveBeenCalled()
  finish([])
  await failure
  expect(await stopping).toBe('cancelled')
  expect(upload).not.toHaveBeenCalled()
  await expect(service.createBackup(githubConfig, 'fixture')).resolves.toMatchObject({
    id: 'fixture',
  })
  expect(upload).toHaveBeenCalledTimes(1)
})
it('refuses cancellation once the final manifest commit begins and preserves the successful result', async () => {
  const service = createService(
    {
      listSummaries: vi.fn(async () => []),
      listVersions: vi.fn(async () => []),
      listVersionSummaries: vi.fn(async () => []),
    } as unknown as ResourceService,
    { list: vi.fn(async () => []) } as unknown as CategoryService,
  )
  let commit!: () => void
  let finish!: (value: { id: string; objectKey: string }) => void
  Object.assign(service, {
    uploadGitHubStructuredBackup: vi.fn(
      (_c, _s, _snapshot, _progress, _constraints, signal, beginCommit) => {
        expect(signal.aborted).toBe(false)
        commit = beginCommit
        return new Promise((resolve) => {
          finish = resolve
        })
      },
    ),
    prune: vi.fn(async () => 0),
  })
  const pending = service.createBackup(githubConfig, 'fixture')
  await vi.waitFor(() => expect(commit).toBeTypeOf('function'))
  commit()
  expect(await service.cancelActiveWebBackup()).toBe('committing')
  finish({ id: 'committed', objectKey: 'fixture' })
  await expect(pending).resolves.toMatchObject({ id: 'committed' })
})

describe('persistent web backup control', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.stubGlobal('localStorage', new MemoryStorage())
    vi.stubGlobal('sessionStorage', new MemoryStorage())
    vi.stubGlobal('indexedDB', new IDBFactory())
    // SRL-PUBLIC-SYNC: BEGIN REPLACE id=public-cloudbackupservice-test-ts-9
    localStorage.setItem('srl.publicWorker.baseUrl.v1', 'https://worker.example')
    // SRL-PUBLIC-SYNC: END REPLACE id=public-cloudbackupservice-test-ts-9
    noticeCenter.dismiss('web-cloud-backup')
  })
  function sessionService() {
    const service = createService(
      {
        listSummaries: vi.fn(async () => []),
        listVersions: vi.fn(async () => []),
        listVersionSummaries: vi.fn(async () => []),
      } as unknown as ResourceService,
      { list: vi.fn(async () => []) } as unknown as CategoryService,
    )
    Object.assign(service, {
      getActiveConfig: () => githubConfig,
      requireSecret: () => 'fixture',
      prune: vi.fn(async () => 0),
    })
    return service
  }
  it('retires the committed backup notice and optional task action without clearing backup state', async () => {
    const service = sessionService()
    let finish!: (value: { id: string; objectKey: string }) => void
    Object.assign(service, {
      uploadGitHubStructuredBackup: vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      ),
    })
    const pending = service.createBackup(githubConfig, 'fixture')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const id = service.getWebBackupState()!.operationId
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      finish({ id: 'committed', objectKey: 'manifest' })
      await pending
      expect(
        noticeCenter.list().find((notice) => notice.id === 'web-cloud-backup')?.persistent,
      ).toBe(false)
      expect(taskCenter.list().find((task) => task.operationId === id)?.actionRequired).toBe(false)
      vi.advanceTimersByTime(4_999)
      expect(taskCenter.list().some((task) => task.operationId === id)).toBe(true)
      vi.advanceTimersByTime(1)
      expect(taskCenter.list().some((task) => task.operationId === id)).toBe(false)
      expect(noticeCenter.list().some((notice) => notice.id === 'web-cloud-backup')).toBe(false)
      expect(service.getWebBackupState()?.status).toBe('completed')
    } finally {
      noticeCenter.dismiss('web-cloud-backup')
      taskCenter.dismiss(id)
      vi.useRealTimers()
    }
  })
  it('releases the service lock when the device cannot persist the initial control checkpoint', async () => {
    const service = sessionService()
    const upload = vi.fn(async () => ({ id: 'saved', objectKey: 'manifest' }))
    Object.assign(service, { uploadGitHubStructuredBackup: upload })
    const storage = vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => {
      throw new Error('storage quota')
    })
    try {
      await expect(service.createBackup(githubConfig, 'fixture')).rejects.toThrow('storage quota')
      expect(upload).not.toHaveBeenCalled()
      await expect(service.createBackup(githubConfig, 'fixture')).resolves.toMatchObject({
        id: 'saved',
      })
    } finally {
      storage.mockRestore()
    }
  })
  it('continues after the page unsubscribes, and exposes the same task to a reopened page', async () => {
    const service = sessionService()
    let finish!: (value: { id: string; objectKey: string }) => void
    Object.assign(service, {
      uploadGitHubStructuredBackup: vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      ),
    })
    const first = vi.fn(),
      remove = service.subscribeWebBackup(first)
    const pending = service.createBackup(githubConfig, 'fixture')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const state = service.getWebBackupState()!
    expect(state.status).toBe('running')
    expect(
      taskCenter.list().find((task) => task.operationId === state.operationId)?.background,
    ).toBe(false)
    remove()
    first.mockClear()
    const reopened = vi.fn(),
      removeReopened = service.subscribeWebBackup(reopened)
    expect(service.getWebBackupState()?.operationId).toBe(state.operationId)
    finish({ id: 'committed', objectKey: 'manifest' })
    await pending
    expect(first).not.toHaveBeenCalled()
    expect(reopened).toHaveBeenCalled()
    expect(service.getWebBackupState()?.status).toBe('completed')
    expect(noticeCenter.list().find((notice) => notice.id === 'web-cloud-backup')?.completed).toBe(
      true,
    )
    removeReopened()
  })
  it('pauses a retry wait, persists control across restart, blocks automatic revival and resumes only explicitly', async () => {
    const service = sessionService()
    let entered = false,
      retries = 0
    Object.assign(service, {
      uploadGitHubStructuredBackup: vi.fn(async (_c, _s, _snap, _p, _a, signal) => {
        entered = true
        await waitForCloudRetry(60_000, signal)
        retries++
        throw new Error('must not retry after pause')
      }),
    })
    const pending = service.createBackup(githubConfig, 'fixture')
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(entered).toBe(true))
    await service.pauseActiveWebBackup()
    await rejected
    expect(retries).toBe(0)
    expect(service.getWebBackupState()?.status).toBe('paused')
    const restarted = sessionService()
    const upload = vi.fn(async () => ({ id: 'resumed', objectKey: 'new-manifest' }))
    Object.assign(restarted, { uploadGitHubStructuredBackup: upload })
    expect(restarted.getWebBackupState()?.status).toBe('paused')
    expect(await restarted.runDueBackup()).toBe('waiting')
    expect(upload).not.toHaveBeenCalled()
    await restarted.cancelActiveWebBackup()
    expect(restarted.getWebBackupState()?.status).toBe('stopped')
    expect(await restarted.runDueBackup()).toBe('waiting')
    await restarted.resumeWebBackup()
    expect(upload).toHaveBeenCalledOnce()
    expect(restarted.getWebBackupState()?.status).toBe('completed')
  })
  it.each(['stopped', 'failed'] as const)(
    'keeps a %s backup quiet across lifecycle checks and reopening until explicit continuation',
    async (status) => {
      const operationId = `${status}-backup-from-previous-session`
      localStorage.setItem(
        'srl.cloudBackup.status.v1',
        JSON.stringify({
          webBackup: {
            operationId,
            status,
            phase: status === 'stopped' ? '备份已停止；已完成对象保留' : '云备份失败',
            target: githubConfig,
          },
        }),
      )
      const checkpoint = localStorage.getItem('srl.cloudBackup.status.v1')
      const upload = vi.fn(async () => ({ id: 'resumed', objectKey: 'new-manifest' }))
      let reopened!: CloudBackupService
      try {
        for (let session = 0; session < 2; session++) {
          reopened = sessionService()
          Object.assign(reopened, { uploadGitHubStructuredBackup: upload })
          expect(await reopened.runDueBackup()).toBe('waiting')
          expect(await reopened.runDueBackup()).toBe('waiting')
          expect(reopened.getWebBackupState()?.status).toBe(status)
          expect(localStorage.getItem('srl.cloudBackup.status.v1')).toBe(checkpoint)
          expect(upload).not.toHaveBeenCalled()
          expect(taskCenter.list().some((task) => task.operationId === operationId)).toBe(false)
          expect(noticeCenter.list().some((notice) => notice.id === 'web-cloud-backup')).toBe(false)
        }
        await reopened.resumeWebBackup()
        expect(upload).toHaveBeenCalledOnce()
        expect(reopened.getWebBackupState()?.status).toBe('completed')
      } finally {
        taskCenter.dismiss(operationId)
        const resumedId = reopened?.getWebBackupState()?.operationId
        if (resumedId) taskCenter.dismiss(resumedId)
        noticeCenter.dismiss('web-cloud-backup')
      }
    },
  )
  it('reports a live failure once and does not resurrect dismissed failure cards', async () => {
    const service = sessionService()
    const upload = vi.fn(async () => {
      throw new Error('fixture upload failed')
    })
    Object.assign(service, { uploadGitHubStructuredBackup: upload })
    const notices = vi.spyOn(noticeCenter, 'push')
    let operationId = ''
    try {
      await expect(service.createBackup(githubConfig, 'fixture')).rejects.toThrow(
        'fixture upload failed',
      )
      operationId = service.getWebBackupState()!.operationId
      expect(service.getWebBackupState()?.status).toBe('failed')
      expect(taskCenter.list().find((task) => task.operationId === operationId)?.status).toBe(
        'failed',
      )
      expect(
        notices.mock.calls.filter(
          ([notice]) => notice.id === 'web-cloud-backup' && notice.type === 'error',
        ),
      ).toHaveLength(1)
      taskCenter.dismiss(operationId)
      noticeCenter.dismiss('web-cloud-backup')
      for (const owner of [service, sessionService()]) {
        expect(await owner.runDueBackup()).toBe('waiting')
        expect(await owner.runDueBackup()).toBe('waiting')
        expect(taskCenter.list().some((task) => task.operationId === operationId)).toBe(false)
        expect(noticeCenter.list().some((notice) => notice.id === 'web-cloud-backup')).toBe(false)
      }
      expect(upload).toHaveBeenCalledOnce()
      expect(
        notices.mock.calls.filter(
          ([notice]) => notice.id === 'web-cloud-backup' && notice.type === 'error',
        ),
      ).toHaveLength(1)
    } finally {
      taskCenter.dismiss(operationId)
      noticeCenter.dismiss('web-cloud-backup')
      notices.mockRestore()
    }
  })
  it.each(['paused', 'running'] as const)(
    'keeps the continuation reminder for an unfinished %s backup without uploading',
    async (status) => {
      const operationId = `unfinished-${status}-backup`
      localStorage.setItem(
        'srl.cloudBackup.status.v1',
        JSON.stringify({
          webBackup: { operationId, status, phase: '待继续备份', target: githubConfig },
        }),
      )
      const service = sessionService()
      const upload = vi.fn()
      Object.assign(service, { uploadGitHubStructuredBackup: upload })
      try {
        expect(await service.runDueBackup()).toBe('waiting')
        expect(await service.runDueBackup()).toBe('waiting')
        expect(upload).not.toHaveBeenCalled()
        expect(taskCenter.list().filter((task) => task.operationId === operationId)).toHaveLength(1)
        expect(
          noticeCenter.list().filter((notice) => notice.id === 'web-cloud-backup'),
        ).toHaveLength(1)
      } finally {
        taskCenter.dismiss(operationId)
        noticeCenter.dismiss('web-cloud-backup')
      }
    },
  )
  it('does not restart a failed scheduled backup on later lifecycle checks', async () => {
    const service = sessionService()
    Object.assign(service, {
      initializeCredentials: vi.fn(async () => undefined),
      getSnapshot: () => ({
        activeProvider: 'github',
        github: { ...githubConfig, autoBackup: true },
        status: { lastAttemptAt: Date.now() - 60 * 60 * 1000, lastError: '401: 请重新登录' },
      }),
      getSecret: () => 'fixture',
      hasActiveNativeBackup: vi.fn(async () => false),
      createBackup: vi.fn(async () => {
        throw new Error('must require explicit continuation')
      }),
    })

    expect(await service.runDueBackup()).toBe('waiting')
    expect(await service.runDueBackup()).toBe('waiting')
    expect(service.createBackup).not.toHaveBeenCalled()
  })
  it('restores an interrupted running checkpoint as paused without retaining credentials, and refuses a changed target', async () => {
    localStorage.setItem(
      'srl.cloudBackup.status.v1',
      JSON.stringify({
        webBackup: {
          operationId: 'interrupted-backup',
          status: 'running',
          phase: 'upload',
          target: githubConfig,
        },
      }),
    )
    const service = sessionService()
    expect(service.getWebBackupState()?.status).toBe('paused')
    Object.assign(service, { getActiveConfig: () => ({ ...githubConfig, repository: 'other' }) })
    await expect(service.resumeWebBackup()).rejects.toThrow('原来的云端目标')
    expect(JSON.stringify(service.getWebBackupState())).not.toContain('fixture')
  })
  it('resumes the real V3 object pipeline without reuploading verified bytes and commits just one complete manifest', async () => {
    const resources = await Promise.all(
      Array.from({ length: 5 }, async (_, index) => {
        const resource = cloudResource(index + '-resource', 'object-' + index)
        resource.contentHash = await hashCloudBlob(resource.originalBlob)
        return resource
      }),
    )
    const service = createService(
      {
        listSummaries: vi.fn(async () => resources),
        listVersions: vi.fn(async () => []),
        listVersionSummaries: vi.fn(async () => []),
        get: vi.fn(async (id) => resources.find((resource) => resource.id === id)),
        updateBackupDescriptor: vi.fn(async (id, descriptor) => {
          resources.find((resource) => resource.id === id)!.backupDescriptor = descriptor
        }),
      } as unknown as ResourceService,
      { list: vi.fn(async () => []) } as unknown as CategoryService,
    )
    const remote = new Map<string, Blob>(),
      uploaded = new Map<string, number>()
    let pausing = true
    const originalContext = (
      service as unknown as {
        getTransportContext: (signal?: AbortSignal, commit?: () => void) => object
      }
    ).getTransportContext.bind(service)
    const transfers = {
      ensureWebDavFolder: async () => undefined,
      listWebDavObjects: async () =>
        [...remote].map(([objectKey, blob]) => ({ objectKey, size: blob.size, createdAt: 1 })),
      uploadWebDavObject: async (_config: unknown, _secret: unknown, key: string, blob: Blob) => {
        remote.set(key, blob)
        uploaded.set(key, (uploaded.get(key) ?? 0) + 1)
        if (pausing && remote.size === 2) {
          pausing = false
          void service.pauseActiveWebBackup()
        }
      },
    }
    Object.assign(service, {
      getActiveConfig: () => webDavConfig,
      requireSecret: () => 'fixture',
      prune: async () => 0,
      getTransportContext: (signal?: AbortSignal, commit?: () => void) =>
        Object.assign(Object.create(originalContext(signal, commit)), transfers),
    })
    await expect(service.createBackup(webDavConfig, 'fixture')).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(service.getWebBackupState()?.status).toBe('paused')
    expect([...remote.keys()].some((key) => key.startsWith('snapshots/'))).toBe(false)
    await service.resumeWebBackup()
    const manifests = [...remote].filter(([key]) => key.startsWith('snapshots/'))
    expect(manifests).toHaveLength(1)
    const manifest = await decodeStructuredSnapshot(manifests[0]![1])
    expect(manifest.resources).toHaveLength(5)
    for (const resource of manifest.resources) {
      for (const part of resource.object.parts) {
        const key = `objects/${part.name}`
        expect(uploaded.get(key)).toBe(1)
        expect(await hashCloudBlob(remote.get(key)!)).toBe(part.sha256)
      }
    }
  })
})
