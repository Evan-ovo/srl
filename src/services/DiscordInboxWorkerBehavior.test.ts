import { createHash, generateKeyPairSync, sign, webcrypto, type KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DISCORD_INBOX_SCHEMA } from '../../workers/discord-source-bridge/src/DiscordInboxSchema.js'
import { DISCORD_RESOURCE_SCHEMA } from '../../workers/discord-source-bridge/src/DiscordResourceSchema.js'
import { buildDiscordManualWorkerSource } from '../../scripts/DiscordManualWorkerSource'
import { createDiscordSourceKey, type DiscordCapture } from '../types/CommunitySource.js'

type Worker = {
  fetch(request: Request, env: object, ctx: object): Promise<Response>
  scheduled(controller: object, env: object): Promise<void>
}
interface Pair {
  libraryId: string
  secret: string
  code: string
  expiresAt: number
}
interface Job {
  id: string
  state: string
  createdAt: number
}

/** Executes production queries against SQLite, including transaction rollback and UNIQUE constraints. */
class SqlD1 {
  readonly sqlite = new DatabaseSync(':memory:')
  failNextAcknowledgement = false
  beforeNextHandoffInsert?: () => void
  constructor(installMigrations = true) {
    if (!installMigrations) return
    for (const file of ['0001_handoffs.sql', '0002_inbox.sql', '0003_resources.sql']) {
      this.sqlite.exec(
        readFileSync(
          fileURLToPath(
            new URL(`../../workers/discord-source-bridge/migrations/${file}`, import.meta.url),
          ),
          'utf8',
        ),
      )
    }
  }
  prepare(sql: string) {
    return new SqlStatement(this, sql)
  }
  async batch(statements: SqlStatement[]) {
    this.sqlite.exec('BEGIN')
    try {
      const results = statements.map((statement) => statement.execute())
      this.sqlite.exec('COMMIT')
      return results
    } catch (error) {
      this.sqlite.exec('ROLLBACK')
      throw error
    }
  }
}
class SqlStatement {
  values: Array<string | number | null> = []
  readonly owner: SqlD1
  readonly sql: string
  constructor(owner: SqlD1, sql: string) {
    this.owner = owner
    this.sql = sql
  }
  bind(...values: Array<string | number | null>) {
    this.values = values
    return this
  }
  execute() {
    if (this.owner.beforeNextHandoffInsert && /INSERT INTO handoffs/u.test(this.sql)) {
      const interleave = this.owner.beforeNextHandoffInsert
      this.owner.beforeNextHandoffInsert = undefined
      interleave()
    }
    if (
      this.owner.failNextAcknowledgement &&
      /UPDATE inbox_deliveries\s+SET state/u.test(this.sql)
    ) {
      this.owner.failNextAcknowledgement = false
      throw new Error('simulated D1 acknowledgement failure')
    }
    const prepared = this.owner.sqlite.prepare(this.sql)
    if (prepared.columns().length)
      return { results: prepared.all(...this.values), meta: { changes: 0 }, success: true }
    const result = prepared.run(...this.values)
    return { results: [], meta: { changes: Number(result.changes) }, success: true }
  }
  async first() {
    return this.execute().results[0] ?? null
  }
  async run() {
    return this.execute()
  }
  async all() {
    return this.execute()
  }
}

let worker: Worker
let signingKey: KeyObject
let publicKey: string
let database: SqlD1
let callbacks: Promise<unknown>[]
let discordReplies: Array<{
  content: string
  components?: Array<{ components: Array<{ url: string }> }>
}>
const base = 'https://bridge.example'
const context = { waitUntil: (task: Promise<unknown>) => callbacks.push(task) }
const environment = () => ({
  DB: database,
  DISCORD_APPLICATION_ID: '12345',
  DISCORD_PUBLIC_KEY: publicKey,
  DISCORD_BOT_TOKEN: 'bot-token',
})
const headers = (pair: Pair) => ({
  Authorization: `Bearer ${pair.secret}`,
  'X-SRL-Library-ID': pair.libraryId,
})
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })

async function request(
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
) {
  return worker.fetch(
    new Request(base + path, {
      method: options.method ?? 'GET',
      headers: { 'Content-Type': 'application/json', ...options.headers },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
    environment(),
    context,
  )
}
async function drain() {
  while (callbacks.length) {
    const tasks = callbacks.splice(0)
    await Promise.all(tasks)
  }
}
async function newPair(name = '我的手机'): Promise<Pair> {
  const response = await request('/inbox/pair', {
    method: 'POST',
    headers: { Authorization: 'Bearer bot-token' },
    body: { name },
  })
  expect(response.status).toBe(200)
  return response.json() as Promise<Pair>
}
async function interaction(data: object, userId = '55555', member = false, discordContext = 0) {
  const body = JSON.stringify({
    id: crypto.randomUUID(),
    type: 2,
    token: 'interaction-token',
    channel_id: '33333',
    context: discordContext,
    ...(discordContext === 0 ? { guild_id: '11111' } : {}),
    ...(member ? { member: { user: { id: userId } } } : { user: { id: userId } }),
    data,
  })
  const timestamp = String(Math.floor(Date.now() / 1_000))
  const signature = sign(null, Buffer.from(timestamp + body), signingKey).toString('hex')
  const response = await worker.fetch(
    new Request(base + '/interactions', {
      method: 'POST',
      body,
      headers: { 'X-Signature-Timestamp': timestamp, 'X-Signature-Ed25519': signature },
    }),
    environment(),
    context,
  )
  await drain()
  return response
}
async function bind(pair: Pair, userId = '55555', member = false) {
  return interaction(
    { name: '绑定资源库', type: 1, options: [{ name: 'code', type: 3, value: pair.code }] },
    userId,
    member,
  )
}
function postData(
  content = '帖子正文',
  messageId = '22222',
  name = '保存帖子到SRL（云端暂存）',
  attachmentQuery = '?ex=old&is=old&hm=old',
) {
  return {
    name,
    type: 3,
    target_id: messageId,
    resolved: {
      messages: {
        [messageId]: {
          id: messageId,
          content,
          timestamp: '2026-10-02T00:00:00.000Z',
          author: { id: '77777', username: 'author' },
          attachments: [
            {
              id: '88888',
              filename: 'card.png',
              size: 100,
              url: `https://cdn.discordapp.com/attachments/33333/88888/card.png${attachmentQuery}`,
            },
          ],
        },
      },
    },
  }
}
async function savePost(
  content = '帖子正文',
  messageId = '22222',
  userId = '55555',
  attachmentQuery?: string,
) {
  discordReplies.length = 0
  const response = await interaction(
    postData(content, messageId, '保存帖子到SRL（云端暂存）', attachmentQuery),
    userId,
  )
  expect(await response.json()).toEqual({ type: 5, data: { flags: 64 } })
  const reply = discordReplies.at(-1)
  const token = reply?.components?.[0]?.components[0]?.url.split('/').at(-1)
  expect(token).toMatch(/^[A-Za-z0-9_-]{30,160}$/u)
  return token!
}
async function jobs(pair: Pair): Promise<{ jobs: Job[]; recent: Job[]; hasMore: boolean }> {
  const response = await request('/inbox/jobs', { headers: headers(pair) })
  expect(response.status).toBe(200)
  return response.json() as Promise<{ jobs: Job[]; recent: Job[]; hasMore: boolean }>
}

beforeAll(async () => {
  const keys = generateKeyPairSync('ed25519')
  signingKey = keys.privateKey
  publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex')
  const result = await build({
    entryPoints: [
      fileURLToPath(new URL('../../workers/discord-source-bridge/src/index.ts', import.meta.url)),
    ],
    bundle: true,
    write: false,
    format: 'esm',
    target: 'es2022',
    platform: 'browser',
  })
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString('base64')}`
  worker = ((await import(/* @vite-ignore */ moduleUrl)) as { default: Worker }).default
})
beforeEach(() => {
  database = new SqlD1()
  callbacks = []
  discordReplies = []
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: Request | URL | string, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.pathname.includes('/messages/@original')) {
        discordReplies.push(JSON.parse(String(init?.body)))
        return json({})
      }
      throw new Error(`unexpected outbound request: ${url}`)
    }),
  )
})
afterEach(async () => {
  await drain()
  database.sqlite.close()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Discord inbox Worker behavior', () => {
  it.each(['/source/read', '/source/messages/check'])(
    'removes %s without reading Discord or D1',
    async (path) => {
      const prepare = vi.spyOn(database, 'prepare')
      const response = await request(path, {
        method: 'POST',
        body: JSON.stringify({ channelId: '12345' }),
      })
      expect(response.status).toBe(404)
      expect(fetch).not.toHaveBeenCalled()
      expect(prepare).not.toHaveBeenCalled()
    },
  )
  it.each([400, 429])(
    'reports safe registration diagnostics for Discord HTTP %s',
    async (status) => {
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      vi.mocked(fetch).mockImplementation(async (_input, init) => {
        if (!init?.method || init.method === 'GET') return json([])
        return new Response(
          JSON.stringify({
            code: 50035,
            message: 'secret upstream message bot-token',
            errors: { name: { _errors: [{ message: 'private details' }] } },
            retry_after: 5.2,
          }),
          { status, headers: { 'Content-Type': 'application/json' } },
        )
      })
      const response = await request('/setup/register', {
        method: 'POST',
        headers: { Authorization: 'Bearer bot-token' },
        body: { applicationId: '12345' },
      })
      expect(response.status).toBe(502)
      const result = await response.json()
      expect(result.error).toContain(`HTTP ${status}`)
      expect(result.error).toContain('粘贴收件')
      expect(result.error).toContain('字段 name')
      expect(JSON.stringify(warning.mock.calls)).not.toContain('bot-token')
      expect(result.error).not.toContain('private')
      if (status === 429) expect(result.error).toContain('等待 6 秒')
    },
  )

  it.each([0, 1, 2])(
    'queues supported links pasted into the command in Discord context %s without saving the pasted post',
    async (context) => {
      const pair = await newPair()
      await bind(pair)
      const direct =
        'https://cdn.discordapp.com/attachments/12345/67890/role.png?ex=ffffffff&is=one&hm=one'
      const duplicate =
        'https://media.discordapp.net/attachments/12345/67890/role.png?ex=eeeeeeee&is=two&hm=two'
      const response = await interaction(
        {
          name: '粘贴收件',
          type: 1,
          options: [
            { name: '正文内容', type: 3, value: `Copied message: <${direct}> ${duplicate}` },
          ],
        },
        '55555',
        false,
        context,
      )
      expect(await response.json()).toEqual({ type: 5, data: { flags: 64 } })
      expect(discordReplies.at(-1)?.content).toContain('已将 1 个文件加入')
      expect(discordReplies.at(-1)?.content).not.toContain('Copied message')
      expect((await jobs(pair)).jobs).toHaveLength(0)
      const resources = await request('/inbox/resources', { headers: headers(pair) })
      expect((await resources.json()).jobs).toMatchObject([{ name: 'role.png', state: 'queued' }])
    },
  )

  it('accepts Discord attachment URL variants already supported by Android share import', async () => {
    const pair = await newPair()
    await bind(pair)
    const url =
      'https://cdn.discordapp.com/ephemeral-attachments/12345/67891/role-card.card?ex=ffffffff'
    await interaction(
      {
        name: '下载直链',
        type: 1,
        options: [{ name: '链接', type: 3, value: url }],
      },
      '55555',
    )
    expect(discordReplies.at(-1)?.content).toContain('已将 1 个文件加入')
    const resources = await request('/inbox/resources', { headers: headers(pair) })
    expect((await resources.json()).jobs).toMatchObject([
      { name: 'role-card.card', state: 'queued' },
    ])
  })

  it('continues registering the same command after Discord retry_after without retrying other failures', async () => {
    const writes: string[] = []
    let limited = false
    vi.mocked(fetch).mockImplementation(async (_input, init) => {
      if (!init?.method || init.method === 'GET') return json([])
      const name = JSON.parse(String(init.body)).name as string
      writes.push(name)
      if (name === '下载直链' && !limited) {
        limited = true
        return new Response(JSON.stringify({ retry_after: 0.01 }), { status: 429 })
      }
      return json({})
    })
    const response = await request('/setup/register', {
      method: 'POST',
      headers: { Authorization: 'Bearer bot-token' },
      body: { applicationId: '12345' },
    })
    expect(response.status).toBe(200)
    expect(writes.filter((name) => name === '下载直链')).toHaveLength(2)
    expect(writes.filter((name) => name === '粘贴收件')).toHaveLength(1)
  })

  it.each([false, true])(
    'migrates cloud command names without duplicating or deleting other commands (already renamed: %s)',
    async (alreadyRenamed) => {
      const commands = [
        { id: '1', name: '保存到资源库', type: 3 },
        { id: '2', name: '保存帖子到SRL', type: 3 },
        { id: '3', name: '下载资源到SRL', type: 3 },
        { id: '4', name: '另一个功能', type: 3 },
        { id: '7', name: '保存首楼帖子', type: 1 },
        { id: '8', name: '保存所有已标注信息', type: 1 },
        ...(alreadyRenamed
          ? [
              { id: '5', name: '保存帖子到SRL（云端暂存）', type: 3 },
              { id: '6', name: '下载资源到SRL（云端暂存）', type: 3 },
            ]
          : []),
      ]
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string, init?: RequestInit) => {
          if (input.endsWith('/oauth2/applications/@me'))
            return json({ id: '12345', verify_key: publicKey })
          expect(input).toContain('/applications/12345/commands')
          if (!init?.method || init.method === 'GET') return json(commands)
          const id = input.split('/').at(-1)
          if (init.method === 'DELETE') {
            commands.splice(
              commands.findIndex((command) => command.id === id),
              1,
            )
            return new Response(null, { status: 204 })
          }
          const value = JSON.parse(String(init.body))
          expect(value.integration_types).toEqual([1])
          expect(value.contexts).toEqual([0, 1, 2])
          const current = commands.find((command) =>
            init.method === 'PATCH'
              ? command.id === id
              : command.name === value.name && command.type === value.type,
          )
          if (current) Object.assign(current, value)
          else commands.push({ id: String(10 + commands.length), ...value })
          return json(value)
        }),
      )
      const register = () =>
        request('/setup/register', {
          method: 'POST',
          headers: { Authorization: 'Bearer bot-token' },
          body: { applicationId: '12345' },
        })
      expect((await register()).status).toBe(200)
      vi.mocked(fetch).mockClear()
      expect((await register()).status).toBe(200)
      expect(
        vi
          .mocked(fetch)
          .mock.calls.filter(([, init]) => init?.method === 'POST' || init?.method === 'PATCH'),
      ).toHaveLength(0)
      expect(commands.map((command) => command.name).sort()).toEqual(
        [
          '保存到资源库',
          '保存帖子到SRL（云端暂存）',
          '下载资源到SRL（云端暂存）',
          '下载直链',
          '绑定资源库',
          '粘贴收件',
          '另一个功能',
        ].sort(),
      )
      expect(commands.find((command) => command.name === '另一个功能')).toEqual({
        id: '4',
        name: '另一个功能',
        type: 3,
      })
      if (!alreadyRenamed)
        expect(commands.find((command) => command.name === '保存帖子到SRL（云端暂存）')?.id).toBe(
          '2',
        )
      const status = await request('/setup/status', {
        headers: { Authorization: 'Bearer bot-token' },
      })
      expect((await status.json()).commandRegistered).toBe(true)
    },
  )

  it('accepts an old cloud command already cached in Discord after its registered name changes', async () => {
    const pair = await newPair()
    await bind(pair)
    await interaction(postData('旧客户端暂存', '22222', '保存帖子到SRL'))
    expect((await jobs(pair)).jobs).toHaveLength(1)
  })

  it('queues resources separately, pins the paired target and deduplicates refreshed Discord URLs', async () => {
    const first = await newPair('手机')
    await bind(first)
    const data = postData('', '22222', '下载资源到SRL（云端暂存）', '?ex=ffffffff&is=one&hm=one')
    await interaction(data)
    expect(discordReplies.at(-1)?.content).toContain('手机')
    expect((await jobs(first)).jobs).toHaveLength(0)
    const resources = async (pair: Pair) =>
      (await request('/inbox/resources', { headers: headers(pair) })).json() as Promise<{
        jobs: Job[]
      }>
    const initial = await resources(first)
    expect(initial.jobs).toHaveLength(1)
    await interaction(
      postData(
        '文字改动不产生重复附件',
        '22222',
        '下载资源到SRL（云端暂存）',
        '?ex=ffffffff&is=two&hm=two',
      ),
    )
    expect((await resources(first)).jobs[0]?.id).toBe(initial.jobs[0]?.id)
    const second = await newPair('平板')
    await bind(second)
    await interaction(data)
    expect((await resources(second)).jobs).toHaveLength(1)
    const id = initial.jobs[0]!.id
    expect((await request(`/inbox/resources/${id}`, { headers: headers(second) })).status).toBe(404)
    expect(
      (
        await request(`/inbox/resources/${id}/ack`, {
          method: 'POST',
          headers: headers(second),
          body: { state: 'imported' },
        })
      ).status,
    ).toBe(404)
    const file = await request(`/inbox/resources/${id}`, { headers: headers(first) })
    expect(file.status).toBe(200)
    expect(((await file.json()) as { url: string }).url).toContain('is=two')
  })

  it('cancels only unfinished resource transfers and deletes only terminal records', async () => {
    const pair = await newPair()
    await bind(pair)
    await interaction(postData('', '22222', '下载资源到SRL（云端暂存）', '?ex=ffffffff'))
    const listing = (await (
      await request('/inbox/resources', { headers: headers(pair) })
    ).json()) as {
      jobs: Job[]
    }
    const id = listing.jobs[0]!.id
    const queuedCancel = await request(`/inbox/resources/${id}/ack`, {
      method: 'POST',
      headers: headers(pair),
      body: { state: 'cancelled' },
    })
    expect(queuedCancel.status).toBe(200)
    expect(
      (
        await request(`/inbox/resources/${id}`, {
          method: 'DELETE',
          headers: headers(pair),
        })
      ).status,
    ).toBe(200)
    expect(
      (await (await request('/inbox/resources', { headers: headers(pair) })).json()).recent,
    ).toHaveLength(0)

    await interaction(postData('', '33334', '下载资源到SRL（云端暂存）', '?ex=ffffffff'))
    const next = (await (await request('/inbox/resources', { headers: headers(pair) })).json()) as {
      jobs: Job[]
    }
    const activeId = next.jobs[0]!.id
    database.sqlite
      .prepare("UPDATE inbox_resources SET state = 'importing' WHERE id = ?")
      .run(activeId)
    expect(
      (
        await request(`/inbox/resources/${activeId}/ack`, {
          method: 'POST',
          headers: headers(pair),
          body: { state: 'cancelled' },
        })
      ).status,
    ).toBe(409)
    expect(
      (
        await request(`/inbox/resources/${activeId}`, {
          method: 'DELETE',
          headers: headers(pair),
        })
      ).status,
    ).toBe(409)
  })

  it('cleans terminal cloud records for only the paired library and leaves active work intact', async () => {
    const pair = await newPair('手机')
    const other = await newPair('平板')
    const now = Date.now()
    const insertResource = (id: string, library: string, state: string) =>
      database.sqlite
        .prepare(
          'INSERT INTO inbox_resources (id,library_id,fingerprint,channel_id,message_id,url,name,size,state,created_at,updated_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          library,
          `fingerprint-${id}`,
          '',
          '',
          '',
          `${state}.png`,
          1,
          state,
          now,
          now,
          now + 60_000,
        )
    const insertDelivery = (id: string, library: string, state: string, hash: string) => {
      database.sqlite
        .prepare(
          'INSERT INTO inbox_deliveries (id,handoff_token_hash,library_id,claimed_library_id,dedupe_scope,fingerprint,source_key_hash,state,title,created_at,expires_at,acknowledged_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          hash,
          library,
          state === 'pending' ? null : library,
          `scope-${id}`,
          `fingerprint-${id}`,
          `source-${id}`,
          state,
          id,
          now,
          now + 60_000,
          state === 'pending' ? null : now,
        )
      database.sqlite
        .prepare('INSERT INTO handoffs (token_hash,payload,created_at,expires_at) VALUES (?,?,?,?)')
        .run(hash, 'payload', now, now + 60_000)
      database.sqlite
        .prepare('INSERT INTO handoffs (token_hash,payload,created_at,expires_at) VALUES (?,?,?,?)')
        .run(`${hash}:chunk:1`, 'chunk', now, now + 60_000)
    }
    await bind(pair)
    await bind(other, '66666')
    insertResource('11111111-1111-4111-a111-111111111111', pair.libraryId, 'imported')
    insertResource('22222222-2222-4222-a222-222222222222', pair.libraryId, 'failed')
    insertResource('33333333-3333-4333-a333-333333333333', pair.libraryId, 'downloading')
    insertResource('44444444-4444-4444-a444-444444444444', other.libraryId, 'imported')
    insertDelivery('saved-delivery', pair.libraryId, 'saved', 'a'.repeat(64))
    insertDelivery('waiting-delivery', pair.libraryId, 'waiting_binding', 'b'.repeat(64))
    insertDelivery('pending-delivery', pair.libraryId, 'pending', 'c'.repeat(64))
    insertDelivery('other-delivery', other.libraryId, 'saved', 'd'.repeat(64))
    expect(pair.libraryId).not.toBe(other.libraryId)
    expect(
      database.sqlite
        .prepare('SELECT claimed_library_id FROM inbox_deliveries WHERE id = ?')
        .get('other-delivery'),
    ).toEqual({ claimed_library_id: other.libraryId })
    expect(
      database.sqlite
        .prepare('SELECT token_hash FROM handoffs WHERE token_hash = ?')
        .get('d'.repeat(64)),
    ).toEqual({
      token_hash: 'd'.repeat(64),
    })
    expect(
      database.sqlite
        .prepare(
          "SELECT handoff_token_hash FROM inbox_deliveries WHERE claimed_library_id = ? AND state IN ('saved','waiting_binding') AND expires_at > ?",
        )
        .all(pair.libraryId, now),
    ).toEqual([{ handoff_token_hash: 'a'.repeat(64) }, { handoff_token_hash: 'b'.repeat(64) }])

    const response = await request('/inbox/cleanup', { method: 'DELETE', headers: headers(pair) })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ posts: 2, resources: 1 })
    expect(database.sqlite.prepare('SELECT id FROM inbox_deliveries ORDER BY id').all()).toEqual([
      { id: 'other-delivery' },
      { id: 'pending-delivery' },
    ])
    expect(database.sqlite.prepare('SELECT id FROM inbox_resources ORDER BY id').all()).toEqual([
      { id: '22222222-2222-4222-a222-222222222222' },
      { id: '33333333-3333-4333-a333-333333333333' },
      { id: '44444444-4444-4444-a444-444444444444' },
    ])
    expect(
      database.sqlite.prepare('SELECT token_hash FROM handoffs ORDER BY token_hash').all(),
    ).toEqual([{ token_hash: 'c'.repeat(64) }, { token_hash: `${'c'.repeat(64)}:chunk:1` }])
  })

  it('cleans only the selected cloud history category', async () => {
    const pair = await newPair()
    await bind(pair)
    const now = Date.now()
    database.sqlite
      .prepare(
        'INSERT INTO inbox_resources (id,library_id,fingerprint,channel_id,message_id,url,name,size,state,created_at,updated_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        '11111111-1111-4111-a111-111111111111',
        pair.libraryId,
        'resource-fingerprint',
        '',
        '',
        '',
        'done.png',
        1,
        'imported',
        now,
        now,
        now + 60_000,
      )
    database.sqlite
      .prepare(
        'INSERT INTO inbox_deliveries (id,handoff_token_hash,library_id,claimed_library_id,dedupe_scope,fingerprint,source_key_hash,state,title,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        'saved-post',
        'a'.repeat(64),
        pair.libraryId,
        pair.libraryId,
        'post-scope',
        'post-fingerprint',
        'post-source',
        'saved',
        '已保存帖子',
        now,
        now + 60_000,
      )

    const posts = await request('/inbox/cleanup-scoped', {
      method: 'DELETE',
      headers: headers(pair),
      body: { scope: 'posts' },
    })
    expect(posts.status).toBe(200)
    expect(await posts.json()).toMatchObject({ posts: 1, resources: 0 })
    expect(database.sqlite.prepare('SELECT id FROM inbox_resources').all()).toHaveLength(1)

    const resources = await request('/inbox/cleanup-scoped', {
      method: 'DELETE',
      headers: headers(pair),
      body: { scope: 'resources' },
    })
    expect(resources.status).toBe(200)
    expect(await resources.json()).toMatchObject({ posts: 0, resources: 1 })
    expect(database.sqlite.prepare('SELECT id FROM inbox_resources').all()).toHaveLength(0)
  })

  it('rejects an unknown scoped cleanup category', async () => {
    const pair = await newPair()
    await bind(pair)
    const response = await request('/inbox/cleanup-scoped', {
      method: 'DELETE',
      headers: headers(pair),
      body: { scope: 'everything' },
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_cleanup_scope' })
  })

  it('cancels an unclaimed post and removes its cloud payload without touching another task', async () => {
    const pair = await newPair()
    await bind(pair)
    const payloadHash = 'e'.repeat(64)
    const otherHash = 'f'.repeat(64)
    const now = Date.now()
    const insertPending = (id: string, hash: string) => {
      database.sqlite
        .prepare(
          "INSERT INTO inbox_deliveries (id,handoff_token_hash,library_id,claimed_library_id,dedupe_scope,fingerprint,source_key_hash,state,title,created_at,expires_at) VALUES (?,?,?,NULL,?,?,?,'pending',?,?,?)",
        )
        .run(
          id,
          hash,
          pair.libraryId,
          `scope-${id}`,
          `fingerprint-${id}`,
          `source-${id}`,
          id,
          now,
          now + 60_000,
        )
      database.sqlite
        .prepare('INSERT INTO handoffs (token_hash,payload,created_at,expires_at) VALUES (?,?,?,?)')
        .run(hash, 'payload', now, now + 60_000)
      database.sqlite
        .prepare('INSERT INTO handoffs (token_hash,payload,created_at,expires_at) VALUES (?,?,?,?)')
        .run(`${hash}:chunk:1`, 'chunk', now, now + 60_000)
    }
    insertPending('cancel-one', payloadHash)
    insertPending('keep-two', otherHash)
    const response = await request('/inbox/jobs/cancel-one', {
      method: 'DELETE',
      headers: headers(pair),
    })
    expect(response.status).toBe(200)
    expect(database.sqlite.prepare('SELECT id FROM inbox_deliveries').all()).toEqual([
      { id: 'keep-two' },
    ])
    expect(
      database.sqlite.prepare('SELECT token_hash FROM handoffs ORDER BY token_hash').all(),
    ).toEqual([{ token_hash: otherHash }, { token_hash: `${otherHash}:chunk:1` }])
  })

  it('routes signed direct-link commands through the paired queue and shares message-command deduplication', async () => {
    const direct = (url: string) =>
      interaction({ name: '下载直链', type: 1, options: [{ name: '链接', type: 3, value: url }] })
    const url = 'https://cdn.discordapp.com/attachments/33333/88888/card.png?ex=ffffffff'
    await direct(url)
    expect(discordReplies.at(-1)?.content).toContain('先在资源库生成配对码')
    const pair = await newPair()
    await bind(pair)
    const response = await direct(url)
    expect(await response.json()).toEqual({ type: 5, data: { flags: 64 } })
    const initial = await (await request('/inbox/resources', { headers: headers(pair) })).json()
    expect(initial.jobs).toHaveLength(1)
    const id = initial.jobs[0].id
    expect(
      database.sqlite
        .prepare('SELECT channel_id, message_id FROM inbox_resources WHERE id = ?')
        .get(id),
    ).toEqual({ channel_id: '', message_id: '' })
    await interaction(postData('', '22222', '下载资源到SRL（云端暂存）', '?ex=ffffffff'))
    await direct(url.replace('cdn.discordapp.com', 'media.discordapp.net'))
    expect(
      (await (await request('/inbox/resources', { headers: headers(pair) })).json()).jobs,
    ).toHaveLength(1)
    expect(
      database.sqlite
        .prepare('SELECT channel_id, message_id FROM inbox_resources WHERE id = ?')
        .get(id),
    ).toEqual({ channel_id: '33333', message_id: '22222' })
    expect(
      database.sqlite.prepare('SELECT COUNT(*) AS count FROM inbox_deliveries').get()?.count,
    ).toBe(0)
    await request(`/inbox/resources/${id}/ack`, {
      method: 'POST',
      headers: headers(pair),
      body: { state: 'imported' },
    })
    await direct(url)
    expect(discordReplies.at(-1)?.content).toContain('没有重复创建资源')
    const second = await newPair('另一份库')
    await bind(second)
    await direct(url)
    expect(
      (await (await request('/inbox/resources', { headers: headers(second) })).json()).jobs,
    ).toHaveLength(1)
    expect((await request(`/inbox/resources/${id}`, { headers: headers(second) })).status).toBe(404)
  })

  it('rejects invalid slash URLs and explains expired ephemeral links without trying to read a message', async () => {
    const pair = await newPair()
    await bind(pair)
    for (const value of [
      undefined,
      42,
      'https://discord.com/channels/11111/33333/22222',
      'https://127.0.0.1/card.json',
      'https://cdn.discordapp.com.evil.example/attachments/33333/88888/card.json',
    ]) {
      await interaction({ name: '下载直链', type: 1, options: [{ name: '链接', type: 3, value }] })
      expect(discordReplies.at(-1)?.content).toContain('没有找到')
    }
    expect(
      database.sqlite.prepare('SELECT COUNT(*) AS count FROM inbox_resources').get()?.count,
    ).toBe(0)
    await interaction({
      name: '下载直链',
      type: 1,
      options: [
        {
          name: '链接',
          type: 3,
          value: 'https://cdn.discordapp.com/attachments/33333/88888/card.png?ex=1',
        },
      ],
    })
    const listing = await (await request('/inbox/resources', { headers: headers(pair) })).json()
    vi.mocked(fetch).mockClear()
    const response = await request(`/inbox/resources/${listing.jobs[0].id}/file`, {
      headers: headers(pair),
    })
    expect(response.status).toBe(410)
    expect((await response.json()).error).toContain('/下载直链')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('pages past unfinished first-page resources without skipping equal-timestamp tasks or exposing another library', async () => {
    const pair = await newPair()
    await bind(pair)
    const createdAt = Date.now()
    const insert = database.sqlite.prepare(
      'INSERT INTO inbox_resources (id, library_id, fingerprint, channel_id, message_id, url, name, size, state, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    for (let i = 0; i < 65; i++)
      insert.run(
        `00000000-0000-4000-a000-${i.toString(16).padStart(12, '0')}`,
        pair.libraryId,
        `fp-${i}`,
        '',
        '',
        'https://cdn.discordapp.com/attachments/33333/88888/card.json',
        'card.json',
        4,
        i < 20 ? 'waiting_version' : 'queued',
        createdAt,
        createdAt,
        createdAt + 60_000,
      )
    const seen = new Set<string>()
    let cursor = ''
    for (let page = 0; page < 4; page++) {
      const payload = await (
        await request(`/inbox/resources${cursor ? '?after=' + encodeURIComponent(cursor) : ''}`, {
          headers: headers(pair),
        })
      ).json()
      for (const job of payload.jobs) {
        expect(seen.has(job.id)).toBe(false)
        seen.add(job.id)
      }
      const last = payload.jobs.at(-1)
      cursor = `${last.createdAt}:${last.id}`
      expect(payload.hasMore).toBe(page < 3)
    }
    expect(seen.size).toBe(65)
    expect(
      (await request('/inbox/resources?after=invalid', { headers: headers(pair) })).status,
    ).toBe(400)
    const other = await newPair('其它库')
    expect(
      (
        await (
          await request(`/inbox/resources?after=${encodeURIComponent(cursor)}`, {
            headers: headers(other),
          })
        ).json()
      ).jobs,
    ).toHaveLength(0)
  })
  it('pages posts past an unchanged pending first page with equal timestamps and library isolation', async () => {
    const pair = await newPair()
    await bind(pair)
    const now = Date.now()
    const insert = database.sqlite.prepare(
      "INSERT INTO inbox_deliveries (id,handoff_token_hash,library_id,dedupe_scope,fingerprint,source_key_hash,state,title,created_at,expires_at) VALUES (?,?,?,?,?,?,'pending',?,?,?)",
    )
    for (let i = 0; i < 45; i++) {
      const id = `00000000-0000-4000-a000-${i.toString(16).padStart(12, '0')}`
      insert.run(
        id,
        `hash-${i}`,
        pair.libraryId,
        `scope-${i}`,
        `fp-${i}`,
        `source-${i}`,
        id,
        now,
        now + 60_000,
      )
    }
    let cursor = ''
    const ids = new Set<string>()
    for (let page = 0; page < 3; page++) {
      const payload = await (
        await request(`/inbox/jobs${cursor ? '?after=' + encodeURIComponent(cursor) : ''}`, {
          headers: headers(pair),
        })
      ).json()
      for (const job of payload.jobs) {
        expect(ids.has(job.id)).toBe(false)
        ids.add(job.id)
      }
      const last = payload.jobs.at(-1)
      cursor = `${last.createdAt}:${last.id}`
      expect(payload.hasMore).toBe(page < 2)
    }
    expect(ids.size).toBe(45)
    expect((await request('/inbox/jobs?after=invalid', { headers: headers(pair) })).status).toBe(
      400,
    )
    const other = await newPair('其它库')
    expect(
      (
        await (
          await request(`/inbox/jobs?after=${encodeURIComponent(cursor)}`, {
            headers: headers(other),
          })
        ).json()
      ).jobs,
    ).toHaveLength(0)
    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) AS n FROM inbox_deliveries WHERE state='pending'")
        .get()?.n,
    ).toBe(45)
  })

  it('rejects unpaired resource jobs and arbitrary external/private download addresses', async () => {
    await interaction(postData('', '22222', '下载资源到SRL（云端暂存）'))
    expect(discordReplies.at(-1)?.content).toContain('先在资源库生成配对码')
    expect(
      database.sqlite.prepare('SELECT COUNT(*) AS count FROM inbox_resources').get()?.count,
    ).toBe(0)
    const pair = await newPair()
    await bind(pair)
    const data = postData(
      'https://127.0.0.1/internal.json https://cdn.discordapp.com.evil.example/attachments/33333/88888/card.json',
      '22222',
      '下载资源到SRL（云端暂存）',
    )
    data.resolved.messages['22222']!.attachments = []
    await interaction(data)
    expect(discordReplies.at(-1)?.content).toContain('没有找到')
    await interaction(
      postData(
        '<https://cdn.discordapp.com/attachments/33333/99999/config.json?ex=ffffffff>',
        '22222',
        '下载资源到SRL（云端暂存）',
        '?ex=ffffffff',
      ),
    )
    const response = await request('/inbox/resources', { headers: headers(pair) })
    expect(((await response.json()) as { jobs: Job[] }).jobs).toHaveLength(2)
  })

  it('keeps import receipts monotonic and retains failed/cancelled tasks for explicit retry', async () => {
    const pair = await newPair()
    await bind(pair)
    await interaction(postData('', '22222', '下载资源到SRL（云端暂存）', '?ex=ffffffff'))
    const listing = (await (
      await request('/inbox/resources', { headers: headers(pair) })
    ).json()) as { jobs: Job[] }
    const id = listing.jobs[0]!.id
    const ack = (state: string) =>
      request(`/inbox/resources/${id}/ack`, {
        method: 'POST',
        headers: headers(pair),
        body: { state },
      })
    expect((await ack('waiting_version')).status).toBe(200)
    const stored = () =>
      database.sqlite.prepare('SELECT * FROM inbox_resources WHERE id = ?').get(id)
    expect(stored()).toMatchObject({ channel_id: '33333', message_id: '22222' })
    expect(stored()?.url).toContain('cdn.discordapp.com')
    expect((await ack('not-valid')).status).toBe(400)
    expect((await ack('failed')).status).toBe(200)
    expect(
      (
        (await (await request('/inbox/resources', { headers: headers(pair) })).json()) as {
          jobs: Job[]
        }
      ).jobs,
    ).toHaveLength(0)
    await ack('queued')
    await ack('imported')
    expect(stored()).toMatchObject({
      state: 'imported',
      url: '',
      channel_id: '',
      message_id: '',
      error: null,
    })
    expect((await request(`/inbox/resources/${id}/file`, { headers: headers(pair) })).status).toBe(
      409,
    )
    await ack('failed')
    await ack('queued')
    const final = (await (
      await request('/inbox/resources', { headers: headers(pair) })
    ).json()) as { recent: Job[] }
    expect(final.recent[0]?.state).toBe('imported')
    await interaction(postData('', '22222', '下载资源到SRL（云端暂存）', '?ex=ffffffff&hm=new'))
    expect(discordReplies.at(-1)?.content).toContain('没有重复创建资源')
    expect(stored()).toMatchObject({ state: 'imported', url: '', channel_id: '', message_id: '' })
    database.sqlite
      .prepare('UPDATE inbox_resources SET expires_at = ? WHERE id = ?')
      .run(Date.now() - 1, id)
    await interaction(postData('', '22222', '下载资源到SRL（云端暂存）', '?ex=ffffffff&hm=reshare'))
    const renewed = database.sqlite.prepare('SELECT * FROM inbox_resources').get()
    expect(renewed).toMatchObject({ state: 'queued', channel_id: '33333', message_id: '22222' })
    expect(renewed?.url).toContain('hm=reshare')
  })

  it('retains resource links when a successful import acknowledgement cannot commit', async () => {
    const pair = await newPair()
    await bind(pair)
    await interaction(postData('', '22222', '下载资源到SRL（云端暂存）', '?ex=ffffffff'))
    const before = database.sqlite.prepare('SELECT * FROM inbox_resources').get()!
    database.sqlite.exec(
      "CREATE TRIGGER fail_resource_purge BEFORE UPDATE ON inbox_resources WHEN NEW.url = '' BEGIN SELECT RAISE(ABORT, 'simulated cleanup failure'); END",
    )
    const response = await request(`/inbox/resources/${before.id}/ack`, {
      method: 'POST',
      headers: headers(pair),
      body: { state: 'imported' },
    })
    expect(response.status).toBe(503)
    expect(database.sqlite.prepare('SELECT * FROM inbox_resources').get()).toEqual(before)
  })

  it('refreshes expired attachment signatures only from the selected message and streams files without credentials', async () => {
    const pair = await newPair()
    await bind(pair)
    await interaction(postData('', '22222', '下载资源到SRL（云端暂存）', '?ex=1&hm=old'))
    const listing = (await (
      await request('/inbox/resources', { headers: headers(pair) })
    ).json()) as { jobs: Job[] }
    const fetcher = vi.mocked(fetch)
    fetcher.mockImplementation(async (input, options) => {
      const url = String(input)
      if (url === 'https://discord.com/api/v10/channels/33333/messages/22222') {
        expect(options?.redirect).toBe('manual')
        expect(options?.headers).toEqual({ Authorization: 'Bot bot-token' })
        return json(
          postData('', '22222', '下载资源到SRL（云端暂存）', '?ex=ffffffff&hm=fresh').resolved
            .messages['22222'],
        )
      }
      if (url.includes('cdn.discordapp.com/attachments/33333/88888/card.png')) {
        expect(url).toContain('hm=fresh')
        expect(options?.redirect).toBe('manual')
        expect(JSON.stringify(options)).not.toContain(pair.secret)
        expect(JSON.stringify(options)).not.toContain('bot-token')
        return new Response('PNG-fixture', {
          headers: { 'Content-Type': 'image/png', 'Content-Length': '11' },
        })
      }
      throw new Error('unexpected fetch')
    })
    const response = await request(`/inbox/resources/${listing.jobs[0]!.id}/file`, {
      headers: headers(pair),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).toBe('PNG-fixture')
    fetcher.mockResolvedValue(new Response('', { status: 403 }))
    expect(
      (await request(`/inbox/resources/${listing.jobs[0]!.id}`, { headers: headers(pair) })).status,
    ).toBe(410)
  })

  it('records the failing download stage without logging links or credentials', async () => {
    const pair = await newPair()
    await bind(pair)
    await interaction(postData('', '22222', '下载资源到SRL（云端暂存）', '?ex=ffffffff'))
    const listing = (await (
      await request('/inbox/resources', { headers: headers(pair) })
    ).json()) as { jobs: Array<{ id: string }> }
    const errorLog = vi.spyOn(console, 'error')
    vi.mocked(fetch).mockRejectedValue(
      new TypeError(
        `Failed fetch https://cdn.discordapp.com/attachments/33333/88888/card.png?hm=private-signature bot-token ${pair.secret}`,
      ),
    )
    const response = await request(`/inbox/resources/${listing.jobs[0]!.id}/file`, {
      headers: headers(pair),
    })
    expect(response.status).toBe(503)
    expect(errorLog).toHaveBeenCalledWith(
      'Discord resource request failed',
      expect.objectContaining({ stage: 'download_attachment', name: 'TypeError' }),
    )
    const output = JSON.stringify(errorLog.mock.calls)
    expect(output).not.toContain('private-signature')
    expect(output).not.toContain('bot-token')
    expect(output).not.toContain(pair.secret)
  })

  it.each([200, 302])(
    'uses the supported edge redirect mode and does not follow CDN redirects (status %s)',
    async (status) => {
      const pair = await newPair()
      await bind(pair)
      await interaction(postData('', '22222', '下载资源到SRL（云端暂存）', '?ex=ffffffff'))
      const listing = (await (
        await request('/inbox/resources', { headers: headers(pair) })
      ).json()) as { jobs: Array<{ id: string }> }
      const fetcher = vi.mocked(fetch)
      fetcher.mockClear()
      fetcher.mockImplementation(async (_input, init) => {
        if (init?.redirect === 'error')
          throw new TypeError('Invalid redirect value, must be one of follow or manual')
        expect(init?.redirect).toBe('manual')
        expect(JSON.stringify(init)).not.toContain(pair.secret)
        expect(JSON.stringify(init)).not.toContain('bot-token')
        return new Response('PNG-fixture', {
          status,
          headers: { 'Content-Type': 'image/png', Location: 'https://example.com/redirect' },
        })
      })
      const response = await request(`/inbox/resources/${listing.jobs[0]!.id}/file`, {
        headers: headers(pair),
      })
      expect(response.status).toBe(status === 200 ? 200 : 502)
      if (status === 200) expect(await response.text()).toBe('PNG-fixture')
      expect(fetcher).toHaveBeenCalledTimes(1)
    },
  )

  it.each([200, 302])(
    'reads TXT attachments with manual redirects and preserves rejected attachment metadata (status %s)',
    async (status) => {
      const pair = await newPair()
      await bind(pair)
      const original = vi.mocked(fetch).getMockImplementation()!
      const fetcher = vi.fn(async (input: Request | URL | string, init?: RequestInit) => {
        if (String(input).includes('/card.txt')) {
          expect(init?.redirect).toBe('manual')
          return new Response('文本附件内容', {
            status,
            headers: { 'Content-Type': 'text/plain', Location: 'https://example.com/redirect' },
          })
        }
        return original(input, init)
      })
      vi.stubGlobal('fetch', fetcher)
      const data = postData()
      data.resolved.messages['22222']!.attachments[0]!.filename = 'card.txt'
      data.resolved.messages['22222']!.attachments[0]!.url =
        'https://cdn.discordapp.com/attachments/33333/88888/card.txt'
      await interaction(data)
      const link = discordReplies.at(-1)?.components?.[0]?.components[0]?.url
      expect(link).toBeDefined()
      const token = new URL(link!).pathname.split('/').at(-1)
      const response = await request(`/handoff/${token}`, { headers: headers(pair) })
      const payload = await response.json()
      expect(payload.capture.attachments[0].name).toBe('card.txt')
      expect(payload.capture.attachments[0].textContent).toBe(
        status === 200 ? '文本附件内容' : undefined,
      )
      expect(
        fetcher.mock.calls.filter(([input]) => String(input).includes('/card.txt')),
      ).toHaveLength(1)
    },
  )

  it('derives the resource migration and Dashboard schema from the same statements', async () => {
    const migration = readFileSync(
      fileURLToPath(
        new URL(
          '../../workers/discord-source-bridge/migrations/0003_resources.sql',
          import.meta.url,
        ),
      ),
      'utf8',
    )
    const normalize = (sql: string) =>
      sql
        .replace(/^--.*$/gmu, '')
        .replace(/\s+/gu, ' ')
        .trim()
    expect(normalize(migration)).toBe(
      normalize(DISCORD_RESOURCE_SCHEMA.map((sql) => sql + ';').join('\n')),
    )
    expect(await buildDiscordManualWorkerSource()).toContain(
      'CREATE TABLE IF NOT EXISTS inbox_resources',
    )
  })
  it('pairs once using the signed invoking user, stores credential hashes, and keeps earlier queued posts on their original endpoint', async () => {
    const first = await newPair('旧手机')
    expect(
      (await (await request('/inbox/status', { headers: headers(first) })).json()).paired,
    ).toBe(false)
    await bind(first, '55555', true)
    const oldToken = await savePost()
    const second = await newPair('新手机')
    await bind(second)
    expect(
      await (await request('/inbox/status', { headers: headers(second) })).json(),
    ).toMatchObject({ paired: true, name: '新手机', expiresInDays: 7 })
    expect(
      await (await request('/inbox/status', { headers: headers(first) })).json(),
    ).toMatchObject({ paired: true, isDefault: false })
    expect((await jobs(first)).jobs).toHaveLength(1)
    const oldDelivery = await (
      await request(`/handoff/${oldToken}`, { headers: headers(first) })
    ).json()
    await request(`/inbox/jobs/${oldDelivery.delivery.id}/ack`, {
      method: 'POST',
      headers: headers(first),
      body: { state: 'saved' },
    })
    expect((await jobs(first)).recent[0]?.state).toBe('saved')
    await bind(second, '66666')
    expect(discordReplies.at(-1)?.content).toContain('配对码')
    expect(
      database.sqlite
        .prepare('SELECT discord_user_id FROM inbox_endpoints WHERE library_id = ?')
        .get(second.libraryId)?.discord_user_id,
    ).toBe('55555')
    const newToken = await savePost('新投递')
    expect((await jobs(second)).jobs).toHaveLength(1)
    const status = await (await request(`/handoff/${oldToken}/status`)).json()
    expect(status.libraryName).toBe('旧手机')
    expect((await request(`/handoff/${newToken}`, { headers: headers(second) })).status).toBe(200)
    const endpoint = database.sqlite
      .prepare('SELECT secret_hash FROM inbox_endpoints WHERE library_id = ?')
      .get(second.libraryId)
    expect(endpoint?.secret_hash).not.toBe(second.secret)
    expect(
      database.sqlite
        .prepare('SELECT code_hash FROM inbox_pair_codes WHERE library_id = ?')
        .get(second.libraryId)?.code_hash,
    ).not.toBe(second.code)
  })

  it('keeps the same snapshot in one task across repeated and concurrent saves, but creates a task for edited content', async () => {
    const pair = await newPair()
    await bind(pair)
    const first = await savePost()
    const repeated = await savePost('帖子正文', '22222', '55555', '?hm=new&is=new&ex=new')
    const original = await (await request(`/handoff/${first}`, { headers: headers(pair) })).json()
    const alias = await (await request(`/handoff/${repeated}`, { headers: headers(pair) })).json()
    expect(alias.delivery.id).toBe(original.delivery.id)
    expect((await jobs(pair)).jobs).toHaveLength(1)
    await Promise.all([
      interaction(postData('并发正文', '99999')),
      interaction(postData('并发正文', '99999')),
    ])
    expect((await jobs(pair)).jobs).toHaveLength(2)
    await savePost('已编辑正文')
    expect((await jobs(pair)).jobs).toHaveLength(3)
    expect(alias.capture.content).toBe('帖子正文')
  })

  it('does not consume payload on reads or failed ACK; receipts leave the pending queue and only advance', async () => {
    const pair = await newPair()
    await bind(pair)
    const token = await savePost()
    const first = await (await request(`/handoff/${token}`, { headers: headers(pair) })).json()
    const again = await (await request(`/handoff/${token}`, { headers: headers(pair) })).json()
    expect(again).toEqual(first)
    expect(first.delivery.capturedAt).toBeGreaterThan(Date.parse(first.capture.timestamp))
    database.failNextAcknowledgement = true
    expect(
      (
        await request(`/inbox/jobs/${first.delivery.id}/ack`, {
          method: 'POST',
          headers: headers(pair),
          body: { state: 'waiting_binding' },
        })
      ).status,
    ).toBe(503)
    expect((await jobs(pair)).jobs).toHaveLength(1)
    expect(
      (await request(`/inbox/jobs/${first.delivery.id}`, { headers: headers(pair) })).status,
    ).toBe(200)
    expect(
      (
        await request(`/handoff/${token}/ack`, {
          method: 'POST',
          headers: headers(pair),
          body: { libraryId: pair.libraryId, state: 'waiting_binding' },
        })
      ).status,
    ).toBe(200)
    expect((await jobs(pair)).jobs).toHaveLength(0)
    expect((await jobs(pair)).recent[0]?.state).toBe('waiting_binding')
    await request(`/inbox/jobs/${first.delivery.id}/ack`, {
      method: 'POST',
      headers: headers(pair),
      body: { state: 'saved' },
    })
    await request(`/inbox/jobs/${first.delivery.id}/ack`, {
      method: 'POST',
      headers: headers(pair),
      body: { state: 'waiting_binding' },
    })
    expect((await jobs(pair)).recent[0]?.state).toBe('saved')
    expect((await request(`/handoff/${token}`, { headers: headers(pair) })).status).toBe(409)
    await savePost()
    expect(discordReplies.at(-1)?.content).toContain('已保存')
    expect((await jobs(pair)).jobs).toHaveLength(0)
  })

  it('isolates endpoints and rejects leaked tokens or Bot Token as queue authorization', async () => {
    const first = await newPair()
    const second = await newPair('另一用户')
    await bind(first)
    await bind(second, '66666')
    const token = await savePost()
    expect((await request(`/handoff/${token}`)).status).toBe(401)
    expect((await request(`/handoff/${token}`, { headers: headers(second) })).status).toBe(409)
    expect(
      (
        await request(`/handoff/${token}/ack`, {
          method: 'POST',
          body: { libraryId: first.libraryId, state: 'saved' },
        })
      ).status,
    ).toBe(401)
    expect(
      (
        await request('/inbox/jobs', {
          headers: { Authorization: 'Bearer bot-token', 'X-SRL-Library-ID': first.libraryId },
        })
      ).status,
    ).toBe(401)
    const item = (await jobs(first)).jobs[0]!
    expect((await request(`/inbox/jobs/${item.id}`, { headers: headers(second) })).status).toBe(404)
    expect((await jobs(first)).jobs).toHaveLength(1)
    expect((await jobs(second)).jobs).toHaveLength(0)
  })

  it('atomically clears acknowledged post bodies, aliases and chunks while keeping receipts and other pending posts', async () => {
    const pair = await newPair()
    await bind(pair)
    const content = '大'.repeat(700_000)
    const token = await savePost(content)
    const alias = await savePost(content)
    const other = await savePost('另一条待领取正文', '33334')
    const delivery = database.sqlite
      .prepare('SELECT * FROM inbox_deliveries WHERE title <> ?')
      .get('另一条待领取正文')!
    expect(
      database.sqlite
        .prepare("SELECT count(*) AS count FROM handoffs WHERE token_hash LIKE '%:chunk:%'")
        .get()?.count,
    ).toBeGreaterThan(0)
    const before = database.sqlite.prepare('SELECT * FROM handoffs ORDER BY token_hash').all()
    database.sqlite.exec(
      "CREATE TRIGGER fail_post_purge BEFORE DELETE ON handoffs BEGIN SELECT RAISE(ABORT, 'simulated payload cleanup failure'); END",
    )
    const acknowledge = () =>
      request(`/inbox/jobs/${delivery.id}/ack`, {
        method: 'POST',
        headers: headers(pair),
        body: { state: 'waiting_binding' },
      })
    expect((await acknowledge()).status).toBe(503)
    expect(
      database.sqlite.prepare('SELECT state FROM inbox_deliveries WHERE id = ?').get(delivery.id)
        ?.state,
    ).toBe('pending')
    expect(database.sqlite.prepare('SELECT * FROM handoffs ORDER BY token_hash').all()).toEqual(
      before,
    )
    database.sqlite.exec('DROP TRIGGER fail_post_purge')
    expect((await acknowledge()).status).toBe(200)
    expect((await acknowledge()).status).toBe(200)
    expect(database.sqlite.prepare('SELECT count(*) AS count FROM handoffs').get()?.count).toBe(1)
    for (const link of [token, alias]) {
      expect((await request(`/handoff/${link}`, { headers: headers(pair) })).status).toBe(409)
      expect(
        (await (await request(`/handoff/${link}/status`, { headers: headers(pair) })).json()).state,
      ).toBe('waiting_binding')
    }
    expect(
      (await (await request(`/handoff/${other}`, { headers: headers(pair) })).json()).capture
        .content,
    ).toBe('另一条待领取正文')
    expect((await jobs(pair)).jobs).toHaveLength(1)
    expect((await jobs(pair)).recent[0]?.state).toBe('waiting_binding')
    const resent = await savePost(content)
    expect(discordReplies.at(-1)?.content).toContain('已保存')
    expect((await request(`/handoff/${resent}`, { headers: headers(pair) })).status).toBe(409)
    expect((await jobs(pair)).jobs).toHaveLength(1)
  })

  it('purges transport data retained by an older Worker without deleting receipts or pending work', async () => {
    const pair = await newPair()
    await bind(pair)
    await savePost()
    await interaction(postData('', '22222', '下载资源到SRL（云端暂存）', '?ex=ffffffff'))
    database.sqlite.exec(
      "UPDATE inbox_deliveries SET state = 'saved'; UPDATE inbox_resources SET state = 'imported'",
    )
    await request('/inbox/status', { headers: headers(pair) })
    await drain()
    expect(database.sqlite.prepare('SELECT count(*) AS count FROM handoffs').get()?.count).toBe(0)
    expect(database.sqlite.prepare('SELECT state FROM inbox_deliveries').get()?.state).toBe('saved')
    expect(
      database.sqlite
        .prepare('SELECT state, url, channel_id, message_id FROM inbox_resources')
        .get(),
    ).toEqual({ state: 'imported', url: '', channel_id: '', message_id: '' })
  })

  it('expires cloud bodies and receipts from the scheduled entry without user requests, even if completed-data cleanup fails', async () => {
    const pair = await newPair()
    await bind(pair)
    const expiredToken = await savePost('过期正文')
    const validToken = await savePost('有效正文', '33334')
    await interaction(postData('', '22222', '下载资源到SRL（云端暂存）', '?ex=ffffffff'))
    await interaction(postData('', '33334', '下载资源到SRL（云端暂存）', '?ex=ffffffff'))
    await drain()
    const expired = Date.now() - 1
    const hash = createHash('sha256').update(expiredToken).digest('hex')
    database.sqlite
      .prepare('UPDATE handoffs SET expires_at = ? WHERE token_hash = ?')
      .run(expired, hash)
    database.sqlite
      .prepare('UPDATE inbox_deliveries SET expires_at = ? WHERE title = ?')
      .run(expired, '过期正文')
    database.sqlite.prepare('UPDATE inbox_pair_codes SET expires_at = ?').run(expired)
    database.sqlite
      .prepare('UPDATE inbox_resources SET expires_at = ? WHERE message_id = ?')
      .run(expired, '22222')
    database.sqlite.exec(
      "UPDATE inbox_resources SET state = 'imported' WHERE message_id = '33334'; CREATE TRIGGER fail_old_resource_purge BEFORE UPDATE ON inbox_resources WHEN NEW.url = '' BEGIN SELECT RAISE(ABORT, 'simulated completed-data cleanup failure'); END",
    )
    await expect(
      worker.scheduled({ cron: '0 * * * *', scheduledTime: Date.now() }, environment()),
    ).rejects.toThrow('cleanup incomplete')
    expect(
      database.sqlite.prepare('SELECT count(*) AS count FROM inbox_pair_codes').get()?.count,
    ).toBe(0)
    expect(database.sqlite.prepare('SELECT title FROM inbox_deliveries').all()).toEqual([
      { title: '有效正文' },
    ])
    expect(database.sqlite.prepare('SELECT count(*) AS count FROM handoffs').get()?.count).toBe(1)
    expect(database.sqlite.prepare('SELECT message_id FROM inbox_resources').all()).toEqual([
      { message_id: '33334' },
    ])
    database.sqlite.exec('DROP TRIGGER fail_old_resource_purge')
    await worker.scheduled({ cron: '0 * * * *', scheduledTime: Date.now() }, environment())
    expect(database.sqlite.prepare('SELECT url FROM inbox_resources').get()?.url).toBe('')
    expect(
      (await (await request(`/handoff/${validToken}`, { headers: headers(pair) })).json()).capture
        .content,
    ).toBe('有效正文')
  })

  it('offers an unpaired short-lived handoff, fixes its manual claimant, and preserves the old one-time command', async () => {
    const token = await savePost()
    const capture = await (await request(`/handoff/${token}`)).json()
    expect(capture.delivery.libraryId).toBeNull()
    const status = await (await request(`/handoff/${token}/status`)).json()
    expect(status.expiresAt - status.createdAt).toBe(20 * 60 * 1_000)
    const deviceId = crypto.randomUUID()
    expect(
      (
        await request(`/handoff/${token}/ack`, {
          method: 'POST',
          body: { libraryId: deviceId, state: 'waiting_binding' },
        })
      ).status,
    ).toBe(200)
    const otherDeviceId = crypto.randomUUID()
    expect(
      (
        await request(`/handoff/${token}/ack`, {
          method: 'POST',
          body: { libraryId: otherDeviceId, state: 'saved' },
        })
      ).status,
    ).toBe(409)
    expect((await request(`/handoff/${token}`)).status).toBe(409)
    expect(
      database.sqlite.prepare('SELECT claimed_library_id FROM inbox_deliveries').get(),
    ).toMatchObject({ claimed_library_id: deviceId })
    expect(
      (
        await request(`/handoff/${token}/ack`, {
          method: 'POST',
          body: { libraryId: deviceId, state: 'saved' },
        })
      ).status,
    ).toBe(200)
    expect((await (await request(`/handoff/${token}/status`)).json()).state).toBe('saved')
    const response = await interaction(postData('旧命令', '123456', '保存到资源库'))
    const legacy = await response.json()
    const oldToken = legacy.data.components[0].components[0].url.split('/').at(-1)
    expect((await request(`/handoff/${oldToken}`)).status).toBe(200)
    expect((await request(`/handoff/${oldToken}`)).status).not.toBe(200)
  })

  it('captures the receipt time before asynchronous TXT enrichment and accepts the UI name limit', async () => {
    const pair = await newPair('库'.repeat(80))
    await bind(pair)
    let clock = Date.now()
    const receivedAt = clock
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.hostname === 'cdn.discordapp.com') {
        clock += 5_000
        return new Response('附件正文')
      }
      discordReplies.push(JSON.parse(String(init?.body)))
      return json({})
    })
    const data = postData()
    const attachment = data.resolved.messages['22222']!.attachments[0]!
    attachment.filename = '正文.txt'
    attachment.url = 'https://cdn.discordapp.com/attachments/33333/88888/body.txt'
    await interaction(data)
    const token = discordReplies.at(-1)?.components?.[0]?.components[0]?.url.split('/').at(-1)
    const detail = await (await request(`/handoff/${token}`, { headers: headers(pair) })).json()
    expect(detail.capture.attachments[0].textContent).toBe('附件正文')
    expect(detail.delivery.capturedAt).toBe(receivedAt)
    expect(detail.delivery.capturedAt).toBeLessThan(clock)
    const status = await (await request(`/handoff/${token}/status`)).json()
    expect(status.createdAt).toBe(receivedAt)
    expect(status.expiresAt - status.createdAt).toBe(7 * 24 * 60 * 60 * 1_000)
    const tooLong = await request('/inbox/pair', {
      method: 'POST',
      headers: { Authorization: 'Bearer bot-token' },
      body: { name: '库'.repeat(81) },
    })
    expect(tooLong.status).toBe(400)
  })

  it('bounds pages, excludes expired tasks, revokes endpoints and refuses expired pairing codes', async () => {
    const pair = await newPair()
    await bind(pair)
    for (let index = 0; index < 22; index++) await savePost(`正文${index}`, String(100000 + index))
    const page = await jobs(pair)
    expect(page.jobs).toHaveLength(20)
    expect(page.hasMore).toBe(true)
    const token = await savePost('即将过期', '700000')
    const detail = await (await request(`/handoff/${token}`, { headers: headers(pair) })).json()
    database.sqlite
      .prepare('UPDATE inbox_deliveries SET expires_at = ? WHERE id = ?')
      .run(Date.now() - 1, detail.delivery.id)
    expect((await (await request(`/handoff/${token}/status`)).json()).state).toBe('expired')
    expect(
      (await request(`/inbox/jobs/${detail.delivery.id}`, { headers: headers(pair) })).status,
    ).toBe(404)
    const expiredPair = await newPair()
    database.sqlite
      .prepare('UPDATE inbox_pair_codes SET expires_at = ? WHERE library_id = ?')
      .run(Date.now() - 1, expiredPair.libraryId)
    await bind(expiredPair, '66666')
    expect(
      (await (await request('/inbox/status', { headers: headers(expiredPair) })).json()).paired,
    ).toBe(false)
    await request('/inbox/pair', { method: 'DELETE', headers: headers(pair) })
    expect((await request('/inbox/jobs', { headers: headers(pair) })).status).toBe(401)
  })

  it('keeps corrupted/incomplete payload retryable and does not ACK it', async () => {
    const pair = await newPair()
    await bind(pair)
    await savePost()
    const item = (await jobs(pair)).jobs[0]!
    database.sqlite
      .prepare(
        'DELETE FROM handoffs WHERE token_hash = (SELECT handoff_token_hash FROM inbox_deliveries WHERE id = ?)',
      )
      .run(item.id)
    expect((await request(`/inbox/jobs/${item.id}`, { headers: headers(pair) })).status).toBe(503)
    expect((await jobs(pair)).jobs[0]?.state).toBe('pending')
  })

  it('does not reuse an old target receipt when the default changes between target lookup and publication', async () => {
    const old = await newPair('原设备')
    await bind(old)
    await savePost()
    const next = await newPair('新设备')
    database.beforeNextHandoffInsert = () => {
      // Interleave a different request's committed default switch before delivery publication.
      database.sqlite.exec('BEGIN')
      database.sqlite
        .prepare('UPDATE inbox_endpoints SET is_default = 0 WHERE library_id = ?')
        .run(old.libraryId)
      database.sqlite
        .prepare(
          'UPDATE inbox_endpoints SET discord_user_id = ?, is_default = 1 WHERE library_id = ?',
        )
        .run('55555', next.libraryId)
      database.sqlite.exec('COMMIT')
    }
    discordReplies.length = 0
    await interaction(postData())
    expect(discordReplies.at(-1)?.content).toContain('收件目标已改变')
    expect(discordReplies.at(-1)?.components).toEqual([])
    expect((await jobs(old)).jobs).toHaveLength(1)
    expect((await jobs(next)).jobs).toHaveLength(0)
    await savePost()
    expect((await jobs(next)).jobs).toHaveLength(1)
  })

  it('round trips a chunked payload repeatedly before ACK without mutating its source text', async () => {
    const pair = await newPair()
    await bind(pair)
    const content = '𠮷中'.repeat(280_000)
    const token = await savePost(content)
    const first = await (await request(`/handoff/${token}`, { headers: headers(pair) })).json()
    const second = await (
      await request(`/inbox/jobs/${first.delivery.id}`, { headers: headers(pair) })
    ).json()
    expect(first.capture.content).toBe(content)
    expect(second.capture.content).toBe(content)
    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM handoffs WHERE token_hash LIKE '%:chunk:%'")
        .get()?.count,
    ).toBeGreaterThan(1)
    expect((await jobs(pair)).jobs[0]?.state).toBe('pending')
  })

  it('rejects unknown message commands and unsigned slash requests', async () => {
    const response = await interaction(postData('不得保存', '123456', '陌生命令'))
    expect((await response.json()).type).toBe(4)
    expect(database.sqlite.prepare('SELECT COUNT(*) AS count FROM handoffs').get()?.count).toBe(0)
    expect(
      (
        await request('/interactions', {
          method: 'POST',
          body: { type: 2, data: { type: 1, name: '绑定资源库' } },
        })
      ).status,
    ).toBe(401)
  })

  it('acknowledges all saved receipts for a bound source beyond recent twenty, without consuming pending or another endpoint', async () => {
    const pair = await newPair()
    await bind(pair)
    let capture: DiscordCapture | undefined
    for (let index = 0; index < 30; index++) {
      const token = await savePost(`待关联的版本${index}`)
      const detail = await (await request(`/handoff/${token}`, { headers: headers(pair) })).json()
      capture = detail.capture as DiscordCapture
      await request(`/inbox/jobs/${detail.delivery.id}/ack`, {
        method: 'POST',
        headers: headers(pair),
        body: { state: 'waiting_binding' },
      })
    }
    expect((await jobs(pair)).recent).toHaveLength(20)
    await savePost('尚未领取的版本')
    const other = await newPair('另一用户')
    await bind(other, '66666')
    const otherToken = await savePost('另一用户版本', '22222', '66666')
    const otherDetail = await (
      await request(`/handoff/${otherToken}`, { headers: headers(other) })
    ).json()
    await request(`/inbox/jobs/${otherDetail.delivery.id}/ack`, {
      method: 'POST',
      headers: headers(other),
      body: { state: 'waiting_binding' },
    })
    const sourceHash = createHash('sha256').update(createDiscordSourceKey(capture!)).digest('hex')
    const waiting = await (
      await request('/inbox/waiting-sources', { headers: headers(pair) })
    ).json()
    expect(waiting).toEqual({ sourceKeyHashes: [sourceHash], nextCursor: null })
    const ackPath = `/inbox/sources/${sourceHash}/ack-bound`
    expect(
      (
        await request(ackPath, {
          method: 'POST',
          headers: { Authorization: `Bearer ${other.secret}`, 'X-SRL-Library-ID': pair.libraryId },
        })
      ).status,
    ).toBe(401)
    expect(
      (
        await request(ackPath, {
          method: 'POST',
          headers: { Authorization: 'Bearer bot-token', 'X-SRL-Library-ID': pair.libraryId },
        })
      ).status,
    ).toBe(401)
    const ack = await (await request(ackPath, { method: 'POST', headers: headers(pair) })).json()
    expect(ack).toMatchObject({ state: 'saved', updated: 30 })
    expect((await jobs(pair)).jobs).toHaveLength(1)
    expect((await jobs(pair)).recent.every((item) => item.state === 'saved')).toBe(true)
    expect((await jobs(other)).recent[0]?.state).toBe('waiting_binding')
    expect(
      await (await request('/inbox/waiting-sources', { headers: headers(pair) })).json(),
    ).toEqual({ sourceKeyHashes: [], nextCursor: null })
  })

  it('paginates distinct waiting source hashes with authenticated cursors and excludes expired or pending receipts', async () => {
    const pair = await newPair()
    await bind(pair)
    for (let index = 0; index < 25; index++) {
      const token = await savePost('已保存', String(500000 + index))
      const detail = await (await request(`/handoff/${token}`, { headers: headers(pair) })).json()
      await request(`/inbox/jobs/${detail.delivery.id}/ack`, {
        method: 'POST',
        headers: headers(pair),
        body: { state: 'waiting_binding' },
      })
    }
    await savePost('仍待领取', '600000')
    const first = await (await request('/inbox/waiting-sources', { headers: headers(pair) })).json()
    expect(first.sourceKeyHashes).toHaveLength(20)
    expect(first.nextCursor).toBe(first.sourceKeyHashes.at(-1))
    const next = await (
      await request(`/inbox/waiting-sources?after=${first.nextCursor}`, { headers: headers(pair) })
    ).json()
    expect(next.sourceKeyHashes).toHaveLength(5)
    expect(next.nextCursor).toBeNull()
    const complete = [...first.sourceKeyHashes, ...next.sourceKeyHashes] as string[]
    expect(new Set(complete).size).toBe(25)
    expect(complete).toEqual([...complete].sort())
    expect(
      (await request('/inbox/waiting-sources?after=invalid', { headers: headers(pair) })).status,
    ).toBe(400)
    expect(
      (await request('/inbox/waiting-sources', { headers: headers(await newPair()) })).status,
    ).toBe(200)
    database.sqlite
      .prepare("UPDATE inbox_deliveries SET expires_at = ? WHERE state = 'waiting_binding'")
      .run(Date.now() - 1)
    expect(
      await (await request('/inbox/waiting-sources', { headers: headers(pair) })).json(),
    ).toEqual({ sourceKeyHashes: [], nextCursor: null })
  })

  it('keeps migration SQL identical to the shared Dashboard schema and bundles its auto-initialization', async () => {
    const migration = readFileSync(
      fileURLToPath(
        new URL('../../workers/discord-source-bridge/migrations/0002_inbox.sql', import.meta.url),
      ),
      'utf8',
    )
    const normalize = (sql: string) =>
      sql
        .replace(/^--.*$/gmu, '')
        .replace(/\s+/gu, ' ')
        .trim()
    expect(normalize(migration)).toBe(
      normalize(DISCORD_INBOX_SCHEMA.map((sql) => sql + ';').join('\n')),
    )
    const manual = await buildDiscordManualWorkerSource()
    expect(manual).toContain('CREATE TABLE IF NOT EXISTS inbox_endpoints')
    expect(manual).toContain('CREATE TABLE IF NOT EXISTS inbox_deliveries')
    expect(manual).toContain('ensureManualSchema')
    expect(manual).not.toMatch(/^import .*DiscordInbox/mu)
    const manualUrl = `data:text/javascript;base64,${Buffer.from(manual).toString('base64')}`
    const generated = ((await import(/* @vite-ignore */ manualUrl)) as { default: Worker }).default
    const empty = new SqlD1(false)
    try {
      const response = await generated.fetch(
        new Request(base + '/health'),
        { ...environment(), DB: empty },
        context,
      )
      expect(response.status).toBe(200)
      expect(
        empty.sqlite
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'inbox_deliveries'",
          )
          .get()?.name,
      ).toBe('inbox_deliveries')
      expect(empty.sqlite.prepare('SELECT source_key_hash FROM inbox_deliveries').all()).toEqual([])
    } finally {
      empty.sqlite.close()
    }
  })
})
