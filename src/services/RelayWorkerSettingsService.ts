import { computed, ref } from 'vue'
import { savePublicWorkerBaseUrl } from './PublicWorkerSettingsService'

const PUBLIC_WORKER_BASE_URL_KEY = 'srl.publicWorker.baseUrl.v1'
const VERIFIED_DEVICE_RELAY_KEY = 'srl.relayWorker.verifiedDeviceOrigin.v1'
const activeTargets = new Set<symbol>()
const settingsRevision = ref(0)
let latestCheck = 0

export const DEVICE_RELAY_DISABLED_MESSAGE = '中继码功能已停用，请自部署worker'

export interface RelayWorkerTarget {
  readonly origin: string
  readonly custom: boolean
}

export function normalizeRelayWorkerBaseUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  let url: URL
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`)
  } catch {
    throw new Error('请输入有效的 Worker HTTPS 根地址')
  }
  const local =
    url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !local) throw new Error('Worker 地址必须使用 HTTPS')
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('Worker 地址不能包含账号、密码、路径、查询参数或片段')
  return url.origin
}

export function loadRelayWorkerBaseUrl(): string {
  const raw = typeof localStorage === 'undefined' ? '' : (localStorage.getItem(PUBLIC_WORKER_BASE_URL_KEY) ?? '')
  return normalizeRelayWorkerBaseUrl(raw)
}

export function saveRelayWorkerBaseUrl(value: string): string {
  const normalized = normalizeRelayWorkerBaseUrl(value)
  let previous = ''
  try {
    previous = loadRelayWorkerBaseUrl()
  } catch {
    // Allow a valid replacement for a malformed saved address.
  }
  if (normalized !== previous && activeTargets.size)
    throw new Error('仍有中继连接或云盘操作，请先断开互传、结束或取消任务，再切换中继')
  savePublicWorkerBaseUrl(normalized)
  if (localStorage.getItem(VERIFIED_DEVICE_RELAY_KEY) !== normalized)
    localStorage.removeItem(VERIFIED_DEVICE_RELAY_KEY)
  settingsRevision.value += 1
  return normalized
}

export function getDeviceRelayStatus(): { enabled: boolean; message: string } {
  try {
    const target = resolveRelayWorkerTarget()
    if (!target.custom) return { enabled: false, message: DEVICE_RELAY_DISABLED_MESSAGE }
    if (localStorage.getItem(VERIFIED_DEVICE_RELAY_KEY) !== target.origin)
      return {
        enabled: false,
        message: '请先在设置 → 自部署 Worker 检测自部署 Worker，检测通过后才能使用中继码',
      }
    return { enabled: true, message: '' }
  } catch (error) {
    return { enabled: false, message: error instanceof Error ? error.message : '中继配置无效' }
  }
}

export function useDeviceRelayStatus() {
  return computed(() => {
    void settingsRevision.value
    return getDeviceRelayStatus()
  })
}

export function acquireDeviceRelayTarget() {
  const status = getDeviceRelayStatus()
  if (!status.enabled) throw new Error(status.message)
  return acquireRelayWorkerTarget()
}

export function resolveRelayWorkerTarget(value = loadRelayWorkerBaseUrl()): RelayWorkerTarget {
  const custom = normalizeRelayWorkerBaseUrl(value)
  // SRL-PUBLIC-SYNC: BEGIN REPLACE id=relay-worker-default-target
  const origin = custom
  // SRL-PUBLIC-SYNC: END REPLACE id=relay-worker-default-target
  return Object.freeze({ origin, custom: Boolean(custom) })
}

export function relayWorkerEndpoint(path: string, target = resolveRelayWorkerTarget()): URL {
  if (!path.startsWith('/')) throw new Error('中继接口路径无效')
  if (!target.custom || !target.origin) throw new Error('请先配置自己的 SRL Worker 地址')
  const endpoint = new URL(path, target.origin)
  if (endpoint.origin !== target.origin) throw new Error('中继接口不能指向其他服务')
  return endpoint
}

export function acquireRelayWorkerTarget() {
  const target = resolveRelayWorkerTarget()
  if (!target.custom) throw new Error('请先配置自己的 SRL Worker 地址')
  const id = Symbol('relay-target')
  activeTargets.add(id)
  return { target, release: () => activeTargets.delete(id) }
}

export async function checkRelayWorker(value: string, signal?: AbortSignal): Promise<void> {
  const target = resolveRelayWorkerTarget(value)
  if (!target.custom) throw new Error(DEVICE_RELAY_DISABLED_MESSAGE)
  const checkId = ++latestCheck
  let savedAtStart = ''
  try {
    savedAtStart = loadRelayWorkerBaseUrl()
  } catch {
    // A draft can still be checked while replacing a malformed stored address.
  }
  if (localStorage.getItem(VERIFIED_DEVICE_RELAY_KEY) === target.origin) {
    localStorage.removeItem(VERIFIED_DEVICE_RELAY_KEY)
    settingsRevision.value += 1
  }
  const options: RequestInit = {
    headers: { accept: 'application/json' },
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
    signal,
  }
  signal?.throwIfAborted()
  const response = await fetch(relayWorkerEndpoint('/api/cloud/health', target), options)
  if (!response.ok) throw new Error(`中继检查失败（HTTP ${response.status}）`)
  const payload = (await response.json()) as { ok?: unknown; service?: unknown }
  if (payload?.ok !== true || payload.service !== 'srl-koofr-worker')
    throw new Error('该地址没有返回有效的 SRL Worker 状态')
  signal?.throwIfAborted()
  const bridge = await fetch(relayWorkerEndpoint('/api/bridge/health', target), options)
  if (!bridge.ok) throw new Error(`中继码检查失败（HTTP ${bridge.status}）`)
  const bridgePayload = (await bridge.json()) as {
    ok?: unknown
    service?: unknown
    deviceCodeEnabled?: unknown
  }
  if (
    bridgePayload?.ok !== true ||
    bridgePayload.service !== 'srl-bridge-cloudflare' ||
    bridgePayload.deviceCodeEnabled === false
  )
    throw new Error('该 Worker 未提供可用的中继码接口，请检查自部署状态')
  signal?.throwIfAborted()
  let savedAtEnd = ''
  try {
    savedAtEnd = loadRelayWorkerBaseUrl()
  } catch {
    // Keep malformed storage distinct from a newly saved valid address.
  }
  if (checkId !== latestCheck || savedAtStart !== savedAtEnd)
    throw new Error('中继地址或检测已变化，请重新检测当前 Worker')
  localStorage.setItem(VERIFIED_DEVICE_RELAY_KEY, target.origin)
  settingsRevision.value += 1
}
