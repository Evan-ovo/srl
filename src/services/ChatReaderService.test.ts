import { describe, expect, it, vi } from 'vitest'
import { ChatReaderService } from './ChatReaderService'
import type { ResourceService } from './ResourceService'
import type { ChatReadPositionCache } from '../storage/ResourceStorageAdapter'
import { ChatResourceParser } from '../parser/ChatResourceParser'

async function fixture() {
  const rows = [
    { name: '角色', mes: '第一楼', is_user: false },
    { name: 'system', mes: '隐藏', is_user: false, is_system: true },
    { name: '用户', mes: '第三楼', is_user: true },
    { name: '角色', mes: '末楼', is_user: false },
  ]
  const originalBlob = new File([rows.map((x) => JSON.stringify(x)).join('\n')], 'test.jsonl')
  const parsed = await new ChatResourceParser().parse(originalBlob)
  const chat = {
    ...parsed,
    id: 'chat',
    originalBlob,
    contentHash: 'original',
    relatedResourceIds: ['old', 'regex'],
    tags: [],
    categoryId: null,
  }
  const resources = {
    get: vi.fn(async (id: string) =>
      id === 'chat' ? chat : { id, type: id === 'bad' ? 'regex' : 'characterCard' },
    ),
    listResourceListSummaries: vi.fn(async () => [
      { id: 'old', type: 'characterCard' },
      { id: 'new', type: 'characterCard' },
    ]),
    updateDetails: vi.fn(),
  }
  return {
    service: new ChatReaderService(resources as unknown as ResourceService),
    resources,
    chat,
  }
}
describe('ChatReaderService', () => {
  it('reuses raw floors across SDK reader instances and seeks from a sparse byte checkpoint', async () => {
    const { service, resources, chat } = await fixture()
    const rows = Array.from({ length: 1000 }, (_, floor) => ({
      name: '角色',
      mes: `第${floor}楼` + '中x🌧'.repeat(100),
      is_user: floor % 3 === 1,
      is_system: floor % 11 === 0,
      variables: [{ stat_data: { floor } }, { stat_data: { floor, alternate: true } }],
      swipes: [`原回复${floor}`, `备用回复${floor}`],
      swipe_id: 0,
    }))
    chat.originalBlob = new File(
      [
        '\uFEFF' +
          JSON.stringify({ chat_metadata: {} }) +
          '\r\n\r\n' +
          rows.map((row) => JSON.stringify(row)).join('\r\n'),
      ],
      'large.jsonl',
    )
    chat.metadata.messageCount = rows.length
    chat.metadata.visibleMessageCount = rows.filter((row) => !row.is_system).length
    const slices = vi.spyOn(chat.originalBlob, 'slice')
    const cold = await service.read('chat', 900, 3)
    const coldBytes = slices.mock.calls.reduce(
      (sum, [start, end]) =>
        sum + Math.min((end ?? 0) - (start ?? 0), chat.originalBlob.size - (start ?? 0)),
      0,
    )
    cold.messages[0]!.message.variables = { mutated: true }
    slices.mockClear()
    const anotherReader = new ChatReaderService(resources as unknown as ResourceService)
    const reused = await anotherReader.read('chat', 900, 3)
    expect(slices).not.toHaveBeenCalled()
    expect(reused.messages[0]!.message.variables).toEqual(rows[900]!.variables)
    expect(reused.messages.map((entry) => entry.index)).toEqual([900, 901, 902])
    const sought = await anotherReader.read('chat', 800, 2)
    expect(slices.mock.calls[0]![0]).toBeGreaterThan(0)
    const seekBytes = slices.mock.calls.reduce(
      (sum, [start, end]) =>
        sum + Math.min((end ?? 0) - (start ?? 0), chat.originalBlob.size - (start ?? 0)),
      0,
    )
    expect(seekBytes).toBeLessThan(coldBytes / 2)
    for (const entry of sought.messages) {
      const visible = rows.slice(0, entry.index + 1).filter((row) => !row.is_system).length
      expect(entry.depth).toBe(
        rows[entry.index]!.is_system ? -1 : Number(chat.metadata.visibleMessageCount) - visible,
      )
      expect(entry.message).toEqual(rows[entry.index])
    }
  })

  it('keeps a complete default page in the bounded recent-floor cache', async () => {
    const { service, resources, chat } = await fixture()
    const rows = Array.from({ length: 1000 }, (_, floor) => ({
      name: '角色',
      mes: `第${floor}楼` + '正文'.repeat(40),
      is_user: floor % 3 === 1,
    }))
    chat.originalBlob = new File([rows.map((row) => JSON.stringify(row)).join('\n')], 'page.jsonl')
    chat.metadata.messageCount = rows.length
    chat.metadata.visibleMessageCount = rows.length
    const slices = vi.spyOn(chat.originalBlob, 'slice')
    const cold = await service.read('chat', 900, 20)
    expect(cold.messages.map((entry) => entry.index)).toEqual(
      Array.from({ length: 20 }, (_, index) => 900 + index),
    )
    expect(slices).toHaveBeenCalled()
    slices.mockClear()
    const warm = await new ChatReaderService(resources as unknown as ResourceService).read(
      'chat',
      900,
      20,
    )
    expect(warm).toEqual(cold)
    expect(slices).not.toHaveBeenCalled()
  })

  it('preserves hidden-user navigation across checkpoints, long user gaps and backward byte trimming', async () => {
    const { service, chat } = await fixture()
    const rows = Array.from({ length: 700 }, (_, floor) => ({
      name: '角色',
      mes: `第${floor}楼` + ([512, 650].includes(floor) ? 'x'.repeat(300_000) : ''),
      is_user: ![0, 120, 256, 300, 512, 650].includes(floor),
      is_system: floor === 256,
    }))
    chat.originalBlob = new File([rows.map((row) => JSON.stringify(row)).join('\n')], 'gaps.jsonl')
    chat.metadata.messageCount = rows.length
    chat.metadata.visibleMessageCount = 699
    await service.read('chat', 660, 1)
    const replies = rows.flatMap((row, floor) => (row.is_user ? [] : [floor]))
    for (const offset of [0, 119, 121, 256, 299, 301, 512, 651, 699, 700])
      for (const backward of [false, true])
        for (const limit of [1, 2, 4]) {
          const candidates = replies.filter((floor) =>
            backward ? floor <= offset : floor >= offset,
          )
          const selected = backward ? candidates.slice(-limit) : candidates.slice(0, limit)
          const size = (floor: number) =>
            new TextEncoder().encode(JSON.stringify(rows[floor])).length
          while (
            selected.length > 1 &&
            selected.reduce((sum, floor) => sum + size(floor), 0) > 512 * 1024
          )
            if (backward) selected.shift()
            else selected.pop()
          if (!backward && !selected.length) selected.push(replies.at(-1)!)
          const page = await service.read('chat', offset, limit, { hideUser: true, backward })
          expect(page.messages.map((entry) => entry.index)).toEqual(selected)
          expect(page.previousOffset).toBe(replies[replies.indexOf(selected[0]!) - 1] ?? null)
          expect(page.nextOffset).toBe(replies[replies.indexOf(selected.at(-1)!) + 1] ?? null)
          for (const entry of page.messages)
            expect(entry.depth).toBe(
              entry.index === 256 ? -1 : 699 - (entry.index + 1 - Number(entry.index > 256)),
            )
        }
    expect(await service.read('chat', 699, 1, { hideUser: true })).toMatchObject({
      previousOffset: 512,
      nextOffset: null,
      messages: [{ index: 650 }],
    })
  })

  it('invalidates changed content and refuses deleted resources even when the requested floor was cached', async () => {
    const { service, chat, resources } = await fixture()
    await service.read('chat', 0, 1)
    const source = await chat.originalBlob.text()
    chat.originalBlob = new File([source.replace('第一楼', '新版楼')], 'new.jsonl')
    chat.contentHash = 'new-content'
    expect((await service.read('chat', 0, 1)).messages[0]!.message.mes).toBe('新版楼')
    resources.get.mockImplementation(async () => undefined as never)
    await expect(service.read('chat', 0, 1)).rejects.toThrow('不存在')
  })

  it('bounds retained floors by count and keeps the same IPC byte limits on cache hits', async () => {
    const { service, chat } = await fixture()
    const rows = Array.from({ length: 80 }, (_, floor) => ({
      name: '角色',
      mes: String(floor),
      is_user: false,
    }))
    chat.originalBlob = new File(
      [rows.map((row) => JSON.stringify(row)).join('\n')],
      'window.jsonl',
    )
    chat.metadata.messageCount = 80
    chat.metadata.visibleMessageCount = 80
    const slices = vi.spyOn(chat.originalBlob, 'slice')
    await service.read('chat', 0, 20)
    slices.mockClear()
    expect((await service.read('chat', 19, 1)).messages[0]!.message.mes).toBe('19')
    expect(slices).not.toHaveBeenCalled()
    await service.read('chat', 20, 20)
    await service.read('chat', 40, 20)
    await service.read('chat', 60, 20)
    slices.mockClear()
    await service.read('chat', 0, 1)
    expect(slices).toHaveBeenCalled()
    chat.originalBlob = new File(
      [JSON.stringify({ name: '角色', mes: '中'.repeat(1_400_000), is_user: false })],
      'huge.jsonl',
    )
    chat.contentHash = 'huge'
    chat.metadata.messageCount = 1
    await expect(service.read('chat', 0, 1)).rejects.toThrow('单楼读取上限')
    const hugeSlices = vi.spyOn(chat.originalBlob, 'slice')
    await expect(service.read('chat', 0, 1)).rejects.toThrow('单楼读取上限')
    expect(hugeSlices).not.toHaveBeenCalled()
  })

  it('reuses a bounded JSON-array floor without reparsing the entire array', async () => {
    const { service, chat } = await fixture()
    chat.originalBlob = new File(
      [
        JSON.stringify([
          { name: '角色', mes: '第一楼', is_user: false },
          { name: '角色', mes: '第二楼', is_user: false, variables: [{ score: 2 }] },
        ]),
      ],
      'array.json',
    )
    chat.metadata.format = 'json'
    chat.metadata.messageCount = 2
    chat.metadata.visibleMessageCount = 2
    const text = vi.spyOn(chat.originalBlob, 'text')
    const page = await service.read('chat', 1, 1)
    text.mockClear()
    expect(await service.read('chat', 1, 1)).toEqual(page)
    expect(text).not.toHaveBeenCalled()
    expect(await service.search('chat', '第二', 1)).toMatchObject({
      results: [{ floor: 1, text: '第二楼' }],
      nextOffset: null,
    })
    expect(await service.chapters('chat', 1, 1)).toMatchObject({
      items: [{ floor: 1, text: '第二楼' }],
      nextOffset: null,
    })
  })

  it('persists sparse byte checkpoints and resumes after recreating the reader service', async () => {
    const { chat } = await fixture()
    const rows = Array.from({ length: 700 }, (_, floor) => ({
      name: '角色',
      mes: `第${floor}楼` + '正文'.repeat(20),
      is_user: floor % 3 === 1,
    }))
    const source = Object.assign(
      new File([rows.map((row) => JSON.stringify(row)).join('\n')], 'persistent.jsonl'),
      { contentIdentity: 'a'.repeat(64) },
    )
    const readChat = {
      ...chat,
      originalSource: source,
      metadata: {
        ...chat.metadata,
        format: 'jsonl',
        messageCount: rows.length,
        visibleMessageCount: rows.length,
      },
    }
    const stored = new Map<string, ChatReadPositionCache>()
    const makeResources = () =>
      ({
        getReadSource: vi.fn(async () => readChat),
        getChatReadPositionCache: vi.fn(async (id: string) => structuredClone(stored.get(id))),
        setChatReadPositionCache: vi.fn(async (id: string, cache: ChatReadPositionCache) =>
          stored.set(id, structuredClone(cache)),
        ),
        deleteChatReadPositionCache: vi.fn(async (id: string) => {
          stored.delete(id)
        }),
      }) as unknown as ResourceService

    await new ChatReaderService(makeResources()).read('chat', 600, 1)
    expect(stored.get('chat')).toMatchObject({
      schemaVersion: 1,
      checkpoints: expect.arrayContaining([expect.objectContaining({ floor: 512 })]),
    })

    const slices = vi.spyOn(source, 'slice')
    const reopened = new ChatReaderService(makeResources())
    const page = await reopened.read('chat', 600, 1)
    expect(page.messages.map(({ index }) => index)).toEqual([600])
    expect(slices.mock.calls[0]![0]).toBeGreaterThan(0)
    expect(
      slices.mock.calls.reduce(
        (sum, [start, end]) =>
          sum + Math.max(0, Math.min(Number(end), source.size) - Number(start)),
        0,
      ),
    ).toBeLessThan(source.size / 2)

    slices.mockClear()
    expect(await reopened.search('chat', '第600楼', 600)).toEqual({
      results: [{ floor: 600, text: expect.stringContaining('第600楼') }],
      nextOffset: null,
    })
    expect(slices.mock.calls[0]![0]).toBeGreaterThan(0)
    expect(
      slices.mock.calls.reduce(
        (sum, [start, end]) =>
          sum + Math.max(0, Math.min(Number(end), source.size) - Number(start)),
        0,
      ),
    ).toBeLessThan(source.size / 2)

    slices.mockClear()
    expect(await reopened.chapters('chat', 600, 1)).toMatchObject({
      items: [{ floor: 600, text: expect.stringContaining('第600楼') }],
      nextOffset: 601,
    })
    expect(slices.mock.calls[0]![0]).toBeGreaterThan(0)
    expect(
      slices.mock.calls.reduce(
        (sum, [start, end]) =>
          sum + Math.max(0, Math.min(Number(end), source.size) - Number(start)),
        0,
      ),
    ).toBeLessThan(source.size / 2)

    slices.mockClear()
    const corrupted = structuredClone(stored.get('chat')!)
    corrupted.checkpoints[1]!.byteOffset = source.size + 1
    stored.set('chat', corrupted)
    const corruptedResources = makeResources()
    await new ChatReaderService(corruptedResources).read('chat', 600, 1)
    expect(corruptedResources.deleteChatReadPositionCache).toHaveBeenCalledWith('chat')
    expect(slices.mock.calls[0]![0]).toBe(0)

    slices.mockClear()
    source.contentIdentity = 'b'.repeat(64)
    const changedResources = makeResources()
    await new ChatReaderService(changedResources).read('chat', 600, 1)
    expect(changedResources.deleteChatReadPositionCache).toHaveBeenCalledWith('chat')
    expect(slices.mock.calls[0]![0]).toBe(0)

    const broken = makeResources()
    vi.mocked(broken.getChatReadPositionCache).mockRejectedValue(new Error('cache unavailable'))
    vi.mocked(broken.setChatReadPositionCache).mockRejectedValue(new Error('cache full'))
    expect((await new ChatReaderService(broken).read('chat', 600, 1)).messages[0]!.index).toBe(600)
    expect(broken.setChatReadPositionCache).toHaveBeenCalled()
    vi.mocked(broken.getReadSource).mockRejectedValue(new Error('original unavailable'))
    await expect(new ChatReaderService(broken).read('chat', 600, 1)).rejects.toThrow(
      'original unavailable',
    )
  })

  it('evicts by estimated bytes before the count limit and drops an inactive chat index', async () => {
    const { service, chat, resources } = await fixture()
    const rows = [0, 1, 2].map((floor) => ({
      name: '角色',
      mes: `${floor}` + 'x'.repeat(1_500_000),
      is_user: false,
    }))
    chat.originalBlob = new File(
      [rows.map((row) => JSON.stringify(row)).join('\n')],
      'budget.jsonl',
    )
    chat.metadata.messageCount = 3
    chat.metadata.visibleMessageCount = 3
    const slices = vi.spyOn(chat.originalBlob, 'slice')
    for (const offset of [0, 1, 2]) await service.read('chat', offset, 1)
    slices.mockClear()
    await service.read('chat', 2, 1)
    expect(slices).not.toHaveBeenCalled()
    await service.read('chat', 0, 1)
    expect(slices).toHaveBeenCalled()
    const first = { ...chat }
    const others = [1, 2, 3, 4].map((id) => ({
      ...chat,
      id: `chat${id}`,
      contentHash: `hash${id}`,
    }))
    resources.get.mockImplementation(
      async (id) => [first, ...others].find((item) => item.id === id) as never,
    )
    for (const other of others) await service.read(other.id, 0, 1)
    slices.mockClear()
    await service.read(first.id, 0, 1)
    expect(slices.mock.calls[0]![0]).toBe(0)
  })

  it('keeps valid byte/depth checkpoints after compacting the index of a very long chat', async () => {
    const { service, chat } = await fixture()
    const total = 132_000
    chat.originalBlob = new File(
      [
        Array.from({ length: total }, (_, floor) =>
          JSON.stringify({
            name: '角色',
            mes: String(floor),
            is_user: floor % 2 === 0,
            is_system: floor % 7 === 0,
          }),
        ).join('\n'),
      ],
      'long.jsonl',
    )
    chat.metadata.messageCount = total
    chat.metadata.visibleMessageCount = total - Math.ceil(total / 7)
    await service.read('chat', total - 1, 1)
    const slices = vi.spyOn(chat.originalBlob, 'slice')
    const page = await service.read('chat', 100_000, 1)
    expect(slices.mock.calls[0]![0]).toBeGreaterThan(0)
    expect(page.messages[0]).toMatchObject({
      index: 100_000,
      depth: Number(chat.metadata.visibleMessageCount) - (100_001 - Math.ceil(100_001 / 7)),
      message: { mes: '100000' },
    })
  })

  it('隐藏用户时跳过连续用户章，前后导航保留原楼号与正则深度', async () => {
    const { service, chat } = await fixture()
    const users = [true, false, true, true, false, true, false, true]
    chat.originalBlob = new File(
      [
        users
          .map((is_user, index) =>
            JSON.stringify({
              name: is_user ? '用户' : '角色',
              mes: `内容${index}`,
              is_user,
            }),
          )
          .join('\n'),
      ],
      'test.jsonl',
    )
    chat.metadata.messageCount = 8
    chat.metadata.visibleMessageCount = 8
    const first = await service.read('chat', 0, 1, { hideUser: true })
    expect(first).toMatchObject({
      previousOffset: null,
      nextOffset: 4,
      messages: [{ index: 1, depth: 6 }],
    })
    const second = await service.read('chat', first.nextOffset!, 1, { hideUser: true })
    expect(second).toMatchObject({
      previousOffset: 1,
      nextOffset: 6,
      messages: [{ index: 4, depth: 3 }],
    })
    const back = await service.read('chat', second.previousOffset!, 1, {
      hideUser: true,
      backward: true,
    })
    expect(back).toEqual(first)
    const batch = await service.read('chat', 6, 2, { hideUser: true, backward: true })
    expect(batch.messages.map((x) => x.index)).toEqual([4, 6])
    expect(batch).toMatchObject({ previousOffset: 1, nextOffset: null })
    expect(
      (await service.read('chat', 7, 1, { hideUser: true })).messages.map((x) => x.index),
    ).toEqual([6])
    expect((await service.read('chat', 2, 1)).messages[0]?.message.is_user).toBe(true)
  })

  it('全为用户的记录没有空章节导航', async () => {
    const { service, chat } = await fixture()
    chat.originalBlob = new File(
      [JSON.stringify({ name: '用户', mes: '仅用户', is_user: true })],
      'test.jsonl',
    )
    chat.metadata.messageCount = 1
    expect(await service.read('chat', 0, 1, { hideUser: true })).toMatchObject({
      messages: [],
      previousOffset: null,
      nextOffset: null,
    })
  })
  it('reviews the selected saved reply against the nearest earlier snapshot and reports gaps', async () => {
    const { service, chat, resources } = await fixture()
    const rows = [
      {
        name: '角色',
        is_user: false,
        mes: '开场',
        variables: [{ stat_data: { 地点: '家', 好感: 1 } }],
      },
      { name: '用户', is_user: true, mes: '继续' },
      {
        name: '角色',
        is_user: false,
        mes: '当前',
        swipes: ['当前', '备用'],
        swipe_id: 0,
        variables: [
          { stat_data: { 地点: '基地', 好感: 3 } },
          { stat_data: { 地点: '公园', 好感: 9 } },
        ],
      },
      { name: '角色', is_user: false, mes: '空快照', variables: [{}] },
    ]
    chat.originalBlob = new File([rows.map((x) => JSON.stringify(x)).join('\n')], 'variables.jsonl')
    expect(await service.variableReview('chat', 0)).toMatchObject({
      status: 'initial',
      baseline: null,
    })
    expect(await service.variableReview('chat', 1)).toMatchObject({
      status: 'missing',
      changes: [],
    })
    const result = await service.variableReview('chat', 2, { '2': 1 })
    expect(result).toMatchObject({
      status: 'compared',
      floor: 2,
      replyId: 1,
      baseline: { floor: 0, replyId: 0 },
      missingFloors: 1,
    })
    expect(result.changes.find((x) => x.path === '好感')).toMatchObject({ delta: 8 })
    expect(await service.variableReview('chat', 3)).toMatchObject({ status: 'incompatible' })
    rows[2]!.variables = [{ stat_data: { 地点: '基地', 好感: 3 } }]
    chat.originalBlob = new File([rows.map((x) => JSON.stringify(x)).join('\n')], 'variables.jsonl')
    expect(await service.variableReview('chat', 2, { '2': 1 })).toMatchObject({ status: 'missing' })
    expect(resources.updateDetails).not.toHaveBeenCalled()
    await expect(service.variableReview('chat', 4)).rejects.toThrow('不存在')
  })
  it('returns a bounded chapter directory without message variables or raw HTML', async () => {
    const { service, chat } = await fixture()
    chat.originalBlob = new File(
      [
        JSON.stringify({
          name: '角色',
          is_user: false,
          mes: '<status_top>不作为章节标题的日期和数值</status_top>```html\n<script>hidden()</script>\n```\n正文的关键词',
          variables: { secret: 'not in outline' },
        }) +
          '\n' +
          JSON.stringify({ name: '用户', is_user: true, mes: '第二章' }),
      ],
      'outline.jsonl',
    )
    const result = await service.chapters('chat', 0, 1)
    expect(result.items).toEqual([
      { floor: 0, name: '角色', isUser: false, text: '正文的关键词', replies: 1 },
    ])
    expect(result.nextOffset).toBe(1)
    expect(JSON.stringify(result)).not.toContain('secret')
    await expect(service.chapters('chat', 0, 51)).rejects.toThrow('参数')
  })
  it('pages original messages and calculates ST depth ignoring system messages', async () => {
    const { service } = await fixture()
    const page = await service.read('chat', 2, 1)
    expect(page).toMatchObject({
      total: 4,
      nextOffset: 3,
      contentHash: 'original',
      messages: [{ index: 2, depth: 1, message: { mes: '第三楼' } }],
    })
    expect((await service.read('chat', 3)).nextOffset).toBeNull()
    await expect(service.read('chat', 0, 0)).rejects.toThrow('分页')
  })
  it('searches originals once and returns bounded floor excerpts', async () => {
    const { service } = await fixture()
    expect(await service.search('chat', '楼', 2)).toEqual({
      results: [
        { floor: 2, text: '第三楼' },
        { floor: 3, text: '末楼' },
      ],
      nextOffset: null,
    })
    await expect(service.search('chat', '')).rejects.toThrow('参数')
  })
  it('binds one real character using existing resource relationships, preserving non-character links and originals', async () => {
    const { service, resources, chat } = await fixture()
    await service.bind('chat', 'new')
    expect(resources.updateDetails).toHaveBeenCalledWith(
      chat,
      expect.objectContaining({ relatedResourceIds: ['regex', 'new'] }),
    )
    await expect(service.bind('chat', 'bad')).rejects.toThrow('角色卡')
  })
})
