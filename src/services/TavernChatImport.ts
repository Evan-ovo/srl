import { createImageThumbnail } from '../utils/createImageThumbnail'
import type { ResourceParserRegistry } from '../parser/ResourceParser'
import type { ImportOptions } from '../types/ResourceOperations'
import type { ImportResult, ParsedResource } from '../types/Import'
import {
  RESOURCE_TYPE,
  getRelatedResourceIds,
  toResourceListSummary,
  type Resource,
  type ResourceListSummary,
} from '../types/Resource'
import type { ResourceService } from './ResourceService'
import { readChatArchive } from './TavernChatArchiveCodec.mjs'
import { ChatReaderService } from './ChatReaderService'
import { hashBlob } from './HashService'
import { isRecord } from '../utils/UnknownValue'
import { chatCharacterThumbnailData, chatCharacterSummary } from './ChatReaderCharacter'
import { materializeNativeFile } from '../core/NativeFileSource'
import {
  extractTavernHelperScripts,
  type HelperScriptRecord,
} from '../utils/TavernHelperScriptParser'

function resourceOf(result: ImportResult): Resource {
  if (result.status === 'failed') throw new Error(result.message)
  if (result.status === 'versionCandidate') throw new Error('配套角色卡需要确认版本')
  return result.resource
}

/** Owned by one serial import batch; only the current card and lightweight summaries survive. */
export interface TavernChatImportBatch {
  summaries?: ResourceListSummary[]
  character?: {
    hash: string
    parsed: ParsedResource
    thumbnail?: Blob
    scripts?: Array<HelperScriptRecord & { type: 'script' }>
  }
}

/** Archive framing only; parsing, persistence and relationships use their existing owners. */
export async function importTavernChat(
  file: File,
  resources: ResourceService,
  parser: ResourceParserRegistry,
  options: ImportOptions = {},
  batch: TavernChatImportBatch = {},
): Promise<ImportResult> {
  file = await materializeNativeFile(file, { detachFromNativeSource: true, signal: options.signal })
  options.signal?.throwIfAborted()
  const {
    card,
    chat,
    avatar,
    displayRules,
    presetRules,
    regexContext,
    hasRegexSnapshot,
    carryReadingScripts,
  } = await readChatArchive(file)
  // Validate both before the first write. A filename or chat speaker never proves card identity.
  const cardHash = await hashBlob(card)
  const cachedCard = batch.character?.hash === cardHash ? batch.character : undefined
  const cardParsed = cachedCard?.parsed ?? (await parser.parse(card))
  const chatParsed = await parser.parse(chat)
  if (cardParsed.type !== RESOURCE_TYPE.CHARACTER_CARD || chatParsed.type !== RESOURCE_TYPE.CHAT)
    throw new Error('聊天传输包必须包含可识别的 PNG 角色卡和 JSONL 聊天原件')
  const chatHash = await hashBlob(chat)
  const summaries = (batch.summaries ??= await resources.listResourceListSummaries())
  batch.character = cachedCard ?? { hash: cardHash, parsed: cardParsed }
  const saveCharacter =
    options.saveChatCharacter === true ||
    options.saveChatCharacterHashes?.includes(cardHash) === true
  const chosenId = options.chatCharacterBindings?.[cardHash]
  const exact = summaries.find(
    (r) =>
      r.type === RESOURCE_TYPE.CHARACTER_CARD &&
      r.contentHash === cardHash &&
      (chosenId ? r.id === chosenId : saveCharacter),
  )
  if (chosenId && !exact) throw new Error('待关联角色卡已变更，请重新确认后导入')
  const parsedCard = isRecord(cardParsed.metadata.card) ? cardParsed.metadata.card : {}
  const body = isRecord(parsedCard.data) ? parsedCard.data : parsedCard
  const extensions = isRecord(body.extensions) ? body.extensions : {}
  if (carryReadingScripts && !batch.character.scripts) {
    const scripts = extractTavernHelperScripts(body, { source: 'character' }).map((script) => ({
      ...script,
      type: 'script' as const,
    }))
    if (scripts.length > 64) throw new Error('角色阅读脚本超过 64 个，请减少卡内脚本')
    if (new TextEncoder().encode(JSON.stringify(scripts)).length > 2 * 1024 * 1024)
      throw new Error('角色阅读脚本超过 2 MiB，请减少卡内脚本')
    batch.character.scripts = scripts
  }
  const characterScripts = carryReadingScripts ? (batch.character.scripts ?? []) : []
  let character = exact ? await resources.get(exact.id) : undefined
  const extractedResources: Resource[] = []
  if (!character && saveCharacter) {
    const cardResult = await resources.importPreparedFile(card, cardParsed, {
      allowContentDuplicate: true,
    })
    character = resourceOf(cardResult)
    if (cardResult.status === 'imported') extractedResources.push(character)
  }
  if (character && (await hashBlob(character.originalBlob)) !== cardHash)
    throw new Error('配套角色卡保存校验失败，聊天尚未绑定')
  const companion = {
    hash: cardHash,
    carryReadingScripts,
    name: cardParsed.name,
    avatar,
    card: {
      name: cardParsed.name,
      ...(characterScripts.length ? { scripts: characterScripts } : {}),
      extensions: {
        regex_scripts: Array.isArray(extensions.regex_scripts) ? extensions.regex_scripts : [],
      },
    },
    thumbnail: await chatCharacterThumbnailData(
      character?.thumbnailBlob ??
        (batch.character.thumbnail ??= await createImageThumbnail(card, {
          maxEdge: 480,
          quality: 0.75,
        })),
    ),
  }
  const characterIds = new Set(
    summaries.filter((r) => r.type === RESOURCE_TYPE.CHARACTER_CARD).map((r) => r.id),
  )
  const candidates = summaries.filter(
    (r) => r.type === RESOURCE_TYPE.CHAT && r.contentHash === chatHash,
  )
  const bound = candidates.find((r) => {
    const ids = getRelatedResourceIds(r).filter((id) => characterIds.has(id))
    return character
      ? ids.length === 1 && ids[0] === character.id
      : ids.length === 0 && chatCharacterSummary(r.metadata)?.hash === cardHash
  })
  const unbound = candidates.find(
    (r) =>
      !getRelatedResourceIds(r).some((id) => characterIds.has(id)) &&
      (!chatCharacterSummary(r.metadata) || chatCharacterSummary(r.metadata)?.hash === cardHash),
  )
  const existing = bound ?? unbound
  const original = existing ? await resources.get(existing.id) : undefined
  // Identical bytes belonging to a different character get a separate resource, never a rebind.
  const result: ImportResult = original
    ? {
        status: 'duplicate',
        fileName: file.name,
        resource: original,
        reclassified: false,
        message: '相同聊天已存在，已核对所属角色',
      }
    : await resources.importPreparedFile(
        chat,
        {
          ...chatParsed,
          description: `${chatParsed.metadata.messageCount} 楼 · ${cardParsed.name}`,
          metadata: {
            ...chatParsed.metadata,
            chatCharacter: companion,
            tavernChatSource: { avatar, chatName: chat.name, cardHash },
          },
        },
        { allowContentDuplicate: true },
      )
  const imported = resourceOf(result)
  const metadata: Resource['metadata'] = {
    chatCharacter: companion,
    tavernChatSource: { avatar, chatName: chat.name, cardHash },
  }
  if (!bound && character) await new ChatReaderService(resources).bind(imported.id, character.id)
  // Character code travels in the existing reading companion; no standalone script resource.
  // Reimports retire the legacy automatic reference, while keeping its original resource intact.
  metadata.chatReadingScriptId = null
  if (displayRules.length || presetRules.length) {
    const regexFile = new File(
      [
        JSON.stringify({
          sourceName: `${cardParsed.name} · 聊天显示正则`,
          ...(displayRules.length ? { global: displayRules } : {}),
          preset: presetRules,
        }),
      ],
      '聊天显示正则.json',
      { type: 'application/json' },
    )
    const parsedRegex = await parser.parse(regexFile)
    let regexResult = await resources.importPreparedFile(regexFile, parsedRegex)
    let regex = resourceOf(regexResult)
    if (!(await resources.get(regex.id))) {
      regexResult = await resources.importPreparedFile(regexFile, parsedRegex, {
        allowContentDuplicate: true,
      })
      regex = resourceOf(regexResult)
    }
    const savedRegex = await resources.get(regex.id)
    if (!savedRegex || (await hashBlob(savedRegex.originalBlob)) !== (await hashBlob(regexFile)))
      throw new Error('聊天显示正则保存校验失败，请保留酒馆原件后重试')
    if (regexResult.status === 'imported') extractedResources.push(regex)
    metadata.chatDisplayRegexId = regex.id
  } else if (hasRegexSnapshot) {
    metadata.chatDisplayRegexId = null
  }
  if (hasRegexSnapshot) metadata.chatRegexContext = regexContext
  await resources.updateMetadata(imported.id, metadata)
  const saved = await resources.get(imported.id)
  if (
    !saved ||
    (await hashBlob(saved.originalBlob)) !== chatHash ||
    (character
      ? !getRelatedResourceIds(saved).includes(character.id)
      : chatCharacterSummary(saved.metadata)?.hash !== cardHash)
  )
    throw new Error('聊天入库或角色关联校验失败，请保留酒馆原件并重试')
  if (result.status !== 'imported' && result.status !== 'duplicate') return result
  // Keep duplicate detection current without rescanning the library for every chat.
  for (const resource of [...extractedResources, ...(character ? [character] : []), saved]) {
    const summary = toResourceListSummary(resource)
    const index = summaries.findIndex((existing) => existing.id === resource.id)
    if (index < 0) summaries.push(summary)
    else summaries[index] = summary
  }
  return {
    ...result,
    fileName: file.name,
    resource: saved,
    extractedResources,
  }
}
