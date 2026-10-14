import recoveryCss from '../styles/RecoveryControls.css?inline'
const GUARD_HOST_ID = 'srl-appearance-safe-layer'
import {
  PENDING_APPEARANCE_KEY,
  LAST_GOOD_APPEARANCE_KEY,
  type PendingAppearance,
} from './AppearanceSafetyStorage'
export { recoverInterruptedAppearance, readLastGoodAppearance } from './AppearanceSafetyStorage'

interface AppearanceTransactionOptions {
  previousCss: string
  nextCss: string
  apply(css: string): void
  persist(css: string): void
  onKeep?(): void
  onRollback?(): void
  durationMs?: number
  autoKeep?: boolean
  previousViews?: string
  title?: string
}

export function createProtectedHost(id: string): { host: HTMLDivElement; root: ShadowRoot } {
  document.getElementById(id)?.remove()
  const host = document.createElement('div')
  host.id = id
  const importantStyles: Record<string, string> = {
    all: 'initial',
    display: 'block',
    position: 'fixed',
    inset: 'auto 12px 12px 12px',
    'z-index': '2147483647',
    'pointer-events': 'none',
    visibility: 'visible',
    opacity: '1',
  }
  for (const [property, value] of Object.entries(importantStyles)) {
    host.style.setProperty(property, value, 'important')
  }
  document.body.append(host)
  return { host, root: host.attachShadow({ mode: 'open' }) }
}

class AppearanceTransactionManager {
  private rollbackActive?: () => void
  private keepActive?: () => void
  private undoConfirmed?: () => void
  private pendingViewTrial = false

  hasPendingViewTrial(): boolean {
    return this.pendingViewTrial
  }

  keep(): void {
    this.keepActive?.()
  }
  undo(): boolean {
    if (this.rollbackActive) {
      this.rollbackActive()
      return true
    }
    const undo = this.undoConfirmed
    this.undoConfirmed = undefined
    if (!undo) return false
    undo()
    return true
  }

  rollback(): void {
    this.rollbackActive?.()
  }

  begin(options: AppearanceTransactionOptions): void {
    this.rollbackActive?.()
    const durationMs = Math.max(1000, options.durationMs ?? 15_000)
    const pending: PendingAppearance = {
      previousCss: options.previousCss,
      nextCss: options.nextCss,
      expiresAt: Date.now() + durationMs,
      ...(options.previousViews !== undefined ? { previousViews: options.previousViews } : {}),
    }
    localStorage.setItem(PENDING_APPEARANCE_KEY, JSON.stringify(pending))
    options.persist(options.nextCss)
    options.apply(options.nextCss)

    const { host, root } = createProtectedHost(GUARD_HOST_ID)
    root.innerHTML = `<style>${recoveryCss}</style><div class="guard" role="alert"><div class="copy"><strong>自定义 CSS 已临时应用</strong><span data-countdown></span></div><div class="actions"><button type="button" data-rollback>立即恢复</button><button type="button" class="keep" data-keep>保留更改</button></div></div>`
    const countdown = root.querySelector<HTMLElement>('[data-countdown]')
    if (options.title) root.querySelector('strong')!.textContent = options.title
    if (options.autoKeep) {
      root.querySelector('strong')!.textContent = '美化已应用'
      root.querySelector('[data-rollback]')!.textContent = '撤销'
      root.querySelector('[data-keep]')!.textContent = '收起提示'
      host.style.setProperty(
        'bottom',
        'calc(94px + var(--bottom-nav-reserved, 0px) + var(--safe-bottom, 0px))',
        'important',
      )
      root.querySelector('.guard')?.classList.add('is-compact')
    }
    const updateCountdown = () => {
      if (countdown)
        countdown.textContent = options.autoKeep
          ? '不满意可以立即恢复，或在对话里说“撤销”。提示会自动收起。'
          : `${Math.max(0, Math.ceil((pending.expiresAt - Date.now()) / 1000))} 秒内未确认将自动恢复上一版`
    }
    updateCountdown()
    const interval = window.setInterval(updateCountdown, 250)
    let settled = false
    const finish = (keep: boolean) => {
      if (settled) return
      settled = true
      window.clearInterval(interval)
      window.clearTimeout(timeout)
      host.remove()
      localStorage.removeItem(PENDING_APPEARANCE_KEY)
      this.rollbackActive = undefined
      this.keepActive = undefined
      this.pendingViewTrial = false
      if (keep) {
        localStorage.setItem(LAST_GOOD_APPEARANCE_KEY, options.nextCss)
        this.undoConfirmed = () => {
          options.persist(options.previousCss)
          options.apply(options.previousCss)
          localStorage.setItem(LAST_GOOD_APPEARANCE_KEY, options.previousCss)
          options.onRollback?.()
        }
        options.onKeep?.()
      } else {
        this.undoConfirmed = undefined
        options.persist(options.previousCss)
        options.apply(options.previousCss)
        localStorage.setItem(LAST_GOOD_APPEARANCE_KEY, options.previousCss)
        options.onRollback?.()
      }
    }
    const timeout = window.setTimeout(() => finish(Boolean(options.autoKeep)), durationMs)
    root.querySelector('[data-keep]')?.addEventListener('click', () => finish(true))
    root.querySelector('[data-rollback]')?.addEventListener('click', () => finish(false))
    this.rollbackActive = () => finish(false)
    this.keepActive = () => finish(true)
    this.pendingViewTrial = options.previousViews !== undefined && !options.autoKeep
  }

  clear(css: string, apply: (value: string) => void, persist: (value: string) => void): void {
    this.rollbackActive?.()
    this.undoConfirmed = undefined
    localStorage.removeItem(PENDING_APPEARANCE_KEY)
    localStorage.setItem(LAST_GOOD_APPEARANCE_KEY, css)
    persist(css)
    apply(css)
  }
}

export const appearanceTransaction = new AppearanceTransactionManager()
