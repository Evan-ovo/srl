/** Existing preferences, shared by the early bootstrap and BrowserStorageService. */
export const CUSTOM_UI_CSS_KEY = 'srl.ui.customCss'
export const CUSTOM_UI_STYLE_ID = 'srl-custom-ui-style'
export const PREVIEW_REMOTE_RESOURCES_KEY = 'srl.preview.allowRemoteResources'
export const PREVIEW_SCRIPTS_KEY = 'srl.preview.allowScripts'
const PALETTE_DRAFT_KEY = 'srl.ui.paletteDraft'

/** Local working progress, separate from applied CSS and portable saved presets. */
export function readPaletteDraft(): Record<string, unknown> | undefined {
  try {
    const raw = localStorage.getItem(PALETTE_DRAFT_KEY)
    if (!raw || raw.length > 64 * 1024) return
    const value: unknown = JSON.parse(raw)
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value as Record<string, unknown>
  } catch {
    // Invalid working progress never blocks the appearance editor.
  }
}

export function writePaletteDraft(value: Record<string, unknown>): void {
  const serialized = JSON.stringify(value)
  localStorage.setItem(PALETTE_DRAFT_KEY, serialized)
  if (localStorage.getItem(PALETTE_DRAFT_KEY) !== serialized)
    throw new Error('调色草稿未保存成功，请检查本机存储空间')
}
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
