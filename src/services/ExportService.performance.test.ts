/** @vitest-environment node */
import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import type { ArchiveManifest } from '../types/Backup'
import { RESOURCE_TYPE, type Resource, type ResourceSummary } from '../types/Resource'
import * as ResourceTypes from '../types/Resource'
import { ExportService, createResourceArchiveSource, type ArchiveSource } from './ExportService'
import type { ResourceService } from './ResourceService'
import type { ResourceListSummaryFilter } from '../storage/ResourceStorageAdapter'
import { writeArchiveEntries, type ArchiveEncoding } from './ArchiveZipWriter'

function resource(id: string, content = JSON.stringify({ id })): Resource {
  const blob = new Blob([content], { type: 'application/json' })
  return {
    id,
    type: RESOURCE_TYPE.OTHER,
    name: id,
    description: '',
    fileName: `${id}.json`,
    mimeType: blob.type,
    fileSize: blob.size,
    contentHash: `fixture-${id}`,
    favorite: false,
    categoryId: null,
    tags: [],
    metadata: {},
    originalBlob: blob,
    createdAt: 1,
    updatedAt: 1,
  }
}
function personaRows(count: number) {
  const personas = Array.from({ length: count }, (_, i): Resource => ({
    ...resource(`persona-${i}`),
    type: RESOURCE_TYPE.USER_PERSONA,
    relatedResourceIds: [`avatar-${i}`, 'notes'],
  }))
  const avatars = Array.from({ length: count }, (_, i): Resource => ({
    ...resource(`avatar-${i}`),
    metadata: { assetKind: 'userPersonaAvatar', avatarId: `avatar-${i}` },
  }))
  const rows = [
    ...personas,
    ...avatars,
    resource('notes'),
    { ...resource('unselected-chat'), type: RESOURCE_TYPE.CHAT },
  ]
  let reads = 0
  const counted = rows.map((row) => ({
    ...row,
    get id() {
      reads++
      return row.id
    },
  }))
  return { personas, avatars, rows, counted, reads: () => reads }
}
function countedSource(rows: Resource[]) {
  const byId = new Map(rows.map((row) => [row.id, row]))
  let idReads = 0
  const summaries = rows.map((row) => ({
    ...row,
    get id() {
      idReads++
      return row.id
    },
  }))
  const read = vi.fn(async (planned: ResourceSummary) => {
    const result = byId.get(planned.id)
    if (!result) throw new Error('Missing fixture resource')
    return result
  })
  const source: ArchiveSource = { resources: summaries, versions: [], read }
  return { source, read, idReads: () => idReads }
}
function replacementCard(id: string): Resource {
  const card = { spec: 'chara_card_v3', data: { name: id, first_mes: 'original' } }
  return {
    ...resource(id, JSON.stringify(card)),
    type: RESOURCE_TYPE.CHARACTER_CARD,
    metadata: { card, characterOverrides: { worldBookResourceId: 'lore' } },
  }
}
async function unpack(blob: Blob) {
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()))
  const manifest = JSON.parse(strFromU8(files['manifest.json']!)) as ArchiveManifest
  return { files, manifest }
}

describe('archive preparation repeated work', () => {
  it.each(['full', 'partial-default', 'partial-all'] as const)(
    'does not expand dependencies already included by %s selection',
    async (mode) => {
      const test = personaRows(100),
        expand = vi.spyOn(ResourceTypes, 'includeChatCompanionIds')
      try {
        const archives = await new ExportService().createArchives(test.counted, [], {
          mode: mode === 'full' ? 'full' : 'partial',
          resourceIds: mode === 'partial-all' ? test.rows.map((row) => row.id) : undefined,
        })
        const { files, manifest } = await unpack(archives[0]!.blob)
        expect(manifest.resources.map((row) => row.id)).toEqual(test.rows.map((row) => row.id))
        const originals = new Map(test.rows.map((row) => [row.id, row.originalBlob]))
        for (const row of manifest.resources)
          expect(strFromU8(files[row.archivePath]!)).toBe(await originals.get(row.id)!.text())
        expect(expand.mock.calls.length).toBe(0)
        expect(test.reads()).toBeLessThanOrEqual(test.rows.length * 30)
      } finally {
        expand.mockRestore()
      }
    },
  )

  it('finds only selected personas avatars with linear catalogue work and retains original ordering', async () => {
    const test = personaRows(250)
    const [archive] = await new ExportService().createArchives(test.counted, [], {
      mode: 'partial',
      resourceIds: test.personas.map((row) => row.id),
    })
    const { files, manifest } = await unpack(archive!.blob)
    expect(manifest.resources.map((row) => row.id)).toEqual(
      [...test.personas, ...test.avatars].map((row) => row.id),
    )
    for (const row of manifest.resources)
      expect(strFromU8(files[row.archivePath]!)).toBe(JSON.stringify({ id: row.id }))
    expect(test.reads()).toBeLessThanOrEqual(test.rows.length * 30)
  })

  it('plans referenced persona avatars without scanning the companion catalogue per persona', async () => {
    const test = personaRows(150),
      summaries = test.rows.map(ResourceTypes.toResourceListSummary)
    let idReads = 0
    const rows = summaries.map((row) => ({
      ...row,
      get id() {
        idReads++
        return row.id
      },
    }))
    const list = vi.fn(async (filter?: ResourceListSummaryFilter) => {
      const ids = filter?.ids ? new Set(filter.ids) : undefined
      return rows.filter((row) =>
        ids ? ids.has(row.id) : filter?.types ? filter.types.includes(row.type) : true,
      )
    })
    const history = vi.fn(async (_ids: string[]) => []),
      get = vi.fn(async () => {
        throw Error('Original must stay lazy')
      })
    const service = {
      listResourceListSummaries: list,
      listVersionSummariesForResources: history,
      get,
    } as unknown as ResourceService
    const result = await createResourceArchiveSource(
      service,
      test.personas.map((row) => row.id),
    )
    expect(result.resources.map((row) => row.id)).toEqual(
      [...test.personas, ...test.avatars].map((row) => row.id),
    )
    expect(new Set(history.mock.calls[0]![0])).toEqual(
      new Set(result.resources.map((row) => row.id)),
    )
    expect(get).not.toHaveBeenCalled()
    expect(list).toHaveBeenCalledTimes(3)
    expect(idReads).toBeLessThanOrEqual(rows.length * 20)
  })

  it('keeps eager descriptor updates in their first matching current/history slots', async () => {
    const first = { ...resource('duplicate', 'first'), fileName: 'a.json' }
    const second = { ...resource('duplicate', 'second'), fileName: 'b.json' }
    const history = {
      ...resource('duplicate', 'old'),
      fileName: 'old.json',
      versionGroupId: 'duplicate',
    }
    const [archive] = await new ExportService().createArchives(
      [first, second],
      [],
      { mode: 'full' },
      [history],
    )
    expect(archive!.manifest.resources.map((row) => row.fileName)).toEqual(['b.json', 'b.json'])
    expect(archive!.manifest.versions?.map((row) => row.fileName)).toEqual(['old.json'])
  })

  it('preserves companion ordering for history queries and accepts a later matching avatar with a duplicate ID', async () => {
    const p0: Resource = {
      ...resource('p0'),
      type: RESOURCE_TYPE.USER_PERSONA,
      relatedResourceIds: ['z', 'a', 'missing'],
    }
    const p1: Resource = {
      ...resource('p1'),
      type: RESOURCE_TYPE.USER_PERSONA,
      relatedResourceIds: ['b'],
    }
    const avatar = (id: string): Resource => ({
      ...resource(id),
      metadata: { assetKind: 'userPersonaAvatar' },
    })
    const rows = [p0, p1, resource('a'), avatar('b'), avatar('z'), avatar('a')].map(
      ResourceTypes.toResourceListSummary,
    )
    const history = vi.fn(async (_ids: string[]) => [])
    const service = {
      listResourceListSummaries: async (filter?: ResourceListSummaryFilter) => {
        const ids = filter?.ids ? new Set(filter.ids) : undefined
        return rows.filter((row) => (ids ? ids.has(row.id) : filter?.types?.includes(row.type)))
      },
      listVersionSummariesForResources: history,
    } as unknown as ResourceService
    const result = await createResourceArchiveSource(service, ['p1', 'p0'])
    expect(result.resources.map((row) => row.id)).toEqual(['p0', 'p1', 'a', 'b', 'z'])
    expect(result.resources.find((row) => row.id === 'a')!.metadata.assetKind).toBe(
      'userPersonaAvatar',
    )
    expect(history.mock.calls[0]![0]).toEqual(['p1', 'p0', 'z', 'a', 'b'])
  })

  it.each(['full', 'partial'] as const)(
    'keeps gallery and private-resource filtering when %s already includes every remaining row',
    async (mode) => {
      const persona: Resource = {
        ...resource('persona'),
        type: RESOURCE_TYPE.USER_PERSONA,
        relatedResourceIds: ['avatar'],
        metadata: { resourceCoverId: 'cover' },
      }
      const avatar = { ...resource('avatar'), metadata: { assetKind: 'userPersonaAvatar' } }
      const gallery = (id: string, owner: string): Resource => ({
        ...resource(id),
        metadata: {
          assetKind: 'resource-gallery-image',
          galleryOwnerId: owner,
          galleryVisible: false,
        },
      })
      const rows = [
        persona,
        avatar,
        { ...resource('secret'), type: RESOURCE_TYPE.SECRET },
        gallery('cover', 'persona'),
        gallery('hidden', 'persona'),
        gallery('excluded-owner', 'secret'),
        gallery('orphan', 'missing'),
      ]
      const [archive] = await new ExportService().createArchives(rows, [], {
        mode,
        personalResources: { secret: false },
        portableSelection: { resourceGallery: false },
      })
      expect(archive!.manifest.resources.map((row) => row.id)).toEqual([
        'persona',
        'avatar',
        'cover',
      ])
    },
  )

  it('does not allocate a separate empty Blob for every current and historical summary', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => resource(`resource-${i}`))
    const versions = Array.from({ length: 500 }, (_, i) => ({
      ...resource(`history-${i}`),
      versionGroupId: rows[i]!.id,
    }))
    const byId = new Map([...rows, ...versions].map((row) => [row.id, row]))
    const read = vi.fn(async (planned: ResourceSummary) => byId.get(planned.id)!)
    const NativeBlob = globalThis.Blob
    let emptyAllocations = 0,
      atEncode = 0
    const files = new Map<string, Blob>()
    vi.stubGlobal(
      'Blob',
      new Proxy(NativeBlob, {
        construct(target, args, newTarget) {
          if (!args[0] || args[0].length === 0) emptyAllocations++
          return Reflect.construct(target, args, newTarget)
        },
      }),
    )
    try {
      await new ExportService().createArchivesFromSource(
        { resources: rows, versions, read },
        [],
        { mode: 'full' },
        async () => ({
          encode: async (encoding) => {
            atEncode = emptyAllocations
            let bytes = 0
            await writeArchiveEntries(encoding, {
              write: async (path, blob) => {
                files.set(path, blob)
                bytes += blob.size
              },
            })
            return bytes
          },
          write: async () => undefined,
          commit: async () => undefined,
          abort: async () => undefined,
        }),
      )
      expect(read).toHaveBeenCalledTimes(rows.length + versions.length)
      const manifest = JSON.parse(await files.get('manifest.json')!.text()) as ArchiveManifest
      expect(manifest.resourceCount).toBe(rows.length)
      expect(manifest.versionCount).toBe(versions.length)
      for (const entry of [...manifest.resources, ...(manifest.versions ?? [])])
        expect(await files.get(entry.archivePath)!.text()).toBe(
          await byId.get(entry.id)!.originalBlob.text(),
        )
      expect(atEncode).toBeLessThanOrEqual(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not search the source catalogue for absent replacement IDs', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => resource(`resource-${i}`))
    const test = countedSource(rows)
    const [archive] = await new ExportService().createArchivesFromSource(test.source, [], {
      mode: 'full',
      resourceContent: 'modified',
    })
    const { files, manifest } = await unpack(archive!.blob)
    expect(manifest.resourceCount).toBe(rows.length)
    expect(test.read).toHaveBeenCalledTimes(rows.length)
    for (const entry of manifest.resources)
      expect(strFromU8(files[entry.archivePath]!)).toBe(
        await rows.find((row) => row.id === entry.id)!.originalBlob.text(),
      )
    expect(test.idReads()).toBeLessThanOrEqual(rows.length * 12)
  })

  it('reuses replacement summaries across split archives, still reading and validating each use', async () => {
    const cards = Array.from({ length: 50 }, (_, i) => {
      const id = `card-${i}`,
        card = {
          spec: 'chara_card_v3',
          data: { name: id, first_mes: 'original', alternate_greetings: [] },
        }
      return {
        ...resource(id, JSON.stringify(card)),
        type: RESOURCE_TYPE.CHARACTER_CARD,
        metadata: {
          card,
          characterOverrides: { worldBookResourceId: 'lore', greetingResourceId: 'opening' },
        },
      }
    })
    const lore = {
      ...resource('lore', JSON.stringify({ entries: [{ key: ['new'], content: 'replacement' }] })),
      type: RESOURCE_TYPE.WORLD_BOOK,
    }
    const opening = resource(
      'opening',
      JSON.stringify({ first_mes: 'replacement opening', alternate_greetings: ['alternative'] }),
    )
    const rows = [
      ...cards,
      ...Array.from({ length: 500 }, (_, i) => resource(`other-${i}`)),
      lore,
      opening,
    ]
    const test = countedSource(rows)
    const archives = await new ExportService().createArchivesFromSource(test.source, [], {
      mode: 'partial',
      resourceIds: cards.map((row) => row.id),
      resourceContent: 'modified',
      splitSizeBytes: cards[0]!.fileSize * 5,
    })
    expect(archives.length).toBeGreaterThan(1)
    let cardCount = 0
    for (const archive of archives) {
      const { files, manifest } = await unpack(archive.blob)
      for (const entry of manifest.resources) {
        const modified = JSON.parse(strFromU8(files[entry.archivePath]!))
        expect(modified.data.name).toBe(entry.id)
        expect(modified.data.first_mes).toBe('replacement opening')
        expect(modified.data.alternate_greetings).toEqual(['alternative'])
        expect(modified.data.character_book.entries[0].content).toBe('replacement')
        cardCount++
      }
    }
    expect(cardCount).toBe(cards.length)
    expect(test.read).toHaveBeenCalledTimes(cards.length * 3)
    expect(test.read.mock.calls.filter(([planned]) => planned.id === 'lore')).toHaveLength(
      cards.length,
    )
    expect(test.read.mock.calls.filter(([planned]) => planned.id === 'opening')).toHaveLength(
      cards.length,
    )
    expect(test.idReads()).toBeLessThanOrEqual(rows.length * 20)
  })

  it('assigns histories to split groups in one pass, preserving input order and excluding orphans', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => resource(`resource-${i}`))
    let membershipReads = 0
    const history = Array.from({ length: 1000 }, (_, i) => ({
      ...resource(`history-${i}`),
      get versionGroupId() {
        membershipReads++
        return rows[i % rows.length]!.id
      },
    }))
    const orphans = [
      resource('undefined-owner'),
      { ...resource('empty-owner'), versionGroupId: '' },
      { ...resource('missing-owner'), versionGroupId: 'missing' },
    ]
    const archives = await new ExportService().createArchives(
      rows,
      [],
      { mode: 'full', splitSizeBytes: 50 },
      [...history, ...orphans],
    )
    expect(archives.length).toBeGreaterThan(10)
    let total = 0
    for (const archive of archives) {
      const { manifest, files } = await unpack(archive.blob)
      const selected = new Set(manifest.resources.map((row) => row.id))
      const expected = history
        .filter((_, i) => selected.has(rows[i % rows.length]!.id))
        .map((row) => row.id)
      expect(manifest.versions?.map((row) => row.id)).toEqual(expected)
      for (const entry of manifest.versions ?? [])
        expect(strFromU8(files[entry.archivePath]!)).toBe(JSON.stringify({ id: entry.id }))
      total += manifest.versionCount ?? 0
    }
    expect(total).toBe(history.length)
    expect(membershipReads).toBeLessThanOrEqual((rows.length + history.length) * 12)
  })

  it('keeps duplicate owner IDs present in separate parts attached to their histories', async () => {
    const rows = [resource('duplicate'), resource('middle'), resource('duplicate')]
    const history = [{ ...resource('history'), versionGroupId: 'duplicate' }]
    const archives = await new ExportService().createArchives(
      rows,
      [],
      { mode: 'full', splitSizeBytes: 1 },
      history,
    )
    expect(archives).toHaveLength(3)
    expect(archives.map((archive) => archive.manifest.versions?.map((row) => row.id))).toEqual([
      ['history'],
      [],
      ['history'],
    ])
  })

  it.each(['contentHash', 'updatedAt'] as const)(
    'does not reuse a loaded replacement after its %s changes in a later part',
    async (changed) => {
      const cards = [replacementCard('first'), replacementCard('second')]
      const lore = {
        ...resource(
          'lore',
          JSON.stringify({ entries: [{ key: ['key'], content: 'replacement' }] }),
        ),
        type: RESOURCE_TYPE.WORLD_BOOK,
      }
      const test = countedSource([...cards, lore])
      let reads = 0
      test.read.mockImplementation(async (planned) => {
        if (planned.id !== 'lore') return cards.find((row) => row.id === planned.id)!
        reads++
        return reads === 1
          ? lore
          : { ...lore, [changed]: changed === 'contentHash' ? 'changed' : 3 }
      })
      await expect(
        new ExportService().createArchivesFromSource(test.source, [], {
          mode: 'partial',
          resourceIds: cards.map((row) => row.id),
          resourceContent: 'modified',
          splitSizeBytes: 1,
        }),
      ).rejects.toThrow('导出关联资源已变化：lore.json')
      expect(reads).toBe(2)
    },
  )

  it('keeps the first matching replacement description and reports a missing replacement', async () => {
    const card = replacementCard('card')
    const lore = {
      ...resource(
        'lore',
        JSON.stringify({ entries: [{ key: ['key'], content: 'first replacement' }] }),
      ),
      type: RESOURCE_TYPE.WORLD_BOOK,
    }
    const duplicate = { ...lore, updatedAt: 9 }
    const read = vi.fn(async (planned: ResourceSummary) => {
      if (planned.id === 'card') return card
      expect(planned.updatedAt).toBe(lore.updatedAt)
      return lore
    })
    const options = {
      mode: 'partial' as const,
      resourceIds: ['card'],
      resourceContent: 'modified' as const,
    }
    const [archive] = await new ExportService().createArchivesFromSource(
      { resources: [card, lore, duplicate], versions: [], read },
      [],
      options,
    )
    const { manifest, files } = await unpack(archive!.blob)
    expect(
      JSON.parse(strFromU8(files[manifest.resources[0]!.archivePath]!)).data.character_book
        .entries[0].content,
    ).toBe('first replacement')
    await expect(
      new ExportService().createArchivesFromSource(
        { resources: [card], versions: [], read },
        [],
        options,
      ),
    ).rejects.toThrow('绑定的替换世界书已不存在')
  })

  it('keeps a single card export from indexing unrelated summaries when its replacements are near the front', async () => {
    const card = replacementCard('card')
    card.metadata.characterOverrides = {
      worldBookResourceId: 'lore',
      greetingResourceId: 'opening',
    }
    const lore = {
      ...resource('lore', JSON.stringify({ entries: [{ key: ['key'], content: 'replacement' }] })),
      type: RESOURCE_TYPE.WORLD_BOOK,
    }
    const opening = resource('opening', JSON.stringify({ first_mes: 'replacement opening' }))
    const rows = [
      lore,
      opening,
      ...Array.from({ length: 1000 }, (_, i) => resource(`other-${i}`)),
      card,
    ]
    const test = countedSource(rows)
    const [archive] = await new ExportService().createArchivesFromSource(test.source, [], {
      mode: 'partial',
      resourceIds: ['card'],
      resourceContent: 'modified',
    })
    const { files, manifest } = await unpack(archive!.blob)
    const modified = JSON.parse(strFromU8(files[manifest.resources[0]!.archivePath]!))
    expect(modified.data.first_mes).toBe('replacement opening')
    expect(modified.data.character_book.entries[0].content).toBe('replacement')
    expect(test.read).toHaveBeenCalledTimes(3)
    expect(test.idReads()).toBeLessThanOrEqual(rows.length + 20)
  })

  it('indexes a batch with many distinct replacement IDs instead of repeating full searches', async () => {
    const cards = Array.from({ length: 20 }, (_, i) => {
      const card = replacementCard(`card-${i}`)
      card.metadata.characterOverrides = { worldBookResourceId: `lore-${i}` }
      return card
    })
    const lore = cards.map((_, i) => ({
      ...resource(
        `lore-${i}`,
        JSON.stringify({ entries: [{ key: ['key'], content: `replacement-${i}` }] }),
      ),
      type: RESOURCE_TYPE.WORLD_BOOK,
    }))
    const rows = [
      ...cards,
      ...Array.from({ length: 1000 }, (_, i) => resource(`other-${i}`)),
      ...lore,
    ]
    const test = countedSource(rows)
    const [archive] = await new ExportService().createArchivesFromSource(test.source, [], {
      mode: 'partial',
      resourceIds: cards.map((row) => row.id),
      resourceContent: 'modified',
    })
    const { files, manifest } = await unpack(archive!.blob)
    for (const [i, entry] of manifest.resources.entries())
      expect(
        JSON.parse(strFromU8(files[entry.archivePath]!)).data.character_book.entries[0].content,
      ).toBe(`replacement-${i}`)
    expect(test.read).toHaveBeenCalledTimes(cards.length * 2)
    expect(test.idReads()).toBeLessThanOrEqual(rows.length * 8)
  })

  it.each([false, true])(
    'keeps native encoding traversal and aborts changed replacements (changed=%s)',
    async (changed) => {
      const cards = [replacementCard('first'), replacementCard('second')]
      const lore = {
        ...resource(
          'lore',
          JSON.stringify({ entries: [{ key: ['key'], content: 'native replacement' }] }),
        ),
        type: RESOURCE_TYPE.WORLD_BOOK,
      }
      const versions = cards.map((row, i) => ({
        ...resource(`history-${i}`),
        versionGroupId: row.id,
      }))
      const byId = new Map([...cards, lore, ...versions].map((row) => [row.id, row]))
      let replacementReads = 0
      const read = vi.fn(async (planned: ResourceSummary) => {
        const row = byId.get(planned.id)!
        if (row.id !== 'lore') return row
        replacementReads++
        return changed && replacementReads > 1 ? { ...row, updatedAt: 5 } : row
      })
      const writers: Array<{
        entries: Map<string, Blob>
        encode: ReturnType<typeof vi.fn>
        write: ReturnType<typeof vi.fn>
        commit: ReturnType<typeof vi.fn>
        abort: ReturnType<typeof vi.fn>
      }> = []
      const operation = new ExportService().createArchivesFromSource(
        { resources: [...cards, lore], versions, read },
        [],
        {
          mode: 'partial',
          resourceIds: cards.map((row) => row.id),
          resourceContent: 'modified',
          splitSizeBytes: 1,
        },
        async () => {
          const entries = new Map<string, Blob>()
          const writer = {
            entries,
            encode: vi.fn(async (encoding: ArchiveEncoding) => {
              let bytes = 0
              await writeArchiveEntries(encoding, {
                write: async (path, blob) => {
                  entries.set(path, blob)
                  bytes += blob.size
                },
              })
              return bytes
            }),
            write: vi.fn(async () => undefined),
            commit: vi.fn(async () => undefined),
            abort: vi.fn(async () => undefined),
          }
          writers.push(writer)
          return writer
        },
      )
      if (changed) await expect(operation).rejects.toThrow('导出关联资源已变化')
      else {
        const result = await operation
        expect(result).toHaveLength(2)
        for (const [index, writer] of writers.entries()) {
          const manifest = JSON.parse(
            await writer.entries.get('manifest.json')!.text(),
          ) as ArchiveManifest
          expect(manifest.versions?.map((row) => row.id)).toEqual([`history-${index}`])
          const card = JSON.parse(
            await writer.entries.get(manifest.resources[0]!.archivePath)!.text(),
          )
          expect(card.data.character_book.entries[0].content).toBe('native replacement')
          expect(writer.commit).toHaveBeenCalledOnce()
          expect(writer.abort).not.toHaveBeenCalled()
        }
      }
      expect(replacementReads).toBe(2)
      expect(writers).toHaveLength(2)
      expect(writers[0]!.commit).toHaveBeenCalledOnce()
      if (changed) {
        expect(writers[1]!.abort).toHaveBeenCalledOnce()
        expect(writers[1]!.commit).not.toHaveBeenCalled()
      }
      for (const writer of writers) {
        expect(writer.encode).toHaveBeenCalledOnce()
        expect(writer.write).not.toHaveBeenCalled()
      }
    },
  )
})
