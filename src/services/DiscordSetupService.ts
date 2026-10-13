import type { DiscordSetupStorage } from '../storage/IndexedDbDiscordSetupStorage'
import { chooseAction, confirmAction } from '../composables/UseConfirmDialog'
import {
  discordSetupParameterResources,
  checkedSetupParameters,
  discordConnectionBackupIdentity,
  MissingDiscordSetupCardError,
  type DiscordSetupParameterResources,
  type DiscordSetupParameters,
  type DiscordSetupConnectionBackup,
} from './DiscordSetupParameters'
import { startAssistantGuidance } from '../core/ProductAssistantGuidance'
import { taskCenter } from '../core/TaskCenter'
import { DISCORD_BRIDGE_WRANGLER_TEMPLATE } from './DiscordBridgeDeployService'
import { checkDiscordWorker, diagnoseDiscordConfiguration } from './DiscordSourceConnectionService'
import {
  nativeDiscordSetupBrowser,
  maskDiscordSetupSecrets,
  discordSetupSession,
  type DiscordSetupBrowser,
  type DiscordBrowserEvent,
  type DiscordBrowserSnapshot,
} from './AssistantBrowserRuntime'
import {
  loadDiscordSourceConnectionSettings,
  replaceDiscordSourceConnectionSettings,
  saveDiscordSourceConnectionSettings,
  saveDiscordSourceConnectionStatus,
  type DiscordSourceConnectionSettings,
} from './DiscordSourceSettingsService'
import {
  DISCORD_SETUP_ROUTES,
  checkedSetupWorkerUrl,
  discordSetupUrl,
  setupStep,
  isSetupAgentUrl,
  isSetupForkPage,
  setupParameterStep,
  type DiscordSetupState,
  type DiscordSetupStep,
  type DiscordSetupTask,
} from './DiscordSetupWorkflow'

export class DiscordSetupService {
  private readonly storage: DiscordSetupStorage
  private readonly browser: DiscordSetupBrowser
  private readonly parameters: DiscordSetupParameterResources
  private state?: DiscordSetupState
  private initialized?: Promise<void>
  private pending: Promise<unknown> = Promise.resolve()
  private assistantRequested: { text: string; userInitiated: boolean } | undefined
  private assistantDraft: string | undefined
  private agentController?: AbortController
  private agentOperationId?: string
  private agentProgress = 0
  private readonly agentActions = new Set<string>()
  private consentStartedAt?: number
  private consentController?: AbortController
  private preparationController?: AbortController
  private transferController?: AbortController
  private collectionReceipt?: {
    startedAt: number
    step: string
    documentId: number
    url: string
    resourceId: string
  }
  private diagnosisReceipt?: {
    startedAt: number
    settings: ReturnType<typeof loadDiscordSourceConnectionSettings>
  }
  private replacementBackup?: {
    startedAt: number
    snapshot: string
    id?: string
    confirmed: boolean
    applicationId?: string
    workerUrl?: string
  }
  private async preservePreviousConnection(
    previous: DiscordSetupConnectionBackup,
    signal?: AbortSignal,
    target = { applicationId: this.state?.applicationId, workerUrl: this.state?.workerUrl },
  ): Promise<boolean> {
    signal ??= this.agentController?.signal.aborted ? undefined : this.agentController?.signal
    const startedAt = this.state!.startedAt
    if (previous.inboxLibraryId && !previous.inboxSecret)
      throw new Error('原收件配对凭据缺失，无法完整保存旧配对；未切换，请先恢复原凭据')
    const prior = this.replacementBackup
    let reuse = false
    if (prior?.startedAt === startedAt) {
      const original = JSON.parse(prior.snapshot) as DiscordSetupConnectionBackup
      const { interactionEndpointUrl: _endpoint, ...base } = original
      const { interactionEndpointUrl: _newEndpoint, ...nextBase } = previous
      delete base.databaseId
      delete nextBase.databaseId
      reuse = discordConnectionBackupIdentity(base) === discordConnectionBackupIdentity(nextBase)
      if (reuse && !previous.interactionEndpointUrl && original.interactionEndpointUrl)
        previous = { ...previous, interactionEndpointUrl: original.interactionEndpointUrl }
      if (reuse && original.databaseId) previous = { ...previous, databaseId: original.databaseId }
    }
    const snapshot = JSON.stringify(previous)
    const fingerprint = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(discordConnectionBackupIdentity(previous)),
        ),
      ),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('')
    if (
      prior?.startedAt === startedAt &&
      discordConnectionBackupIdentity(JSON.parse(prior.snapshot)) ===
        discordConnectionBackupIdentity(previous) &&
      prior.confirmed &&
      prior.id &&
      prior.applicationId === target.applicationId &&
      (!prior.workerUrl || prior.workerUrl === target.workerUrl)
    ) {
      if (!this.parameters.backupConnection) throw new Error('旧连接备份能力不可用，未覆盖')
      try {
        await this.parameters.backupConnection(previous, prior.id, signal)
        prior.workerUrl = target.workerUrl
        return true
      } catch (error) {
        if (!(error instanceof MissingDiscordSetupCardError)) throw error
        prior.id = undefined
        prior.confirmed = false
        await this.save({
          ...this.state!,
          connectionBackupResourceId: undefined,
          connectionBackupFingerprint: undefined,
        })
      }
    }
    const suspended = await this.suspendForModelConsent()
    let accepted = false
    let preserved = false
    try {
      accepted = await confirmAction(
        {
          title: '发现已有 Discord Bridge 配置',
          centered: true,
          message:
            `原 App：${previous.applicationId || '未保存'}\n原 Worker：${previous.workerBaseUrl || '未保存'}\n` +
            (previous.interactionEndpointUrl
              ? `原交互地址：${previous.interactionEndpointUrl}\n`
              : '') +
            `本次 App：${target.applicationId || '尚待确认'}\n本次 Worker：${target.workerUrl || '尚待确认'}\n\n` +
            '本次配置与原连接不同。切换前会将本机已保存的原 App ID、公钥、Worker、Bot Token 和收件配对资料保存为另一个加密密钥资源，并读回核对。未保存过的秘密不能从 Cloudflare 取回；秘密值不发给模型。\n\n旧云端资源不会删除；切到其他 Worker 后，本机停止领取旧收件库，旧待收内容有保留期限，请及时处理。选择不切换将停止本次配置。',
          confirmLabel: '保存旧配置并切换',
          cancelLabel: '不切换，停止配置',
        },
        signal,
      )
      if (!accepted) {
        await this.stopAgent()
        return false
      }
      signal?.throwIfAborted()
      if (this.state?.startedAt !== startedAt) throw new Error('任务已变化，未切换旧连接')
      if (
        discordConnectionBackupIdentity({
          ...loadDiscordSourceConnectionSettings(),
          ...(previous.interactionEndpointUrl
            ? { interactionEndpointUrl: previous.interactionEndpointUrl }
            : {}),
          ...(previous.databaseId ? { databaseId: previous.databaseId } : {}),
        }) !== discordConnectionBackupIdentity(previous)
      )
        throw new Error('原连接在确认期间已变化，未切换')
      await this.prepareParameters(signal)
      if (!this.parameters.backupConnection) throw new Error('旧连接备份能力不可用，未覆盖')
      const receipt =
        reuse && prior
          ? {
              ...prior,
              snapshot,
              confirmed: false,
              applicationId: target.applicationId,
              workerUrl: target.workerUrl,
            }
          : {
              startedAt,
              snapshot,
              confirmed: false,
              applicationId: target.applicationId,
              workerUrl: target.workerUrl,
            }
      if (!receipt.id && this.state.connectionBackupFingerprint === fingerprint)
        receipt.id = this.state.connectionBackupResourceId
      this.replacementBackup = receipt
      const checkpoint = async (id: string) => {
        receipt.id = id
        if (this.state?.startedAt !== startedAt)
          throw new Error('任务已变化，旧配置备份保留，未切换')
        await this.save({
          ...this.state,
          connectionBackupResourceId: id,
          connectionBackupFingerprint: fingerprint,
        })
      }
      const existingBackupId = receipt.id
      try {
        receipt.id = await this.parameters.backupConnection(
          previous,
          receipt.id,
          signal,
          checkpoint,
        )
      } catch (error) {
        if (!(error instanceof MissingDiscordSetupCardError) || !existingBackupId) throw error
        receipt.id = undefined
        receipt.id = await this.parameters.backupConnection(previous, undefined, signal, checkpoint)
      }
      if (this.state?.startedAt !== startedAt) throw new Error('任务已变化，未切换')
      if (
        this.state.connectionBackupResourceId !== receipt.id ||
        this.state.connectionBackupFingerprint !== fingerprint
      )
        await this.save({
          ...this.state,
          connectionBackupResourceId: receipt.id,
          connectionBackupFingerprint: fingerprint,
        })
      receipt.confirmed = true
      preserved = true
      return true
    } finally {
      if (!preserved && accepted && discordSetupSession.agentRunning) await this.stopAgent()
      if (suspended)
        await this.restoreAfterModelConsent(preserved && !!discordSetupSession.agentRunning)
    }
  }
  private async guardConnectionConflict(
    next: Partial<DiscordSourceConnectionSettings>,
    signal?: AbortSignal,
  ) {
    const previous = loadDiscordSourceConnectionSettings()
    const keys = ['applicationId', 'publicKey', 'botToken', 'workerBaseUrl'] as const
    if (
      !keys.some((key) => previous[key]) ||
      !keys.some((key) => next[key] !== undefined && next[key] !== previous[key])
    )
      return true
    return this.preservePreviousConnection(previous, signal)
  }
  private async collectedHere(page: DiscordBrowserSnapshot) {
    if (!this.state?.parameterResourceId || page.paused) return false
    let values: DiscordSetupParameters
    try {
      values = checkedSetupParameters(await this.parameters.read(this.state.parameterResourceId))
    } catch (error) {
      if (error instanceof MissingDiscordSetupCardError) return false
      throw error
    }
    if (this.state.step === 'discord-app') {
      // Completion verifies the stored public fields and App identity, not a transient DOM target.
      // This also resumes a successful capture after the service or WebView has reopened.
      return Boolean(
        values.applicationId &&
        values.publicKey &&
        values.applicationId === this.state.applicationId &&
        page.url ===
          `https://discord.com/developers/applications/${values.applicationId}/information`,
      )
    }
    const receipt = this.collectionReceipt
    return Boolean(
      receipt &&
      receipt.startedAt === this.state?.startedAt &&
      receipt.step === this.state.step &&
      receipt.documentId === page.documentId &&
      receipt.url === page.url &&
      receipt.resourceId === this.state.parameterResourceId,
    )
  }
  private async parameterStatus() {
    if (!this.state?.parameterResourceId)
      return { savedFields: [], parameterCardState: 'not-created' }
    try {
      const values = checkedSetupParameters(
        await this.parameters.read(this.state.parameterResourceId),
      )
      return {
        savedFields: Object.keys(values).filter((key) =>
          Boolean(values[key as keyof DiscordSetupParameters]),
        ),
        parameterCardState: 'available',
      }
    } catch (error) {
      if (!(error instanceof MissingDiscordSetupCardError)) throw error
      return {
        savedFields: [],
        parameterCardState: 'missing',
        parameterCardAction: 'recreate-after-confirmation',
        parametersSaved: false,
        botSecretSaved: false,
        hint: '关联的部署卡已删除。继续 collect-config，软件会居中确认重新建卡并保存公开参数；不能要求用户手动建卡或宣称旧 Token 仍可用。',
      }
    }
  }
  private async prepareParameters(signal?: AbortSignal) {
    if (this.parameters.needsUnlock?.() === false) return
    const controller = new AbortController()
    this.preparationController = controller
    const cancel = () => controller.abort()
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) controller.abort()
    const suspended = await this.suspendForModelConsent()
    try {
      controller.signal.throwIfAborted()
      await this.parameters.prepare(controller.signal)
      controller.signal.throwIfAborted()
    } finally {
      signal?.removeEventListener('abort', cancel)
      if (this.preparationController === controller) this.preparationController = undefined
      if (suspended)
        await this.browser.restore({
          resume: discordSetupSession.agentRunning && !controller.signal.aborted,
        })
    }
  }
  private async confirmAgentPermissions(signal?: AbortSignal) {
    const controller = new AbortController()
    this.consentController = controller
    const cancel = () => controller.abort()
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) controller.abort()
    let suspended = false
    try {
      suspended = await this.suspendForModelConsent()
      const confirmed = await confirmAction(
        {
          title: '开启蒜惹菈代理模式？',
          centered: true,
          confirmLabel: '确认权限并开启',
          cancelLabel: '暂不开启',
          message:
            '本次 Discord Bridge 配置或更新由助手操作 Discord、GitHub、Cloudflare 和 workers.dev 公开站点；登录跳转可打开其他公开 HTTPS 网站，由你完成。\n\n会修改当前账号配置，并调用你选择的 AI 服务、消耗 Token；你可随时在桌宠或任务中心暂停。\n\n登录、密码、验证码及网站显示/重置密钥由你操作；助手可核对并完成 Cloudflare GitHub App 的仓库选择与安装授权，已有连接可复用。模型不读取或接收秘密值；Bot Token 可单独确认本机加密保存，再由软件盲转填到本次 Worker 和资源库设置。\n\n向下滑动查看完整权限：\n• 查看公开页面说明、表格、文本和控件；搜索、跳转、点击、选择、滚动，并按实际结果语义判断生产部署。\n• 自主填写普通非秘密表单；使用本机保存的 App ID、公钥、D1 UUID、Worker 网址回填字段。\n• 创建 App、D1、Worker；Fork 仓库、编辑自己的 Wrangler、提交、同步分支、保存、部署；回填交互地址、打开安装链接、注册命令并核验。\n\n公开文字与控件标签会发给所选 AI；部署参数由本机采集保存回填；普通网页名称、地址和公开标识可交模型定位，秘密值不发模型。已加密保存的 Bot Token 可本机转填；手填时等你明确继续后保存部署。网页操作中暂时锁定触摸，点桌宠查看详情不会打断，点暂停后可接手。删除不自动执行；配置冲突须居中确认，先保存并读回核对旧连接，再允许本次切换；拒绝即停止。\n\n授权仅用于本次任务及当前会话。',
        },
        controller.signal,
      )
      return confirmed && !controller.signal.aborted
    } finally {
      signal?.removeEventListener('abort', cancel)
      if (this.consentController === controller) this.consentController = undefined
      if (suspended) await this.browser.restore({ resume: false })
    }
  }
  progressCursor() {
    return this.agentProgress
  }
  async continueAfterProgress(runId: string | undefined, cursor: number) {
    if (
      !runId ||
      runId !== this.agentOperationId ||
      !discordSetupSession.agentRunning ||
      !this.state ||
      this.state.step === 'done'
    )
      return
    if (setupStep(this.state.step).site !== 'local') {
      const hadActivity = this.agentActions.size > 0
      const page = await this.browser.inspect({ metadataOnly: this.state.step === 'cf-secret' })
      if (
        runId !== this.agentOperationId ||
        !discordSetupSession.agentRunning ||
        this.agentController?.signal.aborted
      )
        return
      if (page.loading) return
      if (page.paused && !this.canRecoverPage(page) && !this.canContinueSecret(page)) return
      if (page.controls?.length || page.headings?.length) this.observeProgress(page)
      // The first baseline alone does not justify a new model request.
      if (!hadActivity) return
    } else if (this.state.step === 'local-settings') return
    if (
      runId !== this.agentOperationId ||
      !discordSetupSession.agentRunning ||
      this.agentController?.signal.aborted ||
      this.agentProgress <= cursor
    )
      return
    this.requestAssistant(
      '代理任务已取得新进展，请接着执行。先 status/inspect 核对当前真实步骤和文档；不要重复已完成操作。按最新实际回执继续，不自行估算调用次数而停止；登录、密码、验证码和秘密输入时停下，Cloudflare GitHub App 的仓库选择与安装授权可由代理完成。',
    )
  }
  async settleAssistantTurn(
    runId: string | undefined,
    failed = false,
    toolBudgetExhausted = false,
  ) {
    if (
      !runId ||
      runId !== this.agentOperationId ||
      !discordSetupSession.agentRunning ||
      this.assistantRequested ||
      !this.state
    )
      return
    if (!failed && setupStep(this.state.step).site !== 'local') {
      const page = await this.browser.inspect({ metadataOnly: true })
      if (
        runId !== this.agentOperationId ||
        !discordSetupSession.agentRunning ||
        this.assistantRequested
      )
        return
      if (page.loading || page.paused) {
        await this.showAssistantProgress(
          page.loading
            ? '正在等待网页加载，加载完成后继续'
            : page.installationCompleted
              ? 'Discord 授权已完成，点桌宠继续资源库连接与命令核验'
              : this.state.step === 'discord-token'
                ? '等待你显示并保存 Bot Token'
                : this.state.step === 'cf-secret'
                  ? '等待密钥填写或部署核验，请点桌宠查看'
                  : '等待你接手，请点桌宠查看说明',
        )
        return
      }
    }
    await this.stopAgent()
    await this.browser.message({
      text: '',
      phase: failed
        ? '请求失败，已释放网页操作；点桌宠查看原因或继续'
        : toolBudgetExhausted
          ? '已达到你设置的工具上限，已释放网页操作；可继续或清空工具上限'
          : '本轮未返回后续操作且未核验到新进展，已释放网页操作；点桌宠查看或继续',
    })
  }
  private markAction(key: string) {
    if (!discordSetupSession.agentRunning || this.agentActions.has(key)) return false
    this.agentActions.add(key)
    this.agentProgress++
    return true
  }
  private canContinueSecret(page: DiscordBrowserSnapshot) {
    return (
      this.state?.step === 'cf-secret' &&
      (['prepare', 'submit', 'saved', 'submitted'].includes(page.secretStage ?? '') ||
        (page.secretStage === 'input' && this.state.botTokenReady === 'encrypted'))
    )
  }
  private observeProgress(page: DiscordBrowserSnapshot) {
    return this.markAction(
      JSON.stringify([
        'inspect',
        this.state?.step,
        page.url,
        page.pageKind,
        page.headings,
        page.controls
          ?.filter((control) => control.kind !== 'public-text')
          // Scrolling changes reachability, not task progress.
          .map((control) => ({ ...control, target: undefined, visible: undefined })),
        page.secretStage,
        page.failed,
      ]),
    )
  }
  private saveLocalForm?: () => Promise<boolean>
  async localConnectionDraft() {
    await this.initialize()
    const state = this.state
    if (state?.step !== 'local-settings' || state.mode !== 'agent' || !state.parameterResourceId)
      return
    const values = await this.parameters.read(state.parameterResourceId)
    if (this.state?.startedAt !== state.startedAt || this.state.step !== 'local-settings') return
    if (
      !values.applicationId ||
      !values.publicKey ||
      !values.workerUrl ||
      values.applicationId !== state.applicationId ||
      values.workerUrl !== state.workerUrl
    )
      throw new Error('本次连接参数与任务不一致，未填入表单')
    return { ...values, needsToken: state.botTokenReady !== 'encrypted' }
  }
  private async previousDatabaseId(values: DiscordSetupParameters) {
    if (!this.state || !values.databaseId || this.state.appliedDatabaseId === values.databaseId)
      return
    const saved = loadDiscordSourceConnectionSettings()
    if (
      this.state.appliedDatabaseId &&
      this.state.applicationId === saved.applicationId &&
      this.state.workerUrl === saved.workerBaseUrl
    )
      return this.state.appliedDatabaseId
    if (!this.state.connectionBackupResourceId) return
    let old: DiscordSetupParameters
    try {
      old = await this.parameters.read(this.state.connectionBackupResourceId)
    } catch (error) {
      if (error instanceof MissingDiscordSetupCardError) return
      throw error
    }
    if (
      old.applicationId === saved.applicationId &&
      old.publicKey === saved.publicKey &&
      old.workerUrl === saved.workerBaseUrl &&
      old.databaseId &&
      old.databaseId !== values.databaseId
    )
      return old.databaseId
  }
  async saveLocalConnectionSettings(value: DiscordSourceConnectionSettings) {
    await this.initialize()
    if (this.state?.step !== 'local-settings') return saveDiscordSourceConnectionSettings(value)
    const draft = await this.localConnectionDraft()
    if (draft?.needsToken && !value.botToken.trim())
      throw new Error('请先填写本次 Bot Token；原连接仍保留，尚未切换')
    const databaseId = draft ? await this.previousDatabaseId(draft) : undefined
    const result = await replaceDiscordSourceConnectionSettings(
      value,
      (previous) =>
        this.preservePreviousConnection(
          { ...previous, ...(databaseId ? { databaseId } : {}) },
          undefined,
          {
            applicationId: value.applicationId.trim(),
            workerUrl: checkedSetupWorkerUrl(value.workerBaseUrl),
          },
        ),
      this.agentController?.signal.aborted ? undefined : this.agentController?.signal,
      undefined,
      !!databaseId,
    )
    if (
      result &&
      draft?.databaseId &&
      result.applicationId === draft.applicationId &&
      result.publicKey === draft.publicKey &&
      result.workerBaseUrl === draft.workerUrl
    ) {
      this.state.appliedDatabaseId = draft.databaseId
      await this.save(this.state)
    }
    return result
  }
  attachLocalForm(save: () => Promise<boolean>) {
    if (this.saveLocalForm) throw new Error('已有连接设置窗口，不能重复接管')
    this.saveLocalForm = save
    return () => {
      if (this.saveLocalForm === save) this.saveLocalForm = undefined
    }
  }
  private async stopAgent() {
    this.consentController?.abort()
    this.preparationController?.abort()
    this.transferController?.abort()
    const operationId = this.agentOperationId
    this.agentController?.abort()
    this.assistantRequested = undefined
    discordSetupSession.agentRunning = false
    window.dispatchEvent(new Event('srl:discord-setup-stop'))
    await this.browser.pauseAgent()
    if (operationId) taskCenter.cancelled(operationId)
  }
  agentRunId() {
    return this.agentOperationId
  }
  pauseAgent(expectedRunId?: string) {
    if (expectedRunId && expectedRunId !== this.agentOperationId) return Promise.resolve()
    return this.stopAgent()
  }
  private async startAgent() {
    if (this.state?.mode !== 'agent' || this.state.step === 'done') return true
    if (this.agentController && !this.agentController.signal.aborted) return true
    const state = this.state
    if (this.consentStartedAt !== state.startedAt) {
      if (!(await this.confirmAgentPermissions())) return false
      if (this.state !== state) return false
      this.consentStartedAt = state.startedAt
    }
    this.agentController?.abort()
    await this.prepareParameters()
    this.agentController = new AbortController()
    this.agentProgress = 0
    this.agentActions.clear()
    discordSetupSession.agentRunning = true
    const operationId = crypto.randomUUID()
    this.agentOperationId = taskCenter.start({
      operationId,
      name: '蒜惹菈配置 Discord Bridge',
      phase: setupStep(this.state.step).title,
      cancelable: true,
      cancel: () => this.pauseAgent(operationId),
      action: {
        label: '查看配置',
        run: () => (operationId === this.agentOperationId ? this.open().then(() => {}) : undefined),
      },
    })
    return true
  }
  takeAssistantDraft(): string | undefined {
    const draft = this.assistantDraft
    this.assistantDraft = undefined
    return draft
  }
  peekAssistantDraft() {
    return this.assistantDraft
  }
  peekAssistantRequest() {
    return this.assistantRequested?.text
  }
  continueInTaskConversation() {
    if (!discordSetupSession.agentRunning || this.agentController?.signal.aborted) return false
    this.requestAssistant(
      '继续本次独立网页协助任务。先 status 核对真实步骤、卡片和保存字段，再 inspect 操作当前页面；不沿用普通聊天的上下文或旧回复。',
    )
    return true
  }
  takeAssistantRequest(): string | undefined {
    if (!this.assistantRequested) return
    const prompt = this.assistantRequested.text
    this.assistantRequested = undefined
    return prompt
  }
  async suspendForModelConsent() {
    if (!discordSetupSession.browserVisible) return false
    return (await this.browser.suspend()).suspended
  }
  async restoreAfterModelConsent(resume: boolean) {
    await this.browser.restore({ resume })
    if (!resume && discordSetupSession.agentRunning) await this.stopAgent()
  }
  async showAssistantReply(text: string) {
    if (!discordSetupSession.active || !text.trim()) return
    await this.browser.message({
      text: maskDiscordSetupSecrets(text).trim().slice(0, 16_000),
    })
  }
  async showAssistantProgress(phase: string) {
    if (!discordSetupSession.agentRunning || !phase.trim()) return
    const safePhase = maskDiscordSetupSecrets(phase).slice(0, 120)
    if (this.agentOperationId) taskCenter.update(this.agentOperationId, { phase: safePhase })
    await this.browser.message({ text: '', phase: safePhase })
  }
  async returnToBrowser(showControls = false) {
    await this.initialize()
    if (!this.state || this.state.step === 'done' || setupStep(this.state.step).site === 'local')
      throw new Error('当前步骤在资源库内处理，没有待返回的配置网页')
    return this.open(false, true, showControls)
  }
  constructor(
    storage: DiscordSetupStorage,
    browser: DiscordSetupBrowser = nativeDiscordSetupBrowser,
    parameters: DiscordSetupParameterResources = discordSetupParameterResources,
  ) {
    this.storage = storage
    this.browser = browser
    this.parameters = parameters
  }
  private initialize() {
    this.initialized ??= (async () => {
      this.state = await this.storage.read()
      await this.browser.addListener('setupAction', (event) => {
        if (event.action === 'quick-chat') {
          void this.userAction(event).catch(() => {})
          return
        }
        // Stop must bypass the operation queue: the queue may itself be waiting for a page/network.
        if (event.action === 'agent-pause') {
          void this.stopAgent().catch(() =>
            this.browser.message({
              text: '代理请求已停止；网页暂停确认失败，请关闭配置网页后再继续。',
            }),
          )
          return
        }
        if (event.action === 'return' && discordSetupSession.agentRunning)
          void this.stopAgent().catch(() => {})
        let interrupted: Promise<void> | undefined
        if (event.action === 'assist' && discordSetupSession.agentRunning) {
          try {
            if (this.assistantQuestion(event.text)) interrupted = this.stopAgent()
          } catch (error) {
            void this.browser.message({ text: error instanceof Error ? error.message : '问题无效' })
            return
          }
        }
        void this.serial(async () => {
          await interrupted
          await this.userAction(event)
        }).catch(() =>
          this.browser.message({
            text: '这一步未完成，请返回资源库查看或重试；已保存的步骤仍保留。',
          }),
        )
      })
    })().catch((error: unknown) => {
      this.initialized = undefined
      throw error
    })
    return this.initialized
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.catch(() => undefined).then(operation)
    this.pending = result
    return result
  }
  private async save(state: DiscordSetupState) {
    const changedStep = this.state?.step !== state.step
    await this.storage.save(state)
    this.state = state
    if (changedStep) this.markAction(`step:${state.step}`)
    discordSetupSession.active = state.step !== 'done'
    discordSetupSession.assistantConversationId =
      state.mode === 'agent' ? (state.assistantConversationId ?? '') : ''
    discordSetupSession.webStepActive =
      state.step !== 'done' && setupStep(state.step).site !== 'local'
    if (this.agentOperationId) {
      if (state.step === 'done') {
        this.assistantRequested = undefined
        taskCenter.complete(this.agentOperationId)
        this.agentController?.abort()
        discordSetupSession.agentRunning = false
      } else taskCenter.update(this.agentOperationId, { phase: setupStep(state.step).title })
    }
    window.dispatchEvent(new Event('srl:discord-setup-changed'))
  }
  async current() {
    await this.initialize()
    return this.state ? { ...this.state } : undefined
  }
  async assistantConversationId() {
    await this.initialize()
    if (!this.state || this.state.mode !== 'agent' || this.state.step === 'done') return
    if (!this.state.assistantConversationId)
      await this.save({ ...this.state, assistantConversationId: crypto.randomUUID() })
    return this.state.assistantConversationId
  }
  private browserEvidence(page: DiscordBrowserSnapshot) {
    const url = URL.canParse(page.url) ? new URL(page.url) : undefined
    return {
      ...(this.state?.step === 'discord-install'
        ? { installationCompleted: page.installationCompleted === true }
        : {}),
      browserPage: {
        host: url?.hostname ?? '',
        path: url && isSetupAgentUrl(url) ? maskDiscordSetupSecrets(url.pathname) : '/',
        access: page.pageAccess ?? 'unknown',
        state: page.failed
          ? 'connection-error'
          : page.loading
            ? 'loading'
            : page.paused
              ? 'paused'
              : 'ready',
        document_id: String(page.documentId),
      },
    }
  }
  private canRecoverPage(page: DiscordBrowserSnapshot) {
    return (
      this.state?.mode === 'agent' &&
      discordSetupSession.agentRunning &&
      !this.agentController?.signal.aborted &&
      page.failed === true &&
      !page.loading &&
      page.pageAccess === 'public' &&
      URL.canParse(page.url) &&
      isSetupAgentUrl(new URL(page.url))
    )
  }
  private summary() {
    return this.state
      ? {
          task: this.state.task,
          mode: this.state.mode ?? 'agent',
          parametersSaved: Boolean(this.state.parameterResourceId),
          parameterCardAction: this.state.parameterResourceId
            ? 'reuse-on-collection'
            : 'create-on-collection',
          botSecretSaved: this.state.botTokenReady === 'encrypted',
          step: this.state.step,
          title: setupStep(this.state.step).title,
          hint: this.stepHint(),
          forkKnown: Boolean(this.state.forkRepo),
          forkRepo: this.state.forkRepo,
          workerKnown: Boolean(this.state.workerUrl),
          ...(this.state.step === 'cf-deploy'
            ? {
                deploymentGoal: {
                  repository: this.state.forkRepo,
                  branch: 'main',
                  revision: this.state.githubRevision,
                  workerName: this.state.task.startsWith('update-')
                    ? this.state.workerUrl &&
                      new URL(this.state.workerUrl).hostname.endsWith('.workers.dev')
                      ? new URL(this.state.workerUrl).hostname.split('.')[0]
                      : undefined
                    : 'srl-discord-source-bridge',
                  reuseExistingWorker: this.state.task.startsWith('update-'),
                  deployCommand: 'npm run deploy',
                },
              }
            : {}),
        }
      : { hint: '尚未开始；更新前先问用户卡在哪一步。' }
  }
  private stepHint() {
    if (this.state?.mode === 'agent') {
      if (this.state.step === 'worker-url')
        return '助手在本次 Worker 详情定位 HTTPS 根网址，保存到本次任务和部署密钥卡，再继续填写 Discord 交互地址。不带 /interactions，不猜网址；本机连接设置留到 local-settings 一并回填，不提前替换旧配对目标。'
      if (this.state.step === 'discord-endpoint')
        return '助手在同一个 App 定位交互地址，填写已保存的 Worker 根网址 + /interactions，保存并核验结果，再自动继续；资源库保留根网址。'
      if (this.state.step === 'discord-install')
        return '助手打开同一个 App 的安装链接；你选择安装目标并授权。完成后在桌宠对话小窗点网页配置操作，再选择填好了，继续。'
      if (this.state.step === 'cf-secret')
        return '助手打开本次 Worker 的 Settings，添加 DISCORD_BOT_TOKEN 并选 Secret。已加密保存的 Token 由本机转填；否则停下来等你填值。保存部署后核验真实生产结果，模型不会收到密钥。'
      if (this.state.step === 'wrangler-edit')
        return '助手在自己的 Fork 打开完整 Wrangler 编辑器，使用本机保存的 App/Public Key/D1 参数填写整份模板，校验后提交；Bot Token 不写仓库。'
      if (this.state.step === 'discord-app')
        return '助手先看实际应用列表，有目标 App 就复用；尚未创建时自己找到入口、自选合法名称并创建（例如 SRL Bridge；名称不含 discord），按网站实际校验错误调整，再进入 General Information。本机读取并校验 Application ID 与 Public Key，存入部署密钥卡后自动继续。有多个无法确定的 App 时问你选择；下一步会打开 Bot 页面让你显示并加密保存 Token，或确认自行保存。'
      if (this.state.step === 'discord-token')
        return '请在本次 App 的 Bot 页完成网站验证并显示 Token，再点桌宠选择加密保存；也可自行保存后明确确认。完成之前不会去 Cloudflare。'
      if (this.state.step === 'd1-uuid')
        return '助手按本次库名从 D1 列表字段、实际数据库链接或详情地址采集 UUID，保存到同一张部署密钥卡，再自动继续 Fork 和 Wrangler；详情页不必显示 UUID。'
      if (this.state.step === 'local-settings')
        return 'App、公钥、Worker 和已加密保存的 Token 在本机回填到原连接设置；未保存 Token 时等你手填。助手沿原设置保存、注册并核验，模型不读取凭据。'
      if (this.state.step === 'd1-create')
        return '助手定位 D1 入口，使用或创建 srl-discord-source-handoff，按库名从列表或详情地址采集 UUID 后继续，无需切换助手模式；账号登录由你完成。'
      if (this.state.step === 'github-fork')
        return '助手 Fork 指定上游仓库，确认自己账号下的 Fork 来源后继续；登录授权由你完成。'
      if (this.state.step === 'cf-deploy' && this.state.task.startsWith('update-'))
        return '更新已配置的同一个 Worker。先观察 Fork 同步触发的实际生产部署；未触发时在原 Worker 处理，不新建或部署示例。生产成功后继续所选更新路线，保留已有 Secret、D1 和交互地址；只有更换 Worker 时先确认备份，再走完整的 Secret、端点与连接切换路线。'
      if (this.state.step === 'cf-deploy')
        return '目标是部署本次 Bridge Worker。先观察当前页和已有填写，按实际控件选择自己的 Git 仓库；构建命令与部署命令是不同字段，npm run deploy 填部署命令。已部署成功就按本次路线继续，首次配置下一步是 Secret；不要求仓库名称、分支和提交号在页面上一一匹配，不为凑证据反复打开 Settings、重新关联或重新构建。只有构建成功、网址变化或进入预览页不算生产部署成功；不要误部署 Hello World 示例。生产参数、D1 和连接健康留到后续核验，首次配置先保存部署 Secret。账号登录与网站验证由你完成；Cloudflare GitHub App 的仓库选择与安装授权由助手处理。'
    }
    return this.state ? setupStep(this.state.step).hint : ''
  }
  start(task: DiscordSetupTask, from?: DiscordSetupStep, mode: 'economy' | 'agent' = 'economy') {
    return this.serial(() => this.startTask(task, from, false, mode))
  }
  resume() {
    return this.serial(async () => {
      await this.initialize()
      if (!(await this.startAgent())) return { ...this.summary(), cancelled: true }
      return this.open()
    })
  }
  restart(task: DiscordSetupTask, mode: 'economy' | 'agent' = 'economy') {
    return this.serial(() => this.startTask(task, undefined, true, mode))
  }
  private async startTask(
    task: DiscordSetupTask,
    from?: DiscordSetupStep,
    restart = false,
    mode: 'economy' | 'agent' = 'economy',
    signal?: AbortSignal,
  ) {
    await this.initialize()
    if (this.state && this.state.step !== 'done' && !restart)
      throw new Error('已有未完成任务，请在居中弹窗选择继续上次配置或重新开始')
    if (
      !Object.hasOwn(DISCORD_SETUP_ROUTES, task) ||
      from === 'done' ||
      (from && !DISCORD_SETUP_ROUTES[task].includes(from))
    )
      throw new Error('配置任务或起始步骤无效；完成状态必须经过实际检查')
    const saved = loadDiscordSourceConnectionSettings()
    if (mode !== 'economy' && mode !== 'agent') throw new Error('请在居中弹窗选择部署协助模式')
    if (task === 'diagnose' && mode !== 'agent')
      throw new Error('桌宠排查请使用代理模式；本机检查仍在原连接设置')
    if (mode === 'agent' && !(await this.confirmAgentPermissions(signal)))
      return { ...this.summary(), cancelled: true, needsUserStep: false }
    signal?.throwIfAborted()
    if (mode === 'agent') await this.prepareParameters(signal)
    signal?.throwIfAborted()
    if (this.agentController && !this.agentController.signal.aborted) await this.stopAgent()
    if (
      task === 'configure' &&
      !from &&
      mode === 'agent' &&
      /^\d{17,20}$/u.test(saved.applicationId) &&
      /^[a-f0-9]{64}$/iu.test(saved.publicKey) &&
      saved.botToken &&
      saved.workerBaseUrl
    ) {
      const suspended = await this.suspendForModelConsent()
      let choice: Awaited<ReturnType<typeof chooseAction>>
      try {
        choice = await chooseAction(
          {
            title: '检测到已有 Discord Bridge 连接',
            centered: true,
            message:
              '本机已经保存过连接配置。可以复用并检查实际连接；也可以继续配置其他连接，遇到替换时会先询问并保存旧配置。已保存不等于当前部署仍可用。',
            confirmLabel: '复用并检查已有配置',
            alternativeLabel: '继续配置其他连接',
            cancelLabel: '停止配置',
          },
          signal,
        )
      } finally {
        if (suspended) await this.restoreAfterModelConsent(false)
      }
      if (choice === 'cancel' || choice === 'additional')
        return { ...this.summary(), cancelled: true, needsUserStep: false }
      if (choice === 'confirm') task = 'diagnose'
      signal?.throwIfAborted()
    }
    let parameterResourceId =
      (task === 'configure' && this.state?.task === 'configure') ||
      (task !== 'configure' && this.state?.applicationId === saved.applicationId)
        ? this.state?.parameterResourceId
        : undefined
    if (parameterResourceId) {
      try {
        await this.parameters.read(parameterResourceId)
      } catch (error) {
        if (!(error instanceof MissingDiscordSetupCardError)) throw error
        parameterResourceId = undefined
      }
    }
    signal?.throwIfAborted()
    this.collectionReceipt = undefined
    this.diagnosisReceipt = undefined
    await this.save({
      task,
      mode,
      step: from ?? DISCORD_SETUP_ROUTES[task][0]!,
      startedAt: Date.now(),
      assistantConversationId: mode === 'agent' ? crypto.randomUUID() : undefined,
      parameterResourceId,
      connectionBackupResourceId: this.state?.connectionBackupResourceId,
      connectionBackupFingerprint: this.state?.connectionBackupFingerprint,
      appliedDatabaseId:
        this.state?.applicationId === saved.applicationId &&
        this.state?.workerUrl === saved.workerBaseUrl
          ? this.state.appliedDatabaseId
          : undefined,
      botTokenReady: parameterResourceId ? this.state?.botTokenReady : undefined,
      applicationId: task === 'configure' ? undefined : saved.applicationId || undefined,
      workerUrl: task === 'configure' ? undefined : saved.workerBaseUrl || undefined,
      ...((task === 'configure' && this.state?.task === 'configure') ||
      (task !== 'configure' && this.state?.applicationId === saved.applicationId)
        ? {
            ...(task !== 'configure' ? { forkRepo: this.state.forkRepo } : {}),
          }
        : {}),
    })
    if (mode === 'agent') this.consentStartedAt = this.state!.startedAt
    if (task === 'configure' || task === 'diagnose' || from) await this.startAgent()
    await this.open(!['configure', 'diagnose'].includes(task) && !from, false)
    return { ...this.summary(), needsUserStep: !['configure', 'diagnose'].includes(task) && !from }
  }
  async open(chooseStep = false, resumeCurrent = true, showControls = false) {
    await this.initialize()
    if (!this.state) throw new Error('请先开始配置或更新任务')
    const step = setupStep(this.state.step)
    discordSetupSession.active = this.state.step !== 'done'
    discordSetupSession.assistantConversationId =
      this.state.mode === 'agent' ? (this.state.assistantConversationId ?? '') : ''
    discordSetupSession.webStepActive = step.site !== 'local'
    if (step.site === 'local') {
      await this.browser.close()
      let nextSettings: ReturnType<typeof loadDiscordSourceConnectionSettings> | undefined
      let previousDatabaseId: string | undefined
      let databaseChanged = false
      let databaseIdToApply: string | undefined
      const existingConnection = loadDiscordSourceConnectionSettings()
      const reuseUpdateConnection =
        this.state.task.startsWith('update-') &&
        this.state.applicationId === existingConnection.applicationId &&
        this.state.workerUrl === existingConnection.workerBaseUrl
      if (
        this.state.mode === 'agent' &&
        this.state.step === 'local-settings' &&
        this.state.parameterResourceId &&
        !reuseUpdateConnection
      ) {
        const values = await this.parameters.read(this.state.parameterResourceId)
        if (
          !values.applicationId ||
          !values.publicKey ||
          !values.workerUrl ||
          values.applicationId !== this.state.applicationId ||
          values.workerUrl !== this.state.workerUrl
        )
          throw new Error('密钥卡参数缺失或 App/Worker 不一致，请先核对')
        const saved = loadDiscordSourceConnectionSettings()
        databaseIdToApply = values.databaseId
        previousDatabaseId = await this.previousDatabaseId(values)
        databaseChanged = !!previousDatabaseId
        if (
          saved.applicationId !== values.applicationId ||
          saved.publicKey !== values.publicKey ||
          saved.workerBaseUrl !== values.workerUrl
        )
          nextSettings = {
            ...saved,
            applicationId: values.applicationId,
            publicKey: values.publicKey,
            workerBaseUrl: values.workerUrl,
            botToken: saved.applicationId === values.applicationId ? saved.botToken : '',
            commandRegistered: false,
            commandCheckedAt: 0,
            workerVerifiedAt: 0,
          }
      }
      let switched: DiscordSourceConnectionSettings | undefined
      if (
        this.state.step === 'local-settings' &&
        this.state.botTokenReady === 'encrypted' &&
        !reuseUpdateConnection
      ) {
        if (!this.state.parameterResourceId || !this.parameters.useBotSecret)
          throw new Error('本次加密 Bot Token 不可用，未替换原连接；请先恢复或填写本次 Token')
        await this.prepareParameters(this.agentController?.signal)
        await this.parameters.useBotSecret(
          this.state.parameterResourceId,
          async (botToken) => {
            this.agentController?.signal.throwIfAborted()
            switched = await replaceDiscordSourceConnectionSettings(
              {
                ...(nextSettings ?? loadDiscordSourceConnectionSettings()),
                botToken,
              },
              (previous) =>
                this.preservePreviousConnection({
                  ...previous,
                  ...(previousDatabaseId ? { databaseId: previousDatabaseId } : {}),
                }),
              this.agentController?.signal,
              undefined,
              databaseChanged,
            )
          },
          this.agentController?.signal,
        )
        if (!switched) return { ...this.summary(), cancelled: true, waitingForUser: true }
        window.dispatchEvent(new Event('srl:discord-setup-credentials'))
      }
      if (switched && databaseIdToApply && this.state.appliedDatabaseId !== databaseIdToApply) {
        this.state.appliedDatabaseId = databaseIdToApply
        await this.save(this.state)
      }
      startAssistantGuidance('inbox-connection', 'inbox')
      if (this.state.step === 'local-settings' && this.state.workerUrl)
        window.dispatchEvent(
          new CustomEvent('srl:discord-setup-worker', {
            detail: { workerUrl: this.state.workerUrl },
          }),
        )
      window.dispatchEvent(new CustomEvent('srl:native-deep-link', { detail: { kind: 'inbox' } }))
      window.dispatchEvent(new Event('srl:discord-setup-settings'))
      if (this.state.step === 'diagnose' && discordSetupSession.agentRunning)
        this.requestAssistant(
          '先 status 核对本次独立排查任务，然后调用 diagnose（from=diagnose）。只报告工具的真实检查结果；按问题调用 repair 选择配置/更新路线及修复起点，保持本次对话，秘密、登录验证和 Discord 安装授权交用户；Cloudflare GitHub App 的仓库安装授权由代理核对并完成。',
        )
      if (
        this.state.step === 'local-settings' &&
        (this.state.botTokenReady === 'encrypted' ||
          (existingConnection.applicationId === this.state.applicationId &&
            existingConnection.workerBaseUrl === this.state.workerUrl &&
            /^\d{17,20}$/u.test(existingConnection.applicationId) &&
            /^[a-f0-9]{64}$/iu.test(existingConnection.publicKey) &&
            !!existingConnection.botToken.trim())) &&
        discordSetupSession.agentRunning
      )
        this.requestAssistant(
          '本机连接参数已就绪，请沿原表单保存并继续连接、命令注册与最终核验；复用已有凭据，模型不读取或返回密钥值。',
        )
      return this.summary()
    }
    await this.browser.open({
      url: discordSetupUrl(this.state),
      site: step.site,
      step: this.state.step,
      title: step.title,
      hint: this.stepHint(),
      steps: DISCORD_SETUP_ROUTES[this.state.task]
        .filter((id) => id !== 'done')
        .map((id) => ({ id, title: setupStep(id).title })),
      template: DISCORD_BRIDGE_WRANGLER_TEMPLATE,
      darkTheme: document.documentElement.dataset.theme === 'dark',
      mode: this.state.mode ?? 'agent',
      conversationId: this.state.mode === 'agent' ? this.state.assistantConversationId : undefined,
      expectedApplicationId: this.state.applicationId,
      agentRunId:
        this.agentController && !this.agentController.signal.aborted
          ? this.agentOperationId
          : undefined,
      ...(chooseStep ? { chooseStep: true } : {}),
      ...(showControls ? { showControls: true } : {}),
      ...(resumeCurrent ? { resumeCurrent: true } : {}),
    })
    return this.summary()
  }
  select(step: DiscordSetupStep) {
    return this.serial(() => this.selectStep(step))
  }
  private async selectStep(step: DiscordSetupStep) {
    await this.initialize()
    if (!this.state || step === 'done' || !DISCORD_SETUP_ROUTES[this.state.task].includes(step))
      throw new Error('这个步骤不属于当前任务，完成状态必须经过实际检查')
    if (
      this.state.mode === 'agent' &&
      !discordSetupSession.agentRunning &&
      !(await this.startAgent())
    )
      return { ...this.summary(), cancelled: true }
    await this.save({ ...this.state, step })
    return this.open()
  }
  private async rememberPage(page: DiscordBrowserSnapshot) {
    if (!this.state) return
    const url = new URL(page.url)
    const site = setupStep(this.state.step).site
    const expectedHost =
      site === 'discord' ? 'discord.com' : site === 'github' ? 'github.com' : 'dash.cloudflare.com'
    if (
      !isSetupAgentUrl(url) ||
      (this.state.mode !== 'agent' && (site === 'local' || url.hostname !== expectedHost))
    )
      throw new Error('当前网页不属于已授权的 Discord、GitHub、Cloudflare 或 workers.dev 配置页面')
    const next = { ...this.state }
    const app =
      url.hostname === 'discord.com' &&
      url.pathname.match(/^\/developers\/applications\/(\d{17,20})(?:\/|$)/u)
    if (app) {
      if (next.applicationId && next.applicationId !== app[1] && this.state.step !== 'discord-app')
        throw new Error('当前 Discord App 与配置任务不一致，请先核对自己的 App')
      next.applicationId = app[1]
    }
    const fork =
      url.hostname === 'github.com' &&
      url.pathname.match(/^\/([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+)(?:\/|$)/u)
    if (
      fork &&
      page.forkOfTarget === true &&
      fork[1] !== 'jixiangruyi117/SRL-Discord-Bridge' &&
      (!next.forkRepo || next.forkRepo === fork[1])
    )
      next.forkRepo = fork[1]
    if (JSON.stringify(next) !== JSON.stringify(this.state)) await this.save(next)
  }
  private requireFork(page: DiscordBrowserSnapshot) {
    const url = new URL(page.url)
    if (
      !this.state?.forkRepo ||
      url.hostname !== 'github.com' ||
      !url.pathname.startsWith(`/${this.state.forkRepo}/`) ||
      !/\/(?:edit|blob)\/main\/wrangler\.jsonc$/u.test(url.pathname)
    )
      throw new Error('请先进入自己 Fork 的 main/wrangler.jsonc 编辑页面；不能修改上游仓库')
  }
  async execute(
    args: Record<string, string>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.serial(async () => {
      await this.initialize()
      signal.throwIfAborted()
      if (args.operation === 'start') {
        const result = await this.startTask(
          args.task as DiscordSetupTask,
          args.from as DiscordSetupStep | undefined,
          false,
          (args.mode || 'economy') as 'economy' | 'agent',
          signal,
        )
        return { ok: !('cancelled' in result && result.cancelled), ...result }
      }
      if (args.operation === 'status') {
        let installation: Record<string, unknown> = {}
        if (this.state?.step === 'discord-install') {
          try {
            const page = await this.browser.inspect({ metadataOnly: true })
            installation = {
              browserAvailable: true,
              installationCompleted: page.installationCompleted === true,
              ...(page.installationCompleted
                ? {
                    hint: 'Discord 已确认本次 App 授权完成，不再要求登录授权；等待用户点桌宠继续，随后完成资源库连接与命令核验。',
                  }
                : {}),
            }
          } catch (cause) {
            installation = {
              browserAvailable: false,
              browserError: maskDiscordSetupSecrets(
                cause instanceof Error ? cause.message : '配置网页状态暂不可读取',
              ),
              hint: '当前浏览器状态未读到；用 open 恢复保留的网页再观察，不能据此认定网页打不开或要求重新登录。',
            }
          }
        }
        return { ok: true, ...this.summary(), ...(await this.parameterStatus()), ...installation }
      }
      if (args.operation === 'open') return { ok: true, ...(await this.open(false, true)) }
      if (args.operation === 'return') {
        if (discordSetupSession.agentRunning) await this.stopAgent()
        await this.browser.close()
        return { ok: true, ...this.summary() }
      }
      if (!this.state) throw new Error('请先开始 Discord 配置任务')
      if (args.operation === 'pause') {
        await this.stopAgent()
        return { ok: true, ...this.summary(), paused: true, waitingForUser: true }
      }
      if (this.state.mode === 'agent' && this.consentStartedAt !== this.state.startedAt) {
        if (!(await this.confirmAgentPermissions(signal)))
          return { ok: false, ...this.summary(), cancelled: true, waitingForUser: true }
        signal.throwIfAborted()
        this.consentStartedAt = this.state.startedAt
      }
      if (args.operation === 'repair') {
        if (
          this.state.step !== 'diagnose' ||
          this.diagnosisReceipt?.startedAt !== this.state.startedAt ||
          !discordSetupSession.agentRunning ||
          this.agentController?.signal.aborted
        )
          throw new Error('请先在活动排查任务中完成 diagnose，再选择修复路径')
        const currentSettings = loadDiscordSourceConnectionSettings()
        if (
          ['workerBaseUrl', 'applicationId', 'publicKey', 'botToken'].some(
            (key) =>
              this.diagnosisReceipt!.settings[key as keyof typeof currentSettings] !==
              currentSettings[key as keyof typeof currentSettings],
          )
        ) {
          this.diagnosisReceipt = undefined
          throw new Error('本机连接配置已变化，请重新排查后选择修复路径')
        }
        const task = args.task as DiscordSetupTask,
          from = args.from as DiscordSetupStep
        if (
          task === 'diagnose' ||
          from === 'done' ||
          !Object.hasOwn(DISCORD_SETUP_ROUTES, task) ||
          !DISCORD_SETUP_ROUTES[task].includes(from)
        )
          throw new Error('修复路线或起点无效，不直接标记完成')
        signal.throwIfAborted()
        await this.save({ ...this.state, task, step: from })
        this.diagnosisReceipt = undefined
        this.markAction(`repair:${task}:${from}`)
        return { ok: true, ...(await this.open()) }
      }
      if (['advance-step', 'verify-local', 'diagnose'].includes(args.operation)) {
        if (
          this.state.mode !== 'agent' ||
          !discordSetupSession.agentRunning ||
          this.agentController?.signal.aborted
        )
          throw new Error('代理任务已停止；请用户明确继续后再操作')
        if (args.from !== this.state.step)
          throw new Error('任务步骤已变化，请先查看 status；不重复推进')
        const agentSignal = this.agentController!.signal
        const cancel = () => controller.abort()
        const controller = new AbortController()
        const modelCancel = () => controller.abort()
        signal.addEventListener('abort', modelCancel, { once: true })
        agentSignal.addEventListener('abort', cancel, { once: true })
        if (agentSignal.aborted || signal.aborted) controller.abort()
        try {
          if (args.operation === 'diagnose') {
            if (this.state.step !== 'diagnose') throw new Error('当前不是配置排查步骤')
            this.diagnosisReceipt = undefined
            const settings = loadDiscordSourceConnectionSettings()
            const diagnosis = await diagnoseDiscordConfiguration(settings, controller.signal)
            signal.throwIfAborted()
            controller.signal.throwIfAborted()
            const current = loadDiscordSourceConnectionSettings()
            if (
              ['workerBaseUrl', 'applicationId', 'publicKey', 'botToken'].some(
                (key) =>
                  settings[key as keyof typeof settings] !== current[key as keyof typeof current],
              )
            )
              throw new Error('本机连接配置已变化，请重新排查')
            this.diagnosisReceipt = { startedAt: this.state.startedAt, settings }
            this.markAction(JSON.stringify(diagnosis))
            return { ok: true, ...this.summary(), diagnosis }
          }
          await this.verifyAgentStep(args, controller.signal)
          signal.throwIfAborted()
          controller.signal.throwIfAborted()
          return { ok: true, ...(await this.advanceStep(true)), verified: true }
        } finally {
          signal.removeEventListener('abort', modelCancel)
          agentSignal.removeEventListener('abort', cancel)
        }
      }
      if (['wait-page', 'wait-status'].includes(args.operation) && this.state.mode === 'agent') {
        const agentSignal = this.agentController?.signal
        if (
          args.operation === 'wait-status' &&
          (!discordSetupSession.agentRunning || !agentSignal || agentSignal.aborted)
        )
          throw new Error('代理任务已停止；请用户明确继续后再等待')
        if (
          args.operation === 'wait-status' &&
          (!/^\d{1,10}$/u.test(args.target || '') || !/^\d+$/u.test(args.document_id || ''))
        )
          throw new Error('请先观察当前部署/同步页的实际状态，再等待其变化')
        const cancel = () => {
          void this.browser.cancelWait()
        }
        signal.addEventListener('abort', cancel, { once: true })
        agentSignal?.addEventListener('abort', cancel, { once: true })
        try {
          const ready =
            args.operation === 'wait-status'
              ? await this.browser.waitStatus({
                  documentId: Number(args.document_id),
                  target: args.target!,
                })
              : await this.browser.waitReady()
          signal.throwIfAborted()
          agentSignal?.throwIfAborted()
          const recoveryNavigation = this.canRecoverPage(ready)
          return {
            ok: true,
            ...this.summary(),
            documentId: ready.documentId,
            ...this.browserEvidence(ready),
            loading: ready.loading === true,
            waitingForPage: ready.loading === true,
            waitingForUser: ready.paused && !ready.loading && !recoveryNavigation,
            ...(recoveryNavigation
              ? {
                  recoveryNavigation: true,
                  hint: '公开网页加载失败；可用 navigate 返回其他已授权配置页，不自动重试失败网址。',
                }
              : {}),
          }
        } finally {
          signal.removeEventListener('abort', cancel)
          agentSignal?.removeEventListener('abort', cancel)
        }
      }
      if (this.state.mode === 'economy')
        return {
          ok: false,
          waitingForUser: true,
          ...this.summary(),
          hint: '省 Token 模式只使用本机步骤、模板、指路和格式检查；请用户操作网页，不调用模型循环查看控件。',
        }
      const query = args.operation === 'inspect' ? (args.query || '').trim() : ''
      if (
        query.length > 80 ||
        [...query].some((character) => character.charCodeAt(0) < 32) ||
        maskDiscordSetupSecrets(query) !== query
      )
        throw new Error('搜索使用页面标签或标题，不传配置值')
      let page = await this.browser.inspect({
        metadataOnly: this.state.step === 'cf-secret' || args.operation !== 'inspect',
        ...(query ? { query } : {}),
      })
      signal.throwIfAborted()
      if (
        args.operation === 'inspect' &&
        this.state.step === 'cf-secret' &&
        (!page.secretStage || ['prepare', 'submit', 'saved'].includes(page.secretStage)) &&
        (!page.paused || !!page.secretStage) &&
        !page.loading
      )
        page = await this.browser.inspect({ metadataOnly: false, ...(query ? { query } : {}) })
      signal.throwIfAborted()
      if (page.loading)
        return {
          ok: true,
          ...this.summary(),
          documentId: page.documentId,
          loading: true,
          ...this.browserEvidence(page),
          waitingForPage: true,
          waitingForUser: false,
          hint: '网页正在加载；用 wait-page 等待加载完成，再 inspect 当前页面。不要重复导航或使用旧控件。',
        }
      const recoveryNavigation = this.canRecoverPage(page)
      if (recoveryNavigation) {
        if (args.operation !== 'navigate')
          return {
            ok: args.operation === 'inspect',
            ...this.summary(),
            documentId: page.documentId,
            ...this.browserEvidence(page),
            recoveryNavigation: true,
            waitingForUser: false,
            hint: '当前公开网页加载失败；可用 navigate 返回已授权配置页，不自动重试失败网址，不在错误页点击或核验成功。',
          }
      }
      if (
        page.paused &&
        !recoveryNavigation &&
        !(this.state.step === 'cf-secret' && page.secretStage)
      )
        return {
          ok: false,
          waitingForUser: true,
          ...this.summary(),
          documentId: page.documentId,
          ...this.browserEvidence(page),
          hint: page.failed
            ? '当前网页连接失败，不能认定登录或授权未完成；以 browserPage 当前网站和状态为准。'
            : page.pageAccess === 'authentication'
              ? '当前实际网页是登录或授权页面，请用户完成当前网站的操作；不要沿历史要求另一网站的授权。'
              : page.pageAccess === 'protected'
                ? '当前实际网页受秘密保护，请用户完成本页操作；不能据此要求另一网站重新授权。'
                : '当前网页协助已暂停，不代表登录或授权未完成。以 browserPage 当前网站和路径为准，不沿历史猜测授权页、按钮或网站验证；用户明确继续后重新观察当前页。',
        }
      await this.rememberPage(page)
      if (!page.paused && !page.loading && (page.controls?.length || page.headings?.length))
        this.observeProgress(page)
      const secretPublicControls =
        discordSetupSession.agentRunning &&
        this.consentStartedAt === this.state.startedAt &&
        page.pageAccess !== 'authentication' &&
        this.state.step === 'cf-secret' &&
        ['prepare', 'submit', 'saved'].includes(page.secretStage ?? '')
      if (this.state.step === 'cf-secret' && page.secretStage) {
        if (args.operation === 'inspect' && page.secretStage !== 'prepare')
          return {
            ok: true,
            ...this.summary(),
            documentId: page.documentId,
            secretStage: page.secretStage,
            ...(page.secretSavedOnPage !== undefined
              ? { secretSavedOnPage: page.secretSavedOnPage }
              : {}),
            ...(['submit', 'saved'].includes(page.secretStage)
              ? { controls: page.controls ?? [], headings: page.headings ?? [] }
              : {}),
            ...this.browserEvidence(page),
            waitingForUser: ![
              'prepare',
              'submit',
              'saved',
              'submitted',
              ...(this.state.botTokenReady === 'encrypted' ? ['input'] : []),
            ].includes(page.secretStage ?? ''),
          }
        if (args.operation === 'prepare-secret' || args.operation === 'submit-secret') {
          if (String(page.documentId) !== args.document_id)
            throw new Error('网页已变化，请重新查看步骤')
          return this.secretAction(args.operation, page, args)
        }
        if (args.operation === 'transfer-secret') {
          if (String(page.documentId) !== args.document_id)
            throw new Error('网页已变化，请重新查看步骤')
          return this.fillStoredBotSecret(page, signal)
        }
        if (page.pageAccess === 'authentication')
          return {
            ok: false,
            ...this.summary(),
            ...this.browserEvidence(page),
            waitingForUser: true,
            hint: '当前网页实际要求密码或网站验证，请用户完成后继续；不要求重复添加 Secret。',
          }
        if (!secretPublicControls)
          throw new Error('Secret 输入阶段只允许本机盲转填和经用户确认的保存部署，不读取秘密值')
        if (
          !['inspect', 'click', 'select', 'focus', 'scroll', 'navigate', 'fill'].includes(
            args.operation!,
          )
        )
          throw new Error(
            'Secret 可自主查找和操作公开控件；名称与类型用 prepare-secret，值用本机盲转填',
          )
      }
      if (args.operation === 'inspect') {
        return {
          ok: true,
          ...this.summary(),
          ...(await this.parameterStatus()),
          documentId: page.documentId,
          paused: page.paused,
          ...this.browserEvidence(page),
          waitingForUser: page.paused,
          ...(page.secretStage ? { secretStage: page.secretStage } : {}),
          ...(page.secretSavedOnPage !== undefined
            ? { secretSavedOnPage: page.secretSavedOnPage }
            : {}),
          controls: page.controls ?? [],
          pageKind: page.pageKind,
          headings: page.headings ?? [],
          ...(page.searchMatched !== undefined
            ? {
                searchMatched: page.searchMatched,
                ...(page.searchMatched === false
                  ? {
                      hint: '本次关键词没有匹配到控件或标题，不代表网页空白。参考当前页面标题，省略 query 观察实际入口，或换成页面上的短标签；不要重复原搜索或让用户代找。',
                    }
                  : {}),
              }
            : {}),
          ...(page.applicationList ? { applicationList: page.applicationList } : {}),
          ...(page.truncated !== undefined ? { truncated: page.truncated } : {}),
        }
      }
      if (page.paused && !recoveryNavigation && !secretPublicControls)
        return {
          ok: false,
          ...this.summary(),
          waitingForUser: true,
          hint: '请用户完成登录或填写，再点击浏览器的“允许协助”；不采集登录页或秘密。',
        }
      if (args.operation !== 'navigate' && String(page.documentId) !== args.document_id)
        throw new Error('网页已变化，请重新 inspect，不执行旧页面操作')
      if (args.operation === 'scroll' && args.direction && !['up', 'down'].includes(args.direction))
        throw new Error('滚动方向只支持 up/down')
      if (args.operation === 'fill-endpoint' || args.operation === 'open-install')
        return this.discordPublicAction(args.operation, page, args.target)
      if (
        args.operation === 'fill' &&
        (args.field === 'interactions-url' || args.source === 'interactions-url')
      )
        return this.discordPublicAction('fill-endpoint', page, args.target)
      if (args.operation === 'collect-config' || args.operation === 'fill-config') {
        if (args.operation === 'collect-config') await this.collectParameters(page, args)
        else await this.fillParameters(page)
        signal.throwIfAborted()
        return {
          ok: true,
          ...this.summary(),
          ...(await this.parameterStatus()),
          ...(args.operation === 'fill-config'
            ? { waitingForUser: !discordSetupSession.agentRunning, written: true }
            : {}),
        }
      }
      const control = page.controls?.find((item) => item.target === args.target)
      if (
        new URL(page.url).hostname === 'github.com' &&
        args.operation === 'click' &&
        /sync fork|update branch|同步|更新分支/iu.test(control?.label ?? '')
      ) {
        if (!page.forkOfTarget || !isSetupForkPage(new URL(page.url), this.state.forkRepo))
          throw new Error('请先打开指定仓库在自己账号下的 Fork，不同步上游或其它仓库')
      }
      if (
        ['template', 'validate'].includes(args.operation!) ||
        (args.operation === 'click' &&
          new URL(page.url).hostname === 'github.com' &&
          /\/edit\//u.test(new URL(page.url).pathname) &&
          /commit|save|提交|保存/iu.test(control?.label ?? ''))
      )
        this.requireFork(page)
      if (args.operation === 'template' && this.state.mode === 'agent') {
        await this.fillParameters(page)
        return {
          ok: true,
          ...this.summary(),
          waitingForUser: !discordSetupSession.agentRunning,
          written: true,
        }
      }
      const values: Record<string, string | undefined> = {
        'app-name': 'SRL Bridge',
        'database-name': 'srl-discord-source-handoff',
        'worker-name': 'srl-discord-source-bridge',
        'deploy-command': 'npm run deploy',
        'repository-search': 'SRL-Discord-Bridge',
        'commit-message': 'Configure Discord Bridge',
      }
      let fillValue =
        args.field && Object.hasOwn(values, args.field) ? values[args.field] : undefined
      if (args.operation === 'fill') {
        const choices = [
          args.field !== undefined,
          args.value !== undefined,
          args.source !== undefined,
        ]
        if (choices.filter(Boolean).length !== 1)
          throw new Error('填写必须选择一个来源：固定 field、普通 value 或本机 source')
        if (args.field && fillValue === undefined)
          throw new Error('不支持此快捷字段；普通公开表单可用 value/source，登录和密钥由用户填写')
        if (fillValue !== undefined || args.value !== undefined || args.source !== undefined) {
          if (!discordSetupSession.agentRunning || this.consentStartedAt !== this.state.startedAt)
            throw new Error('请先确认代理权限并启动本次任务')
          if (
            !control ||
            control.sensitive ||
            !['input', 'textarea', 'textbox', 'combobox', 'searchbox', 'spinbutton'].includes(
              control.kind,
            )
          )
            throw new Error('只能填写已观察到的普通非秘密输入框')
          if (args.value !== undefined) {
            if (
              args.value.length > 4000 ||
              args.value.includes(String.fromCharCode(0)) ||
              /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+|\bsk-(?:proj|live)-|DISCORD_BOT_TOKEN\s*[:=]/iu.test(
                args.value,
              )
            )
              throw new Error('普通填写只接受最多4000字符的非秘密文本；秘密留在网页手填')
            fillValue = args.value
          } else if (args.source !== undefined) {
            if (!this.state.parameterResourceId) throw new Error('请先在本机保存部署参数')
            const parameters = await this.parameters.read(this.state.parameterResourceId)
            if (
              parameters.applicationId &&
              this.state.applicationId &&
              parameters.applicationId !== this.state.applicationId
            )
              throw new Error('本机参数卡与当前 App 不一致，未填写')
            const sources: Record<string, string | undefined> = {
              'application-id': parameters.applicationId,
              'public-key': parameters.publicKey,
              'database-id': parameters.databaseId,
              'worker-url': parameters.workerUrl,
              'interactions-url': parameters.workerUrl
                ? `${checkedSetupWorkerUrl(parameters.workerUrl)}/interactions`
                : undefined,
            }
            fillValue = Object.hasOwn(sources, args.source!) ? sources[args.source!] : undefined
            if (!fillValue) throw new Error('本机参数来源无效或尚未保存，不猜测数值')
          }
          signal.throwIfAborted()
          if (!discordSetupSession.agentRunning || this.agentController?.signal.aborted)
            throw new Error('代理任务已停止；未填写内容')
        }
      }
      if (args.operation === 'navigate') {
        if (!discordSetupSession.agentRunning || this.consentStartedAt !== this.state.startedAt)
          throw new Error('请先确认代理权限并启动本次任务')
        const destination = new URL(args.url || '', page.url)
        if (recoveryNavigation && destination.href === new URL(page.url).href)
          throw new Error('失败网页不自动重试；请返回其他已授权配置页')
        if (!args.url || args.url.length > 2000 || !isSetupAgentUrl(destination))
          throw new Error(
            '本次代理导航支持已授权的 Discord、GitHub、Cloudflare 和 workers.dev HTTPS 页面',
          )
        const receipt = await this.browser.act({
          documentId: page.documentId,
          operation: 'navigate',
          url: destination.href,
        })
        signal.throwIfAborted()
        if (receipt.ok && receipt.dispatched)
          this.markAction(JSON.stringify([this.state.step, page.url, 'navigate', destination.href]))
        return { ...receipt, ...this.summary() }
      }
      if (args.operation === 'collect-worker') {
        await this.collectWorker(page, args.target)
        return {
          ok: true,
          ...this.summary(),
          hint: '已从当前部署页回填 Worker 根链接；部署成功仍需实际连接检查。',
        }
      }
      if (
        this.state.step === 'github-save' &&
        args.operation === 'click' &&
        /commit|提交|保存/iu.test(control?.label ?? '')
      ) {
        // The modal may hide the editor; validate when opening Commit, not the subsequent modal receipt.
        if (/\/edit\/main\/wrangler\.jsonc$/u.test(new URL(page.url).pathname))
          await this.validate(page)
      }
      const result =
        args.operation === 'validate'
          ? await this.validate(page)
          : await this.browser.act({
              documentId: page.documentId,
              operation: args.operation!,
              step: this.state.step,
              target: args.target,
              expectedFork: this.state.forkRepo,
              value: args.operation === 'fill' ? fillValue : undefined,
              ...(args.operation === 'scroll'
                ? { direction: (args.direction || 'down') as 'up' | 'down' }
                : {}),
              template:
                args.operation === 'template' ? DISCORD_BRIDGE_WRANGLER_TEMPLATE : undefined,
            })
      signal.throwIfAborted()
      if (result.configurationConflict === true && args.operation === 'fill')
        return this.discordPublicAction('fill-endpoint', page, args.target)
      if (
        result.ok === true &&
        (result.dispatched || result.written || result.filled || result.moved)
      )
        this.markAction(
          JSON.stringify([
            this.state.step,
            page.url,
            args.operation,
            args.field || '',
            args.source || '',
            args.operation === 'fill' && args.value !== undefined ? args.value : '',
            args.operation === 'scroll' ? args.direction || 'down' : '',
            control?.kind || '',
            control?.label || '',
            page.pageKind || '',
            (page.headings ?? []).slice(0, 3),
          ]),
        )
      return { ...this.summary(), ...result }
    })
  }
  private async validate(page: DiscordBrowserSnapshot) {
    this.requireFork(page)
    const result = await this.browser.act({
      documentId: page.documentId,
      operation: 'validate',
      expectedApplicationId: this.state?.applicationId,
    })
    if (result.ok !== true)
      throw new Error(
        Array.isArray(result.errors)
          ? result.errors.join('；')
          : '未能读取完整编辑内容，请在当前编辑器检查格式',
      )
    return result
  }
  private async verifyAgentStep(args: Record<string, string>, signal: AbortSignal) {
    if (!this.state) throw new Error('尚未开始配置')
    if (this.state.step === 'diagnose')
      throw new Error('排查结果不等于配置完成；请先检查并选择实际修复路径')
    const step = this.state.step
    if (['cf-deploy', 'cf-secret'].includes(step) && !this.state.applicationId)
      throw new Error('请先确认本次 Discord App，不能核验未知 App 的部署')
    if (setupStep(step).site === 'local') {
      if (step === 'local-settings') {
        if (this.saveLocalForm && !(await this.saveLocalForm()))
          throw new Error('本机连接设置尚未保存，请在原设置只填写 Bot Token')
        signal.throwIfAborted()
        return // advanceStep validates the original form's locally saved target and credential.
      }
      const saved = loadDiscordSourceConnectionSettings()
      if (!['register', 'verify'].includes(step)) throw new Error('当前没有可核验的操作')
      if (
        (this.state.applicationId && saved.applicationId !== this.state.applicationId) ||
        (this.state.workerUrl && saved.workerBaseUrl !== this.state.workerUrl)
      )
        throw new Error('本机 App 或 Worker 与任务目标不一致')
      await checkDiscordWorker(saved, 'health', signal)
      const result = await checkDiscordWorker(
        saved,
        step === 'register' ? 'register' : 'status',
        signal,
      )
      signal.throwIfAborted()
      if (!result.commandRegistered) throw new Error('真实命令检查未通过，未标记完成')
      saveDiscordSourceConnectionStatus({
        workerVerifiedAt: Date.now(),
        commandCheckedAt: Date.now(),
        commandRegistered: true,
      })
      return
    }
    const page = await this.browser.inspect({ metadataOnly: step !== 'cf-secret' })
    signal.throwIfAborted()
    if (String(page.documentId) !== args.document_id) throw new Error('网页已变化，请重新 inspect')
    await this.rememberPage(page)
    if (step === 'cf-secret') {
      if (page.secretStage !== 'submitted' && page.secretSavedOnPage !== true)
        throw new Error(
          '尚未核验到 Secret 保存部署；待填写秘密值时等用户，否则 inspect 实际表单或列表，不推断保存失败',
        )
      if (page.secretStage !== 'submitted') this.requireSecretWorker(page)
      if (!this.state.workerUrl) throw new Error('本次 Worker 根网址尚未确认，不能核验生产健康')
      const health = await checkDiscordWorker(
        { applicationId: this.state.applicationId!, workerBaseUrl: this.state.workerUrl },
        'health',
        signal,
      )
      if (!health.configured)
        throw new Error('当前生产 Worker 尚未确认 Discord 参数完整，请查看部署结果')
      if (page.secretStage !== 'submitted' && this.state.botTokenReady === 'encrypted') {
        const state = this.state
        if (!state.parameterResourceId || !this.parameters.useBotSecret)
          throw new Error('本机加密 Token 尚未就绪，不能核验已保存 Secret 与本次凭据的一致性')
        await this.prepareParameters(signal)
        const values = await this.parameters.read(state.parameterResourceId)
        if (values.applicationId !== state.applicationId || values.workerUrl !== state.workerUrl)
          throw new Error('密钥资料卡与本次 App/Worker 不一致，未核验已有 Secret')
        await this.parameters.useBotSecret(
          state.parameterResourceId,
          async (secret) => {
            signal.throwIfAborted()
            await checkDiscordWorker(
              {
                applicationId: state.applicationId!,
                workerBaseUrl: state.workerUrl!,
                botToken: secret,
              },
              'status',
              signal,
            )
          },
          signal,
        )
      }
      return
    }
    if (page.paused) throw new Error('请等待用户登录或授权；不越过用户接手')
    if (['discord-app', 'd1-create', 'd1-uuid'].includes(step)) {
      if (setupParameterStep(page.url) !== (step === 'discord-app' ? 'discord-app' : 'd1-uuid'))
        throw new Error('当前页面无法核验此步骤，请定位本次 App 或 D1 数据库后继续')
      if (!(await this.collectedHere(page))) await this.collectParameters(page, args)
      return
    }
    if (step === 'github-fork') {
      if (!page.forkOfTarget || !isSetupForkPage(new URL(page.url), this.state.forkRepo))
        throw new Error('尚未确认指定上游仓库在自己账号下的 Fork')
      return
    }
    if (['wrangler-edit', 'wrangler-check'].includes(step)) {
      await this.validate(page)
      return
    }
    if (step === 'worker-url') {
      if (!(await this.hasConfirmedWorkerRoot(page))) await this.collectWorker(page, args.target)
      return
    }
    if (step === 'discord-install')
      throw new Error('安装授权由用户完成；请等待用户点桌宠“填好了，继续”，不能自行确认授权')
    if (!['github-sync', 'github-save', 'cf-deploy', 'discord-endpoint'].includes(step))
      throw new Error('该步骤尚无自动核验条件')
    const url = new URL(page.url)
    if (
      step === 'github-sync' &&
      (!page.forkOfTarget || !isSetupForkPage(url, this.state.forkRepo))
    )
      throw new Error('请在本次 Fork 核对 main 分支同步结果')
    if (
      step === 'github-save' &&
      (!this.state.forkRepo || url.pathname !== `/${this.state.forkRepo}/blob/main/wrangler.jsonc`)
    )
      throw new Error('请提交到自己 Fork 的 main；当前仍未保存完成')
    if (
      step === 'cf-deploy' &&
      (url.hostname !== 'dash.cloudflare.com' ||
        !/^\/[^/]+\/workers\/services\/view\/[^/]+(?:\/.*)?$/u.test(url.pathname))
    )
      throw new Error('请进入本次 Worker 的生产部署结果页')
    const values =
      step === 'github-save' && this.state.parameterResourceId
        ? await this.parameters.read(this.state.parameterResourceId)
        : {}
    const result = await this.browser.act({
      documentId: page.documentId,
      operation: 'verify-step',
      step,
      statusTarget: args.target,
      deploymentAssessment:
        step === 'cf-deploy' && args.deployment_assessment === 'deployed' ? 'deployed' : undefined,
      target: step === 'discord-endpoint' ? args.target : undefined,
      expectedApplicationId: this.state.applicationId,
      expectedPublicKey: values.publicKey,
      expectedDatabaseId: values.databaseId,
      expectedRevision: this.state.githubRevision,
      expectedFork: this.state.forkRepo,
      value: step === 'discord-endpoint' ? `${this.state.workerUrl}/interactions` : undefined,
    })
    signal.throwIfAborted()
    if (result.verified !== true)
      throw new Error('当前页面未提供本步成功证据，请继续定位实际结果；不会把点击当成成功')
    if (['github-save', 'github-sync'].includes(step)) {
      if (typeof result.revision !== 'string' || !/^[a-f0-9]{40}$/iu.test(result.revision))
        throw new Error('当前 GitHub 页面没有唯一的 main 提交身份')
      await this.save({ ...this.state, githubRevision: result.revision.toLowerCase() })
    }
    if (step === 'cf-deploy') {
      // The domains and production-result tabs need not repeat the same information.
      if (!(await this.hasConfirmedWorkerRoot(page))) await this.collectWorker(page)
    }
  }
  private async hasConfirmedWorkerRoot(page: DiscordBrowserSnapshot) {
    const state = this.state
    const url = new URL(page.url)
    const worker =
      url.hostname === 'dash.cloudflare.com' &&
      url.pathname.match(/^\/[^/]+\/workers\/services\/view\/([^/]+)(?:\/|$)/u)?.[1]
    return !!(
      state?.workerUrl &&
      worker &&
      (state.workerConfirmedAt ?? 0) >= state.startedAt &&
      new URL(state.workerUrl).hostname.startsWith(`${worker}.`) &&
      (state.parameterResourceId
        ? (await this.parameters.read(state.parameterResourceId)).workerUrl === state.workerUrl
        : state.task.startsWith('update-') &&
          loadDiscordSourceConnectionSettings().workerBaseUrl === state.workerUrl)
    )
  }
  next() {
    return this.serial(() => this.advanceStep())
  }
  private async advanceStep(verifiedAgent = false) {
    await this.initialize()
    if (!this.state) throw new Error('尚未开始配置')
    if (this.state.step === 'diagnose')
      throw new Error('排查结果不等于配置完成；请先检查并选择实际修复路径')
    if (this.state.step === 'discord-token' && !this.state.botTokenReady)
      throw new Error('请先加密保存 Bot Token，或由用户明确确认已自行保存；不会跳过密钥步骤')
    if (setupStep(this.state.step).site !== 'local') {
      const page = await this.browser.inspect()
      await this.rememberPage(page)
      if (
        !verifiedAgent &&
        this.state.mode === 'agent' &&
        ['discord-app', 'd1-uuid'].includes(this.state.step) &&
        !(await this.collectedHere(page))
      )
        await this.collectParameters(page)
      if (['github-fork', 'github-sync'].includes(this.state.step) && !this.state.forkRepo)
        throw new Error('请先打开指定仓库的自己 Fork 首页并允许协助，不能用其它仓库继续')
      if (
        this.state.step === 'github-sync' &&
        (!page.forkOfTarget || !isSetupForkPage(new URL(page.url), this.state.forkRepo))
      )
        throw new Error('请在自己 Fork 核对 main 分支同步结果')
      if (['wrangler-edit', 'wrangler-check'].includes(this.state.step)) await this.validate(page)
      if (
        this.state.step === 'github-save' &&
        (!this.state.forkRepo ||
          new URL(page.url).pathname !== `/${this.state.forkRepo}/blob/main/wrangler.jsonc`)
      )
        throw new Error(
          '请先提交到自己 Fork 的 main，并确认已返回 wrangler.jsonc 文件页；仍在编辑页不算保存成功',
        )
      if (
        (this.state.step === 'discord-endpoint' ||
          (this.state.step === 'discord-install' && !page.installationCompleted)) &&
        (!this.state.applicationId ||
          !new URL(page.url).pathname.startsWith(
            `/developers/applications/${this.state.applicationId}/`,
          ))
      )
        throw new Error('请完成授权后回到同一个 Discord App 的配置页核对结果')
      if (
        [
          'github-sync',
          'github-save',
          'cf-deploy',
          'cf-secret',
          'discord-endpoint',
          'discord-install',
        ].includes(this.state.step) &&
        !verifiedAgent
      ) {
        const result = await this.browser.confirmSuccess({
          documentId: page.documentId,
          step: this.state.step,
        })
        if (!result.confirmed) throw new Error('成功条件尚未确认，已保留当前步骤；核对完成后再继续')
      }
    }
    if (
      this.state.step === 'worker-url' &&
      (!this.state.workerUrl || (this.state.workerConfirmedAt ?? 0) < this.state.startedAt)
    )
      throw new Error('请先填写并确认本次部署成功的 Worker 根链接')
    if (this.state.step === 'worker-url' && this.state.mode === 'agent') {
      if (
        !this.state.parameterResourceId ||
        (await this.parameters.read(this.state.parameterResourceId)).workerUrl !==
          this.state.workerUrl
      )
        throw new Error('Worker 链接尚未保存到本次部署密钥卡，请重新回填后继续')
    }
    const saved = loadDiscordSourceConnectionSettings()
    if (
      this.state.step === 'verify' &&
      ((this.state.applicationId && saved.applicationId !== this.state.applicationId) ||
        (this.state.workerUrl && saved.workerBaseUrl !== this.state.workerUrl))
    )
      throw new Error('最终检查的 App 或 Worker 与本次任务不一致，请回到连接设置核对')
    if (
      this.state.step === 'local-settings' &&
      ![saved.applicationId, saved.publicKey, saved.botToken, saved.workerBaseUrl].every((value) =>
        value.trim(),
      )
    )
      throw new Error('请先在原连接设置填写并保存四项参数')
    if (
      this.state.step === 'local-settings' &&
      (!/^\d{17,20}$/u.test(saved.applicationId) ||
        !/^[0-9a-f]{64}$/iu.test(saved.publicKey) ||
        (this.state.applicationId && saved.applicationId !== this.state.applicationId) ||
        (this.state.workerUrl && saved.workerBaseUrl !== this.state.workerUrl))
    )
      throw new Error('本机配置格式或 App/Worker 目标不一致，请核对本次配置')
    if (
      this.state.step === 'register' &&
      (!saved.commandRegistered || (saved.commandCheckedAt ?? 0) < this.state.startedAt)
    )
      throw new Error('请先使用原按钮注册命令并检查成功')
    if (
      this.state.step === 'verify' &&
      ((saved.workerVerifiedAt ?? 0) < this.state.startedAt ||
        !saved.commandRegistered ||
        (saved.commandCheckedAt ?? 0) < this.state.startedAt)
    )
      throw new Error('请重新测试连接和检查命令；旧检查不能证明本次更新成功')
    const route = DISCORD_SETUP_ROUTES[this.state.task]
    const step = route[route.indexOf(this.state.step) + 1]
    if (step) await this.save({ ...this.state, step })
    const result = await this.open()
    if (discordSetupSession.agentRunning && ['register', 'verify'].includes(this.state.step))
      this.requestAssistant(
        '继续本机 Discord 配置任务：用 status 查看步骤，verify-local 核验并执行本步，from 为当前 step；不请求或返回任何凭据值。',
      )
    return result
  }
  private async userAction(event: DiscordBrowserEvent) {
    try {
      if (event.action === 'installation-ready') {
        if (
          this.state?.step !== 'discord-install' ||
          event.applicationId !== this.state.applicationId
        )
          return
        const page = await this.browser.inspect({ metadataOnly: true })
        if (
          this.state?.step !== 'discord-install' ||
          event.applicationId !== this.state.applicationId ||
          !page.installationCompleted
        )
          return
        const phase = 'Discord 已确认授权完成；点桌宠继续资源库连接与命令核验'
        if (this.agentOperationId) taskCenter.update(this.agentOperationId, { phase })
        await this.browser.message({ text: '', phase })
        return
      }
      if (event.action === 'capture-bot-secret') {
        await this.captureBotSecret()
        return
      }
      if (event.action === 'agent-pause') {
        await this.stopAgent()
        return
      }
      if (event.action === 'agent-resume') {
        if (!(await this.startAgent())) return
        await this.open(false, true)
        return
      }
      if (event.action === 'page-ready') {
        if (
          !this.state ||
          !discordSetupSession.agentRunning ||
          this.agentController?.signal.aborted
        )
          return
        const page = await this.browser.inspect({ metadataOnly: this.state.step === 'cf-secret' })
        if (page.loading) {
          await this.showAssistantProgress('正在等待网页加载，加载完成后继续')
          return
        }
        if (this.canRecoverPage(page)) {
          await this.showAssistantProgress('公开网页加载失败，助手正在选择返回配置页')
          if (this.observeProgress(page))
            this.requestAssistant(
              '当前公开网页加载失败。用 status/inspect 核对实际网址，再用 navigate 返回已授权配置页继续任务；不自动重试失败网址，不把错误页当成功，不要求用户登录或代找入口。',
            )
          return
        }
        if (page.paused && !(this.state.step === 'cf-secret' && page.secretStage === 'submitted')) {
          if (this.agentOperationId)
            taskCenter.update(this.agentOperationId, {
              phase: page.installationCompleted
                ? 'Discord 授权已完成，点桌宠继续'
                : page.pageAccess === 'authentication'
                  ? '等待你完成当前网页登录或验证'
                  : page.pageAccess === 'protected'
                    ? '等待你完成秘密操作'
                    : page.pageAccess === 'external'
                      ? '当前外部网页未开放代理操作，请返回配置页面'
                      : '网页协助已暂停，请点桌宠查看或继续',
            })
          return
        }
        if (!this.observeProgress(page)) {
          // An idle chat can settle the task without a new model request; a busy turn settles itself.
          window.dispatchEvent(new Event('srl:discord-setup-assist'))
          return
        }
        this.requestAssistant(
          '当前配置网页已加载。请 inspect 观察实际页面种类、标题和控件，自己定位并继续配置；不要照教程猜位置。登录/密码/验证码/秘密及 Discord 安装授权交给用户；Cloudflare GitHub App 的仓库选择与安装授权也由你核对并完成。',
        )
        return
      }
      if (event.action === 'visibility') {
        discordSetupSession.browserVisible = event.visible === true
        return
      }
      if (event.action === 'return') {
        if (discordSetupSession.agentRunning) await this.stopAgent()
        await this.browser.close()
        return
      }
      if (event.action === 'fullscreen' || event.action === 'quick-chat') {
        const draft = (event.text ?? '').trim()
        if (draft.length > 200 || maskDiscordSetupSecrets(draft) !== draft)
          throw new Error('配置值请填在网页里，不转入聊天草稿')
        this.assistantDraft = draft || undefined
        await this.browser.close({ keepRunning: true })
        if (event.action === 'fullscreen') {
          window.dispatchEvent(
            new CustomEvent('srl:native-deep-link', { detail: { kind: 'assistant' } }),
          )
          window.dispatchEvent(new Event('srl:discord-setup-fullscreen'))
        } else window.dispatchEvent(new Event('srl:discord-setup-quick-chat'))
        return
      }
      if (event.action === 'secret-prepare' || event.action === 'secret-submit') {
        const operation = event.action === 'secret-prepare' ? 'prepare-secret' : 'submit-secret'
        const page = await this.browser.inspect({ metadataOnly: operation !== 'prepare-secret' })
        if (operation === 'prepare-secret' && page.secretSavedOnPage === true) {
          this.requestAssistant(
            '当前网页列表已有本次 Secret，表单已关闭。先 advance-step/from=cf-secret 核验生产健康与本机凭据；未核验前不认定完成，不重复添加。若凭据验证失败，再编辑现有 Secret 并本机盲转填。',
          )
          return
        }
        const result = await this.secretAction(operation, page)
        if (
          result.ok &&
          'secretStage' in result &&
          result.secretStage === 'input' &&
          this.state?.botTokenReady === 'encrypted' &&
          this.agentController &&
          !this.agentController.signal.aborted
        ) {
          const prepared = await this.browser.inspect({ metadataOnly: true })
          const transferred = await this.fillStoredBotSecret(prepared, this.agentController.signal)
          if (!transferred.ok && transferred.waitingForUser) return
          this.requestAssistant(
            transferred.ok &&
              'secretStage' in transferred &&
              transferred.secretStage === 'submitted'
              ? '本机已取得 Secret 保存部署回执，继续核验真实生产健康；点击不代表部署成功，秘密值不回模型。'
              : '本机盲转填后尚未取得保存部署确认。inspect 当前表单或列表，保留实际错误；secretSavedOnPage=true 时核验生产健康，不重复添加，不宣称已保存部署。',
          )
          return
        }
        if (
          (result.ok || ('recovery' in result && result.recovery === true)) &&
          (!result.waitingForUser ||
            ('secretStage' in result &&
              result.secretStage === 'submitted' &&
              discordSetupSession.agentRunning))
        )
          this.requestAssistant(
            '继续当前 Secret：prepare 阶段 inspect 公开标签并自主定位设置、添加/编辑入口，可为 prepare-secret 指定三个表单字段 target；失败换找法，不让用户代找。input 阶段已有加密 Token 用 transfer-secret，否则等用户填值；用户确认的 submit/saved 阶段用 submit-secret。submitted 后 advance-step/from=cf-secret 核验生产健康，再继续。秘密值不读取、不返回，不把点击当成功。',
          )
        return
      }
      if (event.action === 'resume') {
        if (this.state?.step === 'discord-token') {
          const page = await this.browser.inspect({ metadataOnly: true })
          if (
            page.url !==
            `https://discord.com/developers/applications/${this.state.applicationId}/bot`
          )
            throw new Error('请在同一个 App 的 Bot 页面保存 Token 后再继续')
          await this.save({ ...this.state, botTokenReady: this.state.botTokenReady ?? 'manual' })
          if (
            this.state.mode === 'agent' &&
            !discordSetupSession.agentRunning &&
            !(await this.startAgent())
          )
            return
          await this.advanceStep(true)
          return
        }
        if (this.state?.mode === 'agent' && !discordSetupSession.agentRunning) {
          if (!(await this.startAgent())) return
          if (this.state.step !== 'discord-install') {
            await this.open()
            this.requestAssistant(
              '用户已明确继续代理任务。请核验当前页面并继续执行；登录、密码、验证码、秘密及 Discord 安装授权由用户操作，Cloudflare GitHub App 仓库选择与安装授权由代理完成。',
            )
            return
          }
        }
        if (this.state?.mode === 'agent' && this.state.step === 'discord-install')
          await this.advanceStep(true)
        else if (this.state?.mode === 'agent' && discordSetupSession.agentRunning) {
          this.requestAssistant(
            '用户已完成接手操作，请核验当前结果并自动继续。普通步骤用 advance-step，from 为当前步骤；登录、密码、验证码、秘密及 Discord 安装授权由用户操作，Cloudflare GitHub App 仓库选择与安装授权由代理完成。',
          )
          return
        } else await this.advanceStep()
        await this.browser.message({
          text:
            this.state?.step === 'done'
              ? '本次连接与命令检查通过。请在 Discord 实际使用一次命令，确认菜单与收件正常。'
              : '本步核验通过，已进入下一步。需要手填时我会停下。',
        })
      } else if (event.action === 'assist') {
        const message = this.assistantQuestion(event.text)
        if (discordSetupSession.agentRunning && message) await this.stopAgent()
        if (this.state?.mode === 'agent' && !discordSetupSession.agentRunning) {
          if (!(await this.startAgent())) return
          await this.open(false, true)
        }
        if (this.state?.mode === 'economy') {
          const page = await this.browser.inspect({ metadataOnly: true })
          if (page.paused) throw new Error('请先允许本页本机协助；登录、授权和密钥由你操作')
          await this.rememberPage(page)
          await this.browser.act({
            documentId: page.documentId,
            operation: 'guide',
            step: this.state.step,
          })
          await this.browser.message({ text: setupStep(this.state.step).hint })
          return
        }
        const page = await this.browser.inspect({ metadataOnly: true })
        if (page.paused && !message) throw new Error('请先允许本页协助；登录、授权和密钥由你操作')
        if (!message) await this.rememberPage(page)
        this.requestAssistant(
          `${message || '请继续协助当前 Discord Bridge 网页配置任务。'}\n先处理用户当前问题和更改，再决定如何继续。先 status 核对任务，公开页面 inspect 找实际原因与控件，按反馈调整并核验；教程仅作目标和完成依据，不强行推进原步骤。登录、密码、验证码、密钥及 Discord 安装授权交用户；Cloudflare GitHub App 仓库选择与安装授权由代理完成。网页等待接手时可以回答问题，不读取私密页面。公开参数沿本机保存与回填，不发到聊天。`,
          Boolean(message),
        )
        await this.browser.message({
          text: message
            ? '已把你的问题交给蒜惹菈，先处理问题再继续。点桌宠查看回复。'
            : '已交给蒜惹菈继续协助。点桌宠查看进度或回复。',
        })
      } else if (event.action === 'collect-config' || event.action === 'fill-config') {
        const page = await this.browser.inspect({ metadataOnly: true })
        await this.rememberPage(page)
        if (event.action === 'collect-config') await this.collectParameters(page)
        else await this.fillParameters(page)
        await this.browser.message({
          text:
            event.action === 'collect-config'
              ? '本页部署参数已存入资源库密钥卡，Bot Token 留空，由你手填。'
              : '三个部署参数已填入教程模板，Bot Token 没有写入；请检查后提交。',
        })
      } else if (event.action === 'next') await this.advanceStep()
      else if (event.action === 'select-step') await this.selectStep(event.step as DiscordSetupStep)
      else if (event.action === 'worker-url') {
        if (!this.state || this.state.step !== 'worker-url')
          throw new Error('请在 Worker 链接步骤填写')
        await this.writeWorkerUrl(event.workerUrl ?? '')
        await this.browser.message({
          text: 'Worker 根链接已回填资源库。确认部署成功后点“本步完成”。',
        })
      } else if (event.action === 'collect-worker' || event.action === 'guide') {
        const page = await this.browser.inspect()
        if (page.paused) throw new Error('请先允许本页协助')
        await this.rememberPage(page)
        if (event.action === 'collect-worker') {
          await this.collectWorker(page)
          await this.browser.message({
            text: '已回填当前部署页的 Worker 根链接。请继续核验实际连接。',
          })
        } else {
          const result = await this.browser.act({
            documentId: page.documentId,
            operation: 'guide',
            step: this.state?.step,
          })
          await this.browser.message({
            text: result.ok
              ? '已标出本步骤的位置，请自己保存所需数据或继续填写。'
              : '当前页面没有找到对应位置，请先按步骤说明打开正确页面。',
          })
        }
      } else if (event.action === 'template' || event.action === 'validate') {
        const page = await this.browser.inspect()
        const result = await this.executeDirect(event.action, page)
        await this.browser.message({
          text:
            result.ok === true
              ? event.action === 'template'
                ? this.state?.mode === 'agent'
                  ? '完整模板与三个参数已写入并检查；请核对后确认提交，Bot Token 未写入。'
                  : '模板已写入，请自己填写三个占位值。'
                : '格式通过；账号归属仍需后续连接核验。'
              : '未能完成，请核对当前编辑页。',
        })
      }
    } catch (error) {
      await this.browser.message({
        text: error instanceof Error ? error.message : '当前步骤未完成',
      })
    }
  }
  private assistantQuestion(text?: string) {
    const message = (text ?? '').trim()
    if (message.length > 200 || maskDiscordSetupSecrets(message) !== message)
      throw new Error('配置值请留在网页表单填写；这里只说明遇到的问题')
    return message
  }
  private requestAssistant(prompt: string, userInitiated = false) {
    if (this.assistantRequested?.userInitiated && !userInitiated) return
    this.assistantRequested = { text: prompt, userInitiated }
    window.dispatchEvent(new CustomEvent('srl:native-deep-link', { detail: { kind: 'assistant' } }))
    window.dispatchEvent(new Event('srl:discord-setup-assist'))
  }
  private async captureBotSecret() {
    const state = this.state
    if (
      !state ||
      state.mode !== 'agent' ||
      state.step !== 'discord-token' ||
      !state.parameterResourceId ||
      !state.applicationId ||
      !this.parameters.captureBotSecret ||
      !this.browser.captureBotSecret
    )
      throw new Error('请先保存 App ID、公钥，再进入同一个 App 的 Bot Token 步骤')
    const controller = new AbortController()
    this.transferController = controller
    let suspended = false
    try {
      await this.prepareParameters(controller.signal)
      const page = await this.browser.inspect({ metadataOnly: true })
      if (page.url !== `https://discord.com/developers/applications/${state.applicationId}/bot`)
        throw new Error('当前不是本次 App 的 Bot 页面')
      suspended = await this.suspendForModelConsent()
      const confirmed = await confirmAction(
        {
          title: '本机加密保存 Bot Token？',
          centered: true,
          message:
            '只保存这个 App 当前显示的 Bot Token。网站验证、显示或重置 Token 由你完成。软件在本机加密传入原密钥资料卡，可在解锁后查看，并用于本次 Worker Secret 和资源库连接设置；模型只收到成功或失败，不会看到原值。',
          confirmLabel: '加密保存并继续',
          cancelLabel: '返回网页',
        },
        controller.signal,
      )
      if (!confirmed || controller.signal.aborted) return
      const values = await this.parameters.read(state.parameterResourceId)
      if (values.applicationId !== state.applicationId) throw new Error('部署卡与当前 App 不一致')
      controller.signal.throwIfAborted()
      if (
        this.state?.startedAt !== state.startedAt ||
        this.state.parameterResourceId !== state.parameterResourceId
      )
        throw new Error('任务已变化，未继续旧任务')
      // A confirmed new capture must not let an old saved Token satisfy this step if it fails.
      if (this.state.botTokenReady) await this.save({ ...this.state, botTokenReady: undefined })
      await this.parameters.captureBotSecret(
        state.parameterResourceId,
        async (publicKey) => {
          controller.signal.throwIfAborted()
          return this.browser.captureBotSecret!({
            documentId: page.documentId,
            applicationId: state.applicationId!,
            publicKey,
          })
        },
        controller.signal,
      )
      controller.signal.throwIfAborted()
      if (
        this.state?.startedAt !== state.startedAt ||
        this.state.parameterResourceId !== state.parameterResourceId
      )
        throw new Error('任务已变化，未继续旧任务')
      await this.save({ ...this.state, botTokenReady: 'encrypted' })
      await this.browser.message({
        text: 'Bot Token 已加密保存到原密钥资料卡，可解锁查看。接下来创建 Cloudflare D1；模型看不到密钥。',
      })
      if (suspended) {
        await this.browser.restore({ resume: false })
        suspended = false
      }
      if (!(await this.startAgent())) return
      await this.advanceStep(true)
    } finally {
      if (suspended) await this.browser.restore({ resume: false })
      if (this.transferController === controller) this.transferController = undefined
    }
  }
  private async fillStoredBotSecret(page: DiscordBrowserSnapshot, signal: AbortSignal) {
    const state = this.state
    if (
      !state ||
      state.mode !== 'agent' ||
      state.step !== 'cf-secret' ||
      state.botTokenReady !== 'encrypted' ||
      !state.parameterResourceId ||
      !this.parameters.useBotSecret ||
      !this.browser.fillBotSecret ||
      page.secretStage !== 'input' ||
      !discordSetupSession.agentRunning
    )
      throw new Error('本步需要已加密保存的 Bot Token 和已准备好的 Secret 表单；否则由用户手填')
    const agentSignal = this.agentController!.signal
    this.requireSecretWorker(page)
    await this.prepareParameters(signal)
    const values = await this.parameters.read(state.parameterResourceId)
    if (values.applicationId !== state.applicationId || values.workerUrl !== state.workerUrl)
      throw new Error('密钥资料卡与本次 App/Worker 不一致')
    await this.parameters.useBotSecret(
      state.parameterResourceId,
      async (secret) => {
        signal.throwIfAborted()
        agentSignal.throwIfAborted()
        if (
          !(await this.guardConnectionConflict(
            {
              applicationId: values.applicationId,
              publicKey: values.publicKey,
              workerBaseUrl: values.workerUrl,
              botToken: secret,
            },
            signal,
          ))
        )
          throw new Error('用户选择不切换，已停止本次配置；原连接保留')
        const result = await this.browser.fillBotSecret!({ documentId: page.documentId, secret })
        if (!result.ok)
          throw new Error(
            '本机未取得可确认的填写回执；先 inspect 当前表单或已保存列表，不重复添加 Secret',
          )
      },
      signal,
    )
    signal.throwIfAborted()
    agentSignal.throwIfAborted()
    const filled = await this.browser.inspect({ metadataOnly: true })
    if (filled.documentId !== page.documentId || filled.secretStage !== 'submit')
      throw new Error(
        '转填后的网页状态已变化，当前保存结果尚未核验；inspect 当前列表或表单，不重复添加 Secret',
      )
    return this.secretAction('submit-secret', filled)
  }
  private async secretAction(
    operation: 'prepare-secret' | 'submit-secret',
    page: DiscordBrowserSnapshot,
    args: Record<string, string> = {},
  ) {
    this.requireSecretWorker(page)
    if (operation === 'prepare-secret' && page.secretSavedOnPage === true) {
      const state = this.state!
      const signal = this.agentController?.signal
      if (!signal || !state.parameterResourceId || !this.parameters.useBotSecret)
        throw new Error('已有 Secret，未覆盖；请先恢复本次加密 Token 后核对')
      let alreadyConfigured = false
      await this.parameters.useBotSecret(
        state.parameterResourceId,
        async (botToken) => {
          try {
            await checkDiscordWorker(
              { workerBaseUrl: state.workerUrl!, applicationId: state.applicationId!, botToken },
              'status',
              signal,
            )
            alreadyConfigured = true
          } catch {
            signal.throwIfAborted()
          }
        },
        signal,
      )
      if (alreadyConfigured) {
        this.markAction(`existing-secret:${state.workerUrl}`)
        return {
          ok: true,
          secretAlreadySaved: true,
          waitingForUser: false,
          hint: '当前 Worker 已使用本次 Token 并通过状态核验；直接核验本步，不再打开编辑或重复保存。',
        }
      }
      const previous = loadDiscordSourceConnectionSettings()
      if (!previous.botToken || previous.workerBaseUrl !== state.workerUrl)
        throw new Error(
          'Worker 已有不同或尚未核验的 Secret，但本机没有这个 Worker 的完整旧 Token；无法完整备份，未覆盖。请先恢复原密钥资源中的连接资料。',
        )
      // A successful authenticated response proves the stored old Token matches this Worker,
      // even if Wrangler has already changed its App/public-key configuration.
      const response = await fetch(`${checkedSetupWorkerUrl(state.workerUrl!)}/status`, {
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        signal,
        headers: { Authorization: `Bearer ${previous.botToken}` },
      })
      signal.throwIfAborted()
      if (!response.ok)
        throw new Error('本机旧 Token 与现有 Worker Secret 未核对成功，未覆盖；请先恢复原连接资料')
      if (!(await this.preservePreviousConnection(previous, signal)))
        return { ok: false, cancelled: true, waitingForUser: true }
      const fresh = await this.browser.inspect({ metadataOnly: false })
      if (fresh.documentId !== page.documentId || fresh.url !== page.url || fresh.paused)
        throw new Error('切换确认期间 Secret 页面已变化，未编辑；请重新查看')
    }
    if (
      operation === 'prepare-secret'
        ? !['prepare', 'submit'].includes(page.secretStage ?? '')
        : !['submit', 'saved'].includes(page.secretStage ?? '')
    )
      throw new Error('请点网页桌宠准备设置；填好值后点“填好了，继续”授权保存部署')
    const result = await this.browser.act({
      documentId: page.documentId,
      operation,
      step: 'cf-secret',
      ...(args.target ? { target: args.target } : {}),
      ...(args.secret_name_target ? { secretNameTarget: args.secret_name_target } : {}),
      ...(args.secret_type_target ? { secretTypeTarget: args.secret_type_target } : {}),
      ...(args.secret_value_target ? { secretValueTarget: args.secret_value_target } : {}),
    })
    if (result.cancelled) return { ok: false, waitingForUser: true, cancelled: true }
    if (!result.ok) {
      if (result.pageAccess === 'authentication')
        return {
          ok: false,
          waitingForUser: true,
          hint: '当前网站实际要求密码验证，请用户完成验证后继续；未读取密码或 Token',
        }
      const errors = Array.isArray(result.errors)
        ? result.errors
            .filter((error): error is string => typeof error === 'string')
            .slice(0, 10)
            .map(maskDiscordSetupSecrets)
        : []
      const recoveryHint =
        operation === 'prepare-secret'
          ? '自动准备未定位到表单。用 inspect 搜索实际公开标签，自行 click/focus/scroll 打开添加或编辑入口；可为 prepare-secret 指定名称、类型和值字段的 target，值仅作为本机写入位置，不读取。定位失败不是用户接手，不重复同一失败调用。'
          : '未定位到保存部署按钮。inspect 公开按钮，用 submit-secret 指定当前实际保存部署 target；不读取值，不重新创建 Secret，不重复同一失败调用。'
      const hint = errors.length
        ? errors.join('；') +
          '。' +
          (operation === 'submit-secret'
            ? '先 inspect 当前实际表单或列表；secretSavedOnPage=true 时 advance-step 核验生产健康，不重复提交或添加。'
            : recoveryHint)
        : recoveryHint
      await this.browser.message({ text: hint })
      return {
        ok: false,
        ...this.summary(),
        secretStage: page.secretStage,
        waitingForUser: false,
        recovery: true,
        ...(typeof result.secretSavedOnPage === 'boolean'
          ? { secretSavedOnPage: result.secretSavedOnPage }
          : {}),
        ...(errors.length ? { errors } : {}),
        hint,
      }
    }
    if (result.dispatched || result.secretStage !== page.secretStage)
      this.markAction(
        JSON.stringify([
          this.state!.step,
          page.url,
          operation,
          page.secretStage,
          result.secretStage,
          result.preparedAction,
        ]),
      )
    return {
      ok: true,
      ...this.summary(),
      documentId: page.documentId,
      secretStage: result.secretStage,
      dispatched: result.dispatched === true,
      waitingForUser:
        result.waitingForUser === true &&
        !(result.secretStage === 'input' && this.state?.botTokenReady === 'encrypted'),
    }
  }
  private requireSecretWorker(page: DiscordBrowserSnapshot) {
    const url = new URL(page.url)
    const worker = url.pathname.match(
      /^\/[^/]+\/workers\/services\/view\/([^/]+)(?:\/(?:production|settings)(?:\/.*)?)?$/u,
    )?.[1]
    if (
      this.state?.mode !== 'agent' ||
      this.state.step !== 'cf-secret' ||
      url.hostname !== 'dash.cloudflare.com' ||
      !worker ||
      !this.state.workerUrl ||
      !new URL(this.state.workerUrl).hostname.startsWith(`${worker}.`)
    )
      throw new Error(
        '请定位本次已确认网址对应的 Worker；不要求默认名称，不向其他 Worker 转填 Secret',
      )
  }
  private async writeWorkerUrl(value: string) {
    if (
      !this.state ||
      (this.state.mode !== 'agent' && !['worker-url', 'cf-deploy'].includes(this.state.step))
    )
      throw new Error('请在 Worker 部署或链接步骤回填')
    const workerUrl = checkedSetupWorkerUrl(value)
    const previous = loadDiscordSourceConnectionSettings()
    if (this.state.task.startsWith('update-') && workerUrl !== previous.workerBaseUrl) {
      if (
        !(await this.guardConnectionConflict(
          { workerBaseUrl: workerUrl },
          this.agentController?.signal,
        ))
      )
        throw new Error('用户选择不切换，原 Worker 保留，本次更新已停止')
      await this.save({ ...this.state, task: 'configure' })
    }
    // Capture belongs to this task. Switching the live inbox target belongs to local-settings.
    if (
      this.state.mode === 'agent' &&
      (!this.state.task.startsWith('update-') || this.state.parameterResourceId)
    )
      await this.saveParameters({ workerUrl })
    await this.save({ ...this.state, workerUrl, workerConfirmedAt: Date.now() })
  }
  private async discordPublicAction(
    operation: 'fill-endpoint' | 'open-install',
    page: DiscordBrowserSnapshot,
    target?: string,
  ) {
    const step = operation === 'fill-endpoint' ? 'discord-endpoint' : 'discord-install'
    const url = new URL(page.url)
    if (
      !this.state ||
      this.state.mode === 'economy' ||
      page.paused ||
      !this.state.applicationId ||
      url.hostname !== 'discord.com' ||
      !url.pathname.startsWith(`/developers/applications/${this.state.applicationId}/`)
    )
      throw new Error('请打开本次 Discord App 的对应配置页并允许协助；不操作其它 App')
    const value =
      operation === 'fill-endpoint'
        ? `${checkedSetupWorkerUrl(this.state.workerUrl ?? '')}/interactions`
        : undefined
    let result = await this.browser.act({
      documentId: page.documentId,
      operation,
      step,
      expectedApplicationId: this.state.applicationId,
      value,
      target,
    })
    if (operation === 'fill-endpoint' && result.configurationConflict === true) {
      if (typeof result.previousEndpoint !== 'string')
        throw new Error('原交互地址无法完整保存，未覆盖；请先核对原配置')
      const oldUrl = new URL(result.previousEndpoint)
      if (oldUrl.protocol !== 'https:' || oldUrl.username || oldUrl.password)
        throw new Error('原交互地址格式异常，未覆盖')
      const previous = {
        ...loadDiscordSourceConnectionSettings(),
        interactionEndpointUrl: oldUrl.href,
      }
      if (!(await this.preservePreviousConnection(previous)))
        return { ok: false, cancelled: true, waitingForUser: true }
      const fresh = await this.browser.inspect({ metadataOnly: true })
      if (fresh.documentId !== page.documentId || fresh.url !== page.url || fresh.paused)
        throw new Error('确认期间网页已变化，未覆盖；请重新查看当前表单')
      this.agentController?.signal.throwIfAborted()
      result = await this.browser.act({
        documentId: page.documentId,
        operation,
        step,
        expectedApplicationId: this.state.applicationId,
        value,
        target,
        confirmedPreviousEndpoint: result.previousEndpoint,
      })
      if (result.configurationConflict === true)
        throw new Error('原交互地址在确认期间又有变化，未覆盖；请重新核对')
    }
    if (!result.ok)
      throw new Error(
        operation === 'open-install'
          ? '未定位到唯一安装链接；inspect 实际 Installation 页面，选择本次 App 官方链接的 target 再 open-install，不让用户代找。自定义跳转不作为本次官方安装链接。'
          : '未找到唯一的 Interactions Endpoint URL 输入框，请在同一个 App 的 General Information 检查；不猜测字段',
      )
    this.markAction(`${step}:${page.url}:${operation}`)
    await this.browser.message({
      text:
        operation === 'open-install'
          ? '已打开本次 App 的安装链接，请自己选择账号、安装目标并授权。完成后点桌宠小窗的网页配置操作，再选填好了，继续；无需手工回到 Installation 页。打开链接还不代表安装成功。'
          : discordSetupSession.agentRunning
            ? '交互地址已填好，我会继续保存并核验。资源库保存 HTTPS 根网址。'
            : '已填写 Worker 根网址 + /interactions。请保存并等待 Discord 验证通过，再点我继续。资源库里的地址仍是 HTTPS 根网址。',
    })
    // Public URLs and form values remain local; tools receive only action receipts.
    return {
      ok: true,
      ...this.summary(),
      waitingForUser: operation === 'open-install' || !discordSetupSession.agentRunning,
      ...(operation === 'open-install' ? { dispatched: true, verified: false } : { filled: true }),
    }
  }
  private async collectWorker(page: DiscordBrowserSnapshot, target?: string) {
    if (
      !this.state ||
      (this.state.mode !== 'agent' && !['worker-url', 'cf-deploy'].includes(this.state.step))
    )
      throw new Error('仅在部署完成的 Worker 链接步骤读取')
    const url = new URL(page.url)
    if (
      page.paused ||
      url.hostname !== 'dash.cloudflare.com' ||
      !/^\/[^/]+\/workers\/services\/view\/[^/]+(?:\/.*)?$/u.test(url.pathname)
    )
      throw new Error('请打开本次 Worker 详情并允许协助，不从账号总览猜测部署网址')
    const result = await this.browser.act({
      documentId: page.documentId,
      operation: 'collect-worker',
      ...(target ? { target } : {}),
    })
    if (!result.ok || typeof result.workerUrl !== 'string')
      throw new Error(
        '当前页面未找到唯一的 Worker 根链接；请 inspect 搜索实际域名或网址标签，多个候选时带 target 选择本次公开地址，不猜测或重复部署',
      )
    await this.writeWorkerUrl(result.workerUrl)
  }
  private async saveParameters(values: DiscordSetupParameters) {
    if (!this.state || this.state.mode !== 'agent') throw new Error('仅代理模式自动保存部署参数')
    await this.prepareParameters(this.agentController?.signal)
    const checked = checkedSetupParameters(values)
    let existing: DiscordSetupParameters = {}
    if (this.state.parameterResourceId) {
      try {
        existing = await this.parameters.read(this.state.parameterResourceId)
      } catch (error) {
        if (!(error instanceof MissingDiscordSetupCardError)) throw error
        const confirmed = await confirmAction(
          {
            title: '重新建立部署密钥卡',
            centered: true,
            message:
              '本次关联的卡片已删除。由软件新建一张卡并重新保存公开部署参数？旧卡的 Bot Token 不会自动恢复，需要重新加密保存或自行填写。',
            confirmLabel: '重新建立',
            cancelLabel: '暂不继续',
          },
          this.agentController?.signal,
        )
        this.agentController?.signal.throwIfAborted()
        if (!confirmed) throw new Error('已取消重新建立部署卡，当前步骤保留', { cause: error })
        // The user may have restored the original card while the confirmation was open.
        try {
          existing = await this.parameters.read(this.state.parameterResourceId)
        } catch (error) {
          if (!(error instanceof MissingDiscordSetupCardError)) throw error
          await this.save({
            ...this.state,
            parameterResourceId: undefined,
            botTokenReady: undefined,
          })
          this.collectionReceipt = undefined
        }
      }
      const previous = loadDiscordSourceConnectionSettings()
      if (
        existing.databaseId &&
        existing.applicationId === previous.applicationId &&
        existing.publicKey === previous.publicKey &&
        existing.workerUrl === previous.workerBaseUrl &&
        (Object.keys(checked) as Array<keyof DiscordSetupParameters>).some(
          (key) => existing[key] && checked[key] !== existing[key],
        )
      ) {
        if (
          !(await this.preservePreviousConnection(
            { ...previous, databaseId: existing.databaseId },
            this.agentController?.signal,
          ))
        )
          throw new Error('用户选择不切换，旧部署资料保留，本次配置已停止')
      }
      if (
        checked.applicationId &&
        existing.applicationId &&
        existing.applicationId !== checked.applicationId
      ) {
        if (
          !(await this.guardConnectionConflict(
            { applicationId: checked.applicationId, publicKey: checked.publicKey },
            this.agentController?.signal,
          ))
        )
          throw new Error('用户选择不切换，原部署卡保留，本次配置已停止')
        // A different App gets its own task card. The old encrypted card remains intact.
        await this.save({ ...this.state, parameterResourceId: undefined, botTokenReady: undefined })
        this.collectionReceipt = undefined
      }
    }
    if (
      checked.applicationId &&
      this.state.applicationId &&
      checked.applicationId !== this.state.applicationId
    )
      throw new Error('读取的 Application ID 与当前 App 不一致，未保存')
    const connection = loadDiscordSourceConnectionSettings()
    if (
      this.state.applicationId === connection.applicationId &&
      /^\d{17,20}$/u.test(connection.applicationId) &&
      /^[a-f0-9]{64}$/iu.test(connection.publicKey)
    ) {
      if (!existing.applicationId && !checked.applicationId)
        checked.applicationId = connection.applicationId
      if (!existing.publicKey && !checked.publicKey) checked.publicKey = connection.publicKey
    }
    const id = await this.parameters.save(checked, this.state.parameterResourceId)
    // Preserve the successful card creation even if saving the workflow record fails.
    this.state = { ...this.state, parameterResourceId: id }
    await this.save({ ...this.state, parameterResourceId: id })
  }
  private async collectParameters(
    page: DiscordBrowserSnapshot,
    targets: Record<string, string> = {},
  ) {
    if (!this.state || this.state.mode !== 'agent') throw new Error('仅代理模式可读取部署参数')
    const step = setupParameterStep(page.url)
    if (!step) throw new Error('请定位实际 App 或 D1 页面采集公开参数，无需切换助手模式')
    if (page.paused) throw new Error('请先允许当前信息页的本机读取；Bot、登录和 Secret 页面不读取')
    const result = await this.browser.act({
      documentId: page.documentId,
      operation: 'collect-config',
      step,
      allowParameters: true,
      expectedApplicationId: this.state.applicationId,
      applicationIdTarget: targets.application_id_target,
      publicKeyTarget: targets.public_key_target,
      databaseIdTarget: targets.database_id_target,
    })
    if (!result.ok || !result.parameters || typeof result.parameters !== 'object')
      throw new Error(
        Array.isArray(result.errors)
          ? result.errors.join('；')
          : '当前页未找到唯一完整的部署参数，请 inspect 定位实际字段；不会猜测或读取秘密',
      )
    const input = result.parameters as DiscordSetupParameters
    const values =
      step === 'discord-app'
        ? { applicationId: input.applicationId, publicKey: input.publicKey }
        : { databaseId: input.databaseId }
    if (step === 'discord-app' ? !values.applicationId || !values.publicKey : !values.databaseId)
      throw new Error('当前页部署参数不完整，未保存')
    await this.saveParameters(values)
    if (this.state.parameterResourceId)
      this.collectionReceipt = {
        startedAt: this.state.startedAt,
        step: this.state.step,
        documentId: page.documentId,
        url: page.url,
        resourceId: this.state.parameterResourceId,
      }
  }
  private async fillParameters(page: DiscordBrowserSnapshot) {
    if (!this.state || this.state.mode !== 'agent' || !this.state.parameterResourceId)
      throw new Error('请在代理模式先保存 App 和 D1 参数，再打开自己的 Wrangler 编辑步骤')
    if (page.paused) throw new Error('请先允许本页协助')
    this.requireFork(page)
    const values = await this.parameters.read(this.state.parameterResourceId)
    if (!values.applicationId || !values.publicKey || !values.databaseId)
      throw new Error('密钥卡缺少三个部署参数，请回对应信息页保存')
    if (values.applicationId !== this.state.applicationId)
      throw new Error('密钥卡与当前 Discord App 不一致，未填写')
    if (
      !(await this.guardConnectionConflict(
        {
          applicationId: values.applicationId,
          publicKey: values.publicKey,
        },
        this.agentController?.signal,
      ))
    )
      throw new Error('用户选择不切换，已停止本次配置；原连接保留')
    const template = JSON.parse(DISCORD_BRIDGE_WRANGLER_TEMPLATE)
    template.d1_databases[0].database_id = values.databaseId
    template.vars.DISCORD_APPLICATION_ID = values.applicationId
    template.vars.DISCORD_PUBLIC_KEY = values.publicKey
    const result = await this.browser.act({
      documentId: page.documentId,
      operation: 'template',
      template: JSON.stringify(template, null, 2),
      validateTemplate: true,
      expectedApplicationId: this.state.applicationId,
    })
    if (result.ok !== true)
      throw new Error(
        '未找到可读取完整文档的编辑器，未填写；请 inspect 核对编辑状态，定位自己的 Fork/main/wrangler.jsonc 编辑入口后再填写，不让用户代找或粘贴',
      )
    this.markAction(`${this.state.step}:${page.url}:template`)
  }
  private async executeDirect(operation: 'template' | 'validate', page: DiscordBrowserSnapshot) {
    if (page.paused) throw new Error('请先点击“允许协助”；填写密钥期间不要开放采集')
    this.requireFork(page)
    if (operation === 'validate') return this.validate(page)
    if (this.state?.step !== 'wrangler-edit') throw new Error('请先选择 Wrangler 编辑步骤')
    if (this.state.mode === 'agent') {
      await this.fillParameters(page)
      return { ok: true, written: true, waitingForUser: true }
    }
    return this.browser.act({
      documentId: page.documentId,
      operation,
      template: DISCORD_BRIDGE_WRANGLER_TEMPLATE,
    })
  }
}
