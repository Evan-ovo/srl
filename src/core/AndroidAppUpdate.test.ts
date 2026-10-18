// SRL-PUBLIC-SYNC: BEGIN PUBLIC-ONLY id=public-apk-update-tests
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  currentVersion: vi.fn(async () => ({ versionCode: 1, versionName: '0.0.1' })),
  downloadAndInstall: vi.fn(async () => ({ status: 'install_started' })),
  chooseAction: vi.fn(async () => 'confirm'),
  cancelDownload: vi.fn(async () => ({ status: 'cancelled' })),
  httpRequest: vi.fn(),
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
  CapacitorHttp: { request: mocks.httpRequest },
  registerPlugin: () => ({
    getCurrentVersion: mocks.currentVersion,
    downloadAndInstall: mocks.downloadAndInstall,
    cancelDownload: mocks.cancelDownload,
  }),
}))
vi.mock('./GitHubAndroidApkRelease', () => ({
  loadAndroidApkRelease: async () => {
    const r = await mocks.httpRequest()
    return { status: r.status, release: r.data }
  },
}))
vi.mock('../composables/UseConfirmDialog', () => ({ chooseAction: mocks.chooseAction }))

import { checkForAndroidAppUpdate } from './AndroidAppUpdate'
import { taskCenter } from './TaskCenter'

const release = {
  versionCode: 2,
  versionName: '0.0.2',
  apkUrl: 'https://github.com/owner/project/releases/download/public-test/SRL_Pubilc.apk',
  sha256: 'a'.repeat(64),
  sizeBytes: 123,
  notes: '测试更新；本次更新包含本地数据迁移，建议更新前完成本地备份或云备份。',
}

describe('AndroidAppUpdate', () => {
  it('waits for cancellation acknowledgement when native download failure arrives first', async () => {
    let reject!: (error: Error) => void
    mocks.httpRequest.mockResolvedValue({ data: release, status: 200, headers: {} })
    mocks.downloadAndInstall.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail
        }),
    )
    mocks.cancelDownload.mockImplementationOnce(async () => {
      reject(new Error('APK 更新下载已取消'))
      await Promise.resolve()
      return { status: 'cancelled' }
    })
    const pending = checkForAndroidAppUpdate(true)
    let operationId = ''
    await vi.waitFor(() => {
      const task = taskCenter
        .list()
        .find((item) => item.name === 'APK 更新下载' && item.status === 'running')
      expect(task).toBeDefined()
      operationId = task!.operationId
    })
    expect(taskCenter.cancel(operationId)).toBe(true)
    expect(await pending).toContain('已取消 APK 下载')
    await vi.waitFor(() =>
      expect(taskCenter.list().find((item) => item.operationId === operationId)?.status).toBe(
        'cancelled',
      ),
    )
    expect(mocks.cancelDownload).toHaveBeenCalledWith({ taskId: expect.any(String) })
  })

  it('手动入口加入自动检查仍显示已忽略版本，失败后可重新请求', async () => {
    localStorage.setItem('srl.apk-update.ignored-version-code', String(release.versionCode))
    mocks.httpRequest.mockResolvedValue({ data: release, status: 200, headers: {} })
    const automatic = checkForAndroidAppUpdate()
    const manual = checkForAndroidAppUpdate(true)
    await Promise.all([automatic, manual])
    expect(mocks.httpRequest).toHaveBeenCalledTimes(1)
    expect(mocks.chooseAction).toHaveBeenCalledTimes(1)
    mocks.httpRequest.mockRejectedValueOnce(new Error('offline'))
    await expect(checkForAndroidAppUpdate(true)).rejects.toThrow('offline')
    await expect(checkForAndroidAppUpdate(true)).resolves.toContain('系统安装确认页')
    expect(mocks.httpRequest).toHaveBeenCalledTimes(3)
  })

  it('合并重叠手动检查、确认和安装；结束后仍可重新检查', async () => {
    let finish!: (choice: string) => void
    mocks.chooseAction.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    mocks.httpRequest.mockResolvedValue({ data: release, status: 200, headers: {} })
    const first = checkForAndroidAppUpdate(true)
    const second = checkForAndroidAppUpdate(true)
    await vi.waitFor(() => expect(mocks.chooseAction).toHaveBeenCalled())
    finish('confirm')
    await Promise.all([first, second])
    expect(mocks.httpRequest).toHaveBeenCalledTimes(1)
    expect(mocks.currentVersion).toHaveBeenCalledTimes(1)
    expect(mocks.chooseAction).toHaveBeenCalledTimes(1)
    expect(mocks.downloadAndInstall).toHaveBeenCalledTimes(1)
    await checkForAndroidAppUpdate(true)
    expect(mocks.httpRequest).toHaveBeenCalledTimes(2)
  })

  afterEach(() => {
    localStorage.clear()
    mocks.chooseAction.mockReset()
    mocks.chooseAction.mockResolvedValue('confirm')
    mocks.currentVersion.mockReset()
    mocks.currentVersion.mockResolvedValue({ versionCode: 1, versionName: '0.0.1' })
    mocks.downloadAndInstall.mockClear()
    mocks.httpRequest.mockReset()
    vi.unstubAllGlobals()
  })

  it('手动检查到新 APK 后校验并交给原生安装器', async () => {
    mocks.httpRequest.mockResolvedValue({
      data: release,
      status: 200,
      headers: { 'content-type': 'application/json' },
      url: 'https://github.com/owner/project/api/app-update/android/latest',
    })

    await expect(checkForAndroidAppUpdate(true)).resolves.toContain('系统安装确认页')
    expect(mocks.chooseAction).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining(release.notes) }),
    )
    expect(mocks.chooseAction).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('安装和数据迁移可能受手机系统与设备状态影响'),
      }),
    )
    expect(mocks.chooseAction).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('本地资源不会被覆盖删除') }),
    )
    expect(mocks.downloadAndInstall).toHaveBeenCalledWith({
      url: release.apkUrl,
      sha256: release.sha256,
      sizeBytes: release.sizeBytes,
      taskId: expect.any(String),
    })
  })

  it('稍后提醒会在自动检查中抑制当前新版本', async () => {
    mocks.chooseAction.mockResolvedValueOnce('cancel')
    mocks.httpRequest.mockResolvedValue({
      data: release,
      status: 200,
      headers: { 'content-type': 'application/json' },
      url: 'https://github.com/owner/project/api/app-update/android/latest',
    })

    await expect(checkForAndroidAppUpdate(true)).resolves.toContain('24 小时')
    await expect(checkForAndroidAppUpdate()).resolves.toContain('暂不提示')
    expect(mocks.chooseAction).toHaveBeenCalledTimes(1)
  })

  it('不更新当前版本仅跳过该 versionCode，手动检查仍可再次显示', async () => {
    mocks.chooseAction.mockResolvedValueOnce('alternative').mockResolvedValueOnce('cancel')
    mocks.httpRequest.mockResolvedValue({
      data: release,
      status: 200,
      headers: { 'content-type': 'application/json' },
      url: 'https://github.com/owner/project/api/app-update/android/latest',
    })

    await expect(checkForAndroidAppUpdate(true)).resolves.toContain('不再提示')
    await expect(checkForAndroidAppUpdate()).resolves.toContain('暂不提示')
    await expect(checkForAndroidAppUpdate(true)).resolves.toContain('24 小时')
  })

  it('自动检查十二小时内只请求一次，手动检查不受限频影响', async () => {
    mocks.httpRequest.mockResolvedValue({
      data: { ...release, versionCode: 1 },
      status: 200,
      headers: { 'content-type': 'application/json' },
      url: 'https://github.com/owner/project/api/app-update/android/latest',
    })

    await expect(checkForAndroidAppUpdate()).resolves.toContain('最新')
    await expect(checkForAndroidAppUpdate()).resolves.toContain('限频')
    await expect(checkForAndroidAppUpdate(true)).resolves.toContain('最新')
    expect(mocks.httpRequest).toHaveBeenCalledTimes(2)
  })
})
// SRL-PUBLIC-SYNC: END PUBLIC-ONLY id=public-apk-update-tests
