import { afterEach, expect, it, vi } from 'vitest'
import { zipSync } from 'fflate'
import type { AppDatabase } from '../database/AppDatabase'

const plugin = vi.hoisted(() => ({
  listArchiveEntries: vi.fn(),
  stageArchive: vi.fn(),
  addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
  readArchiveEntry: vi.fn(),
  deleteArchiveJob: vi.fn(),
}))
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true, convertFileSrc: (uri: string) => uri },
  registerPlugin: () => plugin,
}))
import { NativeRestoreStagingStore } from './NativeRestoreStagingStore'
import { rememberNativeFile, nativeFileSource, nativeFileSize } from '../core/NativeFileSource'
import * as nativeMirror from './NativeResourceFileMirror'
import * as nativeRuntime from './AndroidNativeDexieCore'
import { stageArchive } from '../services/ArchiveExtraction'

afterEach(() => {
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})
const archive = () =>
  rememberNativeFile(
    new File(
      [new Uint8Array(zipSync({ 'manifest.json': new TextEncoder().encode('{}') }))],
      'backup.zip',
    ),
    'file:///backup.zip',
  )

it('原生大原件只返回显式文件引用；旧库和缺失加速接口仍交给正文路径', async () => {
  const active = vi.spyOn(nativeRuntime, 'isAndroidNativeAppDatabaseActive').mockReturnValue(true)
  const available = vi.spyOn(nativeMirror, 'canImportNativeResourceObjects').mockResolvedValue(true)
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  plugin.readArchiveEntry.mockResolvedValue({
    entry: {
      jobId: 'native-zip-files',
      path: 'large.bin',
      uri: 'file:///staged',
      size: 33554432,
      sha256: 'a'.repeat(64),
      updatedAt: 1,
    },
  })
  try {
    const store = new NativeRestoreStagingStore({} as AppDatabase)
    const entry = await store.getNativeFile('native-zip-files', 'large.bin')
    expect(entry?.blob.size).toBe(0)
    expect(nativeFileSize(entry!.blob)).toBe(33554432)
    expect(nativeFileSource(entry!.blob)).toBe('file:///staged')
    await store.getNativeFile('native-zip-files', 'large.bin')
    expect(available).toHaveBeenCalledOnce()
    expect(fetcher).not.toHaveBeenCalled()
    active.mockReturnValue(false)
    expect(await store.getNativeFile('native-zip-files', 'large.bin')).toBeUndefined()
    active.mockReturnValue(true)
    available.mockResolvedValue(false)
    expect(
      await new NativeRestoreStagingStore({} as AppDatabase).getNativeFile(
        'native-zip-files',
        'large.bin',
      ),
    ).toBeUndefined()
  } finally {
    active.mockRestore()
    available.mockRestore()
  }
})

it('备份预检使用同一原生解压 Owner，保留可重建的 jobId 和文件引用', async () => {
  const store = new NativeRestoreStagingStore({} as AppDatabase)
  plugin.stageArchive.mockResolvedValue({
    jobId: 'native-zip-checkpoint',
    stagedBytes: 2,
    completedEntries: 1,
  })
  const file = archive()
  expect(await stageArchive(file, store)).toBe('native-zip-checkpoint')
  expect(plugin.stageArchive).toHaveBeenCalledWith(
    expect.objectContaining({
      uri: 'file:///backup.zip',
      size: file.size,
      requestId: expect.any(String),
    }),
  )
  plugin.readArchiveEntry.mockResolvedValue({
    entry: {
      jobId: 'native-zip-checkpoint',
      path: 'manifest.json',
      uri: 'file:///staged',
      size: 2,
      sha256: 'hash',
      updatedAt: 1,
    },
  })
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['{}']) }),
  )
  const entry = await store.get('native-zip-checkpoint', 'manifest.json')
  expect(await entry!.blob.text()).toBe('{}')
  expect(nativeFileSource(entry!.blob)).toBe('file:///staged')
  expect(plugin.deleteArchiveJob).not.toHaveBeenCalled()
  await store.deleteJob('native-zip-checkpoint')
  expect(plugin.deleteArchiveJob).toHaveBeenCalledWith({ jobId: 'native-zip-checkpoint' })
})

it('分享 ZIP 占位文件按原生声明大小入 NativeArchive 并转发真实进度', async () => {
  const store = new NativeRestoreStagingStore({} as AppDatabase)
  const file = rememberNativeFile(
    new File([], 'large-backup.zip'),
    'file:///large-backup.zip',
    5_000_000_000,
  )
  let progressListener:
    | ((event: {
        requestId: string
        completedEntries: number
        reusedEntries: number
        phase: 'hashing' | 'staging'
        readBytes: number
        totalBytes: number
        entryCount: number
        stagedBytes: number
        totalStagedBytes: number
      }) => void)
    | undefined
  plugin.addListener.mockImplementation(async (_event, listener) => {
    progressListener = listener
    return { remove: vi.fn() }
  })
  plugin.stageArchive.mockImplementation(async (options) => {
    progressListener?.({
      requestId: options.requestId,
      completedEntries: 1,
      reusedEntries: 0,
      phase: 'staging',
      readBytes: options.size,
      totalBytes: options.size,
      entryCount: 1,
      stagedBytes: 12_000,
      totalStagedBytes: 24_000,
    })
    return { jobId: 'native-zip-large', stagedBytes: 24_000, completedEntries: 1 }
  })
  const progress = vi.fn()

  expect(await stageArchive(file, store, undefined, progress)).toBe('native-zip-large')
  expect(plugin.stageArchive).toHaveBeenCalledWith(
    expect.objectContaining({ uri: 'file:///large-backup.zip', size: 5_000_000_000 }),
  )
  expect(progress).toHaveBeenCalledWith(
    expect.objectContaining({
      phase: 'staging',
      stagedBytes: 12_000,
      totalStagedBytes: 24_000,
    }),
  )
  expect(plugin.addListener).toHaveBeenCalledTimes(1)
})

it('原生 ZIP 选择只把筛选后的条目交给暂存 owner', async () => {
  const store = new NativeRestoreStagingStore({} as AppDatabase)
  const file = rememberNativeFile(new File([], 'tavern.zip'), 'file:///tavern.zip', 9_000_000)
  plugin.listArchiveEntries.mockResolvedValue({
    paths: ['settings.json', 'characters/a.json', 'chats/a/1.jsonl', 'chats/b/2.jsonl'],
  })
  plugin.stageArchive.mockResolvedValue({
    jobId: 'native-zip-session-0123456789abcdef0123456789abcdef',
    stagedBytes: 40,
    completedEntries: 2,
  })
  const select = vi.fn((path: string) => !path.startsWith('chats/'))

  await expect(stageArchive(file, store, select)).resolves.toContain('native-zip-session-')

  expect(select).toHaveBeenCalledTimes(4)
  expect(plugin.stageArchive).toHaveBeenCalledWith(
    expect.objectContaining({
      uri: 'file:///tavern.zip',
      size: 9_000_000,
      selectedPaths: ['settings.json', 'characters/a.json'],
    }),
  )
})

it('非法 ZIP 在原生暂存前被原有中央目录校验拒绝', async () => {
  const store = new NativeRestoreStagingStore({} as AppDatabase)
  const file = rememberNativeFile(new File(['not a ZIP'], 'bad.zip'), 'file:///bad.zip')
  await expect(stageArchive(file, store)).rejects.toThrow()
  expect(plugin.stageArchive).not.toHaveBeenCalled()
})

it('仅旧 APK 缺能力时降级；磁盘错误不触发第二次解压', async () => {
  const store = new NativeRestoreStagingStore({} as AppDatabase)
  plugin.stageArchive
    .mockRejectedValueOnce({ code: 'UNIMPLEMENTED' })
    .mockRejectedValueOnce(new Error('disk full'))
  expect(await store.stageNativeArchive(archive())).toBeUndefined()
  await expect(store.stageNativeArchive(archive())).rejects.toThrow('disk full')
})
