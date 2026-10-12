/** @vitest-environment jsdom */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Dexie from 'dexie'
import { AppDatabase } from '../database/AppDatabase'
import { IndexedDbProductAssistantStorage } from './IndexedDbProductAssistantStorage'
import { newAssistantConversation } from '../services/ProductAssistantWorkspaceService'
import type { AssistantAppDraft } from '../services/ProductAssistantAppSession'

let database: AppDatabase
let storage: IndexedDbProductAssistantStorage
let legacy: AppDatabase | undefined
async function withLegacy() {
  legacy = new AppDatabase(`assistant-old-test-${crypto.randomUUID()}`)
  const oldStorage = new IndexedDbProductAssistantStorage(legacy)
  storage = new IndexedDbProductAssistantStorage(database, async () => {
    const connection = new Dexie(legacy!.name)
    await connection.open()
    return connection
  })
  return oldStorage
}
const chat = (text: string, id: string = crypto.randomUUID()) => ({
  ...newAssistantConversation(),
  id,
  title: text,
  updatedAt: 10,
  history: [{ id: 'turn', role: 'user' as const, text }],
  input: '未发送的输入',
  images: [{ id: 'image', name: '图片', dataUrl: 'data:image/png;base64,AA==' }],
})

beforeEach(() => {
  database = new AppDatabase(`assistant-backup-test-${crypto.randomUUID()}`)
  storage = new IndexedDbProductAssistantStorage(database)
})

afterEach(async () => {
  await database.delete()
  await legacy?.delete()
  legacy = undefined
})

it('exports only assistant-owned local settings', async () => {
  await database.settings.bulkPut([
    { id: 'assistant.preferences', value: { theme: 'dark' }, updatedAt: 1 },
    { id: 'assistant.chat:one', value: { messages: ['private'] }, updatedAt: 2 },
    { id: 'product-assistant:custom-api', value: { key: 'credential' }, updatedAt: 3 },
    { id: 'srl.ui.customCss', value: '.private {}', updatedAt: 4 },
  ])

  await expect(storage.exportPortableState()).resolves.toEqual([
    { id: 'assistant.chat:one', value: { messages: ['private'] }, updatedAt: 2 },
    { id: 'assistant.preferences', value: { theme: 'dark' }, updatedAt: 1 },
  ])
})

it('restores only valid assistant rows and preserves unrelated settings', async () => {
  await database.settings.put({ id: 'shared-setting', value: 'keep', updatedAt: 1 })

  await storage.importPortableState([
    { id: 'assistant.preferences', value: { theme: 'light' }, updatedAt: 2 },
    { id: 'shared-setting', value: 'overwrite attempt', updatedAt: 3 },
    { id: 'assistant.bad-time', value: {}, updatedAt: Number.NaN },
  ])

  expect((await database.settings.get('assistant.preferences'))?.value).toEqual({ theme: 'light' })
  expect((await database.settings.get('shared-setting'))?.value).toBe('keep')
  expect(await database.settings.get('assistant.bad-time')).toBeUndefined()
})

it('rebuilds a missing history list from existing bodies and persists the search index after reopen', async () => {
  const original = chat('历史正文仍在')
  await storage.save(original, true)
  await database.settings.delete('assistant.summary:' + original.id)
  expect((await storage.list(0, 20)).total).toBe(0)
  await expect(storage.recoverHistory({})).resolves.toMatchObject({ repaired: 1, recovered: 0 })
  expect(await storage.active()).toBe(original.id)
  expect(await storage.read(original.id)).toMatchObject(original)
  database.close()
  await database.open()
  expect((await storage.list(0, 20)).items[0]?.id).toBe(original.id)
  expect((await storage.search('历史正文仍在', false, 0, 20)).total).toBeGreaterThan(0)
})

it('recovers old messages and images without replacing the current chat, preferences or the source', async () => {
  const oldStorage = await withLegacy()
  const old = chat('旧库独有聊天')
  await oldStorage.save(old, true)
  const sourceBefore = JSON.stringify(await oldStorage.exportPortableState())
  const current = chat('当前对话')
  await storage.save(current, true)
  await database.settings.put({
    id: 'assistant.preferences',
    value: { name: '现在的名字' },
    updatedAt: 30,
  })
  const result = await storage.recoverHistory({})
  expect(result).toMatchObject({ recovered: 1, conflicts: 0, repaired: 0, cancelled: false })
  const recovered = (await storage.list(0, 20)).items.find((row) => row.id !== current.id)!
  expect(await storage.read(recovered.id)).toMatchObject({
    history: old.history,
    images: old.images,
    input: old.input,
  })
  expect(await storage.active()).toBe(current.id)
  expect(await storage.preferences()).toEqual({ name: '现在的名字' })
  expect(JSON.stringify(await oldStorage.exportPortableState())).toBe(sourceBefore)
  await storage.save({ ...(await storage.read(recovered.id))!, input: '找回后继续编辑' })
  await expect(storage.recoverHistory({})).resolves.toMatchObject({ recovered: 0 })
  expect((await storage.read(recovered.id))?.input).toBe('找回后继续编辑')
  expect((await storage.list(0, 20)).total).toBe(2)
})

it('preserves both versions for an ID conflict and never reactivates interrupted tools', async () => {
  const oldStorage = await withLegacy()
  const old = chat('旧内容', 'shared')
  old.history[0] = {
    ...old.history[0]!,
    toolCalls: [{ id: 'tool', label: '处理', state: 'running' }],
  } as (typeof old.history)[0]
  await oldStorage.save(old)
  await storage.save(chat('新内容', 'shared'), true)
  const result = await storage.recoverHistory({})
  expect(result).toMatchObject({ recovered: 1, conflicts: 1 })
  expect((await storage.read('shared'))?.history[0]?.text).toBe('新内容')
  const recovered = (await storage.list(0, 20)).items.find((row) => row.id !== 'shared')!
  expect((await storage.read(recovered.id))?.history[0]?.toolCalls?.[0]?.state).toBe('cancelled')
  expect((await oldStorage.read('shared'))?.history[0]?.toolCalls?.[0]?.state).toBe('running')
})

it('copies a linked APP project under a separate identity without overwriting a newer project', async () => {
  const oldStorage = await withLegacy()
  const draft: AssistantAppDraft = {
    manifest: {
      schemaVersion: 2,
      apiVersion: 'srl-app-api@1',
      id: 'old-app',
      name: '小记',
      version: '1.0.0',
      entry: 'index.html',
      permissions: ['app.storage'],
    },
    source: { 'index.html': '<p>旧项目</p>' },
    revision: 1,
  }
  await oldStorage.save({ ...chat('制作旧项目'), draft })
  await storage.save(
    { ...chat('当前项目'), draft: { ...draft, source: { 'index.html': '<p>新项目</p>' } } },
    true,
  )
  await expect(storage.recoverHistory({})).resolves.toMatchObject({ recovered: 1 })
  const recovered = (await storage.list(0, 20)).items.find((row) => row.title.endsWith('（找回）'))!
  const body = (await storage.read(recovered.id))!
  expect(body.projectId).not.toBe('old-app')
  expect(body.draft?.manifest.id).toBe(body.projectId)
  expect(body.draft?.source['index.html']).toBe('<p>旧项目</p>')
  expect((await storage.project('old-app'))?.draft.source['index.html']).toBe('<p>新项目</p>')
  await storage.save({ ...body, input: '找回后续接' })
  expect((await storage.project('old-app'))?.version).toBe(1)
})

it('keeps recovered text readable when the referenced old project is missing', async () => {
  await withLegacy()
  await legacy!.settings.put({
    id: 'assistant.chat:orphan',
    value: { ...chat('缺项目的正文', 'orphan'), projectId: 'missing', projectVersion: 2 },
    updatedAt: 10,
  })
  await expect(storage.recoverHistory({})).resolves.toMatchObject({
    recovered: 1,
    missingProjects: 1,
  })
  const recovered = (await storage.list(0, 20)).items[0]!
  expect(await storage.read(recovered.id)).toMatchObject({ history: [{ text: '缺项目的正文' }] })
})

it('recovers an old project even when its chat body was already migrated unchanged', async () => {
  const oldStorage = await withLegacy()
  const draft: AssistantAppDraft = {
    manifest: {
      schemaVersion: 2,
      id: 'same-project',
      name: '旧项目',
      version: '1.0.0',
      entry: 'index.html',
    },
    source: { 'index.html': '<p>旧源码</p>' },
    revision: 1,
  }
  const original = chat('项目源码仍需找回')
  await oldStorage.save({ ...original, draft })
  await database.settings.bulkPut(
    (await oldStorage.exportPortableState()).filter(
      (row) =>
        !row.id.startsWith('assistant.project:') &&
        !row.id.startsWith('assistant.project-summary:'),
    ),
  )
  await expect(storage.recoverHistory({})).resolves.toMatchObject({ recovered: 1 })
  const recovered = (await storage.list(0, 20)).items.find((row) => row.id !== original.id)!
  expect((await storage.read(recovered.id))?.draft?.source).toEqual(draft.source)
})

it('stops between records, retains committed recovery, and resumes without duplication across pages', async () => {
  const oldStorage = await withLegacy()
  for (let i = 0; i < 23; i++)
    await oldStorage.save(chat('消息' + i, 'old-' + String(i).padStart(2, '0')))
  const controller = new AbortController()
  const result = await storage.recoverHistory({
    signal: controller.signal,
    onProgress: (value) => {
      if (value.recovered === 1) controller.abort()
    },
  })
  expect(result).toMatchObject({ recovered: 1, cancelled: true })
  expect((await storage.list(0, 20)).total).toBe(1)
  await expect(storage.recoverHistory({})).resolves.toMatchObject({
    recovered: 22,
    cancelled: false,
  })
  expect((await storage.list(0, 20)).total).toBe(23)
  expect((await oldStorage.list(0, 20)).total).toBe(23)
})

it('skips malformed bodies and does not invent history from an orphan summary', async () => {
  await withLegacy()
  await legacy!.settings.bulkPut([
    { id: 'assistant.chat:bad', value: { id: 'bad', history: null }, updatedAt: 1 },
    { id: 'assistant.summary:gone', value: { id: 'gone', title: '仅剩标题' }, updatedAt: 1 },
    { id: 'shared-setting', value: '旧的共享设置', updatedAt: 1 },
  ])
  await expect(storage.recoverHistory({})).resolves.toMatchObject({ invalid: 1, recovered: 0 })
  expect((await storage.list(0, 20)).total).toBe(0)
  expect(await database.settings.get('shared-setting')).toBeUndefined()
})

it('rolls back a failed record, preserves the old source and succeeds on an explicit later attempt', async () => {
  const oldStorage = await withLegacy()
  await oldStorage.save(chat('失败后仍可找回'))
  const fail = vi
    .spyOn(database.settings, 'bulkPut')
    .mockRejectedValueOnce(new Error('磁盘写入失败'))
  await expect(storage.recoverHistory({})).rejects.toThrow('磁盘写入失败')
  expect((await storage.list(0, 20)).total).toBe(0)
  expect((await oldStorage.list(0, 20)).total).toBe(1)
  fail.mockRestore()
  await expect(storage.recoverHistory({})).resolves.toMatchObject({ recovered: 1 })
})

it('does no writes for a pre-cancelled recovery or for identical migrated chats', async () => {
  const oldStorage = await withLegacy()
  const original = chat('已经迁移')
  await oldStorage.save(original)
  await storage.save(original)
  await expect(storage.recoverHistory({ signal: AbortSignal.abort() })).resolves.toMatchObject({
    scanned: 0,
    cancelled: true,
  })
  await expect(storage.recoverHistory({})).resolves.toMatchObject({ recovered: 0, repaired: 0 })
  expect((await storage.list(0, 20)).total).toBe(1)
})
