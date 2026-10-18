/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { taskCenter } from '../core/TaskCenter'

const transfer = vi.hoisted(() => ({
  webDavRequest: vi.fn(),
  beginJob: vi.fn(),
  beginObject: vi.fn(),
  stageObjectFromLibrary: vi.fn(),
  stageObjectFromSources: vi.fn(),
  stageObjectFromFile: vi.fn(),
  probeLibraryObject: vi.fn(),
  probeLibraryObjects: vi.fn(),
  appendObject: vi.fn(),
  commitObject: vi.fn(),
  abortObject: vi.fn(),
  startJob: vi.fn(),
  finishJobStaging: vi.fn(),
  getJob: vi.fn(),
  saveCredential: vi.fn(),
  clearCredential: vi.fn(),
  invalidateCredential: vi.fn(),
  readCredential: vi.fn(),
  getLatestJob: vi.fn(),
  cancelJob: vi.fn(),
  restoreStructuredFiles: vi.fn(),
  readRestoredCardMetadata: vi.fn(),
}))
const security = vi.hoisted(() => ({ requestNotifications: vi.fn() }))

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
  registerPlugin: (name: string) => (name === 'NativeCloudTransfer' ? transfer : security),
}))

import {
  canUseNativeStructuredSnapshotHandoff,
  cancelActiveNativeCloudTransfer,
  clearNativeCloudCredential,
  invalidateNativeCloudCredential,
  getLatestNativeCloudRestoreJob,
  nativeWebDavFetch,
  readNativeCloudCredential,
  readNativeRestoredCardMetadata,
  restoreNativeStructuredObjects,
  saveNativeCloudCredential,
  uploadNativeStructuredSnapshot,
} from './NativeCloudTransfer'

describe('NativeCloudTransfer', () => {
  beforeEach(() => {
    for (const task of taskCenter.list()) taskCenter.dismiss(task.operationId)
    vi.clearAllMocks()
    transfer.beginJob.mockResolvedValue({ jobId: 'job-1', pipeline: true })
    transfer.beginObject.mockResolvedValue({ token: 'token-1' })
    transfer.stageObjectFromLibrary.mockResolvedValue({ staged: true })
    transfer.stageObjectFromSources.mockResolvedValue({ staged: true })
    transfer.stageObjectFromFile.mockResolvedValue({ staged: true })
    transfer.probeLibraryObject.mockResolvedValue({
      available: true,
      size: 256 * 1024 * 1024,
    })
    transfer.probeLibraryObjects.mockResolvedValue({ available: true })
    transfer.appendObject.mockResolvedValue(undefined)
    transfer.commitObject.mockResolvedValue(undefined)
    transfer.startJob.mockResolvedValue({ status: 'queued' })
    transfer.finishJobStaging.mockResolvedValue({ status: 'running' })
    transfer.cancelJob.mockResolvedValue({ cancelled: true, status: 'cancelled' })
    transfer.restoreStructuredFiles.mockResolvedValue({
      downloaded: 1,
      reused: 0,
      assembled: 1,
    })
    transfer.saveCredential.mockResolvedValue(undefined)
    transfer.clearCredential.mockResolvedValue(undefined)
    transfer.invalidateCredential.mockResolvedValue(undefined)
    transfer.readCredential.mockResolvedValue({ present: false, valid: true })
    transfer.getJob.mockResolvedValue({
      id: 'job-1',
      provider: 'webdav',
      status: 'completed',
      completed: 1,
      total: 1,
      resultId: 'manifest-id',
      resultName: 'snapshot.json.gz',
    })
    security.requestNotifications.mockResolvedValue({ granted: true })
  })

  it('原生恢复只桥接对象地址与分段描述，不桥接 Blob/Base64', async () => {
    const hash = 'a'.repeat(64)
    await restoreNativeStructuredObjects({
      config: {
        provider: 'github',
        owner: 'owner',
        repository: 'repo',
        retention: 2,
        autoBackup: false,
      },
      secret: 'token',
      objects: [{ url: 'https://api.github.com/assets/1', hash, size: 32 }],
      resources: [
        {
          hash,
          size: 32,
          type: 'other',
          fileName: 'resource.bin',
          segments: [{ hash, offset: 0, size: 32 }],
        },
      ],
    })

    expect(transfer.restoreStructuredFiles).toHaveBeenCalledWith({
      config: expect.objectContaining({ provider: 'github' }),
      secret: 'token',
      objects: [{ url: 'https://api.github.com/assets/1', hash, size: 32 }],
      resources: [
        {
          hash,
          size: 32,
          type: 'other',
          fileName: 'resource.bin',
          segments: [{ hash, offset: 0, size: 32 }],
        },
      ],
    })
    expect(transfer.appendObject).not.toHaveBeenCalled()
    expect(transfer.readRestoredCardMetadata).not.toHaveBeenCalled()
  })

  it('queries restore jobs separately so a download never becomes an upload or backup-success record', async () => {
    transfer.getLatestJob.mockResolvedValueOnce({
      present: true,
      kind: 'restore',
      id: 'restore-1',
      status: 'running',
      completed: 2,
      total: 3,
    })
    expect(await getLatestNativeCloudRestoreJob()).toMatchObject({
      kind: 'restore',
      id: 'restore-1',
    })
    expect(transfer.getLatestJob).toHaveBeenCalledWith({ kind: 'restore' })
    transfer.getLatestJob.mockResolvedValueOnce({
      present: true,
      id: 'legacy-upload',
      status: 'running',
    })
    expect(await getLatestNativeCloudRestoreJob()).toBeNull()
  })

  it('reads exactly one verified card per metadata request', async () => {
    const options = { hash: 'b'.repeat(64), size: 180 * 1024 * 1024, fileName: 'card.png' }
    transfer.readRestoredCardMetadata.mockResolvedValueOnce({
      hash: options.hash,
      card: { name: 'card' },
    })
    await expect(readNativeRestoredCardMetadata(options)).resolves.toMatchObject({
      card: { name: 'card' },
    })
    expect(transfer.readRestoredCardMetadata).toHaveBeenCalledWith(options)
    expect(transfer.restoreStructuredFiles).not.toHaveBeenCalled()
  })

  it('requires an APK update instead of using the retired aggregate-response method', async () => {
    transfer.restoreStructuredFiles.mockRejectedValueOnce(
      Object.assign(new Error('not implemented'), { code: 'UNIMPLEMENTED' }),
    )
    await expect(
      restoreNativeStructuredObjects({
        config: {
          provider: 'github',
          owner: 'owner',
          repository: 'repo',
          retention: 2,
          autoBackup: false,
        },
        secret: 'token',
        objects: [],
        resources: [],
      }),
    ).rejects.toThrow('请更新 Android APK')
  })

  it('awaits Android credential writes and preserves the durable invalid state', async () => {
    await saveNativeCloudCredential('github', 'token')
    await invalidateNativeCloudCredential('github')
    transfer.readCredential.mockResolvedValueOnce({ present: false, valid: false })
    await expect(readNativeCloudCredential('github')).resolves.toEqual({
      state: 'invalid',
      secret: '',
    })
    await clearNativeCloudCredential('github')

    expect(transfer.saveCredential).toHaveBeenCalledWith({ provider: 'github', secret: 'token' })
    expect(transfer.invalidateCredential).toHaveBeenCalledWith({ provider: 'github' })
    expect(transfer.clearCredential).toHaveBeenCalledWith({ provider: 'github' })
  })

  it('cancels the persisted active WorkManager job after a WebView process restart', async () => {
    transfer.getLatestJob.mockResolvedValueOnce({
      present: true,
      id: 'persisted-job',
      provider: 'github',
      status: 'queued',
      completed: 3,
      total: 10,
      updatedAt: 1,
    })

    await expect(cancelActiveNativeCloudTransfer()).resolves.toBe('cancelled')
    expect(transfer.cancelJob).toHaveBeenCalledWith({ jobId: 'persisted-job' })
  })

  it('does not claim cancellation after the durable manifest commit boundary', async () => {
    transfer.getLatestJob.mockResolvedValueOnce({
      present: true,
      id: 'committing-job',
      provider: 'webdav',
      status: 'committing',
      completed: 5,
      total: 6,
      updatedAt: 2,
    })
    transfer.cancelJob.mockResolvedValueOnce({ cancelled: false, status: 'committing' })

    await expect(cancelActiveNativeCloudTransfer()).resolves.toBe('committing')
    expect(transfer.cancelJob).toHaveBeenCalledWith({ jobId: 'committing-job' })
  })

  it('把 CapacitorHttp 不接受的 PROPFIND 交给受限原生 WebDAV 通道', async () => {
    transfer.webDavRequest.mockResolvedValue({
      status: 207,
      headers: { 'content-type': 'application/xml' },
      body: '<multistatus />',
    })

    const response = await nativeWebDavFetch('https://example.test/dav/SRL-Backups', {
      method: 'PROPFIND',
      headers: { Authorization: 'Basic credential', Depth: '1' },
    })

    expect(transfer.webDavRequest).toHaveBeenCalledWith({
      url: 'https://example.test/dav/SRL-Backups',
      method: 'PROPFIND',
      headers: { authorization: 'Basic credential', depth: '1' },
    })
    expect(response.status).toBe(207)
    await expect(response.text()).resolves.toBe('<multistatus />')
  })

  it('完全相同时只暂存最终清单并由 Android 最后提交', async () => {
    const result = await uploadNativeStructuredSnapshot({
      config: {
        provider: 'webdav',
        baseUrl: 'https://example.test/dav',
        folder: 'backup',
        username: 'user',
        retention: 7,
        autoBackup: false,
      },
      secret: 'secret',
      objects: [],
      manifest: {
        name: 'snapshot.json.gz',
        blob: new Blob(['manifest']),
        contentType: 'application/gzip',
      },
    })

    expect(transfer.beginJob).toHaveBeenCalledWith(expect.objectContaining({ expectedTotal: 1 }))
    expect(transfer.startJob).toHaveBeenCalledBefore(transfer.beginObject)
    expect(transfer.beginObject).toHaveBeenCalledOnce()
    expect(transfer.beginObject).toHaveBeenCalledWith(
      expect.objectContaining({ manifest: true, name: 'snapshot.json.gz' }),
    )
    expect(transfer.commitObject).toHaveBeenCalledBefore(transfer.finishJobStaging)
    expect(transfer.finishJobStaging).toHaveBeenCalledWith({ jobId: 'job-1' })
    expect(result).toEqual({
      id: 'manifest-id',
      name: 'snapshot.json.gz',
      metrics: expect.objectContaining({
        localReadBytes: 8,
        bridgeBytes: 8,
        httpRequestCount: 0,
        retryCount: 0,
      }),
    })
  })

  it('snapshots local Discord asset ranges natively and does not bridge attachment bytes', async () => {
    const object = {
      name: `srl-chunk--sha256-${'c'.repeat(64)}`,
      size: 12,
      contentType: 'application/octet-stream',
      nativeSource: { kind: 'file' as const, uri: 'file:///app/asset.bin', offset: 2, size: 12 },
    }
    await uploadNativeStructuredSnapshot({
      config: {
        provider: 'webdav',
        baseUrl: 'https://example.test/dav',
        folder: 'backup',
        username: 'fixture',
        retention: 1,
        autoBackup: false,
      },
      secret: 'fixture',
      objects: [object],
      manifest: {
        name: 'snapshot.srlmanifest.v3.json.gz',
        blob: new Blob(['manifest']),
        contentType: 'application/gzip',
      },
    })
    expect(transfer.stageObjectFromFile).toHaveBeenCalledWith({
      jobId: 'job-1',
      name: object.name,
      contentType: object.contentType,
      uri: object.nativeSource.uri,
      offset: 2,
      size: 12,
      existingId: undefined,
      releaseId: undefined,
    })
    expect(transfer.beginObject.mock.calls.every(([value]) => value.manifest === true)).toBe(true)
    expect(transfer.stageObjectFromLibrary).not.toHaveBeenCalled()
  })

  it('将超过旧 4 MiB 限制的清单按原生流分段暂存', async () => {
    const manifest = new Blob([new Uint8Array(4 * 1024 * 1024 + 1)])

    await expect(
      canUseNativeStructuredSnapshotHandoff({
        objects: [],
        manifest: {
          name: 'snapshot.json.gz',
          blob: manifest,
          contentType: 'application/gzip',
        },
      }),
    ).resolves.toBe(true)

    await uploadNativeStructuredSnapshot({
      config: {
        provider: 'webdav',
        baseUrl: 'https://example.test/dav',
        folder: 'backup',
        username: 'user',
        retention: 7,
        autoBackup: false,
      },
      secret: 'secret',
      objects: [],
      manifest: {
        name: 'snapshot.json.gz',
        blob: manifest,
        contentType: 'application/gzip',
      },
    })

    expect(transfer.beginObject).toHaveBeenCalledWith(
      expect.objectContaining({ manifest: true, size: manifest.size }),
    )
    expect(transfer.appendObject).toHaveBeenCalled()
    expect(transfer.commitObject).toHaveBeenCalled()
  })

  it('只在 NativeLibrary 原件真实可用时允许大型 changed object 进入原生 handoff', async () => {
    const blob = new Blob([new Uint8Array(5 * 1024 * 1024 + 1)])
    const object = {
      name: `srl-chunk--sha256-${'a'.repeat(64)}`,
      blob,
      contentType: 'application/octet-stream',
      nativeSource: {
        kind: 'range' as const,
        contentHash: 'b'.repeat(64),
        offset: 1024,
        size: blob.size,
      },
    }
    const manifest = {
      name: 'snapshot.json.gz',
      blob: new Blob(['manifest']),
      contentType: 'application/gzip',
    }

    await expect(
      canUseNativeStructuredSnapshotHandoff({ objects: [object], manifest }),
    ).resolves.toBe(true)
    expect(transfer.probeLibraryObjects).toHaveBeenCalledWith({
      sources: [
        {
          sourceHash: 'b'.repeat(64),
          minimumSize: 1024 + blob.size,
        },
      ],
    })

    transfer.probeLibraryObjects.mockResolvedValueOnce({ available: false })
    await expect(
      canUseNativeStructuredSnapshotHandoff({ objects: [object], manifest }),
    ).resolves.toBe(false)

    await expect(
      canUseNativeStructuredSnapshotHandoff({
        objects: [{ ...object, nativeSource: undefined }],
        manifest,
      }),
    ).resolves.toBe(false)
  })

  it('thousands of object sources are preflighted in one native bridge call, including large offsets', async () => {
    const manifest = {
      name: 'snapshot.json.gz',
      blob: new Blob(['manifest']),
      contentType: 'application/gzip',
    }
    const objects = Array.from({ length: 1_000 }, (_, index) => {
      const sourceHash = index.toString(16).padStart(64, '0')
      return {
        name: `srl-chunk--sha256-${sourceHash}`,
        size: 32 * 1024 * 1024,
        contentType: 'application/octet-stream',
        nativeSource: {
          kind: 'range' as const,
          contentHash: sourceHash,
          offset: 3 * 1024 * 1024 * 1024,
          size: 32 * 1024 * 1024,
        },
      }
    })

    await expect(canUseNativeStructuredSnapshotHandoff({ objects, manifest })).resolves.toBe(true)
    expect(transfer.probeLibraryObjects).toHaveBeenCalledOnce()
    expect(transfer.probeLibraryObjects.mock.calls[0]?.[0].sources).toHaveLength(1_000)
    expect(transfer.probeLibraryObjects.mock.calls[0]?.[0].sources[0]?.minimumSize).toBe(
      3 * 1024 * 1024 * 1024 + 32 * 1024 * 1024,
    )
  })

  it('falls back to bounded single-object probes on older APKs without batch support', async () => {
    const blob = new Blob(['chunk'])
    transfer.probeLibraryObjects.mockRejectedValueOnce({ code: 'UNIMPLEMENTED' })
    await expect(
      canUseNativeStructuredSnapshotHandoff({
        objects: [
          {
            name: 'chunk',
            size: blob.size,
            contentType: 'application/octet-stream',
            nativeSource: {
              kind: 'range',
              contentHash: 'e'.repeat(64),
              offset: 0,
              size: blob.size,
            },
          },
        ],
        manifest: {
          name: 'snapshot',
          blob: new Blob(['manifest']),
          contentType: 'application/gzip',
        },
      }),
    ).resolves.toBe(true)
    expect(transfer.probeLibraryObject).toHaveBeenCalledOnce()
  })

  it('大型 NativeLibrary source 在 staging 时消失也不会重新退回 Base64 Bridge', async () => {
    const blob = new Blob([new Uint8Array(5 * 1024 * 1024 + 1)])
    transfer.stageObjectFromLibrary.mockResolvedValueOnce({ staged: false })

    await expect(
      uploadNativeStructuredSnapshot({
        config: {
          provider: 'webdav',
          baseUrl: 'https://example.test/dav',
          folder: 'backup',
          username: 'user',
          retention: 7,
          autoBackup: false,
        },
        secret: 'secret',
        objects: [
          {
            name: `srl-chunk--sha256-${'c'.repeat(64)}`,
            blob,
            contentType: 'application/octet-stream',
            nativeSource: {
              kind: 'range',
              contentHash: 'd'.repeat(64),
              offset: 0,
              size: blob.size,
            },
          },
        ],
        manifest: {
          name: 'snapshot.json.gz',
          blob: new Blob(['manifest']),
          contentType: 'application/gzip',
        },
      }),
    ).rejects.toThrow('阻止云对象退回 JS Blob/Base64')

    expect(transfer.beginObject).not.toHaveBeenCalled()
    expect(transfer.appendObject).not.toHaveBeenCalled()
  })

  it('旧 APK 未声明流水能力时保持全部暂存后再启动', async () => {
    transfer.beginJob.mockResolvedValueOnce({ jobId: 'job-1' })

    await uploadNativeStructuredSnapshot({
      config: {
        provider: 'webdav',
        baseUrl: 'https://example.test/dav',
        folder: 'backup',
        username: 'user',
        retention: 7,
        autoBackup: false,
      },
      secret: 'secret',
      objects: [],
      manifest: {
        name: 'snapshot.json.gz',
        blob: new Blob(['manifest']),
        contentType: 'application/gzip',
      },
    })

    expect(transfer.commitObject).toHaveBeenCalledBefore(transfer.startJob)
    expect(transfer.finishJobStaging).not.toHaveBeenCalled()
  })

  it('流水暂存失败时取消已启动的后台任务，不留下半成品 job', async () => {
    transfer.beginObject.mockRejectedValueOnce(new Error('暂存失败'))

    await expect(
      uploadNativeStructuredSnapshot({
        config: {
          provider: 'webdav',
          baseUrl: 'https://example.test/dav',
          folder: 'backup',
          username: 'user',
          retention: 7,
          autoBackup: false,
        },
        secret: 'secret',
        objects: [],
        manifest: {
          name: 'snapshot.json.gz',
          blob: new Blob(['manifest']),
          contentType: 'application/gzip',
        },
      }),
    ).rejects.toThrow('暂存失败')

    expect(transfer.startJob).toHaveBeenCalledBefore(transfer.beginObject)
    expect(transfer.finishJobStaging).not.toHaveBeenCalled()
    expect(transfer.cancelJob).toHaveBeenCalledWith({ jobId: 'job-1' })
  })

  it('手动备份不套用仅 Wi-Fi/充电约束', async () => {
    await uploadNativeStructuredSnapshot({
      config: {
        provider: 'github',
        owner: 'owner',
        repository: 'repo',
        retention: 7,
        autoBackup: true,
        protection: { wifiOnly: true, chargingOnly: true },
      },
      releaseId: 1,
      secret: 'token',
      objects: [],
      manifest: {
        name: 'snapshot.json.gz',
        blob: new Blob(['x']),
        contentType: 'application/gzip',
      },
    })

    expect(transfer.beginJob).toHaveBeenCalledWith(
      expect.objectContaining({ wifiOnly: false, chargingOnly: false, automatic: false }),
    )
    expect(taskCenter.list()).toEqual([
      expect.objectContaining({
        operationId: 'native-cloud-backup:job-1',
        name: 'GitHub 云备份',
        background: false,
        status: 'completed',
      }),
    ])
  })

  it('自动 APK 备份作为后台任务进入共用任务中心', async () => {
    await uploadNativeStructuredSnapshot({
      config: {
        provider: 'webdav',
        baseUrl: 'https://example.test/dav',
        folder: 'backup',
        username: 'user',
        retention: 7,
        autoBackup: true,
      },
      secret: 'secret',
      objects: [],
      manifest: {
        name: 'snapshot.json.gz',
        blob: new Blob(['x']),
        contentType: 'application/gzip',
      },
      respectConstraints: true,
    })

    expect(transfer.beginJob).toHaveBeenCalledWith(expect.objectContaining({ automatic: true }))
    expect(taskCenter.list()).toEqual([
      expect.objectContaining({
        name: 'Koofr 云备份',
        background: true,
        status: 'completed',
      }),
    ])
  })

  it('APK 原生备份失败后在任务中心保留错误', async () => {
    transfer.beginObject.mockRejectedValueOnce(new Error('对象暂存失败'))

    await expect(
      uploadNativeStructuredSnapshot({
        config: {
          provider: 'github',
          owner: 'owner',
          repository: 'repo',
          retention: 1,
          autoBackup: false,
        },
        secret: 'token',
        objects: [],
        manifest: {
          name: 'snapshot.json.gz',
          blob: new Blob(['x']),
          contentType: 'application/gzip',
        },
      }),
    ).rejects.toThrow('对象暂存失败')

    expect(taskCenter.list()).toEqual([
      expect.objectContaining({
        operationId: 'native-cloud-backup:job-1',
        status: 'failed',
        error: '对象暂存失败',
      }),
    ])
  })
})
