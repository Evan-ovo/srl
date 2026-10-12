import { describe, expect, it, vi } from 'vitest'

import { ExternalAppSdkService } from './ExternalAppSdkService'

const resource = {
  id: 'resource-1',
  type: 'characterCard' as const,
  name: '测试角色',
  description: '可供第三方读取的测试资源',
  fileName: 'test.json',
  mimeType: 'application/json',
  fileSize: 10,
  contentHash: 'hash',
  favorite: false,
  categoryId: null,
  categoryIds: [],
  relatedResourceIds: [],
  tags: ['测试'],
  metadata: { format: 'character-card', parserVersion: 2, safe: true },
  originalBlob: new Blob([]),
  createdAt: 1,
  updatedAt: 2,
}

function createSdk(permissions: string[]) {
  const externalApps = {
    get: vi.fn(async () => ({ id: 'app', enabled: true, manifest: { permissions } })),
    getSummary: vi.fn(async () => ({ id: 'app', enabled: true, manifest: { permissions } })),
    hasPermission: vi.fn(async (_id: string, permission: string | string[]) =>
      (Array.isArray(permission) ? permission : [permission]).every((item) =>
        permissions.includes(item),
      ),
    ),
  }
  const resources = {
    listResourceListSummaries: vi.fn(async () => [{ ...resource, originalBlob: undefined }]),
    listSummaries: vi.fn(async () => [{ ...resource, originalBlob: undefined }]),
    get: vi.fn(async (id: string) => (id === resource.id ? resource : undefined)),
    updateExternalAppResource: vi.fn(
      async (update: Record<string, unknown> & { resourceId: string }) => ({
        ...resource,
        ...update,
        id: update.resourceId,
        updatedAt: 3,
      }),
    ),
  }
  return {
    sdk: new ExternalAppSdkService(externalApps as never, resources as never),
    resources,
    externalApps,
  }
}

describe('ExternalAppSdkService', () => {
  it.each([1000, 5000, 10000])(
    'reads one scoped directory for %i chats across all pages, then releases it',
    async (size) => {
      const { sdk, resources } = createSdk(['resources.library.read'])
      const records = Array.from({ length: size }, (_, index) => ({
        ...resource,
        id: `chat-${index}`,
        type: 'chat' as const,
      }))
      resources.listResourceListSummaries.mockResolvedValue(records as never)
      let offset = 0
      let cursor: string | undefined
      let count = 0
      do {
        const result = await sdk.list(
          'app',
          { types: ['chat'], snapshot: true, offset, limit: 50, ...(cursor ? { cursor } : {}) },
          'session',
        )
        count += result.items.length
        offset = result.nextOffset ?? size
        cursor = result.cursor
      } while (offset < size)
      expect(count).toBe(size)
      expect(resources.listResourceListSummaries).toHaveBeenCalledExactlyOnceWith({
        types: ['chat'],
        ids: undefined,
      })
      expect(resources.get).not.toHaveBeenCalled()
      expect(resources.listSummaries).not.toHaveBeenCalled()
      const fresh = await sdk.list('app', { types: ['chat'], snapshot: true, limit: 50 }, 'session')
      sdk.releaseListSession('session')
      await expect(
        sdk.list('app', { types: ['chat'], offset: 50, cursor: fresh.cursor }, 'session'),
      ).rejects.toThrow('分页已结束')
    },
  )

  it('rechecks permissions and binds a directory cursor to its session, APP and range', async () => {
    const { sdk, resources, externalApps } = createSdk(['resources.library.read'])
    resources.listResourceListSummaries.mockResolvedValue(
      Array.from({ length: 51 }, (_, index) => ({ ...resource, id: `item-${index}` })) as never,
    )
    const first = await sdk.list('app', { snapshot: true, limit: 50 }, 'a')
    await expect(sdk.list('app', { cursor: first.cursor, offset: 50 }, 'b')).rejects.toThrow(
      '分页已结束',
    )
    await expect(
      sdk.list('app', { cursor: first.cursor, offset: 50, types: ['chat'] }, 'a'),
    ).rejects.toThrow('范围已变化')
    externalApps.hasPermission.mockResolvedValue(false)
    await expect(sdk.list('app', { cursor: first.cursor, offset: 50 }, 'a')).rejects.toThrow()
    expect(resources.listResourceListSummaries).toHaveBeenCalledOnce()
  })
  it('passes type and ID filters to the storage owner and validates targeted ID batches', async () => {
    const { sdk, resources } = createSdk(['resources.library.read'])
    await expect(
      sdk.list('app', { types: ['characterCard'], ids: ['resource-1'] }),
    ).resolves.toMatchObject({ total: 1 })
    expect(resources.listResourceListSummaries).toHaveBeenCalledWith({
      types: ['characterCard'],
      ids: ['resource-1'],
    })
    await expect(sdk.list('app', { ids: [] })).resolves.toMatchObject({ items: [], total: 0 })
    await expect(sdk.list('app', { ids: ['missing'] })).resolves.toMatchObject({
      items: [],
      total: 0,
    })
    resources.listResourceListSummaries.mockClear()
    await expect(sdk.list('app', { ids: Array(51).fill('resource-1') })).rejects.toThrow('50')
    await expect(sdk.list('app', { ids: [''] })).rejects.toThrow('ID 无效')
    expect(resources.listResourceListSummaries).not.toHaveBeenCalled()
    expect(resources.get).not.toHaveBeenCalled()
  })
  it('checks current permissions without reading the installed runtime or package', async () => {
    const { sdk, externalApps } = createSdk(['resources.library.read'])
    await sdk.capabilities('app')
    await sdk.list('app', {})
    expect(externalApps.get).not.toHaveBeenCalled()
    expect(externalApps.getSummary).toHaveBeenCalledWith('app')
    externalApps.getSummary.mockResolvedValue({
      id: 'app',
      enabled: false,
      manifest: { permissions: [] },
    })
    await expect(sdk.capabilities('app')).rejects.toThrow('已被禁用')
  })
  it('does not inherit the APP content grant when a selected-resource tool has narrower permissions', async () => {
    const { sdk } = createSdk(['resources.selected.read', 'resources.content.read'])
    expect(await sdk.getPicked('app', resource.id)).toHaveProperty('data')
    const limited = await sdk.getPicked('app', resource.id, false)
    expect(limited).toMatchObject({ id: resource.id, name: resource.name })
    expect(limited).not.toHaveProperty('data')
    expect((await sdk.capabilities('app', ['resources.selected.read'])).permissions).toEqual([
      'resources.selected.read',
    ])
    expect((await sdk.capabilities('app', [])).permissions).toEqual([])
  })
  it('requires content and write grants for chat and avatar operations', async () => {
    const { sdk, resources } = createSdk(['resources.library.read'])
    await expect(sdk.readChat('app', { id: 'resource-1' })).rejects.toThrow('未获得')
    await expect(sdk.chatChapters('app', { id: 'resource-1' })).rejects.toThrow('未获得')
    await expect(sdk.readerStyle('app', { id: 'resource-1' })).rejects.toThrow('未获得')
    await expect(sdk.searchChat('app', { id: 'resource-1', query: 'x' })).rejects.toThrow('未获得')
    await expect(sdk.thumbnail('app', 'resource-1')).rejects.toThrow('未获得')
    await expect(sdk.chatVariables('app', { id: 'resource-1', floor: 0 })).rejects.toThrow('未获得')
    await expect(sdk.bindChat('app', { id: 'resource-1', characterId: 'card' })).rejects.toThrow(
      '未获得',
    )
    expect(resources.get).not.toHaveBeenCalled()
  })
  it('does not let a chat preview bypass isolated mode networking', async () => {
    const { sdk, resources } = createSdk([
      'resources.library.read',
      'resources.content.read',
      'network.https',
    ])
    await expect(sdk.readChat('app', { id: 'resource-1', remote: true })).rejects.toThrow(
      '兼容模式',
    )
    await expect(sdk.readChat('app', { id: 'resource-1', interactive: true })).rejects.toThrow(
      '兼容模式',
    )
    await expect(
      sdk.readerStyle('app', { id: 'resource-1', fonts: true, remote: true }),
    ).rejects.toThrow('兼容模式')
    expect(resources.get).not.toHaveBeenCalled()
  })
  it('only returns lightweight snapshots when listing the library', async () => {
    const { sdk } = createSdk(['resources.library.read'])
    const listed = await sdk.list('app', { limit: 25 })

    expect(listed).toMatchObject({ total: 1, nextOffset: null })
    expect(listed.items[0]).toMatchObject({ id: 'resource-1', type: 'characterCard', revision: 2 })
    expect(listed.items[0]).not.toHaveProperty('data')
  })

  it('requires explicit library and content permissions before returning metadata', async () => {
    const { sdk } = createSdk(['resources.library.read'])
    await expect(sdk.get('app', 'resource-1')).rejects.toThrow('未获得')

    const allowed = createSdk(['resources.library.read', 'resources.content.read'])
    await expect(allowed.sdk.get('app', 'resource-1')).resolves.toMatchObject({
      data: { format: 'character-card', safe: true },
    })
  })

  it('only reads a selected resource after the host picker returns its id', async () => {
    const { sdk } = createSdk(['resources.selected.read'])
    await expect(sdk.listPickable('app', {})).resolves.toHaveLength(1)
    await expect(sdk.getPicked('app', 'resource-1')).resolves.not.toHaveProperty('data')
  })

  it('updates only one normal resource field through the authorized SDK method', async () => {
    const { sdk, resources } = createSdk(['resources.write'])

    await expect(sdk.update('app', { id: 'resource-1', tags: ['已检查'] })).resolves.toMatchObject({
      id: 'resource-1',
      tags: ['已检查'],
      revision: 3,
    })
    expect(resources.updateExternalAppResource).toHaveBeenCalledWith({
      resourceId: 'resource-1',
      tags: ['已检查'],
    })
    await expect(sdk.update('app', { id: 'resource-1', metadata: {} })).rejects.toThrow(
      '至少提供一项',
    )
  })
})
