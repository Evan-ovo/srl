import { Capacitor } from '@capacitor/core'
import { performNativeHaptic, type NativeHapticKind } from './NativeSystemUi'

const ENABLED_KEY = 'srl.native.haptics.enabled'

export type { NativeHapticKind } from './NativeSystemUi'

export function isNativeHapticsEnabled(): boolean {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return false
  try {
    return localStorage.getItem(ENABLED_KEY) !== 'false'
  } catch {
    return false
  }
}

export function setNativeHapticsEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, String(enabled))
  } catch {
    // 不可持久化时仍保留系统默认行为，不阻断功能操作。
  }
}

/** 只在用户已开启的 Android APK 内触发；网页端和不支持设备保持静默。 */
export async function triggerNativeHaptic(kind: NativeHapticKind): Promise<void> {
  if (!isNativeHapticsEnabled()) return
  const pattern: Record<NativeHapticKind, number | number[]> = {
    success: [10, 36, 14],
    confirm: 12,
    warning: [18, 40, 22],
  }
  try {
    const performed = await performNativeHaptic(kind)
    if (performed === null && isNativeHapticsEnabled()) navigator.vibrate?.(pattern[kind])
  } catch (error) {
    if ((error as { code?: string }).code === 'UNIMPLEMENTED' && isNativeHapticsEnabled())
      navigator.vibrate?.(pattern[kind])
  }
}
