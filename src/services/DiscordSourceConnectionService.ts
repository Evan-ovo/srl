export interface DiscordWorkerEndpoints {
  baseUrl: string
  interactionsUrl: string
  healthUrl: string
  registerUrl: string
  statusUrl: string
}

export type DiscordDiagnosticState =
  | 'ready'
  | 'd1-error'
  | 'discord-missing'
  | 'discord-invalid'
  | 'worker-error'
  | 'outdated'
  | 'need-token'
export interface DiscordConfigurationDiagnosis {
  state: DiscordDiagnosticState
  message: string
  workerHealthy?: boolean
  commandRegistered?: boolean
  missingVariables?: string[]
}

/** One checker for the connection screen and agent. Never return remote bodies or credential values. */
export async function diagnoseDiscordConfiguration(
  settings: { workerBaseUrl: string; applicationId: string; botToken?: string; publicKey?: string },
  signal: AbortSignal,
): Promise<DiscordConfigurationDiagnosis> {
  signal.throwIfAborted()
  const endpoints = getDiscordWorkerEndpoints(settings.workerBaseUrl)
  if (!endpoints || new URL(endpoints.baseUrl).protocol !== 'https:')
    return { state: 'worker-error', message: '请先保存有效的 HTTPS Worker 根链接。' }
  const report = (
    state: DiscordDiagnosticState,
    message: string,
    extra: Partial<DiscordConfigurationDiagnosis> = {},
  ): DiscordConfigurationDiagnosis => ({ state, message, ...extra })
  try {
    const response = await fetch(endpoints.healthUrl, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal,
    })
    let health: Record<string, unknown>
    try {
      health = await response.json()
    } catch {
      return report('worker-error', `Worker /health 没有返回有效 JSON（HTTP ${response.status}）。`)
    }
    signal.throwIfAborted()
    if (!health || typeof health !== 'object' || Array.isArray(health))
      return report('worker-error', 'Worker /health 返回的数据格式无效。')
    if (health.database !== true)
      return report(
        'd1-error',
        'Worker 已响应，但 D1 或 handoffs 迁移表检查失败。请核对当前账号、Database ID、DB 绑定和数据库迁移。',
      )
    if (!response.ok || health.ok !== true)
      return report('worker-error', `Worker /health 检查失败（HTTP ${response.status}）。`)
    const localId = settings.applicationId.trim()
    if (!/^\d{17,20}$/u.test(localId))
      return report('discord-invalid', '请先在本机保存有效的 Application ID。', {
        workerHealthy: true,
      })
    if (health.applicationId !== localId)
      return report(
        'discord-invalid',
        'D1 正常，但 Worker 的 Application ID 与本机填写的 ID 不同。检查 Wrangler 是否来自同一个 Discord App。',
        { workerHealthy: true },
      )
    if (settings.publicKey && !/^[a-f0-9]{64}$/iu.test(settings.publicKey.trim()))
      return report('discord-invalid', '本机 Public Key 格式不正确，应为 64 位十六进制字符串。', {
        workerHealthy: true,
      })
    const checks = health.discordVariables as Record<string, unknown> | undefined
    const names = [
      ['applicationId', 'DISCORD_APPLICATION_ID'],
      ['publicKey', 'DISCORD_PUBLIC_KEY'],
      ['botToken', 'DISCORD_BOT_TOKEN'],
    ] as const
    if (
      !checks ||
      typeof checks !== 'object' ||
      names.some(([key]) => typeof checks[key] !== 'boolean')
    )
      return report(
        'outdated',
        'D1 正常，但当前 Worker 版本不支持完整配置核验。更新并重新部署 Bridge 后再检查。',
        { workerHealthy: true },
      )
    const missingVariables = names.filter(([key]) => checks[key] === false).map(([, name]) => name)
    if (missingVariables.length || health.discordConfigured !== true)
      return report(
        'discord-missing',
        missingVariables.length
          ? `D1 正常；Worker 缺少 Discord 变量：${missingVariables.join('、')}。核对 Wrangler 和 Production 的 Bot Token Secret。`
          : 'D1 正常，但 Worker 报告 Discord 配置未完成；检查三个值是否已部署到 Production。',
        { workerHealthy: true, missingVariables },
      )
    if (!settings.botToken?.trim())
      return report(
        'need-token',
        'D1 正常，Worker 中三项 Discord 值均已填写；请在本机保存或解锁 Bot Token，才能核验凭据。不发送到聊天。',
        { workerHealthy: true },
      )
    const status = await fetch(endpoints.statusUrl, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      headers: { Authorization: `Bearer ${settings.botToken.trim()}` },
      signal,
    })
    signal.throwIfAborted()
    if (status.status === 401)
      return report(
        'discord-invalid',
        'D1 正常，但本机 Bot Token 与 Cloudflare 中的 DISCORD_BOT_TOKEN Secret 不一致。',
        { workerHealthy: true },
      )
    if (status.status === 404)
      return report(
        'outdated',
        'D1 正常，但当前 Worker 没有凭证核验接口。更新并重新部署 Bridge 后再检查。',
        { workerHealthy: true },
      )
    if (!status.ok)
      return report(
        'discord-invalid',
        `D1 正常，但 Discord 凭证核验失败（HTTP ${status.status}）。请核对当前 App 的新 Token。`,
        { workerHealthy: true },
      )
    let discord: Record<string, unknown>
    try {
      discord = await status.json()
    } catch {
      return report('outdated', 'Worker 没有返回完整的凭据核验结果。', { workerHealthy: true })
    }
    signal.throwIfAborted()
    if (
      !discord ||
      typeof discord !== 'object' ||
      Array.isArray(discord) ||
      typeof discord.applicationIdMatches !== 'boolean' ||
      typeof discord.publicKeyMatches !== 'boolean' ||
      typeof discord.commandRegistered !== 'boolean'
    )
      return report(
        'outdated',
        '当前 Worker 版本没有返回完整的 App、公钥和命令核验结果。更新并重新部署 Bridge 后再检查。',
        { workerHealthy: true },
      )
    if (!discord.applicationIdMatches)
      return report(
        'discord-invalid',
        'D1 正常，但 DISCORD_APPLICATION_ID 与 Bot Token 所属 App 不一致。',
        { workerHealthy: true },
      )
    if (!discord.publicKeyMatches)
      return report(
        'discord-invalid',
        'D1 正常，但 DISCORD_PUBLIC_KEY 与 Bot Token 所属 App 的 Public Key 不一致。',
        { workerHealthy: true },
      )
    return report(
      'ready',
      discord.commandRegistered
        ? '核验通过：Worker 可访问、D1 查询成功，Bot Token 有效，Application ID 和 Public Key 与同一个 Discord App 匹配。网页端点保存、安装账号和实际命令菜单仍需网页或用户证据。'
        : '核验通过：Worker、D1 和 Discord 凭据匹配；消息命令还未注册。',
      { workerHealthy: true, commandRegistered: discord.commandRegistered },
    )
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    return report(
      'worker-error',
      '无法访问 Worker 检查接口。请核对根网址、网络、workers.dev 和部署状态。',
    )
  }
}

const KNOWN_ENDPOINT_SUFFIXES = [
  '/setup/register',
  '/setup/status',
  '/interactions',
  '/health',
] as const

function looksLikeHost(value: string): boolean {
  return /^[\w.-]+(?::\d+)?(?:\/.*)?$/u.test(value)
}

export function normalizeDiscordWorkerBaseUrl(value: string): string {
  let candidate = value.trim()
  if (!candidate) return ''
  if (!/^https?:\/\//iu.test(candidate) && looksLikeHost(candidate)) {
    candidate = `https://${candidate}`
  }

  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    if (url.username || url.password) return ''

    url.hash = ''
    url.search = ''

    let pathname = url.pathname.replace(/\/+$/u, '')
    const lowerPath = pathname.toLowerCase()
    const suffix = KNOWN_ENDPOINT_SUFFIXES.find((item) => lowerPath.endsWith(item))
    if (suffix) pathname = pathname.slice(0, -suffix.length).replace(/\/+$/u, '')
    url.pathname = pathname || '/'

    return url.toString().replace(/\/+$/u, '')
  } catch {
    return ''
  }
}

export function getDiscordWorkerEndpoints(value: string): DiscordWorkerEndpoints | undefined {
  const baseUrl = normalizeDiscordWorkerBaseUrl(value)
  if (!baseUrl) return undefined
  return {
    baseUrl,
    interactionsUrl: `${baseUrl}/interactions`,
    healthUrl: `${baseUrl}/health`,
    registerUrl: `${baseUrl}/setup/register`,
    statusUrl: `${baseUrl}/setup/status`,
  }
}

/** Shared by the connection screen and setup agent. Credentials and raw responses stay local. */
export async function checkDiscordWorker(
  settings: { workerBaseUrl: string; applicationId: string; botToken?: string },
  operation: 'health' | 'status' | 'register',
  signal: AbortSignal,
): Promise<{ configured: boolean; commandRegistered?: boolean }> {
  signal.throwIfAborted()
  const endpoints = getDiscordWorkerEndpoints(settings.workerBaseUrl)
  if (!endpoints || new URL(endpoints.baseUrl).protocol !== 'https:')
    throw new Error('请先保存有效的 HTTPS Worker 地址')
  if (
    (operation !== 'health' || settings.applicationId) &&
    !/^\d{17,20}$/u.test(settings.applicationId)
  )
    throw new Error('请先保存有效的 App ID')
  if (operation !== 'health' && !settings.botToken?.trim())
    throw new Error('请在连接设置手填 Bot Token；不要发到聊天')
  const response = await fetch(
    operation === 'health'
      ? endpoints.healthUrl
      : operation === 'status'
        ? endpoints.statusUrl
        : endpoints.registerUrl,
    {
      method: operation === 'register' ? 'POST' : 'GET',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal,
      ...(operation !== 'health'
        ? {
            headers: {
              Authorization: `Bearer ${settings.botToken!.trim()}`,
              ...(operation === 'register' ? { 'Content-Type': 'application/json' } : {}),
            },
          }
        : {}),
      ...(operation === 'register'
        ? { body: JSON.stringify({ applicationId: settings.applicationId }) }
        : {}),
    },
  )
  // Never return a server error body: it may contain credentials or arbitrary page instructions.
  if (!response.ok) throw new Error(`Worker ${operation} 检查失败（HTTP ${response.status}）`)
  let payload: Record<string, unknown>
  try {
    payload = (await response.json()) as Record<string, unknown>
  } catch {
    throw new Error('Worker 未返回有效的检查结果')
  }
  signal.throwIfAborted()
  if (!payload || (settings.applicationId && payload.applicationId !== settings.applicationId))
    throw new Error('Worker 与本次 Discord App 不一致或缺少 App 身份，未确认成功')
  if (operation === 'health') {
    if (payload.database !== true) throw new Error('D1 绑定或迁移检查未通过')
    return { configured: payload.discordConfigured === true }
  }
  if (payload.applicationIdMatches === false || payload.publicKeyMatches === false)
    throw new Error('Worker 的 App、公钥与 Bot Token 所属 App 不一致')
  if (operation === 'register') return checkDiscordWorker(settings, 'status', signal)
  if (
    payload.applicationIdMatches !== true ||
    payload.publicKeyMatches !== true ||
    typeof payload.commandRegistered !== 'boolean'
  )
    throw new Error('Worker 未返回完整的 App、公钥和命令核验结果，请先更新 Worker')
  return { configured: true, commandRegistered: payload.commandRegistered }
}
