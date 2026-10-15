import { inboxRequest, type DiscordInboxTarget } from './DiscordHandoffService'
import { cancelNativeCloudDiscordResource } from '../utils/ShareTargetIntake'
import { Capacitor } from '@capacitor/core'

export const RESOURCE_JOB_STATES = [
  'queued',
  'downloading',
  'importing',
  'waiting_version',
  'imported',
  'failed',
  'cancelled',
] as const
export type DiscordResourceState = (typeof RESOURCE_JOB_STATES)[number]
export interface DiscordResourceJob {
  id: string
  libraryId: string
  name: string
  size: number
  state: DiscordResourceState
  error?: string | null
  createdAt: number
  updatedAt: number
  expiresAt: number
}
const WEB_MAX_BYTES = 256 * 1024 * 1024

function parseJob(value: unknown): DiscordResourceJob {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('资源下载任务无效')
  const job = value as DiscordResourceJob
  if (
    !/^[a-f\d-]{36}$/u.test(job.id) ||
    typeof job.libraryId !== 'string' ||
    typeof job.name !== 'string' ||
    !job.name ||
    job.name.length > 240 ||
    !Number.isSafeInteger(job.size) ||
    job.size < 0 ||
    !RESOURCE_JOB_STATES.includes(job.state) ||
    ![job.createdAt, job.updatedAt, job.expiresAt].every(Number.isSafeInteger) ||
    (job.error !== undefined && job.error !== null && typeof job.error !== 'string')
  )
    throw new Error('资源下载任务无效')
  return job
}

export async function listDiscordResourceJobs(
  target?: DiscordInboxTarget,
  after?: string,
  signal?: AbortSignal,
): Promise<{
  jobs: DiscordResourceJob[]
  recent: DiscordResourceJob[]
  hasMore: boolean
}> {
  if (after !== undefined && !/^\d{1,13}:[a-f\d-]{36}$/u.test(after))
    throw new Error('资源下载分页无效')
  const payload = (await (
    await inboxRequest(
      `/resources${after ? '?after=' + encodeURIComponent(after) : ''}`,
      'GET',
      undefined,
      target,
      signal,
    )
  ).json()) as Record<string, unknown>
  const read = (value: unknown) => {
    if (!Array.isArray(value) || value.length > 20) throw new Error('资源下载列表无效')
    const jobs = value.map(parseJob)
    if (target && jobs.some((job) => job.libraryId !== target.libraryId))
      throw new Error('资源下载目标不匹配')
    return jobs
  }
  if (typeof payload.hasMore !== 'boolean') throw new Error('资源下载列表无效')
  return { jobs: read(payload.jobs), recent: read(payload.recent), hasMore: payload.hasMore }
}

function jobPath(id: string): string {
  if (!/^[a-f\d-]{36}$/u.test(id)) throw new Error('资源下载任务身份无效')
  return `/resources/${id}`
}

export async function readDiscordResourceJob(
  id: string,
  target: DiscordInboxTarget,
  signal?: AbortSignal,
): Promise<DiscordResourceJob & { url: string }> {
  const payload = (await (
    await inboxRequest(jobPath(id), 'GET', undefined, target, signal)
  ).json()) as {
    url?: unknown
  }
  const job = parseJob(payload)
  if (job.id !== id || job.libraryId !== target.libraryId || typeof payload.url !== 'string')
    throw new Error('资源下载目标不匹配')
  const url = new URL(payload.url)
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname) ||
    url.pathname.length <= 1
  )
    throw new Error('资源附件直链无效')
  return { ...job, url: url.toString() }
}

export async function acknowledgeDiscordResource(
  id: string,
  state: DiscordResourceState,
  target: DiscordInboxTarget,
  error?: string,
): Promise<void> {
  await inboxRequest(`${jobPath(id)}/ack`, 'POST', { state, error }, target)
}

export async function cancelDiscordResourceJob(
  id: string,
  target: DiscordInboxTarget,
): Promise<void> {
  await acknowledgeDiscordResource(id, 'cancelled', target)
  window.dispatchEvent(new CustomEvent('srl:discord-resource-cancelled', { detail: { id } }))
  try {
    const cancelled = await cancelNativeCloudDiscordResource({ id, ...target })
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android' && !cancelled)
      throw new Error('当前 APK 不支持停止本机云端下载')
  } catch (error) {
    throw new Error('云端任务已取消，但本机下载器没有确认停止；请回到任务中心检查。', {
      cause: error,
    })
  }
}

export async function deleteDiscordResourceJob(
  id: string,
  target?: DiscordInboxTarget,
): Promise<void> {
  await inboxRequest(`${jobPath(id)}`, 'DELETE', undefined, target)
}

export async function downloadWebDiscordResource(
  job: DiscordResourceJob,
  target: DiscordInboxTarget,
  signal: AbortSignal,
  progress: (bytes: number, total?: number) => void,
): Promise<File> {
  if (job.size > WEB_MAX_BYTES)
    throw new Error('网页一次最多下载 256 MiB；更大的文件请使用 APK 或手动导入。')
  const response = await inboxRequest(`${jobPath(job.id)}/file`, 'GET', undefined, target, signal)
  const declared = response.headers.get('Content-Length')
  const total =
    declared !== null && Number.isSafeInteger(Number(declared)) && Number(declared) > 0
      ? Number(declared)
      : undefined
  const reader = response.body?.getReader()
  if (!reader) throw new Error('附件没有返回文件内容')
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let received = 0
  try {
    if (total && total > WEB_MAX_BYTES)
      throw new Error('附件超过网页 256 MiB 下载上限，请使用 APK。')
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > WEB_MAX_BYTES || (total && received > total))
        throw new Error('附件超出下载大小限制，未导入。')
      chunks.push(value)
      progress(received, total)
    }
    if (!received || (total && received !== total))
      throw new Error('附件下载不完整，未导入；请重试。')
    return new File(chunks, job.name, {
      type: response.headers.get('Content-Type') || 'application/octet-stream',
    })
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
