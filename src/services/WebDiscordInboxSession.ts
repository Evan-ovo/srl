import { requestWebBackgroundAudio } from './WebBackgroundKeepAlive'
import { Capacitor } from '@capacitor/core'
import { taskCenter } from '../core/TaskCenter'
import { noticeCenter } from '../core/NoticeCenter'
import { inboxConnection } from './DiscordHandoffService'

export interface WebInboxState {
  status: 'off' | 'starting' | 'running' | 'pausing' | 'paused'
  message: string
}
export interface WebInboxCycle {
  signal: AbortSignal
  current: () => boolean
}
const TASK_ID = 'discord-web-inbox-session'
const STOPPED_KEY = 'srl.web-inbox.explicit-stop'
const listeners = new Set<() => void>()
const participants = new Map<
  string,
  { run: (cycle: WebInboxCycle) => Promise<void>; pause?: () => Promise<void> }
>()
let state: WebInboxState = { status: 'off', message: '' }
let controller: AbortController | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let expiry: ReturnType<typeof setTimeout> | undefined
let target: ReturnType<typeof inboxConnection> | undefined
let poll: Promise<void> | undefined
let session = 0
let guardsInstalled = false

export function isWebDiscordInboxAvailable(): boolean {
  return !Capacitor.isNativePlatform() && typeof window !== 'undefined'
}
export const isWebDiscordInboxRunning = () => state.status === 'running'
export const webDiscordInboxSignal = () => controller?.signal
export const webDiscordInboxState = (): WebInboxState =>
  state.status === 'off' && isWebDiscordInboxPaused()
    ? { ...state, status: 'paused', message: state.message || '上次收件已停止，请手动继续。' }
    : { ...state }
export function isWebDiscordInboxPaused(): boolean {
  try {
    return (
      state.status === 'paused' ||
      state.status === 'pausing' ||
      localStorage.getItem(STOPPED_KEY) === '1'
    )
  } catch {
    return state.status === 'paused'
  }
}
export function subscribeWebDiscordInbox(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
export function registerWebInboxParticipant(
  owner: string,
  run: (cycle: WebInboxCycle) => Promise<void>,
  pause?: () => Promise<void>,
): () => void {
  const participant = { run, pause }
  participants.set(owner, participant)
  return () => {
    if (participants.get(owner) === participant) participants.delete(owner)
    if (isWebDiscordInboxRunning())
      pauseWebDiscordInbox('收件处理已退出，请重新打开资源库后开启收件。')
  }
}
function publish(): void {
  for (const listener of listeners) listener()
  window.dispatchEvent(new CustomEvent('srl:web-inbox-state', { detail: webDiscordInboxState() }))
}
function targetCurrent(): boolean {
  try {
    const current = inboxConnection()
    return Boolean(
      target &&
      current.workerUrl === target.workerUrl &&
      current.libraryId === target.libraryId &&
      current.secret === target.secret,
    )
  } catch {
    return false
  }
}
function schedule(): void {
  clearTimeout(timer)
  if (!isWebDiscordInboxRunning()) return
  timer = setTimeout(() => {
    void checkWebDiscordInbox()
  }, 30_000)
}
export async function checkWebDiscordInbox(): Promise<void> {
  if (!isWebDiscordInboxRunning()) return
  if (poll) return poll
  if (!targetCurrent()) {
    pauseWebDiscordInbox('配对已改变或失效，请核对后重新开启收件。')
    return
  }
  const currentSession = session
  const signal = controller!.signal
  const cycle: WebInboxCycle = {
    signal,
    current: () => currentSession === session && !signal.aborted && targetCurrent(),
  }
  poll = (async () => {
    try {
      // Reuse the existing intake owners; no second downloader, parser, database or binding queue.
      await Promise.all([...participants.values()].map(({ run }) => run(cycle)))
      if (cycle.current()) taskCenter.update(TASK_ID, { phase: '等待新帖子和资源；每 30 秒检查' })
    } catch (error) {
      if (!cycle.current()) return
      pauseWebDiscordInbox(error instanceof Error ? error.message : '收件检查失败，请查看后继续。')
    } finally {
      poll = undefined
      if (currentSession === session) schedule()
    }
  })()
  return poll
}
function stopForTarget(): void {
  if (state.status === 'running' || state.status === 'starting')
    pauseWebDiscordInbox('连接设置已改变，请核对目标后重新开启收件。')
}
function stopForVault(): void {
  if (state.status === 'running' || state.status === 'starting')
    pauseWebDiscordInbox('保险库已锁定，解锁后请手动继续收件。')
}
function installGuards(): void {
  if (guardsInstalled) return
  guardsInstalled = true
  window.addEventListener('pagehide', () => pauseWebDiscordInbox('页面已离开，请手动继续收件。'))
  window.addEventListener('srl:discord-inbox-target-changed', stopForTarget)
  window.addEventListener('srl:vault-locked', stopForVault)
}

/** Explicit inbox opt-in. Global background audio is owned separately by settings. */
export async function startWebDiscordInbox(): Promise<void> {
  if (!isWebDiscordInboxAvailable()) throw new Error('此入口用于网页版；APK 请使用原生收件模式。')
  if (state.status === 'starting') return
  const draining = pauseWebDiscordInbox('', false)
  const id = ++session
  target = inboxConnection()
  controller = new AbortController()
  state = { status: 'starting', message: '' }
  installGuards()
  publish()
  let releaseAudio = () => undefined as void
  try {
    releaseAudio = await requestWebBackgroundAudio('后台收件', controller.signal)
    const { initializeVaultOnce, vaultService } = await import('../core/LibraryContainer')
    await Promise.all([initializeVaultOnce(), draining])
    if (id !== session) return
    if (vaultService.getStatus().locked) throw new Error('请先解锁保险库。')
    if (!targetCurrent()) throw new Error('配对已改变，请重新开启收件。')
    try {
      localStorage.removeItem(STOPPED_KEY)
    } catch {
      /* Session still remains explicit. */
    }
    state = { status: 'running', message: '' }
    taskCenter.start({
      operationId: TASK_ID,
      name: '网页后台收件',
      keepAlive: true,
      phase: '检查新帖子和资源',
      background: true,
      cancelable: true,
      cancel: () => pauseWebDiscordInbox('已停止收件，已保存内容保留。'),
      action: { label: '查看收件箱', run: openWebDiscordInbox },
    })
    noticeCenter.push({
      id: TASK_ID,
      type: 'info',
      persistent: true,
      message: '网页后台收件已开启',
      actions: [
        { label: '停止收件', run: () => pauseWebDiscordInbox('已停止收件，已保存内容保留。') },
        { label: '查看收件箱', run: openWebDiscordInbox },
      ],
    })
    publish()
    expiry = setTimeout(
      () => pauseWebDiscordInbox('本轮收件已满 5 小时，可手动继续。'),
      5 * 60 * 60 * 1_000,
    )
    void checkWebDiscordInbox()
  } catch (error) {
    if (id === session)
      pauseWebDiscordInbox(error instanceof Error ? error.message : '收件未能启动。')
    throw error
  } finally {
    releaseAudio()
  }
}

export function pauseWebDiscordInbox(
  message = '已暂停，可在收件箱重新开启收件模式。',
  remember = true,
): Promise<void> {
  const wasActive = state.status === 'running' || state.status === 'starting'
  ++session
  const pausedSession = session
  controller?.abort(new DOMException('网页收件已暂停', 'AbortError'))
  controller = undefined
  clearTimeout(timer)
  clearTimeout(expiry)
  target = undefined
  if (remember) {
    try {
      localStorage.setItem(STOPPED_KEY, '1')
    } catch {
      /* Do not restore running automatically. */
    }
  }
  state = { ...state, status: remember ? 'pausing' : 'off', message }
  if (wasActive) {
    taskCenter.update(TASK_ID, { phase: '正在暂停；保留已完成的提交', cancelable: false })
    noticeCenter.dismiss(TASK_ID)
  }
  publish()
  return Promise.allSettled([
    poll,
    ...[...participants.values()].map(({ pause }) => pause?.()),
  ]).then(() => {
    if (pausedSession !== session) return
    if (remember) state = { ...state, status: 'paused' }
    taskCenter.cancelled(TASK_ID)
    publish()
  })
}
export function openWebDiscordInbox(): void {
  window.dispatchEvent(new CustomEvent('srl:native-deep-link', { detail: { kind: 'inbox' } }))
}
