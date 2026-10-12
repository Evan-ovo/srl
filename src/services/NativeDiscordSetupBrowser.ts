import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { reactive } from 'vue'
import type { SecretBrowserTransfer } from './SecretResourceService'
/** Public routes/names/identifiers are not credentials. Input values stay in the local executor. */
export function maskDiscordSetupSecrets(text: string): string {
  return text
    .replace(
      /([?&](?:code|token|access_token|refresh_token|id_token|password|secret|client_secret|api_key)=)[^&#\s]+/giu,
      '$1[已遮蔽]',
    )
    .replace(
      /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}|(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{20,}/gu,
      '[已遮蔽]',
    )
}
/** Transient UI ownership; Cookie/editor/secret data never enters it. */
export const discordSetupSession = reactive({
  active: false,
  browserVisible: false,
  agentRunning: false,
  webStepActive: false,
  assistantConversationId: '',
})
export interface DiscordBrowserSnapshot {
  documentId: number
  url: string
  paused: boolean
  loading?: boolean
  failed?: boolean
  pageAccess?: 'public' | 'authentication' | 'protected' | 'external'
  chatOpen?: boolean
  pageKind?: string
  headings?: string[]
  truncated?: boolean
  searchMatched?: boolean
  applicationList?: { state: 'available' | 'empty' | 'unknown'; count: number }
  secretStage?: 'prepare' | 'input' | 'submit' | 'saved' | 'submitted'
  secretSavedOnPage?: boolean
  installationCompleted?: boolean
  forkOfTarget?: boolean
  controls?: Array<{
    target: string
    label: string
    kind: string
    sensitive: boolean
    disabled?: boolean
    checked?: boolean
    invalid?: boolean
    feedback?: string[]
    context?: string
    visible?: boolean
  }>
}
export interface DiscordBrowserEvent {
  action:
    | 'next'
    | 'select-step'
    | 'worker-url'
    | 'collect-worker'
    | 'guide'
    | 'template'
    | 'validate'
    | 'return'
    | 'assist'
    | 'resume'
    | 'visibility'
    | 'collect-config'
    | 'fill-config'
    | 'fullscreen'
    | 'quick-chat'
    | 'secret-prepare'
    | 'secret-submit'
    | 'page-ready'
    | 'agent-pause'
    | 'agent-resume'
    | 'capture-bot-secret'
    | 'installation-ready'
  step?: string
  workerUrl?: string
  visible?: boolean
  text?: string
  applicationId?: string
}
export interface DiscordSetupBrowser {
  captureBotSecret?(options: {
    documentId: number
    applicationId: string
    publicKey: string
  }): Promise<SecretBrowserTransfer>
  fillBotSecret?(options: { documentId: number; secret: string }): Promise<{ ok: boolean }>
  open(options: {
    url?: string
    site: string
    step: string
    title: string
    hint: string
    steps: Array<{ id: string; title: string }>
    template: string
    chooseStep?: boolean
    showControls?: boolean
    resumeCurrent?: boolean
    darkTheme?: boolean
    mode?: 'economy' | 'agent'
    agentRunId?: string
    conversationId?: string
    expectedApplicationId?: string
  }): Promise<void>
  pauseAgent(): Promise<void>
  waitReady(): Promise<DiscordBrowserSnapshot>
  waitStatus(options: { documentId: number; target: string }): Promise<DiscordBrowserSnapshot>
  cancelWait(): Promise<void>
  inspect(options?: { metadataOnly?: boolean; query?: string }): Promise<DiscordBrowserSnapshot>
  act(options: {
    documentId: number
    operation: string
    step?: string
    target?: string
    value?: string
    url?: string
    direction?: 'up' | 'down'
    template?: string
    expectedApplicationId?: string
    confirmedPreviousEndpoint?: string
    allowParameters?: boolean
    applicationIdTarget?: string
    publicKeyTarget?: string
    databaseIdTarget?: string
    statusTarget?: string
    deploymentAssessment?: string
    secretNameTarget?: string
    secretTypeTarget?: string
    secretValueTarget?: string
    expectedPublicKey?: string
    expectedDatabaseId?: string
    expectedRevision?: string
    expectedFork?: string
    validateTemplate?: boolean
  }): Promise<Record<string, unknown>>
  close(options?: { keepRunning?: boolean }): Promise<void>
  confirmSuccess(options: { documentId: number; step: string }): Promise<{ confirmed: boolean }>
  suspend(): Promise<{ suspended: boolean }>
  restore(options: { resume: boolean }): Promise<void>
  pet(options: { dataUrl: string }): Promise<void>
  addListener(
    event: 'setupAction',
    callback: (event: DiscordBrowserEvent) => void,
  ): Promise<PluginListenerHandle>
  message(options: { text: string; phase?: string }): Promise<void>
}
export const nativeDiscordSetupBrowser = registerPlugin<DiscordSetupBrowser>(
  'NativeDiscordSetupBrowser',
)
export function hasDiscordSetupBrowser(): boolean {
  return (
    Capacitor.getPlatform() === 'android' &&
    Capacitor.isPluginAvailable('NativeDiscordSetupBrowser')
  )
}
