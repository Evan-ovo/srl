import type { AppDatabase } from '../database/AppDatabase'
import {
  OFFICIAL_APP_ASSET_CACHE,
  type InstalledOfficialApp,
  type OfficialAppFile,
  type OfficialAppId,
} from '../types/OfficialApp'
import type { OfficialAppPackageStorage } from './OfficialAppPackageStorage'
import { isCapacitorApp } from '../utils/CapacitorDetection'
import { hashBlob } from '../services/HashService'
import { Capacitor, registerPlugin } from '@capacitor/core'

const nativeFiles = registerPlugin<{
  hasOfficialAppFiles(options: {
    files: Array<Pick<OfficialAppFile, 'path' | 'size'>>
  }): Promise<{ ready: boolean }>
}>('NativeLibrary')

const PREFIX = 'official-app:'
function requirePath(path: string): string {
  if (!/^\/assets\/[A-Za-z0-9_.-]+$/u.test(path) || path.includes('..'))
    throw new Error('APP 文件路径无效')
  return 'official-apps' + path
}
function mimeType(path: string): string {
  if (path.endsWith('.js')) return 'text/javascript'
  if (path.endsWith('.css')) return 'text/css'
  if (path.endsWith('.wasm')) return 'application/wasm'
  if (path.endsWith('.woff2')) return 'font/woff2'
  return 'application/octet-stream'
}
export class InstalledOfficialAppStorage implements OfficialAppPackageStorage {
  private readonly database: AppDatabase
  constructor(database: AppDatabase) {
    this.database = database
  }
  async list(): Promise<InstalledOfficialApp[]> {
    return (await this.database.settings.where('id').startsWith(PREFIX).toArray()).map(
      (row) => row.value as InstalledOfficialApp,
    )
  }
  async save(app: InstalledOfficialApp): Promise<void> {
    await this.database.settings.put({ id: PREFIX + app.id, value: app, updatedAt: Date.now() })
  }
  async get(id: OfficialAppId): Promise<InstalledOfficialApp | undefined> {
    const row = await this.database.settings.get(PREFIX + id)
    return row?.value as InstalledOfficialApp | undefined
  }
  async remove(id: OfficialAppId): Promise<void> {
    await this.database.settings.delete(PREFIX + id)
  }
  async writeFile(path: string, bytes: Uint8Array): Promise<void> {
    const nativePath = requirePath(path)
    if (isCapacitorApp()) {
      const { Filesystem, Directory } = await import('@capacitor/filesystem')
      // The native bridge takes base64. Limit each bridge message instead of expanding a whole package.
      const chunkSize = 192 * 1024
      for (let offset = 0; offset < bytes.length || offset === 0; offset += chunkSize) {
        const chunk = bytes.subarray(offset, offset + chunkSize)
        let binary = ''
        for (const value of chunk) binary += String.fromCharCode(value)
        const options = {
          path: nativePath + '.part',
          directory: Directory.Data,
          data: btoa(binary),
        }
        if (offset === 0) await Filesystem.writeFile({ ...options, recursive: true })
        else await Filesystem.appendFile(options)
      }
      await Filesystem.rename({
        from: nativePath + '.part',
        to: nativePath,
        directory: Directory.Data,
      })
      return
    }
    await (
      await caches.open(OFFICIAL_APP_ASSET_CACHE)
    ).put(
      path,
      new Response(new Uint8Array(bytes).buffer, {
        headers: { 'Content-Type': mimeType(path), 'Content-Length': String(bytes.length) },
      }),
    )
  }
  async hasFile(path: string, size: number, bundled = false): Promise<boolean> {
    const nativePath = requirePath(path)
    if (isCapacitorApp()) {
      const { Filesystem, Directory } = await import('@capacitor/filesystem')
      try {
        return (
          (await Filesystem.stat({ path: nativePath, directory: Directory.Data })).size === size
        )
      } catch {
        return false
      }
    }
    const cacheNames = bundled
      ? [OFFICIAL_APP_ASSET_CACHE, 'srl-feature-assets']
      : [OFFICIAL_APP_ASSET_CACHE]
    for (const name of cacheNames) {
      if (!(await caches.has(name))) continue
      const response = await (await caches.open(name)).match(path)
      if (response && Number(response.headers.get('Content-Length')) === size) return true
    }
    return false
  }
  async repairUnreadableFile(path: string, bytes: Uint8Array): Promise<boolean> {
    requirePath(path)
    if (isCapacitorApp() || !(await caches.has(OFFICIAL_APP_ASSET_CACHE))) return false
    const cache = await caches.open(OFFICIAL_APP_ASSET_CACHE)
    // Some CacheStorage backends retain an index entry whose body is unreadable
    // after reload; put() cannot replace it. Only repair that observed failure.
    if ((await cache.match(path)) || !(await cache.delete(path))) return false
    await this.writeFile(path, bytes)
    return true
  }
  async hasFiles(files: readonly Pick<OfficialAppFile, 'path' | 'size'>[]): Promise<boolean> {
    for (const file of files) requirePath(file.path)
    if (!files.length) return true
    if (isCapacitorApp()) {
      try {
        // The installed APK bridge accepts at most 100 paths per request.
        for (let offset = 0; offset < files.length; offset += 100) {
          const result = await nativeFiles.hasOfficialAppFiles({
            files: files.slice(offset, offset + 100).map(({ path, size }) => ({ path, size })),
          })
          if (result.ready !== true) return false
        }
        return true
      } catch (error) {
        if ((error as { code?: string }).code !== 'UNIMPLEMENTED') return false
      }
      // Older APKs retain the existing check; other native errors are not bypassed.
      for (const file of files) if (!(await this.hasFile(file.path, file.size))) return false
      return true
    }
    if (!(await caches.has(OFFICIAL_APP_ASSET_CACHE))) return false
    // Scope this handle to one readiness check: deletion/recreation must be seen next time.
    const cache = await caches.open(OFFICIAL_APP_ASSET_CACHE)
    for (let offset = 0; offset < files.length; offset += 4) {
      const present = await Promise.all(
        files.slice(offset, offset + 4).map(async (file) => {
          const response = await cache.match(file.path)
          return Boolean(response && Number(response.headers.get('Content-Length')) === file.size)
        }),
      )
      if (present.some((value) => !value)) return false
    }
    return true
  }
  async hasFileHash(
    path: string,
    size: number,
    expectedHash: string,
    bundled = false,
  ): Promise<boolean> {
    const nativePath = requirePath(path)
    try {
      let blob: Blob
      if (isCapacitorApp()) {
        const { Filesystem, Directory } = await import('@capacitor/filesystem')
        const options = { path: nativePath, directory: Directory.Data }
        if ((await Filesystem.stat(options)).size !== size) return false
        const { uri } = await Filesystem.getUri(options)
        // The native file server reads the validated asset path without sending
        // the whole file as base64 through the JS bridge. Large hashes use the existing Worker.
        const response = await fetch(Capacitor.convertFileSrc(uri), { cache: 'no-store' })
        if (!response.ok) return false
        blob = await response.blob()
      } else {
        const cacheNames = bundled
          ? [OFFICIAL_APP_ASSET_CACHE, 'srl-feature-assets']
          : [OFFICIAL_APP_ASSET_CACHE]
        let response: Response | undefined
        for (const name of cacheNames) {
          if (!(await caches.has(name))) continue
          response = await (await caches.open(name)).match(path)
          if (response) break
        }
        if (!response) return false
        blob = await response.blob()
      }
      return blob.size === size && (await hashBlob(blob)) === expectedHash
    } catch {
      return false
    }
  }
  async deleteFile(path: string, bundled = false): Promise<void> {
    const nativePath = requirePath(path)
    if (isCapacitorApp()) {
      if (bundled) return
      const { Filesystem, Directory } = await import('@capacitor/filesystem')
      for (const target of [nativePath, nativePath + '.part']) {
        let exists = false
        try {
          await Filesystem.stat({ path: target, directory: Directory.Data })
          exists = true
        } catch {
          /* absent */
        }
        if (exists) await Filesystem.deleteFile({ path: target, directory: Directory.Data })
      }
    } else {
      // APP uninstall/update must not evict shared shell chunks from the Service
      // Worker's general runtime cache. Only remove assets owned by this cache.
      if (await caches.has(OFFICIAL_APP_ASSET_CACHE))
        await (await caches.open(OFFICIAL_APP_ASSET_CACHE)).delete(path)
    }
  }
}
