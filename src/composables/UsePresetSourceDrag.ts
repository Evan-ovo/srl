import { ref } from 'vue'
interface PresetSourceDragContext {
  busy: import('vue').Ref<boolean>
  notice: import('vue').Ref<string>
  insertionIndex: import('vue').Ref<number>
  onPickup?: () => void
  commitSourceDrop: (kind: 'segment' | 'favorite' | 'target', id: string, index: number) => void
}
export function usePresetSourceDrag(context: PresetSourceDragContext) {
  const { busy, notice, insertionIndex, commitSourceDrop } = context
  interface SourceDragState {
    kind: 'segment' | 'favorite' | 'target'
    id: string
    startX: number
    startY: number
    x: number
    y: number
    picked: boolean
    overDropSlot: boolean
    targetIndex: number
    timer: number
    pointerId: number
    pointerType: string
  }

  const sourceDrag = ref<SourceDragState>()

  let suppressSourceAction = false
  let captured: HTMLElement | undefined

  function startSourceDrag(
    kind: 'segment' | 'favorite' | 'target',
    id: string,
    event: PointerEvent,
  ): void {
    if (busy.value || event.button !== 0 || event.isPrimary === false) return
    cancelSourceDrag()
    const current = event.currentTarget as HTMLElement
    captured = current
    suppressSourceAction = false
    const state: SourceDragState = {
      kind,
      id,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      picked: false,
      overDropSlot: false,
      targetIndex: insertionIndex.value,
      timer: 0,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
    }
    state.timer = window.setTimeout(pickupSourceDrag, 420)
    sourceDrag.value = state
    window.addEventListener('pointermove', moveSourceDrag)
    window.addEventListener('pointerup', endSourceDrag)
    window.addEventListener('pointercancel', cancelSourceDrag)
    try {
      current.setPointerCapture(event.pointerId)
    } catch {
      // 移动端 WebView 未保留指针捕获时，窗口监听仍可接管移动和松手。
    }
  }

  function pickupSourceDrag(): void {
    const state = sourceDrag.value
    if (!state || state.picked) return
    window.clearTimeout(state.timer)
    state.picked = true
    // 浮动拖动提示已说明落点；这里插入页内提示会推移列表，让原落点失效。
    context.onPickup?.()
  }

  function moveSourceDrag(event: PointerEvent): void {
    const state = sourceDrag.value
    if (!state || state.pointerId !== event.pointerId) return
    state.x = event.clientX
    state.y = event.clientY
    if (!state.picked) {
      const distance = Math.hypot(event.clientX - state.startX, event.clientY - state.startY)
      if (state.pointerType === 'mouse' && distance > 6) {
        pickupSourceDrag()
      } else if (distance > 10) {
        cancelSourceDrag()
        suppressNextSourceAction()
      }
      if (!state.picked) return
    }
    const elements = document.elementsFromPoint(event.clientX, event.clientY)
    const pane = elements
      .map((element) => element.closest<HTMLElement>('.stitch-pane--target'))
      .find(Boolean)
    const list = pane?.querySelector<HTMLElement>('.stitch-target-list')
    state.overDropSlot = false
    if (
      !list ||
      elements.some((element) => element.closest('.stitch-sheet, .stitch-editor, .stitch-tools'))
    )
      return
    const rect = list.getBoundingClientRect()
    if (event.clientY < rect.top || event.clientY > rect.bottom) return
    // 条目上下半区对应前后插入点，不要求用户瞄准细线。
    const slot = elements
      .map((element) => element.closest<HTMLElement>('[data-insertion-index]'))
      .find((element) => element && list.contains(element))
    const row = elements
      .map((element) => element.closest<HTMLElement>('[data-entry-index]'))
      .find((element) => element && list.contains(element))
    if (slot) state.targetIndex = Number(slot.dataset.insertionIndex)
    else if (row) {
      const rowRect = row.getBoundingClientRect()
      state.targetIndex =
        Number(row.dataset.entryIndex) + (event.clientY >= rowRect.top + rowRect.height / 2 ? 1 : 0)
    } else {
      const slots = [...list.querySelectorAll<HTMLElement>('[data-insertion-index]')]
      const nearest = slots.reduce<HTMLElement | undefined>(
        (best, item) =>
          !best ||
          Math.abs(item.getBoundingClientRect().top - event.clientY) <
            Math.abs(best.getBoundingClientRect().top - event.clientY)
            ? item
            : best,
        undefined,
      )
      if (!nearest) return
      state.targetIndex = Number(nearest.dataset.insertionIndex)
    }
    state.overDropSlot = true
  }

  function guardDragTouch(event: TouchEvent): void {
    if (sourceDrag.value?.picked && event.cancelable) event.preventDefault()
  }

  function endSourceDrag(event?: PointerEvent): void {
    const state = sourceDrag.value
    if (!state || (event && state.pointerId !== event.pointerId)) return
    if (event && state.picked) moveSourceDrag(event)
    window.clearTimeout(state.timer)
    stopSourceDragTracking()
    if (state.picked) {
      suppressNextSourceAction()
      if (!state.overDropSlot) notice.value = '未放到主预设条目之间，本次没有加入'
      else commitSourceDrop(state.kind, state.id, state.targetIndex)
    }
    sourceDrag.value = undefined
  }

  function cancelSourceDrag(event?: PointerEvent): void {
    const state = sourceDrag.value
    if (!state || (event && state.pointerId !== event.pointerId)) return
    window.clearTimeout(state.timer)
    stopSourceDragTracking()
    if (state.picked) suppressNextSourceAction()
    sourceDrag.value = undefined
  }

  function stopSourceDragTracking(): void {
    const pointerId = sourceDrag.value?.pointerId
    if (pointerId !== undefined && captured?.hasPointerCapture?.(pointerId))
      captured.releasePointerCapture(pointerId)
    captured = undefined
    window.removeEventListener('pointermove', moveSourceDrag)
    window.removeEventListener('pointerup', endSourceDrag)
    window.removeEventListener('pointercancel', cancelSourceDrag)
  }

  function suppressNextSourceAction(): void {
    suppressSourceAction = true
    // 下一次 pointerdown 重置，保留移动端延迟 click 的抑制。
  }

  function consumeSuppressedSourceAction(): boolean {
    if (!suppressSourceAction) return false
    suppressSourceAction = false
    return true
  }
  return {
    sourceDrag,
    guardDragTouch,
    startSourceDrag,
    cancelSourceDrag,
    consumeSuppressedSourceAction,
  }
}
