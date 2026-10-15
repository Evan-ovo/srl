import {
  RESOURCE_TYPE,
  RESOURCE_TYPE_LABELS,
  type ResourceReference,
  type ResourceType,
} from '../types/Resource'
import { Capacitor } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import { transferNativeStream } from '../core/NativeStreamTransfer'
import { taskCenter } from '../core/TaskCenter'

export type ThemeValue = 'light' | 'dark'

const THEME_STORAGE_KEY = 'srl-theme'
const NATIVE_EXPORT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function formatBackupDate(value?: number): string {
  return value ? new Date(value).toLocaleString('zh-CN') : '尚未完整备份'
}

export function summarizeResourceTypes(items: ResourceReference[]): string {
  const counts = new Map<ResourceType, number>()
  for (const resource of items) counts.set(resource.type, (counts.get(resource.type) ?? 0) + 1)

  return Object.values(RESOURCE_TYPE)
    .map((type) => {
      const count = counts.get(type)
      return count ? `${RESOURCE_TYPE_LABELS[type]} ${count}` : ''
    })
    .filter(Boolean)
    .join('、')
}

export function summarizeFileNames(fileNames: string[], limit = 3): string {
  const visibleNames = fileNames.slice(0, limit)
  const remainingCount = fileNames.length - visibleNames.length
  return `${visibleNames.join('、')}${remainingCount ? `，另有 ${remainingCount} 项` : ''}`
}

function browserDownloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function cleanStaleNativeExports(): Promise<void> {
  const cutoff = Date.now() - NATIVE_EXPORT_RETENTION_MS
  const listing = await Filesystem.readdir({ path: 'exports', directory: Directory.Cache }).catch(
    () => null,
  )
  if (!listing) return
  await Promise.all(
    listing.files.map(async (file) => {
      const modifiedAt = file.mtime ?? file.ctime ?? Date.now()
      if (modifiedAt >= cutoff) return
      if (file.type === 'file') {
        await Filesystem.deleteFile({
          path: `exports/${file.name}`,
          directory: Directory.Cache,
        }).catch(() => undefined)
      } else if (file.type === 'directory' && /^\d{13}-[0-9a-f-]{36}$/u.test(file.name)) {
        await Filesystem.rmdir({
          path: `exports/${file.name}`,
          directory: Directory.Cache,
          recursive: true,
        }).catch(() => undefined)
      }
    }),
  )
}

async function shareNativeBlob(blob: Blob, fileName: string): Promise<void> {
  const controller = new AbortController()
  const operationId = taskCenter.start({
    name: `导出 ${fileName}`,
    phase: '准备分享文件',
    cancelable: true,
    cancel: () => controller.abort(new DOMException('导出已取消', 'AbortError')),
  })
  const sanitizedName = fileName.replace(/[\\/:*?"<>|]/g, '_')
  const safeName = !sanitizedName || /^\.+$/u.test(sanitizedName) ? 'srl-export' : sanitizedName
  const exportDirectory = `exports/${Date.now()}-${crypto.randomUUID()}`
  const path = `${exportDirectory}/${safeName}`
  let written = false
  let handedOff = false
  const throwIfAborted = (): void => {
    if (controller.signal.aborted) throw controller.signal.reason
  }
  try {
    await cleanStaleNativeExports()
    throwIfAborted()
    taskCenter.update(operationId, { phase: '写入分享缓存' })
    taskCenter.updateTransfer(operationId, { transferredBytes: 0, totalBytes: blob.size })
    const append = async (data: string): Promise<void> => {
      if (!written) {
        // 即使原生 write 报错，也清理本次唯一的可能残片路径。
        written = true
        await Filesystem.writeFile({ path, data, directory: Directory.Cache, recursive: true })
      } else {
        await Filesystem.appendFile({ path, data, directory: Directory.Cache })
      }
    }
    if (blob.size === 0) await append('')
    else {
      await transferNativeStream(blob, {
        append,
        signal: controller.signal,
        onProgress: (progress) => taskCenter.updateTransfer(operationId, progress),
      })
    }
    throwIfAborted()
    const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache })
    throwIfAborted()
    // 系统分享面板由系统管理，不能展示一个实际上无法关闭它的取消按钮。
    taskCenter.update(operationId, { phase: '等待系统分享', cancelable: false })
    handedOff = true
    await Share.share({ title: fileName, dialogTitle: '导出 SRL 文件', url: uri })
    taskCenter.complete(operationId)
  } catch (error) {
    // 系统已接收 URI 后可能继续读取文件，不删除这份有效交付副本。
    if (written && !handedOff) {
      await Filesystem.rmdir({
        path: exportDirectory,
        directory: Directory.Cache,
        recursive: true,
      }).catch(() => undefined)
    }
    if (controller.signal.aborted) taskCenter.cancelled(operationId)
    else taskCenter.fail(operationId, error)
    throw error
  }
}

export async function downloadBlob(blob: Blob, fileName: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    browserDownloadBlob(blob, fileName)
    return
  }
  // 原生取消或失败必须原样传给调用方，不能悄悄启动另一份下载并报告成功。
  await shareNativeBlob(blob, fileName)
}

export function readStoredTheme(): ThemeValue {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    // 部分隐私模式会禁用 localStorage，读取失败时回到浅色主题。
    return 'light'
  }
}

export function writeStoredTheme(value: ThemeValue): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, value)
  } catch {
    // 部分隐私模式会禁用 localStorage，主题仍可在当前会话生效。
  }
}
