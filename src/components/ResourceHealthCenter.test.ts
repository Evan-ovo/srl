/** @vitest-environment jsdom */
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const api = vi.hoisted(() => ({
  scan: vi.fn(),
  info: vi.fn(),
  candidates: vi.fn(),
  preview: vi.fn(),
  recover: vi.fn(),
  repair: vi.fn(),
  deleteCandidates: vi.fn(),
  accounting: vi.fn(),
  mirrors: vi.fn(),
  notice: vi.fn(),
  browserHealth: vi.fn(),
  clearCaches: vi.fn(),
  confirm: vi.fn(),
  mediaUsage: vi.fn(),
  clearMedia: vi.fn(),
  optimize: vi.fn(),
  compactStatus: vi.fn(),
  intakeList: vi.fn(),
  intakeRemove: vi.fn(),
}))
vi.mock('../utils/ShareTargetIntake', () => ({
  listNativeIntakeFiles: api.intakeList,
  removeNativeIntakeFile: api.intakeRemove,
}))
vi.mock('../core/AppContainer', () => ({
  browserStorageService: {
    getHealth: api.browserHealth,
    optimizeDerivedSummaries: api.optimize,
    getSummaryCompactionStatus: api.compactStatus,
  },
  communitySourceService: {
    downloadedMediaUsage: api.mediaUsage,
    clearDownloadedMedia: api.clearMedia,
  },
  nativeResourceRecoveryService: {
    listCandidates: api.candidates,
    preview: api.preview,
    recover: api.recover,
    repairExisting: api.repair,
    deleteCandidates: api.deleteCandidates,
    storageAccounting: api.accounting,
    nativeMirrorDuplicationSummary: api.mirrors,
  },
}))
vi.mock('../core/HealthCenter', () => ({ healthCenter: { scan: api.scan, repairSafe: vi.fn() } }))
vi.mock('../core/PlatformService', () => ({ getPlatformInfo: vi.fn() }))
vi.mock('../core/SafeStartup', () => ({ isSafeModeActive: () => false }))
vi.mock('../core/TaskCenter', () => ({
  taskCenter: {
    list: () => [],
    start: vi.fn(() => 'browser-usage'),
    update: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn(),
    cancelled: vi.fn(),
  },
}))
vi.mock('../core/NoticeCenter', () => ({ noticeCenter: { push: api.notice, list: () => [] } }))
vi.mock('../storage/NativeResourceFileMirror', () => ({
  getNativeResourceStorageInfo: api.info,
  clearNativeTemporaryCaches: api.clearCaches,
}))
vi.mock('../composables/UseConfirmDialog', () => ({ confirmAction: api.confirm }))
import ResourceHealthCenter from './ResourceHealthCenter.vue'
import { domainEvents } from '../core/DomainEvents'
import { taskCenter } from '../core/TaskCenter'
const accounting = {
  currentOriginalBytes: 10,
  versionOriginalBytes: 5,
  nativeReferenceBytes: 0,
  localSnapshotBytes: 20,
  restoreStagingBytes: 0,
  assetBytes: 12,
  thumbnailAssetBytes: 7,
  assetCount: 3,
  thumbnailAssetCount: 2,
  recoveredPlaceholderCount: 1,
  recoveredPlaceholderBytes: 9,
  pendingNativeLinkCount: 0,
}
const report = { created: 1, updated: 0, existing: 0, unsupported: 0, failed: 0, pendingLinks: 0 }
beforeEach(() => {
  vi.resetAllMocks()
  api.scan.mockResolvedValue([])
  api.compactStatus.mockResolvedValue(false)
  api.mediaUsage.mockResolvedValue({ count: 0, bytes: 0 })
  api.intakeList.mockResolvedValue([])
  api.info.mockResolvedValue({
    recoveryMetadataVersion: 1,
    totalBytes: 700,
    objectBytes: 180,
    objectCount: 1,
  })
  api.candidates.mockResolvedValue({
    candidates: [
      {
        contentHash: 'a'.repeat(64),
        size: 180,
        modifiedAt: 1,
        nativeId: 'surviving-native-id',
        nativeScope: 'current',
        fileName: '崩溃前角色卡.json',
      },
    ],
    scanned: 1,
  })
  api.preview.mockResolvedValue({ name: '找回的角色', type: 'characterCard' })
  api.recover.mockResolvedValue(report)
  api.repair.mockResolvedValue({ ...report, created: 0, updated: 1 })
  api.accounting.mockResolvedValue(accounting)
  api.mirrors.mockResolvedValue({ currentCount: 0, versionCount: 0, reclaimableBytes: 0 })
  api.browserHealth.mockResolvedValue({
    supported: true,
    persisted: false,
    usage: 100,
    quota: 1024,
  })
})
describe('ResourceHealthCenter recovery controls', () => {
  it('requires explicit selection and confirmation before deleting recovery candidates, then refreshes only candidates', async () => {
    const view = mount(ResourceHealthCenter)
    await view
      .findAll('button')
      .find((button) => button.text() === '检查原件与空间')!
      .trigger('click')
    await flushPromises()
    const remove = () =>
      view.findAll('button').find((button) => button.text().startsWith('删除所选'))!
    expect(remove().attributes('disabled')).toBeDefined()
    await view.get('.resource-health__candidates input').setValue(true)
    api.confirm.mockResolvedValueOnce(false)
    await remove().trigger('click')
    await flushPromises()
    expect(api.deleteCandidates).not.toHaveBeenCalled()
    expect(api.candidates).toHaveBeenCalledOnce()
    api.confirm.mockResolvedValueOnce(true)
    api.deleteCandidates.mockResolvedValue({
      deletedHashes: ['a'.repeat(64)],
      retainedHashes: [],
      clearedBytes: 180,
    })
    api.candidates.mockResolvedValueOnce({ candidates: [], scanned: 1 })
    await remove().trigger('click')
    await flushPromises()
    expect(api.confirm).toHaveBeenLastCalledWith(
      expect.objectContaining({
        danger: true,
        confirmLabel: '永久删除所选',
        message: expect.stringContaining('不进入回收站'),
      }),
      expect.any(AbortSignal),
    )
    expect(api.deleteCandidates).toHaveBeenCalledOnce()
    expect(api.candidates).toHaveBeenCalledTimes(2)
    expect(api.accounting).toHaveBeenCalledOnce()
    expect(api.scan).not.toHaveBeenCalled()
    expect(view.find('.resource-health__candidates').exists()).toBe(false)
    view.unmount()
  })
  it('separates quick index scanning from explicit original and link inspection', async () => {
    const view = mount(ResourceHealthCenter)
    await view
      .findAll('button')
      .find((button) => button.text() === '扫描')!
      .trigger('click')
    await flushPromises()
    expect(api.scan).toHaveBeenLastCalledWith({ deep: false })
    expect(api.info).not.toHaveBeenCalled()
    expect(api.candidates).not.toHaveBeenCalled()
    await view
      .findAll('button')
      .find((button) => button.text() === '检查文件与链接')!
      .trigger('click')
    await flushPromises()
    expect(api.scan).toHaveBeenLastCalledWith({ deep: true })
    expect(view.text()).toContain('本次完整检查未发现问题')
    expect(api.accounting).not.toHaveBeenCalled()
    view.unmount()
  })

  it('shows verified compact summaries as already compact and invalidates after a resource change', async () => {
    api.compactStatus.mockResolvedValue(true)
    const view = mount(ResourceHealthCenter)
    await view
      .findAll('button')
      .find((button) => button.text() === '检查原件与空间')!
      .trigger('click')
    await flushPromises()
    expect(
      view
        .findAll('button')
        .find((button) => button.text() === '已精简')!
        .attributes('disabled'),
    ).toBeDefined()
    expect(api.optimize).not.toHaveBeenCalled()
    domainEvents.emit('ResourceImported', { resourceIds: ['new-resource'], operationId: 'import' })
    await flushPromises()
    expect(view.findAll('button').some((button) => button.text() === '精简摘要')).toBe(true)
    view.unmount()
  })

  it('marks a successful compaction without repeating original or space scans', async () => {
    api.confirm.mockResolvedValue(true)
    api.optimize.mockResolvedValue({ beforeBytes: 100, afterBytes: 30 })
    const view = mount(ResourceHealthCenter)
    await view
      .findAll('button')
      .find((button) => button.text() === '检查原件与空间')!
      .trigger('click')
    await flushPromises()
    const reads = api.info.mock.calls.length
    await view
      .findAll('button')
      .find((button) => button.text() === '精简摘要')!
      .trigger('click')
    await flushPromises()
    expect(api.optimize).toHaveBeenCalledOnce()
    expect(api.info).toHaveBeenCalledTimes(reads)
    expect(api.scan).not.toHaveBeenCalled()
    expect(
      view
        .findAll('button')
        .find((button) => button.text() === '已精简')!
        .attributes('disabled'),
    ).toBeDefined()
    view.unmount()
  })
  it('opens intake inventory on demand without clearing files or rescanning originals', async () => {
    const view = mount(ResourceHealthCenter)
    await view
      .findAll('button')
      .find((button) => button.text() === '检查原件与空间')!
      .trigger('click')
    await flushPromises()
    const reads = api.info.mock.calls.length
    await view
      .findAll('button')
      .find((button) => button.text() === '查看文件')!
      .trigger('click')
    await flushPromises()
    expect(api.intakeList).toHaveBeenCalledOnce()
    expect(api.intakeRemove).not.toHaveBeenCalled()
    expect(api.info).toHaveBeenCalledTimes(reads)
    expect(view.text()).toContain('没有接收暂存文件')
    view.unmount()
  })
  it('keeps numeric space inspection available when locked post media cannot be decoded', async () => {
    api.mediaUsage.mockRejectedValue(new Error('请先解锁保险库'))
    const view = mount(ResourceHealthCenter)
    await view
      .findAll('button')
      .find((item) => item.text() === '检查原件与空间')!
      .trigger('click')
    await flushPromises()
    expect(api.info).toHaveBeenCalledOnce()
    expect(view.text()).toContain('请先解锁保险库')
    expect(
      view
        .findAll('button')
        .find((item) => item.text() === '清理帖子媒体')!
        .attributes('disabled'),
    ).toBeDefined()
    view.unmount()
  })
  it('explains a chart category before a separate cleanup confirmation and keeps originals untouched', async () => {
    api.info.mockResolvedValue({
      totalBytes: 1000,
      objectBytes: 300,
      libraryBytes: 320,
      internalBreakdown: { databaseBytes: 400, fileGroups: { 'srl-app-data': 200 } },
    })
    api.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const view = mount(ResourceHealthCenter)
    await view
      .findAll('button')
      .find((item) => item.text() === '检查原件与空间')!
      .trigger('click')
    await flushPromises()
    await view
      .findAll('.storage-usage__legend button')
      .find((item) => item.text().includes('文字、设置与查询记录'))!
      .trigger('click')
    await flushPromises()
    expect(api.confirm).toHaveBeenCalledTimes(2)
    expect(api.confirm.mock.calls[0]![0]).toMatchObject({ confirmLabel: '查看清理内容' })
    expect(api.confirm.mock.calls[1]![0].message).toContain('会保留：完整角色卡、聊天正文')
    expect(api.optimize).not.toHaveBeenCalled()
    expect(api.recover).not.toHaveBeenCalled()
    view.unmount()
  })
  it('releases post media only after showing what will be removed and its offline impact', async () => {
    api.mediaUsage.mockResolvedValue({ count: 3, bytes: 1024 })
    api.clearMedia.mockResolvedValue({ count: 2, bytes: 800, retainedCount: 1 })
    api.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const view = mount(ResourceHealthCenter)
    await view
      .findAll('button')
      .find((item) => item.text() === '检查原件与空间')!
      .trigger('click')
    await flushPromises()
    const clean = view.findAll('button').find((item) => item.text() === '清理帖子媒体')!
    await clean.trigger('click')
    await flushPromises()
    expect(api.clearMedia).not.toHaveBeenCalled()
    expect(api.confirm.mock.calls[0]![0].message).toContain('需要联网查看')
    await clean.trigger('click')
    await flushPromises()
    expect(api.clearMedia).toHaveBeenCalledOnce()
    expect(api.notice).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('保留 1 个共用') }),
    )
    view.unmount()
  })
  it('cleans only retired translation models after confirmation and refreshes sizes without scanning originals', async () => {
    api.info.mockResolvedValueOnce({
      totalBytes: 200,
      supportsRetiredTranslationModelCleanup: true,
      objectBytes: 100,
      internalBreakdown: {
        noBackupBreakdown: {
          otherEntries: [{ name: 'com.google.mlkit.translate.models', bytes: 50, directory: true }],
        },
      },
    })
    api.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    api.clearCaches.mockResolvedValue(50)
    const view = mount(ResourceHealthCenter)
    await view
      .findAll('button')
      .find((item) => item.text() === '检查原件与空间')!
      .trigger('click')
    await flushPromises()
    const button = view.findAll('button').find((item) => item.text() === '删除已停用翻译模型')!
    await button.trigger('click')
    await flushPromises()
    expect(api.clearCaches).not.toHaveBeenCalled()
    const candidateCalls = api.candidates.mock.calls.length
    await button.trigger('click')
    await flushPromises()
    expect(api.clearCaches).toHaveBeenCalledWith({ scope: 'retiredTranslationModels' })
    expect(api.info).toHaveBeenLastCalledWith({ includeDetails: true })
    expect(api.candidates.mock.calls.length).toBe(candidateCalls)
    expect(api.recover).not.toHaveBeenCalled()
    expect(view.text()).not.toContain('删除已停用翻译模型')
    view.unmount()
  })
  it('separates private directory bytes, reusable database pages and logical attachment references', async () => {
    api.info.mockResolvedValue({
      ...(await api.info()),
      internalBreakdown: {
        filesBytes: 1024,
        databaseBytes: 2048,
        preferencesBytes: 3,
        noBackupBytes: 4,
        otherBytes: 5,
        fileGroups: { 'srl-app-data': 900, 'official-apps': 124 },
        blobFilesBytes: 900,
        pendingBlobFilesBytes: 0,
        noBackupBreakdown: { databaseBytes: 2, walBytes: 1, shmBytes: 1, otherBytes: 0 },
      },
      nativeDatabase: {
        fileBytes: 2000,
        walBytes: 40,
        shmBytes: 8,
        pageBytes: 2000,
        freePageBytes: 1000,
        uniqueReferencedBlobBytes: 900,
        pendingBlobCount: 0,
        pendingExpectedBytes: 0,
        stores: [{ store: 'assetFiles', records: 2, jsonBytes: 20, blobReferenceBytes: 1800 }],
      },
    })
    const view = mount(ResourceHealthCenter)
    await view
      .findAll('button')
      .find((item) => item.text() === '检查原件与空间')!
      .trigger('click')
    await flushPromises()
    expect(view.text()).toContain('内部文件 1.0 KiB')
    expect(view.text()).toContain('数据库目录 2.0 KiB')
    expect(api.info).toHaveBeenCalledWith({ includeDetails: true })
    expect(view.text()).toContain('其中后台任务数据库 2 B，写入日志 1 B，共享索引 1 B，其他 0 B')
    expect(view.text()).toContain('内置 APP 程序文件：124 B')
    expect(view.text()).toContain('可复用空闲页 1000 B（未压缩或删除）')
    expect(view.text()).toContain('素材文件（含缩略图）：2 条，文字记录 20 B，附件引用 1.8 KiB')
    expect(view.text()).toContain('共享附件可能被多表引用')
    expect(api.recover).not.toHaveBeenCalled()
    expect(api.repair).not.toHaveBeenCalled()
    view.unmount()
  })

  it('does not report failed optional native database diagnostics as zero bytes', async () => {
    api.info.mockResolvedValue({ ...(await api.info()), nativeDatabaseUnavailable: true })
    const view = mount(ResourceHealthCenter)
    await view
      .findAll('button')
      .find((item) => item.text() === '检查原件与空间')!
      .trigger('click')
    await flushPromises()
    expect(view.text()).toContain('本次未能读取原生数据库明细，不能将其视为零占用')
    expect(view.text()).not.toContain('数据库文件 0 B')
    view.unmount()
  })

  it('distinguishes database payload from native references and disk occupancy', async () => {
    api.accounting.mockResolvedValue({ ...accounting, nativeReferenceBytes: 5 * 1024 * 1024 })
    const view = mount(ResourceHealthCenter)
    await view
      .findAll('button')
      .find((button) => button.text() === '检查原件与空间')!
      .trigger('click')
    await flushPromises()
    expect(view.text()).toContain('数据库内原件载荷（不含原生文件引用）')
    expect(view.text()).toContain('已关联原生原件的逻辑大小（当前与历史合计） 5.0 MiB')
    expect(view.text()).toContain('此数值不是去重后的磁盘占用')
    expect(view.text()).toContain('不是运行内存')
    view.unmount()
  })

  it('shows browser storage and original accounting on iOS without calling Android recovery', async () => {
    api.info.mockResolvedValue(null)
    const view = mount(ResourceHealthCenter)
    await view
      .findAll('button')
      .find((button) => button.text() === '检查原件与空间')!
      .trigger('click')
    await flushPromises()
    expect(view.text()).toContain('网页本机存储')
    expect(view.text()).toContain('100 B')
    expect(view.text()).toContain('1.0 KiB')
    expect(view.text()).toContain('当前原件 10 B')
    expect(view.text()).toContain('素材库 12 B')
    expect(api.accounting).toHaveBeenCalledOnce()
    expect(api.candidates).not.toHaveBeenCalled()
    expect(api.mirrors).not.toHaveBeenCalled()
    expect(api.scan).not.toHaveBeenCalled()
    view.unmount()
  })

  it('reports unavailable browser estimates without claiming zero disk usage', async () => {
    api.info.mockResolvedValue(null)
    api.browserHealth.mockResolvedValue({ supported: false, persisted: false, usage: 0, quota: 0 })
    const view = mount(ResourceHealthCenter)
    await view
      .findAll('button')
      .find((button) => button.text() === '检查原件与空间')!
      .trigger('click')
    await flushPromises()
    expect(view.text()).toContain('当前浏览器未提供占用总量')
    expect(view.text()).toContain('当前原件 10 B')
    expect(view.text()).not.toContain('站点已用 0 B')
    view.unmount()
  })

  it.each([true, false])(
    'shows purpose categories without expanding technical details (estimate available: %s)',
    async (supported) => {
      api.info.mockResolvedValue(null)
      api.browserHealth.mockResolvedValue({
        supported,
        persisted: false,
        usage: supported ? 10000 : 0,
        quota: supported ? 20000 : 0,
      })
      api.accounting.mockResolvedValue({
        ...accounting,
        browserStores: [
          { store: 'resources', bytes: 1024, records: 2 },
          { store: 'resourceVersions', bytes: 2048, records: 3 },
          { store: 'externalAppData', bytes: 4096, records: 10 },
          { store: 'settings', bytes: 128, records: 5 },
        ],
      })
      const view = mount(ResourceHealthCenter)
      expect(api.accounting).not.toHaveBeenCalled()
      await view
        .findAll('button')
        .find((button) => button.text() === '检查原件与空间')!
        .trigger('click')
      await flushPromises()
      const section = view.get('[aria-label="网页数据用途分类"]')
      expect(section.find('details').exists()).toBe(false)
      expect(section.text()).toContain('当前资源1.0 KiB · 2 条')
      expect(section.text()).toContain('历史版本2.0 KiB · 3 条')
      expect(section.text()).toContain('APP 使用数据与草稿4.0 KiB · 10 条')
      expect(section.text()).toContain('素材与缩略图0 B · 0 条')
      expect(view.get('.storage-usage').text()).toContain('已统计数据（估算）')
      expect(view.get('.storage-usage').text()).not.toContain('浏览器本机存储')
      expect(api.accounting).toHaveBeenCalledWith(
        expect.objectContaining({ browserDetails: true, signal: expect.any(AbortSignal) }),
      )
      await view.get('.storage-usage__legend button').trigger('click')
      expect(api.confirm).toHaveBeenCalledWith(
        expect.objectContaining({ title: '当前资源 · 1.0 KiB', confirmLabel: '知道了' }),
      )
      expect(api.optimize).not.toHaveBeenCalled()
      view.unmount()
    },
  )

  it.each(['button', 'task', 'unmount'])(
    'stops browser accounting via %s and ignores a late success',
    async (stop) => {
      api.info.mockResolvedValue(null)
      let finish!: (value: unknown) => void
      api.accounting.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      )
      const view = mount(ResourceHealthCenter)
      await view
        .findAll('button')
        .find((button) => button.text() === '检查原件与空间')!
        .trigger('click')
      await flushPromises()
      const options = api.accounting.mock.calls[0]![0]
      options.onProgress(1, 26)
      await flushPromises()
      expect(taskCenter.update).toHaveBeenCalled()
      if (stop === 'button')
        await view
          .findAll('button')
          .find((button) => button.text() === '停止统计')!
          .trigger('click')
      else if (stop === 'task') vi.mocked(taskCenter.start).mock.calls[0]![0].cancel!()
      else view.unmount()
      expect(options.signal.aborted).toBe(true)
      finish({ ...accounting, browserStores: [{ store: 'resources', bytes: 9999, records: 1 }] })
      await flushPromises()
      expect(view.find('[aria-label="网页数据用途分类"]').exists()).toBe(false)
      if (stop !== 'unmount') expect(view.text()).toContain('用途统计已停止')
      expect(taskCenter.cancelled).toHaveBeenCalledWith('browser-usage')
      expect(api.accounting).toHaveBeenCalledOnce()
      if (stop === 'unmount') return
      await view
        .findAll('button')
        .find((button) => button.text() === '检查原件与空间')!
        .trigger('click')
      await flushPromises()
      expect(api.accounting).toHaveBeenCalledTimes(2)
      view.unmount()
    },
  )

  it('keeps a failed browser inventory incomplete and does not retry it automatically', async () => {
    api.info.mockResolvedValue(null)
    api.accounting.mockRejectedValue(new Error('无法读取数据库'))
    const view = mount(ResourceHealthCenter)
    await view
      .findAll('button')
      .find((button) => button.text() === '检查原件与空间')!
      .trigger('click')
    await flushPromises()
    expect(view.text()).toContain('无法读取数据库')
    expect(view.find('[aria-label="网页数据用途分类"]').exists()).toBe(false)
    expect(api.accounting).toHaveBeenCalledOnce()
    expect(taskCenter.fail).toHaveBeenCalledWith('browser-usage', expect.any(Error))
    view.unmount()
  })

  it('shows in-progress inspection feedback and returns to the actionable button', async () => {
    let finish!: (value: null) => void
    api.info.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    const view = mount(ResourceHealthCenter)
    const button = view.findAll('button').find((item) => item.text() === '检查原件与空间')!
    await button.trigger('click')
    expect(button.text()).toBe('正在检查…')
    expect(button.attributes('disabled')).toBeDefined()
    finish(null)
    await flushPromises()
    expect(button.text()).toBe('检查原件与空间')
    expect(button.attributes('disabled')).toBeUndefined()
    view.unmount()
  })

  it('uses the post-cleanup measurement without another scan and unsubscribes on close', async () => {
    const view = mount(ResourceHealthCenter)
    await view
      .findAll('button')
      .find((button) => button.text() === '检查原件与空间')!
      .trigger('click')
    await flushPromises()
    expect(view.text()).toContain('应用数据 700 B')
    domainEvents.emit('NativeTemporaryCachesCleared', {
      storage: {
        ...(await api.info()),
        totalBytes: 530,
        webViewBytes: 163,
        webViewBreakdown: {
          siteDataBytes: 120,
          cacheBytes: 20,
          temporaryBlobBytes: 10,
          otherBytes: 13,
        },
      },
      measuredAt: Date.now(),
    })
    await flushPromises()
    expect(view.text()).toContain('应用数据 530 B')
    expect(view.text()).toContain('非实时值')
    expect(view.text()).toContain('临时 Blob 10 B')
    expect(api.candidates).toHaveBeenCalledOnce()
    expect(api.accounting).toHaveBeenCalledOnce()
    expect(api.scan).not.toHaveBeenCalled()
    const calls = api.info.mock.calls.length
    view.unmount()
    domainEvents.emit('NativeTemporaryCachesCleared', { storage: null, measuredAt: Date.now() })
    expect(api.info).toHaveBeenCalledTimes(calls)
  })

  it('does not overwrite a post-cleanup measurement with an older in-flight inspection', async () => {
    const info = await api.info()
    let resolveInfo!: (value: unknown) => void
    api.info.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveInfo = resolve
      }),
    )
    const view = mount(ResourceHealthCenter)
    await view
      .findAll('button')
      .find((button) => button.text() === '检查原件与空间')!
      .trigger('click')
    domainEvents.emit('NativeTemporaryCachesCleared', {
      storage: { ...info, totalBytes: 530 },
      measuredAt: Date.now(),
    })
    resolveInfo(info)
    await flushPromises()
    expect(view.text()).toContain('应用数据 530 B')
    expect(view.text()).not.toContain('应用数据 700 B')
    view.unmount()
  })

  it('shows recognized names and emits a refresh without re-running the full audit after recovery', async () => {
    const view = mount(ResourceHealthCenter)
    await view
      .findAll('.resource-health__summary button')
      .find((button) => button.text() === '检查原件与空间')!
      .trigger('click')
    await flushPromises()
    expect(view.text()).toContain('找回的角色')
    await view.get('input[type=checkbox]').setValue(true)
    await view.get('.resource-health__actions .button--primary').trigger('click')
    await flushPromises()
    expect(api.recover).toHaveBeenCalledOnce()
    expect(api.recover).toHaveBeenCalledWith([
      {
        contentHash: 'a'.repeat(64),
        size: 180,
        nativeId: 'surviving-native-id',
        nativeScope: 'current',
        fileName: '崩溃前角色卡.json',
      },
    ])
    expect(api.scan).not.toHaveBeenCalled()
    expect(api.candidates).toHaveBeenCalledTimes(2)
    expect(view.emitted('library-changed')).toHaveLength(1)
    view.unmount()
  })
  it('offers in-place repair for old placeholders and keeps accounting explicitly non-additive', async () => {
    const view = mount(ResourceHealthCenter)
    await view
      .findAll('.resource-health__summary button')
      .find((button) => button.text() === '检查原件与空间')!
      .trigger('click')
    await flushPromises()
    const repair = view.findAll('button').find((button) => button.text().includes('补全以前'))!
    await repair.trigger('click')
    await flushPromises()
    expect(api.repair).toHaveBeenCalledOnce()
    expect(api.scan).not.toHaveBeenCalled()
    expect(view.text()).toContain('不能与总量相加')
    expect(view.text()).toContain('本地恢复副本')
    expect(view.text()).toContain('其中缩略图')
    view.unmount()
  })
  it('inspects and recovers without full health scanning or repeated whole-library accounting', async () => {
    const view = mount(ResourceHealthCenter)
    await view
      .findAll('button')
      .find((button) => button.text() === '检查原件与空间')!
      .trigger('click')
    await flushPromises()
    await view.get('input[type=checkbox]').setValue(true)
    await view.get('.resource-health__actions .button--primary').trigger('click')
    await flushPromises()
    expect(api.scan).not.toHaveBeenCalled()
    expect(api.accounting).toHaveBeenCalledOnce()
    expect(api.candidates).toHaveBeenCalledTimes(2)
    view.unmount()
  })
  it('reports inspection errors without claiming empty storage or deleting files', async () => {
    api.info.mockRejectedValue(new Error('storage unavailable'))
    const view = mount(ResourceHealthCenter)
    await view
      .findAll('button')
      .find((button) => button.text() === '检查原件与空间')!
      .trigger('click')
    await flushPromises()
    expect(api.notice).toHaveBeenCalledWith({ type: 'error', message: 'storage unavailable' })
    expect(api.recover).not.toHaveBeenCalled()
    view.unmount()
  })
  it('does not attempt the new native API on an old APK', async () => {
    api.info.mockResolvedValue({ totalBytes: 700, objectBytes: 180, objectCount: 1 })
    const view = mount(ResourceHealthCenter)
    await view
      .findAll('.resource-health__summary button')
      .find((button) => button.text() === '检查原件与空间')!
      .trigger('click')
    await flushPromises()
    expect(api.preview).not.toHaveBeenCalled()
    expect(view.text()).toContain('仅更新网页无效')
    expect(
      view.get('.resource-health__actions .button--primary').attributes('disabled'),
    ).toBeDefined()
    view.unmount()
  })
})
