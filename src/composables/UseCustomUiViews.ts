import { onBeforeUnmount, onMounted, ref } from 'vue'
import { BrowserStorageService } from '../services/BrowserStorageService'
import { CUSTOM_UI_VIEWS_CHANGED, CUSTOM_UI_VIEWS_KEY } from '../types/UiCustomization'
import { isSafeModeActive } from '../core/SafeStartup'
import type { CustomUiViews } from '../types/UiCustomization'
import { confirmAction } from './UseConfirmDialog'

/** One consent owner for editing, local imports and Resource Plaza appearance trials. */
export async function confirmViewScripts(
  views?: CustomUiViews,
  signal?: AbortSignal,
  importedName?: string,
): Promise<boolean> {
  const enabled = Object.entries(views ?? {}).filter(([, view]) => view?.enabled)
  if (!enabled.length) return true
  const storage = new BrowserStorageService()
  const current = storage.getCustomUiViews()
  if (
    importedName === undefined &&
    enabled.every(
      ([key, view]) => JSON.stringify(current[key as keyof CustomUiViews]) === JSON.stringify(view),
    )
  )
    return true
  return confirmAction(
    {
      title: importedName === undefined ? '应用自定义界面' : '检测到 Vue 自定义界面',
      message: `${importedName === undefined ? '' : `「${importedName}」包含 Vue 源码，是否同时启用？仅应用 CSS 会保留源码但不运行。`}将运行 ${enabled.length} 个界面的自定义源码。脚本可读取这些页面当前显示的非敏感内容，并调用原有界面操作；不提供数据库或凭据访问。${!isSafeModeActive() && storage.getPreviewPolicy().allowRemoteResources ? '已允许 HTTPS 网络，源码可以发送它读取的界面内容。' : '网络访问关闭。'}可在保护提示中撤销，或长按界面2秒显示“恢复原界面”；3秒内连点悬浮蒜惹菈5下可打开外观快捷切换，选择预设库预设、关闭Vue或恢复默认预设。`,
      confirmLabel: importedName === undefined ? '运行并试用' : '启用并试用',
      ...(importedName === undefined ? {} : { cancelLabel: '仅应用 CSS' }),
      centered: true,
      danger: true,
    },
    signal,
  )
}

export function useCustomUiViews() {
  const storage = new BrowserStorageService()
  const views = ref(storage.getCustomUiViews())
  const refresh = () => {
    views.value = isSafeModeActive() ? {} : storage.getCustomUiViews()
  }
  const syncStorage = (event: StorageEvent) => {
    if (event.key === CUSTOM_UI_VIEWS_KEY) refresh()
  }
  refresh()
  onMounted(() => {
    window.addEventListener(CUSTOM_UI_VIEWS_CHANGED, refresh)
    window.addEventListener('storage', syncStorage)
  })
  onBeforeUnmount(() => {
    window.removeEventListener(CUSTOM_UI_VIEWS_CHANGED, refresh)
    window.removeEventListener('storage', syncStorage)
  })
  return views
}
