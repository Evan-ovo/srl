/** @vitest-environment jsdom */
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import TavernParcelExchange from './TavernParcelExchange.vue'
import { resourceService } from '../core/AppContainer'
import { createChatArchive, readChatArchive } from '../services/TavernChatArchiveCodec.mjs'
import { createParcel, readParcel, removeParcel } from '../services/BridgeParcelCodec.mjs'
import { saveRelayWorkerBaseUrl } from '../services/RelayWorkerSettingsService'
import { RESOURCE_TYPE, type Resource } from '../types/Resource'
import { PngResourceParser } from '../parser/PngResourceParser'
// SRL-PUBLIC-SYNC: BEGIN PUBLIC-ONLY id=public-parcel-worker-fixture
import { beforeEach } from 'vitest'
beforeEach(() => {
  localStorage.removeItem('srl.publicWorker.baseUrl.v1')
  saveRelayWorkerBaseUrl('https://worker.example')
})
// SRL-PUBLIC-SYNC: END PUBLIC-ONLY id=public-parcel-worker-fixture
vi.mock('../core/AppContainer', async () => ({
  exportService: new (await import('../services/ExportService')).ExportService(),
  resourceService: { get: vi.fn() },
  browserStorageService: { getModifiedResourceSyncTags: vi.fn(() => false) },
}))
vi.mock('../services/BridgeParcelCodec.mjs', () => ({
  createParcel: vi.fn(async () => ({ ticket: 'SRL1-fixture' })),
  readParcel: vi.fn(),
  removeParcel: vi.fn(),
}))
const wrappers: Array<{ unmount(): void }> = []
afterEach(() => {
  wrappers.splice(0).forEach((w) => w.unmount())
  vi.clearAllMocks()
  // SRL-PUBLIC-SYNC: BEGIN REPLACE id=parcel-worker-storage-cleanup
  localStorage.removeItem('srl.publicWorker.baseUrl.v1')
  // SRL-PUBLIC-SYNC: END REPLACE id=parcel-worker-storage-cleanup
})
it.each(['original', 'modified'] as const)(
  'packages %s according to the shared setting',
  async (content) => {
    const card = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: { name: '角色', first_mes: '原文' },
    }
    const raw = JSON.stringify(card)
    const resource = {
      id: 'card',
      name: '角色',
      fileName: 'card.json',
      type: RESOURCE_TYPE.CHARACTER_CARD,
      tags: [],
      mimeType: 'application/json',
      originalBlob: new Blob([raw]),
      metadata: {
        card,
        characterContentEdits: [
          {
            id: 'edit',
            section: 'greeting',
            targetKey: 'primary',
            before: '原文',
            after: '新文',
            operation: 'update',
            label: '开场白',
            migrateToVersions: false,
            updatedAt: 1,
          },
        ],
      },
    } as unknown as Resource
    vi.mocked(resourceService.get).mockResolvedValue(resource)
    const w = mount(TavernParcelExchange, {
      props: { resources: [resource], initialIds: ['card'], sendContent: content },
    })
    wrappers.push(w)
    await w
      .findAll('button')
      .find((b) => b.text() === '发给酒馆')!
      .trigger('click')
    await w.find('.tavern-parcel__primary').trigger('click')
    await vi.waitFor(() => expect(createParcel).toHaveBeenCalledOnce())
    const payload = vi.mocked(createParcel).mock.calls[0]![1]
    expect(payload[0]!.file.name).toBe(content === 'original' ? 'card.json' : 'card.png')
    if (content === 'original') expect(await payload[0]!.file.text()).toBe(raw)
    else
      expect((await new PngResourceParser().parse(payload[0]!.file)).metadata.card).toMatchObject({
        data: { first_mes: '新文' },
      })
    await flushPromises()
    expect(w.text()).toContain('暂存就绪')
  },
)

it('deletes a saved parcel from its original Worker after changing the local setting', async () => {
  saveRelayWorkerBaseUrl('https://worker.example')
  const resource = {
    id: 'card',
    name: '角色',
    fileName: 'card.json',
    type: RESOURCE_TYPE.CHARACTER_CARD,
    tags: [],
    mimeType: 'application/json',
    originalBlob: new Blob(['{}']),
    metadata: {},
  } as unknown as Resource
  vi.mocked(resourceService.get).mockResolvedValue(resource)
  const w = mount(TavernParcelExchange, {
    props: { resources: [resource], initialIds: ['card'], sendContent: 'original' },
  })
  wrappers.push(w)
  await w
    .findAll('button')
    .find((b) => b.text() === '发给酒馆')!
    .trigger('click')
  await w.find('.tavern-parcel__primary').trigger('click')
  await vi.waitFor(() => expect(createParcel).toHaveBeenCalledOnce())
  expect(vi.mocked(createParcel).mock.calls[0]![0]).toBe('https://worker.example')
  saveRelayWorkerBaseUrl('https://other.example')
  await w
    .findAll('button')
    .find((b) => b.text().includes('删除暂存'))!
    .trigger('click')
  await vi.waitFor(() => expect(removeParcel).toHaveBeenCalledOnce())
  expect(vi.mocked(removeParcel).mock.calls[0]![0]).toBe('https://worker.example')
})
it('checks the prepared parcel size instead of the source size and never falls back to original', async () => {
  const resource = {
    id: 'large',
    name: '角色',
    type: RESOURCE_TYPE.CHARACTER_CARD,
    fileName: 'small.json',
    originalBlob: new Blob(['{}']),
    metadata: {},
    tags: [],
  } as unknown as Resource
  vi.mocked(resourceService.get).mockResolvedValue(resource)
  const { exportService } = await import('../core/AppContainer')
  const prepare = vi
    .spyOn(exportService, 'createTavernTransferFile')
    .mockResolvedValue(
      new File([new Uint8Array(17 * 1024 * 1024)], 'large.png', { type: 'image/png' }),
    )
  try {
    const w = mount(TavernParcelExchange, {
      props: { resources: [resource], initialIds: [resource.id] },
    })
    wrappers.push(w)
    await w
      .findAll('button')
      .find((b) => b.text() === '发给酒馆')!
      .trigger('click')
    await w.find('.tavern-parcel__primary').trigger('click')
    await flushPromises()
    expect(w.get('[role="alert"]').text()).toContain('超过 16 MiB')
    expect(createParcel).not.toHaveBeenCalled()
    expect(prepare).toHaveBeenCalledExactlyOnceWith(
      resource,
      'modified',
      resourceService,
      undefined,
      { syncCharacterTags: false },
    )
  } finally {
    prepare.mockRestore()
  }
})

it.each([true, false])(
  'honors the carry setting %s on parcel receipt, preserving card, chat and display rules',
  async (includeChatScripts) => {
    const card = new File(['png-original'], 'card.png'),
      chat = new File(['jsonl-original'], 'chat.jsonl')
    const rule = { findRegex: 'status', replaceString: 'panel', markdownOnly: true }
    vi.mocked(readParcel).mockResolvedValue([
      {
        kind: 'chat',
        displayName: 'chat',
        file: createChatArchive(card, chat, 'card.png', [rule], {
          readingScripts: [{ sourceName: 'phone', scripts: { content: 'code' } }],
        }),
      },
    ])
    const w = mount(TavernParcelExchange, { props: { resources: [], includeChatScripts } })
    wrappers.push(w)
    await w.get('textarea').setValue('SRL1-fixture')
    await w
      .findAll('button')
      .find((b) => b.text().includes('领取并校验'))!
      .trigger('click')
    await flushPromises()
    await w
      .findAll('button')
      .find((b) => b.text() === '导入资源库')!
      .trigger('click')
    await flushPromises()
    const imported = (w.emitted('import-files')![0]![0] as File[])[0]!
    const archive = await readChatArchive(imported)
    expect(archive.carryReadingScripts).toBe(includeChatScripts)
    expect(archive.readingScripts).toEqual(
      includeChatScripts ? [{ sourceName: 'phone', scripts: { content: 'code' } }] : [],
    )
    expect(await archive.card.text()).toBe('png-original')
    expect(await archive.chat.text()).toBe('jsonl-original')
    expect(archive.displayRules).toEqual([rule])
  },
)
