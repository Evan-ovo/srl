import { App } from '@capacitor/app'
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'

import { normalizeDiscordHandoffRequest } from '../services/DiscordHandoffService'
import { noticeCenter } from './NoticeCenter'
import {
  checkNativeDiscordInboxTarget,
  publishNativeDiscordInboxState,
  readNativeDiscordInboxState,
} from '../services/NativeDiscordInboxService'

interface NativeShortcutApi {
  takePending(): Promise<{ action?: string }>
  addListener(
    eventName: 'shortcut',
    listener: (event: { action?: string }) => void,
  ): Promise<PluginListenerHandle>
}

interface NativeShareReceiverApi {
  addListener(
    eventName: 'autoBindingsCommitted',
    listener: (event: {
      bindings: Array<{
        sourceId?: string
        resourceId?: string
        sourceTitle?: string
        resourceName?: string
      }>
    }) => void,
  ): Promise<PluginListenerHandle>
  resumeDeferredDiscordImports(): Promise<{ resumed: number }>
  addListener(
    eventName: 'cloudInboxReady',
    listener: (event: { running: boolean; postsSaved?: boolean }) => void,
  ): Promise<PluginListenerHandle>
  addListener(
    eventName: 'discordDownloadStarted',
    listener: (event: { token: string; workId?: string; name?: string; cloud?: boolean }) => void,
  ): Promise<PluginListenerHandle>
  addListener(eventName: 'ready', listener: () => void): Promise<PluginListenerHandle>
  addListener(
    eventName: 'discordDownloadFailed',
    listener: (event: { token: string; workId?: string; cloud?: boolean }) => void,
  ): Promise<PluginListenerHandle>
  addListener(
    eventName: 'discordDownloadCompleted',
    listener: (event: { token: string; workId?: string; cloud?: boolean }) => void,
  ): Promise<PluginListenerHandle>
}

export type NativeDeepLink =
  | { kind: 'resource'; resourceId: string }
  | { kind: 'backup' }
  | { kind: 'restore' }
  | { kind: 'favorites' }
  | { kind: 'import' }
  | { kind: 'sharedImport'; token: string }
  | { kind: 'inbox' }
  | { kind: 'assistant' }
  | { kind: 'discordSource'; workerUrl: string; token: string }

const NativeShortcut = registerPlugin<NativeShortcutApi>('NativeShortcut')
const NativeShareReceiver = registerPlugin<NativeShareReceiverApi>('ShareReceiver')
let deferredDiscordImportResume: Promise<void> | undefined

function resumeDeferredDiscordImports(): void {
  if (Capacitor.getPlatform() !== 'android' || deferredDiscordImportResume) return
  deferredDiscordImportResume = NativeShareReceiver.resumeDeferredDiscordImports()
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => {
      deferredDiscordImportResume = undefined
    })
}

/** 深链只引用本机资源 ID，绝不编码资源内容、账号或云端凭据。 */
export function createNativeResourceDeepLink(resourceId: string): string | null {
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(resourceId)) return null
  return `srl://resource/${resourceId}`
}

function publishDeepLink(link: NativeDeepLink): void {
  sessionStorage.setItem('srl.native.deep-link', JSON.stringify(link))
  window.dispatchEvent(new CustomEvent<NativeDeepLink>('srl:native-deep-link', { detail: link }))
}

function publishShortcut(url?: string): void {
  if (!url) return
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'srl:') return
    if (parsed.hostname === 'resource') {
      const resourceId = parsed.pathname.replace(/^\/+/, '')
      if (/^[A-Za-z0-9._-]{1,160}$/.test(resourceId))
        publishDeepLink({ kind: 'resource', resourceId })
      return
    }
    if (parsed.hostname === 'discord-source') {
      const handoff = normalizeDiscordHandoffRequest({
        workerUrl: parsed.searchParams.get('worker') ?? '',
        token: parsed.searchParams.get('token') ?? '',
      })
      if (handoff) publishDeepLink({ kind: 'discordSource', ...handoff })
      return
    }
    if (parsed.hostname === 'backup') {
      publishShortcutAction('cloud')
      return
    }
    if (parsed.hostname === 'restore') {
      publishDeepLink({ kind: 'restore' })
      return
    }
    if (parsed.hostname === 'inbox') {
      publishDeepLink({ kind: 'inbox' })
      return
    }
    if (parsed.hostname === 'shared-import') {
      const token = parsed.pathname.slice(1)
      if (/^discord-url-[a-f0-9-]{36}$/u.test(token))
        publishDeepLink({ kind: 'sharedImport', token })
      return
    }
    if (parsed.hostname !== 'shortcut') return
    const action = parsed.pathname.replace(/^\/+/, '')
    if (!['import', 'cloud', 'favorites'].includes(action)) return
    sessionStorage.setItem('srl.native.shortcut', action)
    window.dispatchEvent(new CustomEvent('srl:native-shortcut', { detail: action }))
    if (action === 'cloud') publishDeepLink({ kind: 'backup' })
    else if (action === 'import') publishDeepLink({ kind: 'import' })
    else publishDeepLink({ kind: 'favorites' })
  } catch {
    // 非 SRL 深链交给其他注册逻辑处理。
  }
}

function publishShortcutAction(action?: string): void {
  if (!action || !['import', 'cloud', 'favorites'].includes(action)) return
  sessionStorage.setItem('srl.native.shortcut', action)
  window.dispatchEvent(new CustomEvent('srl:native-shortcut', { detail: action }))
  if (action === 'cloud') publishDeepLink({ kind: 'backup' })
  else if (action === 'import') publishDeepLink({ kind: 'import' })
  else publishDeepLink({ kind: 'favorites' })
}

async function installNativeShortcutListener(): Promise<void> {
  await NativeShortcut.addListener('shortcut', ({ action }) => {
    publishShortcutAction(action)
    void NativeShortcut.takePending()
  })
  const { action } = await NativeShortcut.takePending()
  publishShortcutAction(action)
}

async function installNativeShareListener(): Promise<void> {
  await NativeShareReceiver.addListener('autoBindingsCommitted', ({ bindings }) => {
    if (!Array.isArray(bindings)) return
    for (const binding of bindings) {
      if (!binding.sourceId || !binding.resourceId) continue
      noticeCenter.push({
        id: `discord-auto-binding:${binding.sourceId}:${binding.resourceId}`,
        type: 'success',
        persistent: true,
        message: `帖子“${binding.sourceTitle || '未命名帖子'}”已绑定角色卡“${binding.resourceName || '未命名角色卡'}”`,
      })
    }
    window.dispatchEvent(new Event('srl:community-sources-changed'))
  })
  window.addEventListener('srl:discord-inbox-target-changed', (event) => {
    const detail = (event as CustomEvent<{ workerUrl: string; libraryId: string }>).detail
    checkNativeDiscordInboxTarget(detail.workerUrl, detail.libraryId)
  })
  await NativeShareReceiver.addListener('cloudInboxReady', ({ running, postsSaved }) => {
    publishNativeDiscordInboxState(running === true)
    if (running) window.dispatchEvent(new Event('srl:receive-discord-inbox'))
    if (postsSaved) window.dispatchEvent(new Event('srl:community-sources-changed'))
  })
  await readNativeDiscordInboxState().catch(() => false)
  await NativeShareReceiver.addListener('discordDownloadStarted', (detail) => {
    window.dispatchEvent(new CustomEvent('srl:native-share-download-started', { detail }))
  })
  await NativeShareReceiver.addListener('ready', () => {
    window.dispatchEvent(new Event('srl:native-share'))
  })
  await NativeShareReceiver.addListener('discordDownloadFailed', (detail) => {
    window.dispatchEvent(new CustomEvent('srl:native-share-download-failed', { detail }))
  })
  await NativeShareReceiver.addListener('discordDownloadCompleted', (detail) => {
    window.dispatchEvent(new CustomEvent('srl:native-share-download-completed', { detail }))
    // The worker emits this after persisting a migration-gated result but before WorkManager
    // leaves RUNNING. Native resume appends one follow-up behind that job when necessary.
    resumeDeferredDiscordImports()
  })
  resumeDeferredDiscordImports()
}

export function installNativeRuntime(): void {
  if (!Capacitor.isNativePlatform()) return
  document.documentElement.dataset.nativePlatform = Capacitor.getPlatform()

  // Android 硬件返回由 MainActivity 发出 srl:back-request，和 Web Escape/Browser Back
  // 共用同一个 BackStack；这里不再另走 DOM 探测与 history/minimize 分支。
  void App.addListener('appStateChange', ({ isActive }) => {
    if (isActive) {
      window.dispatchEvent(new Event('srl:native-share'))
      window.dispatchEvent(new Event('srl:native-active'))
      resumeDeferredDiscordImports()
    }
  })
  void App.addListener('appUrlOpen', ({ url }) => publishShortcut(url))
  // 必须先完成监听注册再清空启动期间的待办，否则冷启动和快捷方式到达相邻时会漏动作。
  void installNativeShortcutListener()
  void installNativeShareListener()
  const getLaunchUrl = (App as typeof App & { getLaunchUrl?: typeof App.getLaunchUrl }).getLaunchUrl
  if (getLaunchUrl) void getLaunchUrl.call(App).then((launch) => publishShortcut(launch?.url))
}
