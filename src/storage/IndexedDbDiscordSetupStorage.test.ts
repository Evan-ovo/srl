/** @vitest-environment jsdom */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { AppDatabase } from '../database/AppDatabase'
import { IndexedDbDiscordSetupStorage } from './IndexedDbDiscordSetupStorage'
import { IndexedDbProductAssistantStorage } from './IndexedDbProductAssistantStorage'
let database: AppDatabase
beforeEach(async () => {
  database = new AppDatabase(`discord-setup-${crypto.randomUUID()}`)
  await database.open()
})
afterEach(async () => {
  await database.delete()
})
it('persists and rereads only whitelisted metadata in the existing settings table', async () => {
  const storage = new IndexedDbDiscordSetupStorage(database)
  const state = {
    task: 'configure' as const,
    step: 'd1-uuid' as const,
    startedAt: 1,
    botToken: 'NEVER_EXPORT_THIS',
    source: 'NEVER_EXPORT_THIS',
    cookie: 'NEVER_EXPORT_THIS',
  }
  await storage.save(state)
  expect(await new IndexedDbDiscordSetupStorage(database).read()).toEqual({
    task: 'configure',
    step: 'd1-uuid',
    startedAt: 1,
  })
  const exported = await new IndexedDbProductAssistantStorage(database).exportPortableState()
  expect(exported.map((record) => record.id)).toContain('assistant.discord-setup')
  expect(JSON.stringify(exported)).not.toContain('NEVER_EXPORT_THIS')
  expect(await database.resources.count()).toBe(0)
  await database.settings.where('id').startsWith('assistant.').delete()
  expect(await storage.read()).toBeUndefined()
})
it('does not restore an arbitrary site or invalid task through backup import', async () => {
  await database.settings.put({
    id: 'assistant.discord-setup',
    updatedAt: 1,
    value: { task: 'unknown', step: 'done', startedAt: 1, cookie: 'PRIVATE' },
  })
  expect(await new IndexedDbDiscordSetupStorage(database).read()).toBeUndefined()
})
it('keeps the mode and resource reference across restart without copying public-key/UUID/Secret into assistant settings', async () => {
  const storage = new IndexedDbDiscordSetupStorage(database)
  await storage.save({
    task: 'configure',
    step: 'wrangler-edit',
    startedAt: 1,
    mode: 'agent',
    parameterResourceId: 'card-123',
    assistantConversationId: 'agent-chat-123',
    publicKey: 'a'.repeat(64),
    databaseId: '12345678-1234-5678-9abc-123456789abc',
    botToken: 'SECRET',
  } as never)
  expect(await storage.read()).toEqual({
    task: 'configure',
    step: 'wrangler-edit',
    startedAt: 1,
    mode: 'agent',
    parameterResourceId: 'card-123',
    assistantConversationId: 'agent-chat-123',
  })
})
