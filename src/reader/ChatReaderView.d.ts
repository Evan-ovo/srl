import type { ChatReaderHostApi } from '../services/ChatReaderHostService'
export function mountChatReader(
  root: ShadowRoot,
  api: ChatReaderHostApi,
): {
  appearance(css: string): void
  ready: Promise<void>
  action(action: 'back' | 'search' | 'cover'): void
  dispose(): Promise<void>
}
