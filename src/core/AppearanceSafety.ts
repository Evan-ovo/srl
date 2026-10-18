import recoveryCss from '../styles/RecoveryControls.css?inline'
import { CUSTOM_UI_VIEWS_CHANGED, type CustomUiViews } from '../types/UiCustomization'
import type { CustomCssScope } from '../types/BrowserPreferences'
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
  // Both protected hosts use the top layer index; trial confirmation must stay
  // above the per-view recovery button even when that button mounts later.
  document.body.insertBefore(host, document.getElementById(GUARD_HOST_ID))
  const root = host.attachShadow({ mode: 'open' })
  appearanceTransaction.observeProtectedRoot(root)
  return { host, root }
}

class AppearanceTransactionManager {
  private rollbackActive?: () => void
  private keepActive?: () => void
  private undoConfirmed?: () => void
  private pendingViewTrial = false
  private previewViews?: CustomUiViews
  private finishPreview?: () => void
  private observePreviewRoot?: (root: ShadowRoot) => void

  observeProtectedRoot(root: ShadowRoot): void {
    this.observePreviewRoot?.(root)
  }

  getPreviewViews(): CustomUiViews | undefined {
    return this.previewViews
  }

  isPreviewing(): boolean {
    return Boolean(this.finishPreview)
  }

  exitPreview(): void {
    this.finishPreview?.()
  }

  disablePreviewView(scope: CustomCssScope): boolean {
    if (!this.previewViews) return false
    const view = this.previewViews[scope]
    if (view) this.previewViews = { ...this.previewViews, [scope]: { ...view, enabled: false } }
    window.dispatchEvent(new Event(CUSTOM_UI_VIEWS_CHANGED))
    return true
  }

  preview(options: {
    previousCss: string
    nextCss: string
    views: CustomUiViews
    apply(css: string): void
    onExit(): void
    beforeExit?(): Promise<boolean>
  }): void {
    this.exitPreview()
    this.rollback()
    const { host, root } = createProtectedHost('srl-appearance-preview-layer')
    root.innerHTML = `<style>${recoveryCss}</style><aside class="appearance-preview-controls" popover="manual" aria-label="外观预览"><div class="appearance-preview-actions"><button type="button" data-exit-preview title="退出预览（Esc）"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5H5v14h4m5-12 5 5-5 5m-5-5h10" /></svg><span>退出预览</span></button><button type="button" data-preview-info aria-label="预览说明" aria-expanded="false" aria-controls="srl-preview-help"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 11v5m0-9v1"/></svg></button></div><div id="srl-preview-help" class="appearance-preview-help" role="note" hidden><strong>外观仅临时生效</strong><p>退出后恢复原外观，编辑草稿保留。</p><p>保存、删除会影响真实数据，退出预览不会撤销。</p></div></aside>`
    const controls = root.querySelector<HTMLElement>('.appearance-preview-controls')!
    const help = root.querySelector<HTMLElement>('#srl-preview-help')!
    const info = root.querySelector<HTMLButtonElement>('[data-preview-info]')!
    const setHelp = (open: boolean) => {
      help.hidden = !open
      info.setAttribute('aria-expanded', String(open))
    }
    info.addEventListener('click', () => setHelp(help.hidden === true))
    const syncTheme = () => {
      host.dataset.previewTheme =
        document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
    }
    syncTheme()
    const protectedRoots = new Set<ShadowRoot>()
    const modals: HTMLDialogElement[] = []
    const exit = () => {
      if (this.finishPreview !== exit) return
      this.finishPreview = undefined
      this.previewViews = undefined
      this.observePreviewRoot = undefined
      document.removeEventListener('keydown', escape, true)
      document.removeEventListener('toggle', raiseControls, true)
      for (const other of protectedRoots) other.removeEventListener('toggle', raiseControls, true)
      observer.disconnect()
      host.remove()
      try {
        options.apply(options.previousCss)
      } finally {
        window.dispatchEvent(new Event(CUSTOM_UI_VIEWS_CHANGED))
        options.onExit()
      }
    }
    let deciding = false
    const requestExit = async () => {
      if (deciding) return
      deciding = true
      try {
        if (options.beforeExit && !(await options.beforeExit())) return
        exit()
      } finally {
        deciding = false
      }
    }
    const escape = (event: KeyboardEvent) => {
      if (deciding || event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (!help.hidden) {
        setHelp(false)
        info.focus()
        return
      }
      void requestExit()
    }
    // Keep the escape control above native dialogs/popovers opened during the session.
    const placeControls = () => {
      // A top-layer popover outside the active modal is still inert. Keep the
      // protected Shadow host inside that modal until it closes or is removed.
      let parent: HTMLElement = document.body
      for (let index = modals.length - 1; index >= 0; index--) {
        const modal = modals[index]!
        if (modal.isConnected && modal.open) {
          parent = modal
          break
        }
      }
      controls.hidePopover?.()
      if (host.parentNode !== parent) parent.append(host)
      controls.showPopover?.()
    }
    const raiseControls = (event: Event) => {
      if (event.target === controls) return
      if (event.target instanceof HTMLDialogElement) {
        const index = modals.indexOf(event.target)
        if (index !== -1) modals.splice(index, 1)
        if (event.target.open && event.target.matches(':modal')) modals.push(event.target)
      }
      placeControls()
    }
    const observer = new MutationObserver(() => {
      syncTheme()
      for (let index = modals.length - 1; index >= 0; index--) {
        if (!modals[index]!.isConnected || !modals[index]!.open) modals.splice(index, 1)
      }
      for (const other of protectedRoots) {
        if (!other.host.isConnected) {
          other.removeEventListener('toggle', raiseControls, true)
          protectedRoots.delete(other)
        }
      }
      if (this.finishPreview === exit && !host.isConnected) {
        placeControls()
      }
    })
    root.querySelector('[data-exit-preview]')!.addEventListener('click', () => void requestExit())
    document.addEventListener('keydown', escape, true)
    document.addEventListener('toggle', raiseControls, true)
    this.observePreviewRoot = (other) => {
      protectedRoots.add(other)
      other.addEventListener('toggle', raiseControls, true)
    }
    observer.observe(document.body, { childList: true, subtree: true })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    this.previewViews = options.views
    this.finishPreview = exit
    try {
      controls.showPopover?.()
      options.apply(options.nextCss)
      window.dispatchEvent(new Event(CUSTOM_UI_VIEWS_CHANGED))
    } catch (error) {
      exit()
      throw error
    }
  }

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
    this.exitPreview()
    this.rollbackActive?.()
  }

  begin(options: AppearanceTransactionOptions): void {
    this.exitPreview()
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
    this.exitPreview()
    this.rollbackActive?.()
    this.undoConfirmed = undefined
    localStorage.removeItem(PENDING_APPEARANCE_KEY)
    localStorage.setItem(LAST_GOOD_APPEARANCE_KEY, css)
    persist(css)
    apply(css)
  }
}

export const appearanceTransaction = new AppearanceTransactionManager()
