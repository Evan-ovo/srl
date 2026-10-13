export const PENDING_APPEARANCE_KEY = 'srl.appearance.pending.v1'
export const LAST_GOOD_APPEARANCE_KEY = 'srl.appearance.lastGood.v1'
import { CUSTOM_UI_VIEWS_KEY, CUSTOM_UI_VIEWS_CHANGED } from '../types/UiCustomization'

export interface PendingAppearance {
  previousCss: string
  nextCss: string
  expiresAt: number
  previousViews?: string
}

function parsePendingAppearance(): PendingAppearance | null {
  try {
    const value = JSON.parse(localStorage.getItem(PENDING_APPEARANCE_KEY) ?? 'null') as unknown
    if (
      value &&
      typeof value === 'object' &&
      typeof (value as PendingAppearance).previousCss === 'string' &&
      typeof (value as PendingAppearance).nextCss === 'string' &&
      Number.isFinite((value as PendingAppearance).expiresAt)
    ) {
      return value as PendingAppearance
    }
  } catch {
    // Corrupt safety metadata is discarded below.
  }
  try {
    localStorage.removeItem(PENDING_APPEARANCE_KEY)
  } catch {
    /* No metadata is needed for normal appearance. */
  }
  return null
}

export function recoverInterruptedAppearance(): string | undefined {
  const pending = parsePendingAppearance()
  if (!pending) return undefined
  try {
    localStorage.removeItem(PENDING_APPEARANCE_KEY)
    localStorage.setItem(LAST_GOOD_APPEARANCE_KEY, pending.previousCss)
    if (typeof pending.previousViews === 'string')
      localStorage.setItem(CUSTOM_UI_VIEWS_KEY, pending.previousViews)
    window.dispatchEvent(new Event(CUSTOM_UI_VIEWS_CHANGED))
  } catch {
    /* Still render the previous CSS if diagnostic storage is unavailable. */
  }
  return pending.previousCss
}

export function readLastGoodAppearance(): string {
  try {
    return localStorage.getItem(LAST_GOOD_APPEARANCE_KEY) ?? ''
  } catch {
    return ''
  }
}
