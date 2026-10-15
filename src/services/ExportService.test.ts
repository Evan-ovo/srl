import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'

import { ARCHIVE_FORMAT, ARCHIVE_VERSION, type ArchiveManifest } from '../types/Backup'
import {
  normalizeResourceLinks,
  RESOURCE_LINK_TYPE,
  RESOURCE_TYPE,
  toResourceListSummary,
  type Category,
  type Resource,
} from '../types/Resource'
import { ExportService, createResourceArchiveSource } from './ExportService'
import type { ResourceService } from './ResourceService'

function createResource(id: string, categoryId: string | null, content: string): Resource {
  const now = Date.now()
  return {
    id,
    type: RESOURCE_TYPE.WORLD_BOOK,
    name: id,
    description: '',
    fileName: `${id}.json`,
    mimeType: 'application/json',
    fileSize: content.length,
    contentHash: `hash-${id}`,
    favorite: false,
    categoryId,
    tags: ['测试'],
    metadata: { format: 'json' },
    originalBlob: new Blob([content]),
    createdAt: now,
    updatedAt: now,
  }
}

const categories: Category[] = [
  {
    id: 'lore',
    name: '设定',
    color: '#486b5d',
    hidden: true,
    createdAt: 1,
    updatedAt: 1,
  },
  { id: 'unused', name: '空分类', color: '#8a6a47', createdAt: 2, updatedAt: 2 },
]

describe('ExportService', () => {
  it('plans selected chat companions and persona avatars without a full catalogue or originals', async () => {
    const chat = {
      ...createResource('chat', null, 'chat'),
      type: RESOURCE_TYPE.CHAT,
      relatedResourceIds: ['card', 'unrelated'],
      metadata: { chatDisplayRegexId: 'regex', chatReadingScriptId: 'script' },
    }
    const persona = {
      ...createResource('persona', null, 'persona'),
      type: RESOURCE_TYPE.USER_PERSONA,
      relatedResourceIds: ['avatar', 'unrelated'],
    }
    const rows = [
      chat,
      persona,
      { ...createResource('card', null, 'card'), type: RESOURCE_TYPE.CHARACTER_CARD },
      { ...createResource('regex', null, 'regex'), type: RESOURCE_TYPE.REGEX },
      { ...createResource('script', null, 'script'), type: RESOURCE_TYPE.SCRIPT },
      {
        ...createResource('avatar', null, 'avatar'),
        type: RESOURCE_TYPE.OTHER,
        metadata: { assetKind: 'userPersonaAvatar' },
      },
      {
        ...createResource('gallery', null, 'gallery'),
        type: RESOURCE_TYPE.OTHER,
        metadata: { assetKind: 'resource-gallery-image', galleryOwnerId: 'card' },
      },
      createResource('unrelated', null, 'unrelated'),
    ]
    const summaries = rows.map(toResourceListSummary)
    const list = vi.fn(async (filter) =>
      summaries.filter((r) =>
        filter.ids ? filter.ids.includes(r.id) : filter.types.includes(r.type),
      ),
    )
    const history = vi.fn(async (_ids: string[]) => [])
    const service = {
      listResourceListSummaries: list,
      listVersionSummariesForResources: history,
    } as unknown as ResourceService
    const plan = await createResourceArchiveSource(service, ['chat', 'persona'])
    expect(plan.resources.map((r) => r.id).sort()).toEqual([
      'avatar',
      'card',
      'chat',
      'gallery',
      'persona',
      'regex',
      'script',
    ])
    expect(list.mock.calls.every(([filter]) => filter.ids || filter.types)).toBe(true)
    expect(history.mock.calls[0]?.[0].sort()).toEqual(plan.resources.map((r) => r.id).sort())
  })
  it('exports a selected chat with its bound card and hidden display regex, excluding unrelated resources', async () => {
    const chat = {
      ...createResource('chat', null, '{"mes":"rain"}'),
      type: RESOURCE_TYPE.CHAT,
      relatedResourceIds: ['card'],
      metadata: { chatDisplayRegexId: 'regex' },
    }
    const card = { ...createResource('card', null, 'card'), type: RESOURCE_TYPE.CHARACTER_CARD }
    const regex = { ...createResource('regex', null, 'regex'), type: RESOURCE_TYPE.REGEX }
    const result = await new ExportService().createArchive(
      [chat, card, regex, createResource('other', null, 'x')],
      [],
      { mode: 'partial', resourceIds: ['chat'] },
    )
    expect(result.manifest.resources.map((item) => item.id).sort()).toEqual([
      'card',
      'chat',
      'regex',
    ])
    expect(
      result.manifest.resources.find((item) => item.id === 'chat')?.metadata.chatDisplayRegexId,
    ).toBe('regex')
  })
  it('streams archive output to a writer without materializing resource arrayBuffers', async () => {
    const resource = createResource('streamed', null, '正文'.repeat(200_000))
    Object.defineProperty(resource.originalBlob, 'arrayBuffer', {
      value: () => Promise.reject(new Error('whole arrayBuffer is forbidden')),
    })
    const chunks: Uint8Array[] = []
    let committed = false

    const result = await new ExportService().createArchivesToSinks(
      [resource],
      [],
      { mode: 'full' },
      [],
      async () => ({
        write: async (chunk) => {
          chunks.push(chunk)
        },
        commit: async () => {
          committed = true
        },
        abort: async () => undefined,
      }),
    )

    const archiveBytes = new Blob(chunks.map((chunk) => chunk.slice().buffer))
    const files = unzipSync(new Uint8Array(await archiveBytes.arrayBuffer()))
    expect(committed).toBe(true)
    expect(result[0]?.bytes).toBe(archiveBytes.size)
    expect(strFromU8(files[result[0]!.manifest.resources[0]!.archivePath]!)).toBe(
      '正文'.repeat(200_000),
    )
  })

  it('creates a complete archive with manifest and original files', async () => {
    const resources = [
      createResource('atlas', 'lore', '{"name":"Atlas"}'),
      createResource('notes', null, '{"name":"Notes"}'),
    ]
    resources[0]!.sourceLinks = [
      {
        id: 'discord-post',
        label: '作者 DC 原帖',
        url: 'https://discord.gg/example',
        type: RESOURCE_LINK_TYPE.DISCORD,
        note: '首发社区',
        createdAt: 1,
      },
    ]

    const archive = await new ExportService().createArchive(resources, categories, { mode: 'full' })
    const files = unzipSync(new Uint8Array(await archive.blob.arrayBuffer()))
    const manifest = JSON.parse(strFromU8(files['manifest.json']!)) as ArchiveManifest

    expect(manifest.format).toBe(ARCHIVE_FORMAT)
    expect(manifest.version).toBe(ARCHIVE_VERSION)
    expect(manifest.resourceCount).toBe(2)
    expect(manifest.categoryCount).toBe(2)
    expect(Object.keys(files)).toHaveLength(3)
    const atlas = manifest.resources.find((resource) => resource.id === 'atlas')
    expect(strFromU8(files[atlas!.archivePath]!)).toBe('{"name":"Atlas"}')
    expect(atlas?.sourceLinks).toEqual(normalizeResourceLinks(resources[0]!.sourceLinks))
  })

  it('keeps the imported character file in original mode and applies overrides in modified mode', async () => {
    const source = JSON.stringify({
      spec: 'chara_card_v3',
      data: {
        name: 'Atlas',
        first_mes: '原开场',
        alternate_greetings: [],
        character_book: { entries: [{ key: ['old'], content: '原世界书' }] },
        extensions: {
          regex_scripts: [{ id: 'rule-1', scriptName: '状态栏', disabled: true }],
        },
      },
    })
    const character = createResource('character', null, source)
    character.type = RESOURCE_TYPE.CHARACTER_CARD
    character.metadata = {
      format: 'json',
      card: JSON.parse(source),
      characterOverrides: {
        regexEnabled: { 'id:rule-1': true },
        worldBookResourceId: 'lore',
        greetingResourceId: 'opening',
      },
    }
    character.relatedResourceIds = ['lore', 'opening']
    const lore = createResource(
      'lore',
      null,
      JSON.stringify({ entries: [{ key: ['new'], content: '替换世界书' }] }),
    )
    const opening = createResource(
      'opening',
      null,
      JSON.stringify({ first_mes: '替换开场', alternate_greetings: ['备用开场'] }),
    )

    const originalArchive = await new ExportService().createArchive(
      [character, lore, opening],
      [],
      { mode: 'full', resourceContent: 'original' },
    )
    const originalFiles = unzipSync(new Uint8Array(await originalArchive.blob.arrayBuffer()))
    const originalEntry = originalArchive.manifest.resources.find(
      (resource) => resource.id === character.id,
    )
    expect(strFromU8(originalFiles[originalEntry!.archivePath]!)).toBe(source)
    expect(originalArchive.manifest.resourceContent).toBe('original')

    const modifiedArchive = await new ExportService().createArchive(
      [character, lore, opening],
      [],
      { mode: 'full', resourceContent: 'modified' },
    )
    const modifiedFiles = unzipSync(new Uint8Array(await modifiedArchive.blob.arrayBuffer()))
    const modifiedEntry = modifiedArchive.manifest.resources.find(
      (resource) => resource.id === character.id,
    )
    const modifiedCard = JSON.parse(strFromU8(modifiedFiles[modifiedEntry!.archivePath]!))
    expect(modifiedCard.data.first_mes).toBe('替换开场')
    expect(modifiedCard.data.alternate_greetings).toEqual(['备用开场'])
    expect(modifiedCard.data.character_book.entries[0].content).toBe('替换世界书')
    expect(modifiedCard.data.extensions.regex_scripts[0].disabled).toBe(false)
    expect(modifiedArchive.manifest.resourceContent).toBe('modified')
  })

  it('creates a partial archive with selected resources and referenced categories', async () => {
    const resources = [
      createResource('atlas', 'lore', '{"name":"Atlas"}'),
      createResource('notes', null, '{"name":"Notes"}'),
    ]

    const archive = await new ExportService().createArchive(resources, categories, {
      mode: 'partial',
      resourceIds: ['atlas'],
      includeAllCategories: false,
    })
    const manifest = archive.manifest

    expect(manifest.resources.map((resource) => resource.id)).toEqual(['atlas'])
    expect(manifest.categories.map((category) => category.id)).toEqual(['lore'])
    expect(manifest.categories[0]?.hidden).toBe(true)
    expect(archive.fileName).toContain('分包')
  })

  it('includes only the selected persona avatar attachment and keeps it in the same split', async () => {
    const persona = createResource('persona', null, '{"personas":{}}')
    persona.type = RESOURCE_TYPE.USER_PERSONA
    persona.relatedResourceIds = ['avatar-alice']
    const avatar = createResource('avatar-alice', null, 'avatar-bytes')
    avatar.type = RESOURCE_TYPE.OTHER
    avatar.fileName = 'alice.png'
    avatar.mimeType = 'image/png'
    avatar.metadata = { assetKind: 'userPersonaAvatar', avatarId: 'alice.png' }
    avatar.relatedResourceIds = [persona.id]
    const unrelatedAvatar = createResource('avatar-other', null, 'other-avatar')
    unrelatedAvatar.type = RESOURCE_TYPE.OTHER
    unrelatedAvatar.fileName = 'other.png'
    unrelatedAvatar.mimeType = 'image/png'
    unrelatedAvatar.metadata = { assetKind: 'userPersonaAvatar', avatarId: 'other.png' }
    const notes = createResource('notes', null, '{"notes":true}')

    const archives = await new ExportService().createArchives(
      [persona, avatar, unrelatedAvatar, notes],
      [],
      {
        mode: 'partial',
        resourceIds: [persona.id, notes.id],
        splitSizeBytes: persona.fileSize + avatar.fileSize,
      },
    )

    const exportedIds = archives.flatMap((archive) =>
      archive.manifest.resources.map((resource) => resource.id),
    )
    expect(exportedIds).toEqual(['persona', 'avatar-alice', 'notes'])
    const personaArchive = archives.find((archive) =>
      archive.manifest.resources.some((resource) => resource.id === persona.id),
    )
    expect(personaArchive?.manifest.resources.map((resource) => resource.id)).toEqual([
      'persona',
      'avatar-alice',
    ])
    expect(
      personaArchive?.manifest.resources.find((resource) => resource.id === persona.id)
        ?.relatedResourceIds,
    ).toEqual(['avatar-alice'])
  })

  it('preserves multiple folders and only keeps relations included in the archive', async () => {
    const atlas = createResource('atlas', 'lore', '{"name":"Atlas"}')
    atlas.categoryIds = ['lore', 'unused']
    atlas.relatedResourceIds = ['notes']
    const notes = createResource('notes', null, '{"name":"Notes"}')
    notes.relatedResourceIds = ['atlas']

    const full = await new ExportService().createArchive([atlas, notes], categories, {
      mode: 'full',
    })
    expect(full.manifest.resources.find((resource) => resource.id === 'atlas')).toMatchObject({
      categoryIds: ['lore', 'unused'],
      relatedResourceIds: ['notes'],
    })

    const partial = await new ExportService().createArchive([atlas, notes], categories, {
      mode: 'partial',
      resourceIds: ['atlas'],
      includeAllCategories: false,
    })
    expect(partial.manifest.categories.map((category) => category.id)).toEqual(['lore', 'unused'])
    expect(partial.manifest.resources[0]?.relatedResourceIds).toEqual([])
  })

  it('rejects an empty partial archive', async () => {
    await expect(
      new ExportService().createArchive([], categories, {
        mode: 'partial',
        resourceIds: [],
      }),
    ).rejects.toThrow('请至少选择一项资源')
  })

  it('creates independently restorable split archives', async () => {
    const resources = [
      createResource('atlas', 'lore', '{"name":"Atlas"}'),
      createResource('notes', null, '{"name":"Notes"}'),
    ]

    const archives = await new ExportService().createArchives(resources, categories, {
      mode: 'full',
      splitSizeBytes: 20,
    })

    expect(archives).toHaveLength(2)
    expect(archives[0]?.fileName).toContain('第01卷-共02卷')
    expect(archives[1]?.fileName).toContain('第02卷-共02卷')
    expect(archives.flatMap((archive) => archive.manifest.resources.map(({ id }) => id))).toEqual([
      'atlas',
      'notes',
    ])
    for (const archive of archives) {
      const files = unzipSync(new Uint8Array(await archive.blob.arrayBuffer()))
      expect(files['manifest.json']).toBeDefined()
      expect(Object.keys(files)).toHaveLength(2)
    }
  })

  it('keeps an empty complete backup restorable when splitting is enabled', async () => {
    const archives = await new ExportService().createArchives([], categories, {
      mode: 'full',
      splitSizeBytes: 1024,
    })

    expect(archives).toHaveLength(1)
    expect(archives[0]?.manifest.resourceCount).toBe(0)
    expect(archives[0]?.manifest.categoryCount).toBe(categories.length)
  })

  it('stores selected portable app data in the versioned manifest', async () => {
    const portableData = {
      version: 1 as const,
      appearance: {
        theme: 'dark' as const,
        layoutMode: 'grid' as const,
        customCss: ':root { --test: 1; }',
        presets: [],
        activePresetId: '',
      },
      characterDraw: {
        state: { totalDraws: 2, totalSessions: 1, records: {}, history: [] },
        showNames: false,
      },
    }
    const archive = await new ExportService().createArchive([], [], {
      mode: 'full',
      portableData,
    })

    expect(archive.manifest.portableData).toEqual(portableData)
  })
})
