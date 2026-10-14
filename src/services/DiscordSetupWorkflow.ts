export type DiscordSetupTask =
  'configure' | 'update-worker' | 'update-commands' | 'update-commands-only' | 'diagnose'
export const DISCORD_SETUP_STEPS = [
  {
    id: 'diagnose',
    title: '排查当前 Discord Bridge 配置',
    site: 'local',
    hint: '检查本机配置对应的 Worker、D1、Discord 凭据和命令状态；根据真实结果选择修复步骤。秘密不发送给模型，网页交互地址和安装账号仍需实际证据。',
  },
  {
    id: 'discord-app',
    title: '保存 Discord App ID 与公钥',
    site: 'discord',
    hint: '登录 Discord Developer Portal，先看应用列表；有自己的目标 App 就复用，没有则创建一个 App，多个且不确定时先选目标。在 General Information 保存 Application ID、Public Key；在 Bot 页面保存 Bot Token。Token 不要发到聊天。',
  },
  {
    id: 'discord-token',
    title: '保存 Discord Bot Token',
    site: 'discord',
    hint: '已保存 App ID 和公钥。现在在同一个 App 的 Bot 页面完成网站验证并显示 Token，点桌宠“加密保存当前 Bot Token”。软件只在本机加密保存，模型看不到；也可以自行保存后明确选择继续。完成后再创建 Cloudflare D1。',
  },
  {
    id: 'd1-create',
    title: '创建 D1 数据库',
    site: 'cloudflare',
    hint: '登录自己的 Cloudflare，进入存储与数据库 → D1，创建 srl-discord-source-handoff。已有该数据库时继续使用，不重复创建。',
  },
  {
    id: 'd1-uuid',
    title: '记下 D1 Database ID',
    site: 'cloudflare',
    hint: '打开刚创建的 D1 数据库，找到 Database ID（UUID）并记住。数据库名称不是 UUID；后面 Wrangler 模板第一个空使用这个值。',
  },
  {
    id: 'github-fork',
    title: 'Fork 指定仓库',
    site: 'github',
    hint: '登录 GitHub，把 jixiangruyi117/SRL-Discord-Bridge Fork 到自己的账号。进入自己的 Fork 首页，再点本步完成；已 Fork 可直接进入自己的仓库。',
  },
  {
    id: 'wrangler-edit',
    title: '编辑 Wrangler 三个空',
    site: 'github',
    hint: '在自己的 Fork 打开 wrangler.jsonc 并编辑。使用“粘贴教程模板”，自己填写 D1 UUID、Application ID、Public Key。不要写 Bot Token；粘贴会替换当前文件内容。',
  },
  {
    id: 'wrangler-check',
    title: '检查 Wrangler 格式',
    site: 'github',
    hint: '保持编辑页面，点击“检查格式”。检查 JSON、UUID、Application ID、公钥和固定配置。这里只检查格式，不能证明三个值来自同一个账号。',
  },
  {
    id: 'github-save',
    title: '保存 GitHub 配置',
    site: 'github',
    hint: '格式检查通过后 Commit changes，保存到自己的 Fork。提交会触发已绑定的自动部署；保存失败留在本步。',
  },
  {
    id: 'github-sync',
    title: '核对并更新部署仓库分支',
    site: 'github',
    hint: '先核对 Worker 实际部署仓库与分支。Fork 才 Sync fork → Update branch；登录者拥有源仓库则核验当前提交，不找 Fork。已最新就复用，保留自己的配置；没有新提交不会触发自动构建，下一步检查原 Worker 当前生产部署，不等待新记录。有冲突先查差异，不点 Discard commits。',
  },
  {
    id: 'cf-deploy',
    title: '部署并确认 Worker 成功',
    site: 'cloudflare',
    hint: 'Cloudflare → Workers & Pages，部署本次 Bridge Worker；部署命令使用 npm run deploy（包含 D1 迁移）。确认当前 Worker 的生产部署成功即可继续，既有成功部署也可复用；仓库没有新提交不会自动产生新部署记录，不因此停住或制造提交。没有成功部署时检查实际构建/部署错误并处理原 Worker，只有正在构建或排队才等待。不要求仓库名、分支和提交号逐一匹配；Secret 与实际连接在后续步骤检查。',
  },
  {
    id: 'cf-secret',
    title: '填写 Cloudflare Bot Secret',
    site: 'cloudflare',
    hint: '自己的 Worker → Settings → Variables and Secrets，添加 DISCORD_BOT_TOKEN，类型选 Secret。值由你填写；然后保存并部署。不要把它放进 GitHub 或聊天。',
  },
  {
    id: 'worker-url',
    title: '回填 Worker 根链接',
    site: 'cloudflare',
    hint: '找到部署成功的 HTTPS Worker 根链接，点“填写 Worker 链接”。先保存到本次任务，不带 /interactions；完成 Secret 与 Discord 配置后，到本机连接步骤再一并回填。浏览器会保留当前步骤。',
  },
  {
    id: 'discord-endpoint',
    title: '回填 Discord 交互地址',
    site: 'discord',
    hint: '打开同一个 Discord App 的 General Information，Interactions Endpoint URL 填 Worker 根链接加 /interactions，再保存并确认 Discord 验证成功。',
  },
  {
    id: 'discord-install',
    title: '安装或重新安装 Discord App',
    site: 'discord',
    hint: '进入同一个 App 的 Installation，确认 User Install 及应用命令安装设置，找到 Install Link，打开链接完成个人账号安装或重新授权。安装由你确认；出现错误不要标记完成。',
  },
  {
    id: 'local-settings',
    title: '填写资源库连接参数',
    site: 'local',
    hint: '回到资源库连接设置，自己填写 Application ID、Public Key、Bot Token 和 Worker 根链接，并保存。Bot Token 沿原本机受保护存储保存。',
  },
  {
    id: 'register',
    title: '注册 Discord 消息命令',
    site: 'local',
    hint: '在原连接设置点“注册消息命令”。更新注册指令需要重新注册，重新安装 App 不等于注册成功。',
  },
  {
    id: 'verify',
    title: '核验连接与命令',
    site: 'local',
    hint: '点“测试连接”，核验 Worker、D1、Discord App 与命令状态。检查成功后再标记完成；最后在 Discord 查看新命令。',
  },
  {
    id: 'done',
    title: '配置流程结束',
    site: 'local',
    hint: '资源库连接与注册检查通过。Discord 实际菜单可见性仍以你在 Discord 的操作为准。',
  },
] as const
export type DiscordSetupStep = (typeof DISCORD_SETUP_STEPS)[number]['id']
export const DISCORD_SETUP_ROUTES: Record<DiscordSetupTask, readonly DiscordSetupStep[]> = {
  diagnose: ['diagnose', 'done'],
  configure: [
    'discord-app',
    'discord-token',
    'd1-create',
    'd1-uuid',
    'github-fork',
    'wrangler-edit',
    'wrangler-check',
    'github-save',
    'cf-deploy',
    'cf-secret',
    'worker-url',
    'discord-endpoint',
    'discord-install',
    'local-settings',
    'register',
    'verify',
    'done',
  ],
  'update-worker': ['github-sync', 'cf-deploy', 'verify', 'done'],
  'update-commands': [
    'github-sync',
    'cf-deploy',
    'discord-install',
    'local-settings',
    'register',
    'verify',
    'done',
  ],
  'update-commands-only': ['discord-install', 'local-settings', 'register', 'verify', 'done'],
}
export interface DiscordSetupState {
  assistantConversationId?: string
  botTokenReady?: 'encrypted' | 'manual'
  mode?: 'economy' | 'agent'
  parameterResourceId?: string
  connectionBackupResourceId?: string
  connectionBackupFingerprint?: string
  appliedDatabaseId?: string
  task: DiscordSetupTask
  step: DiscordSetupStep
  startedAt: number
  forkRepo?: string
  repositoryKind?: 'fork'
  githubBranch?: string
  githubFile?: 'wrangler.jsonc' | 'wrangler.json'
  applicationId?: string
  workerUrl?: string
  workerConfirmedAt?: number
  githubRevision?: string
}
export function setupStep(id: DiscordSetupStep) {
  return DISCORD_SETUP_STEPS.find((step) => step.id === id)!
}
export function normalizeDiscordSetupState(value: unknown): DiscordSetupState | undefined {
  if (!value || typeof value !== 'object') return
  const input = value as Record<string, unknown>
  if (!Object.hasOwn(DISCORD_SETUP_ROUTES, String(input.task))) return
  const task = input.task as DiscordSetupTask
  if (
    !DISCORD_SETUP_ROUTES[task].includes(input.step as DiscordSetupStep) ||
    !Number.isFinite(input.startedAt)
  )
    return
  const state: DiscordSetupState = {
    task,
    step: input.step as DiscordSetupStep,
    startedAt: input.startedAt as number,
  }
  if (input.mode === 'economy' || input.mode === 'agent') state.mode = input.mode
  if (
    typeof input.assistantConversationId === 'string' &&
    /^[\w-]{1,100}$/u.test(input.assistantConversationId)
  )
    state.assistantConversationId = input.assistantConversationId
  if (input.botTokenReady === 'encrypted' || input.botTokenReady === 'manual')
    state.botTokenReady = input.botTokenReady
  if (
    typeof input.parameterResourceId === 'string' &&
    /^[\w-]{1,100}$/u.test(input.parameterResourceId)
  )
    state.parameterResourceId = input.parameterResourceId
  if (
    typeof input.connectionBackupResourceId === 'string' &&
    /^[\w-]{1,100}$/u.test(input.connectionBackupResourceId)
  )
    state.connectionBackupResourceId = input.connectionBackupResourceId
  if (
    typeof input.connectionBackupFingerprint === 'string' &&
    /^[a-f0-9]{64}$/u.test(input.connectionBackupFingerprint)
  )
    state.connectionBackupFingerprint = input.connectionBackupFingerprint
  if (
    typeof input.appliedDatabaseId === 'string' &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(input.appliedDatabaseId)
  )
    state.appliedDatabaseId = input.appliedDatabaseId
  if (
    typeof input.forkRepo === 'string' &&
    /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/u.test(input.forkRepo)
  )
    state.forkRepo = input.forkRepo
  if (input.repositoryKind === 'fork') state.repositoryKind = input.repositoryKind
  if (typeof input.githubBranch === 'string' && validSetupBranch(input.githubBranch))
    state.githubBranch = input.githubBranch
  if (input.githubFile === 'wrangler.jsonc' || input.githubFile === 'wrangler.json')
    state.githubFile = input.githubFile
  if (typeof input.applicationId === 'string' && /^\d{17,20}$/u.test(input.applicationId))
    state.applicationId = input.applicationId
  if (Number.isFinite(input.workerConfirmedAt))
    state.workerConfirmedAt = input.workerConfirmedAt as number
  if (typeof input.githubRevision === 'string' && /^[a-f0-9]{40}$/iu.test(input.githubRevision))
    state.githubRevision = input.githubRevision.toLowerCase()
  if (typeof input.workerUrl === 'string') {
    try {
      state.workerUrl = checkedSetupWorkerUrl(input.workerUrl)
    } catch {
      /* Invalid imported metadata does not restore a target. */
    }
  }
  return state
}
export function isSetupAgentUrl(url: URL): boolean {
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    !url.port &&
    (['discord.com', 'github.com', 'dash.cloudflare.com'].includes(url.hostname) ||
      url.hostname.endsWith('.workers.dev'))
  )
}
export function isSetupForkPage(url: URL, repo?: string): boolean {
  return (
    !!repo &&
    isSetupAgentUrl(url) &&
    url.hostname === 'github.com' &&
    (url.pathname === `/${repo}` || url.pathname.startsWith(`/${repo}/`))
  )
}
export function validSetupBranch(branch: string): boolean {
  return (
    !!branch &&
    branch.length <= 200 &&
    ![...branch].some(
      (char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127 || '~^:?*[\\'.includes(char),
    ) &&
    !branch.includes('..') &&
    !branch.includes('@{') &&
    !branch.startsWith('/') &&
    !branch.endsWith('/') &&
    !branch.endsWith('.') &&
    !branch.includes('//') &&
    branch.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock'))
  )
}
export function setupWranglerPage(
  url: URL,
  state: DiscordSetupState,
  kind?: 'edit' | 'blob',
): boolean {
  if (!isSetupForkPage(url, state.forkRepo)) return false
  const match = url.pathname.match(/\/(edit|blob)\/(.+)\/(wrangler\.jsonc?)$/u)
  if (!match || (kind && match[1] !== kind)) return false
  try {
    return (
      decodeURIComponent(match[2]!) === (state.githubBranch ?? 'main') &&
      match[3] === (state.githubFile ?? 'wrangler.jsonc')
    )
  } catch {
    return false
  }
}
export function setupParameterStep(value: string): 'discord-app' | 'd1-uuid' | undefined {
  const url = new URL(value)
  if (!isSetupAgentUrl(url)) return
  if (
    url.hostname === 'discord.com' &&
    /^\/developers\/applications\/\d{17,20}(?:\/|$)/u.test(url.pathname)
  )
    return 'discord-app'
  if (url.hostname === 'dash.cloudflare.com' && /\/d1(?:\/|$)/u.test(url.pathname)) return 'd1-uuid'
}
export function checkedSetupWorkerUrl(value: string): string {
  const url = new URL(value.trim())
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !/^[a-z0-9.-]+\.[a-z]{2,}$/iu.test(url.hostname) ||
    /(?:^|\.)(localhost|local|internal|lan|home)$/iu.test(url.hostname) ||
    url.pathname.replace(/\/+$/u, '')
  )
    throw new Error('请填写不带路径、查询参数或凭据的 HTTPS Worker 根链接')
  return url.origin
}
export function discordSetupUrl(state: DiscordSetupState): string | undefined {
  const step = setupStep(state.step)
  if (step.site === 'local') return
  if (['d1-uuid', 'wrangler-check', 'github-save', 'cf-secret', 'worker-url'].includes(state.step))
    return
  if (step.site === 'discord')
    return state.applicationId
      ? `https://discord.com/developers/applications/${state.applicationId}${state.step === 'discord-install' ? '/installation' : state.step === 'discord-token' ? '/bot' : '/information'}`
      : 'https://discord.com/developers/applications'
  if (step.site === 'cloudflare') return 'https://dash.cloudflare.com/'
  if (state.step === 'github-fork')
    return 'https://github.com/jixiangruyi117/SRL-Discord-Bridge/fork'
  if (!state.forkRepo) return 'https://github.com/'
  return `https://github.com/${state.forkRepo}${state.step === 'wrangler-edit' ? `/edit/${encodeURIComponent(state.githubBranch ?? 'main')}/${state.githubFile ?? 'wrangler.jsonc'}` : ''}`
}
