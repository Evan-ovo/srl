import { Capacitor } from '@capacitor/core'
import { confirmAction } from '../composables/UseConfirmDialog'

/** A media adapter only. It neither owns inbox work nor promises OS background execution. */
export class WebBackgroundKeepAlive {
  private media?: HTMLMediaElement
  private audioUrl?: string
  private generation = 0

  private readonly interrupted: (message: string) => void
  constructor(interrupted: (message: string) => void) {
    this.interrupted = interrupted
  }

  private audio(): HTMLAudioElement {
    // Independently generated PCM: a tiny nonzero signal, never a microphone recording.
    const rate = 8_000
    const samples = rate * 20
    const bytes = new ArrayBuffer(44 + samples * 2)
    const view = new DataView(bytes)
    const text = (at: number, value: string) => {
      for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i))
    }
    text(0, 'RIFF')
    view.setUint32(4, bytes.byteLength - 8, true)
    text(8, 'WAVEfmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, rate, true)
    view.setUint32(28, rate * 2, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, 16, true)
    text(36, 'data')
    view.setUint32(40, samples * 2, true)
    for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, i % 2 ? 1 : -1, true)
    this.audioUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))
    const audio = new Audio(this.audioUrl)
    audio.volume = 0.0001
    return audio
  }

  async start(): Promise<void> {
    this.stop()
    const generation = this.generation
    const media = this.audio()
    this.media = media
    media.loop = true
    media.setAttribute('playsinline', '')
    const onInterruption = () => {
      if (this.media !== media) return
      this.interrupted('后台音频已中断，可在设置中重新开启。')
    }
    // Invoke play synchronously in the user's click, before permission or database awaits.
    const playing = media.play()
    try {
      await playing
      if (generation !== this.generation) throw new DOMException('已停止保活', 'AbortError')
      media.addEventListener('pause', onInterruption)
      media.addEventListener('error', onInterruption)
      if ('mediaSession' in navigator) {
        try {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: 'SRL 后台运行',
            artist: 'SRL',
          })
          navigator.mediaSession.setActionHandler('pause', onInterruption)
        } catch {
          /* Media Session metadata is optional; playback already succeeded. */
        }
      }
    } catch (error) {
      void playing.catch(() => undefined)
      if (generation === this.generation) this.stop()
      throw error
    }
  }

  stop(): void {
    this.generation++
    const media = this.media
    this.media = undefined
    if (media) {
      media.pause()
      media.removeAttribute('src')
      media.load()
      media.remove()
    }
    if (this.audioUrl) URL.revokeObjectURL(this.audioUrl)
    this.audioUrl = undefined
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = null
        navigator.mediaSession.setActionHandler('pause', null)
      } catch {
        /* Optional OS media controls may be unavailable. */
      }
    }
  }
}

export interface WebBackgroundAudioState {
  status: 'off' | 'starting' | 'running'
  message: string
  manual: boolean
  tasks: number
}
let state: Pick<WebBackgroundAudioState, 'status' | 'message'> = { status: 'off', message: '' }
let manual = false
const tasks = new Set<symbol>()
let generation = 0
let starting: Promise<void> | undefined
let pageGuardInstalled = false
const listeners = new Set<() => void>()
const backgroundAudio = new WebBackgroundKeepAlive((message) => stopWebBackgroundAudio(message))
export const webBackgroundAudioState = (): WebBackgroundAudioState => ({
  ...state,
  manual,
  tasks: tasks.size,
})
export function subscribeWebBackgroundAudio(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
function publishAudio(): void {
  for (const listener of listeners) listener()
}
/** A manual request outlives all temporary task requests in this page session. */
export function startWebBackgroundAudio(): Promise<void> {
  manual = true
  return ensureWebBackgroundAudio()
}
function ensureWebBackgroundAudio(): Promise<void> {
  publishAudio()
  if (starting) return starting
  if (state.status === 'running') return Promise.resolve()
  const id = ++generation
  state = { status: 'starting', message: '' }
  publishAudio()
  if (!pageGuardInstalled) {
    pageGuardInstalled = true
    window.addEventListener('pagehide', () => stopWebBackgroundAudio())
  }
  starting = (async () => {
    try {
      // Stay in the initiating user gesture; do not await other features first.
      await backgroundAudio.start()
      if (id !== generation) return
      state = { status: 'running', message: '' }
      publishAudio()
    } catch (error) {
      if (id === generation) {
        manual = false
        tasks.clear()
        state = {
          status: 'off',
          message: error instanceof Error ? error.message : '后台音频未能开启。',
        }
        publishAudio()
      }
      throw error
    } finally {
      if (id === generation) starting = undefined
    }
  })()
  return starting
}
export function stopWebBackgroundAudio(message = ''): void {
  ++generation
  starting = undefined
  manual = false
  tasks.clear()
  backgroundAudio.stop()
  state = { status: 'off', message }
  publishAudio()
}

/** Each live operation releases only its own request; rejection never fails the operation. */
export function acquireWebBackgroundAudio(confirmed = false): () => void {
  if (typeof window === 'undefined' || Capacitor.isNativePlatform()) return () => undefined
  if (!confirmed && state.status === 'off') return () => undefined
  const token = Symbol()
  tasks.add(token)
  // play() is reached synchronously, before the caller's first await.
  void ensureWebBackgroundAudio().catch(() => undefined)
  return () => {
    if (!tasks.delete(token)) return
    if (!tasks.size && !manual) stopWebBackgroundAudio()
    else publishAudio()
  }
}

/** Called after acquiring the operation owner's lock; confirm plays in the actual click. */
export async function requestWebBackgroundAudio(
  name: string,
  signal?: AbortSignal,
): Promise<() => void> {
  if (signal?.aborted || typeof window === 'undefined' || Capacitor.isNativePlatform())
    return () => undefined
  if (state.status !== 'off') return acquireWebBackgroundAudio()
  let release = () => undefined as void
  await confirmAction(
    {
      title: '本次任务后台保活',
      message: `是否为“${name}”开启后台音频保活？任务结束后自动关闭；设置里手动开启的保活会继续保持。iOS 仍可能限制后台运行。`,
      confirmLabel: '开启并继续',
      cancelLabel: '直接继续',
      centered: true,
      onConfirm: () => {
        release = acquireWebBackgroundAudio(true)
      },
    },
    signal,
  )
  return release
}

/** The operation owner must hold its normal guard before calling this wrapper. */
export function withWebBackgroundAudio<Args extends unknown[], Result>(
  name: string,
  operation: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return async (...args) => {
    const release = await requestWebBackgroundAudio(name)
    try {
      return await operation(...args)
    } finally {
      release()
    }
  }
}
