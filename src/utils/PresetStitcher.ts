import { isRecord } from './UnknownValue'

/**
 * 「缝了么」预设缝合核心：从多个 SillyTavern 预设中挑选提示词段，
 * 以某个预设为底板缝合出可直接导入酒馆的新预设。
 *
 * 往返保真红线：缝合永远在底板完整深拷贝的基础上进行，只新增 prompts
 * 条目、重建 prompt_order 顺序与追加 extensions.regex_scripts；
 * 所有未识别字段原样透传，绝不重建整个 JSON。
 */

export interface PresetSegmentView {
  identifier: string
  name: string
  role: string
  content: string
  charCount: number
  enabled: boolean
  marker: boolean
  /** 是否出现在 prompt_order 中；孤儿条目保留在文件里但不参与装配。 */
  inOrder: boolean
  stitchable: boolean
}

export interface AssemblyEntry {
  /** 界面行唯一键：底板行为 base:<identifier>，挑选行为 pick:<资源id>:<identifier>。 */
  key: string
  origin: 'base' | 'pick'
  identifier: string
  name: string
  role: string
  content: string
  charCount: number
  marker: boolean
  enabled: boolean
  sourceResourceId?: string
  sourceName?: string
  favoriteId?: string
  /** 每一行都携带工作副本；编辑只改副本，不改来源资源。 */
  prompt: Record<string, unknown>
  original: {
    name: string
    role: string
    content: string
    enabled: boolean
  }
}

export interface PresetPromptSlot {
  id: string
  label: string
}

export interface PresetPromptSlotEntry {
  identifier: string
  name: string
  emptyBehavior: 'hide-entry'
  slots: PresetPromptSlot[]
}

export const PRESET_PROMPT_SLOT_SCHEMA_VERSION = 1

/** 酒馆扩展读取的命名占位宏；id 稳定，label 仅用于显示。 */
export function createPresetPromptSlotMacro(
  label: string,
  id: string = crypto.randomUUID(),
): string {
  const normalized = label.trim()
  if (!normalized || normalized.length > 80 || /[{}:\r\n]/u.test(normalized))
    throw new Error('占位名需为 1–80 个字符，且不能包含花括号、冒号或换行')
  return `{{srl_slot::${id}::${normalized}}}`
}

export function readPresetPromptSlots(content: string): PresetPromptSlot[] {
  const slots = new Map<string, PresetPromptSlot>()
  const pattern = /\{\{\s*srl_slot::([a-z\d-]{8,64})::([^:{}\r\n]{1,80})\s*\}\}/giu
  for (const match of content.matchAll(pattern)) {
    const id = match[1]?.trim()
    const label = match[2]?.trim()
    if (id && label && !slots.has(id)) slots.set(id, { id, label })
  }
  return [...slots.values()]
}

/** Runtime macros are represented as placeholders when reviewing preset content changes. */
export function renderPromptReviewContent(content: string, label = '', marker = false): string {
  const markerName = label.toLocaleLowerCase()
  if (marker && /world.?info|lorebook|world.?book/u.test(markerName)) return '【这是世界书内容】'
  if (marker && /user.?persona|persona|user.?description|用户人设/u.test(markerName))
    return '【这是用户人设】'
  if (
    marker &&
    /char.?description|char.?personality|character|description|personality|角色人设|角色描述/u.test(
      markerName,
    )
  )
    return '【这是角色人设内容】'
  if (marker && /chat.?history|conversation|message.?history|聊天记录|对话历史/u.test(markerName))
    return '【这是聊天记录内容】'
  const withPromptSlots = content.replace(
    /\{\{\s*srl_slot::[a-z\d-]{8,64}::([^:{}\r\n]{1,80})\s*\}\}/giu,
    '【填写：$1】',
  )
  return withPromptSlots.replace(/\{\{\s*([^{}]+?)\s*\}\}/gu, (_macro, rawName: string) => {
    const name = rawName.trim()
    const normalized = name.toLocaleLowerCase()
    if (/world.?info|lorebook|world.?book|wi::/u.test(normalized)) return '【这是世界书内容】'
    if (/persona|user.?description|user.?persona/u.test(normalized)) return '【这是用户人设】'
    if (
      /char.?description|char.?personality|description|personality|scenario|mes.?examples/u.test(
        normalized,
      )
    )
      return '【这是角色人设内容】'
    if (/^char$/u.test(normalized)) return '【角色名】'
    if (/^user$/u.test(normalized)) return '【用户名】'
    return `【运行时变量：${name}】`
  })
}

export interface PresetFavoriteSnapshot {
  id: string
  sourceResourceId?: string
  sourceName: string
  identifier: string
  name: string
  role: string
  content: string
  prompt: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

/** 只用于本机候选检查；不改变任何 prompt 正文或导出内容。 */
export function estimatePromptSimilarity(left: string, right: string): number {
  const normalize = (value: string) => value.toLocaleLowerCase().replace(/\s+/g, '')
  const first = normalize(left)
  const second = normalize(right)
  if (!first || !second) return 0
  if (first === second) return 1
  if (first.includes(second) || second.includes(first))
    return Math.min(first.length, second.length) / Math.max(first.length, second.length)
  const grams = (value: string) => {
    const result = new Set<string>()
    for (let index = 0; index < value.length - 1; index += 1)
      result.add(value.slice(index, index + 2))
    return result
  }
  const firstGrams = grams(first)
  const secondGrams = grams(second)
  let shared = 0
  for (const gram of firstGrams) if (secondGrams.has(gram)) shared += 1
  return shared / Math.max(firstGrams.size + secondGrams.size - shared, 1)
}

export function listPromptSetVariables(content: string): string[] {
  const variables = new Set<string>()
  const pattern = /\{\{\s*set(?:global)?var::\s*([^:}]+?)\s*::/gi
  for (const match of content.matchAll(pattern)) {
    const name = match[1]?.trim()
    if (name) variables.add(name)
  }
  return [...variables]
}

export interface RegexGroupPick {
  sourceResourceId: string
  sourceName: string
  scripts: Record<string, unknown>[]
}

export interface StitchProvenance {
  kind: 'segment' | 'regex'
  resourceId: string
  resourceName: string
  identifier: string
  finalIdentifier: string
  name: string
}

export interface StitchOutput {
  preset: Record<string, unknown>
  provenance: StitchProvenance[]
}

export interface StitchReviewItem {
  kind: 'add' | 'remove' | 'edit' | 'regex'
  key: string
  title: string
  detail: string
  sourceName?: string
  beforeContent?: string
  afterContent?: string
  addedMacros?: string[]
  removedMacros?: string[]
}

export interface PromptVariableReference {
  scope: 'chat' | 'global'
  operation: 'read' | 'write'
  name: string
}

export interface PromptAuditIssue {
  kind: 'braces' | 'condition' | 'unwritten-read' | 'repeated-write'
  severity: 'error' | 'warning'
  title: string
  detail: string
  entryKeys: string[]
}

export interface PromptAuditReport {
  issues: PromptAuditIssue[]
  reads: string[]
  writes: string[]
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function variableLabel(reference: PromptVariableReference): string {
  return `${reference.scope === 'global' ? '全局' : '聊天'}：${reference.name}`
}

function subtractOccurrences(values: string[], baseline: string[]): string[] {
  const counts = new Map<string, number>()
  for (const value of baseline) counts.set(value, (counts.get(value) ?? 0) + 1)
  return values.filter((value) => {
    const count = counts.get(value) ?? 0
    if (!count) return true
    counts.set(value, count - 1)
    return false
  })
}

export function listPromptMacros(content: string): string[] {
  return [...content.matchAll(/\{\{[^{}]*\}\}/g)].map((match) => match[0])
}

function listMacroRanges(content: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  let start = -1
  let depth = 0
  for (let index = 0; index < content.length - 1; index += 1) {
    const pair = content.slice(index, index + 2)
    if (pair === '{{') {
      if (depth === 0) start = index
      depth += 1
      index += 1
    } else if (pair === '}}' && depth > 0) {
      depth -= 1
      index += 1
      if (depth === 0 && start >= 0) {
        ranges.push({ start, end: index + 1 })
        start = -1
      }
    }
  }
  return ranges
}

function macroHighlightKind(macro: string): 'read' | 'write' | 'plain' {
  const value = macro.slice(2, -2).trim().replace(/^#\s*/, '')
  if (/^(?:get|has)(?:global)?var\b/i.test(value)) return 'read'
  if (/^(?:set|add|inc|dec|delete)(?:global)?var\b/i.test(value)) return 'write'
  const shorthand =
    /^([.$])\s*[A-Za-z](?:[A-Za-z0-9_-]*[A-Za-z0-9])?\s*(\|\|=|\?\?=|\+\+|--|\+=|-=|=)?/.exec(value)
  if (!shorthand) return 'plain'
  return shorthand[2] ? 'write' : 'read'
}

/** 原样转义正文后为酒馆宏加上只读高亮标记；不解析或执行宏。 */
export interface PromptDisplayToken {
  text: string
  kind: 'plain' | 'read' | 'write'
}

/** 仅按原文切分展示片段，不解析或执行酒馆宏。 */
export function getPromptDisplayTokens(content: string): PromptDisplayToken[] {
  let cursor = 0
  const tokens: PromptDisplayToken[] = []
  for (const range of listMacroRanges(content)) {
    const plainText = content.slice(cursor, range.start)
    if (plainText) tokens.push({ text: plainText, kind: 'plain' })
    const macro = content.slice(range.start, range.end)
    tokens.push({ text: macro, kind: macroHighlightKind(macro) })
    cursor = range.end
  }
  const trailingText = content.slice(cursor)
  if (trailingText) tokens.push({ text: trailingText, kind: 'plain' })
  return tokens
}

export function listPromptVariables(content: string): PromptVariableReference[] {
  const references: Array<PromptVariableReference & { index: number }> = []
  const pattern =
    /\{\{\s*#?\s*((?:get|has|set|add|inc|dec|delete)(?:global)?var)(?:(?:::)|\s+)\s*(?!\{\{)([^:}\s]+)/gi
  for (const match of content.matchAll(pattern)) {
    const macro = match[1]?.toLocaleLowerCase()
    const name = match[2]?.trim()
    if (!macro || !name) continue
    references.push({
      scope: macro.includes('global') ? 'global' : 'chat',
      operation: /^(get|has)/.test(macro) ? 'read' : 'write',
      name,
      index: match.index,
    })
  }

  const shorthandPattern =
    /\{\{\s*#?\s*([.$])\s*([A-Za-z](?:[A-Za-z0-9_-]*[A-Za-z0-9])?)\s*(\|\|=|\?\?=|\+\+|--|\+=|-=|==|!=|>=|<=|=|>|<|\|\||\?\?)?/g
  const shorthandWrites = new Set(['||=', '??=', '++', '--', '+=', '-=', '='])
  for (const match of content.matchAll(shorthandPattern)) {
    const scope = match[1] === '$' ? 'global' : 'chat'
    const name = match[2]?.trim()
    if (!name) continue
    references.push({
      scope,
      operation: match[3] && shorthandWrites.has(match[3]) ? 'write' : 'read',
      name,
      index: match.index,
    })
  }

  return references
    .sort((left, right) => left.index - right.index)
    .map(({ scope, operation, name }) => ({ scope, operation, name }))
}

function buildContentDiff(before: string, after: string) {
  const beforeMacros = listPromptMacros(before)
  const afterMacros = listPromptMacros(after)
  return {
    addedMacros: subtractOccurrences(afterMacros, beforeMacros),
    removedMacros: subtractOccurrences(beforeMacros, afterMacros),
  }
}

function auditPromptSyntax(entry: AssemblyEntry): PromptAuditIssue[] {
  const issues: PromptAuditIssue[] = []
  let braceDepth = 0
  let unmatchedClosing = false
  for (let index = 0; index < entry.content.length - 1; index += 1) {
    const pair = entry.content.slice(index, index + 2)
    if (pair === '{{') {
      braceDepth += 1
      index += 1
    } else if (pair === '}}') {
      if (braceDepth === 0) unmatchedClosing = true
      else braceDepth -= 1
      index += 1
    }
  }
  if (braceDepth || unmatchedClosing) {
    issues.push({
      kind: 'braces',
      severity: 'error',
      title: `「${entry.name}」的大括号没有配对`,
      detail: '请检查 {{ 和 }} 是否成对出现。',
      entryKeys: [entry.key],
    })
  }

  let conditionDepth = 0
  let invalidCondition = false
  for (const match of entry.content.matchAll(/\{\{\s*#?\s*(\/if|if|else)\b/gi)) {
    const token = match[1]?.toLocaleLowerCase()
    if (token === 'if') conditionDepth += 1
    else if (token === '/if') {
      if (conditionDepth === 0) invalidCondition = true
      else conditionDepth -= 1
    } else if (conditionDepth === 0) invalidCondition = true
  }
  if (conditionDepth || invalidCondition) {
    issues.push({
      kind: 'condition',
      severity: 'error',
      title: `「${entry.name}」的条件块没有关闭`,
      detail: '请检查 {{if ...}}、{{else}} 和 {{/if}}。',
      entryKeys: [entry.key],
    })
  }
  return issues
}

export function auditPresetAssembly(assembly: AssemblyEntry[]): PromptAuditReport {
  const enabled = assembly.filter((entry) => entry.enabled && !entry.marker)
  const issues = enabled.flatMap(auditPromptSyntax)
  const references = enabled.flatMap((entry) =>
    listPromptVariables(entry.content).map((reference) => ({ entry, reference })),
  )
  const writes = references.filter((item) => item.reference.operation === 'write')
  const writeKeys = new Set(writes.map((item) => `${item.reference.scope}:${item.reference.name}`))
  const missingReads = new Map<string, { label: string; entryKeys: Set<string> }>()
  for (const item of references.filter((value) => value.reference.operation === 'read')) {
    const key = `${item.reference.scope}:${item.reference.name}`
    if (writeKeys.has(key)) continue
    const current = missingReads.get(key) ?? {
      label: variableLabel(item.reference),
      entryKeys: new Set<string>(),
    }
    current.entryKeys.add(item.entry.key)
    missingReads.set(key, current)
  }
  for (const value of missingReads.values()) {
    issues.push({
      kind: 'unwritten-read',
      severity: 'warning',
      title: `读取了未在当前预设写入的变量「${value.label}」`,
      detail: '这个变量可能来自聊天、快速回复或其他扩展，请确认来源。',
      entryKeys: [...value.entryKeys],
    })
  }

  const writers = new Map<string, { label: string; entryKeys: Set<string> }>()
  for (const item of writes) {
    const key = `${item.reference.scope}:${item.reference.name}`
    const current = writers.get(key) ?? {
      label: variableLabel(item.reference),
      entryKeys: new Set<string>(),
    }
    current.entryKeys.add(item.entry.key)
    writers.set(key, current)
  }
  for (const value of writers.values()) {
    if (value.entryKeys.size < 2) continue
    issues.push({
      kind: 'repeated-write',
      severity: 'warning',
      title: `多段提示词写入同一变量「${value.label}」`,
      detail: `共有 ${value.entryKeys.size} 个启用条目写入这个变量。`,
      entryKeys: [...value.entryKeys],
    })
  }

  return {
    issues,
    reads: unique(
      references
        .filter((item) => item.reference.operation === 'read')
        .map((item) => variableLabel(item.reference)),
    ),
    writes: unique(writes.map((item) => variableLabel(item.reference))),
  }
}

/** 预设是纯 JSON 数据；JSON 深拷贝可同时剥离 Vue 响应式代理，structuredClone 反而会抛错。 */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function parsePresetText(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function readPrompts(preset: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(preset.prompts) ? preset.prompts.filter(isRecord) : []
}

interface OrderGroup {
  group: Record<string, unknown>
  order: Record<string, unknown>[]
}

function readOrderGroups(preset: Record<string, unknown>): OrderGroup[] {
  if (!Array.isArray(preset.prompt_order)) return []
  return preset.prompt_order.filter(isRecord).flatMap((group) => {
    if (!Array.isArray(group.order)) return []
    return [{ group, order: group.order.filter(isRecord) }]
  })
}

/**
 * 酒馆聊天补全使用 100001 全局组，旧组即使更长也不是当前顺序。
 * 不带全局组的旧文件沿用首个有效组；不能仅凭条目数量猜测当前角色。
 */
function readPresetOrderGroup(preset: Record<string, unknown>): OrderGroup | undefined {
  const groups = readOrderGroups(preset)
  return groups.find(({ group }) => String(group.character_id) === '100001') ?? groups[0]
}

function segmentFromPrompt(
  prompt: Record<string, unknown>,
  enabled: boolean,
  inOrder: boolean,
): PresetSegmentView {
  const marker = prompt.marker === true
  const content = readString(prompt.content)
  const role = readString(prompt.role) || (prompt.system_prompt === true ? 'system' : '')
  return {
    identifier: readString(prompt.identifier),
    name: readString(prompt.name) || readString(prompt.identifier) || '未命名段',
    role,
    content,
    charCount: content.length,
    enabled,
    marker,
    inOrder,
    stitchable: !marker,
  }
}

/** 详情与缝合共用顺序/启停解析，原记录只读；未排序条目附在末尾。 */
export function listPresetPromptEntries(
  preset: Record<string, unknown>,
): { prompt: Record<string, unknown>; enabled: boolean; inOrder: boolean }[] {
  const prompts = readPrompts(preset)
  const group = readPresetOrderGroup(preset)
  // 没有排序表的旧格式仍展示原数组及其启停状态，保留无 identifier 的条目。
  if (!group)
    return prompts.map((prompt) => ({ prompt, enabled: prompt.enabled !== false, inOrder: false }))
  const byIdentifier = new Map(prompts.map((prompt) => [readString(prompt.identifier), prompt]))
  const entries: ReturnType<typeof listPresetPromptEntries> = []
  const seen = new Set<string>()
  for (const entry of group.order) {
    const identifier = readString(entry.identifier)
    const prompt = byIdentifier.get(identifier)
    if (!identifier || !prompt || seen.has(identifier)) continue
    seen.add(identifier)
    entries.push({ prompt, enabled: entry.enabled !== false, inOrder: true })
  }
  for (const prompt of prompts) {
    const identifier = readString(prompt.identifier)
    if (identifier && seen.has(identifier)) continue
    if (identifier) seen.add(identifier)
    entries.push({ prompt, enabled: false, inOrder: false })
  }
  return entries
}

/** 按 prompt_order 顺序列出预设条目，孤儿条目（不在 order 中）附在末尾。 */
export function listPresetSegments(preset: Record<string, unknown>): PresetSegmentView[] {
  return listPresetPromptEntries(preset).map(({ prompt, enabled, inOrder }) =>
    segmentFromPrompt(prompt, inOrder && enabled, inOrder),
  )
}

/** 预设内嵌整组正则（extensions.regex_scripts）中的可缝条目。 */
export function listPresetRegexScripts(preset: Record<string, unknown>): Record<string, unknown>[] {
  const extensions = isRecord(preset.extensions) ? preset.extensions : undefined
  if (!Array.isArray(extensions?.regex_scripts)) return []
  return extensions.regex_scripts.filter(
    (item): item is Record<string, unknown> =>
      isRecord(item) &&
      (typeof item.scriptName === 'string' || typeof item.script_name === 'string'),
  )
}

export function regexScriptName(script: Record<string, unknown>): string {
  return readString(script.scriptName) || readString(script.script_name) || '未命名正则'
}

/** 由底板 prompt_order 建立初始装配区：底板行可停用、可排序，不可移除。 */
export function buildBaseAssembly(preset: Record<string, unknown>): AssemblyEntry[] {
  const prompts = new Map(
    readPrompts(preset).map((prompt) => [readString(prompt.identifier), prompt]),
  )
  return listPresetSegments(preset)
    .filter((segment) => segment.inOrder)
    .flatMap((segment) => {
      const prompt = prompts.get(segment.identifier)
      if (!prompt) return []
      return [
        {
          key: `base:${segment.identifier}`,
          origin: 'base' as const,
          identifier: segment.identifier,
          name: segment.name,
          role: segment.role,
          content: segment.content,
          charCount: segment.charCount,
          marker: segment.marker,
          enabled: segment.enabled,
          prompt: cloneJson(prompt),
          original: {
            name: segment.name,
            role: segment.role,
            content: segment.content,
            enabled: segment.enabled,
          },
        },
      ]
    })
}

export function buildPickEntry(
  sourceResourceId: string,
  sourceName: string,
  preset: Record<string, unknown>,
  identifier: string,
): AssemblyEntry | undefined {
  const prompt = readPrompts(preset).find((item) => readString(item.identifier) === identifier)
  if (!prompt || prompt.marker === true) return undefined
  const segment = segmentFromPrompt(prompt, true, true)
  return {
    key: `pick:${sourceResourceId}:${identifier}`,
    origin: 'pick',
    identifier,
    name: segment.name,
    role: segment.role,
    content: segment.content,
    charCount: segment.charCount,
    marker: false,
    enabled: true,
    sourceResourceId,
    sourceName,
    prompt: cloneJson(prompt),
    original: {
      name: segment.name,
      role: segment.role,
      content: segment.content,
      enabled: segment.enabled,
    },
  }
}

export function buildFavoriteEntry(favorite: PresetFavoriteSnapshot): AssemblyEntry {
  return {
    key: `favorite:${favorite.id}:${crypto.randomUUID()}`,
    origin: 'pick',
    identifier: favorite.identifier,
    name: favorite.name,
    role: favorite.role,
    content: favorite.content,
    charCount: favorite.content.length,
    marker: false,
    enabled: true,
    sourceResourceId: favorite.sourceResourceId,
    sourceName: favorite.sourceName || '已收藏条目',
    favoriteId: favorite.id,
    prompt: cloneJson(favorite.prompt),
    original: {
      name: favorite.name,
      role: favorite.role,
      content: favorite.content,
      enabled: true,
    },
  }
}

export function applyEntryEdit(
  entry: AssemblyEntry,
  value: { name: string; role: string; content: string },
): void {
  entry.name = value.name.trim() || entry.identifier || '未命名段'
  entry.role = value.role
  entry.content = value.content
  entry.charCount = value.content.length
  entry.prompt.name = entry.name
  entry.prompt.role = entry.role
  entry.prompt.content = entry.content
}

/**
 * 缝合：底板深拷贝 + 追加挑选段 + 按装配区重建 prompt_order + 合并整组正则。
 * identifier 冲突时换新 uuid 并在段名后加「·缝」；底板 prompts 与未知字段不动。
 */
export function stitchPreset(
  base: Record<string, unknown>,
  assembly: AssemblyEntry[],
  regexPicks: RegexGroupPick[] = [],
): StitchOutput {
  const preset = cloneJson(base)
  const provenance: StitchProvenance[] = []

  const prompts = Array.isArray(preset.prompts) ? preset.prompts : []
  preset.prompts = prompts
  const usedIdentifiers = new Set(
    prompts.filter(isRecord).map((prompt) => readString(prompt.identifier)),
  )

  const promptByIdentifier = new Map(
    prompts.filter(isRecord).map((prompt) => [readString(prompt.identifier), prompt] as const),
  )
  for (const entry of assembly) {
    if (entry.origin !== 'base' || entry.marker) continue
    const target = promptByIdentifier.get(entry.identifier)
    if (!target) continue
    target.name = entry.name
    target.role = entry.role
    target.content = entry.content
  }

  const finalIdentifiers = new Map<string, string>()
  for (const entry of assembly) {
    if (entry.origin !== 'pick') continue
    let identifier = entry.identifier
    let name = entry.name
    if (usedIdentifiers.has(identifier)) {
      identifier = crypto.randomUUID()
      name = name ? `${name}·缝` : name
    }
    usedIdentifiers.add(identifier)
    finalIdentifiers.set(entry.key, identifier)
    const clone = cloneJson(entry.prompt)
    clone.identifier = identifier
    clone.name = name
    clone.role = entry.role
    clone.content = entry.content
    prompts.push(clone)
    provenance.push({
      kind: 'segment',
      resourceId: entry.sourceResourceId ?? '',
      resourceName: entry.sourceName ?? '',
      identifier: entry.identifier,
      finalIdentifier: identifier,
      name: entry.name,
    })
  }

  const baseOrderIds = new Set(
    (readPresetOrderGroup(base)?.order ?? []).map((orderEntry) =>
      readString(orderEntry.identifier),
    ),
  )
  const groups = readOrderGroups(preset)
  const applyOrder = (group: OrderGroup): void => {
    const originals = new Map(
      group.order.map((orderEntry) => [readString(orderEntry.identifier), orderEntry]),
    )
    const rebuilt = assembly.map((entry) => {
      const identifier =
        entry.origin === 'pick'
          ? (finalIdentifiers.get(entry.key) ?? entry.identifier)
          : entry.identifier
      const original = originals.get(identifier)
      if (original) return { ...cloneJson(original), enabled: entry.enabled }
      return { identifier, enabled: entry.enabled }
    })
    // 该组独有、不在装配基准里的条目保留在末尾，不丢失其他 character 组的私有顺序。
    const extras = group.order
      .filter((orderEntry) => !baseOrderIds.has(readString(orderEntry.identifier)))
      .map((orderEntry) => cloneJson(orderEntry))
    group.group.order = [...rebuilt, ...extras]
  }
  if (groups.length) {
    for (const group of groups) applyOrder(group)
  } else if (assembly.some((entry) => entry.origin === 'pick')) {
    preset.prompt_order = [
      {
        character_id: 100001,
        order: assembly.map((entry) => ({
          identifier:
            entry.origin === 'pick'
              ? (finalIdentifiers.get(entry.key) ?? entry.identifier)
              : entry.identifier,
          enabled: entry.enabled,
        })),
      },
    ]
  }

  if (regexPicks.length) {
    const extensions = isRecord(preset.extensions) ? preset.extensions : {}
    preset.extensions = extensions
    const regexScripts = Array.isArray(extensions.regex_scripts) ? extensions.regex_scripts : []
    extensions.regex_scripts = regexScripts
    const usedRegexIds = new Set(
      regexScripts.filter(isRecord).map((script) => readString(script.id)),
    )
    for (const pick of regexPicks) {
      for (const script of pick.scripts) {
        const clone = cloneJson(script)
        const originalId = readString(clone.id)
        let id = originalId
        if (!id || usedRegexIds.has(id)) id = crypto.randomUUID()
        usedRegexIds.add(id)
        clone.id = id
        regexScripts.push(clone)
        provenance.push({
          kind: 'regex',
          resourceId: pick.sourceResourceId,
          resourceName: pick.sourceName,
          identifier: originalId,
          finalIdentifier: id,
          name: regexScriptName(script),
        })
      }
    }
  }

  const promptSlotEntries: PresetPromptSlotEntry[] = assembly.flatMap((entry) => {
    if (entry.marker) return []
    const slots = readPresetPromptSlots(entry.content)
    if (!slots.length) return []
    return [
      {
        identifier: finalIdentifiers.get(entry.key) ?? entry.identifier,
        name: entry.name,
        emptyBehavior: 'hide-entry',
        slots,
      },
    ]
  })
  const extensions = isRecord(preset.extensions) ? preset.extensions : {}
  if (promptSlotEntries.length) {
    extensions.srl_prompt_slots = {
      schemaVersion: PRESET_PROMPT_SLOT_SCHEMA_VERSION,
      entries: promptSlotEntries,
    }
    preset.extensions = extensions
  } else if (isRecord(extensions.srl_prompt_slots)) {
    delete extensions.srl_prompt_slots
    preset.extensions = extensions
  }

  return { preset, provenance }
}

export function buildStitchReview(
  base: Record<string, unknown>,
  assembly: AssemblyEntry[],
  regexPicks: RegexGroupPick[] = [],
): StitchReviewItem[] {
  const original = buildBaseAssembly(base)
  const originalIndex = new Map(original.map((entry, index) => [entry.identifier, index]))
  const currentBaseIndex = new Map(
    assembly
      .filter((entry) => entry.origin === 'base')
      .map((entry, index) => [entry.identifier, index]),
  )
  const items: StitchReviewItem[] = []

  assembly.forEach((entry, index) => {
    if (entry.origin === 'pick') {
      const previous = assembly[index - 1]
      items.push({
        kind: 'add',
        key: `add:${entry.key}`,
        title: `新增「${entry.name}」`,
        detail: previous ? `插入在「${previous.name}」之后` : '插入到主预设最前面',
        sourceName: entry.sourceName,
        afterContent: entry.content,
        ...buildContentDiff('', entry.content),
      })
      return
    }

    const oldIndex = originalIndex.get(entry.identifier)
    const newIndex = currentBaseIndex.get(entry.identifier)
    const details: string[] = []
    const contentChanged = entry.content !== entry.original.content
    if (entry.name !== entry.original.name)
      details.push(`名称：${entry.original.name} → ${entry.name}`)
    if (entry.role !== entry.original.role)
      details.push(`角色：${entry.original.role || '未标注'} → ${entry.role || '未标注'}`)
    if (oldIndex !== undefined && newIndex !== undefined && oldIndex !== newIndex)
      details.push(`顺序：第 ${oldIndex + 1} 位 → 第 ${newIndex + 1} 位`)
    if (entry.enabled !== entry.original.enabled)
      details.push(
        `状态：${entry.original.enabled ? '启用' : '停用'} → ${entry.enabled ? '启用' : '停用'}`,
      )

    if (details.length || contentChanged) {
      items.push({
        kind: 'edit',
        key: `edit:${entry.key}`,
        title: `修改「${entry.name}」`,
        detail: details.join('；'),
        ...(contentChanged
          ? {
              beforeContent: entry.original.content,
              afterContent: entry.content,
              ...buildContentDiff(entry.original.content, entry.content),
            }
          : {}),
      })
    }
  })

  for (const entry of original) {
    if (currentBaseIndex.has(entry.identifier)) continue
    items.push({
      kind: 'remove',
      key: `remove:${entry.key}`,
      title: `删除「${entry.name}」`,
      detail: '从主预设中移除',
      beforeContent: entry.content,
      ...buildContentDiff(entry.content, ''),
    })
  }

  regexPicks.forEach((pick) => {
    items.push({
      kind: 'regex',
      key: `regex:${pick.sourceResourceId}`,
      title: `追加「${pick.sourceName}」配套正则`,
      detail: `${pick.scripts.length} 条正则脚本`,
      sourceName: pick.sourceName,
    })
  })
  return items
}

export function serializeStitchedPreset(preset: Record<string, unknown>): string {
  return JSON.stringify(preset, null, 2)
}

export function defaultStitchName(baseName: string): string {
  const trimmed = baseName.trim() || '未命名预设'
  return `${trimmed}·缝合`
}
