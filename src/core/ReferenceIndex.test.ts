import { describe, expect, it, vi } from 'vitest'

import { ReferenceIndex, type EntityReference } from './ReferenceIndex'

function reference(
  ownerId: string,
  targetId: string,
  overrides: Partial<EntityReference> = {},
): EntityReference {
  return {
    ownerType: 'relation',
    ownerId,
    targetType: 'resource',
    targetId,
    label: ownerId,
    strength: 'strong',
    ...overrides,
  }
}

describe('ReferenceIndex', () => {
  it('replaces only the selected owner and keeps other owners in insertion order', () => {
    const index = new ReferenceIndex()
    const first = reference('first', 'shared')
    const second = reference('second', 'shared')
    index.replaceOwner('relation', 'first', [first, reference('first', 'old')])
    index.replaceOwner('relation', 'second', [second])
    const replacement = reference('first', 'shared', { label: 'updated' })
    index.replaceOwner('relation', 'first', [replacement, reference('first', 'new')])
    expect(index.impacts('resource', 'shared')).toEqual([second, replacement])
    expect(index.impacts('resource', 'old')).toEqual([])
    expect(index.impacts('resource', 'new')).toEqual([reference('first', 'new')])
    index.removeOwner('relation', 'first')
    expect(index.impacts('resource', 'shared')).toEqual([second])
    expect(index.impacts('resource', 'new')).toEqual([])
    index.removeOwner('relation', 'first')
    expect(index.impacts('resource', 'shared')).toEqual([second])
  })

  it('keeps the last duplicate target and ignores references belonging to another owner', () => {
    const index = new ReferenceIndex()
    const last = reference('a', 'target', { label: 'last', strength: 'weak' })
    index.replaceOwner('relation', 'a', [
      reference('a', 'target'),
      reference('other', 'ignored'),
      reference('a', 'ignored', { ownerType: 'asset' }),
      last,
    ])
    expect(index.impacts('resource', 'target')).toEqual([last])
    expect(index.impacts('resource', 'ignored')).toEqual([])
    index.replaceOwner('relation', 'a', [reference('other', 'ignored')])
    expect(index.impacts('resource', 'target')).toEqual([])
    index.removeOwner('relation', 'a')
    expect(index.impacts('resource', 'ignored')).toEqual([])
  })

  it('separates owner and target entity types with identical IDs', () => {
    const index = new ReferenceIndex()
    const relation = reference('same', 'target')
    const assetOwner = reference('same', 'target', { ownerType: 'asset' })
    const assetTarget = reference('same', 'target', { targetType: 'asset' })
    index.replaceOwner('relation', 'same', [relation, assetTarget])
    index.replaceOwner('asset', 'same', [assetOwner])
    index.removeOwner('relation', 'same')
    expect(index.impacts('resource', 'target')).toEqual([assetOwner])
    expect(index.impacts('asset', 'target')).toEqual([])
  })

  it('clears both indexes so reusing owner IDs cannot remove newly added references', () => {
    const index = new ReferenceIndex()
    index.replaceOwner('relation', 'old', [reference('old', 'shared')])
    index.clear()
    const current = reference('new', 'shared')
    index.replaceOwner('relation', 'new', [current])
    index.removeOwner('relation', 'old')
    expect(index.impacts('resource', 'shared')).toEqual([current])
    index.replaceOwner('relation', 'old', [reference('old', 'other')])
    expect(index.impacts('resource', 'other')).toEqual([reference('old', 'other')])
    index.clear()
    expect(index.impacts('resource', 'shared')).toEqual([])
    expect(index.impacts('resource', 'other')).toEqual([])
  })

  it.each([1000, 5000, 10000])(
    'does not scan unrelated targets when adding or replacing an owner in a %i-item library',
    (count) => {
      const index = new ReferenceIndex()
      for (let position = 0; position < count; position++)
        index.replaceOwner('relation', String(position), [
          reference(String(position), String(position)),
        ])
      const deletedKeys: unknown[] = []
      const originalDelete = Map.prototype.delete
      const spy = vi.spyOn(Map.prototype, 'delete').mockImplementation(function (
        this: Map<unknown, unknown>,
        key: unknown,
      ) {
        deletedKeys.push(key)
        return originalDelete.call(this, key)
      })
      try {
        index.replaceOwner('relation', 'new', [reference('new', 'new-target')])
        index.replaceOwner('relation', '0', [reference('0', 'replacement')])
        index.removeOwner('relation', 'missing')
      } finally {
        spy.mockRestore()
      }
      expect(deletedKeys.filter((key) => key === 'relation:new')).toHaveLength(0)
      // One edge bucket and its reverse owner entry; never every target in the library.
      expect(deletedKeys.filter((key) => key === 'relation:0')).toHaveLength(2)
      expect(deletedKeys.filter((key) => key === 'relation:missing')).toHaveLength(0)
      expect(index.impacts('resource', '0')).toEqual([])
      expect(index.impacts('resource', 'replacement')).toEqual([reference('0', 'replacement')])
      expect(index.impacts('resource', String(count - 1))).toEqual([
        reference(String(count - 1), String(count - 1)),
      ])
    },
  )
})
