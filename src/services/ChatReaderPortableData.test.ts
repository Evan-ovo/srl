import { expect, it } from 'vitest'
import { remapReaderPortableData } from './ChatReaderPortableData'

it('keeps cabinet positions and saved workspace references on the restored resources after ID conflicts', () => {
  const draft = {
    baseId: 'old',
    name: 'saved draft',
    savedAt: 1,
    regexPickIds: ['old'],
    entries: [
      { origin: 'base' as const, identifier: 'prompt', enabled: true, sourceResourceId: 'old' },
    ],
    sourceEdits: [
      {
        sourceResourceId: 'old',
        identifier: 'prompt',
        name: 'saved',
        role: 'system',
        content: 'old is literal text',
      },
    ],
  }
  const data = {
    version: 1 as const,
    generalPreferences: {
      previewPolicy: { allowScripts: false, allowRemoteResources: false },
      extractCharacterAssets: false,
      hideCharacterAssets: true,
      searchHistory: ['old'],
      cabinetResourceIds: ['old', 'unchanged'],
      cabinetLayout: [
        {
          kind: 'resource' as const,
          id: 'old',
          slot: 0,
          columnSpan: 1 as const,
          rowSpan: 1 as const,
        },
        {
          kind: 'folder' as const,
          id: 'old-folder',
          slot: 1,
          columnSpan: 1 as const,
          rowSpan: 1 as const,
        },
      ],
    },
    stitchWork: { draft, checkpoint: draft, recentPresets: ['old'] },
    aiTaggingState: {
      undo: {
        version: 1 as const,
        appliedAt: 1,
        additions: [{ resourceId: 'old', resourceName: 'saved', tags: ['tag'] }],
      },
    },
  }
  const result = remapReaderPortableData(
    data,
    new Map([['old', 'new']]),
    new Map([['old-folder', 'new-folder']]),
  )!
  expect(result.generalPreferences?.cabinetResourceIds).toEqual(['new', 'unchanged'])
  expect(result.generalPreferences?.cabinetLayout?.map((entry) => entry.id)).toEqual([
    'new',
    'new-folder',
  ])
  expect(result.generalPreferences?.searchHistory).toEqual(['old'])
  expect(result.stitchWork?.draft).toMatchObject({
    baseId: 'new',
    regexPickIds: ['new'],
    entries: [{ sourceResourceId: 'new' }],
    sourceEdits: [{ sourceResourceId: 'new', content: 'old is literal text' }],
  })
  expect(result.stitchWork?.checkpoint?.baseId).toBe('new')
  expect(result.stitchWork?.recentPresets).toEqual(['new'])
  expect(result.aiTaggingState?.undo?.additions[0]?.resourceId).toBe('new')
  expect(data.stitchWork.draft.baseId).toBe('old')
})

it('remaps reader bookmarks, appearance and resume index when merge restore changes resource IDs', () => {
  const record = {
    appId: 'com.srl.duleme',
    id: 'old',
    updatedAt: 1,
    value: {
      marks: [{ floor: 7, reply: 2 }],
      regexSources: { preset: 'old-preset', character: 'kept' },
      scriptSources: ['old-script', 'kept-script'],
      scriptOverrides: { signature: true },
    },
  }
  const data = remapReaderPortableData(
    {
      version: 1,
      chatReader: [
        { ...record, key: 'chat:old-chat' },
        { ...record, key: 'appearance:old-card' },
        { ...record, key: 'reader-index-v1', value: { lastChat: 'old-chat' } },
      ],
    },
    new Map([
      ['old-chat', 'new-chat'],
      ['old-card', 'new-card'],
      ['old-preset', 'new-preset'],
      ['old-script', 'new-script'],
    ]),
  )!
  expect(data.chatReader?.map((item) => item.key)).toEqual([
    'chat:new-chat',
    'appearance:new-card',
    'reader-index-v1',
  ])
  expect(data.chatReader?.[0]?.value).toEqual({
    ...record.value,
    regexSources: { preset: 'new-preset', character: 'kept' },
    scriptSources: ['new-script', 'kept-script'],
  })
  expect(record.value.regexSources.preset).toBe('old-preset')
  expect(record.value.scriptSources).toEqual(['old-script', 'kept-script'])
  expect(data.chatReader?.[2]?.value).toEqual({ lastChat: 'new-chat' })
})
