import type { AppDatabase } from '../database/AppDatabase'
import { toResourceSummary, type Resource } from '../types/Resource'
import type { ResourceReadSource } from '../types/ResourceReadSource'
import { isEncryptedResource, isNativeBackedResource, type StoredResource } from '../types/Vault'
import { isAndroidNativeAppDatabaseActive, runAndroidNativeRead } from './AndroidNativeDexieCore'
import { encodeAppDatabaseKey, isEncodedBlobValue } from './AndroidAppDatabaseMigration'
import { nativeAppDatabase } from './NativeAppDatabaseBridge'
import { withAbort } from '../utils/Abortable'
import { openNativeResourceByteSource } from './NativeResourceFileMirror'

/** Read a resource snapshot without hydrating originals or thumbnail attachments. */
export async function readResourceMetadata(
  database: AppDatabase,
  id: string,
  store: 'resources' | 'resourceVersions' = 'resources',
): Promise<StoredResource | undefined> {
  const table = database[store]
  if (!isAndroidNativeAppDatabaseActive()) return table.get(id)
  return database.transaction('r', table, async (transaction) => {
    const request = { trans: transaction.idbtrans, key: id, loadBinary: false }
    return (await table.core.get(request)) as StoredResource | undefined
  })
}

/** Uses the same DBCore transaction queue as get()/update(), retaining binary descriptors. */
export async function readResourceMetadataBatch(
  database: AppDatabase,
  ids: string[],
  store: 'resources' | 'resourceVersions' = 'resources',
): Promise<Array<StoredResource | undefined>> {
  const table = database[store]
  if (!isAndroidNativeAppDatabaseActive()) return table.bulkGet(ids)
  return database.transaction('r', table, async (transaction) => {
    const request = { trans: transaction.idbtrans, keys: ids, loadBinary: false }
    return (await table.core.getMany(request)) as Array<StoredResource | undefined>
  })
}

/** Uses the same DBCore transaction queue as get()/update(), retaining binary descriptors. */
export async function readResourceSource(
  database: AppDatabase,
  id: string,
  get: (id: string) => Promise<Resource | undefined>,
  historical = false,
  signal?: AbortSignal,
  decode?: (record: StoredResource) => Promise<Resource>,
): Promise<ResourceReadSource | undefined> {
  signal?.throwIfAborted()
  const activeNative = isAndroidNativeAppDatabaseActive()
  const store = historical ? 'resourceVersions' : 'resources'
  const record = await withAbort(readResourceMetadata(database, id, store), signal)
  if (!record) return undefined
  if (activeNative) {
    if (isNativeBackedResource(record)) {
      if (
        record.nativeOriginal.contentHash.toLowerCase() !== record.contentHash.toLowerCase() ||
        record.nativeOriginal.size !== record.fileSize
      )
        throw new Error('Android 原生原件描述与资源索引不一致')
      const originalSource = await openNativeResourceByteSource(
        record.nativeOriginal.contentHash.toLowerCase(),
        record.nativeOriginal.size,
        signal,
      )
      if (originalSource)
        return { ...toResourceSummary(record as unknown as Resource), originalSource }
    }
    const table = database[store]
    if (
      !isEncryptedResource(record) &&
      'originalBlob' in record &&
      isEncodedBlobValue(record.originalBlob)
    ) {
      const descriptor = record.originalBlob
      const key = descriptor.blobOwnerKey ?? encodeAppDatabaseKey(id)
      const read = (offset: number, length: number) =>
        database.transaction('r', table, (transaction) =>
          runAndroidNativeRead(transaction.idbtrans, () =>
            nativeAppDatabase.readBlobRange(
              store,
              key,
              descriptor.fieldPath,
              offset,
              length,
              descriptor,
            ),
          ),
        )
      // Live existence/identity validation still runs when recent floors are cached.
      await withAbort(read(0, Math.min(1, descriptor.size)), signal)
      const source = {
        size: descriptor.size,
        contentIdentity: descriptor.sha256,
        slice(start = 0, end = descriptor.size) {
          const bound = (value: number) =>
            Math.max(0, Math.min(descriptor.size, value < 0 ? descriptor.size + value : value))
          const from = bound(start),
            to = Math.max(from, bound(end))
          return {
            async arrayBuffer(readSignal = signal) {
              const bytes = new Uint8Array(to - from)
              for (let offset = from; offset < to; offset += 256 * 1024) {
                readSignal?.throwIfAborted()
                const chunk = await withAbort(
                  read(offset, Math.min(256 * 1024, to - offset)),
                  readSignal,
                )
                readSignal?.throwIfAborted()
                bytes.set(new Uint8Array(chunk), offset - from)
              }
              return bytes.buffer
            },
          }
        },
        async text() {
          const decoder = new TextDecoder('utf-8')
          let text = ''
          for (let offset = 0; offset < descriptor.size; offset += 256 * 1024)
            text += decoder.decode(
              await read(offset, Math.min(256 * 1024, descriptor.size - offset)),
              { stream: true },
            )
          return text + decoder.decode()
        },
      }
      return { ...toResourceSummary(record as unknown as Resource), originalSource: source }
    }
  }
  // Encrypted originals and old file mirrors retain their established verified owner.
  const resource = await withAbort(!activeNative && decode ? decode(record) : get(id), signal)
  signal?.throwIfAborted()
  return resource
    ? {
        ...toResourceSummary(resource),
        originalSource: resource.originalBlob,
        requiresWholeRead:
          isEncryptedResource(record) ||
          isNativeBackedResource(record) ||
          ('originalBlob' in record && record.originalBlob instanceof ArrayBuffer),
      }
    : undefined
}
