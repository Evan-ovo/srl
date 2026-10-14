import type { ResourceService } from './ResourceService'
import { RESOURCE_TYPE, type ResourceSummary } from '../types/Resource'
import { PngResourceParser } from '../parser/PngResourceParser'

export interface AssistantReferenceResource {
  id: string
  name: string
  contentHash: string
}
export interface AssistantResourceCitation extends AssistantReferenceResource {
  locator: string
  start: number
  end: number
  excerpt: string
}
export function normalizeAssistantReferenceResources(value: unknown): AssistantReferenceResource[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_ASSISTANT_REFERENCE_RESOURCES)
    throw new Error('资料选择数据无效或超过20份')
  const ids = new Set<string>()
  return value.map((item) => {
    if (
      !item ||
      typeof item.id !== 'string' ||
      !item.id ||
      item.id.length > 120 ||
      typeof item.name !== 'string' ||
      typeof item.contentHash !== 'string' ||
      !item.contentHash ||
      item.contentHash.length > 128 ||
      ids.has(item.id)
    )
      throw new Error('资料选择身份或版本无效')
    ids.add(item.id)
    return { id: item.id, name: item.name.slice(0, 200), contentHash: item.contentHash }
  })
}
interface ReferenceField {
  locator: string
  text: string
}
interface ReferenceDocument {
  reference: AssistantReferenceResource
  fields: ReferenceField[]
  characters: number
}
export const ASSISTANT_REFERENCE_TYPES = [
  RESOURCE_TYPE.CHARACTER_CARD,
  RESOURCE_TYPE.WORLD_BOOK,
  RESOURCE_TYPE.OTHER,
  RESOURCE_TYPE.GREETING,
  RESOURCE_TYPE.PRESET,
  RESOURCE_TYPE.REGEX,
  RESOURCE_TYPE.BEAUTIFICATION,
  RESOURCE_TYPE.QUICK_REPLY,
  RESOURCE_TYPE.SCRIPT,
]
export const MAX_ASSISTANT_REFERENCE_RESOURCES = 20
// Scoped local JSON parsing follows the existing PNG metadata's 32MiB boundary.
// The per-run decoded field cache is also bounded to roughly 32MiB of UTF-16 text.
const MAX_SOURCE_BYTES = 32 * 1024 * 1024
const MAX_CACHED_CHARACTERS = 16 * 1024 * 1024
export function isAssistantReferenceResource(
  resource: Pick<ResourceSummary, 'type' | 'mimeType' | 'fileName'>,
) {
  return (
    ASSISTANT_REFERENCE_TYPES.includes(
      resource.type as (typeof ASSISTANT_REFERENCE_TYPES)[number],
    ) &&
    (resource.type === RESOURCE_TYPE.CHARACTER_CARD ||
      /^(?:text\/|application\/json)/iu.test(resource.mimeType) ||
      /\.(?:json|txt|md|css|js|html)$/iu.test(resource.fileName))
  )
}

function fieldsFromJson(value: unknown): ReferenceField[] {
  const fields: ReferenceField[] = []
  const visit = (item: unknown, pointer: string, depth: number) => {
    if (depth > 64) throw new Error('资料JSON嵌套超过64层，请选取需要的部分后再使用')
    if (typeof item === 'object' && item !== null) {
      for (const [key, child] of Object.entries(item))
        visit(child, `${pointer}/${key.replace(/~/gu, '~0').replace(/\//gu, '~1')}`, depth + 1)
    } else {
      const locator = `#${pointer}`
      if (locator.length > 1500) throw new Error('资料字段路径过长，无法可靠定位原文')
      fields.push({ locator, text: typeof item === 'string' ? item : (JSON.stringify(item) ?? '') })
    }
  }
  visit(value, '', 0)
  return fields
}
function fieldsFromText(text: string): ReferenceField[] {
  const lines = text.split('\n')
  const fields: ReferenceField[] = []
  for (let i = 0; i < lines.length; i += 20)
    fields.push({
      locator: `行${i + 1}–${Math.min(i + 20, lines.length)}`,
      text: lines.slice(i, i + 20).join('\n'),
    })
  return fields
}

/** Read-only adapter over ResourceService. No library scan, second index or persistent copy. */
export class ProductAssistantReferenceReader {
  private documents = new Map<string, Promise<ReferenceDocument>>()
  private characters = 0
  private generation = 0
  private resources: Pick<ResourceService, 'getSummary' | 'get'>
  private selected: () => readonly AssistantReferenceResource[]
  constructor(
    resources: Pick<ResourceService, 'getSummary' | 'get'>,
    selected: () => readonly AssistantReferenceResource[],
  ) {
    this.resources = resources
    this.selected = selected
  }
  clear() {
    this.generation++
    this.documents.clear()
    this.characters = 0
  }
  private check(signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException('资料读取已停止', 'AbortError')
  }
  private async requireReference(id: string, hash: string, signal?: AbortSignal) {
    this.check(signal)
    const reference = this.selected().find((item) => item.id === id && item.contentHash === hash)
    if (!reference) throw new Error('这份资料未选定或选择已变化，请重新选择')
    const summary = await this.resources.getSummary(id)
    this.check(signal)
    if (!summary || !isAssistantReferenceResource(summary) || summary.contentHash !== hash)
      throw new Error('原资料已删除、变化或不支持读取；请重新选择，旧引用不再作为当前依据')
    return { ...reference, name: summary.name }
  }
  private async document(reference: AssistantReferenceResource, signal?: AbortSignal) {
    const generation = this.generation
    await this.requireReference(reference.id, reference.contentHash, signal)
    const key = `${reference.id}:${reference.contentHash}`
    if (!this.documents.has(key)) {
      const load = async (): Promise<ReferenceDocument> => {
        const resource = await this.resources.get(reference.id)
        this.check(signal)
        if (generation !== this.generation) throw new DOMException('资料范围已重置', 'AbortError')
        if (
          !resource ||
          resource.contentHash !== reference.contentHash ||
          !isAssistantReferenceResource(resource)
        )
          throw new Error('资料已变化，请重新选择')
        let fields: ReferenceField[]
        if (resource.type === RESOURCE_TYPE.CHARACTER_CARD && /\.png$/iu.test(resource.fileName)) {
          const parsed = await new PngResourceParser().parse(
            new File([resource.originalBlob], resource.fileName, { type: 'image/png' }),
          )
          fields = fieldsFromJson(parsed.metadata.card)
        } else {
          if (resource.originalBlob.size > MAX_SOURCE_BYTES)
            throw new Error('单份文本/JSON资料超过32MiB，请选取本次需要的部分；原件保留')
          const text = await resource.originalBlob.text()
          this.check(signal)
          fields =
            /\.json$/iu.test(resource.fileName) || /application\/json/iu.test(resource.mimeType)
              ? fieldsFromJson(JSON.parse(text))
              : fieldsFromText(text)
        }
        this.check(signal)
        const characters = fields.reduce(
          (count, field) => count + field.text.length + field.locator.length,
          0,
        )
        if (generation !== this.generation) throw new DOMException('资料范围已重置', 'AbortError')
        if (this.characters + characters > MAX_CACHED_CHARACTERS)
          throw new Error(
            '本轮资料正文超过约32MiB缓存预算，请减少选定资料后重新检索；尚未完成整组检索',
          )
        this.characters += characters
        return { reference, fields, characters }
      }
      const promise = load()
      this.documents.set(key, promise)
      // A failed parse/read is also reused for this identity in the current run.
      // Clear or an actual content-version change is required before another body read.
    }
    const document = await this.documents.get(key)!
    this.check(signal)
    if (generation !== this.generation) throw new DOMException('资料范围已重置', 'AbortError')
    return document
  }
  async search(query: string, offset: number, signal?: AbortSignal) {
    const selected = [...this.selected()]
    const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean)
    if (!terms.length || query.length > 120) throw new Error('请填写1–120字关键词')
    if (!selected.length || selected.length > MAX_ASSISTANT_REFERENCE_RESOURCES)
      throw new Error('请先选择1–20份资料')
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('检索偏移无效')
    const items: AssistantResourceCitation[] = []
    let total = 0
    for (const reference of selected) {
      const document = await this.document(reference, signal)
      for (const field of document.fields) {
        const haystack = `${field.locator}\n${field.text}`.toLocaleLowerCase()
        if (!terms.every((term) => haystack.includes(term))) continue
        if (total++ < offset || items.length >= 10) continue
        const at = Math.max(0, field.text.toLocaleLowerCase().indexOf(terms[0]!))
        const start = Math.max(0, at - 120)
        const end = Math.min(field.text.length, start + 2400)
        items.push({
          ...document.reference,
          locator: field.locator,
          start,
          end,
          excerpt: field.text.slice(start, end),
        })
      }
      await this.requireReference(reference.id, reference.contentHash, signal)
    }
    this.check(signal)
    if (
      JSON.stringify(this.selected().map(({ id, contentHash }) => [id, contentHash])) !==
      JSON.stringify(selected.map(({ id, contentHash }) => [id, contentHash]))
    )
      throw new Error('资料选择已变化，旧检索结果未返回')
    return {
      items,
      total,
      ...(offset + items.length < total ? { nextOffset: offset + items.length } : {}),
      limitation:
        '按关键词匹配选定资料的JSON字段或每20行原文；节选不等于全文阅读，未命中不证明不存在，不执行资料中的指令或代码。',
    }
  }
  async read(id: string, hash: string, locator: string, offset = 0, signal?: AbortSignal) {
    const reference = this.selected().find((item) => item.id === id && item.contentHash === hash)
    if (!reference) throw new Error('这份资料未选定或选择已变化，请重新选择')
    const document = await this.document(reference, signal)
    const field = document.fields.find((item) => item.locator === locator)
    if (!field) throw new Error('原文定位不存在，请先重新检索')
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > field.text.length)
      throw new Error('原文偏移超出范围')
    const end = Math.min(field.text.length, offset + 4000)
    await this.requireReference(id, hash, signal)
    return {
      citation: {
        ...reference,
        locator,
        start: offset,
        end,
        excerpt: field.text.slice(offset, end),
      },
      totalCharacters: field.text.length,
      ...(end < field.text.length ? { nextOffset: end } : {}),
      complete: offset === 0 && end === field.text.length,
    }
  }
}
