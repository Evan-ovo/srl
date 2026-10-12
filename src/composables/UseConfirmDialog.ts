import { readonly, shallowRef } from 'vue'
import type { AssistantTokenReview } from '../services/ProductAssistantContext'

/**
 * 全项目统一的确认对话框服务。
 *
 * 取代原生 window.confirm：可样式化、适配移动端安全区与深色主题，
 * Esc / 点击遮罩等同取消。confirmAction 返回 Promise<boolean>，
 * 服务本身不依赖组件上下文，composable 与普通模块都可直接调用；
 * 并发请求按先后排队，同一时刻只显示一个对话框。
 */

export interface ConfirmDialogOptions {
  /** 正文，支持 \n 换行。 */
  message: string
  /** 标题，默认「请确认」。 */
  title?: string
  confirmLabel?: string
  cancelLabel?: string
  /** 危险操作：确认按钮红色，默认聚焦取消按钮。 */
  danger?: boolean
  centered?: boolean
  tokenReview?: AssistantTokenReview
  /** Uses the existing password settings owner; passwords never enter this queue. */
  secretUnlock?: boolean
}

export interface ChoiceDialogOptions extends ConfirmDialogOptions {
  /** 第三个操作按钮；适合不应被归为“取消”的明确选择。 */
  alternativeLabel: string
  additionalLabel?: string
}

export interface ActiveConfirmDialog extends Required<
  Omit<ConfirmDialogOptions, 'tokenReview' | 'secretUnlock'>
> {
  id: number
  tokenReview?: AssistantTokenReview
  secretUnlock?: boolean
  alternativeLabel?: string
  additionalLabel?: string
}

export type ConfirmDialogResponse = 'confirm' | 'cancel' | 'alternative' | 'additional'

interface PendingConfirm {
  dialog: ActiveConfirmDialog
  resolve: (response: ConfirmDialogResponse) => void
}

let nextId = 1
const queue: PendingConfirm[] = []
const activeDialog = shallowRef<ActiveConfirmDialog>()
let activeResolve: ((response: ConfirmDialogResponse) => void) | undefined

function present(next: PendingConfirm): void {
  activeDialog.value = next.dialog
  activeResolve = next.resolve
}

/** 弹出确认对话框；resolve(true) 表示用户确认。 */
export function confirmAction(
  options: ConfirmDialogOptions,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  const dialog: ActiveConfirmDialog = {
    id: nextId++,
    message: options.message,
    title: options.title ?? '请确认',
    confirmLabel: options.confirmLabel ?? '确认',
    cancelLabel: options.cancelLabel ?? '取消',
    danger: options.danger ?? false,
    centered: options.centered ?? false,
    tokenReview: options.tokenReview,
    secretUnlock: options.secretUnlock,
  }
  return new Promise<boolean>((resolve) => {
    const cancel = () => {
      if (activeDialog.value?.id === dialog.id) {
        activeDialog.value = undefined
        activeResolve = undefined
        pending.resolve('cancel')
        const next = queue.shift()
        if (next) present(next)
      } else {
        const index = queue.findIndex((item) => item.dialog.id === dialog.id)
        if (index >= 0) queue.splice(index, 1)[0]!.resolve('cancel')
      }
    }
    const pending = {
      dialog,
      resolve: (response: ConfirmDialogResponse) => {
        signal?.removeEventListener('abort', cancel)
        resolve(response === 'confirm')
      },
    }
    signal?.addEventListener('abort', cancel, { once: true })
    if (activeDialog.value) queue.push(pending)
    else present(pending)
  })
}

/** 弹出带第三个明确选项的确认框，与 confirmAction 共用同一根节点、队列和焦点规则。 */
export function chooseAction(
  options: ChoiceDialogOptions,
  signal?: AbortSignal,
): Promise<ConfirmDialogResponse> {
  if (signal?.aborted) return Promise.resolve('cancel')
  const dialog: ActiveConfirmDialog = {
    id: nextId++,
    message: options.message,
    title: options.title ?? '请确认',
    confirmLabel: options.confirmLabel ?? '确认',
    cancelLabel: options.cancelLabel ?? '取消',
    danger: options.danger ?? false,
    centered: options.centered ?? false,
    alternativeLabel: options.alternativeLabel,
    additionalLabel: options.additionalLabel,
    tokenReview: options.tokenReview,
  }
  return new Promise<ConfirmDialogResponse>((resolve) => {
    const cancel = () => {
      if (activeDialog.value?.id === dialog.id) {
        activeDialog.value = undefined
        activeResolve = undefined
        pending.resolve('cancel')
        const next = queue.shift()
        if (next) present(next)
      } else {
        const index = queue.findIndex((item) => item.dialog.id === dialog.id)
        if (index >= 0) queue.splice(index, 1)[0]!.resolve('cancel')
      }
    }
    const pending = {
      dialog,
      resolve: (response: ConfirmDialogResponse) => {
        signal?.removeEventListener('abort', cancel)
        resolve(response)
      },
    }
    signal?.addEventListener('abort', cancel, { once: true })
    if (activeDialog.value) queue.push(pending)
    else present(pending)
  })
}

/** 供根节点对话框组件使用的状态与应答入口。 */
export function useConfirmDialogState() {
  return {
    activeDialog: readonly(activeDialog),
    respond(response: ConfirmDialogResponse): void {
      const resolve = activeResolve
      activeResolve = undefined
      activeDialog.value = undefined
      resolve?.(response)
      const next = queue.shift()
      if (next) present(next)
    },
  }
}
