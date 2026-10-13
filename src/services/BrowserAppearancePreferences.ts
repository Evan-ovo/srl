/** Existing preferences, shared by the early bootstrap and BrowserStorageService. */
export const CUSTOM_UI_CSS_KEY = 'srl.ui.customCss'
export const CUSTOM_UI_STYLE_ID = 'srl-custom-ui-style'
export const PREVIEW_REMOTE_RESOURCES_KEY = 'srl.preview.allowRemoteResources'
export const PREVIEW_SCRIPTS_KEY = 'srl.preview.allowScripts'
export function readStoredCustomUiCss(): string {
  try {
    return localStorage.getItem(CUSTOM_UI_CSS_KEY) ?? ''
  } catch {
    return ''
  }
}
export function writeStoredCustomUiCss(value: string): void {
  try {
    localStorage.setItem(CUSTOM_UI_CSS_KEY, value)
  } catch {
    /* Current-session CSS still works. */
  }
}
export function storedAppearanceAllowsRemoteResources(): boolean {
  try {
    return (
      localStorage.getItem(PREVIEW_SCRIPTS_KEY) === 'true' ||
      localStorage.getItem(PREVIEW_REMOTE_RESOURCES_KEY) === 'true'
    )
  } catch {
    return false
  }
}
