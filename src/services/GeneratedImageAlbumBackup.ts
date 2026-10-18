import type { ArchivePortableData } from '../types/Backup'
import { parseGitHubBundleManifest } from './GitHubBackupBundle'
import { isRecord } from '../utils/UnknownValue'

export type AlbumBackup = NonNullable<ArchivePortableData['generatedImageAlbum']>

export function parseAlbumBackup(value: unknown): AlbumBackup {
  if (!Array.isArray(value)) throw new Error('生图相册备份格式无效')
  const ids = new Set<string>()
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      !isRecord(entry.item) ||
      typeof entry.item.id !== 'string' ||
      !entry.item.id ||
      ids.has(entry.item.id) ||
      typeof entry.item.name !== 'string' ||
      !['generated', 'imported'].includes(String(entry.item.source)) ||
      !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(
        String(entry.item.mimeType),
      ) ||
      !Number.isSafeInteger(entry.item.sizeBytes) ||
      Number(entry.item.sizeBytes) < 1 ||
      !Number.isFinite(entry.item.createdAt) ||
      !Number.isFinite(entry.item.updatedAt)
    )
      throw new Error('生图相册备份记录无效')
    const object = parseGitHubBundleManifest(entry.object)
    if (object.totalSize !== entry.item.sizeBytes) throw new Error('生图相册原图大小不一致')
    entry.object = object
    ids.add(entry.item.id)
  }
  return value as AlbumBackup
}

export function albumArchivePath(hash: string): string {
  if (!/^[a-f0-9]{64}$/iu.test(hash)) throw new Error('生图相册原图哈希无效')
  return `app-data/album/${hash.toLowerCase()}.bin`
}
