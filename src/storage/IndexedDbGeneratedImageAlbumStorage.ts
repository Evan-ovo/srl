import Dexie from 'dexie'

import type { AppDatabase } from '../database/AppDatabase'
import type { AppSetting } from '../types/Resource'
import type {
  GeneratedImageAlbumFile,
  GeneratedImageAlbumItem,
  GeneratedImageAlbumPage,
  GeneratedImageAlbumQuery,
} from '../types/GeneratedImageAlbum'
import type { GeneratedImageAlbumStorage } from './GeneratedImageAlbumStorage'
import { encodeAppDatabaseKey } from './AndroidAppDatabaseMigration'

const FILE_MIGRATION_SETTING_ID = 'migration.generatedImageFiles.blob.v17'
const FILE_MIGRATION_BATCH_SIZE = 10
const DEFAULT_PAGE_SIZE = 18
const MAX_PAGE_SIZE = 48

interface FileMigrationState {
  version: 17
  status: 'running' | 'complete'
  checkpoint?: string
  migrated: number
}

function base64ToBlob(value: string, mimeType: string): Blob {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type: mimeType })
}

function normalizeLegacyFile(file: GeneratedImageAlbumFile): GeneratedImageAlbumFile | undefined {
  const originalBlob =
    file.originalBlob instanceof Blob
      ? file.originalBlob
      : file.originalBytes instanceof ArrayBuffer
        ? new Blob([file.originalBytes], { type: file.originalMimeType || 'image/png' })
        : file.originalBase64
          ? base64ToBlob(file.originalBase64, file.originalMimeType || 'image/png')
          : undefined
  if (!originalBlob) return undefined
  const thumbnailBlob =
    file.thumbnailBlob instanceof Blob
      ? file.thumbnailBlob
      : file.thumbnailBytes instanceof ArrayBuffer
        ? new Blob([file.thumbnailBytes], { type: file.thumbnailMimeType || 'image/webp' })
        : file.thumbnailBase64
          ? base64ToBlob(file.thumbnailBase64, file.thumbnailMimeType || 'image/webp')
          : undefined
  return {
    id: file.id,
    originalBlob,
    originalMimeType: file.originalMimeType || originalBlob.type || 'image/png',
    thumbnailBlob,
    thumbnailMimeType: file.thumbnailMimeType || thumbnailBlob?.type,
    updatedAt: file.updatedAt,
  }
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function cloneItem(item: GeneratedImageAlbumItem): GeneratedImageAlbumItem {
  const cloned = structuredClone(item) as unknown as {
    provider?: string
    generationManifest?: { provider?: string }
  }
  if (cloned.provider === 'custom') cloned.provider = 'openai'
  if (cloned.generationManifest?.provider === 'custom')
    cloned.generationManifest.provider = 'openai'
  return cloned as GeneratedImageAlbumItem
}

function cloneFile(file: GeneratedImageAlbumFile): GeneratedImageAlbumFile {
  const { originalBlob, thumbnailBlob, ...metadata } = file
  return { ...structuredClone(metadata), originalBlob, thumbnailBlob }
}

export class IndexedDbGeneratedImageAlbumStorage implements GeneratedImageAlbumStorage {
  private readonly database: AppDatabase
  private migrationPromise?: Promise<void>

  constructor(database: AppDatabase) {
    this.database = database
  }

  private ensureMigrated(): Promise<void> {
    this.migrationPromise ??= this.migrateLegacyFiles()
    return this.migrationPromise
  }

  private async migrateLegacyFiles(): Promise<void> {
    const saved = await this.database.settings.get(FILE_MIGRATION_SETTING_ID)
    const previous = saved?.value as Partial<FileMigrationState> | undefined
    if (previous?.version === 17 && previous.status === 'complete') return
    let checkpoint = previous?.version === 17 ? previous.checkpoint : undefined
    let migrated = previous?.version === 17 ? (previous.migrated ?? 0) : 0

    while (true) {
      const query = checkpoint
        ? this.database.generatedImageFiles.where('id').above(checkpoint)
        : this.database.generatedImageFiles.orderBy('id')
      const files = await query.limit(FILE_MIGRATION_BATCH_SIZE).toArray()
      if (files.length === 0) {
        const complete: AppSetting = {
          id: FILE_MIGRATION_SETTING_ID,
          value: { version: 17, status: 'complete', migrated } satisfies FileMigrationState,
          updatedAt: Date.now(),
        }
        await this.database.settings.put(complete)
        return
      }

      const normalized = files
        .map(normalizeLegacyFile)
        .filter((file): file is GeneratedImageAlbumFile => file !== undefined)
      const nextCheckpoint = files.at(-1)!.id
      migrated += normalized.length
      await this.database.transaction(
        'rw',
        this.database.generatedImageFiles,
        this.database.settings,
        async () => {
          if (normalized.length) await this.database.generatedImageFiles.bulkPut(normalized)
          await this.database.settings.put({
            id: FILE_MIGRATION_SETTING_ID,
            value: {
              version: 17,
              status: 'running',
              checkpoint: nextCheckpoint,
              migrated,
            } satisfies FileMigrationState,
            updatedAt: Date.now(),
          })
        },
      )
      checkpoint = nextCheckpoint
      await yieldToBrowser()
    }
  }

  async list(): Promise<GeneratedImageAlbumItem[]> {
    await this.ensureMigrated()
    const items = await this.database.generatedImages.orderBy('createdAt').reverse().toArray()
    return items.map(cloneItem)
  }

  async count(): Promise<number> {
    await this.ensureMigrated()
    return this.database.generatedImages.count()
  }

  private async distinctStrings(indexName: 'category' | 'mimeType'): Promise<string[]> {
    const table = this.database.generatedImages
    return this.database.transaction('r', table, async (transaction) => {
      const cursor = await table.core.openCursor({
        trans: transaction.idbtrans,
        values: false,
        query: {
          index: table.core.schema.getIndexByKeyPath(indexName)!,
          range: { type: 2, lower: '', lowerOpen: true, upper: undefined },
        },
      })
      const keys: string[] = []
      await cursor?.start(() => {
        const key: unknown = cursor.key
        // IndexedDB orders all string keys before binary/array keys. Empty and
        // non-string legacy values never appeared in the facet list.
        if (typeof key !== 'string') {
          cursor.stop()
          return
        }
        if (keys.at(-1) === key) {
          cursor.continue()
          return
        }
        keys.push(key)
        // Ordinary `next`, not `nextunique`: seek past this duplicate run.
        // Appending the smallest UTF-16 unit retains keys such as "a\0".
        // The native DBCore adapter also implements this seek without values.
        const nextKey = `${key}\u0000`
        let canSeek = true
        try {
          encodeAppDatabaseKey(nextKey)
        } catch {
          // A valid native key can already fill its encoded-key budget. Keep
          // walking that run normally instead of issuing an oversized seek.
          canSeek = false
        }
        cursor.continue(canSeek ? nextKey : undefined)
      })
      return keys
    })
  }

  async query(query: GeneratedImageAlbumQuery): Promise<GeneratedImageAlbumPage> {
    await this.ensureMigrated()
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, Math.round(query.pageSize ?? DEFAULT_PAGE_SIZE)),
    )
    const needle = query.search?.trim().toLocaleLowerCase() ?? ''
    const albumTotal = await this.database.generatedImages.count()
    if (albumTotal === 0) {
      return {
        items: [],
        total: 0,
        page: 1,
        pageSize,
        pageCount: 1,
        categories: [],
        mimeTypes: [],
      }
    }
    const createCollection = () => {
      let collection = this.database.generatedImages.orderBy('createdAt')
      if (query.category && query.mimeType) {
        collection = this.database.generatedImages
          .where('[category+mimeType+createdAt]')
          .between(
            [query.category, query.mimeType, Dexie.minKey],
            [query.category, query.mimeType, Dexie.maxKey],
            true,
            true,
          )
      } else if (query.category) {
        collection = this.database.generatedImages
          .where('[category+createdAt]')
          .between([query.category, Dexie.minKey], [query.category, Dexie.maxKey], true, true)
      } else if (query.mimeType) {
        collection = this.database.generatedImages
          .where('[mimeType+createdAt]')
          .between([query.mimeType, Dexie.minKey], [query.mimeType, Dexie.maxKey], true, true)
      }
      const needsPredicate = Boolean(needle || (query.hostedStatus && query.hostedStatus !== 'all'))
      return needsPredicate
        ? collection.and((item) => {
            if (query.hostedStatus === 'hosted' && !item.hostedUrl) return false
            if (query.hostedStatus === 'local' && item.hostedUrl) return false
            if (!needle) return true
            return `${item.name} ${item.category} ${item.prompt ?? ''} ${item.hostedUrl ?? ''}`
              .toLocaleLowerCase()
              .includes(needle)
          })
        : collection
    }
    const filtered = Boolean(
      query.category ||
      query.mimeType ||
      needle ||
      (query.hostedStatus && query.hostedStatus !== 'all'),
    )
    const total = filtered ? await createCollection().count() : albumTotal
    const pageCount = Math.max(1, Math.ceil(total / pageSize))
    const page = Math.min(pageCount, Math.max(1, Math.round(query.page ?? 1)))
    const ordered = query.sort === 'oldest' ? createCollection() : createCollection().reverse()
    // iOS WebKit can reject simultaneous IndexedDB cursors with an opaque
    // "Unable to open cursor" UnknownError. Keep each cursor sequential and
    // avoid the less portable `nextunique` cursor direction used by uniqueKeys().
    const items = await ordered
      .offset((page - 1) * pageSize)
      .limit(pageSize)
      .toArray()
    const categories = await this.distinctStrings('category')
    const mimeTypes = await this.distinctStrings('mimeType')
    return {
      items: items.map(cloneItem),
      total,
      page,
      pageSize,
      pageCount,
      categories,
      mimeTypes,
    }
  }

  async get(id: string): Promise<GeneratedImageAlbumItem | undefined> {
    await this.ensureMigrated()
    const item = await this.database.generatedImages.get(id)
    return item ? cloneItem(item) : undefined
  }

  async getFile(id: string): Promise<GeneratedImageAlbumFile | undefined> {
    await this.ensureMigrated()
    const file = await this.database.generatedImageFiles.get(id)
    return file ? cloneFile(file) : undefined
  }

  async put(item: GeneratedImageAlbumItem, file: GeneratedImageAlbumFile): Promise<void> {
    await this.ensureMigrated()
    await this.database.transaction(
      'rw',
      this.database.generatedImages,
      this.database.generatedImageFiles,
      async () => {
        await this.database.generatedImages.put(cloneItem(item))
        await this.database.generatedImageFiles.put(cloneFile(file))
      },
    )
  }

  async update(item: GeneratedImageAlbumItem): Promise<void> {
    await this.ensureMigrated()
    await this.database.generatedImages.put(cloneItem(item))
  }

  async delete(id: string): Promise<void> {
    await this.ensureMigrated()
    await this.database.transaction(
      'rw',
      this.database.generatedImages,
      this.database.generatedImageFiles,
      async () => {
        await this.database.generatedImages.delete(id)
        await this.database.generatedImageFiles.delete(id)
      },
    )
  }
}
