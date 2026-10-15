/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'

const nativeMocks = vi.hoisted(() => ({
  isNativePlatform: vi.fn(() => true),
  readdir: vi.fn(),
  deleteFile: vi.fn(),
  writeFile: vi.fn(),
  appendFile: vi.fn(),
  getUri: vi.fn(),
  share: vi.fn(),
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: nativeMocks.isNativePlatform },
}))

vi.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' },
  Filesystem: {
    readdir: nativeMocks.readdir,
    deleteFile: nativeMocks.deleteFile,
    writeFile: nativeMocks.writeFile,
    appendFile: nativeMocks.appendFile,
    getUri: nativeMocks.getUri,
  },
}))

vi.mock('@capacitor/share', () => ({ Share: { share: nativeMocks.share } }))

import { downloadBlob } from './LibraryFormatting'

describe('downloadBlob Android native export', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    Object.values(nativeMocks).forEach((mock) => mock.mockReset())
    nativeMocks.isNativePlatform.mockReturnValue(true)
  })

  it('分块写入原生缓存、清理过期导出并打开系统分享', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000)
    nativeMocks.readdir.mockResolvedValue({
      files: [
        { name: 'expired.zip', type: 'file', mtime: 1 },
        { name: 'recent.zip', type: 'file', mtime: 2_000_000_000 },
      ],
    })
    nativeMocks.deleteFile.mockResolvedValue(undefined)
    nativeMocks.writeFile.mockResolvedValue(undefined)
    nativeMocks.appendFile.mockResolvedValue(undefined)
    nativeMocks.getUri.mockResolvedValue({ uri: 'file:///cache/export.zip' })
    nativeMocks.share.mockResolvedValue({})

    await downloadBlob(new Blob([new Uint8Array(512 * 1024 + 1)]), '备份.zip')

    expect(nativeMocks.deleteFile).toHaveBeenCalledWith({
      path: 'exports/expired.zip',
      directory: 'CACHE',
    })
    expect(nativeMocks.writeFile).toHaveBeenCalledTimes(1)
    expect(nativeMocks.appendFile).toHaveBeenCalledTimes(1)
    const writePath = nativeMocks.writeFile.mock.calls[0]![0].path as string
    expect(writePath).toMatch(/^exports\/2000000000-[0-9a-f-]{36}\/备份\.zip$/)
    expect(nativeMocks.appendFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: writePath }),
    )
    expect(nativeMocks.getUri).toHaveBeenCalledWith({
      path: writePath,
      directory: 'CACHE',
    })
    expect(nativeMocks.share).toHaveBeenCalledWith({
      title: '备份.zip',
      dialogTitle: '导出 SRL 文件',
      url: 'file:///cache/export.zip',
    })
  })
})
