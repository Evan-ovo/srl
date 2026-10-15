import { ref } from 'vue'
import { expect, it, vi } from 'vitest'
import { unzipSync } from 'fflate'
import { useLibraryResourceActions } from './UseLibraryResourceActions'
import { ExportService } from '../services/ExportService'
import { hashBlob } from '../services/HashService'
import { RESOURCE_TYPE, toResourceListSummary, type Resource } from '../types/Resource'

const service = vi.hoisted(() => ({
  list: vi.fn(),
  listAllVersions: vi.fn(),
  listResourceListSummaries: vi.fn(),
  listVersionSummariesForResources: vi.fn(),
  get: vi.fn(),
  getVersion: vi.fn(),
  listVersions: vi.fn(),
  updateDetails: vi.fn(),
}))
const download = vi.hoisted(() => vi.fn())
vi.mock('../core/LibraryContainer', async () => {
  const { ExportService } = await import('../services/ExportService')
  return { resourceService: service, exportService: new ExportService() }
})
vi.mock('../utils/LibraryFormatting', () => ({ downloadBlob: download }))

function detailFixture() {
  const resource = {
    id: 'card',
    type: RESOURCE_TYPE.CHARACTER_CARD,
    contentHash: 'hash',
    updatedAt: 1,
    relatedResourceIds: ['old'],
    metadata: {},
    originalBlob: new Blob(['card']),
  } as Resource
  const context = {
    organizingResource: ref<Resource>(),
    organizingInitialTab: ref<'overview' | 'versions'>('overview'),
    organizingBoundResources: ref<Resource[]>([]),
    organizingVersions: ref([]),
    isOrganizing: ref(false),
    showNotice: vi.fn(),
    loadResources: vi.fn(async () => undefined),
  }
  const actions = useLibraryResourceActions(() => context as never)
  return { resource, context, actions }
}

it('opens an overview without reading related originals/history, and prepares only the requested tab', async () => {
  vi.resetAllMocks()
  const { resource, context, actions } = detailFixture()
  service.get.mockResolvedValue(resource)
  service.listVersions.mockResolvedValue([{ resource, active: true }])
  await actions.openResourceDetail(toResourceListSummary(resource))
  expect(service.get).toHaveBeenCalledExactlyOnceWith('card')
  expect(service.listVersions).not.toHaveBeenCalled()
  await actions.prepareResourceDetail('relations')
  expect(service.get).toHaveBeenCalledTimes(1)
  await Promise.all([
    actions.prepareResourceDetail('versions'),
    actions.prepareResourceDetail('versions'),
  ])
  expect(service.listVersions).toHaveBeenCalledExactlyOnceWith('card')
  expect(context.organizingVersions.value).toHaveLength(1)
  service.get.mockResolvedValue({ ...resource, id: 'old' })
  await actions.prepareResourceDetail('content')
  expect(context.organizingBoundResources.value.map((r) => r.id)).toEqual(['old'])
})

it('drops late resource, version and related reads after closing or switching details', async () => {
  vi.resetAllMocks()
  const { resource, context, actions } = detailFixture()
  let resolve!: (value: Resource) => void
  service.get.mockImplementationOnce(
    () =>
      new Promise<Resource>((done) => {
        resolve = done
      }),
  )
  const opening = actions.openResourceDetail(toResourceListSummary(resource))
  actions.closeResourceDetail()
  resolve(resource)
  await opening
  expect(context.organizingResource.value).toBeUndefined()
  service.get.mockResolvedValue(resource)
  await actions.openResourceDetail(resource)
  let finishVersions!: (value: unknown[]) => void
  service.listVersions.mockImplementationOnce(
    () =>
      new Promise((done) => {
        finishVersions = done
      }),
  )
  const loading = actions.prepareResourceDetail('versions')
  actions.closeResourceDetail()
  finishVersions([{ resource }])
  await loading
  expect(context.organizingVersions.value).toEqual([])
})

it('refreshes saved resource and old/new relations only; a failed save retains the draft', async () => {
  vi.resetAllMocks()
  const { resource, context, actions } = detailFixture()
  context.organizingResource.value = resource
  const details = {
    name: 'changed',
    description: '',
    type: resource.type,
    categoryIds: [],
    relatedResourceIds: ['new'],
    tags: [],
    sourceLinks: [],
  }
  service.updateDetails.mockRejectedValueOnce(new Error('write failed'))
  await actions.handleDetailSave(details)
  expect(context.loadResources).not.toHaveBeenCalled()
  expect(context.organizingResource.value?.id).toBe(resource.id)
  service.updateDetails.mockResolvedValue(undefined)
  await actions.handleDetailSave(details)
  expect(context.loadResources).toHaveBeenCalledExactlyOnceWith(['card', 'old', 'new'])
  expect(context.organizingResource.value).toBeUndefined()
})
it('exports only selected originals, their gallery and history with complete bytes and metadata', async () => {
  vi.resetAllMocks()
  const create = async (id: string): Promise<Resource> => {
    const originalBlob = new Blob([`bytes-${id}`])
    return {
      id,
      type: RESOURCE_TYPE.OTHER,
      name: id,
      fileName: `${id}.txt`,
      mimeType: 'text/plain',
      fileSize: originalBlob.size,
      contentHash: await hashBlob(originalBlob),
      originalBlob,
      description: '',
      metadata: { completeBody: id },
      tags: [],
      categoryId: null,
      favorite: false,
      createdAt: 1,
      updatedAt: 1,
    }
  }
  const selected = await create('selected'),
    unrelated = await create('unrelated')
  const gallery = {
    ...(await create('gallery')),
    metadata: { assetKind: 'resource-gallery-image', galleryOwnerId: selected.id },
  }
  const version = { ...(await create('history')), versionGroupId: selected.id }
  service.listResourceListSummaries.mockImplementation(async (filter) =>
    (filter?.ids ? [selected] : [selected, unrelated, gallery]).map(toResourceListSummary),
  )
  service.listVersionSummariesForResources.mockResolvedValue([toResourceListSummary(version)])
  service.get.mockImplementation(async (id) => [selected, gallery].find((r) => r.id === id))
  service.getVersion.mockResolvedValue(version)
  const context = {
    organizingResource: ref(selected),
    isOrganizing: ref(false),
    categories: ref([]),
    showNotice: vi.fn(),
  }
  await useLibraryResourceActions(() => context as never).handleRelatedDownload([selected.id])
  expect(context.showNotice.mock.calls[0]?.[0]).toBe('已打包下载 1 个关联文件')
  expect(service.list).not.toHaveBeenCalled()
  expect(service.listAllVersions).not.toHaveBeenCalled()
  expect(service.get.mock.calls.map(([id]) => id).sort()).toEqual(['gallery', 'selected'])
  expect(service.getVersion).toHaveBeenCalledExactlyOnceWith('history')
  expect(download).toHaveBeenCalledOnce()
  const zip = unzipSync(new Uint8Array(await download.mock.calls[0]![0].arrayBuffer()))
  const manifest = JSON.parse(new TextDecoder().decode(zip['manifest.json']))
  expect(manifest.resources.map((r: Resource) => r.id).sort()).toEqual(['gallery', 'selected'])
  expect(manifest.resources.find((r: Resource) => r.id === 'selected').metadata.completeBody).toBe(
    'selected',
  )
  expect(manifest.versions.map((r: Resource) => r.id)).toEqual(['history'])
  expect(context.isOrganizing.value).toBe(false)
  // Compare the existing archive format, including history and gallery inclusion.
  const eager = await new ExportService().createArchive(
    [selected, unrelated, gallery],
    [],
    { mode: 'partial', resourceIds: [selected.id], includeAllCategories: false },
    [version],
  )
  const expected = unzipSync(new Uint8Array(await eager.blob.arrayBuffer()))
  expect(Object.keys(zip).sort()).toEqual(Object.keys(expected).sort())
  for (const path of Object.keys(zip).filter((path) => path !== 'manifest.json'))
    expect(zip[path]).toEqual(expected[path])
})
