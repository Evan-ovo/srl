import type { DiscordInboxResult } from './NativeDiscordInboxService'
import { noticeCenter } from '../core/NoticeCenter'

const delivered = new Map<string, { application: boolean; system: boolean }>()
export function webInboxNotificationStatus(): 'unsupported' | NotificationPermission {
  return typeof Notification === 'undefined' || !('serviceWorker' in navigator)
    ? 'unsupported'
    : Notification.permission
}
/** Shared web system-notification permission; inbox and backup request it only on user clicks. */
export async function enableWebInboxNotifications(): Promise<NotificationPermission> {
  if (webInboxNotificationStatus() === 'unsupported')
    throw new Error('此浏览器没有系统通知入口；iPhone/iPad 请添加到主屏幕后打开 PWA。')
  return Notification.requestPermission()
}

async function notify(
  key: string,
  title: string,
  body: string,
  applicationNotice = true,
  completed = false,
  destination: 'inbox' | 'backup' = 'inbox',
  noticeId = key,
): Promise<void> {
  let delivery = delivered.get(key)
  if (!delivery) {
    delivery = { application: false, system: false }
    delivered.set(key, delivery)
    if (delivered.size > 256) delivered.delete(delivered.keys().next().value!)
  }
  if (applicationNotice && !delivery.application) {
    delivery.application = true
    noticeCenter.push({
      id: noticeId,
      type: 'info',
      persistent: true,
      completed,
      message: `${title}：${body}`,
      actions: [
        {
          label: destination === 'backup' ? '查看云备份' : '查看收件箱',
          run: () => {
            window.dispatchEvent(
              new CustomEvent('srl:native-deep-link', { detail: { kind: destination } }),
            )
          },
        },
      ],
    })
  }
  if (delivery.system || webInboxNotificationStatus() !== 'granted') return
  try {
    // getRegistration does not wait forever when no service worker has been installed.
    const registration = await navigator.serviceWorker.getRegistration()
    if (!registration?.active) return
    await registration.showNotification(title, {
      body,
      tag: key,
      icon: '/icons/srl-icon-192.png',
      data: destination === 'backup' ? { srlBackup: true } : { srlInbox: true },
    })
    delivery.system = true
  } catch {
    // Delivery failure cannot change a verified import/binding result.
  }
}

/** The backup owner calls this only after final commit, never for an uploaded part. */
export async function notifyWebCloudBackupResult(
  operationId: string,
  message: string,
  success: boolean,
): Promise<void> {
  await notify(
    `cloud-backup:${operationId}:${success}`,
    success ? '云备份完成' : '云备份未完成',
    message,
    false,
    success,
    'backup',
  )
}

export async function notifyWebDiscordInboxResult(result: DiscordInboxResult): Promise<void> {
  const noticeId = `discord-inbox:${JSON.stringify([result.workerUrl, result.libraryId, result.kind, result.id])}`
  const key = `discord-inbox:${JSON.stringify([result.workerUrl, result.libraryId, result.kind, result.id, result.state])}`
  const message =
    result.kind === 'resource'
      ? {
          imported: '解析成功并已导入',
          duplicate: '已在资源库中，无需重复导入',
          waiting_version: '等待确认历史版本',
          cancelled: '已取消，已保存内容保留',
          failed: '下载或解析未完成，请查看原因',
        }[result.state]
      : {
          saved: '保存成功，已整理',
          waiting_binding: '保存成功，待整理',
          failed: '帖子保存未完成，请查看原因',
        }[result.state]
  const completed =
    result.kind === 'resource'
      ? result.state === 'imported' || result.state === 'duplicate'
      : result.state === 'saved'
  await notify(key, message, result.name, true, completed, 'inbox', noticeId)
}
export async function notifyWebDiscordAutoBinding(
  sourceTitle: string,
  resourceName: string,
  identity?: { sourceId: string; resourceId: string },
): Promise<void> {
  const key = `discord-binding:${JSON.stringify(identity ? [identity.sourceId, identity.resourceId] : [sourceTitle, resourceName])}`
  await notify(key, '帖子自动绑定成功', `“${sourceTitle}”已绑定“${resourceName}”`, false)
}

export function installWebInboxNotificationNavigation(): () => void {
  const open = (kind: 'inbox' | 'backup') =>
    window.dispatchEvent(new CustomEvent('srl:native-deep-link', { detail: { kind } }))
  const message = (event: MessageEvent) => {
    if (event.data?.type === 'srl:open-inbox') open('inbox')
    if (event.data?.type === 'srl:open-backup') open('backup')
  }
  navigator.serviceWorker?.addEventListener('message', message)
  const url = new URL(window.location.href)
  const kind =
    url.searchParams.get('open-backup') === '1'
      ? 'backup'
      : url.searchParams.get('open-inbox') === '1'
        ? 'inbox'
        : undefined
  if (kind) {
    url.searchParams.delete(`open-${kind}`)
    history.replaceState(history.state, '', url)
    queueMicrotask(() => open(kind))
  }
  return () => navigator.serviceWorker?.removeEventListener('message', message)
}
