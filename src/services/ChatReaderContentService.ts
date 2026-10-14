import { chatCharacterThumbnail, resolveChatCharacter } from './ChatReaderCharacter'
import { ChatReaderService } from './ChatReaderService'
import type { chatReaderScripts } from './ChatReaderRendering'
import type { ResourceService } from './ResourceService'
import { RESOURCE_TYPE } from '../types/Resource'
import { isRecord } from '../utils/UnknownValue'
import { OPAQUE_PREVIEW_DOCUMENT_URL } from '../utils/OpaquePreviewDocument'
const textEncoder = new TextEncoder()
function normalizeResourceId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!id || id.length > 160) throw new Error('资源 ID 无效')
  return id
}

function normalizedInteger(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max)
    throw new Error('分页参数无效')
  return value
}

/** One content owner for native reading and the permission-checked third-party SDK. */
export class ChatReaderContentService {
  private readonly resources: ResourceService
  constructor(resources: ResourceService) {
    this.resources = resources
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

  readChat(payload: Record<string, unknown> & { snapshotsOnly: true }): Promise<{
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
  readChat(payload: unknown): ReturnType<ChatReaderContentService['readChatPage']>
  async readChat(payload: unknown) {
    const input = (payload ?? {}) as Record<string, unknown>
    if (input.snapshotsOnly !== true) return this.readChatPage(payload)
    const reader = new ChatReaderService(this.resources)
    const chat = await reader.getReadChat(normalizeResourceId(input.id))
    const page = await reader.readResource(
      chat,
      normalizedInteger(input.offset, 0, 10_000_000),
      normalizedInteger(input.limit, 20, 50),
    )
    const { archivedChatSnapshot, selectChatReply } = await import('./ChatReaderRendering')
    const overrides = isRecord(input.replyOverrides) ? input.replyOverrides : {}
    return {
      ...page,
      messages: page.messages.map((entry) => ({
        index: entry.index,
        snapshot: archivedChatSnapshot(
          selectChatReply(entry, overrides[String(entry.index)]),
          page.total,
        ),
      })),
      previewCapabilities: {
        archivedReaderWindow: true as const,
        archivedReaderHistory: true as const,
      },
    }
  }

  private async readChatPage(payload: unknown) {
    const input = (payload ?? {}) as Record<string, unknown>
    const scriptListOnly = input.scriptListOnly === true
    const textOnly = input.textOnly === true
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
      previewCapabilities: { archivedReaderWindow: true, archivedReaderHistory: true },
      previewDocumentUrl: OPAQUE_PREVIEW_DOCUMENT_URL,
      userNames: names,
      characterId: character!.id,
    }
  }

  async searchChat(payload: unknown) {
    const input = (payload ?? {}) as Record<string, unknown>
    if (typeof input.query !== 'string') throw new Error('请输入搜索词')
    return new ChatReaderService(this.resources).search(
      normalizeResourceId(input.id),
      input.query,
      normalizedInteger(input.offset, 0, 10_000_000),
    )
  }

  async chatChapters(payload: unknown) {
    const input = (payload ?? {}) as Record<string, unknown>
    return new ChatReaderService(this.resources).chapters(
      normalizeResourceId(input.id),
      normalizedInteger(input.offset, 0, 10_000_000),
    )
  }

  async chatVariables(payload: unknown) {
    const input = (payload ?? {}) as Record<string, unknown>
    return new ChatReaderService(this.resources).variableReview(
      normalizeResourceId(input.id),
      normalizedInteger(input.floor, 0, 10_000_000),
      isRecord(input.replyOverrides) ? input.replyOverrides : {},
    )
  }

  async readerStyle(payload: unknown) {
    const input = (payload ?? {}) as Record<string, unknown>
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

  async bindChat(payload: unknown): Promise<void> {
    const input = (payload ?? {}) as Record<string, unknown>
    await new ChatReaderService(this.resources).bind(
      normalizeResourceId(input.id),
      normalizeResourceId(input.characterId),
    )
  }

  async thumbnail(resourceId: unknown): Promise<Blob | null> {
    const id = normalizeResourceId(resourceId)
    const resource = this.resources.getSummary
      ? await this.resources.getSummary(id)
      : await this.resources.get(id)
    if (!resource) return null
    if (resource.type === RESOURCE_TYPE.CHAT)
      return chatCharacterThumbnail(resource.metadata) ?? null
    if (resource.type !== RESOURCE_TYPE.CHARACTER_CARD) return null
    // Only a bounded raster thumbnail is exposed, never the original PNG/card payload.
    const blob = this.resources.getThumbnail
      ? await this.resources.getThumbnail(id)
      : 'thumbnailBlob' in resource
        ? resource.thumbnailBlob
        : undefined
    return blob && blob.size <= 512 * 1024 && /^image\/(png|jpeg|webp)$/.test(blob.type)
      ? blob
      : null
  }
}
