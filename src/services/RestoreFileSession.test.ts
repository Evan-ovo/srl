/** @vitest-environment node */
import { Capacitor } from '@capacitor/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nativeFileSize, nativeFileSource, rememberNativeFile } from '../core/NativeFileSource'
import type { Resource, ResourceType } from '../types/Resource'
import type { RestoreStagingEntry } from '../types/RestoreStaging'
import type { RestoreStagingStore } from '../storage/RestoreStagingStore'
import { createImageThumbnail } from '../utils/createImageThumbnail'
import { openArchiveFiles } from './RestoreFileSession'

// Isolate metadata selection from image decoding; the thumbnail records exactly
// which verified original was chosen. PNG decoding has separate browser coverage.
vi.mock('../utils/createImageThumbnail', () => ({
  createImageThumbnail: vi.fn(
    async (blob: Blob) => new Blob(['thumbnail:' + (await blob.text())], { type: 'image/webp' }),
  ),
}))
beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.restoreAllMocks())
async function record(
  id: string,
  type: ResourceType = 'other',
  metadata: Record<string, unknown> = {},
): Promise<Resource> {
  const avatar = metadata.assetKind === 'userPersonaAvatar'
  const originalBlob = new Blob([JSON.stringify({ id, metadata })], {
    type: avatar ? 'image/png' : 'application/json',
  })
  const contentHash = [
    ...new Uint8Array(await crypto.subtle.digest('SHA-256', await originalBlob.arrayBuffer())),
  ]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
  return {
    id,
    type,
    metadata,
    name: id,
    description: '',
    fileName: id + (avatar ? '.png' : '.json'),
    mimeType: originalBlob.type,
    fileSize: originalBlob.size,
    originalBlob,
    contentHash,
    tags: [],
    favorite: false,
    categoryId: null,
    createdAt: 1,
    updatedAt: 1,
  }
}
function fixture(rows: Resource[]) {
  const paths = new Map(rows.map((row) => [row.contentHash, 'files/' + row.contentHash]))
  const entries = new Map<string, RestoreStagingEntry>(
    rows.map((row) => [
      paths.get(row.contentHash)!,
      {
        jobId: 'fixture',
        path: paths.get(row.contentHash)!,
        blob: row.originalBlob,
        size: row.fileSize,
        sha256: row.contentHash,
        updatedAt: 1,
      },
    ]),
  )
  const get = vi.fn(async (_jobId: string, path: string) => entries.get(path)),
    deleteJob = vi.fn(async () => undefined)
  const stage: RestoreStagingStore = {
    get,
    deleteJob,
    getMetadata: async (_jobId, path) => entries.get(path),
    putChunk: async () => undefined,
    complete: async () => undefined,
  }
  return { stage, get, deleteJob, entries, paths }
}

describe('staged persona avatar selection', () => {
  it('passes a declared file reference only to an explicit native original sink', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true)
    const row = { ...(await record('large')), fileSize: 32 * 1024 * 1024, mimeType: 'video/mp4' }
    const state = fixture([row])
    const entry = state.entries.get(state.paths.get(row.contentHash)!)!
    const getNativeFile = vi.fn(async () => ({
      ...entry,
      blob: rememberNativeFile(new Blob(), 'file:///staged', row.fileSize),
    }))
    state.stage.getNativeFile = getNativeFile
    const ordinary = await openArchiveFiles(state.stage, 'fixture', state.paths, [row])
    await ordinary.hydrate(row)
    expect(getNativeFile).not.toHaveBeenCalled()
    const native = await openArchiveFiles(state.stage, 'fixture', state.paths, [row], true)
    const ready = await native.hydrate(row)
    expect(ready.originalBlob.size).toBe(0)
    expect(nativeFileSize(ready.originalBlob)).toBe(row.fileSize)
    expect(nativeFileSource(ready.originalBlob)).toBe('file:///staged')
    expect(state.get).toHaveBeenCalledTimes(1)
    getNativeFile.mockResolvedValueOnce(undefined as never)
    await native.hydrate(row)
    expect(state.get).toHaveBeenCalledTimes(2)
    await native.hydrate({ ...row, type: 'secret' })
    expect(getNativeFile).toHaveBeenCalledTimes(2)
  })
  it('does not scan unrelated records for each persona or prefetch originals at session open', async () => {
    const personas = await Promise.all(
      Array.from({ length: 160 }, async (_, i) => ({
        ...(await record(`persona-${i}`, 'userPersona', { defaultPersonaAvatarId: `avatar-${i}` })),
        relatedResourceIds: [`avatar-${i}`],
      })),
    )
    const avatars = await Promise.all(
      Array.from({ length: 160 }, (_, i) =>
        record(`avatar-${i}`, 'other', { assetKind: 'userPersonaAvatar', avatarId: `avatar-${i}` }),
      ),
    )
    const others = await Promise.all(Array.from({ length: 600 }, (_, i) => record(`other-${i}`)))
    const rows = [...personas, ...others, ...avatars],
      test = fixture(rows)
    let idReads = 0
    const counted = rows.map((row) => ({
      ...row,
      get id() {
        idReads++
        return row.id
      },
    }))
    const session = await openArchiveFiles(test.stage, 'fixture', test.paths, counted)
    expect(test.get).not.toHaveBeenCalled()
    for (const [i, persona] of counted.slice(0, personas.length).entries()) {
      const ready = await session.hydrate(persona)
      expect(await ready.originalBlob.text()).toBe(await personas[i]!.originalBlob.text())
      expect(await ready.thumbnailBlob!.text()).toBe(
        'thumbnail:' + (await avatars[i]!.originalBlob.text()),
      )
    }
    expect(test.get).toHaveBeenCalledTimes(personas.length * 2)
    expect(createImageThumbnail).toHaveBeenCalledTimes(personas.length)
    expect(idReads).toBeLessThanOrEqual(rows.length * 5)
    await session.dispose()
    expect(test.deleteJob).toHaveBeenCalledWith('fixture')
  })

  it.each([undefined, 'unknown', 'last'] as const)(
    'preserves collection order and missing/default avatar keys (default=%s)',
    async (defaultId) => {
      const persona = {
        ...(await record('persona', 'userPersona', { defaultPersonaAvatarId: defaultId })),
        relatedResourceIds: ['last', 'missing-key', 'first'],
      }
      const first = await record('first', 'other', {
        assetKind: 'userPersonaAvatar',
        avatarId: 'first',
      })
      const missing = await record('missing-key', 'other', { assetKind: 'userPersonaAvatar' })
      const last = await record('last', 'other', {
        assetKind: 'userPersonaAvatar',
        avatarId: 'last',
      })
      const unrelated = await record('unrelated', 'other', {
        assetKind: 'userPersonaAvatar',
        avatarId: defaultId,
      })
      const test = fixture([persona, first, missing, last, unrelated]),
        session = await openArchiveFiles(test.stage, 'fixture', test.paths, [
          persona,
          first,
          missing,
          last,
          unrelated,
        ])
      const ready = await session.hydrate(persona),
        expected = defaultId === undefined ? missing : defaultId === 'last' ? last : first
      expect(await ready.thumbnailBlob!.text()).toBe(
        'thumbnail:' + (await expected.originalBlob.text()),
      )
      expect(test.get.mock.calls.map(([, path]) => path)).toEqual([
        test.paths.get(persona.contentHash),
        test.paths.get(expected.contentHash),
      ])
    },
  )

  it('keeps duplicate avatar IDs available for matching and ignores unrelated records', async () => {
    const persona = {
      ...(await record('persona', 'userPersona', { defaultPersonaAvatarId: 'wanted' })),
      relatedResourceIds: ['duplicate'],
    }
    const first = await record('duplicate', 'other', {
      assetKind: 'userPersonaAvatar',
      avatarId: 'other',
    })
    const second = await record('duplicate', 'other', {
      assetKind: 'userPersonaAvatar',
      avatarId: 'wanted',
    })
    const rows = [persona, first, second],
      test = fixture(rows),
      session = await openArchiveFiles(test.stage, 'fixture', test.paths, rows)
    expect(await (await session.hydrate(persona)).thumbnailBlob!.text()).toBe(
      'thumbnail:' + (await second.originalBlob.text()),
    )
  })

  it('rereads stage validity and native URI rather than caching materialized originals or thumbnails', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true)
    const persona = { ...(await record('persona', 'userPersona')), relatedResourceIds: ['avatar'] }
    const avatar = await record('avatar', 'other', { assetKind: 'userPersonaAvatar' })
    const rows = [persona, avatar],
      test = fixture(rows),
      entry = test.entries.get(test.paths.get(avatar.contentHash)!)!
    rememberNativeFile(entry.blob, 'content://fixture/first')
    const session = await openArchiveFiles(test.stage, 'fixture', test.paths, rows)
    await session.hydrate(persona)
    entry.blob = rememberNativeFile(
      new Blob([entry.blob], { type: entry.blob.type }),
      'content://fixture/second',
    )
    await session.hydrate(persona)
    expect(
      vi.mocked(createImageThumbnail).mock.calls.map(([blob]) => nativeFileSource(blob)),
    ).toEqual(['content://fixture/first', 'content://fixture/second'])
    entry.size++
    await expect(session.hydrate(persona)).rejects.toThrow('备份原文件校验失败')
    expect(test.get).toHaveBeenCalledTimes(6)
    expect(createImageThumbnail).toHaveBeenCalledTimes(2)
    expect(test.deleteJob).not.toHaveBeenCalled()
  })
})
