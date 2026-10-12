import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppDatabase } from '../database/AppDatabase'
import { IndexedDbResourceStorage } from '../storage/IndexedDbResourceStorage'
import { ResourceParserRegistry } from '../parser/ResourceParser'
import { PngResourceParser } from '../parser/PngResourceParser'
import { JsonResourceParser } from '../parser/JsonResourceParser'
import { ChatResourceParser } from '../parser/ChatResourceParser'
import { ResourceService } from './ResourceService'
import { ChatReaderService } from './ChatReaderService'
import { createChatArchive, readChatArchive } from './TavernChatArchiveCodec.mjs'
import { resolveChatCharacter, chatCharacterThumbnail } from './ChatReaderCharacter'
import { ExternalAppSdkService } from './ExternalAppSdkService'
import { prepareChatReturn } from './TavernChatReturn'
import { hashBlob } from './HashService'
import { RESOURCE_TYPE, includeChatCompanionIds, toResourceListSummary } from '../types/Resource'
import * as nativeFiles from '../core/NativeFileSource'
import * as thumbnails from '../utils/createImageThumbnail'
import { chatReaderScripts } from './ChatReaderRendering'

vi.mock('../utils/createImageThumbnail', () => ({
  createImageThumbnail: async () => new Blob(['thumbnail'], { type: 'image/webp' }),
}))
const databases: AppDatabase[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) await db.delete()
})
function setup() {
  const db = new AppDatabase(`chat-transfer-${crypto.randomUUID()}`)
  databases.push(db)
  const storage = new IndexedDbResourceStorage(db)
  const resources = new ResourceService(
    storage,
    new ResourceParserRegistry([
      new PngResourceParser(),
      new ChatResourceParser(),
      new JsonResourceParser(),
    ]),
  )
  return { resources, storage, database: db }
}
function png(marker: string, scripts: unknown[] = []) {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      name: 'Same name',
      description: marker,
      first_mes: 'Hello',
      ...(scripts.length ? { extensions: { tavern_helper: { scripts } } } : {}),
    }),
  )
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 32768)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768))
  const data = new TextEncoder().encode('chara\0' + btoa(binary))
  const chunk = new Uint8Array(data.length + 12)
  new DataView(chunk.buffer).setUint32(0, data.length)
  chunk.set(new TextEncoder().encode('tEXt'), 4)
  chunk.set(data, 8)
  return new File(
    [
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk,
      new Uint8Array([0, 0, 0, 0, 73, 69, 78, 68, 0, 0, 0, 0]),
    ],
    `${marker}.png`,
    { type: 'image/png' },
  )
}
const raw =
  '\ufeff{"user_name":"旅人","character_name":"同名角色"}\r\n{"name":"角色","is_user":false,"mes":"{{user}} <status>原文</status>"}\r\n'
function archive(marker = 'a', text = raw) {
  return createChatArchive(png(marker), new File([text], '雨夜.jsonl'), `${marker}.png`)
}
describe('chat transfer to the canonical resource library', () => {
  it('resolves complete bound-card metadata without reading card or unrelated originals', async () => {
    const { resources, storage } = setup()
    await resources.importFiles([png('bound'), png('second')])
    const [card, second] = await resources.list()
    if (!card || !second) throw new Error('card fixture missing')
    await resources.importFiles([archive()])
    const chat = (await resources.list()).find((resource) => resource.type === RESOURCE_TYPE.CHAT)!
    const unrelated = { ...card, id: 'unrelated', type: RESOURCE_TYPE.OTHER }
    await storage.save(unrelated)
    const fullRead = vi.spyOn(resources, 'get').mockRejectedValue(new Error('original not needed'))
    const summaryRead = vi.spyOn(resources, 'getSummary')
    const linked = { ...chat, relatedResourceIds: [card.id, unrelated.id, 'missing'] }
    expect(await resolveChatCharacter(linked, resources)).toEqual({
      id: card.id,
      name: card.name,
      contentHash: card.contentHash,
      fileName: card.fileName,
      card: card.metadata.card,
    })
    expect(summaryRead.mock.calls.map(([id]) => id)).toEqual([card.id, unrelated.id, 'missing'])
    expect(fullRead).not.toHaveBeenCalled()
    await expect(
      resolveChatCharacter({ ...chat, relatedResourceIds: [card.id, second.id] }, resources),
    ).rejects.toThrow('明确绑定一张角色卡')
    // A missing/non-card link still uses the portable companion in the chat metadata.
    expect(
      (await resolveChatCharacter({ ...chat, relatedResourceIds: ['missing'] }, resources)).id,
    ).toMatch(/^chat-character:/)
    expect(fullRead).not.toHaveBeenCalled()
  })

  it('reuses batch summaries/card thumbnails among 1000 resources, but keeps newly imported duplicates visible', async () => {
    const { resources, database } = setup()
    await resources.importFiles([png('filler')])
    const template = (await resources.list())[0]!
    const storedFixture = await database.resources.get(template.id)
    if (!storedFixture) throw new Error('stored fixture missing')
    const fillers = Array.from({ length: 1000 }, (_, index) => ({
      ...template,
      id: 'filler-' + index,
      contentHash: index.toString(16).padStart(64, '0'),
    }))
    const summariesFixture = fillers.map(toResourceListSummary)
    // Seed existing records in one transaction; this regression measures chat
    // batch reads, rather than externalizing the same fixture thumbnail 1000 times.
    await database.transaction(
      'rw',
      [database.resources, database.resourceSummaries, database.resourceListSummaries],
      async () => {
        await database.resources.bulkPut(
          fillers.map(({ id, contentHash }) => ({ ...storedFixture, id, contentHash })),
        )
        await database.resourceSummaries.bulkPut(summariesFixture)
        await database.resourceListSummaries.bulkPut(summariesFixture)
      },
    )
    expect(await database.resourceListSummaries.count()).toBe(1001)
    const summaries = vi.spyOn(resources, 'listResourceListSummaries')
    const thumbnail = vi.spyOn(thumbnails, 'createImageThumbnail')
    const metadata = vi.spyOn(resources, 'updateMetadata')
    const results = await resources.importFiles([
      archive(),
      archive('a', raw.replace('原文', '新原文')),
      archive(),
    ])
    expect(results.map((result) => result.status)).toEqual(['imported', 'imported', 'duplicate'])
    expect(summaries).toHaveBeenCalledTimes(1)
    expect(thumbnail).toHaveBeenCalledTimes(1)
    expect(metadata).toHaveBeenCalledTimes(3)
    await resources.importFiles([archive()])
    expect(summaries).toHaveBeenCalledTimes(2)
    expect(thumbnail).toHaveBeenCalledTimes(2)
    const first = results[0]!
    if (first.status !== 'imported') throw new Error('chat import failed')
    const stored = await resources.get(first.resource.id)
    expect(new Uint8Array(await stored!.originalBlob.arrayBuffer())).toEqual(
      new TextEncoder().encode(raw),
    )
  }, 10000)

  it('imports a native shared chat package through the service entrypoint', async () => {
    const { resources } = setup()
    const bytes = archive()
    const placeholder = new File([], bytes.name)
    const read = vi.spyOn(nativeFiles, 'materializeNativeFile').mockResolvedValue(bytes)
    try {
      const [result] = await resources.importFiles([placeholder])
      expect(result?.status).toBe('imported')
      if (result?.status !== 'imported') throw new Error('chat import failed')
      expect(result.resource.type).toBe(RESOURCE_TYPE.CHAT)
      expect(result.resource.fileSize).toBeGreaterThan(0)
    } finally {
      read.mockRestore()
    }
  })
  it('uses the existing hash index among 500 cards and skips full metadata/version preparation for chat packages', async () => {
    const { resources, storage } = setup()
    await resources.importFiles([png('a')])
    const original = (await resources.list())[0]!
    await storage.saveMany(
      Array.from({ length: 500 }, (_, index) => ({
        ...original,
        id: `filler-${index}`,
        contentHash: String(index).padStart(64, '0'),
        metadata: { card: { description: 'x'.repeat(20000) } },
      })),
    )
    const summaryRead = vi.spyOn(storage, 'listSummaries')
    const versionRead = vi.spyOn(storage, 'listVersionSummaries')
    const hashRead = vi.spyOn(storage, 'findByHash')
    expect((await resources.findByContentHash(original.contentHash))?.id).toBe(original.id)
    expect(hashRead).toHaveBeenCalledWith(original.contentHash)
    await resources.importFiles([archive()])
    expect(summaryRead).not.toHaveBeenCalled()
    expect(versionRead).not.toHaveBeenCalled()
  }, 20_000)
  it('stores only a chat by default, keeping reading rules and a portable thumbnail without full card lore', async () => {
    const { resources } = setup()
    await resources.importFiles([archive(), archive()])
    const rows = await resources.list()
    expect(rows).toHaveLength(1)
    const chat = rows[0]!
    expect(chat.type).toBe(RESOURCE_TYPE.CHAT)
    expect(chat.relatedResourceIds).toEqual([])
    const role = await resolveChatCharacter(chat, resources)
    expect(role.id).toBe(`chat-character:${await hashBlob(png('a'))}`)
    expect(role.card).not.toHaveProperty('description')
    expect(await chatCharacterThumbnail(chat.metadata)?.text()).toBe('thumbnail')
    const apps = { get: async () => ({ enabled: true }), hasPermission: async () => true }
    const sdk = new ExternalAppSdkService(apps as never, resources)
    expect((await sdk.list('reader', { types: ['chat'] })).items[0]?.chatCharacter?.id).toBe(
      role.id,
    )
    expect(await (await sdk.thumbnail('reader', chat.id))?.text()).toBe('thumbnail')
    expect(await prepareChatReturn(chat, resources, undefined, false)).toMatchObject({
      avatar: 'a.png',
    })
  })
  it('reuses the explicitly saved companion card for three chats in the same batch', async () => {
    const { resources } = setup()
    const card = png('same-role')
    const hash = await hashBlob(card)
    const files = [1, 2, 3].map((index) =>
      createChatArchive(
        card,
        new File(
          [
            raw +
              '\n' +
              JSON.stringify({ name: 'Same name', is_user: false, mes: `message ${index}` }),
          ],
          `chat-${index}.jsonl`,
        ),
        'same-role.png',
      ),
    )
    const results = await resources.importFiles(files, {
      chatCharacterBindings: { [hash]: null },
      saveChatCharacterHashes: [hash],
    })
    expect(results.map((result) => result.status)).toEqual(['imported', 'imported', 'imported'])
    const rows = await resources.list()
    const cards = rows.filter((resource) => resource.type === RESOURCE_TYPE.CHARACTER_CARD)
    const chats = rows.filter((resource) => resource.type === RESOURCE_TYPE.CHAT)
    expect(cards).toHaveLength(1)
    expect(chats).toHaveLength(3)
    const roles = await Promise.all(chats.map((chat) => resolveChatCharacter(chat, resources)))
    expect(new Set(roles.map((role) => role.id))).toEqual(new Set([cards[0]!.id]))
    expect(await hashBlob(cards[0]!.originalBlob)).toBe(hash)
  })
  it('only reuses a verified user-selected card and rejects a stale selection before writing', async () => {
    const { resources } = setup()
    await resources.importFiles([png('a')])
    const card = (await resources.list())[0]!
    const hash = await hashBlob(png('a'))
    expect(
      (
        await resources.importFiles([archive()], { chatCharacterBindings: { [hash]: 'missing' } })
      )[0]?.status,
    ).toBe('failed')
    expect(await resources.list()).toHaveLength(1)
    await resources.importFiles([archive()], { chatCharacterBindings: { [hash]: card.id } })
    const chat = (await resources.list()).find((r) => r.type === RESOURCE_TYPE.CHAT)!
    expect(chat.relatedResourceIds).toEqual([card.id])
    expect(await resources.list()).toHaveLength(2)
  })
  it('can decline an existing card and keeps different same-named companions separate', async () => {
    const { resources } = setup()
    await resources.importFiles([png('a')])
    await resources.importFiles([archive('a'), archive('b'), archive('b')])
    const rows = await resources.list()
    expect(rows).toHaveLength(3)
    const chats = rows.filter((r) => r.type === RESOURCE_TYPE.CHAT)
    expect(chats.every((r) => !r.relatedResourceIds?.length)).toBe(true)
    const roles = await Promise.all(chats.map((c) => resolveChatCharacter(c, resources)))
    expect(new Set(roles.map((r) => r.id)).size).toBe(2)
  })
  it('carries global display rules without changing originals and upgrades existing imports on redelivery', async () => {
    const { resources } = setup()
    await resources.importFiles([archive()], { saveChatCharacter: true })
    const rules = [
      {
        scriptName: '状态栏',
        findRegex: '<status>(.*?)</status>',
        replaceString: '<b>$1</b>',
        markdownOnly: true,
        placement: [2],
      },
    ]
    const file = createChatArchive(png('a'), new File([raw], '雨夜.jsonl'), 'a.png', rules)
    expect((await readChatArchive(file)).displayRules).toEqual(rules)
    await resources.importFiles([file, file], { saveChatCharacter: true })
    const rows = await resources.list()
    expect(rows).toHaveLength(3)
    const chat = rows.find((r) => r.type === RESOURCE_TYPE.CHAT)!
    const regex = rows.find((r) => r.id === chat.metadata.chatDisplayRegexId)!
    expect(regex.type).toBe(RESOURCE_TYPE.REGEX)
    expect(JSON.parse(await regex.originalBlob.text()).global).toEqual(rules)
    expect(new Uint8Array(await chat.originalBlob.arrayBuffer())).toEqual(
      new TextEncoder().encode(raw),
    )
    expect(() =>
      createChatArchive(png('a'), new File([raw], '雨夜.jsonl'), 'a.png', [
        { ...rules[0], replaceString: 'x'.repeat(3 * 1024 * 1024) },
      ]),
    ).toThrow('大小限制')
  })

  it('persists the exact originals, binds the actual card, reads it through Duleme, and deduplicates repeated delivery', async () => {
    const { resources } = setup()
    const [result] = await resources.importFiles([archive()], { saveChatCharacter: true })
    expect(result?.status).toBe('imported')
    let rows = await resources.list()
    const chat = rows.find((r) => r.type === RESOURCE_TYPE.CHAT)!
    const card = rows.find((r) => r.type === RESOURCE_TYPE.CHARACTER_CARD)!
    expect(chat.relatedResourceIds).toEqual([card.id])
    expect(new Uint8Array(await chat.originalBlob.arrayBuffer())).toEqual(
      new TextEncoder().encode(raw),
    )
    expect(new Uint8Array(await card.originalBlob.arrayBuffer())).toEqual(
      new Uint8Array(await png('a').arrayBuffer()),
    )
    expect(
      (await new ChatReaderService(resources).read(chat.id)).messages[0]?.message.mes,
    ).toContain('{{user}}')
    expect((await resources.importFiles([archive()], { saveChatCharacter: true }))[0]?.status).toBe(
      'duplicate',
    )
    rows = await resources.list()
    expect(rows).toHaveLength(2)
  })
  it('never rebinds an existing chat when identical text arrives with a different same-named character', async () => {
    const { resources } = setup()
    await resources.importFiles([archive('a'), archive('b'), archive('b')], {
      saveChatCharacter: true,
    })
    const rows = await resources.list()
    expect(rows).toHaveLength(4)
    const chats = rows.filter((r) => r.type === RESOURCE_TYPE.CHAT)
    expect(new Set(chats.flatMap((r) => r.relatedResourceIds)).size).toBe(2)
    expect(chats[0]?.contentHash).toBe(chats[1]?.contentHash)
  })
  it('validates both parts before saving; broken framing and invalid JSONL create no resources', async () => {
    const { resources } = setup()
    const broken = new File([archive().slice(0, -1)], 'broken.srlchat')
    for (const file of [broken, archive('a', '{bad json}')])
      expect((await resources.importFiles([file]))[0]?.status).toBe('failed')
    expect(await resources.list()).toHaveLength(0)
  })
  it('reports a failed relationship write and safely reuses saved originals on retry', async () => {
    const { resources } = setup()
    const bind = vi
      .spyOn(resources, 'updateDetails')
      .mockRejectedValueOnce(new Error('模拟存储失败'))
    expect(
      (await resources.importFiles([archive()], { saveChatCharacter: true }))[0],
    ).toMatchObject({
      status: 'failed',
      message: '模拟存储失败',
    })
    bind.mockRestore()
    expect((await resources.importFiles([archive()], { saveChatCharacter: true }))[0]?.status).toBe(
      'duplicate',
    )
    const rows = await resources.list()
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.type === RESOURCE_TYPE.CHAT)?.relatedResourceIds).toHaveLength(1)
  })
  it('decodes with bounded slices and rejects oversized or unsafe metadata', async () => {
    const file = archive()
    vi.spyOn(file, 'arrayBuffer').mockRejectedValue(new Error('whole-file read'))
    expect((await readChatArchive(file)).avatar).toBe('a.png')
    expect(() => createChatArchive(png('a'), new File([raw], '../chat.jsonl'), 'a.png')).toThrow(
      '无效',
    )
    const prefix = new Uint8Array(await file.slice(0, 12).arrayBuffer())
    new DataView(prefix.buffer).setUint32(8, 1000000)
    await expect(
      readChatArchive(new File([prefix, file.slice(12)], 'bad.srlchat')),
    ).rejects.toThrow('包头')
  })
  it('accepts chats over 64 MiB and cards over 16 MiB within the shared file limit', async () => {
    const card = new File([new Uint8Array(17 * 1024 * 1024)], 'a.png')
    const chat = new File([new Uint8Array(65 * 1024 * 1024)], 'large.jsonl')
    const file = createChatArchive(card, chat, 'a.png')
    const decoded = await readChatArchive(file)
    expect(decoded.card.size).toBe(card.size)
    expect(decoded.chat.size).toBe(chat.size)
    expect(file.size).toBeGreaterThan(card.size + chat.size)
  })
})

describe('character reading scripts travel inside chat companions', () => {
  const phone = {
    type: 'script',
    id: 'phone',
    name: '手机',
    enabled: true,
    content: 'initializeGlobal("Phone", getVariables({type:"message"}));',
    data: { label: '保存配置' },
    folder: '手机分组',
    info: '角色手机',
    button: { enabled: true, buttons: [{ name: '手机显隐切换', visible: true }] },
  }
  it('persists role scripts without standalone card/script resources and reads them after reopening storage', async () => {
    const { resources, database } = setup()
    const card = png('script', [phone])
    const file = createChatArchive(card, new File([raw], '雨夜.jsonl'), 'a.png')
    await resources.importFiles([file, file])
    const rows = await resources.list()
    expect(rows).toHaveLength(1)
    const chat = rows[0]!
    expect(chat.type).toBe(RESOURCE_TYPE.CHAT)
    expect(chat.metadata.chatReadingScriptId).toBeNull()
    expect(JSON.stringify(toResourceListSummary(chat))).not.toContain('initializeGlobal')
    expect(new Uint8Array(await chat.originalBlob.arrayBuffer())).toEqual(
      new TextEncoder().encode(raw),
    )
    const selected = new Set([chat.id])
    includeChatCompanionIds(rows, selected)
    expect([...selected]).toEqual([chat.id])
    database.close()
    await database.open()
    const saved = (await resources.get(chat.id))!
    const role = await resolveChatCharacter(saved, resources)
    expect(role.card).not.toHaveProperty('description')
    const catalog = await chatReaderScripts(role.card, [], {})
    expect(catalog.rules).toEqual([
      expect.objectContaining({
        name: phone.name,
        folder: phone.folder,
        sourceId: 'character',
        enabled: false,
      }),
    ])
    expect(catalog.active).toEqual([])
    const enabled = await chatReaderScripts(role.card, [], { [catalog.rules[0]!.key]: true })
    expect(enabled.active).toEqual([
      expect.objectContaining({
        content: phone.content,
        data: phone.data,
        info: phone.info,
        buttonDefinitions: [{ name: '手机显隐切换', visible: true }],
      }),
    ])
    expect(await hashBlob(card)).toBe((saved.metadata.chatCharacter as { hash: string }).hash)
  })
  it('does not save role scripts when the carry switch is off, preserving both originals', async () => {
    const { resources } = setup()
    const card = png('off', [phone])
    const file = createChatArchive(card, new File([raw], '雨夜.jsonl'), 'a.png', [], {
      carryReadingScripts: false,
    })
    const decoded = await readChatArchive(file)
    expect(await decoded.card.arrayBuffer()).toEqual(await card.arrayBuffer())
    await resources.importFiles([file])
    const chat = (await resources.list())[0]!
    expect(
      (await chatReaderScripts((await resolveChatCharacter(chat, resources)).card, [], {})).rules,
    ).toHaveLength(0)
    expect(JSON.stringify(chat.metadata)).not.toContain('initializeGlobal')
    expect(new Uint8Array(await chat.originalBlob.arrayBuffer())).toEqual(
      new TextEncoder().encode(raw),
    )
    expect(await resources.list()).toHaveLength(1)
  })
  it('honors mixed carry settings and reimports without leaking the batch script cache', async () => {
    const { resources } = setup()
    const card = png('mixed', [phone])
    const make = (carryReadingScripts: boolean, name = '雨夜') =>
      createChatArchive(
        card,
        new File(
          [raw + JSON.stringify({ name: '角色', mes: name, is_user: false }) + '\n'],
          name + '.jsonl',
        ),
        'a.png',
        [],
        { carryReadingScripts },
      )
    await resources.importFiles([make(true, '开启'), make(false, '关闭')])
    const rows = await resources.list()
    const withCode = rows.find((r) => JSON.stringify(r.metadata).includes('initializeGlobal'))!
    const withoutCode = rows.find((r) => r.id !== withCode.id)!
    expect(rows).toHaveLength(2)
    expect(
      (await chatReaderScripts((await resolveChatCharacter(withoutCode, resources)).card, [], {}))
        .rules,
    ).toHaveLength(0)
    await resources.importFiles([make(false, '开启')])
    expect(JSON.stringify((await resources.get(withCode.id))!.metadata)).not.toContain(
      'initializeGlobal',
    )
    await resources.importFiles([make(true, '关闭')])
    expect(JSON.stringify((await resources.get(withoutCode.id))!.metadata)).toContain(
      'initializeGlobal',
    )
    expect(await resources.list()).toHaveLength(2)
  })
  it('stores the carry exclusion with a full bound card without editing its original', async () => {
    const { resources } = setup()
    const card = png('full-off', [phone])
    const file = createChatArchive(card, new File([raw], '雨夜.jsonl'), 'a.png', [], {
      carryReadingScripts: false,
    })
    await resources.importFiles([file], { saveChatCharacter: true })
    const rows = await resources.list()
    const savedCard = rows.find((r) => r.type === RESOURCE_TYPE.CHARACTER_CARD)!
    const chat = rows.find((r) => r.type === RESOURCE_TYPE.CHAT)!
    expect(await savedCard.originalBlob.arrayBuffer()).toEqual(await card.arrayBuffer())
    expect(chat.metadata.chatCharacter).toMatchObject({ carryReadingScripts: false })
    expect(JSON.stringify(chat.metadata)).not.toContain('initializeGlobal')
    expect(chat.relatedResourceIds).toEqual([savedCard.id])
  })
  it('ignores legacy global/preset snapshots and preserves manually imported scripts', async () => {
    const { resources } = setup()
    await resources.importFiles([new File([JSON.stringify(phone)], 'manual-phone.json')])
    const manual = (await resources.list())[0]!
    const file = createChatArchive(png('a', [phone]), new File([raw], '雨夜.jsonl'), 'a.png', [], {
      readingScripts: [
        { sourceName: '全局手机', scripts: { ...phone, id: 'global', content: 'globalOnly()' } },
        { sourceName: '预设', scripts: { other: true } },
      ],
    })
    await resources.importFiles([file])
    const chat = (await resources.list()).find((r) => r.type === RESOURCE_TYPE.CHAT)!
    expect(JSON.stringify(chat.metadata)).not.toContain('globalOnly()')
    expect(await resources.list()).toHaveLength(2)
    await resources.updateMetadata(chat.id, { chatReadingScriptId: manual.id })
    await resources.importFiles([file])
    expect((await resources.get(chat.id))!.metadata.chatReadingScriptId).toBeNull()
    expect((await resources.get(manual.id))!.contentHash).toBe(manual.contentHash)
    const role = await resolveChatCharacter((await resources.get(chat.id))!, resources)
    const catalog = await chatReaderScripts(role.card, [manual], {})
    expect(catalog.rules).toHaveLength(1)
  })
  it('still supports saving and binding the full original card without extracting scripts', async () => {
    const { resources } = setup()
    const file = createChatArchive(png('full', [phone]), new File([raw], '雨夜.jsonl'), 'a.png')
    await resources.importFiles([file, file], { saveChatCharacter: true })
    const rows = await resources.list()
    expect(rows).toHaveLength(2)
    const card = rows.find((r) => r.type === RESOURCE_TYPE.CHARACTER_CARD)!
    const chat = rows.find((r) => r.type === RESOURCE_TYPE.CHAT)!
    expect(chat.relatedResourceIds).toEqual([card.id])
    const role = await resolveChatCharacter(chat, resources)
    expect((await chatReaderScripts(role.card, [], {})).rules).toHaveLength(1)
  })
  it('rejects excessive role code before any write, keeping the bounded legacy wire checks', async () => {
    const { resources } = setup()
    for (const scripts of [
      Array.from({ length: 65 }, (_, i) => ({ ...phone, id: String(i) })),
      [{ ...phone, content: 'x'.repeat(2 * 1024 * 1024) }],
    ]) {
      const file = createChatArchive(png('large', scripts), new File([raw], '雨夜.jsonl'), 'a.png')
      expect((await resources.importFiles([file], { saveChatCharacter: true }))[0]!.status).toBe(
        'failed',
      )
    }
    expect(await resources.list()).toHaveLength(0)
    expect(() =>
      createChatArchive(png('a'), new File([raw], '雨夜.jsonl'), 'a.png', [], {
        readingScripts: Array.from({ length: 9 }, () => ({ sourceName: '手机', scripts: phone })),
      }),
    ).toThrow('来源')
  })
})
