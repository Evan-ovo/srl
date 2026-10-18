/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'
import { prune } from './CloudBackupRetentionOperations'
import type { CloudBackupSnapshotOperationsContext } from './CloudBackupSnapshotOperations'
import type { GitHubBackupConfig } from '../types/CloudBackup'

const config: GitHubBackupConfig = {
  provider: 'github',
  owner: 'example',
  repository: 'backups',
  retention: 1,
  autoBackup: false,
}

function fixture(expiredCount = 1) {
  const backups = Array.from({ length: expiredCount + 1 }, (_, index) => ({
    id: String(index + 1),
    objectKey: `${index}.zip`,
    size: 1,
    createdAt: 100 - index,
    kind: 'single' as const,
  }))
  const githubFetch = vi.fn<CloudBackupSnapshotOperationsContext['githubFetch']>(
    async () => new Response(null, { status: 204 }),
  )
  const eligibleOrphans = vi.fn(async () => [] as string[])
  const getGitHubRelease = vi.fn<CloudBackupSnapshotOperationsContext['getGitHubRelease']>()
  const context = {
    listRetentionBackups: vi.fn(async () => backups),
    githubFetch,
    getGitHubRelease,
    transportState: {
      jobStore: { pendingOrphans: vi.fn(async () => []), eligibleOrphans, clearOrphan: vi.fn() },
    },
  } as unknown as CloudBackupSnapshotOperationsContext
  return { context, githubFetch, eligibleOrphans, getGitHubRelease }
}

describe('retention maintenance outcomes', () => {
  it('retains the successful deletion count when later content reclamation fails', async () => {
    const { context, githubFetch, eligibleOrphans, getGitHubRelease } = fixture()
    eligibleOrphans.mockResolvedValueOnce([
      `srl-cloud-objects-0001\u0000srl-chunk--sha256-${'a'.repeat(64)}`,
    ])
    getGitHubRelease.mockRejectedValueOnce(new Error('本站 GitHub 中转没有收到响应'))
    await expect(prune(context, config, 'test-token')).rejects.toMatchObject({
      deletedSnapshots: 1,
      stage: 'objects',
      message: expect.stringMatching(/已清理 1 份旧快照.*内容对象回收未完成/),
    })
    expect(githubFetch).toHaveBeenCalledExactlyOnceWith(
      config,
      'test-token',
      '/releases/assets/2',
      { method: 'DELETE' },
    )
  })

  it('reports partial confirmed deletion and stops before reclaiming shared objects', async () => {
    const { context, githubFetch, eligibleOrphans } = fixture(2)
    githubFetch.mockImplementation(async (_config, _secret, path) => {
      if (path.endsWith('/3')) throw new Error('删除结果尚未确认')
      return new Response(null, { status: 204 })
    })
    await expect(prune(context, config, 'test-token')).rejects.toMatchObject({
      deletedSnapshots: 1,
      stage: 'snapshots',
      message: expect.stringMatching(/已确认清理 1\/2 份旧快照.*未完成/),
    })
    expect(eligibleOrphans).not.toHaveBeenCalled()
  })

  it('does not claim old snapshots were deleted when only orphan maintenance was needed', async () => {
    const { context, eligibleOrphans } = fixture(0)
    eligibleOrphans.mockRejectedValueOnce(new Error('Storage failed'))
    await expect(prune(context, config, 'test-token', undefined, true)).rejects.toMatchObject({
      deletedSnapshots: 0,
      stage: 'objects',
      message: expect.stringMatching(/快照保留检查已完成.*内容对象回收未完成/),
    })
  })

  it('keeps the existing successful deletion result and normal request count', async () => {
    const { context, githubFetch } = fixture()
    await expect(prune(context, config, 'test-token')).resolves.toBe(1)
    expect(githubFetch).toHaveBeenCalledOnce()
  })

  it('preserves confirmed HTTP errors for existing credential handling', async () => {
    const { context, githubFetch } = fixture()
    githubFetch.mockRejectedValueOnce(Object.assign(new Error('Bad credentials'), { status: 401 }))
    await expect(prune(context, config, 'test-token')).rejects.toMatchObject({
      stage: 'snapshots',
      status: 401,
      deletedSnapshots: 0,
    })
  })
})
