import { toSnapshot } from './ResourceSnapshot'
import { ChatReaderContentService } from './ChatReaderContentService'
import type { ResourceService } from './ResourceService'
import type { ExternalAppResourceUpdate } from './ResourceService'
import type { ExternalAppService } from './ExternalAppService'
import {
  EXTERNAL_APP_PERMISSION,
  EXTERNAL_APP_SDK_VERSION,
  getExternalAppPermissionLevel,
  getGrantedExternalAppPermissions,
  type ExternalAppPermission,
} from '../types/ExternalApp'
import { RESOURCE_TYPE, type ResourceType } from '../types/Resource'

const MAX_PAGE_SIZE = 50

export interface ExternalAppResourceSnapshot {
  apiVersion: 'srl-resource@1'
  id: string
  type: ResourceType
  name: string
  description: string
  tags: string[]
  favorite: boolean
  categoryIds: string[]
  relatedResourceIds: string[]
  revision: number
  format: string
  formatVersion: number
  chatCharacter?: { id: string; name: string; hash: string }
  messageCount?: number
  data?: Record<string, unknown>
}

export interface ExternalAppResourceListResult {
  items: ExternalAppResourceSnapshot[]
  total: number
  nextOffset: number | null
  cursor?: string
}

export interface ExternalAppResourceUpdateRequest {
  id: string
  name?: string
  description?: string
  tags?: string[]
  favorite?: boolean
  categoryIds?: string[]
}

export interface ExternalAppResourceUpdatePreview {
  resource: ExternalAppResourceSnapshot
  changes: Array<{ field: string; before: unknown; after: unknown }>
}

function normalizeResourceId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!id || id.length > 160) throw new Error('资源 ID 无效')
  return id
}

function normalizeTypes(value: unknown): ResourceType[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error('资源类型筛选必须是数组')
  const supported = new Set<ResourceType>(Object.values(RESOURCE_TYPE))
  const types = Array.from(
    new Set(value.filter((item): item is ResourceType => typeof item === 'string')),
  )
  if (types.some((type) => !supported.has(type))) throw new Error('资源类型筛选包含不支持的类型')
  return types
}

function normalizedInteger(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max)
    throw new Error('分页参数无效')
  return value
}

function normalizeOptionalText(
  value: unknown,
  field: '名称' | '说明',
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`资源${field}必须是文本`)
  if (value.length > maxLength) throw new Error(`资源${field}不能超过 ${maxLength} 个字符`)
  return value
}

function normalizeOptionalStrings(
  value: unknown,
  field: string,
  maxItems: number,
): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw new Error(`资源${field}必须是文本数组`)
  if (value.length > maxItems) throw new Error(`资源${field}不能超过 ${maxItems} 项`)
  return value
}

function normalizeUpdateRequest(payload: unknown): ExternalAppResourceUpdateRequest {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new Error('资源更新参数无效')
  const input = payload as Record<string, unknown>
  const request: ExternalAppResourceUpdateRequest = { id: normalizeResourceId(input.id) }
  const name = normalizeOptionalText(input.name, '名称', 160)
  const description = normalizeOptionalText(input.description, '说明', 20_000)
  const tags = normalizeOptionalStrings(input.tags, '标签', 100)
  const categoryIds = normalizeOptionalStrings(input.categoryIds, '分类', 100)
  if (name !== undefined) request.name = name
  if (description !== undefined) request.description = description
  if (tags !== undefined) request.tags = tags
  if (categoryIds !== undefined) request.categoryIds = categoryIds
  if (input.favorite !== undefined) {
    if (typeof input.favorite !== 'boolean') throw new Error('收藏状态必须是 true 或 false')
    request.favorite = input.favorite
  }
  if (
    request.name === undefined &&
    request.description === undefined &&
    request.tags === undefined &&
    request.favorite === undefined &&
    request.categoryIds === undefined
  ) {
    throw new Error('请至少提供一项要更新的资源字段')
  }
  return request
}

export class ExternalAppSdkService {
  private readonly externalApps: ExternalAppService
  private readonly resources: ResourceService
  private readonly readerContent: ChatReaderContentService
  // One directory operation per runtime session; released after the final page or close.
  private readonly listSessions = new Map<
    string,
    {
      appId: string
      scope: string
      cursor: string
      items: ExternalAppResourceSnapshot[]
      nextOffset: number
      bytes: number
    }
  >()

  releaseListSession(session: string): void {
    this.listSessions.delete(session)
  }

  constructor(externalApps: ExternalAppService, resources: ResourceService) {
    this.externalApps = externalApps
    this.resources = resources
    this.readerContent = new ChatReaderContentService(resources)
  }

  async capabilities(
    appId: string,
    scope?: readonly ExternalAppPermission[],
  ): Promise<{
    apiVersion: typeof EXTERNAL_APP_SDK_VERSION
    permissions: ExternalAppPermission[]
    permissionLevel: string
  }> {
    const app = await this.externalApps.getSummary(appId)
    if (!app?.enabled) throw new Error('APP 已被禁用')
    const permissions = getGrantedExternalAppPermissions(app).filter(
      (permission) => !scope || scope.includes(permission),
    )
    return {
      apiVersion: EXTERNAL_APP_SDK_VERSION,
      permissions,
      permissionLevel: getExternalAppPermissionLevel(permissions),
    }
  }

  async list(
    appId: string,
    payload: unknown,
    session = appId,
  ): Promise<ExternalAppResourceListResult> {
    await this.requirePermission(appId, EXTERNAL_APP_PERMISSION.RESOURCES_LIBRARY_READ)
    const options =
      payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
    const types = normalizeTypes(options.types)
    const ids = normalizeOptionalStrings(options.ids, 'ID 列表', MAX_PAGE_SIZE)?.map(
      normalizeResourceId,
    )
    const selectedIds = ids ? new Set(ids) : undefined
    const offset = normalizedInteger(options.offset, 0, 100_000)
    const limit = normalizedInteger(options.limit, 25, MAX_PAGE_SIZE)
    const scope = JSON.stringify([types, ids])
    if (options.cursor !== undefined) {
      const snapshot = this.listSessions.get(session)
      if (
        !snapshot ||
        snapshot.appId !== appId ||
        snapshot.scope !== scope ||
        snapshot.cursor !== options.cursor ||
        snapshot.nextOffset !== offset
      )
        throw new Error('资源目录分页已结束或范围已变化，请重新读取')
      const items = snapshot.items.slice(offset, offset + limit)
      const nextOffset =
        offset + items.length < snapshot.items.length ? offset + items.length : null
      if (nextOffset === null) this.listSessions.delete(session)
      else snapshot.nextOffset = nextOffset
      return {
        items,
        total: snapshot.items.length,
        nextOffset,
        ...(nextOffset !== null ? { cursor: snapshot.cursor } : {}),
      }
    }
    this.listSessions.delete(session)
    const matches = (await this.resources.listResourceListSummaries({ types, ids })).filter(
      (resource) =>
        (!types || types.includes(resource.type)) && (!selectedIds || selectedIds.has(resource.id)),
    )
    const items = matches.slice(offset, offset + limit).map((resource) => toSnapshot(resource))
    const nextOffset = offset + items.length < matches.length ? offset + items.length : null
    let cursor: string | undefined
    if (options.snapshot === true && nextOffset !== null && matches.length <= 10_000) {
      const snapshots: ExternalAppResourceSnapshot[] = []
      let bytes = 0
      // Account for UTF-16 strings and per-item overhead without serializing one giant array.
      for (const resource of matches) {
        const snapshot = toSnapshot(resource)
        bytes += JSON.stringify(snapshot).length * 2 + 256
        if (bytes > 8 * 1024 * 1024) break
        snapshots.push(snapshot)
      }
      if (snapshots.length === matches.length) {
        cursor = crypto.randomUUID()
        while (
          this.listSessions.size >= 4 ||
          [...this.listSessions.values()].reduce((total, item) => total + item.bytes, bytes) >
            8 * 1024 * 1024
        )
          this.listSessions.delete(this.listSessions.keys().next().value!)
        this.listSessions.set(session, {
          appId,
          scope,
          cursor,
          items: snapshots,
          nextOffset,
          bytes,
        })
      }
    }
    return {
      items,
      total: matches.length,
      nextOffset,
      ...(cursor ? { cursor } : {}),
    }
  }

  async get(appId: string, resourceId: unknown): Promise<ExternalAppResourceSnapshot> {
    await this.requirePermission(appId, EXTERNAL_APP_PERMISSION.RESOURCES_LIBRARY_READ)
    await this.requirePermission(appId, EXTERNAL_APP_PERMISSION.RESOURCES_CONTENT_READ)
    const resource = await this.resources.get(normalizeResourceId(resourceId))
    if (!resource) throw new Error('资源不存在或已被删除')
    return toSnapshot(resource, true)
  }

  readChat(
    appId: string,
    payload: Record<string, unknown> & { snapshotsOnly: true },
  ): Promise<{
    messages: Array<{
      index: number
      snapshot: import('../utils/RenderCompatibilityRuntime').ArchivedMessageSnapshot
    }>
    nextOffset: number | null
    previousOffset?: number | null
    total: number
    contentHash: string
    previewCapabilities: { archivedReaderWindow: true; archivedReaderHistory: true }
  }>
  readChat(appId: string, payload: unknown): ReturnType<ChatReaderContentService['readChat']>

  async readChat(appId: string, payload: unknown) {
    await this.requirePermission(appId, [
      EXTERNAL_APP_PERMISSION.RESOURCES_LIBRARY_READ,
      EXTERNAL_APP_PERMISSION.RESOURCES_CONTENT_READ,
    ])
    const input = (payload ?? {}) as Record<string, unknown>
    if (input.snapshotsOnly !== true && input.textOnly !== true && input.scriptListOnly !== true) {
      if (
        (input.interactive === true || input.remote === true) &&
        (await this.externalApps.getSummary(appId))?.runtimeMode !== 'trustedCompatible'
      )
        throw new Error(
          input.interactive === true ? '交互状态栏需要信任兼容模式' : '远程资源需要信任兼容模式',
        )
      if (input.remote === true)
        await this.requirePermission(appId, EXTERNAL_APP_PERMISSION.NETWORK_HTTPS)
    }
    if (input.snapshotsOnly === true)
      return this.readerContent.readChat(input as Record<string, unknown> & { snapshotsOnly: true })
    return this.readerContent.readChat(payload)
  }
  async searchChat(appId: string, payload: unknown) {
    await this.requirePermission(appId, [
      EXTERNAL_APP_PERMISSION.RESOURCES_LIBRARY_READ,
      EXTERNAL_APP_PERMISSION.RESOURCES_CONTENT_READ,
    ])
    return this.readerContent.searchChat(payload)
  }
  async chatChapters(appId: string, payload: unknown) {
    await this.requirePermission(appId, [
      EXTERNAL_APP_PERMISSION.RESOURCES_LIBRARY_READ,
      EXTERNAL_APP_PERMISSION.RESOURCES_CONTENT_READ,
    ])
    return this.readerContent.chatChapters(payload)
  }
  async chatVariables(appId: string, payload: unknown) {
    await this.requirePermission(appId, [
      EXTERNAL_APP_PERMISSION.RESOURCES_LIBRARY_READ,
      EXTERNAL_APP_PERMISSION.RESOURCES_CONTENT_READ,
    ])
    return this.readerContent.chatVariables(payload)
  }
  async readerStyle(appId: string, payload: unknown) {
    await this.requirePermission(appId, [
      EXTERNAL_APP_PERMISSION.RESOURCES_LIBRARY_READ,
      EXTERNAL_APP_PERMISSION.RESOURCES_CONTENT_READ,
    ])
    const input = (payload ?? {}) as Record<string, unknown>
    if (
      input.fonts === true &&
      input.remote === true &&
      (await this.externalApps.getSummary(appId))?.runtimeMode !== 'trustedCompatible'
    )
      throw new Error('请先使用兼容模式，再加载外部字体')
    return this.readerContent.readerStyle(payload)
  }
  async bindChat(appId: string, payload: unknown) {
    await this.requirePermission(appId, [
      EXTERNAL_APP_PERMISSION.RESOURCES_LIBRARY_READ,
      EXTERNAL_APP_PERMISSION.RESOURCES_WRITE,
    ])
    return this.readerContent.bindChat(payload)
  }
  async thumbnail(appId: string, resourceId: unknown) {
    await this.requirePermission(appId, [
      EXTERNAL_APP_PERMISSION.RESOURCES_LIBRARY_READ,
      EXTERNAL_APP_PERMISSION.RESOURCES_CONTENT_READ,
    ])
    return this.readerContent.thumbnail(resourceId)
  }
  async listPickable(appId: string, payload: unknown): Promise<ExternalAppResourceSnapshot[]> {
    await this.requirePermission(appId, EXTERNAL_APP_PERMISSION.RESOURCES_SELECTED_READ)
    const options =
      payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
    const types = normalizeTypes(options.types)
    return (await this.resources.listSummaries())
      .filter((resource) => !types || types.includes(resource.type))
      .map((resource) => toSnapshot(resource))
  }

  async getPicked(
    appId: string,
    resourceId: unknown,
    allowContent = true,
  ): Promise<ExternalAppResourceSnapshot> {
    await this.requirePermission(appId, EXTERNAL_APP_PERMISSION.RESOURCES_SELECTED_READ)
    const resource = await this.resources.get(normalizeResourceId(resourceId))
    if (!resource) throw new Error('资源不存在或已被删除')
    const includeData =
      allowContent &&
      (await this.externalApps.hasPermission(appId, EXTERNAL_APP_PERMISSION.RESOURCES_CONTENT_READ))
    return toSnapshot(resource, includeData)
  }

  async update(appId: string, payload: unknown): Promise<ExternalAppResourceSnapshot> {
    await this.requirePermission(appId, EXTERNAL_APP_PERMISSION.RESOURCES_WRITE)
    const request = normalizeUpdateRequest(payload)
    const update: ExternalAppResourceUpdate = {
      resourceId: request.id,
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.description === undefined ? {} : { description: request.description }),
      ...(request.tags === undefined ? {} : { tags: request.tags }),
      ...(request.favorite === undefined ? {} : { favorite: request.favorite }),
      ...(request.categoryIds === undefined ? {} : { categoryIds: request.categoryIds }),
    }
    return toSnapshot(await this.resources.updateExternalAppResource(update))
  }

  async describeUpdate(appId: string, payload: unknown): Promise<ExternalAppResourceUpdatePreview> {
    await this.requirePermission(appId, EXTERNAL_APP_PERMISSION.RESOURCES_WRITE)
    const request = normalizeUpdateRequest(payload)
    const resource = await this.resources.get(request.id)
    if (!resource) throw new Error('资源不存在或已被删除')
    const current = toSnapshot(resource)
    const fields: Array<keyof Omit<ExternalAppResourceUpdateRequest, 'id'>> = [
      'name',
      'description',
      'tags',
      'favorite',
      'categoryIds',
    ]
    const changes = fields.flatMap((field) => {
      const after = request[field]
      if (after === undefined) return []
      const before = current[field]
      return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ field, before, after }]
    })
    return { resource: current, changes }
  }

  private async requirePermission(
    appId: string,
    permission: ExternalAppPermission | ExternalAppPermission[],
  ): Promise<void> {
    if (!(await this.externalApps.hasPermission(appId, permission)))
      throw new Error('该 APP 未获得此资源库权限')
  }
}
