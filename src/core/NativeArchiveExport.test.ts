import { expect, it, vi, afterEach } from 'vitest'
import type { ArchiveEncoding } from '../services/ArchiveZipWriter'
import { ARCHIVE_FORMAT, ARCHIVE_VERSION } from '../types/Backup'
import { RESOURCE_TYPE, type Resource } from '../types/Resource'

const native = vi.hoisted(() => ({
  beginArchive: vi.fn(),
  getArchiveEntry: vi.fn(),
  resetArchiveInput: vi.fn(),
  appendArchiveInput: vi.fn(),
  compressArchiveEntry: vi.fn(),
  assembleArchive: vi.fn(),
  publishArchive: vi.fn(),
  discardArchiveTask: vi.fn(),
}))
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: () => native,
}))
import { openCheckpointArchiveWriter } from './NativeArchiveExport'
import { rememberNativeFile } from './NativeFileSource'

afterEach(() => vi.resetAllMocks())

it('reuses compressed resources without reading originals and routes remaining native files directly', async () => {
  const resource: Resource = {
    id: 'a',
    type: RESOURCE_TYPE.OTHER,
    name: 'a',
    description: '',
    fileName: 'a.txt',
    mimeType: 'text/plain',
    fileSize: 3,
    contentHash: 'a'.repeat(64),
    favorite: false,
    categoryId: null,
    tags: [],
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
    originalBlob: new Blob(['abc']),
  }
  const second = {
    ...resource,
    id: 'b',
    originalBlob: rememberNativeFile(new Blob(['abc']), 'file:///native-b'),
  }
  const read = vi.fn(async (r: Resource) => r)
  native.beginArchive.mockResolvedValue({ id: 'job' })
  native.getArchiveEntry.mockImplementation(async ({ path }: { path: string }) =>
    path === 'files/a'
      ? { entry: { bytes: 11, descriptor: { ...resource, archivePath: path } } }
      : {},
  )
  native.compressArchiveEntry.mockResolvedValue({ bytes: 12 })
  native.assembleArchive.mockResolvedValue({ bytes: 99 })
  const options: ArchiveEncoding = {
    resources: [resource, second],
    versions: [],
    communitySourceAttachments: [],
    manifest: {
      format: ARCHIVE_FORMAT,
      version: ARCHIVE_VERSION,
      mode: 'full',
      createdAt: new Date(1).toISOString(),
      resourceCount: 2,
      categoryCount: 0,
      categories: [],
      resources: [],
      versions: [],
      versionCount: 0,
    },
    read,
    path: (r) => `files/${r.id}`,
    describe: (r) => ({ ...r, archivePath: `files/${r.id}` }),
  }
  const writer = await openCheckpointArchiveWriter('task', 'archive.zip')
  expect(await writer.encode!(options)).toBe(99)
  expect(read.mock.calls.map(([r]) => r.id)).toEqual(['b'])
  expect(native.compressArchiveEntry).toHaveBeenCalledWith(
    expect.objectContaining({ path: 'files/b', uri: 'file:///native-b', size: 3 }),
  )
  expect(native.resetArchiveInput.mock.calls.map(([arg]) => arg.path)).toEqual(['manifest.json'])
  expect(native.assembleArchive).toHaveBeenCalledWith({
    id: 'job',
    paths: ['files/a', 'files/b', 'manifest.json'],
  })
  await writer.abort()
  expect(native.discardArchiveTask).not.toHaveBeenCalled()
  await writer.commit()
  expect(native.publishArchive).toHaveBeenCalledWith({ id: 'job' })
})

function pendingArchive(count = 1): ArchiveEncoding {
  const resources = Array.from({ length: count }, (_, index): Resource => ({
    id: 'item-' + index,
    type: RESOURCE_TYPE.OTHER,
    name: 'item-' + index,
    description: '',
    fileName: 'item.txt',
    mimeType: 'text/plain',
    fileSize: 3,
    contentHash: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    favorite: false,
    categoryId: null,
    tags: [],
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
    originalBlob: rememberNativeFile(new Blob(['abc']), 'file:///item-' + index),
  }))
  native.beginArchive.mockResolvedValue({ id: 'job' })
  native.getArchiveEntry.mockResolvedValue({})
  native.compressArchiveEntry.mockResolvedValue({ bytes: 12 })
  native.assembleArchive.mockResolvedValue({ bytes: 99 })
  return {
    resources,
    versions: [],
    communitySourceAttachments: [],
    manifest: {
      format: ARCHIVE_FORMAT,
      version: ARCHIVE_VERSION,
      mode: 'full',
      createdAt: new Date(1).toISOString(),
      resourceCount: resources.length,
      categoryCount: 0,
      categories: [],
      resources: [],
      versions: [],
      versionCount: 0,
    },
    read: vi.fn(async (resource) => resource),
    path: (resource, historical) => (historical ? 'versions/' : 'files/') + resource.id,
    describe: (resource, historical) => ({
      ...resource,
      archivePath: (historical ? 'versions/' : 'files/') + resource.id,
    }),
  }
}

it.each([1, 1001])('queries each missing checkpoint once for %i originals', async (count) => {
  const options = pendingArchive(count)
  options.versions = [{ ...options.resources[0]!, id: 'old', versionGroupId: 'item-0' }]
  options.manifest.versionCount = 1
  const writer = await openCheckpointArchiveWriter('task', 'archive.zip')
  expect(await writer.encode!(options)).toBe(99)
  const paths = native.compressArchiveEntry.mock.calls.map(([entry]) => entry.path)
  expect(paths).toHaveLength(count + 2)
  expect(new Set(paths).size).toBe(count + 2)
  expect(paths).toContain('versions/old')
  expect(paths.at(-1)).toBe('manifest.json')
  expect(options.read).toHaveBeenCalledTimes(count + 1)
  expect(native.resetArchiveInput.mock.calls.map(([entry]) => entry.path)).toEqual([
    'manifest.json',
  ])
  expect(native.assembleArchive).toHaveBeenCalledWith({ id: 'job', paths })
  expect(native.getArchiveEntry.mock.calls.length).toBe(paths.length)
  expect(native.getArchiveEntry.mock.calls.map(([entry]) => entry.path)).toEqual(paths)
  const manifest = JSON.parse(
    native.appendArchiveInput.mock.calls
      .filter(([entry]) => entry.path === 'manifest.json')
      .map(([entry]) => atob(entry.data))
      .join(''),
  )
  expect(manifest.resources.map((resource: Resource) => resource.id)).toEqual(
    options.resources.map((resource) => resource.id),
  )
  expect(manifest.versions.map((resource: Resource) => resource.id)).toEqual(['old'])
})

it.each(['read', 'compress'])(
  'rechecks checkpoints after a failed %s and explicit retry',
  async (step) => {
    const options = pendingArchive()
    if (step === 'read') vi.mocked(options.read).mockRejectedValueOnce(new Error('source failed'))
    else native.compressArchiveEntry.mockRejectedValueOnce(new Error('compress failed'))
    const writer = await openCheckpointArchiveWriter('task', 'archive.zip')
    await expect(writer.encode!(options)).rejects.toThrow('failed')
    expect(native.assembleArchive).not.toHaveBeenCalled()
    expect(native.publishArchive).not.toHaveBeenCalled()
    expect(native.discardArchiveTask).not.toHaveBeenCalled()
    native.getArchiveEntry.mockClear()
    native.compressArchiveEntry.mockClear()
    const descriptor = options.describe(options.resources[0]!, false)
    native.getArchiveEntry.mockImplementation(async ({ path }: { path: string }) =>
      path === 'files/item-0' ? { entry: { bytes: 12, descriptor } } : {},
    )
    const reads = vi.mocked(options.read).mock.calls.length
    expect(await writer.encode!(options)).toBe(99)
    expect(vi.mocked(options.read).mock.calls.length).toBe(reads)
    expect(native.getArchiveEntry.mock.calls.map(([entry]) => entry.path)).toEqual([
      'files/item-0',
      'manifest.json',
    ])
    expect(native.compressArchiveEntry.mock.calls.map(([entry]) => entry.path)).toEqual([
      'manifest.json',
    ])
  },
)

it('keeps the existing check for a checkpoint without a resource descriptor', async () => {
  const options = pendingArchive()
  native.getArchiveEntry.mockImplementation(async ({ path }: { path: string }) =>
    path === 'files/item-0' ? { entry: { bytes: 12 } } : {},
  )
  const writer = await openCheckpointArchiveWriter('task', 'archive.zip')
  expect(await writer.encode!(options)).toBe(99)
  expect(native.getArchiveEntry.mock.calls.map(([entry]) => entry.path)).toEqual([
    'files/item-0',
    'files/item-0',
    'manifest.json',
  ])
  expect(options.read).toHaveBeenCalledTimes(1)
  expect(native.compressArchiveEntry.mock.calls.map(([entry]) => entry.path)).toEqual([
    'manifest.json',
  ])
})

it('still delegates a checkpoint that appears during the source read to native compression', async () => {
  const options = pendingArchive()
  let checkpoint = false
  vi.mocked(options.read).mockImplementation(async (resource) => {
    checkpoint = true
    return resource
  })
  native.getArchiveEntry.mockImplementation(async ({ path }: { path: string }) =>
    path === 'files/item-0' && checkpoint ? { entry: { bytes: 12 } } : {},
  )
  native.compressArchiveEntry.mockImplementation(async ({ path }: { path: string }) => {
    if (path === 'files/item-0') expect(checkpoint).toBe(true)
    return { bytes: 12 }
  })
  const writer = await openCheckpointArchiveWriter('task', 'archive.zip')
  expect(await writer.encode!(options)).toBe(99)
  expect(native.compressArchiveEntry.mock.calls.map(([entry]) => entry.path)).toEqual([
    'files/item-0',
    'manifest.json',
  ])
})

it('does not carry a miss across cancellation or publish partial work', async () => {
  const options = pendingArchive(),
    controller = new AbortController()
  options.signal = controller.signal
  vi.mocked(options.read).mockImplementationOnce(async (resource) => {
    controller.abort(new Error('stopped'))
    return resource
  })
  const writer = await openCheckpointArchiveWriter('task', 'archive.zip')
  await expect(writer.encode!(options)).rejects.toThrow('stopped')
  expect(native.compressArchiveEntry).not.toHaveBeenCalled()
  expect(native.appendArchiveInput).not.toHaveBeenCalled()
  expect(native.assembleArchive).not.toHaveBeenCalled()
  expect(native.publishArchive).not.toHaveBeenCalled()
  await writer.abort()
  expect(native.discardArchiveTask).not.toHaveBeenCalled()
  native.getArchiveEntry.mockClear()
  expect(await writer.encode!({ ...options, signal: new AbortController().signal })).toBe(99)
  expect(native.getArchiveEntry.mock.calls.map(([entry]) => entry.path)).toEqual([
    'files/item-0',
    'manifest.json',
  ])
})
