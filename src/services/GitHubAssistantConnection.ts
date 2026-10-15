import { Capacitor, registerPlugin } from '@capacitor/core'

export interface GitHubAssistantFile {
  connected: true
  login: string
  forkFound?: boolean
  repository?: string
  repositoryKind?: 'fork' | 'owned-source'
  branch?: string
  file?: 'wrangler.jsonc' | 'wrangler.json'
  source?: string
  sha?: string
  revision?: string
  behindBy?: number
  saved?: boolean
}
export interface GitHubAssistantPort {
  available(): boolean
  status(): Promise<{ connected: boolean }>
  authorize(signal: AbortSignal): Promise<{ connected: boolean; login: string }>
  execute(
    operation: 'inspect' | 'fork' | 'read' | 'sync' | 'save',
    options: {
      repository?: string
      branch?: string
      file?: string
      content?: string
      sha?: string
    },
    signal: AbortSignal,
  ): Promise<GitHubAssistantFile>
}
interface NativeGitHubAssistant {
  status(): Promise<{ connected: boolean }>
  authorize(options: { requestId: string }): Promise<{ connected: boolean; login: string }>
  execute(options: {
    requestId: string
    operation: string
    repository?: string
    branch?: string
    file?: string
    content?: string
    sha?: string
  }): Promise<GitHubAssistantFile>
  cancel(options: { requestId: string }): Promise<void>
}
const native = registerPlugin<NativeGitHubAssistant>('NativeGitHubAssistant')

/** Credentials and login codes remain native; this port carries only local configuration and receipts. */
export class GitHubAssistantConnection implements GitHubAssistantPort {
  private readonly plugin: NativeGitHubAssistant
  private readonly supported: () => boolean
  constructor(
    plugin = native,
    supported = () =>
      Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('NativeGitHubAssistant'),
  ) {
    this.plugin = plugin
    this.supported = supported
  }
  available() {
    return this.supported()
  }
  status() {
    return this.available() ? this.plugin.status() : Promise.resolve({ connected: false })
  }
  private async run<T>(
    signal: AbortSignal,
    execute: (requestId: string) => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted()
    if (!this.available()) throw new Error('当前环境没有 GitHub 授权连接，请保留原网页配置路线')
    const requestId = crypto.randomUUID()
    const cancel = () => {
      void this.plugin.cancel({ requestId }).catch(() => {})
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      const result = await execute(requestId)
      signal.throwIfAborted()
      return result
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  }
  authorize(signal: AbortSignal) {
    return this.run(signal, (requestId) => this.plugin.authorize({ requestId }))
  }
  execute(
    operation: 'inspect' | 'fork' | 'read' | 'sync' | 'save',
    options: {
      repository?: string
      branch?: string
      file?: string
      content?: string
      sha?: string
    },
    signal: AbortSignal,
  ) {
    return this.run(signal, (requestId) =>
      this.plugin.execute({ requestId, operation, ...options }),
    )
  }
}
export const gitHubAssistantConnection = new GitHubAssistantConnection()
