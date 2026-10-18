import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppDatabase } from '../database/AppDatabase'
import { IndexedDbGeneratedImageAlbumStorage } from '../storage/IndexedDbGeneratedImageAlbumStorage'
import { IndexedDbFrontendWorkshopProjectStorage } from '../storage/IndexedDbFrontendWorkshopProjectStorage'
import { IndexedDbArchiveStorage } from '../storage/IndexedDbArchiveStorage'
import { MemoryRestoreStagingStore } from '../storage/RestoreStagingStore'
import { createFrontendWorkshopProject } from '../types/FrontendWorkshopProject'
import { createFrontendWorkshopSourceDocument } from '../types/FrontendWorkshopSourceDocument'
import { createFrontendWorkshopSourceComponent } from '../types/FrontendWorkshopSourceComponent'
import { GeneratedImageAlbumService } from './GeneratedImageAlbumService'
import { ExportService } from './ExportService'
import { RestoreService } from './RestoreService'
import {
  createStructuredSnapshot,
  parseStructuredSnapshot,
  structuredSnapshotParts,
} from './CloudStructuredSnapshot'
import { hashCloudBlob } from './CloudArchiveCodec'
import { portableRestoreScopeIds, selectRestorePortableData } from './BackupRestoreSelection'
import { parseAlbumBackup } from './GeneratedImageAlbumBackup'
import {
  buildNativeRestorePlan,
  materializeStructuredArchive,
  type CloudBackupSnapshotOperationsContext,
} from './CloudBackupSnapshotOperations'
import type { ArchivePortableData } from '../types/Backup'
import type { GeneratedImageAlbumItem } from '../types/GeneratedImageAlbum'

vi.mock('../utils/createImageThumbnail', () => ({
  createImageThumbnail: vi.fn(async () => new Blob(['thumb'], { type: 'image/webp' })),
}))

const databases: AppDatabase[] = []
const db = () => {
  const value = new AppDatabase('portable-migration-' + crypto.randomUUID())
  databases.push(value)
  return value
}
const album = (database: AppDatabase) =>
  new GeneratedImageAlbumService(new IndexedDbGeneratedImageAlbumStorage(database), async () => {
    throw new Error('no generation/network')
  })
const item = (id: string, blob: Blob): GeneratedImageAlbumItem => ({
  id,
  name: '已保存图片',
  source: 'generated',
  prompt: 'prompt',
  category: '作品',
  mimeType: 'image/png',
  sizeBytes: blob.size,
  hostedUrl: 'https://img.example/item.png',
  createdAt: 100,
  updatedAt: 200,
})
const blob = new Blob([new Uint8Array(1024 * 1024).fill(41)], { type: 'image/png' })

afterEach(async () => {
  for (const database of databases.splice(0)) {
    database.close()
    await database.delete()
  }
})

async function snapshot() {
  return createStructuredSnapshot(
    [],
    [],
    [],
    {
      version: 1,
      generatedImageAlbum: [
        { item: item('parent', blob) },
        {
          item: {
            ...item('child', blob),
            generationManifest: {
              version: 1,
              provider: 'openai',
              model: 'image',
              prompt: 'p',
              width: 256,
              height: 256,
              outputFormat: 'png',
              parameters: {},
              createdAt: 100,
              parentImageId: 'parent',
            },
          },
        },
      ],
    },
    { readAlbumFile: async () => blob },
  )
}

describe('portable app migration', () => {
  it('uses revision 5, one deduplicated immutable image object, with independent scope selection', async () => {
    const result = await snapshot()
    expect(result.snapshot.version).toBe(5)
    expect(
      parseStructuredSnapshot(JSON.parse(JSON.stringify(result.snapshot))).portableData
        .generatedImageAlbum,
    ).toHaveLength(2)
    expect(structuredSnapshotParts(result.snapshot)).toHaveLength(1)
    expect(result.snapshot.resources).toHaveLength(0)
    expect(portableRestoreScopeIds(result.snapshot.portableData)).toEqual([
      'extra.generatedImageAlbum',
    ])
    expect(selectRestorePortableData(result.snapshot.portableData, [])).toEqual({ version: 1 })
    expect(() => parseStructuredSnapshot({ ...result.snapshot, version: 4 })).toThrow('修订 5')
  })

  it('restores original bytes and metadata into an empty database, then reopens and retries without downloads', async () => {
    const result = await snapshot(),
      database = db(),
      service = album(database)
    const read = vi.fn(async () => blob)
    await service.importPortableState(result.snapshot.portableData.generatedImageAlbum!, read)
    const expected = result.snapshot.portableData.generatedImageAlbum!.map((entry) => entry.item)
    expect(
      (await service.exportPortableState())
        .map((entry) => entry.item)
        .sort((a, b) => a.id.localeCompare(b.id)),
    ).toEqual(expected.sort((a, b) => a.id.localeCompare(b.id)))
    database.close()
    await database.open()
    expect(await hashCloudBlob(await album(database).getOriginalBlob('parent'))).toBe(
      await hashCloudBlob(blob),
    )
    read.mockClear()
    await album(database).importPortableState(
      result.snapshot.portableData.generatedImageAlbum!,
      read,
    )
    expect(read).not.toHaveBeenCalled()
    expect(await service.count()).toBe(2)
  })

  it('preserves conflicting local originals and remaps parent image references; retries do not duplicate', async () => {
    const result = await snapshot(),
      database = db(),
      service = album(database)
    const storage = new IndexedDbGeneratedImageAlbumStorage(database)
    const old = new Blob(['old'], { type: 'image/png' })
    await storage.put(item('parent', old), {
      id: 'parent',
      originalBlob: old,
      originalMimeType: 'image/png',
      updatedAt: 200,
    })
    await service.importPortableState(
      result.snapshot.portableData.generatedImageAlbum!,
      async () => blob,
    )
    expect(await (await service.getOriginalBlob('parent')).text()).toBe('old')
    const rows = (await service.exportPortableState()).map((entry) => entry.item)
    const restoredParent = rows.find((row) => row.id.startsWith('parent-restored-'))!
    expect(rows.find((row) => row.id === 'child')?.generationManifest?.parentImageId).toBe(
      restoredParent.id,
    )
    await service.importPortableState(
      result.snapshot.portableData.generatedImageAlbum!,
      async () => blob,
    )
    expect(await service.count()).toBe(3)
  })

  it('rejects corrupt originals and stops before the first read on cancellation', async () => {
    const result = await snapshot(),
      service = album(db())
    await expect(
      service.importPortableState(
        result.snapshot.portableData.generatedImageAlbum!,
        async () => new Blob(['broken']),
      ),
    ).rejects.toThrow('完整性')
    expect(await service.count()).toBe(0)
    const controller = new AbortController()
    controller.abort()
    const read = vi.fn(async () => blob)
    await expect(
      service.importPortableState(
        result.snapshot.portableData.generatedImageAlbum!,
        read,
        controller.signal,
      ),
    ).rejects.toThrow()
    expect(read).not.toHaveBeenCalled()
  })

  it('fails backup when a selected local image is missing or changed, and rejects missing object descriptors', async () => {
    const data: ArchivePortableData = {
      version: 1,
      generatedImageAlbum: [{ item: item('missing', blob) }],
    }
    await expect(createStructuredSnapshot([], [], [], data)).rejects.toThrow('原图缺失')
    await expect(
      createStructuredSnapshot([], [], [], data, {
        readAlbumFile: async () => new Blob(['changed']),
      }),
    ).rejects.toThrow('原图缺失')
    expect(() => parseAlbumBackup(data.generatedImageAlbum)).toThrow()
  })

  it('round-trips the same image scope through ZIP staging, restores only selected data, and reopens', async () => {
    const result = await snapshot(),
      target = db(),
      service = album(target)
    const exported = await new ExportService(undefined, undefined, async () => blob).createArchive(
      [],
      [],
      { mode: 'full', portableData: result.snapshot.portableData },
    )
    expect(exported.manifest.version).toBe(5)
    const restore = new RestoreService(
      new IndexedDbArchiveStorage(target),
      new MemoryRestoreStagingStore(),
      undefined,
      service,
    )
    const prepared = await restore.prepare(new File([exported.blob], 'migration.zip'), [], [], true)
    await restore.restore(prepared)
    target.close()
    await target.open()
    expect(await service.count()).toBe(2)
    expect(await hashCloudBlob(await service.getOriginalBlob('child'))).toBe(
      await hashCloudBlob(blob),
    )
    expect(await target.resources.count()).toBe(0)
  })

  it('freezes album identity in native export checkpoints and rejects changed originals on resume', async () => {
    let bytes = blob
    const exporter = new ExportService(undefined, undefined, async () => bytes)
    const options = await exporter.prepareOptions(
      {
        mode: 'full',
        portableData: { version: 1, generatedImageAlbum: [{ item: item('snapshot-image', blob) }] },
      },
      undefined,
      true,
    )
    expect(options.portableData?.generatedImageAlbum?.[0]?.object?.totalSha256).toBe(
      await hashCloudBlob(blob),
    )
    bytes = new Blob([new Uint8Array(blob.size).fill(72)], { type: 'image/png' })
    await expect(exporter.createArchive([], [], options)).rejects.toThrow('相册原图校验失败')
  })

  it('partitions album images across ZIP volumes once, while retaining derived-image families together', async () => {
    const result = await snapshot()
    const data: ArchivePortableData = {
      version: 1,
      generatedImageAlbum: [
        ...result.snapshot.portableData.generatedImageAlbum!,
        { item: item('independent', blob) },
      ],
    }
    const read = vi.fn(async () => blob)
    const files = await new ExportService(undefined, undefined, read).createArchives([], [], {
      mode: 'partial',
      splitSizeBytes: blob.size,
      portableData: data,
    })
    expect(files).toHaveLength(2)
    const ids = files.map((file) =>
      file.manifest.portableData!.generatedImageAlbum!.map((entry) => entry.item.id),
    )
    expect(ids).toEqual([['parent', 'child'], ['independent']])
    expect(read).toHaveBeenCalledTimes(3)
    const database = db(),
      service = album(database)
    const restore = new RestoreService(
      new IndexedDbArchiveStorage(database),
      new MemoryRestoreStagingStore(),
      undefined,
      service,
    )
    for (const file of files)
      await restore.restore(
        await restore.prepare(new File([file.blob], file.fileName), [], [], true),
      )
    expect(await service.count()).toBe(3)
    expect((await service.get('child'))?.generationManifest?.parentImageId).toBe('parent')
  })

  it('includes album files in the native download plan and cloud-to-ZIP reads from the snapshot, not the source device', async () => {
    const result = await snapshot()
    const config = {
      provider: 'webdav' as const,
      baseUrl: 'https://cloud.example/dav',
      folder: 'backups',
      username: 'fixture',
      retention: 7,
      autoBackup: false,
    }
    const read = vi.fn(async () => blob)
    const context = {
      exportService: new ExportService(undefined, undefined, async () => {
        throw new Error('must not read local album')
      }),
      readWebDavStructuredSnapshot: async () => result.snapshot,
      createWebDavObjectReader: () => read,
    } as unknown as CloudBackupSnapshotOperationsContext
    const plan = await buildNativeRestorePlan(context, result.snapshot, config, 'fixture-secret')
    expect(plan.objects).toHaveLength(1)
    expect(plan.resources).toHaveLength(2)
    expect(
      plan.resources.every(
        (row) =>
          row.hash === result.snapshot.portableData.generatedImageAlbum![0]!.object!.totalSha256,
      ),
    ).toBe(true)
    const zip = await materializeStructuredArchive(
      context,
      {
        id: 'fixture',
        kind: 'webdavSnapshot',
        objectKey: 'snapshot.srlmanifest.v3.json.gz',
        size: 100,
        createdAt: Date.now(),
      },
      config,
      'fixture-secret',
    )
    const target = db(),
      owner = album(target)
    const restore = new RestoreService(
      new IndexedDbArchiveStorage(target),
      new MemoryRestoreStagingStore(),
      undefined,
      owner,
    )
    await restore.restore(await restore.prepare(new File([zip.blob], zip.fileName), [], [], true))
    expect(await owner.count()).toBe(2)
    expect(await hashCloudBlob(await owner.getOriginalBlob('parent'))).toBe(
      await hashCloudBlob(blob),
    )
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('keeps component dependency identities stable when an unassociated local component conflicts', async () => {
    const source = db(),
      target = db()
    const project = createFrontendWorkshopProject('status', 100)
    const first = createFrontendWorkshopSourceComponent(
      {
        name: '父组件',
        source: { html: '<p>source</p>', css: '', javascript: '' },
        root: { tagName: 'p' },
        provenance: { origin: 'manual' },
        projectIds: [project.id],
      },
      'parent-component',
      100,
    )
    const second = createFrontendWorkshopSourceComponent(
      {
        name: '子组件',
        source: { html: '<span>child</span>', css: '', javascript: '' },
        root: { tagName: 'span' },
        provenance: { origin: 'derived', sourceComponentId: first.id },
        projectIds: [project.id],
        dependencies: [{ kind: 'component', specifier: first.id }],
      },
      'child-component',
      100,
    )
    await source.frontendWorkshopProjects.put(project)
    await source.frontendWorkshopSourceComponents.bulkPut([first, second])
    await target.frontendWorkshopSourceComponents.put({
      ...first,
      projectIds: [],
      source: { ...first.source, html: '<p>local</p>' },
    })
    const importer = new IndexedDbFrontendWorkshopProjectStorage(target)
    const data = await new IndexedDbFrontendWorkshopProjectStorage(source).exportPortableState()
    await importer.importPortableState(data)
    const restored = await target.frontendWorkshopSourceComponents.get(second.id)
    expect(restored?.dependencies[0]?.specifier).toMatch(/^parent-component-restored-/)
    expect(restored?.provenance.sourceComponentId).toBe(restored?.dependencies[0]?.specifier)
    await importer.importPortableState(data)
    expect(await target.frontendWorkshopSourceComponents.count()).toBe(3)
    expect((await target.frontendWorkshopSourceComponents.get(first.id))?.source.html).toBe(
      '<p>local</p>',
    )
  })

  it('exports and imports project Source verbatim, last_good, saved AI sessions and component associations', async () => {
    const source = db(),
      target = db(),
      storage = new IndexedDbFrontendWorkshopProjectStorage(source)
    const project = createFrontendWorkshopProject('status', 100)
    const document = createFrontendWorkshopSourceDocument(
      project.id,
      '  <unknown attr="保留">\n<script>const x = 1</script>  ',
      100,
    )
    const component = createFrontendWorkshopSourceComponent(
      {
        name: '模块',
        source: { html: '<x-unknown/>', css: '', javascript: '' },
        root: { tagName: 'x-unknown' },
        provenance: { origin: 'project-selection', projectId: project.id },
        projectIds: [project.id],
      },
      'component-saved',
      100,
    )
    await source.frontendWorkshopProjects.put(project)
    await source.frontendWorkshopProjectLastGood.put({
      id: project.id,
      projectId: project.id,
      project,
      savedAt: 90,
    })
    await source.frontendWorkshopSourceDocuments.put(document)
    await source.frontendWorkshopSourceDocumentLastGood.put({
      projectId: project.id,
      document: { ...document, authorSource: ' previous ' },
      savedAt: 90,
    })
    await source.frontendWorkshopSourceComponents.put(component)
    await source.frontendWorkshopSourceComponents.put({
      ...component,
      id: 'unassociated',
      projectIds: [],
    })
    await source.settings.put({
      id: 'frontend-workshop-ai-local:session:' + project.id,
      value: {
        revision: 2,
        data: {
          version: 1,
          snapshot: {
            projectId: project.id,
            turns: [],
            generations: [],
            activeGenerationId: null,
            materializedGenerationId: null,
            pending: false,
            applying: false,
            error: null,
          },
          anchors: [
            {
              id: 'anchor',
              projectId: project.id,
              sourceCreatedAt: 100,
              sourceRevision: 1,
              sourceFingerprint: 'fixture',
              label: 'saved',
              createdAt: 100,
              textUnits: 1,
              authorSource: ' old source ',
            },
          ],
          materializedSourceRevision: 1,
        },
      },
      updatedAt: 100,
    })
    const data = await storage.exportPortableState()
    expect(data.components).toHaveLength(1)
    const importer = new IndexedDbFrontendWorkshopProjectStorage(target)
    await importer.importPortableState(data)
    target.close()
    await target.open()
    expect(await importer.exportPortableState()).toEqual(data)
    await importer.importPortableState(data)
    expect(await target.frontendWorkshopProjects.count()).toBe(1)
    expect(await target.frontendWorkshopSourceComponents.count()).toBe(1)
    await target.frontendWorkshopSourceDocuments.put({ ...document, authorSource: 'local changed' })
    await importer.importPortableState(data)
    const restored = await importer.exportPortableState()
    const moved = restored.projects.find((row) => row.id !== project.id)!
    expect(restored.documents.find((row) => row.projectId === project.id)?.authorSource).toBe(
      'local changed',
    )
    expect(restored.documents.find((row) => row.projectId === moved.id)?.authorSource).toBe(
      document.authorSource,
    )
    expect(
      restored.components.some(
        (row) => row.projectIds.includes(moved.id) && row.provenance.projectId === moved.id,
      ),
    ).toBe(true)
    const session = restored.sessions.find((row) => row.id.endsWith(moved.id))!.value as {
      data: {
        snapshot: { projectId: string }
        anchors: { projectId: string; authorSource: string }[]
      }
    }
    expect(session.data.snapshot.projectId).toBe(moved.id)
    expect(session.data.anchors[0]).toMatchObject({
      projectId: moved.id,
      authorSource: ' old source ',
    })
    await importer.importPortableState(data)
    expect(await target.frontendWorkshopProjects.count()).toBe(2)
  })
})
