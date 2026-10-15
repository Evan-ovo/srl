import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  readdir: vi.fn(),
  writeFile: vi.fn(),
  appendFile: vi.fn(),
  getUri: vi.fn(),
  deleteFile: vi.fn(),
  rmdir: vi.fn(),
  share: vi.fn(),
  start: vi.fn(),
  update: vi.fn(),
  updateTransfer: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  cancelled: vi.fn(),
}))
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }))
vi.mock('@capacitor/filesystem', () => ({ Directory: { Cache: 'CACHE' }, Filesystem: native }))
vi.mock('@capacitor/share', () => ({ Share: { share: native.share } }))
vi.mock('../core/TaskCenter', () => ({ taskCenter: native }))

import { RESOURCE_TYPE, type ResourceReference } from '../types/Resource'
import {
  formatBackupDate,
  formatBytes,
  summarizeFileNames,
  summarizeResourceTypes,
  downloadBlob,
} from './LibraryFormatting'

function reference(type: ResourceReference['type']): ResourceReference {
  return { id: `id-${type}`, type } as ResourceReference
}

describe('formatBytes', () => {
  it('零字节显示为 0 B', () => {
    expect(formatBytes(0)).toBe('0 B')
  })

  it('按 KB / MB / GB 逐级换算', () => {
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.00 GB')
  })
})

describe('formatBackupDate', () => {
  it('没有时间戳时提示尚未备份', () => {
    expect(formatBackupDate()).toBe('尚未完整备份')
    expect(formatBackupDate(0)).toBe('尚未完整备份')
  })

  it('有时间戳时输出本地化时间', () => {
    expect(formatBackupDate(Date.UTC(2026, 6, 26))).toContain('2026')
  })
})

describe('summarizeResourceTypes', () => {
  it('按类型统计并使用中文标签', () => {
    const summary = summarizeResourceTypes([
      reference(RESOURCE_TYPE.CHARACTER_CARD),
      reference(RESOURCE_TYPE.CHARACTER_CARD),
      reference(RESOURCE_TYPE.WORLD_BOOK),
    ])
    expect(summary).toContain('2')
    expect(summary).toContain('1')
    expect(summary).toContain('、')
  })

  it('空列表返回空字符串', () => {
    expect(summarizeResourceTypes([])).toBe('')
  })
})

describe('summarizeFileNames', () => {
  it('不超过上限时全部展示', () => {
    expect(summarizeFileNames(['a.png', 'b.json'])).toBe('a.png、b.json')
  })

  it('超出上限时补充剩余数量', () => {
    expect(summarizeFileNames(['a', 'b', 'c', 'd', 'e'])).toBe('a、b、c，另有 2 项')
  })

  it('支持自定义上限', () => {
    expect(summarizeFileNames(['a', 'b', 'c'], 1)).toBe('a，另有 2 项')
  })
})

describe('native export filenames and cache lifecycle', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    native.readdir.mockResolvedValue({ files: [] })
    native.deleteFile.mockResolvedValue(undefined)
    native.rmdir.mockResolvedValue(undefined)
    native.getUri.mockImplementation(async ({ path }) => ({ uri: `file:///cache/${path}` }))
    native.start.mockReturnValue('export-task')
  })
  it('shares the preset name while concurrent same-name exports use different directories', async () => {
    await Promise.all([
      downloadBlob(new Blob([':root { color: pink; }']), '粉樱.css'),
      downloadBlob(new Blob(['body { color: red; }']), '粉樱.css'),
    ])
    const paths = native.writeFile.mock.calls.map(([value]) => value.path as string)
    expect(paths).toHaveLength(2)
    expect(paths[0]).not.toBe(paths[1])
    for (const path of paths) expect(path.split('/').at(-1)).toBe('粉樱.css')
    const texts = native.writeFile.mock.calls.map(([value]) => atob(value.data))
    expect(texts.sort()).toEqual([':root { color: pink; }', 'body { color: red; }'].sort())
    for (const [options] of native.share.mock.calls) {
      expect(options.title).toBe('粉樱.css')
      expect(options.url.split('/').at(-1)).toBe('粉樱.css')
    }
    expect(native.rmdir).not.toHaveBeenCalled()
  })
  it.each(['', '.', '..'])(
    'prevents an invalid filename escaping its unique directory: %s',
    async (name) => {
      await downloadBlob(new Blob([]), name)
      expect(native.writeFile.mock.calls[0]![0].path.split('/').at(-1)).toBe('srl-export')
    },
  )
  it('cleans only old export files and recognized task directories', async () => {
    const old = Date.now() - 8 * 24 * 60 * 60 * 1000
    const folder = '1791910000000-11111111-1111-4111-8111-111111111111'
    native.readdir.mockResolvedValue({
      files: [
        { name: 'old-粉樱.css', type: 'file', mtime: old },
        { name: folder, type: 'directory', mtime: old },
        { name: 'user-folder', type: 'directory', mtime: old },
        {
          name: `${Date.now()}-22222222-2222-4222-8222-222222222222`,
          type: 'directory',
          mtime: Date.now(),
        },
      ],
    })
    await downloadBlob(new Blob(['a{}']), '粉樱.css')
    expect(native.deleteFile.mock.calls.map(([value]) => value.path)).toEqual([
      'exports/old-粉樱.css',
    ])
    expect(native.rmdir.mock.calls.map(([value]) => value.path)).toEqual([`exports/${folder}`])
  })
  it('cleans a failed write directory without opening the share panel', async () => {
    native.writeFile.mockRejectedValueOnce(new Error('写入失败'))
    await expect(downloadBlob(new Blob(['a{}']), '粉樱.css')).rejects.toThrow('写入失败')
    expect(native.share).not.toHaveBeenCalled()
    const path = native.writeFile.mock.calls[0]![0].path as string
    expect(native.rmdir).toHaveBeenCalledWith({
      path: path.slice(0, path.lastIndexOf('/')),
      directory: 'CACHE',
      recursive: true,
    })
  })
  it('keeps files after system handoff even when the share panel returns an error', async () => {
    native.share.mockRejectedValueOnce(new Error('分享取消'))
    await expect(downloadBlob(new Blob(['a{}']), '粉樱.css')).rejects.toThrow('分享取消')
    expect(native.rmdir).not.toHaveBeenCalled()
    expect(native.deleteFile).not.toHaveBeenCalled()
  })
  it('retains task cancellation before handoff and cleans the partial directory', async () => {
    native.writeFile.mockImplementationOnce(async () => native.start.mock.calls[0]![0].cancel())
    await expect(downloadBlob(new Blob(['a{}']), '粉樱.css')).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(native.share).not.toHaveBeenCalled()
    expect(native.cancelled).toHaveBeenCalledWith('export-task')
    expect(native.rmdir).toHaveBeenCalledTimes(1)
  })
})
