import { Capacitor, registerPlugin } from '@capacitor/core'

export interface NativeSystemUiState {
  showStatusBar: boolean
}

interface NativeSystemUiPlugin {
  getState(): Promise<NativeSystemUiState>
  setShowStatusBar(options: { show: boolean }): Promise<NativeSystemUiState>
  performHaptic(options: { kind: NativeHapticKind }): Promise<{ performed: boolean }>
}

export type NativeHapticKind = 'success' | 'confirm' | 'warning'

const plugin = registerPlugin<NativeSystemUiPlugin>('NativeSystemUi')

function isAvailable(): boolean {
  return (
    Capacitor.isNativePlatform() &&
    Capacitor.getPlatform() === 'android' &&
    Capacitor.isPluginAvailable('NativeSystemUi')
  )
}

export async function getNativeSystemUiState(): Promise<NativeSystemUiState | null> {
  return isAvailable() ? plugin.getState() : null
}

export async function setNativeStatusBarVisible(
  show: boolean,
): Promise<NativeSystemUiState | null> {
  if (!isAvailable()) return null
  const state = await plugin.setShowStatusBar({ show })
  window.dispatchEvent(new CustomEvent('srl:system-ui-changed', { detail: state }))
  return state
}

/** null means the native plugin is unavailable; false means Android honored the call but no feedback was performed. */
export async function performNativeHaptic(kind: NativeHapticKind): Promise<boolean | null> {
  if (!isAvailable()) return null
  return (await plugin.performHaptic({ kind })).performed
}
