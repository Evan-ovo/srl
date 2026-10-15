import { Capacitor, registerPlugin } from '@capacitor/core'
import { requestNativeNotifications } from '../core/NativeSecurity'
import { inboxConnection } from './DiscordHandoffService'
import {
  notifyWebDiscordAutoBinding,
  notifyWebDiscordInboxResult,
} from './WebDiscordInboxNotifications'

interface DiscordInboxResultBase {
  id: string
  workerUrl: string
  libraryId: string
  name: string
}
export type DiscordInboxResult =
  | (DiscordInboxResultBase & {
      kind: 'resource'
      state: 'imported' | 'duplicate' | 'waiting_version' | 'cancelled' | 'failed'
    })
  | (DiscordInboxResultBase & {
      kind: 'post'
      state: 'saved' | 'waiting_binding' | 'failed'
      messageKey?: string
    })

interface Receiver {
  notifyCloudInboxAutoBinding(options: {
    sourceTitle: string
    resourceName: string
    sourceId?: string
    resourceId?: string
  }): Promise<void>
  notifyCloudInboxResult(options: DiscordInboxResult): Promise<void>
  startCloudInbox(options: {
    workerUrl: string
    libraryId: string
    secret: string
  }): Promise<{ running: boolean; reason?: string }>
  stopCloudInbox(): Promise<void>
  cloudInboxStatus(): Promise<{ running: boolean; workerUrl?: string; libraryId?: string }>
}
const receiver = registerPlugin<Receiver>('ShareReceiver')
/** Foreground save-time and manual-version binding commits also need a system result. */
export async function notifyNativeDiscordAutoBinding(
  sourceTitle: string,
  resourceName: string,
  identity?: { sourceId: string; resourceId: string },
): Promise<void> {
  if (!isNativeDiscordInboxAvailable()) {
    if (!Capacitor.isNativePlatform())
      await notifyWebDiscordAutoBinding(sourceTitle, resourceName, identity)
    return
  }
  try {
    await receiver.notifyCloudInboxAutoBinding({ sourceTitle, resourceName, ...identity })
  } catch {
    // A denied notification or older APK must not undo the saved binding.
  }
}
let running = false
let target: { workerUrl: string; libraryId: string } | undefined
export const isNativeDiscordInboxAvailable = () =>
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
export const isNativeDiscordInboxRunning = () => running
export function publishNativeDiscordInboxState(value: boolean): void {
  running = value
  window.dispatchEvent(new CustomEvent('srl:cloud-inbox-state', { detail: { running } }))
}
export async function readNativeDiscordInboxState(): Promise<boolean> {
  if (!isNativeDiscordInboxAvailable()) return false
  const state = await receiver.cloudInboxStatus()
  target =
    state.running && state.workerUrl && state.libraryId
      ? { workerUrl: state.workerUrl, libraryId: state.libraryId }
      : undefined
  publishNativeDiscordInboxState(state.running === true)
  return running
}
export async function startNativeDiscordInbox(): Promise<void> {
  if (!isNativeDiscordInboxAvailable()) throw new Error('收件模式仅支持新版安卓 APK')
  const connection = inboxConnection()
  if (!(await requestNativeNotifications())) throw new Error('请先允许系统通知，再开启收件模式。')
  // Recheck after the permission dialog, which may outlive a target change.
  const current = inboxConnection()
  if (
    current.workerUrl !== connection.workerUrl ||
    current.libraryId !== connection.libraryId ||
    current.secret !== connection.secret
  )
    throw new Error('配对已改变，请重新开启收件模式。')
  let result: { running: boolean; reason?: string }
  try {
    result = await receiver.startCloudInbox(connection)
  } catch {
    throw new Error('无法开启收件模式，请更新 APK 并检查配对。')
  }
  if (!result || typeof result.running !== 'boolean') {
    await stopNativeDiscordInbox()
    throw new Error('当前 APK 无法确认后台服务启动，请更新 APK。')
  }
  if (!result.running) {
    publishNativeDiscordInboxState(false)
    const reason =
      typeof result.reason === 'string' && /^[A-Za-z][A-Za-z0-9_$]{0,79}$/u.test(result.reason)
        ? `（${result.reason}）`
        : ''
    throw new Error(`后台收件服务未能启动${reason}，请检查配对和系统后台运行限制。`)
  }
  const confirmed = await receiver.cloudInboxStatus()
  if (
    !confirmed.running ||
    confirmed.workerUrl !== connection.workerUrl ||
    confirmed.libraryId !== connection.libraryId
  ) {
    publishNativeDiscordInboxState(false)
    throw new Error('后台收件服务已停止或目标已改变，请重新开启。')
  }
  target = { workerUrl: connection.workerUrl, libraryId: connection.libraryId }
  publishNativeDiscordInboxState(true)
}
export async function stopNativeDiscordInbox(): Promise<void> {
  if (isNativeDiscordInboxAvailable()) await receiver.stopCloudInbox()
  publishNativeDiscordInboxState(false)
  target = undefined
}
export function checkNativeDiscordInboxTarget(workerUrl: string, libraryId: string): void {
  if (running && (!target || target.workerUrl !== workerUrl || target.libraryId !== libraryId))
    void stopNativeDiscordInbox().catch(() => undefined)
}

/** Only the local commit/decision owner can report a completed receive operation. */
export async function notifyNativeDiscordInboxResult(result: DiscordInboxResult): Promise<void> {
  if (!isNativeDiscordInboxAvailable()) {
    if (!Capacitor.isNativePlatform()) await notifyWebDiscordInboxResult(result)
    return
  }
  try {
    const { id, workerUrl, libraryId, name } = result
    const base = { id, workerUrl, libraryId, name }
    await receiver.notifyCloudInboxResult(
      result.kind === 'resource'
        ? { ...base, kind: 'resource', state: result.state }
        : {
            ...base,
            kind: 'post',
            state: result.state,
            ...(result.messageKey ? { messageKey: result.messageKey } : {}),
          },
    )
  } catch {
    // Notification permission or an older APK must not change the persisted result.
  }
}
