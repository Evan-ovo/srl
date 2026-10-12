import { onBeforeUnmount, onMounted, ref } from 'vue'
import { BrowserStorageService } from '../services/BrowserStorageService'
import { CUSTOM_UI_VIEWS_CHANGED, CUSTOM_UI_VIEWS_KEY } from '../types/UiCustomization'
import { isSafeModeActive } from '../core/SafeStartup'

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
