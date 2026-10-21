import { jsonChatRecords, summarizeChat } from './ChatResourceParser'
import type { ParsedResource } from '../types/Import'
import { parseGreetingResource } from '../types/GreetingResource'
import { RESOURCE_TYPE, type ResourceType } from '../types/Resource'
import { isRecord } from '../utils/UnknownValue'
import type { ResourceParser } from './ResourceParser'
import {
  isSillyTavernPersonaBackup,
  parseSillyTavernPersonaBackup,
} from './SillyTavernPersonaBackup'

export const JSON_RESOURCE_PARSER_VERSION = 10

interface Detection {
  type: ResourceType
  variant: string
  name?: string
  description?: string
  itemCount?: number
  tags?: string[]
  metadata?: Record<string, unknown>
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === 'string')
        .flatMap((item) => item.split(/[,，\n]/))
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  )
}

function getCharacterData(record: Record<string, unknown>): Record<string, unknown> {
  return isRecord(record.data) ? record.data : record
}

function isCharacterCard(record: Record<string, unknown>): boolean {
  const spec = readString(record.spec).toLocaleLowerCase()
  const data = getCharacterData(record)
  const isVersionedCard = /^chara_card_v[23]$/.test(spec) && isRecord(record.data)
  const legacyFields = [
    'name',
    'description',
    'personality',
    'scenario',
    'first_mes',
    'mes_example',
  ]
  const isLegacyCard = legacyFields.every((key) => typeof data[key] === 'string')
  return Boolean(readString(data.name)) && (isVersionedCard || isLegacyCard)
}

function isTavernHelperScript(record: Record<string, unknown>): boolean {
  const content = readString(record.content)
  const button = isRecord(record.button) ? record.button : undefined
  const hasTypedShape =
    record.type === 'script' &&
    typeof record.id === 'string' &&
    typeof record.name === 'string' &&
    typeof record.content === 'string' &&
    (button == null || Array.isArray(button.buttons))
  if (hasTypedShape) return true

  const hasPackageShape =
    typeof record.id === 'string' &&
    typeof record.name === 'string' &&
    (typeof record.info === 'string' || Array.isArray(record.buttons))
  const looksExecutable =
    /(?:^|[\s;])(?:async\s+)?function\b|(?:^|[\s;])(?:const|let|var)\s+[\w$]+|=>|['"]use strict['"]/.test(
      content,
    )
  return Boolean(content && hasPackageShape && looksExecutable)
}

function isTavernHelperFolder(
  record: Record<string, unknown>,
): record is Record<string, unknown> & { scripts: Record<string, unknown>[] } {
  return (
    record.type === 'folder' &&
    typeof record.name === 'string' &&
    Array.isArray(record.scripts) &&
    record.scripts.every((item) => isRecord(item) && isTavernHelperScript(item))
  )
}

function isTavernHelperTree(value: unknown): boolean {
  return isRecord(value) && (isTavernHelperScript(value) || isTavernHelperFolder(value))
}

function countTavernHelperScripts(values: unknown[]): number {
  return values.reduce<number>((count, value) => {
    if (!isRecord(value)) return count
    if (isTavernHelperScript(value)) return count + 1
    if (isTavernHelperFolder(value)) return count + value.scripts.length
    return count
  }, 0)
}

function isRegexScript(value: unknown): boolean {
  return (
    isRecord(value) &&
    ((typeof value.scriptName === 'string' &&
      typeof value.findRegex === 'string' &&
      typeof value.replaceString === 'string') ||
      (typeof value.script_name === 'string' &&
        typeof value.find_regex === 'string' &&
        typeof value.replace_string === 'string'))
  )
}

function isRegexPreset(value: Record<string, unknown>): boolean {
  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    ['global', 'scoped', 'preset'].every((key) => Array.isArray(value[key]))
  )
}

function readRegexScope(
  record: Record<string, unknown>,
): 'global' | 'character' | 'preset' | undefined {
  if (Array.isArray(record.global)) return 'global'
  if (Array.isArray(record.scoped)) return 'character'
  if (Array.isArray(record.preset)) return 'preset'
  return undefined
}

function countEntries(value: unknown): number {
  if (Array.isArray(value)) return value.length
  return isRecord(value) ? Object.keys(value).length : 0
}

function detectArray(content: unknown[], fallbackName: string): Detection {
  if (content.length > 0 && content.every(isRegexScript)) {
    return {
      type: RESOURCE_TYPE.REGEX,
      variant: 'regexCollection',
      name: fallbackName,
      description: `包含 ${content.length} 条正则脚本`,
      itemCount: content.length,
    }
  }

  if (content.length > 0 && content.every(isTavernHelperTree)) {
    const itemCount = countTavernHelperScripts(content)
    return {
      type: RESOURCE_TYPE.SCRIPT,
      variant: 'tavernHelperScriptTree',
      name: fallbackName,
      description: `酒馆助手脚本库，包含 ${itemCount} 个脚本`,
      itemCount,
    }
  }

  return {
    type: RESOURCE_TYPE.OTHER,
    variant: 'jsonArray',
    name: fallbackName,
    description: `未识别的 JSON 数组，共 ${content.length} 项`,
    itemCount: content.length,
  }
}

function detectRecord(record: Record<string, unknown>, fallbackName: string): Detection {
  const scriptLanguage = readString(record.language ?? record.type).toLocaleLowerCase()
  if (isSillyTavernPersonaBackup(record)) {
    const personaBackup = parseSillyTavernPersonaBackup(record)
    const names = personaBackup.entries.map((entry) => entry.name).filter(Boolean)
    const nativeCharacterIds = Array.from(
      new Set(
        personaBackup.entries.flatMap((entry) =>
          entry.connections
            .filter((connection) => connection.type === 'character')
            .map((connection) => connection.id),
        ),
      ),
    )
    const profileCharacterIds = Array.from(
      new Set(personaBackup.entries.flatMap((entry) => Object.keys(entry.profile.variants))),
    )
    const characterNames = (ids: string[]) =>
      ids.map(
        (id) =>
          personaBackup.entries.find((entry) => entry.characterBindings[id])?.characterBindings[id]
            ?.name ?? id,
      )
    return {
      type: RESOURCE_TYPE.USER_PERSONA,
      variant: 'sillyTavernPersonaBackup',
      name: names.length === 1 ? names[0] : fallbackName,
      description: `SillyTavern 用户人设备份，包含 ${personaBackup.entries.length} 个人设`,
      itemCount: personaBackup.entries.length,
      metadata: {
        personaNames: names.slice(0, 50),
        personaNativeCharacterNames: characterNames(nativeCharacterIds).slice(0, 50),
        personaProfileCharacterNames: characterNames(profileCharacterIds).slice(0, 50),
        personaCharacterNames: Array.from(
          new Set([...characterNames(nativeCharacterIds), ...characterNames(profileCharacterIds)]),
        ).slice(0, 50),
        defaultPersonaAvatarId: personaBackup.defaultPersona,
        warningCount: personaBackup.warnings.length,
      },
    }
  }
  if (
    typeof record.display_name === 'string' &&
    typeof record.loading_order === 'number' &&
    typeof record.js === 'string'
  ) {
    const details = [readString(record.author), readString(record.version)]
      .filter(Boolean)
      .join(' · ')
    return {
      type: RESOURCE_TYPE.PLUGIN,
      variant: 'extensionManifest',
      name: readString(record.display_name) || fallbackName,
      description: details || 'SillyTavern 扩展清单',
    }
  }

  if (isCharacterCard(record)) {
    const data = getCharacterData(record)
    return {
      type: RESOURCE_TYPE.CHARACTER_CARD,
      variant: isRecord(record.data) ? 'characterCardJson' : 'characterCardJsonLegacy',
      name: readString(data.name) || fallbackName,
      description: readString(data.description),
      tags: readStringArray(data.tags),
      metadata: {
        characterCardSpec: readString(record.spec) || 'tavern_card_v1',
        characterCardSpecVersion: readString(record.spec_version) || '1.0',
        creator: readString(data.creator),
        characterVersion: readString(data.character_version),
        card: record,
      },
    }
  }

  if (typeof record.name === 'string' && Array.isArray(record.qrList)) {
    return {
      type: RESOURCE_TYPE.QUICK_REPLY,
      variant: 'quickReplySet',
      name: readString(record.name) || fallbackName,
      description: `包含 ${record.qrList.length} 条快速回复`,
      itemCount: record.qrList.length,
    }
  }

  if (isRegexScript(record)) {
    return {
      type: RESOURCE_TYPE.REGEX,
      variant: typeof record.find_regex === 'string' ? 'tavernHelperRegex' : 'regexScript',
      name: readString(record.scriptName ?? record.script_name) || fallbackName,
      description: 'SillyTavern 查找与替换正则脚本',
      itemCount: 1,
    }
  }

  if (isRegexPreset(record)) {
    const scope = readRegexScope(record)
    return {
      type: RESOURCE_TYPE.REGEX,
      variant: 'regexPreset',
      name: readString(record.name) || fallbackName,
      description: 'SillyTavern 正则启用方案',
      metadata: {
        regexScope: scope,
        sourceName: readString(record.sourceName),
      },
    }
  }

  const regexScope = readRegexScope(record)
  if (regexScope) {
    const scripts = record[regexScope === 'character' ? 'scoped' : regexScope]
    const itemCount = Array.isArray(scripts) ? scripts.filter(isRegexScript).length : 0
    if (itemCount > 0) {
      const scopeLabel =
        regexScope === 'global' ? '全局' : regexScope === 'character' ? '角色卡' : '预设'
      return {
        type: RESOURCE_TYPE.REGEX,
        variant: 'regexCollection',
        name:
          regexScope === 'global' && itemCount === 1 && readString(record.sourceName) === '全局正则'
            ? fallbackName
            : readString(record.sourceName) || fallbackName,
        description: `${scopeLabel}正则，包含 ${itemCount} 条脚本`,
        itemCount,
        metadata: {
          regexScope,
          sourceName: readString(record.sourceName),
        },
      }
    }
  }

  if (isTavernHelperScript(record)) {
    const button = isRecord(record.button) ? record.button : undefined
    return {
      type: RESOURCE_TYPE.SCRIPT,
      variant: 'tavernHelperScript',
      name: readString(record.name) || fallbackName,
      description: '酒馆助手 JavaScript 脚本',
      itemCount: Array.isArray(button?.buttons)
        ? button.buttons.length
        : Array.isArray(record.buttons)
          ? record.buttons.length
          : undefined,
    }
  }

  if (isTavernHelperFolder(record)) {
    return {
      type: RESOURCE_TYPE.SCRIPT,
      variant: 'tavernHelperScriptFolder',
      name: readString(record.name) || fallbackName,
      description: `酒馆助手脚本文件夹，包含 ${record.scripts.length} 个脚本`,
      itemCount: record.scripts.length,
    }
  }

  const helperScripts = Array.isArray(record.scripts)
    ? record.scripts
    : isRecord(record.script) && Array.isArray(record.script.scripts)
      ? record.script.scripts
      : undefined
  if (helperScripts?.length && helperScripts.every(isTavernHelperTree)) {
    const itemCount = countTavernHelperScripts(helperScripts)
    return {
      type: RESOURCE_TYPE.SCRIPT,
      variant: 'tavernHelperScriptLibrary',
      name: readString(record.name) || fallbackName,
      description: `酒馆助手脚本库，包含 ${itemCount} 个脚本`,
      itemCount,
    }
  }

  const themeKeys = ['main_text_color', 'blur_strength', 'chat_tint_color', 'custom_css']
  if (typeof record.name === 'string' && themeKeys.filter((key) => key in record).length >= 2) {
    const colors = [
      record.chat_tint_color,
      record.user_mes_blur_tint_color,
      record.bot_mes_blur_tint_color,
      record.main_text_color,
      record.quote_text_color,
      record.border_color,
    ]
      .map(readString)
      .filter(Boolean)
    return {
      type: RESOURCE_TYPE.BEAUTIFICATION,
      variant: 'theme',
      name: readString(record.name) || fallbackName,
      description: 'SillyTavern 界面主题',
      metadata: {
        beautificationPreview: {
          colors,
          blurStrength: typeof record.blur_strength === 'number' ? record.blur_strength : undefined,
          customCssLength: readString(record.custom_css).length,
        },
      },
    }
  }

  if ('entries' in record && (isRecord(record.entries) || Array.isArray(record.entries))) {
    const itemCount = countEntries(record.entries)
    return {
      type: RESOURCE_TYPE.WORLD_BOOK,
      variant: 'worldBook',
      name: readString(record.name) || fallbackName,
      description: readString(record.description) || `包含 ${itemCount} 条世界书条目`,
      itemCount,
    }
  }

  const scriptContent = readString(record.script) || readString(record.content)
  if (scriptContent && scriptLanguage === 'stscript') {
    return {
      type: RESOURCE_TYPE.SCRIPT,
      variant: 'stscript',
      name: readString(record.name) || readString(record.title) || fallbackName,
      description: readString(record.description) || 'SillyTavern STscript 脚本',
    }
  }

  const samplerKeys = [
    'temperature',
    'top_p',
    'top_k',
    'min_p',
    'repetition_penalty',
    'frequency_penalty',
    'presence_penalty',
  ]
  const samplerKeyCount = samplerKeys.filter((key) => key in record).length
  const isPreset =
    typeof record.chat_completion_source === 'string' ||
    (Array.isArray(record.prompts) && Array.isArray(record.prompt_order)) ||
    (typeof record.input_sequence === 'string' && typeof record.output_sequence === 'string') ||
    (typeof record.story_string === 'string' && typeof record.example_separator === 'string') ||
    samplerKeyCount >= 3

  if (isPreset) {
    const extensions = isRecord(record.extensions) ? record.extensions : undefined
    const presetRegexCount = Array.isArray(extensions?.regex_scripts)
      ? extensions.regex_scripts.filter(isRegexScript).length
      : 0
    const promptCount = Array.isArray(record.prompts) ? record.prompts.length : 0
    return {
      type: RESOURCE_TYPE.PRESET,
      variant: 'generationPreset',
      name: readString(record.name) || fallbackName,
      description:
        readString(record.description) ||
        `SillyTavern 生成与提示词预设${presetRegexCount ? ` · ${presetRegexCount} 条配套正则` : ''}`,
      itemCount: promptCount + presetRegexCount,
      metadata: {
        promptCount,
        presetRegexCount,
      },
    }
  }

  return {
    type: RESOURCE_TYPE.OTHER,
    variant: 'jsonObject',
    name: readString(record.name) || readString(record.title) || fallbackName,
    description: readString(record.description) || '未识别的 JSON 资源',
  }
}

export class JsonResourceParser implements ResourceParser {
  supports(file: File): boolean {
    return file.type === 'application/json' || file.name.toLowerCase().endsWith('.json')
  }

  async parse(file: File): Promise<ParsedResource> {
    let content: unknown

    try {
      content = JSON.parse(await file.text())
    } catch {
      throw new Error('JSON 格式无效')
    }

    if (!isRecord(content) && !Array.isArray(content)) {
      throw new Error('JSON 顶层必须是对象或数组')
    }

    if (jsonChatRecords(content)) return summarizeChat(file, 'json')

    if (isRecord(content) && content.format === 'srl-personal-resource') {
      const { parsePersonalResource } = await import('../types/PersonalResource')
      const { personalResourceMetadata } = await import('../services/PersonalResourceService')
      const document = parsePersonalResource(content)
      if (document.kind === 'secret') {
        if (file.size > 2 * 1024 * 1024) throw new Error('密钥资源超过 2 MB，请减少字段内容')
        const { validateSecretDocument } = await import('../services/PersonalResourceImport')
        validateSecretDocument(document)
      }
      return personalResourceMetadata(document)
    }
    if (isRecord(content) && content.format === 'srl-greeting') {
      const greeting = parseGreetingResource(content)
      return {
        type: RESOURCE_TYPE.GREETING,
        name: greeting.name,
        description: `主开场白 + ${greeting.alternate_greetings.length} 个备用开场白${greeting.companion_scripts.length ? ` · ${greeting.companion_scripts.length} 个配套脚本` : ''}`,
        metadata: {
          format: 'json',
          parserVersion: JSON_RESOURCE_PARSER_VERSION,
          detectedVariant: 'greeting',
          itemCount: greeting.alternate_greetings.length + 1,
        },
      }
    }
    const fallbackName = file.name.replace(/\.json$/i, '')
    const detection = Array.isArray(content)
      ? detectArray(content, fallbackName)
      : detectRecord(content, fallbackName)

    return {
      type: detection.type,
      name: detection.name || fallbackName,
      description: detection.description || '',
      tags: detection.tags,
      metadata: {
        format: 'json',
        parserVersion: JSON_RESOURCE_PARSER_VERSION,
        detectedVariant: detection.variant,
        rootKeys: isRecord(content) ? Object.keys(content).slice(0, 50) : [],
        itemCount: detection.itemCount,
        ...detection.metadata,
      },
    }
  }
}
