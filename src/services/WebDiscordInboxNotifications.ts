import type { DiscordInboxResult } from './NativeDiscordInboxService'
import { noticeCenter } from '../core/NoticeCenter'

const delivered = new Set<string>()
export function webInboxNotificationStatus(): 'unsupported' | NotificationPermission {
  return typeof Notification === 'undefined' || !('serviceWorker' in navigator)
    ? 'unsupported'
    : Notification.permission
}
/** Permission is requested only by the dedicated user-click control. */
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
): Promise<void> {
  if (delivered.has(key)) return
  if (applicationNotice)
    noticeCenter.push({
      id: key,
      type: 'info',
      persistent: true,
      message: `${title}：${body}`,
      actions: [
        {
          label: '查看收件箱',
          run: () => {
            window.dispatchEvent(
              new CustomEvent('srl:native-deep-link', { detail: { kind: 'inbox' } }),
            )
          },
        },
      ],
    })
  if (webInboxNotificationStatus() !== 'granted') return
  try {
    // getRegistration does not wait forever when no service worker has been installed.
    const registration = await navigator.serviceWorker.getRegistration()
    if (!registration?.active) return
    await registration.showNotification(title, {
      body,
      tag: key,
      icon: '/icons/srl-icon-192.png',
      data: { srlInbox: true },
    })
    delivered.add(key)
    if (delivered.size > 256) delivered.delete(delivered.values().next().value!)
  } catch {
    // Delivery failure cannot change a verified import/binding result.
  }
}

export async function notifyWebDiscordInboxResult(result: DiscordInboxResult): Promise<void> {
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
  await notify(key, message, result.name)
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
  const open = () =>
    window.dispatchEvent(new CustomEvent('srl:native-deep-link', { detail: { kind: 'inbox' } }))
  const message = (event: MessageEvent) => {
    if (event.data?.type === 'srl:open-inbox') open()
  }
  navigator.serviceWorker?.addEventListener('message', message)
  const url = new URL(window.location.href)
  if (url.searchParams.get('open-inbox') === '1') {
    url.searchParams.delete('open-inbox')
    history.replaceState(history.state, '', url)
    queueMicrotask(open)
  }
  return () => navigator.serviceWorker?.removeEventListener('message', message)
}
