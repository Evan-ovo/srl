import { describe, expect, it, vi } from 'vitest'
import type { Resource } from '../types/Resource'
import {
  cloneBlob,
  cloneResourceForStorage,
  hydrateResourceFromIndexedDb,
  materializeResourceForIndexedDb,
} from './ResourceStorageClone'

describe('cloneBlob', () => {
  it('detaches large files in bounded reads and keeps large originals out of ArrayBuffer records', async () => {
    const original = new File([new Uint8Array(3 * 1024 * 1024 + 19)], 'video.mp4', {
      type: 'video/mp4',
    })
    const read = vi.spyOn(original, 'arrayBuffer').mockRejectedValue(new Error('no whole file'))
    const slice = vi.spyOn(original, 'slice')
    const cloned = await cloneBlob(original)
    expect(cloned!.size).toBe(original.size)
    expect(cloned!.type).toBe(original.type)
    expect(slice.mock.calls).toHaveLength(4)
    expect(slice.mock.calls.every(([start = 0, end = 0]) => end - start <= 1024 * 1024)).toBe(true)
    expect(read).not.toHaveBeenCalled()
    const stored = await materializeResourceForIndexedDb({ originalBlob: cloned } as Resource)
    expect((stored as Resource).originalBlob).toBe(cloned)
    expect(new Uint8Array(await cloned!.slice(-19).arrayBuffer())).toEqual(new Uint8Array(19))
  })
  it('materializes File bytes as a detached Blob for WebKit IndexedDB persistence', async () => {
    const file = new File(['preset'], 'preset.json', { type: 'application/json' })
    const cloned = await cloneBlob(file)

    expect(cloned).toBeInstanceOf(Blob)
    expect(cloned).not.toBe(file)
    expect(cloned?.type).toBe('application/json')
    expect(await cloned?.text()).toBe('preset')
  })
})

describe('IndexedDB binary boundary', () => {
  it('preserves V2 backup parts on metadata edits and invalidates them when original content changes', async () => {
    const resource: Resource = {
      id: 'descriptor-resource',
      type: 'other',
      name: 'original',
      description: '',
      fileName: 'original.bin',
      mimeType: 'application/octet-stream',
      fileSize: 6,
      contentHash: 'a'.repeat(64),
      favorite: false,
      categoryId: null,
      tags: [],
      metadata: {},
      originalBlob: new Blob(['binary']),
      createdAt: 1,
      updatedAt: 1,
      backupDescriptor: {
        version: 2,
        resourceId: 'descriptor-resource',
        contentHash: 'a'.repeat(64),
        size: 6,
        updatedAt: 1,
        parts: [
          {
            name: `srl-chunk--sha256-${'a'.repeat(64)}`,
            offset: 0,
            size: 6,
            sha256: 'a'.repeat(64),
          },
        ],
      },
    }
    const edited = await cloneResourceForStorage({
      ...resource,
      name: 'metadata edit',
      updatedAt: 2,
    })
    expect(edited.backupDescriptor).toEqual(resource.backupDescriptor)
    expect(await edited.originalBlob.text()).toBe('binary')
    for (const changes of [{ contentHash: 'b'.repeat(64) }, { fileSize: 7 }, { id: 'new-owner' }]) {
      const replaced = await cloneResourceForStorage({ ...resource, ...changes })
      expect(replaced.backupDescriptor?.parts).toBeUndefined()
      expect(replaced.backupDescriptor).toMatchObject({
        resourceId: replaced.id,
        contentHash: replaced.contentHash,
        size: replaced.fileSize,
      })
    }
  })
  it('stores resource bodies as ArrayBuffer and hydrates them back to Blob', async () => {
    const resource = {
      id: 'resource-1',
      type: 'preset',
      name: '预设',
      description: '',
      fileName: 'preset.json',
      mimeType: 'application/json',
      fileSize: 6,
      contentHash: 'a'.repeat(64),
      favorite: false,
      categoryId: null,
      tags: [],
      metadata: {},
      originalBlob: new Blob(['preset'], { type: 'application/json' }),
      createdAt: 1,
      updatedAt: 1,
    } as Resource

    const stored = await materializeResourceForIndexedDb(resource)
    const storedBlob = (stored as { originalBlob: unknown }).originalBlob
    expect(storedBlob).toBeInstanceOf(ArrayBuffer)

    const hydrated = hydrateResourceFromIndexedDb(stored)
    expect(hydrated.originalBlob).toBeInstanceOf(Blob)
    expect(await hydrated.originalBlob.text()).toBe('preset')
  })
})
