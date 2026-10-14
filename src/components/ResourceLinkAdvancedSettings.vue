<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import DiscordSetupAssistant from './DiscordSetupAssistant.vue'
import { discordSetupService } from '../core/AppContainer'
import { hasDiscordSetupBrowser, discordSetupSession } from '../services/AssistantBrowserRuntime'
import { useAssistantHelpContext } from '../composables/UseAssistantHelpContext'

import { useTransientStatus } from '../composables/UseTransientStatus'
import { assistantGuidance } from '../core/ProductAssistantGuidance'
import { DISCORD_BRIDGE_PUBLIC_REPOSITORY_URL } from '../services/DiscordBridgeDeployService'
import {
  checkDiscordWorker,
  diagnoseDiscordConfiguration,
  type DiscordDiagnosticState,
  getDiscordWorkerEndpoints,
  normalizeDiscordWorkerBaseUrl,
} from '../services/DiscordSourceConnectionService'
import {
  loadDiscordSourceConnectionSettings,
  saveDiscordSourceConnectionSettings,
  saveDiscordSourceConnectionStatus,
} from '../services/DiscordSourceSettingsService'
import DiscordManualDeployDrawer from './DiscordManualDeployDrawer.vue'
import DiscordInboxPanel from './DiscordInboxPanel.vue'
import DiscordPendingSources from './DiscordPendingSources.vue'
import DiscordSetupGuideDrawer from './DiscordSetupGuideDrawer.vue'

const props = withDefaults(
  defineProps<{ contextResourceId?: string; title?: string; backLabel?: string }>(),
  { contextResourceId: undefined, title: '来源链接高级设置', backLabel: '返回来源与链接' },
)
const emit = defineEmits<{ close: [] }>()
useAssistantHelpContext('discord-bridge')

type ConnectionState = 'idle' | 'testing' | 'connected' | 'stale' | 'error'
type DiagnosticState = 'idle' | 'checking' | DiscordDiagnosticState
type CommandState =
  'idle' | 'checking' | 'registering' | 'registered' | 'missing' | 'stale' | 'error'

const applicationId = ref('')
const publicKey = ref('')
const botToken = ref('')
const credentialPersistence = ref<'local' | 'session'>('local')
const workerUrl = ref('')
const showToken = ref(false)
const oneClickDeployOpen = ref(false)
const githubDeployOpen = ref(false)
const manualDeployOpen = ref(false)
const connectionState = ref<ConnectionState>('idle')
const diagnosticState = ref<DiagnosticState>('idle')
const commandState = ref<CommandState>('idle')
const { statusMessage, setStatus, showTransientStatus } = useTransientStatus()
let detachSetupForm: (() => void) | undefined
let disposed = false
onMounted(() => {
  detachSetupForm = discordSetupService.attachLocalForm(persistSettings)
})
onBeforeUnmount(() => detachSetupForm?.())

watch(
  assistantGuidance,
  (guide) => {
    if (guide?.destination !== 'inbox') return
    if (guide.id === 'discord-oneclick-tutorial') oneClickDeployOpen.value = true
    else if (guide.id === 'discord-github-tutorial') githubDeployOpen.value = true
    else if (guide.id === 'discord-manual-deploy-tutorial') manualDeployOpen.value = true
  },
  { immediate: true },
)

const endpoints = computed(() => getDiscordWorkerEndpoints(workerUrl.value))
const discordAppConfigured = computed(() =>
  Boolean(applicationId.value.trim() && publicKey.value.trim() && botToken.value.trim()),
)
const cloudflareStatusLabel = computed(() => {
  switch (diagnosticState.value) {
    case 'checking':
      return '配置核验中'
    case 'ready':
      return '配置核验通过'
    case 'd1-error':
      return 'D1 检查失败'
    case 'discord-missing':
      return 'Discord 变量缺失'
    case 'discord-invalid':
      return 'Discord 凭证不匹配'
    case 'worker-error':
      return 'Worker 检查失败'
    case 'outdated':
      return 'Worker 需更新'
    case 'need-token':
      return '待验证 Bot Token'
    default:
      return connectionState.value === 'testing'
        ? '检查中'
        : connectionState.value === 'connected'
          ? 'Worker / D1 可达'
          : connectionState.value === 'stale'
            ? '上次正常'
            : connectionState.value === 'error'
              ? '检查失败'
              : '待检查'
  }
})
const cloudflareStatusActive = computed(
  () =>
    diagnosticState.value === 'ready' ||
    (diagnosticState.value === 'idle' && ['connected', 'stale'].includes(connectionState.value)),
)
const cloudflareStatusError = computed(() =>
  ['d1-error', 'discord-missing', 'discord-invalid', 'worker-error', 'outdated'].includes(
    diagnosticState.value,
  ),
)
const developerAppUrl = computed(() => {
  const id = applicationId.value.trim()
  return id
    ? `https://discord.com/developers/applications/${encodeURIComponent(id)}/information`
    : 'https://discord.com/developers/applications'
})
const developerBotUrl = computed(() => {
  const id = applicationId.value.trim()
  return id
    ? `https://discord.com/developers/applications/${encodeURIComponent(id)}/bot`
    : 'https://discord.com/developers/applications'
})
const installationUrl = computed(() => {
  const id = applicationId.value.trim()
  return id
    ? `https://discord.com/developers/applications/${encodeURIComponent(id)}/installation`
    : 'https://discord.com/developers/applications'
})

watch([applicationId, publicKey, botToken, workerUrl], () => {
  if (diagnosticState.value !== 'checking') diagnosticState.value = 'idle'
})

function applyCachedStatus(): void {
  const settings = loadDiscordSourceConnectionSettings()
  connectionState.value = settings.workerVerifiedAt ? 'connected' : 'idle'
  if (!settings.commandCheckedAt) {
    commandState.value = 'idle'
  } else {
    commandState.value = settings.commandRegistered ? 'registered' : 'missing'
  }
}

function openDiscordHandoffPaste(): void {
  window.dispatchEvent(new Event('srl:open-discord-handoff-paste'))
  emit('close')
}

function acceptSetupWorker(event: Event) {
  const value = (event as CustomEvent<{ workerUrl?: string }>).detail?.workerUrl
  if (value) workerUrl.value = normalizeDiscordWorkerBaseUrl(value)
  void applySetupDraft()
}
async function applySetupDraft(): Promise<boolean> {
  if (!hasDiscordSetupBrowser()) return false
  try {
    const draft = await discordSetupService.localConnectionDraft()
    if (disposed) return true
    if (!draft) return false
    applicationId.value = draft.applicationId!
    publicKey.value = draft.publicKey!
    workerUrl.value = draft.workerUrl!
    if (draft.needsToken) {
      botToken.value = ''
      setStatus('请填写本次 Bot Token 再保存；原连接仍保留，尚未切换。')
      return true
    }
  } catch (error) {
    if (disposed) return true
    setStatus(error instanceof Error ? error.message : '本次配置参数尚未准备好。')
    return true
  }
  return false
}
function acceptSetupCredentials() {
  botToken.value = loadDiscordSourceConnectionSettings().botToken
}
onBeforeUnmount(() => {
  disposed = true
  window.removeEventListener('srl:discord-setup-worker', acceptSetupWorker)
  window.removeEventListener('srl:discord-setup-credentials', acceptSetupCredentials)
})
onMounted(async () => {
  window.addEventListener('srl:discord-setup-worker', acceptSetupWorker)
  window.addEventListener('srl:discord-setup-credentials', acceptSetupCredentials)
  const settings = loadDiscordSourceConnectionSettings()
  applicationId.value = settings.applicationId
  publicKey.value = settings.publicKey
  botToken.value = settings.botToken
  workerUrl.value = settings.workerBaseUrl
  credentialPersistence.value = settings.credentialPersistence === 'session' ? 'session' : 'local'
  applyCachedStatus()
  if (await applySetupDraft()) return
  if (disposed) return
  if (settings.workerBaseUrl) {
    void verifyWorker(true)
    if (settings.botToken) void checkCommandStatus(true)
  }
})

function normalizeWorkerDraft(): void {
  const normalized = normalizeDiscordWorkerBaseUrl(workerUrl.value)
  if (normalized) workerUrl.value = normalized
}

function cachedWorkerWasHealthy(): boolean {
  return Boolean(loadDiscordSourceConnectionSettings().workerVerifiedAt)
}

function cachedCommandWasRegistered(): boolean {
  const settings = loadDiscordSourceConnectionSettings()
  return Boolean(settings.commandCheckedAt && settings.commandRegistered)
}

async function persistSettings(): Promise<boolean> {
  normalizeWorkerDraft()
  let saved: Awaited<ReturnType<typeof saveDiscordSourceConnectionSettings>>
  try {
    const save = hasDiscordSetupBrowser()
      ? discordSetupService.saveLocalConnectionSettings.bind(discordSetupService)
      : saveDiscordSourceConnectionSettings
    const result = await save({
      applicationId: applicationId.value,
      publicKey: publicKey.value,
      botToken: botToken.value,
      workerBaseUrl: workerUrl.value,
      credentialPersistence: credentialPersistence.value,
    })
    if (!result) {
      setStatus('已停止本次切换，原连接保持不变。')
      return false
    }
    saved = result
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Bot Token 未能保存到本机。')
    connectionState.value = 'error'
    return false
  }
  applicationId.value = saved.applicationId
  publicKey.value = saved.publicKey
  botToken.value = saved.botToken
  workerUrl.value = saved.workerBaseUrl
  credentialPersistence.value = saved.credentialPersistence === 'session' ? 'session' : 'local'
  if (!saved.workerBaseUrl) {
    setStatus('请粘贴 Cloudflare 部署完成后得到的 workers.dev 链接。')
    connectionState.value = 'error'
    return false
  }
  if (!saved.workerVerifiedAt && connectionState.value !== 'testing') connectionState.value = 'idle'
  if (!saved.commandCheckedAt && commandState.value !== 'registering') commandState.value = 'idle'
  return true
}

async function copyText(value: string, successMessage: string): Promise<void> {
  if (!value) return
  try {
    await navigator.clipboard.writeText(value)
  } catch {
    const input = document.createElement('textarea')
    input.value = value
    input.setAttribute('readonly', '')
    input.style.position = 'fixed'
    input.style.left = '-9999px'
    document.body.append(input)
    input.select()
    document.execCommand('copy')
    input.remove()
  }
  showTransientStatus(successMessage)
}

async function verifyWorker(background = false): Promise<boolean> {
  if (!endpoints.value) return false
  const hadCachedSuccess = cachedWorkerWasHealthy()
  if (!background || !hadCachedSuccess) connectionState.value = 'testing'
  if (!background) setStatus('正在检查你自己的 Worker…')
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 6_000)
  try {
    await checkDiscordWorker(
      { workerBaseUrl: workerUrl.value, applicationId: applicationId.value },
      'health',
      controller.signal,
    )
    saveDiscordSourceConnectionStatus({ workerVerifiedAt: Date.now() })
    connectionState.value = 'connected'
    if (!background) showTransientStatus('Worker 已连接。SRL 已自动生成 Discord 所需地址。')
    return true
  } catch (error) {
    connectionState.value = hadCachedSuccess ? 'stale' : 'error'
    const message =
      error instanceof DOMException && error.name === 'AbortError'
        ? 'Worker 当前复查超时。'
        : `当前无法复查 Worker：${error instanceof Error ? error.message : '未知错误'}`
    if (!background || !hadCachedSuccess) {
      setStatus(
        hadCachedSuccess
          ? `${message} 上次真实检查正常，本机配置不会因此被重置。`
          : `${message} 请确认部署链接是否正确。`,
      )
    }
    return false
  } finally {
    window.clearTimeout(timer)
  }
}

async function checkCommandStatus(background = false): Promise<boolean | undefined> {
  if (!endpoints.value || !botToken.value.trim()) return undefined
  const hadCachedRegistration = cachedCommandWasRegistered()
  if (!background || !hadCachedRegistration) commandState.value = 'checking'
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 8_000)
  try {
    const payload = await checkDiscordWorker(
      {
        workerBaseUrl: workerUrl.value,
        applicationId: applicationId.value,
        botToken: botToken.value,
      },
      'status',
      controller.signal,
    )
    const checkedAt = Date.now()
    saveDiscordSourceConnectionStatus({
      workerVerifiedAt: checkedAt,
      commandCheckedAt: checkedAt,
      commandRegistered: payload.commandRegistered,
    })
    connectionState.value = 'connected'
    commandState.value = payload.commandRegistered ? 'registered' : 'missing'
    return payload.commandRegistered
  } catch (error) {
    commandState.value = hadCachedRegistration ? 'stale' : 'error'
    if (!background || !hadCachedRegistration) {
      setStatus(
        hadCachedRegistration
          ? `当前无法复查 Discord 消息命令：${error instanceof Error ? error.message : '未知错误'}。上次真实检查正常，不会要求你重复注册。`
          : `无法检查 Discord 消息命令：${error instanceof Error ? error.message : '未知错误'}`,
      )
    }
    return undefined
  } finally {
    window.clearTimeout(timer)
  }
}

async function testConnection(): Promise<void> {
  if (!(await persistSettings()) || !endpoints.value) return
  const connected = await verifyWorker(false)
  if (connected && botToken.value.trim()) void checkCommandStatus(true)
}

async function diagnoseConfiguration(): Promise<void> {
  if (!(await persistSettings()) || !endpoints.value) return
  diagnosticState.value = 'checking'
  setStatus('正在检查 Worker、D1 和 Discord 配置…')
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 15_000)
  try {
    const result = await diagnoseDiscordConfiguration(
      {
        workerBaseUrl: workerUrl.value,
        applicationId: applicationId.value,
        publicKey: publicKey.value,
        botToken: botToken.value,
      },
      controller.signal,
    )
    diagnosticState.value = result.state
    connectionState.value = result.workerHealthy ? 'connected' : 'error'
    if (result.workerHealthy) saveDiscordSourceConnectionStatus({ workerVerifiedAt: Date.now() })
    if (typeof result.commandRegistered === 'boolean') {
      saveDiscordSourceConnectionStatus({
        commandCheckedAt: Date.now(),
        commandRegistered: result.commandRegistered,
      })
      commandState.value = result.commandRegistered ? 'registered' : 'missing'
    }
    setStatus(result.message)
  } catch {
    diagnosticState.value = 'worker-error'
    setStatus('检查已停止或超时，请确认后重新检查。')
  } finally {
    window.clearTimeout(timer)
  }
}
async function registerCommand(): Promise<void> {
  if (!(await persistSettings()) || !endpoints.value || !botToken.value.trim()) return
  commandState.value = 'registering'
  setStatus('正在请求 Worker 注册 Discord 消息命令…')
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 8_000)
  try {
    const result = await checkDiscordWorker(
      {
        workerBaseUrl: workerUrl.value,
        applicationId: applicationId.value,
        botToken: botToken.value,
      },
      'register',
      controller.signal,
    )
    if (!result.commandRegistered) throw new Error('注册请求已发送，但真实命令尚未核验通过')
    const checkedAt = Date.now()
    saveDiscordSourceConnectionStatus({
      workerVerifiedAt: checkedAt,
      commandCheckedAt: checkedAt,
      commandRegistered: true,
    })
    connectionState.value = 'connected'
    commandState.value = 'registered'
    showTransientStatus('帖子保存、资源下载与绑定命令已注册并确认。')
  } catch (error) {
    commandState.value = cachedCommandWasRegistered() ? 'stale' : 'error'
    setStatus(
      error instanceof DOMException && error.name === 'AbortError'
        ? '注册请求超时，请先确认 Worker 可以正常访问。'
        : `消息命令注册失败：${error instanceof Error ? error.message : '未知错误'}`,
    )
  } finally {
    window.clearTimeout(timer)
  }
}

async function clearBotToken(): Promise<void> {
  botToken.value = ''
  if (await persistSettings()) {
    connectionState.value = 'idle'
    commandState.value = 'idle'
    showTransientStatus('Discord Bot Token 已从本机清除。')
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-show="
        !(
          discordSetupSession.active &&
          discordSetupSession.webStepActive &&
          discordSetupSession.chatPresentation
        )
      "
      class="resource-source-advanced-overlay mobile-dialog-viewport"
      role="presentation"
      @click.self="emit('close')"
    >
      <section
        class="resource-source-advanced"
        data-assistant-help-context="discord-bridge"
        role="dialog"
        aria-modal="true"
        aria-labelledby="resource-source-advanced-title"
      >
        <header class="resource-source-advanced__header">
          <div>
            <button class="resource-source-advanced__back" type="button" @click="emit('close')">
              ← {{ props.backLabel }}
            </button>
            <h2 id="resource-source-advanced-title">{{ props.title }}</h2>
            <p>配置你自己的 Discord App 与 Cloudflare Worker。配置只保存在本机。</p>
          </div>
        </header>

        <DiscordSetupAssistant />
        <DiscordInboxPanel mode="pairing" />

        <div class="resource-source-status-strip" aria-label="Discord 来源状态">
          <span>
            <i :class="{ 'is-active': discordAppConfigured }"></i>
            Discord App
            <strong>{{ discordAppConfigured ? '已填写' : '待填写' }}</strong>
          </span>
          <span>
            <i
              :class="{
                'is-active': cloudflareStatusActive,
                'is-error': cloudflareStatusError,
                'is-checking': diagnosticState === 'checking',
              }"
            ></i>
            Cloudflare
            <strong>{{ cloudflareStatusLabel }}</strong>
          </span>
          <span>
            <i :class="{ 'is-active': ['registered', 'stale'].includes(commandState) }"></i>
            消息命令
            <strong>{{
              commandState === 'registering'
                ? '注册中'
                : commandState === 'checking'
                  ? '检查中'
                  : commandState === 'registered'
                    ? '正常'
                    : commandState === 'stale'
                      ? '上次正常'
                      : commandState === 'error'
                        ? '检查失败'
                        : commandState === 'missing'
                          ? '待注册'
                          : '待检查'
            }}</strong>
          </span>
        </div>

        <section class="resource-source-handoff">
          <div>
            <strong>从 Discord 领取分享</strong>
            <p>iOS 桌面 PWA 请回到这里粘贴临时链接，确保保存到这份资源库。</p>
          </div>
          <button type="button" @click="openDiscordHandoffPaste">粘贴领取链接</button>
        </section>

        <section class="resource-source-deploy" aria-labelledby="resource-source-deploy-title">
          <header>
            <span id="resource-source-deploy-title">部署 Discord Bridge</span>
            <p>三种方式都部署到你自己的 Cloudflare；SRL 不经过开发者公共 Worker。</p>
          </header>
          <div class="resource-source-deploy__choices">
            <button type="button" @click="githubDeployOpen = true">
              <strong>GitHub 仓库部署</strong>
              <small>推荐长期使用 · Fork 后可同步上游更新并自动部署</small>
              <span>›</span>
            </button>
            <button type="button" @click="oneClickDeployOpen = true">
              <strong>Cloudflare 一键部署</strong>
              <small>适合快速开始 · 上游版本需自己合并到副本</small>
              <span>›</span>
            </button>
            <button type="button" @click="manualDeployOpen = true">
              <strong>浏览器手动部署</strong>
              <small>打开逐步教程；不需要 GitHub / GitLab 或终端</small>
              <span>›</span>
            </button>
          </div>
          <a
            class="resource-source-deploy__source"
            :href="DISCORD_BRIDGE_PUBLIC_REPOSITORY_URL"
            target="_blank"
            rel="noopener noreferrer"
          >
            查看公开 Bridge 模板源码
          </a>
        </section>

        <div class="resource-source-advanced__form">
          <label>
            <span>Application ID</span>
            <div>
              <input
                v-model="applicationId"
                autocomplete="off"
                inputmode="numeric"
                maxlength="64"
              />
              <button type="button" @click="copyText(applicationId, '已复制 Application ID')">
                复制
              </button>
            </div>
          </label>

          <label>
            <span>Public Key</span>
            <div>
              <input v-model="publicKey" autocomplete="off" maxlength="256" />
              <button type="button" @click="copyText(publicKey, '已复制 Public Key')">复制</button>
            </div>
          </label>

          <label data-sensitive>
            <span>Bot Token</span>
            <div>
              <input
                v-model="botToken"
                :type="showToken ? 'text' : 'password'"
                autocomplete="off"
                maxlength="512"
              />
              <button type="button" @click="showToken = !showToken">
                {{ showToken ? '隐藏' : '显示' }}
              </button>
            </div>
            <small>默认由设备保护存储保存；普通资源导出和云备份默认不包含。</small>
          </label>

          <label>
            <span>Token 保存方式</span>
            <div>
              <select v-model="credentialPersistence">
                <option value="local">保存在本机（推荐）</option>
                <option value="session">仅本次使用</option>
              </select>
              <button type="button" @click="clearBotToken">清除本机 Token</button>
            </div>
          </label>

          <label>
            <span>Cloudflare 部署链接</span>
            <input
              v-model="workerUrl"
              inputmode="url"
              maxlength="2000"
              placeholder="https://你的-worker.workers.dev"
              @blur="normalizeWorkerDraft"
            />
            <small>
              只粘贴 Cloudflare 部署完成后给你的链接即可。即使误粘了 /interactions，SRL
              也会自动识别并整理。
            </small>
          </label>

          <section v-if="endpoints" class="resource-source-endpoint">
            <div>
              <span>Discord 最终地址</span>
              <strong>{{ endpoints.interactionsUrl }}</strong>
              <small>
                把这一条粘到 Discord 的 Interactions Endpoint URL。其他技术路径由 SRL 自动处理。
              </small>
            </div>
            <button
              type="button"
              @click="copyText(endpoints.interactionsUrl, '已复制 Discord 最终地址')"
            >
              复制地址
            </button>
          </section>

          <div class="resource-source-advanced__actions">
            <button
              class="button button--primary"
              type="button"
              :disabled="connectionState === 'testing'"
              @click="testConnection"
            >
              {{ connectionState === 'testing' ? '正在检查…' : '保存并测试连接' }}
            </button>
            <button
              class="button button--quiet"
              type="button"
              :disabled="!endpoints || diagnosticState === 'checking'"
              @click="diagnoseConfiguration"
            >
              {{ diagnosticState === 'checking' ? '正在核验…' : '检查部署配置' }}
            </button>
            <button
              class="button button--quiet"
              type="button"
              :disabled="
                !endpoints ||
                !botToken.trim() ||
                commandState === 'registering' ||
                commandState === 'checking'
              "
              @click="registerCommand"
            >
              {{ commandState === 'registering' ? '正在注册…' : '注册消息命令' }}
            </button>
          </div>

          <p v-if="statusMessage" class="resource-source-advanced__status" role="status">
            {{ statusMessage }}
          </p>
        </div>

        <footer class="resource-source-advanced__quick-links">
          <a :href="developerAppUrl" target="_blank" rel="noopener noreferrer">
            创建 / 打开 Discord App
          </a>
          <a :href="installationUrl" target="_blank" rel="noopener noreferrer">打开安装页面</a>
        </footer>

        <p class="resource-source-advanced__status">帖子收件和资源下载请到“功能 → 收件箱”查看。</p>
        <DiscordPendingSources
          v-if="props.contextResourceId"
          :context-resource-id="props.contextResourceId"
        />
      </section>
    </div>
  </Teleport>

  <DiscordSetupGuideDrawer
    :open="oneClickDeployOpen"
    :application-id="applicationId"
    :public-key="publicKey"
    :bot-token="botToken"
    :interactions-url="endpoints?.interactionsUrl"
    :installation-url="installationUrl"
    :developer-app-url="developerAppUrl"
    :developer-bot-url="developerBotUrl"
    @close="oneClickDeployOpen = false"
  />

  <DiscordSetupGuideDrawer
    :open="githubDeployOpen"
    deployment-mode="github"
    :application-id="applicationId"
    :public-key="publicKey"
    :bot-token="botToken"
    :interactions-url="endpoints?.interactionsUrl"
    :installation-url="installationUrl"
    :developer-app-url="developerAppUrl"
    :developer-bot-url="developerBotUrl"
    @close="githubDeployOpen = false"
  />

  <DiscordManualDeployDrawer
    :open="manualDeployOpen"
    :application-id="applicationId"
    :public-key="publicKey"
    :bot-token="botToken"
    :interactions-url="endpoints?.interactionsUrl"
    :installation-url="installationUrl"
    :developer-app-url="developerAppUrl"
    :developer-bot-url="developerBotUrl"
    @close="manualDeployOpen = false"
  />
</template>

<style scoped src="../styles/ResourceLinkAdvancedSettings.css"></style>
