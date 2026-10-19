import { Zip, ZipPassThrough } from 'fflate'
import { parsePersonalResource, type PersonalResourceDocument } from '../types/PersonalResource'
import type { Resource } from '../types/Resource'
import type { ParsedResource } from '../types/Import'
import type { RestoreStagingStore } from '../storage/RestoreStagingStore'
import { stageArchive } from './ArchiveExtraction'
import type { ResourceService } from './ResourceService'

export function personalResourceMetadata(document: PersonalResourceDocument): ParsedResource {
  const icon = document.icons?.find((item) => item.source === document.iconSource)
  const data = icon?.dataUrl.startsWith('data:') ? icon.dataUrl.split(',')[1] : undefined
  return {
    ...(data
      ? {
          thumbnailBlob: new Blob([Uint8Array.from(atob(data), (char) => char.charCodeAt(0))], {
            type: icon!.dataUrl.split(';')[0]!.slice(5),
          }),
        }
      : {}),
    type: document.kind,
    name: document.name,
    description:
      document.kind === 'extraStory'
        ? document.text.slice(0, 200)
        : document.kind === 'secret'
          ? '部署资料 · 私密字段需解锁查看'
          : document.text.slice(0, 200),
    metadata: {
      format: 'srl-personal-resource',
      attachmentCount: document.attachments.length,
      privateFieldCount: document.fields.filter((field) => field.private).length,
      phoneIconUrl: icon?.dataUrl.startsWith('https:') ? icon.dataUrl : '',
      ...(document.kind === 'pocketPhone' ? { personalDocument: document } : {}),
    },
  }
}

export async function readPersonalDocument(
  file: Blob,
  staging: RestoreStagingStore,
): Promise<PersonalResourceDocument> {
  const signature = new Uint8Array(await file.slice(0, 4).arrayBuffer())
  if (signature[0] !== 0x50 || signature[1] !== 0x4b) {
    if (file.size > 2 * 1024 * 1024) throw new Error('个人资源文本超过 2 MB')
    return parsePersonalResource(JSON.parse(await file.text()))
  }
  const job = await stageArchive(
    new File([file], 'resource.zip'),
    staging,
    (path) => path === 'srl-resource.json',
  )
  try {
    const entry = await staging.get(job, 'srl-resource.json')
    if (!entry || entry.size > 2 * 1024 * 1024) throw new Error('缺少有效的个人资源清单')
    return parsePersonalResource(JSON.parse(await entry.blob.text()))
  } finally {
    await staging.deleteJob(job)
  }
}

export class PersonalResourceService {
  private readonly resources: ResourceService
  private readonly staging: RestoreStagingStore
  constructor(resources: ResourceService, staging: RestoreStagingStore) {
    this.resources = resources
    this.staging = staging
  }

  read(resource: Resource): Promise<PersonalResourceDocument> {
    if (resource.type === 'pocketPhone' && resource.metadata.personalDocument)
      return Promise.resolve(parsePersonalResource(resource.metadata.personalDocument))
    return readPersonalDocument(resource.originalBlob, this.staging)
  }

  async attachment(resource: Resource, path: string): Promise<Blob> {
    const document = await this.read(resource)
    const expected = document.attachments.find((item) => item.path === path)
    if (!expected) throw new Error('附件不存在')
    const job = await stageArchive(
      new File([resource.originalBlob], resource.fileName),
      this.staging,
      (name) => name === path,
    )
    try {
      const entry = await this.staging.get(job, path)
      if (!entry || entry.size !== expected.size) throw new Error('附件缺失或大小不符')
      return entry.blob
    } finally {
      await this.staging.deleteJob(job)
    }
  }

  async save(
    document: PersonalResourceDocument,
    added: Map<string, File>,
    current?: Resource,
    restoredSourceHash?: string,
  ): Promise<Resource> {
    parsePersonalResource(document)
    const descriptor = new Blob([JSON.stringify(document)], { type: 'application/json' })
    if (descriptor.size > 2 * 1024 * 1024)
      throw new Error('个人资源文本超过 2 MB，请减少文本或字段内容')
    if (current && document.kind === 'pocketPhone' && !added.size) {
      const previous = await this.read(current)
      if (JSON.stringify(previous.attachments) === JSON.stringify(document.attachments)) {
        return this.resources.updatePersonalMetadata(current, personalResourceMetadata(document))
      }
    }
    if (document.kind === 'secret') {
      const { validateSecretResource } = await import('./PersonalResourceImport')
      await validateSecretResource(descriptor)
    }
    const file = await this.createFile(document, added, current)
    const parsed = personalResourceMetadata(document)
    if (restoredSourceHash) {
      if (
        document.kind !== 'secret' ||
        current?.contentHash !== restoredSourceHash ||
        !/^[a-f0-9]{64}$/iu.test(restoredSourceHash)
      )
        throw new Error('密钥恢复来源与当前原件不一致')
      parsed.metadata = {
        ...parsed.metadata,
        restoredSecretSourceHash: restoredSourceHash.toLowerCase(),
      }
    }
    if (current) return this.resources.updatePersonalContent(file, parsed, current.id)
    const result = await this.resources.importPreparedFile(file, personalResourceMetadata(document))
    if (result.status === 'failed') throw new Error(result.message)
    if (result.status === 'versionCandidate') throw new Error('资源需要确认版本')
    return result.resource
  }
  /** Materialize edited metadata only at the standalone export/file-replacement boundary. */
  async exportFile(resource: Resource): Promise<File> {
    return this.createFile(await this.read(resource), new Map(), resource)
  }

  private async createFile(
    document: PersonalResourceDocument,
    added: Map<string, File>,
    current?: Resource,
  ): Promise<File> {
    const descriptor = new Blob([JSON.stringify(document)], { type: 'application/json' })
    const stem = document.name.replace(/[\\/:*?"<>|]/g, '_')
    let file: File
    if (!document.attachments.length)
      file = new File([descriptor], `${stem}.srl-resource.json`, {
        type: 'application/json',
      })
    else {
      const parts: BlobPart[] = []
      let failure: Error | undefined
      const zip = new Zip((error, bytes) => {
        if (error) failure = error
        else parts.push(new Uint8Array(bytes))
      })
      const append = async (path: string, blob: Blob) => {
        const entry = new ZipPassThrough(path)
        zip.add(entry)
        const reader = blob.stream().getReader()
        try {
          while (true) {
            const { done, value } = await reader.read()
            entry.push(value ? new Uint8Array(value) : new Uint8Array(), done)
            if (failure) throw failure
            if (done) break
          }
        } finally {
          reader.releaseLock()
        }
      }
      const retained = new Set(
        document.attachments.filter((item) => !added.has(item.path)).map((item) => item.path),
      )
      const job =
        current && retained.size
          ? await stageArchive(
              new File([current.originalBlob], current.fileName),
              this.staging,
              (path) => retained.has(path),
            )
          : undefined
      try {
        await append('srl-resource.json', descriptor)
        for (const attachment of document.attachments) {
          const blob =
            added.get(attachment.path) ??
            (job ? (await this.staging.get(job, attachment.path))?.blob : undefined)
          if (!blob || blob.size !== attachment.size) throw new Error('附件内容与清单不一致')
          await append(attachment.path, blob)
        }
      } finally {
        if (job) await this.staging.deleteJob(job)
      }
      zip.end()
      if (failure) throw failure
      file = new File(parts, `${stem}.srl-resource.zip`, { type: 'application/zip' })
    }
    return file
  }
}
