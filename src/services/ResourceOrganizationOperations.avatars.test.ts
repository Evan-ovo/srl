import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { AppDatabase } from '../database/AppDatabase'
import { IndexedDbResourceStorage } from '../storage/IndexedDbResourceStorage'
import { RESOURCE_TYPE, type Resource } from '../types/Resource'
import { findDuplicateGroups } from '../utils/DuplicateGroups'
import { deleteMany, mergeDuplicates } from './ResourceOrganizationOperations'

function resource(id: string, overrides: Partial<Resource> = {}): Resource {
  return {
    id,
    type: RESOURCE_TYPE.OTHER,
    name: id,
    description: '',
    fileName: `${id}.bin`,
    contentHash: 'same-pixels',
    fileSize: 4,
    mimeType: 'application/octet-stream',
    originalBlob: new Blob(['same']),
    metadata: { assetKind: 'userPersonaAvatar', avatarId: 'avatar.png' },
    relatedResourceIds: ['persona'],
    categoryId: null,
    tags: [],
    favorite: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function fixture(): Resource[] {
  return [
    resource('persona', {
      type: RESOURCE_TYPE.USER_PERSONA,
      contentHash: 'persona-data',
      metadata: { manuallyBoundResourceIds: ['copy'] },
      relatedResourceIds: ['copy'],
    }),
    resource('keep'),
    resource('copy'),
    resource('different-avatar', {
      metadata: { assetKind: 'userPersonaAvatar', avatarId: 'other.png' },
    }),
    resource('ordinary-image', { metadata: {}, relatedResourceIds: [] }),
  ]
}

describe('cleanup restored avatar copies', () => {
  it('shows only repeated avatar identities, preserving other avatar names and ordinary images', () => {
    const groups = findDuplicateGroups(fixture())
    expect(groups).toHaveLength(1)
    expect(groups[0].resources.map((item) => item.id)).toEqual(['keep', 'copy'])
  })

  it('moves persona links and manual bindings to the keeper, and is safe to repeat', async () => {
    const db = new AppDatabase(`avatar-clean-${crypto.randomUUID()}`)
    const storage = new IndexedDbResourceStorage(db)
    try {
      await storage.saveMany(fixture())
      const remove = (ids: string[]) => deleteMany(storage, ids)
      expect(await mergeDuplicates(storage, remove, 'keep', ['copy'])).toBe(1)
      const persona = await storage.get('persona')
      expect(persona?.relatedResourceIds).toEqual(['keep'])
      expect(persona?.metadata.manuallyBoundResourceIds).toEqual(['keep'])
      expect((await storage.get('keep'))?.relatedResourceIds).toEqual(['persona'])
      expect(await storage.get('copy')).toBeUndefined()
      expect(await storage.get('different-avatar')).toBeDefined()
      expect(await storage.get('ordinary-image')).toBeDefined()
      expect(findDuplicateGroups(await storage.listSummaries())).toEqual([])
      expect(await mergeDuplicates(storage, remove, 'keep', ['copy'])).toBe(0)
    } finally {
      await db.delete()
    }
  })

  it.each(['different-avatar', 'ordinary-image', 'different-owner'])(
    'rejects %s even when image bytes match',
    async (target) => {
      const db = new AppDatabase(`avatar-guard-${crypto.randomUUID()}`)
      const storage = new IndexedDbResourceStorage(db)
      try {
        await storage.saveMany([
          ...fixture(),
          resource('other-persona', {
            type: RESOURCE_TYPE.USER_PERSONA,
            contentHash: 'other-owner',
            metadata: {},
            relatedResourceIds: ['different-owner'],
          }),
          resource('different-owner', { relatedResourceIds: ['other-persona'] }),
        ])
        await expect(
          mergeDuplicates(storage, (ids) => deleteMany(storage, ids), 'keep', [target]),
        ).rejects.toThrow('头像身份')
        expect(await storage.get(target)).toBeDefined()
        expect((await storage.get('persona'))?.relatedResourceIds).toEqual(['copy'])
      } finally {
        await db.delete()
      }
    },
  )
})
