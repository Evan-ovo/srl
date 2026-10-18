import { Capacitor, registerPlugin } from '@capacitor/core'
import type { ArchiveStreamWriter } from '../services/ExportService'
import { transferNativeStream } from './NativeStreamTransfer'

export interface NativeSafBackupStatus {
  warning?: string
  configured: boolean
  available: boolean
  name?: string
  uri?: string
  availableBytes?: number
  lastBackupAt: number
}

interface NativeSafBackupPlugin {
  chooseDirectory(): Promise<NativeSafBackupStatus>
  getStatus(): Promise<NativeSafBackupStatus>
  clearDirectory(): Promise<NativeSafBackupStatus>
  beginWrite(options: { fileName: string }): Promise<{ token: string }>
  appendWrite(options: { token: string; data: string }): Promise<void>
  commitWrite(options: { token: string }): Promise<{ uri: string; bytes: number }>
  abortWrite(options: { token: string }): Promise<void>
}

const plugin = registerPlugin<NativeSafBackupPlugin>('NativeSafBackup')

export function isNativeSafBackupAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
}

export async function getNativeSafBackupStatus(): Promise<NativeSafBackupStatus | null> {
  if (!isNativeSafBackupAvailable()) return null
  return plugin.getStatus()
}

export async function chooseNativeSafBackupDirectory(): Promise<NativeSafBackupStatus | null> {
  if (!isNativeSafBackupAvailable()) return null
  return plugin.chooseDirectory()
}

export async function clearNativeSafBackupDirectory(): Promise<NativeSafBackupStatus | null> {
  if (!isNativeSafBackupAvailable()) return null
  return plugin.clearDirectory()
}

/** ZIP 编码器直接写入 SAF OutputStream；不会先在 JS 中合成完整备份 Blob。 */
export async function openNativeSafBackupWriter(
  fileName: string,
): Promise<ArchiveStreamWriter | null> {
  if (!isNativeSafBackupAvailable()) return null
  const status = await plugin.getStatus()
  if (!status.available) return null
  const { token } = await plugin.beginWrite({ fileName })
  const stream = new TransformStream<Uint8Array>()
  const writer = stream.writable.getWriter()
  // Keep one bounded transfer open across ZIP entries so headers and small
  // compressed chunks share 512 KiB native writes instead of one bridge call each.
  const transfer = transferNativeStream(stream.readable, {
    append: (data) => plugin.appendWrite({ token, data }),
  })
  void transfer.catch(() => undefined)
  return {
    write: (chunk) => writer.write(chunk),
    commit: async () => {
      await writer.close()
      await transfer
      await plugin.commitWrite({ token })
    },
    abort: async () => {
      await writer.abort().catch(() => undefined)
      await transfer.catch(() => undefined)
      await plugin.abortWrite({ token })
    },
  }
}

/** 只在用户已选择且授权仍有效的 SAF 文件夹中写入。失败由调用方回退至常规分享。 */
export async function saveBlobToNativeSafBackup(blob: Blob, fileName: string): Promise<boolean> {
  if (!isNativeSafBackupAvailable()) return false
  const status = await plugin.getStatus()
  if (!status.available) return false
  const { token } = await plugin.beginWrite({ fileName })
  try {
    await transferNativeStream(blob, {
      append: (data) => plugin.appendWrite({ token, data }),
    })
    await plugin.commitWrite({ token })
    return true
  } catch (error) {
    await plugin.abortWrite({ token }).catch(() => undefined)
    throw error
  }
}
