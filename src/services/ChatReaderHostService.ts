import { ChatReaderContentService } from './ChatReaderContentService'
import { toSnapshot } from './ResourceSnapshot'
import type { ResourceService } from './ResourceService'
import type { ExternalAppService } from './ExternalAppService'
import type { ResourceType } from '../types/Resource'

export interface ChatReaderNavigation {
  page: 'roles' | 'chats' | 'reader'
  cover: boolean
  colors: Record<string, string>
}
export interface ChatReaderHostUi {
  navigation(value: ChatReaderNavigation): void
  ready(): void
  exit(): void
  shareText(name: string, text: string): Promise<void>
  appearance(): Promise<string>
}
/** Native UI calls existing services directly. Author script windows never receive this object. */
export function createChatReaderHost(
  resources: ResourceService,
  data: ExternalAppService,
  ui: ChatReaderHostUi,
  options: { thumbnailConcurrency?: number } = {},
) {
  const content = new ChatReaderContentService(resources)
  const concurrency = options.thumbnailConcurrency ?? 4
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)
    throw new Error('头像读取并发参数无效')
  let closed = false,
    active = 0
  const waiting: Array<(admitted: boolean) => void> = []
  async function thumbnail(id: unknown) {
    if (closed) return null
    const admitted =
      active >= concurrency
        ? await new Promise<boolean>((resolve) => waiting.push(resolve))
        : (active++, true)
    if (!admitted) return null
    if (closed) {
      active--
      return null
    }
    try {
      return await content.thumbnail(id)
    } finally {
      const next = waiting.shift()
      if (next && !closed) next(true)
      else active--
    }
  }
  return {
    dispose() {
      closed = true
      for (const resolve of waiting.splice(0)) resolve(false)
    },
    capabilities: async () => ({
      runtime: { builtinReader: true, network: true, readerUiCss: await ui.appearance() },
    }),
    storage: {
      get: async (key: string) => (await data.readReaderData([key]))[key],
      getMany: (keys: string[]) => data.readReaderData(keys),
      set: (key: string, value: unknown) => data.writeReaderData(key, value),
    },
    resources: {
      async summaries(types: ResourceType[], ids?: string[]) {
        return (await resources.listResourceListSummaries({ types, ids })).map((item) =>
          toSnapshot(item),
        )
      },
      async directory() {
        const chats = await resources.listResourceListSummaries({ types: ['chat'] })
        const ids = [...new Set(chats.flatMap((chat) => chat.relatedResourceIds ?? []))]
        const characters = ids.length
          ? await resources.listResourceListSummaries({ types: ['characterCard'], ids })
          : []
        return {
          chats: chats.map((item) => toSnapshot(item)),
          characters: characters.map((item) => toSnapshot(item)),
        }
      },
      async list(options: {
        types: ResourceType[]
        ids?: string[]
        offset?: number
        limit?: number
      }) {
        const rows = await resources.listResourceListSummaries({
          types: options.types,
          ids: options.ids,
        })
        const offset = options.offset ?? 0,
          limit = options.limit ?? 50
        const items = rows.slice(offset, offset + limit).map((item) => toSnapshot(item))
        return {
          items,
          total: rows.length,
          nextOffset: offset + items.length < rows.length ? offset + items.length : null,
        }
      },
      readChat: content.readChat.bind(content),
      searchChat: content.searchChat.bind(content),
      chatChapters: content.chatChapters.bind(content),
      chatVariables: content.chatVariables.bind(content),
      thumbnail,
      readerStyle: (id: string, options: Record<string, unknown> = {}) =>
        content.readerStyle({ ...options, id }),
      bindChat: (id: string, characterId: string) => content.bindChat({ id, characterId }),
    },
    files: { shareText: ui.shareText },
    ui: {
      setReaderNavigation: async (value: ChatReaderNavigation) => ui.navigation(value),
      setLoading: async () => ui.ready(),
      exitFullscreen: async () => ui.exit(),
    },
  }
}
export type ChatReaderHostApi = ReturnType<typeof createChatReaderHost>
