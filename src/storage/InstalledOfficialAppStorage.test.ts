import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppDatabase } from '../database/AppDatabase'
import { hashBytes } from '../services/HashService'
import { InstalledOfficialAppStorage } from './InstalledOfficialAppStorage'

const filesystem = vi.hoisted(() => ({ stat: vi.fn(), getUri: vi.fn(), readFile: vi.fn() }))
const nativeFiles = vi.hoisted(() => ({ hasOfficialAppFiles: vi.fn() }))
vi.mock('@capacitor/filesystem', () => ({ Filesystem: filesystem, Directory: { Data: 'DATA' } }))
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => false,
    convertFileSrc: (uri: string) => `https://localhost/_capacitor_file_${uri.slice(7)}`,
  },
  registerPlugin: () => nativeFiles,
}))

describe('installed official APP storage', () => {
  it('removes only an unreadable indexed cache entry before rewriting verified bytes', async () => {
    const bytes = new TextEncoder().encode('export default 1')
    let response: Response | undefined
    const cache = {
      match: vi.fn(async () => response?.clone()),
      delete: vi.fn(async () => true),
      put: vi.fn(async (_path, value: Response) => {
        response = value
      }),
    }
    vi.stubGlobal('caches', { has: async () => true, open: async () => cache })
    const storage = new InstalledOfficialAppStorage({} as AppDatabase)
    expect(await storage.repairUnreadableFile('/assets/app.js', bytes)).toBe(true)
    expect(cache.delete).toHaveBeenCalledExactlyOnceWith('/assets/app.js')
    expect(cache.put).toHaveBeenCalledTimes(1)
    expect(await storage.hasFileHash('/assets/app.js', bytes.length, await hashBytes(bytes))).toBe(
      true,
    )
    expect(await storage.repairUnreadableFile('/assets/app.js', bytes)).toBe(false)
    expect(cache.delete).toHaveBeenCalledTimes(1)
    expect(cache.put).toHaveBeenCalledTimes(1)
  })

  it('does not rewrite absent cache entries or native files as a cache repair', async () => {
    const cache = { match: vi.fn(), delete: vi.fn(async () => false), put: vi.fn() }
    const open = vi.fn(async () => cache)
    vi.stubGlobal('caches', { has: async () => true, open })
    const storage = new InstalledOfficialAppStorage({} as AppDatabase)
    expect(await storage.repairUnreadableFile('/assets/app.js', new Uint8Array([1]))).toBe(false)
    expect(cache.put).not.toHaveBeenCalled()
    vi.stubGlobal('window', { Capacitor: { isNativePlatform: () => true } })
    open.mockClear()
    expect(await storage.repairUnreadableFile('/assets/app.js', new Uint8Array([1]))).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })
  it('reads only the target APP installation record', async () => {
    const get = vi.fn().mockResolvedValue({ value: { id: 'draw' } })
    const storage = new InstalledOfficialAppStorage({ settings: { get } } as unknown as AppDatabase)
    expect(await storage.get('draw')).toEqual({ id: 'draw' })
    expect(get).toHaveBeenCalledExactlyOnceWith('official-app:draw')
  })
  it('checks a 127-file APK package in batches within the native 100-file limit', async () => {
    vi.stubGlobal('window', { Capacitor: { isNativePlatform: () => true } })
    nativeFiles.hasOfficialAppFiles.mockImplementation(async ({ files }) => {
      if (files.length > 100) throw new Error('APP 文件清单无效')
      return { ready: true }
    })
    const storage = new InstalledOfficialAppStorage({} as AppDatabase)
    const files = Array.from({ length: 127 }, (_, index) => ({
      path: `/assets/app-${index}.js`,
      size: 1,
    }))
    expect(await storage.hasFiles(files)).toBe(true)
    expect(
      nativeFiles.hasOfficialAppFiles.mock.calls.map(([options]) => options.files.length),
    ).toEqual([100, 27])
    expect(filesystem.stat).not.toHaveBeenCalled()
    nativeFiles.hasOfficialAppFiles.mockClear()
    nativeFiles.hasOfficialAppFiles
      .mockResolvedValueOnce({ ready: true })
      .mockResolvedValueOnce({ ready: false })
    expect(await storage.hasFiles(files)).toBe(false)
    expect(nativeFiles.hasOfficialAppFiles).toHaveBeenCalledTimes(2)
  })

  it('reads one APP record by primary key without scanning settings', async () => {
    const get = vi.fn().mockResolvedValue({ value: { id: 'draw' } })
    const where = vi.fn()
    const storage = new InstalledOfficialAppStorage({
      settings: { get, where },
    } as unknown as AppDatabase)
    expect(await storage.get('draw')).toEqual({ id: 'draw' })
    expect(get).toHaveBeenCalledExactlyOnceWith('official-app:draw')
    expect(where).not.toHaveBeenCalled()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetAllMocks()
  })

  it('checks large cached content without reading a whole response into the page heap', async () => {
    const bytes = new Uint8Array(5 * 1024 * 1024).fill(17)
    const expectedHash = await hashBytes(bytes)
    const arrayBuffer = vi.fn()
    let body = await new Response(bytes).blob()
    vi.stubGlobal('caches', {
      has: async () => true,
      open: async () => ({
        match: async () => ({ blob: async () => body, arrayBuffer }),
      }),
    })
    const storage = new InstalledOfficialAppStorage({} as AppDatabase)
    expect(await storage.hasFileHash('/assets/compiler.wasm', bytes.length, expectedHash)).toBe(
      true,
    )
    body = await new Response(new Uint8Array(bytes.length).fill(18)).blob()
    expect(await storage.hasFileHash('/assets/compiler.wasm', bytes.length, expectedHash)).toBe(
      false,
    )
    expect(await storage.hasFileHash('/assets/compiler.wasm', bytes.length + 1, expectedHash)).toBe(
      false,
    )
    expect(arrayBuffer).not.toHaveBeenCalled()
  })

  it('reads native assets through the existing file URL without a whole base64 bridge message', async () => {
    vi.stubGlobal('window', { Capacitor: { isNativePlatform: () => true } })
    const bytes = new Uint8Array(5 * 1024 * 1024).fill(17)
    const expectedHash = await hashBytes(bytes)
    filesystem.stat.mockResolvedValue({ size: bytes.length })
    filesystem.getUri.mockResolvedValue({ uri: 'file:///data/files/official-apps/assets/app.js' })
    const fetchFile = vi.fn().mockImplementation(async () => new Response(bytes))
    vi.stubGlobal('fetch', fetchFile)
    const storage = new InstalledOfficialAppStorage({} as AppDatabase)
    expect(await storage.hasFileHash('/assets/app.js', bytes.length, expectedHash)).toBe(true)
    expect(filesystem.getUri).toHaveBeenCalledWith({
      path: 'official-apps/assets/app.js',
      directory: 'DATA',
    })
    expect(fetchFile).toHaveBeenCalledWith(
      'https://localhost/_capacitor_file_/data/files/official-apps/assets/app.js',
      { cache: 'no-store' },
    )
    expect(filesystem.readFile).not.toHaveBeenCalled()
    fetchFile.mockResolvedValueOnce(new Response(new Uint8Array(bytes.length)))
    expect(await storage.hasFileHash('/assets/app.js', bytes.length, expectedHash)).toBe(false)
    fetchFile.mockResolvedValueOnce(new Response(null, { status: 404 }))
    expect(await storage.hasFileHash('/assets/app.js', bytes.length, expectedHash)).toBe(false)
    filesystem.stat.mockResolvedValueOnce({ size: bytes.length - 1 })
    expect(await storage.hasFileHash('/assets/app.js', bytes.length, expectedHash)).toBe(false)
    expect(fetchFile).toHaveBeenCalledTimes(3)
    await expect(
      storage.hasFileHash('/assets/../private.js', bytes.length, expectedHash),
    ).rejects.toThrow('路径')
  })

  it('checks cached file hashes only when explicitly requested', async () => {
    const goodBytes = new TextEncoder().encode('export default 1')
    let storedBytes = goodBytes
    const cache = {
      match: vi.fn(
        async () =>
          new Response(new Uint8Array(storedBytes).buffer, {
            headers: { 'Content-Length': String(storedBytes.length) },
          }),
      ),
    }
    vi.stubGlobal('caches', {
      has: vi.fn(async () => true),
      open: vi.fn(async () => cache),
    })
    const storage = new InstalledOfficialAppStorage({} as AppDatabase)
    const expectedHash = await hashBytes(goodBytes)

    expect(await storage.hasFileHash('/assets/app.js', goodBytes.length, expectedHash)).toBe(true)
    storedBytes = new Uint8Array(goodBytes.length).fill(0)
    expect(await storage.hasFileHash('/assets/app.js', goodBytes.length, expectedHash)).toBe(false)
    expect(await storage.hasFile('/assets/app.js', goodBytes.length)).toBe(true)
  })

  it('does not evict shared Service Worker assets when deleting an APP-owned copy', async () => {
    const appCache = { delete: vi.fn(async () => true) }
    const runtimeCache = { delete: vi.fn(async () => true) }
    vi.stubGlobal('caches', {
      has: vi.fn(async () => true),
      open: vi.fn(async (name: string) =>
        name === 'srl-official-app-assets-v1' ? appCache : runtimeCache,
      ),
    })
    const storage = new InstalledOfficialAppStorage({} as AppDatabase)

    await storage.deleteFile('/assets/shared.js')

    expect(appCache.delete).toHaveBeenCalledWith('/assets/shared.js')
    expect(runtimeCache.delete).not.toHaveBeenCalled()
  })

  it('checks a batch with one cache handle, at most four reads, and observes cache replacement', async () => {
    let active = 0
    let peak = 0
    const cache = {
      match: vi.fn(async (): Promise<Response | undefined> => {
        peak = Math.max(peak, ++active)
        await Promise.resolve()
        active--
        return new Response(null, { headers: { 'Content-Length': '12' } })
      }),
    }
    const cacheStorage = { has: vi.fn(async () => true), open: vi.fn(async () => cache) }
    vi.stubGlobal('caches', cacheStorage)
    const storage = new InstalledOfficialAppStorage({} as AppDatabase)
    const files = Array.from({ length: 9 }, (_, index) => ({
      path: `/assets/${index}.js`,
      size: 12,
    }))
    expect(await storage.hasFiles(files)).toBe(true)
    expect(peak).toBe(4)
    expect(cache.match).toHaveBeenCalledTimes(9)
    expect(cacheStorage.has).toHaveBeenCalledTimes(1)
    expect(cacheStorage.open).toHaveBeenCalledTimes(1)

    cache.match.mockResolvedValueOnce(new Response(null, { headers: { 'Content-Length': '11' } }))
    expect(await storage.hasFiles(files)).toBe(false)
    cache.match.mockResolvedValueOnce(undefined)
    expect(await storage.hasFiles(files)).toBe(false)
    cacheStorage.has.mockResolvedValueOnce(false)
    expect(await storage.hasFiles(files)).toBe(false)
    expect(await storage.hasFiles(files)).toBe(true)
    expect(cacheStorage.open).toHaveBeenCalledTimes(4)
    await expect(storage.hasFiles([{ path: '/assets/../bad.js', size: 1 }])).rejects.toThrow('路径')
  })

  it('retains sequential native file checks without opening a browser cache', async () => {
    nativeFiles.hasOfficialAppFiles.mockRejectedValueOnce({ code: 'UNIMPLEMENTED' })
    vi.stubGlobal('window', { Capacitor: { isNativePlatform: () => true } })
    const storage = new InstalledOfficialAppStorage({} as AppDatabase)
    const check = vi
      .spyOn(storage, 'hasFile')
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    const files = [
      { path: '/assets/a.js', size: 12 },
      { path: '/assets/b.js', size: 12 },
    ]
    expect(await storage.hasFiles(files)).toBe(false)
    expect(check.mock.calls).toEqual(files.map((file) => [file.path, file.size]))
  })

  it('checks 255 official files in native batches of at most 100 and stops on a missing batch', async () => {
    vi.stubGlobal('window', { Capacitor: { isNativePlatform: () => true } })
    const storage = new InstalledOfficialAppStorage({} as AppDatabase)
    const files = Array.from({ length: 255 }, (_, index) => ({
      path: `/assets/file-${index}.js`,
      size: 1,
    }))
    nativeFiles.hasOfficialAppFiles.mockImplementation(async ({ files }) => {
      if (files.length > 100) throw new Error('APP 文件清单无效')
      return { ready: true }
    })
    expect(await storage.hasFiles(files)).toBe(true)
    expect(nativeFiles.hasOfficialAppFiles.mock.calls.map(([call]) => call.files.length)).toEqual([
      100, 100, 55,
    ])
    nativeFiles.hasOfficialAppFiles.mockClear()
    nativeFiles.hasOfficialAppFiles
      .mockResolvedValueOnce({ ready: true })
      .mockResolvedValueOnce({ ready: false })
    expect(await storage.hasFiles(files)).toBe(false)
    expect(nativeFiles.hasOfficialAppFiles).toHaveBeenCalledTimes(2)
  })

  it('checks native APP metadata in one bridge call and preserves missing/invalid-file failures', async () => {
    vi.stubGlobal('window', { Capacitor: { isNativePlatform: () => true } })
    const storage = new InstalledOfficialAppStorage({} as AppDatabase)
    const files = Array.from({ length: 100 }, (_, index) => ({
      path: `/assets/${index}.js`,
      size: 12,
    }))
    nativeFiles.hasOfficialAppFiles.mockResolvedValueOnce({ ready: true })
    expect(await storage.hasFiles(files)).toBe(true)
    expect(nativeFiles.hasOfficialAppFiles).toHaveBeenCalledExactlyOnceWith({ files })
    expect(filesystem.stat).not.toHaveBeenCalled()
    nativeFiles.hasOfficialAppFiles.mockResolvedValueOnce({ ready: false })
    expect(await storage.hasFiles(files)).toBe(false)
    nativeFiles.hasOfficialAppFiles.mockRejectedValueOnce(new Error('permission denied'))
    expect(await storage.hasFiles(files)).toBe(false)
    expect(filesystem.stat).not.toHaveBeenCalled()
    await expect(storage.hasFiles([{ path: '/assets/../private.js', size: 12 }])).rejects.toThrow(
      '路径',
    )
  })
})
