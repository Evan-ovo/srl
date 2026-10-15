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
}
let state: WebBackgroundAudioState = { status: 'off', message: '' }
let generation = 0
let starting: Promise<void> | undefined
let pageGuardInstalled = false
const listeners = new Set<() => void>()
const backgroundAudio = new WebBackgroundKeepAlive((message) => stopWebBackgroundAudio(message))
export const webBackgroundAudioState = (): WebBackgroundAudioState => ({ ...state })
export function subscribeWebBackgroundAudio(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
function publishAudio(): void {
  for (const listener of listeners) listener()
}
/** Global opt-in media only: no inbox, vault, task, pairing or network dependency. */
export function startWebBackgroundAudio(): Promise<void> {
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
  backgroundAudio.stop()
  state = { status: 'off', message }
  publishAudio()
}
