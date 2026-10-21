/** @vitest-environment jsdom */
import { ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ResourceVersionView } from '../services/ResourceService'
import { RESOURCE_TYPE, type Resource, type ResourceSummary } from '../types/Resource'

const resourceApi = {
  activateVersion: vi.fn(),
  detachVersion: vi.fn(),
  listVersions: vi.fn(),
  deleteVersion: vi.fn(),
  deleteVersions: vi.fn(),
  get: vi.fn(),
  getSummary: vi.fn(),
  updateMetadata: vi.fn(),
  updateVersionNote: vi.fn(),
  mergeExistingResourceAsVersion: vi.fn(),
  replaceCharacterCardArtwork: vi.fn(),
}

vi.mock('../core/AppContainer', () => ({ resourceService: resourceApi }))

const confirmMock = vi.fn(async () => true)
const chooseActionMock = vi.fn(async (..._args: unknown[]) => 'confirm' as const)
vi.mock('./UseConfirmDialog', () => ({
  confirmAction: confirmMock,
  chooseAction: chooseActionMock,
}))

const { useResourceVersions } = await import('./UseResourceVersions')
const selectionMock = vi.hoisted(() => vi.fn())
vi.mock('../services/CharacterCardMigrationReview', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/CharacterCardMigrationReview')>()),
  selectCharacterCardMigrationEdits: selectionMock,
}))

const current = {
  id: 'r1',
  name: '夜航船',
  contentHash: 'r1',
  originalBlob: new Blob(['current']),
  updatedAt: 1,
} as Resource

function version(id: string, active: boolean): ResourceVersionView {
  return {
    active,
    resource: { id, contentHash: id, fileName: `${id}.png`, versionLabel: `版本 ${id}` },
  } as ResourceVersionView
}

function setup(versions: ResourceVersionView[] = []) {
  const notices: string[] = []
  const organizingResource = ref<Resource | undefined>(current)
  const organizingVersions = ref<ResourceVersionView[]>(versions)
  const isOrganizing = ref(false)
  const resources = ref<ResourceSummary[]>([{ id: 'r2', name: '旧版夜航船' } as ResourceSummary])
  const loadResources = vi.fn(async () => {})
  const refreshStorageHealth = vi.fn(async () => {})
  const api = useResourceVersions({
    organizingResource,
    organizingVersions,
    isOrganizing,
    resources,
    showNotice: (m) => notices.push(m),
    loadResources,
    refreshStorageHealth,
  })
  return { api, notices, organizingResource, organizingVersions, isOrganizing, loadResources }
}

describe('useResourceVersions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resourceApi.listVersions.mockResolvedValue([])
    selectionMock.mockImplementation(async (edits) => edits)
  })

  it('切换当前版本后刷新版本列表与资源索引', async () => {
    const next = { id: 'r1', name: '夜航船 v2' } as Resource
    resourceApi.activateVersion.mockResolvedValue(next)
    const { api, organizingResource, loadResources, notices } = setup([version('v2', false)])

    await api.handleActivateVersion('v2')

    expect(resourceApi.activateVersion).toHaveBeenCalledWith('r1', 'v2')
    expect(organizingResource.value).toStrictEqual(next)
    expect(loadResources).toHaveBeenCalledExactlyOnceWith(['r1'])
    expect(notices[0]).toContain('已切换当前展示版本')
  })

  it('按统一清单选择迁移角色卡修改，再更新激活版本的补丁元数据', async () => {
    const edit = {
      id: 'greeting-edit',
      section: 'greeting',
      operation: 'add',
      targetKey: 'alternate:added',
      label: '新备用开场白',
      after: '迁移后的备用开场白',
      migrateToVersions: true,
      updatedAt: 1,
    }
    const targetCard = {
      spec: 'chara_card_v2',
      data: { first_mes: '新版主开场白', alternate_greetings: [] },
    }
    const targetVersion = {
      id: 'v2',
      name: '夜航船新版',
      type: RESOURCE_TYPE.CHARACTER_CARD,
      metadata: { card: targetCard, characterContentEdits: [] },
    } as unknown as Resource
    const next = {
      id: 'r1',
      name: '夜航船新版',
      type: RESOURCE_TYPE.CHARACTER_CARD,
      metadata: { card: targetCard, characterContentEdits: [] },
    } as unknown as Resource
    resourceApi.activateVersion.mockResolvedValue(next)
    resourceApi.updateMetadata.mockResolvedValue(next)
    chooseActionMock.mockResolvedValueOnce('confirm')
    const { api, organizingResource } = setup([
      { active: false, resource: targetVersion } as ResourceVersionView,
    ])
    organizingResource.value = {
      ...current,
      type: RESOURCE_TYPE.CHARACTER_CARD,
      metadata: {
        card: { data: { first_mes: '原开场', alternate_greetings: [] } },
        characterContentEdits: [edit],
      },
    } as Resource

    await api.handleActivateVersion('v2')

    expect(selectionMock).toHaveBeenCalledOnce()
    expect(selectionMock.mock.calls[0]?.[0]).toEqual([edit])
    expect(resourceApi.updateMetadata).toHaveBeenCalledWith('r1', {
      characterContentEdits: [
        expect.objectContaining({
          label: '新备用开场白',
          targetKey: 'alternate:added',
          migrateToVersions: true,
        }),
      ],
    })
  })

  it('正在进行其他版本操作时忽略并发调用', async () => {
    const { api, isOrganizing } = setup()
    isOrganizing.value = true
    await api.handleActivateVersion('v2')
    expect(resourceApi.activateVersion).not.toHaveBeenCalled()
  })

  it('不允许删除当前版本', async () => {
    const { api } = setup([version('v1', true)])
    await api.handleDeleteResourceVersion('v1')
    expect(resourceApi.deleteVersions).not.toHaveBeenCalled()
  })

  it('删除历史版本前必须确认', async () => {
    const { api, loadResources } = setup([version('v1', false)])
    confirmMock.mockResolvedValueOnce(false)
    await api.handleDeleteResourceVersion('v1')
    expect(resourceApi.deleteVersions).not.toHaveBeenCalled()

    confirmMock.mockResolvedValueOnce(true)
    resourceApi.get.mockResolvedValue(current)
    await api.handleDeleteResourceVersion('v1')
    expect(resourceApi.deleteVersions).toHaveBeenCalledWith('r1', ['v1'])
    expect(loadResources).toHaveBeenCalledExactlyOnceWith(['r1'])
  })

  it('refreshes only the owner and the new standalone resource after detaching history', async () => {
    confirmMock.mockResolvedValueOnce(true)
    resourceApi.detachVersion.mockResolvedValue({ id: 'v1' })
    resourceApi.get.mockResolvedValue(current)
    const { api, loadResources } = setup([version('v1', false)])
    await api.handleDetachResourceVersion('v1')
    expect(resourceApi.detachVersion).toHaveBeenCalledWith('r1', 'v1')
    expect(loadResources).toHaveBeenCalledExactlyOnceWith(['r1', 'v1'])
  })

  it('允许删除当前逻辑版本中的非当前自定义卡面封装', async () => {
    const custom = { id: 'custom-art', fileName: 'custom.png' } as Resource
    const activeGroup = {
      active: true,
      resource: current,
      carriers: [current, custom],
    } as ResourceVersionView
    resourceApi.get.mockResolvedValue(current)
    const { api } = setup([activeGroup])

    await api.handleDeleteResourceVersion(custom.id)

    expect(resourceApi.deleteVersions).toHaveBeenCalledWith('r1', ['custom-art'])
  })

  it('更换卡面后刷新同一资源的封装列表', async () => {
    const next = { ...current, fileName: '自定义卡面.png' } as Resource
    resourceApi.replaceCharacterCardArtwork.mockResolvedValue(next)
    const { api, organizingResource, notices } = setup()
    const file = new File(['image'], '喜欢的图片.png', { type: 'image/png' })

    await api.handleReplaceCharacterCardArtwork(file)

    expect(resourceApi.replaceCharacterCardArtwork).toHaveBeenCalledWith('r1', file)
    expect(organizingResource.value).toStrictEqual(next)
    expect(notices[0]).toContain('原卡面和原文件仍保留')
  })

  it('版本备注保存与清除给出不同提示', async () => {
    resourceApi.getSummary
      .mockResolvedValueOnce({ ...version('v1', false).resource, versionNote: '作者原版' })
      .mockResolvedValueOnce({ ...version('v1', false).resource, versionNote: '' })
    const { api, notices, loadResources } = setup([version('v1', false)])
    await api.handleUpdateVersionNote('v1', '作者原版')
    await api.handleUpdateVersionNote('v1', '   ')
    expect(notices).toEqual(['备注已保存', '备注已清除'])
    expect(resourceApi.get).not.toHaveBeenCalled()
    expect(resourceApi.listVersions).not.toHaveBeenCalled()
    expect(loadResources).not.toHaveBeenCalled()
  })

  it('updates an active note from persisted metadata without reloading originals or the full catalogue', async () => {
    resourceApi.getSummary.mockResolvedValue({
      ...current,
      versionNote: 'stored note',
      updatedAt: 5,
    })
    const { api, organizingResource, organizingVersions, loadResources } = setup([
      { active: true, resource: current, carriers: [current] },
    ])
    const blob = organizingResource.value!.originalBlob
    await api.handleUpdateVersionNote('r1', ' input note ')
    expect(resourceApi.getSummary).toHaveBeenCalledWith('r1', false)
    expect(organizingResource.value?.versionNote).toBe('stored note')
    expect(organizingResource.value?.originalBlob).toBe(blob)
    expect(organizingVersions.value[0]?.carriers?.[0]?.versionNote).toBe('stored note')
    expect(loadResources).toHaveBeenCalledExactlyOnceWith(['r1'])
    expect(resourceApi.get).not.toHaveBeenCalled()
    expect(resourceApi.listVersions).not.toHaveBeenCalled()
  })

  it('updates only the selected historical carrier while preserving other carriers and originals', async () => {
    const first = { ...version('v1', false).resource, originalBlob: new Blob(['one']) }
    const second = { ...version('v2', false).resource, originalBlob: new Blob(['two']) }
    const { api, organizingVersions, loadResources } = setup([
      { active: false, resource: first, carriers: [first, second] },
    ])
    resourceApi.getSummary.mockResolvedValue({ ...second, versionNote: 'second', updatedAt: 9 })
    await api.handleUpdateVersionNote('v2', 'second')
    expect(resourceApi.getSummary).toHaveBeenCalledWith('v2', true)
    expect(organizingVersions.value[0]?.resource.versionNote).toBeUndefined()
    expect(organizingVersions.value[0]?.carriers?.[1]?.versionNote).toBe('second')
    expect(organizingVersions.value[0]?.carriers?.[1]?.originalBlob).toBe(second.originalBlob)
    expect(loadResources).not.toHaveBeenCalled()
  })

  it('keeps the established detail read on a real content change, but refreshes only the selected resource', async () => {
    resourceApi.getSummary.mockResolvedValue({
      ...current,
      contentHash: 'new',
      versionNote: 'changed',
    })
    const next = { ...current, contentHash: 'new' }
    resourceApi.get.mockResolvedValue(next)
    resourceApi.listVersions.mockResolvedValue([{ active: true, resource: next }])
    const { api, organizingResource, loadResources } = setup([{ active: true, resource: current }])
    await api.handleUpdateVersionNote('r1', 'changed')
    expect(organizingResource.value?.contentHash).toBe('new')
    expect(resourceApi.get).toHaveBeenCalledOnce()
    expect(resourceApi.listVersions).toHaveBeenCalledOnce()
    expect(loadResources).toHaveBeenCalledExactlyOnceWith(['r1'])
  })

  it('does not publish a late metadata read into another resource detail', async () => {
    let release!: (value: Resource) => void
    resourceApi.getSummary.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const { api, organizingResource, organizingVersions } = setup([version('v1', false)])
    const pending = api.handleUpdateVersionNote('v1', 'old detail')
    await Promise.resolve()
    organizingResource.value = { ...current, id: 'other' }
    organizingVersions.value = []
    release({ ...version('v1', false).resource, versionNote: 'old detail' })
    await pending
    expect(organizingResource.value.id).toBe('other')
    expect(organizingVersions.value).toEqual([])
  })

  it('preserves the displayed note on write failure or readback failure, distinguishing a saved note', async () => {
    const { api, notices, organizingVersions } = setup([version('v1', false)])
    resourceApi.updateVersionNote.mockRejectedValueOnce(new Error('write failed'))
    await api.handleUpdateVersionNote('v1', 'new')
    expect(notices.at(-1)).toBe('write failed')
    expect(resourceApi.getSummary).not.toHaveBeenCalled()
    resourceApi.getSummary.mockRejectedValueOnce(new Error('read failed'))
    await api.handleUpdateVersionNote('v1', 'new')
    expect(notices.at(-1)).toContain('备注已保存，但显示刷新未完成')
    expect(organizingVersions.value[0]?.resource.versionNote).toBeUndefined()
  })

  it('合并不存在的资源时提示并跳过', async () => {
    const { api, notices } = setup()
    await api.handleMergeExistingVersion('missing', '')
    expect(notices).toEqual(['要合并的资源已经不存在'])
    expect(resourceApi.mergeExistingResourceAsVersion).not.toHaveBeenCalled()
  })

  it('手动合并成功后同时刷新存储用量', async () => {
    resourceApi.mergeExistingResourceAsVersion.mockResolvedValue(current)
    confirmMock.mockResolvedValueOnce(true)
    const { api, notices, loadResources } = setup()
    await api.handleMergeExistingVersion('r2', '来自旧库')
    expect(resourceApi.mergeExistingResourceAsVersion).toHaveBeenCalledWith('r1', 'r2', '来自旧库')
    expect(loadResources).toHaveBeenCalledExactlyOnceWith(undefined)
    expect(notices).toEqual(['已手动加入历史版本'])
  })

  it('没有打开任何资源时所有操作都是空动作', async () => {
    const { api, organizingResource } = setup()
    organizingResource.value = undefined
    await api.handleActivateVersion('v1')
    await api.handleUpdateVersionNote('v1', 'x')
    await api.handleMergeExistingVersion('r2', '')
    expect(resourceApi.activateVersion).not.toHaveBeenCalled()
    expect(resourceApi.updateVersionNote).not.toHaveBeenCalled()
    expect(resourceApi.mergeExistingResourceAsVersion).not.toHaveBeenCalled()
  })
})
