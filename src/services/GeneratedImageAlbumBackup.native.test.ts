import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { AppDatabase } from '../database/AppDatabase'
import { IndexedDbGeneratedImageAlbumStorage } from '../storage/IndexedDbGeneratedImageAlbumStorage'
import { createStructuredSnapshot } from './CloudStructuredSnapshot'

const native = vi.hoisted(() => ({ sources: new WeakMap<Blob, string>() }))
vi.mock('../core/NativeFileSource', async (original) => ({
  ...(await original<typeof import('../core/NativeFileSource')>()),
  nativeFileSource: (blob: Blob) => native.sources.get(blob),
  hashNativeFile: async () => undefined,
}))

let database: AppDatabase | undefined
afterEach(async () => {
  if (database) {
    database.close()
    await database.delete()
    database = undefined
  }
})

it('hands album bytes to native file-range plans and preserves source identity at the storage boundary', async () => {
  const original = new Blob(['native-image-bytes'], { type: 'image/png' })
  native.sources.set(original, 'file:///fixture/album.png')
  const item = {
    id: 'native-image',
    name: 'image',
    source: 'imported' as const,
    category: '',
    mimeType: 'image/png',
    sizeBytes: original.size,
    createdAt: 1,
    updatedAt: 1,
  }
  const created = await createStructuredSnapshot(
    [],
    [],
    [],
    { version: 1, generatedImageAlbum: [{ item }] },
    { readAlbumFile: async () => original },
  )
  expect(created.snapshot.version).toBe(5)
  expect(created.chunks.size).toBe(0)
  expect(created.objectPlans[0]).toMatchObject({
    source: { kind: 'file', uri: 'file:///fixture/album.png', offset: 0, size: original.size },
  })
  expect(created.objectPlans[0]?.blob).toBeUndefined()
  database = new AppDatabase('album-native-boundary-' + crypto.randomUUID())
  const write = vi.spyOn(database.generatedImageFiles, 'put')
  await new IndexedDbGeneratedImageAlbumStorage(database).put(item, {
    id: item.id,
    originalBlob: original,
    originalMimeType: item.mimeType,
    updatedAt: 1,
  })
  expect(write.mock.calls.at(-1)?.[0].originalBlob).toBe(original)
  expect(native.sources.get(write.mock.calls.at(-1)![0].originalBlob!)).toBe(
    'file:///fixture/album.png',
  )
})
