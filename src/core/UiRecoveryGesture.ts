/** Shared by the native host and the sandbox. Keep self-contained for serialization. */
export function installUiRecoveryGesture(
  doc: Document,
  reveal: () => void,
  active: (event: PointerEvent) => boolean = () => true,
): () => void {
  const win = doc.defaultView
  if (!win) return () => {}
  let timer: number | undefined
  let press: { id: number; x: number; y: number } | undefined
  let suppressClick = false
  const cancel = () => {
    if (timer !== undefined) win.clearTimeout(timer)
    timer = undefined
    press = undefined
  }
  const down = (event: PointerEvent) => {
    cancel()
    suppressClick = false
    if (event.isPrimary === false || event.button !== 0 || !active(event)) return
    press = { id: event.pointerId, x: event.clientX, y: event.clientY }
    timer = win.setTimeout(() => {
      timer = undefined
      if (!press || doc.hidden || !active(event)) return
      suppressClick = true
      reveal()
    }, 2000)
  }
  const move = (event: PointerEvent) => {
    if (
      press?.id === event.pointerId &&
      Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10
    )
      cancel()
  }
  const up = (event: PointerEvent) => {
    if (press?.id === event.pointerId) cancel()
  }
  const click = (event: MouseEvent) => {
    if (!suppressClick || event.detail === 0) return
    suppressClick = false
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  const contextMenu = (event: Event) => {
    if (press) event.preventDefault()
  }
  const visibility = () => {
    if (doc.hidden) cancel()
  }
  doc.addEventListener('pointerdown', down, true)
  doc.addEventListener('pointermove', move, true)
  doc.addEventListener('pointerup', up, true)
  doc.addEventListener('pointercancel', up, true)
  doc.addEventListener('click', click, true)
  doc.addEventListener('contextmenu', contextMenu, true)
  doc.addEventListener('scroll', cancel, true)
  doc.addEventListener('visibilitychange', visibility)
  win.addEventListener('blur', cancel)
  win.addEventListener('pagehide', cancel)
  return () => {
    cancel()
    doc.removeEventListener('pointerdown', down, true)
    doc.removeEventListener('pointermove', move, true)
    doc.removeEventListener('pointerup', up, true)
    doc.removeEventListener('pointercancel', up, true)
    doc.removeEventListener('click', click, true)
    doc.removeEventListener('contextmenu', contextMenu, true)
    doc.removeEventListener('scroll', cancel, true)
    doc.removeEventListener('visibilitychange', visibility)
    win.removeEventListener('blur', cancel)
    win.removeEventListener('pagehide', cancel)
  }
}
