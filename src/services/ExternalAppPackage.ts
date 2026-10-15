import {
  boundedUnzipPackage,
  requireSafePath,
  MAX_PACKAGE_BYTES,
  MAX_EXTRACTED_BYTES,
  MAX_EXTRACTED_FILES,
  MAX_SINGLE_FILE_BYTES,
  type PackageFileLimit,
} from './ExternalAppUnzip'
export {
  requireSafePath,
  MAX_PACKAGE_BYTES,
  MAX_EXTRACTED_BYTES,
  MAX_EXTRACTED_FILES,
  MAX_SINGLE_FILE_BYTES,
} from './ExternalAppUnzip'
import {
  EXTERNAL_APP_PERMISSION,
  EXTERNAL_APP_SCHEMA_VERSION,
  EXTERNAL_APP_SDK_VERSION,
  getExternalAppPermissionLevel,
  type ExternalAppPreview,
  type ExternalAppManifest,
  type ExternalAppPermission,
  type ExternalAppOrientation,
} from '../types/ExternalApp'
import { normalizeExternalAppTools } from './ExternalAppTools'
export const TEXT_ENCODER = new TextEncoder()

export const APP_ID_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{1,118}[a-z0-9])?$/

export const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

export const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true })

export const SUPPORTED_PERMISSIONS = new Set<ExternalAppPermission>(
  Object.values(EXTERNAL_APP_PERMISSION),
)

export const SPLASH_COLOR_PATTERN = /^#[0-9a-f]{6}$/i

export interface PackageFiles {
  files: Record<string, Uint8Array>
  manifest: ExternalAppManifest
  fingerprint?: string
  sourceKind: ExternalAppPreview['sourceKind']
}

export interface UnzipWorkerResponse {
  id: string
  files?: Record<string, Uint8Array>
  error?: string
}

export let unzipWorker: Worker | undefined

export const unzipRequests = new Map<
  string,
  {
    resolve: (files: Record<string, Uint8Array>) => void
    reject: (error: Error) => void
  }
>()

export function getUnzipWorker(): Worker | undefined {
  if (unzipWorker) return unzipWorker
  if (typeof Worker === 'undefined') return undefined
  try {
    unzipWorker = new Worker(new URL('../workers/ExternalAppUnzipWorker.ts', import.meta.url), {
      type: 'module',
    })
    unzipWorker.addEventListener('message', (event: MessageEvent<UnzipWorkerResponse>) => {
      const request = unzipRequests.get(event.data.id)
      if (!request) return
      unzipRequests.delete(event.data.id)
      if (event.data.files) request.resolve(event.data.files)
      else request.reject(new Error(event.data.error || '无法读取压缩包'))
    })
    const worker = unzipWorker
    worker.addEventListener('error', () => {
      for (const request of unzipRequests.values())
        request.reject(new Error('安装包解压 Worker 已停止'))
      unzipRequests.clear()
      worker.terminate()
      if (unzipWorker === worker) unzipWorker = undefined
    })
    return unzipWorker
  } catch {
    return undefined
  }
}

export async function unzipPackage(
  bytes: ArrayBuffer,
  maxFiles: PackageFileLimit = MAX_EXTRACTED_FILES,
): Promise<Record<string, Uint8Array>> {
  const worker = getUnzipWorker()
  if (!worker) return boundedUnzipPackage(bytes, maxFiles)
  const id = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    unzipRequests.set(id, { resolve, reject })
    worker.postMessage({ id, bytes, maxFiles }, [bytes])
  })
}

export function requireDeclaredFiles(
  files: Record<string, Uint8Array>,
  manifest: ExternalAppManifest,
): void {
  if (!files[manifest.entry]) throw new Error('安装包缺少清单指定的入口文件')
  if (manifest.icon && !files[manifest.icon]) throw new Error('安装包缺少清单指定的图标文件')
}

export type ExternalAppInstallInput = File | readonly File[] | ExternalAppPreview

export function readText(bytes: Uint8Array, label: string): string {
  try {
    return TEXT_DECODER.decode(bytes)
  } catch {
    throw new Error(`${label}不是有效的 UTF-8 文本`)
  }
}

export function normalizeManifest(value: unknown): ExternalAppManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('manifest.json 格式无效')
  const candidate = value as Partial<ExternalAppManifest>
  const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
  const name = typeof candidate.name === 'string' ? candidate.name.trim() : ''
  const version = typeof candidate.version === 'string' ? candidate.version.trim() : ''
  const entry = typeof candidate.entry === 'string' ? candidate.entry.trim() : ''
  if (candidate.schemaVersion !== 1 && candidate.schemaVersion !== EXTERNAL_APP_SCHEMA_VERSION) {
    throw new Error(`暂不支持 APP 清单版本 ${String(candidate.schemaVersion)}`)
  }
  if (
    candidate.schemaVersion === EXTERNAL_APP_SCHEMA_VERSION &&
    candidate.apiVersion !== EXTERNAL_APP_SDK_VERSION
  ) {
    throw new Error(`APP 必须声明 API 版本 ${EXTERNAL_APP_SDK_VERSION}`)
  }
  if (!APP_ID_PATTERN.test(id)) throw new Error('APP ID 只能使用小写字母、数字、点和连字符')
  if (!name || name.length > 80) throw new Error('APP 名称必须为 1 到 80 个字符')
  if (!VERSION_PATTERN.test(version)) throw new Error('APP 版本必须使用 x.y.z 格式')
  const safeEntry = requireSafePath(entry, '入口文件')
  if (!/\.html?$/i.test(safeEntry)) throw new Error('入口文件必须是 HTML')
  const author =
    typeof candidate.author === 'string' ? candidate.author.trim().slice(0, 80) : undefined
  const description =
    typeof candidate.description === 'string'
      ? candidate.description.trim().slice(0, 500)
      : undefined
  const icon =
    typeof candidate.icon === 'string' ? requireSafePath(candidate.icon, '图标文件') : undefined
  if (icon && !/\.(?:png|jpe?g|webp|gif|svg)$/i.test(icon)) {
    throw new Error('图标文件必须是常见图片格式')
  }
  const splashColor =
    typeof candidate.splashColor === 'string' ? candidate.splashColor.trim() : undefined
  if (splashColor && !SPLASH_COLOR_PATTERN.test(splashColor)) {
    throw new Error('启动页颜色必须使用 #RRGGBB 格式')
  }
  const orientation = candidate.orientation
  if (
    orientation !== undefined &&
    orientation !== 'auto' &&
    orientation !== 'portrait' &&
    orientation !== 'landscape'
  ) {
    throw new Error('屏幕方向只能是 auto、portrait 或 landscape')
  }
  if (candidate.immersive !== undefined && typeof candidate.immersive !== 'boolean') {
    throw new Error('默认沉浸式必须是 true 或 false')
  }
  if (candidate.permissions !== undefined && !Array.isArray(candidate.permissions)) {
    throw new Error('APP 权限必须是数组')
  }
  const permissions = Array.from(
    new Set(
      (candidate.permissions ?? []).filter(
        (item): item is ExternalAppPermission => typeof item === 'string',
      ),
    ),
  )
  if (permissions.some((permission) => !SUPPORTED_PERMISSIONS.has(permission)))
    throw new Error('APP 声明了暂不支持的权限')
  if (
    candidate.schemaVersion === 1 &&
    permissions.some((permission) => permission !== EXTERNAL_APP_PERMISSION.STORAGE)
  )
    throw new Error('清单版本 1 仅支持 APP 自己的本地存储权限')
  const permissionLevel = getExternalAppPermissionLevel(permissions)
  const tools = normalizeExternalAppTools(candidate.tools, permissions)
  if (tools.length && candidate.schemaVersion !== EXTERNAL_APP_SCHEMA_VERSION)
    throw new Error('自定义工具需要 APP 清单版本 2')
  if (candidate.permissionLevel !== undefined && candidate.permissionLevel !== permissionLevel) {
    throw new Error('APP 声明的权限等级与实际权限不一致')
  }
  return {
    schemaVersion: candidate.schemaVersion,
    ...(candidate.schemaVersion === EXTERNAL_APP_SCHEMA_VERSION
      ? { apiVersion: EXTERNAL_APP_SDK_VERSION, permissionLevel }
      : {}),
    id,
    name,
    version,
    entry: safeEntry,
    ...(tools.length ? { tools } : {}),
    ...(author ? { author } : {}),
    ...(description ? { description } : {}),
    ...(icon ? { icon } : {}),
    ...(splashColor ? { splashColor } : {}),
    ...(orientation ? { orientation: orientation as ExternalAppOrientation } : {}),
    ...(candidate.immersive === true ? { immersive: true } : {}),
    ...(permissions.length ? { permissions } : {}),
  }
}

export async function unpackPackage(bytes: ArrayBuffer): Promise<PackageFiles> {
  let files: Record<string, Uint8Array>
  try {
    files = await unzipPackage(bytes)
  } catch (error) {
    if (error instanceof Error && /安装包|不安全路径/.test(error.message)) throw error
    throw new Error('无法读取 .srlapp 安装包', { cause: error })
  }
  const manifestBytes = files['manifest.json']
  if (!manifestBytes) throw new Error('安装包缺少 manifest.json')
  let manifest: ExternalAppManifest
  try {
    manifest = normalizeManifest(JSON.parse(readText(manifestBytes, 'manifest.json')))
  } catch (error) {
    if (error instanceof Error) throw error
    throw new Error('manifest.json 格式无效', { cause: error })
  }
  requireDeclaredFiles(files, manifest)
  return { files, manifest, sourceKind: 'srlapp' }
}

export async function fingerprintFiles(files: Record<string, Uint8Array>): Promise<string> {
  let hash = 2166136261
  for (const path of Object.keys(files).sort()) {
    for (const character of `${path}\u0000`) {
      hash ^= character.charCodeAt(0)
      hash = Math.imul(hash, 16777619)
    }
    const bytes = files[path]!
    for (let offset = 0; offset < bytes.length; offset += 256 * 1024) {
      const end = Math.min(bytes.length, offset + 256 * 1024)
      for (let index = offset; index < end; index++) {
        hash ^= bytes[index]!
        hash = Math.imul(hash, 16777619)
      }
      if (end < bytes.length) await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
  }
  return `app-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

export function quickManifest(
  files: Record<string, Uint8Array>,
  sourceName: string,
  fingerprint: string,
): ExternalAppManifest {
  const htmlPaths = Object.keys(files).filter((path) => /\.html?$/i.test(path))
  const entry = htmlPaths.find((path) => /(^|\/)index\.html$/i.test(path)) ?? htmlPaths[0]
  if (!entry)
    throw new Error('未找到 HTML 入口文件；请选择 HTML 文件或包含 index.html 的文件夹/ZIP')
  const baseName = sourceName.replace(/\.[^.]+$/, '').trim() || 'local-app'
  const slug =
    baseName
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'local-app'
  return {
    schemaVersion: EXTERNAL_APP_SCHEMA_VERSION,
    apiVersion: EXTERNAL_APP_SDK_VERSION,
    id: `local.${slug}-${fingerprint.slice(-8)}`,
    name: baseName.slice(0, 80),
    version: '0.0.0-local',
    entry,
    description: '由本机 HTML 或静态网页快速导入。',
    orientation: 'auto',
    immersive: false,
    permissions: [],
  }
}

export function validateFileMap(files: Record<string, Uint8Array>): void {
  const paths = Object.keys(files)
  if (!paths.length) throw new Error('导入内容为空')
  if (paths.length > MAX_EXTRACTED_FILES) throw new Error('导入文件数量超过限制')
  let total = 0
  for (const [path, contents] of Object.entries(files)) {
    requireSafePath(path, '导入文件')
    if (contents.byteLength > MAX_SINGLE_FILE_BYTES) throw new Error('导入内容包含过大的文件')
    total += contents.byteLength
    if (total > MAX_EXTRACTED_BYTES) throw new Error('导入内容总大小超过限制')
  }
}

export async function filesFromInput(input: File | readonly File[]): Promise<PackageFiles> {
  const selected = input instanceof File ? [input] : [...input]
  if (!selected.length) throw new Error('请选择 HTML、ZIP、文件夹或 .srlapp 安装包')
  if (selected.length === 1) {
    const [file] = selected
    if (!file.size) throw new Error('导入文件为空')
    if (file.size > MAX_PACKAGE_BYTES) throw new Error('导入文件超过 50 MiB 限制')
    const lowerName = file.name.toLowerCase()
    if (lowerName.endsWith('.srlapp')) return unpackPackage(await file.arrayBuffer())
    if (lowerName.endsWith('.zip')) {
      let files: Record<string, Uint8Array>
      try {
        files = await unzipPackage(await file.arrayBuffer())
      } catch (error) {
        throw new Error('无法读取 ZIP 静态网页包', { cause: error })
      }
      validateFileMap(files)
      const fingerprint = await fingerprintFiles(files)
      const manifest = files['manifest.json']
        ? normalizeManifest(JSON.parse(readText(files['manifest.json'], 'manifest.json')))
        : quickManifest(files, file.name, fingerprint)
      requireDeclaredFiles(files, manifest)
      return { files, manifest, fingerprint, sourceKind: 'zip' }
    }
  }
  if (selected.length > MAX_EXTRACTED_FILES) throw new Error('导入文件数量超过限制')
  let total = 0
  for (const file of selected) {
    if (file.size > MAX_SINGLE_FILE_BYTES) throw new Error('导入内容包含过大的文件')
    total += file.size
    if (total > MAX_EXTRACTED_BYTES) throw new Error('导入内容总大小超过限制')
  }
  const relativePaths = selected.map((file) => file.webkitRelativePath || file.name)
  const firstSegments = relativePaths.map((path) => path.replaceAll('\\', '/').split('/')[0])
  const stripRoot =
    selected.some((file) => file.webkitRelativePath?.includes('/')) &&
    firstSegments.every((segment) => segment === firstSegments[0])
  const files: Record<string, Uint8Array> = {}
  for (let index = 0; index < selected.length; index += 1) {
    const file = selected[index]
    const rawPath = relativePaths[index].replaceAll('\\', '/')
    const path = stripRoot ? rawPath.split('/').slice(1).join('/') : rawPath
    const safePath = requireSafePath(path, '导入文件')
    if (files[safePath]) throw new Error('导入内容包含重复文件')
    files[safePath] = new Uint8Array(await file.arrayBuffer())
  }
  validateFileMap(files)
  const fingerprint = await fingerprintFiles(files)
  const manifest = files['manifest.json']
    ? normalizeManifest(JSON.parse(readText(files['manifest.json'], 'manifest.json')))
    : quickManifest(
        files,
        stripRoot
          ? `${firstSegments[0]}.html`
          : (selected.find((file) => /\.html?$/i.test(file.name))?.name ?? selected[0].name),
        fingerprint,
      )
  requireDeclaredFiles(files, manifest)
  return {
    files,
    manifest,
    fingerprint,
    sourceKind: stripRoot || selected.length > 1 ? 'folder' : 'html',
  }
}
