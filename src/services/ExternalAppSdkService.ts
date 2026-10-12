import {
  chatCharacterSummary,
  chatCharacterThumbnail,
  resolveChatCharacter,
} from './ChatReaderCharacter'
import { isRecord } from '../utils/UnknownValue'
import { ChatReaderService } from './ChatReaderService'
import type { chatReaderScripts } from './ChatReaderRendering'
import { OPAQUE_PREVIEW_DOCUMENT_URL } from '../utils/OpaquePreviewDocument'
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
import {
  RESOURCE_TYPE,
  type Resource,
  type ResourceSummary,
  type ResourceType,
} from '../types/Resource'

const MAX_PAGE_SIZE = 50
const MAX_RESOURCE_DATA_BYTES = 512 * 1024
const textEncoder = new TextEncoder()

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

function cloneMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(metadata)
  if (json === undefined || textEncoder.encode(json).byteLength > MAX_RESOURCE_DATA_BYTES)
    throw new Error('该资源可供 APP 读取的数据过大')
  return JSON.parse(json) as Record<string, unknown>
}

function toSnapshot(
  resource: ResourceSummary | Resource,
  includeData = false,
): ExternalAppResourceSnapshot {
  return {
    apiVersion: 'srl-resource@1',
    id: resource.id,
    type: resource.type,
    name: resource.name,
    description: resource.description,
    tags: [...resource.tags],
    favorite: resource.favorite,
    categoryIds: Array.isArray(resource.categoryIds)
      ? [...resource.categoryIds]
      : resource.categoryId
        ? [resource.categoryId]
        : [],
    relatedResourceIds: Array.isArray(resource.relatedResourceIds)
      ? [...resource.relatedResourceIds]
      : [],
    revision: resource.updatedAt,
    format: typeof resource.metadata.format === 'string' ? resource.metadata.format : 'unknown',
    formatVersion:
      typeof resource.metadata.parserVersion === 'number' ? resource.metadata.parserVersion : 1,
    ...(resource.type === RESOURCE_TYPE.CHAT
      ? {
          messageCount: Number(resource.metadata.messageCount) || 0,
          chatCharacter: chatCharacterSummary(resource.metadata),
        }
      : {}),
    ...(includeData ? { data: cloneMetadata(resource.metadata) } : {}),
  }
}

export class ExternalAppSdkService {
  private readonly externalApps: ExternalAppService
  private readonly resources: ResourceService
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

  private async readChatScripts(
    card: Record<string, unknown>,
    metadata: Record<string, unknown>,
    input: Record<string, unknown>,
  ) {
    const ids = Array.isArray(input.scriptSources) ? [...new Set(input.scriptSources)] : []
    if (ids.length > 8) throw new Error('最多选择 8 份脚本来源')
    const sources = []
    for (const sourceId of ids) {
      const resource = await this.resources.getReadSource(normalizeResourceId(sourceId))
      if (!resource) throw new Error('所选脚本来源已不存在，请在脚本选择中移除')
      sources.push(resource)
    }
    const { chatReaderScripts } = await import('./ChatReaderRendering')
    return chatReaderScripts(
      isRecord(metadata.chatCharacter) && metadata.chatCharacter.carryReadingScripts === false
        ? {}
        : card,
      sources,
      isRecord(input.scriptOverrides) ? input.scriptOverrides : {},
    )
  }

  async readChat(appId: string, payload: unknown) {
    await this.requirePermission(appId, [
      EXTERNAL_APP_PERMISSION.RESOURCES_LIBRARY_READ,
      EXTERNAL_APP_PERMISSION.RESOURCES_CONTENT_READ,
    ])
    const input = (payload ?? {}) as Record<string, unknown>
    const scriptListOnly = input.scriptListOnly === true
    const textOnly = input.textOnly === true
    if (
      !scriptListOnly &&
      !textOnly &&
      input.interactive === true &&
      (await this.externalApps.getSummary(appId))?.runtimeMode !== 'trustedCompatible'
    )
      throw new Error('交互状态栏需要信任兼容模式')
    if (!scriptListOnly && !textOnly && input.remote === true) {
      await this.requirePermission(appId, EXTERNAL_APP_PERMISSION.NETWORK_HTTPS)
      if ((await this.externalApps.getSummary(appId))?.runtimeMode !== 'trustedCompatible')
        throw new Error('远程资源需要信任兼容模式')
    }
    const reader = new ChatReaderService(this.resources)
    const id = normalizeResourceId(input.id)
    const offset = normalizedInteger(input.offset, 0, 10_000_000)
    const limit = normalizedInteger(input.limit, 20, 50)
    const chat = await reader.getReadChat(id)
    const character = await resolveChatCharacter(chat, this.resources)
    const card = character.card
    const names = Array.isArray(chat.metadata.chatUserNames) ? chat.metadata.chatUserNames : []
    if (scriptListOnly) {
      const scripts = await this.readChatScripts(card, chat.metadata, input)
      return {
        messages: [],
        nextOffset: null,
        total: Number(chat.metadata.messageCount) || 0,
        contentHash: chat.contentHash,
        regexRules: [],
        regexSources: {},
        scriptRules: scripts.rules,
        scriptErrors: [] as string[],
        replyDiff: undefined,
        presetName: undefined,
        previewDocumentUrl: OPAQUE_PREVIEW_DOCUMENT_URL,
        userNames: names,
        characterId: character.id,
      }
    }
    const page = await reader.readResource(chat, offset, limit, {
      hideUser: input.hideUser === true,
      backward: input.backward === true,
    })
    const userName =
      typeof input.userName === 'string' && input.userName.trim()
        ? input.userName.trim().slice(0, 160)
        : names.length === 1 && typeof names[0] === 'string'
          ? names[0]
          : undefined
    const {
      chatRenderInput,
      transformChatInputs,
      formatChatResult,
      chatRegexProfileRules,
      chatRegexRules,
      archivedChatSnapshot,
      interactiveChatFrontend,
      interactiveChatWithScripts,
      chatReaderCss,
      selectChatReply,
    } = await import('./ChatReaderRendering')
    let extraRules: unknown[] = []
    let presetRules: unknown[] = []
    const sourceErrors: string[] = []
    if (typeof chat.metadata.chatDisplayRegexId === 'string') {
      const regex = await this.resources.getReadSource(chat.metadata.chatDisplayRegexId)
      if (regex?.type === RESOURCE_TYPE.REGEX && regex.originalSource.size <= 2 * 1024 * 1024) {
        const data: unknown = JSON.parse(await regex.originalSource.text())
        if (isRecord(data)) {
          if (Array.isArray(data.global)) extraRules = data.global
          if (Array.isArray(data.preset)) presetRules = data.preset
        }
      } else sourceErrors.push('随附显示正则不存在或超过 2 MiB，未加载；可在显示正则中替换来源')
    }
    const regexContext = isRecord(chat.metadata.chatRegexContext)
      ? chat.metadata.chatRegexContext
      : {}
    const ruleOverrides = isRecord(input.ruleOverrides)
      ? Object.fromEntries(
          Object.entries(input.ruleOverrides)
            .slice(0, 384)
            .filter((pair): pair is [string, boolean] => typeof pair[1] === 'boolean'),
        )
      : {}
    const renderOptions = {
      regex: input.regex !== false,
      userName,
      extraRules,
      presetRules,
      regexContext,
      ruleOverrides,
      characterRules: undefined as unknown[] | undefined,
    }
    const regexSources: Record<string, { id: string; name: string }> = {}
    if (isRecord(input.regexSources)) {
      for (const scope of ['global', 'preset', 'character'] as const) {
        if (!input.regexSources[scope]) continue
        const resource = await this.resources.getReadSource(
          normalizeResourceId(input.regexSources[scope]),
        )
        if (!resource) throw new Error('所选正则来源已不存在，请在显示正则中恢复随附来源')
        const expectedType =
          scope === 'preset'
            ? RESOURCE_TYPE.PRESET
            : scope === 'character'
              ? RESOURCE_TYPE.CHARACTER_CARD
              : RESOURCE_TYPE.REGEX
        if (resource.type !== expectedType && resource.type !== RESOURCE_TYPE.REGEX)
          throw new Error('所选资源类型不适用于这组正则')
        const { readChatRegexSource } = await import('./ChatReaderRendering')
        const rules = await readChatRegexSource(resource, scope)
        regexSources[scope] = { id: resource.id, name: resource.name }
        if (scope === 'global') renderOptions.extraRules = rules
        else if (scope === 'preset') {
          renderOptions.presetRules = rules
          renderOptions.regexContext = { ...renderOptions.regexContext, presetEnabled: true }
        } else {
          renderOptions.characterRules = rules
          renderOptions.regexContext = { ...renderOptions.regexContext, characterEnabled: true }
        }
      }
    }
    const preparedRules = chatRegexRules(card, renderOptions)
    const regexRules = await chatRegexProfileRules(
      card,
      renderOptions,
      isRecord(input.profileRuleOverrides) ? input.profileRuleOverrides : {},
      preparedRules,
    )
    renderOptions.ruleOverrides = Object.fromEntries(
      regexRules.map((rule) => [rule.key, rule.enabled]),
    )
    const preparedDisplayRules = preparedRules.map((item, index) => {
      const enabled = regexRules[index]!.enabled
      return { ...item, enabled, rule: { ...item.rule, enabled, disabled: !enabled } }
    })
    const replyOverrides = isRecord(input.replyOverrides) ? input.replyOverrides : {}
    let scriptRules: Awaited<ReturnType<typeof chatReaderScripts>>['rules'] = []
    let activeScripts: Awaited<ReturnType<typeof chatReaderScripts>>['active'] = []
    const scriptErrors: string[] = []
    if (input.scriptList === true || (!textOnly && input.scripts === true)) {
      try {
        const scripts = await this.readChatScripts(card, chat.metadata, input)
        scriptRules = scripts.rules
        if (!textOnly && input.scripts === true) activeScripts = scripts.active
      } catch (error) {
        if (input.scriptList === true) throw error
        scriptErrors.push(error instanceof Error ? error.message : '脚本来源无法加载')
      }
    }
    const readerCss =
      activeScripts.length && typeof input.readerCss === 'string'
        ? chatReaderCss(input.readerCss)
        : ''
    const selectedMessages = page.messages.map((entry) =>
      selectChatReply(entry, replyOverrides[String(entry.index)]),
    )
    const inputs = selectedMessages.map((entry) =>
      chatRenderInput(entry, card, renderOptions, preparedDisplayRules),
    )
    const results = await transformChatInputs(inputs)
    const panelTheme =
      input.panelAppearance === 'reader'
        ? input.theme === 'night'
          ? 'night'
          : input.theme === 'green'
            ? 'green'
            : 'paper'
        : undefined
    const messages = []
    const panelColor = document.createElement('span').style
    if (input.panelAppearance === 'reader' && typeof input.panelInk === 'string')
      panelColor.color = input.panelInk
    let responseBytes = 0
    let nextOffset = page.nextOffset
    for (const [index, entry] of selectedMessages.entries()) {
      const result = results[index]!
      const source = result.contents[0] ?? entry.message.mes
      const rendered = formatChatResult(
        source,
        input.remote === true,
        input.blendPanels !== false,
        panelTheme,
        textOnly,
      )
      const snapshot = archivedChatSnapshot(entry, page.total)
      const interactiveFrontends: string[] = []
      let interactiveDocument: string | undefined
      if (!textOnly && input.interactive === true && activeScripts.length)
        interactiveDocument = await interactiveChatWithScripts(
          source,
          rendered.formatted,
          activeScripts,
          snapshot,
          input.remote === true,
          input.theme === 'night' ? 'dark' : 'light',
          readerCss,
          panelColor.color ||
            (input.blendPanels === false
              ? undefined
              : input.theme === 'night'
                ? '#d0d3c6'
                : '#26382f'),
          panelTheme,
          {
            card,
            userName,
            regexes: {
              global: renderOptions.extraRules,
              preset: renderOptions.presetRules,
              character:
                renderOptions.characterRules ??
                (isRecord(card.data) &&
                isRecord(card.data.extensions) &&
                Array.isArray(card.data.extensions.regex_scripts)
                  ? card.data.extensions.regex_scripts
                  : isRecord(card.extensions) && Array.isArray(card.extensions.regex_scripts)
                    ? card.extensions.regex_scripts
                    : []),
            },
          },
        )
      else if (!textOnly && input.interactive === true)
        for (const frontend of rendered.formatted.frontendBlocks)
          interactiveFrontends.push(
            await interactiveChatFrontend(
              frontend,
              input.remote === true,
              snapshot,
              panelColor.color ||
                (input.blendPanels === false
                  ? undefined
                  : input.theme === 'night'
                    ? '#d0d3c6'
                    : '#26382f'),
              input.theme === 'night' ? 'dark' : 'light',
              panelTheme,
            ),
          )
      const renderedEntry = {
        ...entry,
        archivedSwipeId: Number(page.messages[index]!.message.swipe_id) || 0,
        displaySource: source,
        hiddenByRules:
          result.emptyCauses
            ?.filter((cause) => cause.contentIndex === 0)
            .map((cause) => ({ key: cause.id, name: cause.name })) || [],
        html: rendered.html,
        frontends: rendered.frontends,
        interactiveFrontends,
        interactiveDocument,
        scriptCount: activeScripts.length,
        scriptErrors,
        snapshot,
        frontendCount: rendered.frontendCount,
        errors: [...sourceErrors, ...(inputs[index]?.diagnostics || []), ...result.errors],
      }
      const bytes = textEncoder.encode(JSON.stringify(renderedEntry)).length
      if (messages.length && responseBytes + bytes > 8 * 1024 * 1024) {
        nextOffset = entry.index
        break
      }
      if (bytes > 8 * 1024 * 1024)
        throw new Error(`第 ${entry.index + 1} 楼渲染内容过大，请使用精简模式或关闭正则`)
      responseBytes += bytes
      messages.push(renderedEntry)
    }
    // Warm only the next adjacent floor's pure regex projection. No media/script documents are built.
    if (input.prefetch === true && page.nextOffset !== null) {
      void reader
        .readResource(chat, page.nextOffset, 1, { hideUser: input.hideUser === true })
        .then((neighbor) =>
          transformChatInputs(
            neighbor.messages.map((entry) =>
              chatRenderInput(
                selectChatReply(entry, replyOverrides[String(entry.index)]),
                card,
                renderOptions,
                preparedDisplayRules,
              ),
            ),
          ),
        )
        .catch(() => undefined) // Speculative work; entering that floor reports errors through normal readChat.
    }
    let replyDiff
    if (Array.isArray(input.compareReplies)) {
      if (input.compareReplies.length !== 2 || !page.messages[0])
        throw new Error('请选择两条回复比较')
      const variants = input.compareReplies.map((value) =>
        selectChatReply(page.messages[0]!, value),
      )
      const projections = await transformChatInputs(
        variants.map((entry) => chatRenderInput(entry, card, renderOptions, preparedDisplayRules)),
      )
      const text = projections.map((result) => {
        const rendered = formatChatResult(result.contents[0] || '', false)
        const template = document.createElement('template')
        template.innerHTML = rendered.html
        template.content
          .querySelectorAll('[data-chat-frontend],script,style')
          .forEach((el) => el.remove())
        template.content
          .querySelectorAll('p,br,div,li')
          .forEach((el) => el.append(document.createTextNode('\n')))
        return (template.content.textContent || '').trim().slice(0, 30000)
      })
      const { diffLines } = await import('../utils/ResourceDiff')
      replyDiff = {
        lines: diffLines(text[0]!, text[1]!),
        errors: projections.flatMap((result) => result.errors),
        limit: 30000,
      }
    }
    return {
      ...page,
      nextOffset,
      messages,
      regexRules,
      regexSources,
      scriptRules,
      scriptErrors,
      replyDiff,
      presetName: regexContext.presetName,
      previewDocumentUrl: OPAQUE_PREVIEW_DOCUMENT_URL,
      userNames: names,
      characterId: character!.id,
    }
  }

  async searchChat(appId: string, payload: unknown) {
    await this.requirePermission(appId, EXTERNAL_APP_PERMISSION.RESOURCES_LIBRARY_READ)
    await this.requirePermission(appId, EXTERNAL_APP_PERMISSION.RESOURCES_CONTENT_READ)
    const input = (payload ?? {}) as Record<string, unknown>
    if (typeof input.query !== 'string') throw new Error('请输入搜索词')
    return new ChatReaderService(this.resources).search(
      normalizeResourceId(input.id),
      input.query,
      normalizedInteger(input.offset, 0, 10_000_000),
    )
  }

  async chatChapters(appId: string, payload: unknown) {
    await this.requirePermission(appId, EXTERNAL_APP_PERMISSION.RESOURCES_LIBRARY_READ)
    await this.requirePermission(appId, EXTERNAL_APP_PERMISSION.RESOURCES_CONTENT_READ)
    const input = (payload ?? {}) as Record<string, unknown>
    return new ChatReaderService(this.resources).chapters(
      normalizeResourceId(input.id),
      normalizedInteger(input.offset, 0, 10_000_000),
    )
  }

  async chatVariables(appId: string, payload: unknown) {
    await this.requirePermission(appId, EXTERNAL_APP_PERMISSION.RESOURCES_LIBRARY_READ)
    await this.requirePermission(appId, EXTERNAL_APP_PERMISSION.RESOURCES_CONTENT_READ)
    const input = (payload ?? {}) as Record<string, unknown>
    return new ChatReaderService(this.resources).variableReview(
      normalizeResourceId(input.id),
      normalizedInteger(input.floor, 0, 10_000_000),
      isRecord(input.replyOverrides) ? input.replyOverrides : {},
    )
  }

  async readerStyle(appId: string, payload: unknown) {
    await this.requirePermission(appId, EXTERNAL_APP_PERMISSION.RESOURCES_LIBRARY_READ)
    await this.requirePermission(appId, EXTERNAL_APP_PERMISSION.RESOURCES_CONTENT_READ)
    const input = (payload ?? {}) as Record<string, unknown>
    if (
      input.fonts === true &&
      input.remote === true &&
      (await this.externalApps.getSummary(appId))?.runtimeMode !== 'trustedCompatible'
    )
      throw new Error('请先使用兼容模式，再加载外部字体')
    const resource = await this.resources.getReadSource(normalizeResourceId(input.id))
    if (!resource || resource.type !== RESOURCE_TYPE.BEAUTIFICATION)
      throw new Error('请选择资源库中的美化')
    if (resource.originalSource.size > 256 * 1024)
      throw new Error('美化文件超过 256 KiB，请先提取聊天区域的 CSS')
    const source = await resource.originalSource.text()
    let css = source
    let theme: Record<string, unknown> = {}
    if (resource.metadata.format !== 'css' && resource.metadata.format !== 'text') {
      const parsed: unknown = JSON.parse(source)
      if (
        !isRecord(parsed) ||
        (parsed.custom_css !== undefined && typeof parsed.custom_css !== 'string')
      )
        throw new Error('美化不含可用的聊天 CSS')
      theme = parsed
      css = typeof parsed.custom_css === 'string' ? parsed.custom_css : ''
    }
    const { chatReaderCss, chatReaderFonts } = await import('./ChatReaderRendering')
    return {
      name: resource.name,
      css: chatReaderCss(css, theme),
      fonts: input.fonts === true ? await chatReaderFonts(css, input.remote === true) : undefined,
    }
  }

  async bindChat(appId: string, payload: unknown): Promise<void> {
    await this.requirePermission(appId, EXTERNAL_APP_PERMISSION.RESOURCES_LIBRARY_READ)
    await this.requirePermission(appId, EXTERNAL_APP_PERMISSION.RESOURCES_WRITE)
    const input = (payload ?? {}) as Record<string, unknown>
    await new ChatReaderService(this.resources).bind(
      normalizeResourceId(input.id),
      normalizeResourceId(input.characterId),
    )
  }

  async thumbnail(appId: string, resourceId: unknown): Promise<Blob | null> {
    await this.requirePermission(appId, EXTERNAL_APP_PERMISSION.RESOURCES_LIBRARY_READ)
    await this.requirePermission(appId, EXTERNAL_APP_PERMISSION.RESOURCES_CONTENT_READ)
    const resource = await this.resources.get(normalizeResourceId(resourceId))
    if (!resource) return null
    if (resource.type === RESOURCE_TYPE.CHAT)
      return chatCharacterThumbnail(resource.metadata) ?? null
    if (resource.type !== RESOURCE_TYPE.CHARACTER_CARD) return null
    // Only a bounded raster thumbnail is exposed, never the original PNG/card payload.
    const blob = resource.thumbnailBlob
    return blob && blob.size <= 512 * 1024 && /^image\/(png|jpeg|webp)$/.test(blob.type)
      ? blob
      : null
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
