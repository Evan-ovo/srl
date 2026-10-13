import { describe, expect, it, vi } from 'vitest'

import { RESOURCE_TYPE, type Resource } from '../types/Resource'
import type { ResourceService } from './ResourceService'
import { UserPersonaService } from './UserPersonaService'

function personaResource(): Resource {
  const content = JSON.stringify({
    personas: { 'alice.png': 'Alice' },
    persona_descriptions: { 'alice.png': { description: 'Archivist', position: 0 } },
    default_persona: 'alice.png',
  })
  return {
    id: 'persona-resource',
    type: RESOURCE_TYPE.USER_PERSONA,
    name: 'Alice',
    description: 'SillyTavern 用户人设备份，包含 1 个人设',
    fileName: 'personas_20260801.json',
    mimeType: 'application/json',
    fileSize: content.length,
    contentHash: 'a'.repeat(64),
    favorite: false,
    categoryId: null,
    categoryIds: [],
    relatedResourceIds: [],
    tags: ['自设'],
    metadata: { detectedVariant: 'sillyTavernPersonaBackup', itemCount: 1 },
    originalBlob: new Blob([content], { type: 'application/json' }),
    createdAt: 1,
    updatedAt: 1,
  }
}

function avatarResource(): Resource {
  return {
    ...personaResource(),
    id: 'avatar-resource',
    type: RESOURCE_TYPE.OTHER,
    name: '用户头像 · alice',
    fileName: 'alice.png',
    mimeType: 'image/png',
    metadata: { assetKind: 'userPersonaAvatar', avatarId: 'alice.png' },
    thumbnailBlob: new Blob(['thumbnail'], { type: 'image/webp' }),
    originalBlob: new Blob(['avatar'], { type: 'image/png' }),
  }
}

describe('UserPersonaService', () => {
  it('reads only verified avatar attachments after checking related metadata', async () => {
    const avatar = avatarResource()
    const getSummary = vi
      .fn()
      .mockResolvedValueOnce(personaResource())
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(avatar)
      .mockResolvedValueOnce(avatar)
    const get = vi.fn().mockResolvedValueOnce(avatar).mockResolvedValueOnce(personaResource())
    const service = new UserPersonaService({
      getSummary,
      get,
    } as unknown as ResourceService)
    expect(await service.loadAvatarResource('character')).toBeUndefined()
    expect(await service.loadAvatarResource('missing')).toBeUndefined()
    expect(get).not.toHaveBeenCalled()
    expect(await service.loadAvatarResource(avatar.id)).toEqual(avatar)
    expect(get).toHaveBeenCalledTimes(1)
    // An attachment changed after the metadata read must still be checked on load.
    expect(await service.loadAvatarResource(avatar.id)).toBeUndefined()
    expect(get).toHaveBeenCalledTimes(2)
  })

  it.each(['imported', 'duplicate'] as const)(
    'skips an empty cover write when a %s persona has no thumbnail',
    async (status) => {
      const resource = personaResource()
      const importFiles = vi.fn(async () => [{ status, resource }])
      const updateThumbnail = vi.fn()
      const service = new UserPersonaService({
        importFiles,
        updateThumbnail,
      } as unknown as ResourceService)
      const loaded = (
        await import('../parser/SillyTavernPersonaBackup')
      ).parseSillyTavernPersonaBackup(JSON.parse(await resource.originalBlob.text()))
      await service.create(loaded.entries[0]!, [], null)
      expect(updateThumbnail).not.toHaveBeenCalled()
    },
  )

  it('still clears an existing duplicate persona cover when explicitly saved without an avatar', async () => {
    const resource = { ...personaResource(), thumbnailBlob: new Blob(['old cover']) }
    const importFiles = vi.fn(async () => [{ status: 'duplicate', resource }])
    const updateThumbnail = vi.fn(async () => resource)
    const service = new UserPersonaService({
      importFiles,
      updateThumbnail,
    } as unknown as ResourceService)
    const loaded = (
      await import('../parser/SillyTavernPersonaBackup')
    ).parseSillyTavernPersonaBackup(JSON.parse(await resource.originalBlob.text()))
    await service.create(loaded.entries[0]!, [], null)
    expect(updateThumbnail).toHaveBeenCalledWith(resource.id, undefined)
  })
  it('caches a validated avatar as an internal persona attachment', async () => {
    const avatar = avatarResource()
    const importPreparedFile = vi.fn(async () => ({
      status: 'imported' as const,
      fileName: 'alice.png',
      resource: avatar,
    }))
    const resourceService = { importPreparedFile } as unknown as ResourceService
    const service = new UserPersonaService(resourceService)
    const bytes = new Uint8Array(45)
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0)
    bytes.set([0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 3], 8)
    bytes.set([0, 0, 0, 0, 73, 69, 78, 68, 0, 0, 0, 0], 33)

    const cached = await service.cacheAvatarFile(
      new File([bytes], 'source.png', { type: 'image/png' }),
      'alice.png',
    )

    expect(cached.id).toBe('avatar-resource')
    expect(importPreparedFile).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'alice.png', type: 'image/png' }),
      expect.objectContaining({
        type: RESOURCE_TYPE.OTHER,
        metadata: expect.objectContaining({
          assetKind: 'userPersonaAvatar',
          avatarId: 'alice.png',
        }),
      }),
      { allowContentDuplicate: true },
    )
  })

  it('loads persona content from the authoritative resource blob', async () => {
    const resource = personaResource()
    const resourceService = { get: vi.fn(async () => resource) } as unknown as ResourceService
    const service = new UserPersonaService(resourceService)

    const loaded = await service.load(resource.id)

    expect(loaded.view.entries[0]).toMatchObject({ avatarId: 'alice.png', name: 'Alice' })
  })

  it('saves edits as an active history version and synchronizes resource relations', async () => {
    const before = personaResource()
    const after = { ...before, updatedAt: 2 }
    const get = vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after)
    const importAsVersion = vi.fn(async () => after)
    const updateDetails = vi.fn(async () => undefined)
    const updateThumbnail = vi.fn(async () => after)
    const resourceService = {
      get,
      importAsVersion,
      updateDetails,
      updateThumbnail,
    } as unknown as ResourceService
    const service = new UserPersonaService(resourceService)
    const backup = JSON.parse(await before.originalBlob.text())
    backup.persona_descriptions['alice.png'].description = 'Updated archivist'

    const avatar = avatarResource()
    await service.save(before.id, backup, ['world-1', 'character-1'], '用户人设编辑', avatar, true)

    expect(importAsVersion).toHaveBeenCalledWith(
      expect.objectContaining({ name: before.fileName }),
      before.id,
      true,
      '用户人设编辑',
      undefined,
      {},
      false,
      true,
    )
    expect(updateDetails).toHaveBeenCalledWith(
      after,
      expect.objectContaining({
        name: before.name,
        type: RESOURCE_TYPE.USER_PERSONA,
        relatedResourceIds: ['world-1', 'character-1'],
        tags: ['自设'],
      }),
    )
    expect(updateThumbnail).toHaveBeenCalledWith(before.id, avatar.thumbnailBlob)
  })

  it('rejects non-persona JSON before it can enter the persona app', async () => {
    const importFiles = vi.fn()
    const resourceService = { importFiles } as unknown as ResourceService
    const service = new UserPersonaService(resourceService)

    const report = await service.importFiles([
      new File(['{"name":"not a persona"}'], 'other.json', { type: 'application/json' }),
    ])

    expect(report.imported).toBe(0)
    expect(report.failed[0]?.message).toContain('不是 SillyTavern 用户人设备份')
    expect(importFiles).not.toHaveBeenCalled()
  })
})

it('saves a cover-only edit without reimporting duplicate native JSON, and syncs renamed personas', async () => {
  const before = personaResource()
  const backup = JSON.parse(await before.originalBlob.text())
  const { serializeSillyTavernPersonaBackup } = await import('../parser/SillyTavernPersonaBackup')
  before.originalBlob = new Blob([serializeSillyTavernPersonaBackup(backup)], {
    type: 'application/json',
  })
  const avatar = avatarResource()
  const get = vi.fn(async () => before)
  const importAsVersion = vi.fn(async () => before)
  const updateDetails = vi.fn(async () => undefined)
  const updateThumbnail = vi.fn(async () => before)
  const service = new UserPersonaService({
    get,
    importAsVersion,
    updateDetails,
    updateThumbnail,
  } as unknown as ResourceService)
  await service.save(before.id, backup, [avatar.id], '封面', avatar)
  expect(importAsVersion).not.toHaveBeenCalled()
  expect(updateThumbnail).toHaveBeenCalledWith(before.id, avatar.thumbnailBlob)
  expect(updateDetails).toHaveBeenCalledWith(
    before,
    expect.objectContaining({ relatedResourceIds: [avatar.id] }),
  )
  backup.personas['alice.png'] = 'Alice renamed'
  await service.save(before.id, backup, [avatar.id], '改名')
  expect(importAsVersion).toHaveBeenCalledOnce()
  expect(importAsVersion.mock.calls[0]?.at(-1)).toBe(false)
  expect(updateDetails).toHaveBeenLastCalledWith(
    before,
    expect.objectContaining({ name: 'Alice renamed' }),
  )
})
