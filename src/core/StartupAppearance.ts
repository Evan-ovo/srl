import { recoverInterruptedAppearance } from './AppearanceSafetyStorage'
import { isSafeModeActive } from './SafeStartup'
import {
  CUSTOM_UI_STYLE_ID,
  readStoredCustomUiCss,
  writeStoredCustomUiCss,
  storedAppearanceAllowsRemoteResources,
} from '../services/BrowserAppearancePreferences'
import { sanitizeCssForPreview } from '../utils/PreviewSafety'

/** Read the existing applied CSS, never a second startup preset/cache. */
export function applyStartupAppearance(): void {
  const previous = recoverInterruptedAppearance()
  if (previous !== undefined) writeStoredCustomUiCss(previous)
  const theme = (() => {
    try {
      return localStorage.getItem('srl-theme')
    } catch {
      return null
    }
  })()
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme
  const css = isSafeModeActive() ? '' : readStoredCustomUiCss()
  let style = document.getElementById(CUSTOM_UI_STYLE_ID) as HTMLStyleElement | null
  if (!style && !css) return
  if (!style) {
    style = document.createElement('style')
    style.id = CUSTOM_UI_STYLE_ID
  }
  style.textContent = sanitizeCssForPreview(css, {
    allowExternalResources: storedAppearanceAllowsRemoteResources(),
    allowLocalResources: true,
    preserveLength: true,
  })
  document.head.append(style)
}

/** Keep startup CSS after the dynamically loaded application stylesheets. */
export function placeStartupAppearanceAfterApplicationStyles(): void {
  const style = document.getElementById(CUSTOM_UI_STYLE_ID)
  if (style) document.head.append(style)
}
