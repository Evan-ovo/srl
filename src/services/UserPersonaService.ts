import {
  createEmptyPersonaBackup,
  parseSillyTavernPersonaBackup,
  serializeSillyTavernPersonaBackup,
} from '../parser/SillyTavernPersonaBackup'
import {
  getResourceCategoryIds,
  isUserPersonaAvatarAttachment,
  RESOURCE_TYPE,
  USER_PERSONA_AVATAR_ASSET_KIND,
  type Resource,
} from '../types/Resource'
import type { ParsedResource } from '../types/Import'
import type {
  SillyTavernPersonaBackup,
  UserPersonaBackupView,
  UserPersonaDraft,
} from '../types/UserPersona'
import type { ResourceService } from './ResourceService'
import {
  fetchUserPersonaAvatar,
  normalizeUserPersonaAvatarId,
  normalizeUserPersonaAvatarUrl,
  prepareUserPersonaAvatar,
} from '../utils/UserPersonaAvatar'

export interface UserPersonaImportReport {
  imported: number
  duplicates: number
  failed: Array<{ fileName: string; message: string }>
}

export function isUserPersonaAvatarResource(resource: Pick<Resource, 'metadata'>): boolean {
  return isUserPersonaAvatarAttachment(resource)
}

function dateStamp(date = new Date()): string {
  return date.toISOString().slice(0, 10).replaceAll('-', '')
}

export class UserPersonaService {
  private readonly resourceService: ResourceService

  constructor(resourceService: ResourceService) {
    this.resourceService = resourceService
  }

  async load(resourceId: string): Promise<{ resource: Resource; view: UserPersonaBackupView }> {
    const resource = await this.resourceService.get(resourceId)
    if (!resource || resource.type !== RESOURCE_TYPE.USER_PERSONA) {
      throw new Error('用户人设资源不存在或类型不正确')
    }
    let content: unknown
    try {
      content = JSON.parse(await resource.originalBlob.text())
    } catch {
      throw new Error('用户人设 JSON 已损坏')
    }
    return { resource, view: parseSillyTavernPersonaBackup(content) }
  }

  async create(
    draft: UserPersonaDraft,
    relatedResourceIds: string[] = [],
    coverResource?: Resource | null,
  ): Promise<Resource> {
    const backup = createEmptyPersonaBackup(draft)
    const file = new File(
      [serializeSillyTavernPersonaBackup(backup)],
      `personas_${dateStamp()}.json`,
      { type: 'application/json' },
    )
    const [result] = await this.resourceService.importFiles([file], { detectVersions: false })
    if (!result || result.status === 'failed' || result.status === 'versionCandidate') {
      throw new Error(result?.status === 'failed' ? result.message : '用户人设保存失败')
    }
    if (result.resource.type !== RESOURCE_TYPE.USER_PERSONA) {
      throw new Error('生成的人设文件没有通过 SillyTavern 格式校验')
    }
    let current = result.resource
    if (relatedResourceIds.length) {
      await this.resourceService.updateDetails(current, {
        name: current.name,
        description: current.description,
        type: RESOURCE_TYPE.USER_PERSONA,
        categoryIds: getResourceCategoryIds(current),
        relatedResourceIds,
        tags: current.tags,
        sourceLinks: current.sourceLinks,
      })
      current = (await this.resourceService.get(current.id)) ?? current
    }
    if (
      coverResource !== undefined &&
      (coverResource || current.thumbnailBlob || current.thumbnailAssetId)
    ) {
      current = await this.resourceService.updateThumbnail(
        current.id,
        coverResource?.thumbnailBlob ?? coverResource?.originalBlob,
      )
    }
    return current
  }

  async cacheAvatarFile(file: Blob, avatarId: string, sourceUrl = ''): Promise<Resource> {
    const normalizedId = normalizeUserPersonaAvatarId(avatarId)
    const prepared = await prepareUserPersonaAvatar(file, normalizedId)
    const normalizedSourceUrl = sourceUrl ? normalizeUserPersonaAvatarUrl(sourceUrl) : ''
    const parsed: ParsedResource = {
      type: RESOURCE_TYPE.OTHER,
      name: `用户头像 · ${normalizedId.replace(/\.png$/i, '')}`,
      description: normalizedSourceUrl
        ? '从 HTTPS 直链缓存的用户人设头像'
        : '从本地图片缓存的用户人设头像',
      tags: ['用户头像'],
      metadata: {
        assetKind: USER_PERSONA_AVATAR_ASSET_KIND,
        avatarId: normalizedId,
        format: 'png',
        ...(normalizedSourceUrl ? { sourceUrl: normalizedSourceUrl } : {}),
      },
    }
    const result = await this.resourceService.importPreparedFile(prepared, parsed, {
      allowContentDuplicate: true,
    })
    if (result.status !== 'imported') {
      throw new Error(result.status === 'failed' ? result.message : '头像附件保存失败')
    }
    return result.resource
  }

  async cacheAvatarFromUrl(url: string, avatarId: string): Promise<Resource> {
    const fetched = await fetchUserPersonaAvatar(url, avatarId)
    return this.cacheAvatarFile(fetched.file, avatarId, fetched.sourceUrl)
  }

  async loadAvatarResource(resourceId: string): Promise<Resource | undefined> {
    // Most related resources are large character cards or world books. Check the
    // attachment identity from metadata before requesting their original bytes.
    const summary = await this.resourceService.getSummary(resourceId)
    if (!summary || !isUserPersonaAvatarResource(summary)) return undefined
    const resource = await this.resourceService.get(resourceId)
    return resource && isUserPersonaAvatarResource(resource) ? resource : undefined
  }

  async importFiles(files: File[]): Promise<UserPersonaImportReport> {
    const validFiles: File[] = []
    const failed: UserPersonaImportReport['failed'] = []
    for (const file of files) {
      try {
        parseSillyTavernPersonaBackup(JSON.parse(await file.text()))
        validFiles.push(file)
      } catch (error) {
        failed.push({
          fileName: file.name,
          message: error instanceof Error ? error.message : '不是有效的酒馆用户人设 JSON',
        })
      }
    }

    const results = validFiles.length
      ? await this.resourceService.importFiles(validFiles, { detectVersions: false })
      : []
    let imported = 0
    let duplicates = 0
    for (const result of results) {
      if (result.status === 'imported') imported += 1
      else if (result.status === 'duplicate') duplicates += 1
      else if (result.status === 'failed') {
        failed.push({ fileName: result.fileName, message: result.message })
      }
    }
    return { imported, duplicates, failed }
  }

  async save(
    resourceId: string,
    backup: SillyTavernPersonaBackup,
    relatedResourceIds: string[],
    note = '用户人设编辑',
    coverResource?: Resource | null,
    preservePreviousVersion = false,
  ): Promise<Resource> {
    const before = await this.resourceService.get(resourceId)
    if (!before || before.type !== RESOURCE_TYPE.USER_PERSONA) {
      throw new Error('要保存的用户人设资源不存在')
    }
    const view = parseSillyTavernPersonaBackup(backup)
    const content = serializeSillyTavernPersonaBackup(backup)
    const file = new File([content], before.fileName, {
      type: 'application/json',
    })
    // Cover and relation edits do not change the native JSON and must not create a duplicate version.
    let current =
      serializeSillyTavernPersonaBackup(JSON.parse(await before.originalBlob.text())) === content
        ? before
        : await this.resourceService.importAsVersion(
            file,
            resourceId,
            true,
            note,
            undefined,
            {},
            false,
            preservePreviousVersion,
          )
    await this.resourceService.updateDetails(current, {
      name: view.entries.length === 1 ? view.entries[0]!.name : before.name,
      description: current.description,
      type: RESOURCE_TYPE.USER_PERSONA,
      categoryIds: getResourceCategoryIds(before),
      relatedResourceIds,
      tags: before.tags,
      sourceLinks: before.sourceLinks,
    })
    current = (await this.resourceService.get(resourceId)) ?? current
    if (coverResource !== undefined) {
      current = await this.resourceService.updateThumbnail(
        resourceId,
        coverResource?.thumbnailBlob ?? coverResource?.originalBlob,
      )
    }
    return current
  }
}
