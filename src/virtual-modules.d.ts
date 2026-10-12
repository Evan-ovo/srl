declare const __SRL_PREINSTALL_OFFICIAL_APPS__: boolean
declare const __SRL_PREINSTALL_OFFICIAL_APP_IDS__: readonly string[] | null

declare module 'virtual:srl-preview-vendor-globals-source' {
  const source: string
  export default source
}

declare module 'virtual:srl-appearance-starter-css-source' {
  const source: Record<string, string>
  export default source
}

declare module 'virtual:srl-appearance-reference' {
  const catalog: import('./types/AppearanceReference').ReferenceCatalog
  export default catalog
}

declare module 'virtual:srl-discord-manual-worker-source' {
  const source: string
  export default source
}

declare module 'virtual:srl-official-app-entries' {
  export const runtimeEntry: string | undefined
  import type { Component } from 'vue'
  export const entries: Record<
    string,
    { url?: string; load?: () => Promise<{ default: Component; prepare?: () => Promise<void> }> }
  >
}
