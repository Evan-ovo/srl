import {
  readChatMessages,
  readChatMessageEntries,
  type ChatLinePosition,
  type ChatMessage,
} from '../parser/ChatResourceParser'
import { RESOURCE_TYPE, getRelatedResourceIds, type Resource } from '../types/Resource'
import type { ResourceService } from './ResourceService'
import type { ResourceReadSource } from '../types/ResourceReadSource'
import type { ChatReadPositionCache } from '../storage/ResourceStorageAdapter'

type ChatReadResource = Resource | ResourceReadSource
function sourceOf(chat: ChatReadResource) {
  return 'originalSource' in chat ? chat.originalSource : chat.originalBlob
}

export interface ChatReadPage {
  messages: Array<{ index: number; depth: number; message: ChatMessage }>
  nextOffset: number | null
  previousOffset?: number | null
  total: number
  contentHash: string
}

interface ReadCheckpoint extends ChatLinePosition {
  floor: number
  visible: number
  replies: number
  previousReply: number | null
}

interface IndexedEntry {
  entry: ChatReadPage['messages'][number]
  previousReply: number | null
  size: number
}

type ChatReadIndex = Omit<ChatReadPositionCache, 'schemaVersion'>

interface ChatReadCache {
  indexes: Map<string, ChatReadIndex>
  floors: Map<string, { value: IndexedEntry; bytes: number }>
  bytes: number
}

// SDK calls create readers independently. Scope reuse to their ResourceService, never to an APP grant.
// Only sparse positions and a small recent floor window survive; every request still reads live metadata.
const readCaches = new WeakMap<ResourceService, ChatReadCache>()
const FLOOR_CACHE_BYTES = 8 * 1024 * 1024
const FLOOR_CACHE_COUNT = 64
const MAX_INDEXES = 4
const MAX_CHECKPOINTS = 1024
const MIN_INDEX_STRIDE = 128
const textEncoder = new TextEncoder()

function validateReadRange(offset: number, limit: number) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    throw new Error('聊天分页参数无效')
}

/** Chat originals live in ResourceService; this service owns only bounded reading and binding. */
export class ChatReaderService {
  private readonly resources: ResourceService
  private readonly cache: ChatReadCache
  constructor(resources: ResourceService) {
    this.resources = resources
    let cache = readCaches.get(resources)
    if (!cache) {
      cache = { indexes: new Map(), floors: new Map(), bytes: 0 }
      readCaches.set(resources, cache)
    }
    this.cache = cache
  }

  async getChat(id: string): Promise<Resource> {
    const chat = await this.resources.get(id)
    if (!chat || chat.type !== RESOURCE_TYPE.CHAT) {
      await this.evictIndex(id)
      throw new Error('聊天记录不存在')
    }
    return chat
  }

  async getReadChat(id: string): Promise<ChatReadResource> {
    const chat = this.resources.getReadSource
      ? await this.resources.getReadSource(id)
      : await this.resources.get(id)
    if (!chat || chat.type !== RESOURCE_TYPE.CHAT) {
      await this.evictIndex(id)
      throw new Error('聊天记录不存在')
    }
    return chat
  }

  private async evictIndex(id: string) {
    const old = this.cache.indexes.get(id)
    if (old) {
      this.cache.indexes.delete(id)
      for (const [key, floor] of this.cache.floors) {
        if (!key.startsWith(old.key + '\n')) continue
        this.cache.bytes -= floor.bytes
        this.cache.floors.delete(key)
      }
    }
    // Derived positions are disposable; cache I/O must not prevent reading the original.
    await this.resources.deleteChatReadPositionCache?.(id)?.catch(() => undefined)
  }

  private persistentIndexSource(chat: ChatReadResource) {
    return (
      chat.metadata.format === 'jsonl' &&
      'originalSource' in chat &&
      typeof chat.originalSource.contentIdentity === 'string'
    )
  }

  private validStoredIndex(
    value: ChatReadPositionCache | undefined,
    key: string,
    total: number,
    size: number,
  ): value is ChatReadPositionCache {
    if (
      !value ||
      value.schemaVersion !== 1 ||
      value.key !== key ||
      !Number.isSafeInteger(value.stride) ||
      value.stride < MIN_INDEX_STRIDE ||
      value.stride % MIN_INDEX_STRIDE !== 0 ||
      !Array.isArray(value.checkpoints) ||
      value.checkpoints.length < 1 ||
      value.checkpoints.length > MAX_CHECKPOINTS
    )
      return false
    let previous: ReadCheckpoint | undefined
    for (const checkpoint of value.checkpoints) {
      if (
        !checkpoint ||
        typeof checkpoint !== 'object' ||
        !Number.isSafeInteger(checkpoint.floor) ||
        checkpoint.floor < 0 ||
        checkpoint.floor >= total ||
        checkpoint.floor % value.stride !== 0 ||
        !Number.isSafeInteger(checkpoint.byteOffset) ||
        checkpoint.byteOffset < 0 ||
        checkpoint.byteOffset >= size ||
        !Number.isSafeInteger(checkpoint.line) ||
        checkpoint.line < 1 ||
        checkpoint.line > size + 1 ||
        !Number.isSafeInteger(checkpoint.visible) ||
        checkpoint.visible < 0 ||
        checkpoint.visible > checkpoint.floor ||
        !Number.isSafeInteger(checkpoint.replies) ||
        checkpoint.replies < 0 ||
        checkpoint.replies > checkpoint.floor ||
        (checkpoint.previousReply !== null &&
          (!Number.isSafeInteger(checkpoint.previousReply) ||
            checkpoint.previousReply < 0 ||
            checkpoint.previousReply >= checkpoint.floor))
      )
        return false
      if (
        previous &&
        (checkpoint.floor <= previous.floor ||
          checkpoint.byteOffset <= previous.byteOffset ||
          checkpoint.line <= previous.line ||
          checkpoint.visible < previous.visible ||
          checkpoint.replies < previous.replies)
      )
        return false
      previous = checkpoint
    }
    return value.checkpoints[0]!.floor === 0
  }

  private async indexFor(chat: ChatReadResource): Promise<ChatReadIndex> {
    const key = JSON.stringify([
      chat.id,
      chat.contentHash,
      sourceOf(chat).size,
      'originalSource' in chat ? chat.originalSource.contentIdentity : undefined,
      chat.metadata.format,
      chat.metadata.messageCount,
      chat.metadata.visibleMessageCount,
    ])
    let index = this.cache.indexes.get(chat.id)
    if (index?.key === key) {
      this.cache.indexes.delete(chat.id)
      this.cache.indexes.set(chat.id, index)
      return index
    }
    if (index) await this.evictIndex(chat.id)
    const size = sourceOf(chat).size
    const stored = this.persistentIndexSource(chat)
      ? await this.resources.getChatReadPositionCache?.(chat.id)?.catch(() => undefined)
      : undefined
    const storedIsValid = this.validStoredIndex(
      stored,
      key,
      Number(chat.metadata.messageCount),
      size,
    )
    index = storedIsValid
      ? {
          key: stored.key,
          stride: stored.stride,
          checkpoints: structuredClone(stored.checkpoints),
        }
      : {
          key,
          stride: MIN_INDEX_STRIDE,
          checkpoints: [
            { byteOffset: 0, line: 1, floor: 0, visible: 0, replies: 0, previousReply: null },
          ],
        }
    if (stored && !storedIsValid)
      await this.resources.deleteChatReadPositionCache?.(chat.id)?.catch(() => undefined)
    this.cache.indexes.delete(chat.id)
    this.cache.indexes.set(chat.id, index)
    if (this.cache.indexes.size > MAX_INDEXES)
      await this.evictIndex(this.cache.indexes.keys().next().value!)
    return index
  }

  private checkpointFor(index: ChatReadIndex, floor: number) {
    let low = 0,
      high = index.checkpoints.length
    while (low + 1 < high) {
      const middle = (low + high) >>> 1
      if (index.checkpoints[middle]!.floor <= floor) low = middle
      else high = middle
    }
    return index.checkpoints[low]!
  }

  private rememberFloor(index: ChatReadIndex, value: IndexedEntry, bytes: number) {
    // An older concurrent request must not repopulate a replaced/evicted resource version.
    if (![...this.cache.indexes.values()].includes(index)) return
    const key = index.key + '\n' + value.entry.index
    const old = this.cache.floors.get(key)
    if (old) {
      this.cache.bytes -= old.bytes
      this.cache.floors.delete(key)
    }
    if (bytes > FLOOR_CACHE_BYTES) return
    while (
      this.cache.floors.size &&
      (this.cache.bytes + bytes > FLOOR_CACHE_BYTES || this.cache.floors.size >= FLOOR_CACHE_COUNT)
    ) {
      const oldest = this.cache.floors.keys().next().value!
      this.cache.bytes -= this.cache.floors.get(oldest)!.bytes
      this.cache.floors.delete(oldest)
    }
    this.cache.floors.set(key, { value: structuredClone(value), bytes })
    this.cache.bytes += bytes
  }

  private async *entries(chat: ChatReadResource, offset: number): AsyncGenerator<IndexedEntry> {
    const index = await this.indexFor(chat)
    const before = JSON.stringify([index.stride, index.checkpoints])
    let target = offset
    while (true) {
      const key = index.key + '\n' + target
      const cached = this.cache.floors.get(key)
      if (!cached) break
      this.cache.floors.delete(key)
      this.cache.floors.set(key, cached)
      target++
      yield structuredClone(cached.value)
    }
    if (target >= Number(chat.metadata.messageCount)) return
    const start = this.checkpointFor(index, target)
    let floor = start.floor,
      visible = start.visible,
      replies = start.replies,
      previousReply = start.previousReply
    try {
      for await (const { message, position, chars } of readChatMessageEntries(
        sourceOf(chat),
        String(chat.metadata.format),
        start,
      )) {
        if (position && floor % index.stride === 0) {
          const checkpoint = { ...position, floor, visible, replies, previousReply }
          const at = index.checkpoints.findIndex((item) => item.floor >= floor)
          if (at < 0) index.checkpoints.push(checkpoint)
          else if (index.checkpoints[at]!.floor === floor) index.checkpoints[at] = checkpoint
          else index.checkpoints.splice(at, 0, checkpoint)
          if (index.checkpoints.length > MAX_CHECKPOINTS) {
            index.stride *= 2
            index.checkpoints = index.checkpoints.filter((item) => item.floor % index.stride === 0)
          }
        }
        if (!message.is_system) visible++
        const previous = previousReply
        if (!message.is_user) {
          previousReply = floor
          replies++
        }
        const current = floor++
        if (current < target) continue
        const serialized = JSON.stringify(message)
        const value = {
          entry: {
            index: current,
            depth: message.is_system ? -1 : Number(chat.metadata.visibleMessageCount) - visible,
            message,
          },
          previousReply: previous,
          size: textEncoder.encode(serialized).length,
        }
        // Estimate retained UTF-16 strings with per-entry overhead, without holding a second serialized body.
        this.rememberFloor(index, value, Math.max(chars, serialized.length) * 2 + 512)
        yield value
      }
    } finally {
      if (
        this.persistentIndexSource(chat) &&
        before !== JSON.stringify([index.stride, index.checkpoints])
      ) {
        const cache: ChatReadPositionCache = {
          schemaVersion: 1,
          key: index.key,
          stride: index.stride,
          checkpoints: structuredClone(index.checkpoints),
        }
        await this.resources.setChatReadPositionCache?.(chat.id, cache)?.catch(() => undefined)
      }
    }
  }

  async read(
    id: string,
    offset = 0,
    limit = 20,
    options: { hideUser?: boolean; backward?: boolean } = {},
  ): Promise<ChatReadPage> {
    validateReadRange(offset, limit)
    return this.readResource(await this.getReadChat(id), offset, limit, options)
  }

  /** Reuse one live resource snapshot for the SDK's page, card context and speculative next floor. */
  async readResource(
    chat: ChatReadResource,
    offset = 0,
    limit = 20,
    options: { hideUser?: boolean; backward?: boolean } = {},
  ): Promise<ChatReadPage> {
    validateReadRange(offset, limit)
    if (chat.type !== RESOURCE_TYPE.CHAT) throw new Error('聊天记录不存在')
    const total = Number(chat.metadata.messageCount)
    if (!Number.isSafeInteger(total) || total < 1)
      throw new Error('聊天解析信息缺失，请重新导入原件')
    if (options.hideUser)
      return this.readCharacterReplies(chat, offset, limit, options.backward === true)
    const messages: ChatReadPage['messages'] = []
    let index = Math.min(offset, total),
      bytes = 0
    for await (const { entry, size } of this.entries(chat, offset)) {
      index = entry.index
      // Bound each IPC response, while retaining a complete, valid message rather than truncating it.
      if (size > 4 * 1024 * 1024) throw new Error(`第 ${index + 1} 楼超过单楼读取上限`)
      if (messages.length && bytes + size > 512 * 1024) break
      bytes += size
      messages.push(entry)
      index++
      if (messages.length >= limit) break
    }
    return {
      messages,
      total,
      contentHash: chat.contentHash,
      nextOffset: index < total ? index : null,
    }
  }

  private async readCharacterReplies(
    chat: ChatReadResource,
    offset: number,
    limit: number,
    backward: boolean,
  ): Promise<ChatReadPage> {
    const entries: Array<{ entry: ChatReadPage['messages'][number]; size: number }> = []
    let bytes = 0
    let previousOffset: number | null = null,
      nextOffset: number | null = null
    const index = await this.indexFor(chat)
    let start = Math.min(offset, Number(chat.metadata.messageCount) - 1)
    if (backward) {
      const nearest = this.checkpointFor(index, start)
      // Start before enough character replies to preserve reverse navigation and response byte trimming.
      const budget = nearest.replies - limit - 1
      start = 0
      for (let at = index.checkpoints.length - 1; at >= 0; at--)
        if (index.checkpoints[at]!.replies <= budget) {
          start = index.checkpoints[at]!.floor
          break
        }
    }
    for await (const { entry, previousReply, size } of this.entries(chat, start)) {
      const floor = entry.index
      if (!entries.length) previousOffset = previousReply
      if (entry.message.is_user) continue
      if ((backward && floor > offset) || (!backward && entries.length >= limit)) {
        nextOffset = floor
        break
      }
      if (size > 4 * 1024 * 1024) throw new Error(`第 ${floor + 1} 楼超过单楼读取上限`)
      if (!backward && entries.length && bytes + size > 512 * 1024) {
        nextOffset = floor
        break
      }
      entries.push({ entry, size })
      bytes += size
      while (backward && entries.length > 1 && (entries.length > limit || bytes > 512 * 1024)) {
        const removed = entries.shift()!
        bytes -= removed.size
        previousOffset = removed.entry.index
      }
    }
    // Hiding the final user chapter returns to the last remaining reply, not an empty page.
    if (!entries.length && previousOffset !== null) {
      for await (const { entry, previousReply, size } of this.entries(chat, previousOffset)) {
        if (size > 4 * 1024 * 1024) throw new Error(`第 ${entry.index + 1} 楼超过单楼读取上限`)
        entries.push({ entry, size })
        previousOffset = previousReply
        break
      }
    }
    return {
      messages: entries.map((item) => item.entry),
      previousOffset,
      nextOffset,
      total: Number(chat.metadata.messageCount),
      contentHash: chat.contentHash,
    }
  }

  async search(id: string, query: string, offset = 0) {
    if (!query.trim() || query.length > 200 || !Number.isSafeInteger(offset) || offset < 0)
      throw new Error('搜索参数无效')
    const chat = await this.getReadChat(id)
    const results: Array<{ floor: number; text: string }> = []
    const checkpoint = offset > 0 ? this.checkpointFor(await this.indexFor(chat), offset) : null
    let index = checkpoint?.floor ?? 0
    for await (const { message } of readChatMessageEntries(
      sourceOf(chat),
      String(chat.metadata.format),
      checkpoint ?? undefined,
    )) {
      const floor = index++
      if (floor < offset) continue
      const at = message.mes.indexOf(query)
      if (at >= 0)
        results.push({
          floor,
          text: message.mes.slice(Math.max(0, at - 25), at + query.length + 65),
        })
      if (results.length === 100) break
    }
    return { results, nextOffset: index < Number(chat.metadata.messageCount) ? index : null }
  }

  async chapters(id: string, offset = 0, limit = 50) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50
    )
      throw new Error('章节分页参数无效')
    const chat = await this.getReadChat(id)
    const items = []
    const checkpoint = offset > 0 ? this.checkpointFor(await this.indexFor(chat), offset) : null
    let index = checkpoint?.floor ?? 0
    for await (const { message } of readChatMessageEntries(
      sourceOf(chat),
      String(chat.metadata.format),
      checkpoint ?? undefined,
    )) {
      const floor = index++
      if (floor < offset) continue
      // Excerpts are a bounded plain-text projection, never executed or treated as chapter titles from AI.
      const excerpt = message.mes
        .slice(0, 64 * 1024)
        .replace(/```[\s\S]*?(?:```|$)/g, ' ')
        .replace(
          /<(script|style|thinking|think|details|status_top|status_bottom)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
          ' ',
        )
        .replace(/<[^>]*>/g, ' ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 100)
      items.push({
        floor,
        name: message.name,
        isUser: message.is_user,
        text: excerpt || '状态栏或开场内容',
        replies: Array.isArray(message.swipes) ? message.swipes.length : 1,
      })
      if (items.length >= limit) break
    }
    const total = Number(chat.metadata.messageCount)
    return { items, total, nextOffset: index < total ? index : null, contentHash: chat.contentHash }
  }

  async variableReview(id: string, floor: number, replyOverrides: Record<string, unknown> = {}) {
    if (!Number.isSafeInteger(floor) || floor < 0) throw new Error('变量回顾楼层无效')
    const chat = await this.getReadChat(id)
    const total = Number(chat.metadata.messageCount)
    if (floor >= total) throw new Error('指定楼层不存在')
    const { selectChatReply, savedChatVariables } = await import('./ChatReaderRendering')
    const { compareChatVariables } = await import('./ChatVariableReview')
    let previous: { floor: number; replyId: number; data: Record<string, unknown> } | undefined
    let index = 0
    for await (const message of readChatMessages(sourceOf(chat), String(chat.metadata.format))) {
      const entry = selectChatReply({ index, depth: 0, message }, replyOverrides[String(index)])
      const data = savedChatVariables(entry)
      const replyId = Number.isSafeInteger(entry.message.swipe_id)
        ? Number(entry.message.swipe_id)
        : 0
      if (index === floor) {
        const comparison = data && previous ? compareChatVariables(previous.data, data) : null
        return {
          floor,
          replyId,
          total,
          contentHash: chat.contentHash,
          status: !data
            ? 'missing'
            : !previous
              ? 'initial'
              : comparison?.incompatible
                ? 'incompatible'
                : 'compared',
          baseline: previous ? { floor: previous.floor, replyId: previous.replyId } : null,
          missingFloors: previous ? floor - previous.floor - 1 : floor,
          kind: comparison?.kind,
          changes: comparison?.changes || [],
          truncated: comparison?.truncated || false,
        }
      }
      if (data) previous = { floor: index, replyId, data }
      index++
    }
    throw new Error('指定楼层不存在')
  }

  async bind(id: string, characterId: string): Promise<void> {
    const chat = await this.getChat(id)
    const character = await this.resources.get(characterId)
    if (!character || character.type !== RESOURCE_TYPE.CHARACTER_CARD)
      throw new Error('请选择有效的角色卡')
    const summaries = await this.resources.listResourceListSummaries()
    const characterIds = new Set(
      summaries.filter((r) => r.type === RESOURCE_TYPE.CHARACTER_CARD).map((r) => r.id),
    )
    await this.resources.updateDetails(chat, {
      name: chat.name,
      description: chat.description,
      type: chat.type,
      categoryIds: chat.categoryIds ?? (chat.categoryId ? [chat.categoryId] : []),
      relatedResourceIds: [
        ...getRelatedResourceIds(chat).filter((id) => !characterIds.has(id)),
        characterId,
      ],
      tags: chat.tags,
      sourceLinks: chat.sourceLinks,
    })
  }
}
