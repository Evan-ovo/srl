import type { AppearanceScope } from '../core/AppearanceScopes'
import type { AssistantImage } from './ProductAssistantService'
import { isAssistantAuthenticationVisible } from '../core/ProductAssistantViewContext'

/** Render the real mounted page. Current-view references are masked before rendering. */
export async function captureAssistantPage(
  scope: AppearanceScope,
  signal: AbortSignal,
  currentView = false,
): Promise<AssistantImage> {
  const assistantTarget = scope.appId === 'assistant'
  const source = Array.from(document.querySelectorAll<HTMLElement>(scope.selector)).find(
    (node) =>
      !node.closest('.assistant-pet-dialog') &&
      (!currentView || node.getBoundingClientRect().height > 0),
  )
  if (
    !source ||
    (!assistantTarget && source.matches('.feature-hub[data-feature-page="assistant"]'))
  )
    throw new Error(`「${scope.title}」当前没有打开，无法截图；已应用的样式在打开该界面后生效`)
  if (signal.aborted) throw new DOMException('截图已停止', 'AbortError')
  if (isAssistantAuthenticationVisible()) throw new Error('登录界面不能截图')
  const bounds = source.getBoundingClientRect()
  const clone = source.cloneNode(true) as HTMLElement
  const sidebar = source.closest('.app-shell')?.querySelector<HTMLElement>('.sidebar')
  const width = Math.max(
    currentView ? 1 : 280,
    Math.round(
      source.getBoundingClientRect().width ||
        document.documentElement.clientWidth - (sidebar?.getBoundingClientRect().width ?? 0),
    ),
  )
  const viewWidth = Math.max(1, Math.min(bounds.right, innerWidth) - Math.max(0, bounds.left))
  clone.removeAttribute('id')
  clone.removeAttribute('inert')
  clone.removeAttribute('aria-hidden')
  clone.style.removeProperty('display')
  Object.assign(clone.style, {
    position: 'fixed',
    left: '-200vw',
    top: '0',
    width: `${width}px`,
    height: 'auto',
    maxHeight: 'none',
    minHeight: '0',
    opacity: '0',
    pointerEvents: 'none',
  })
  for (const node of clone.querySelectorAll('[autofocus]')) node.removeAttribute('autofocus')
  source.parentElement?.append(clone)
  // Computed styles exist only after the copy is mounted. Paint virtualized cards
  // before html-to-image measures and copies the offscreen subtree.
  for (const node of clone.querySelectorAll<HTMLElement>('*')) {
    // Copying a card restarts its entrance animation at opacity 0. Render the
    // settled CSS state in the disposable copy, without changing the live page.
    node.style.animation = 'none'
    node.style.transition = 'none'
    // Offscreen virtualized cards must paint before copying their computed styles.
    if (getComputedStyle(node).contentVisibility === 'auto')
      node.style.contentVisibility = 'visible'
  }
  let frame: HTMLElement | undefined
  try {
    // Bind corresponding nodes before removing assistant children from the copy.
    const originals = currentView ? [source, ...source.querySelectorAll<HTMLElement>('*')] : []
    const copies = currentView ? [clone, ...clone.querySelectorAll<HTMLElement>('*')] : []
    const mapping = new Map(originals.map((node, index) => [node, copies[index]!]))
    // Remove assistant UI from the disposable page before any renderer sees it.
    // The live chat remains open, and unrelated page geometry is unchanged.
    for (const node of clone.querySelectorAll(
      `${assistantTarget ? '' : '.product-assistant,'}.assistant-pet-dialog,.assistant-pet,.assistant-pet-bubble,.chat-message-menu,.chat-image-viewer,.chat-tool-result,.chat-reasoning-viewer`,
    ))
      node.remove()
    if (assistantTarget) {
      // Preserve the real bubble geometry, without transmitting hidden messages,
      // earlier conversation text, attached images or local tool results.
      for (const bubble of clone.querySelectorAll<HTMLElement>('.chat-bubble')) {
        bubble.style.setProperty('color', 'transparent', 'important')
        for (const child of Array.from(bubble.children))
          if (child instanceof HTMLElement)
            child.style.setProperty('visibility', 'hidden', 'important')
      }
      for (const node of clone.querySelectorAll<HTMLElement>(
        '.chat-history-summary,.chat-status,.chat-error,.chat-attachments,.assistant-resource-citations,.assistant-task-context',
      ))
        node.style.setProperty('visibility', 'hidden', 'important')
    }
    if (currentView || assistantTarget) {
      for (const field of clone.querySelectorAll<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >('input,textarea,select')) {
        if (field instanceof HTMLSelectElement) field.replaceChildren()
        else {
          field.value = ''
          if (field instanceof HTMLInputElement) field.checked = false
          field.removeAttribute('value')
          field.textContent = ''
        }
        field.setAttribute('placeholder', '')
      }
      for (const node of clone.querySelectorAll(
        '.main-api-settings,.account-trigger,.auth-portal,[data-sensitive]',
      ))
        node.remove()
    }
    if (currentView) {
      // html-to-image does not preserve scrollTop. Translate the actual scrolled content
      // in the offscreen clone, while keeping the original container's clipping.
      for (const original of originals) {
        if (!original.scrollTop && !original.scrollLeft) continue
        const copy = mapping.get(original)
        if (!copy?.isConnected) continue
        for (const child of Array.from(copy.children)) {
          if (!(child instanceof HTMLElement) || getComputedStyle(child).position === 'fixed')
            continue
          child.style.transform = `${getComputedStyle(child).transform === 'none' ? '' : getComputedStyle(child).transform} translate(${-original.scrollLeft}px, ${-original.scrollTop}px)`
        }
        copy.style.overflow = 'hidden'
      }
      frame = document.createElement('div')
      Object.assign(frame.style, {
        position: 'fixed',
        left: '-200vw',
        top: '0',
        width: `${viewWidth}px`,
        height: `${Math.max(1, Math.min(bounds.bottom, innerHeight) - Math.max(0, bounds.top))}px`,
        overflow: 'hidden',
        pointerEvents: 'none',
      })
      source.parentElement?.append(frame)
      frame.append(clone)
      Object.assign(clone.style, {
        position: 'absolute',
        left: `${Math.min(0, bounds.left)}px`,
        top: `${Math.min(0, bounds.top)}px`,
        height: `${bounds.height}px`,
        opacity: '1',
      })
    }
    await document.fonts.ready
    if (signal.aborted) throw new DOMException('截图已停止', 'AbortError')
    if (getComputedStyle(clone).display === 'none' || clone.scrollHeight === 0)
      throw new Error('该区域被样式隐藏，无法截图；可以说“撤销刚才的修改”')
    const height = Math.min(
      1440,
      Math.ceil(currentView ? frame!.getBoundingClientRect().height : clone.scrollHeight),
    )
    const { toJpeg } = await import('html-to-image')
    const dataUrl = await toJpeg(frame ?? clone, {
      width: currentView ? viewWidth : width,
      height,
      pixelRatio: 1,
      quality: 0.85,
      skipFonts: true,
      backgroundColor:
        getComputedStyle(document.documentElement).getPropertyValue('--color-canvas').trim() ||
        '#f2f9fa',
      style: {
        position: 'relative',
        left: '0',
        top: '0',
        insetInlineStart: '0',
        insetInlineEnd: 'auto',
        insetBlockStart: '0',
        insetBlockEnd: 'auto',
        opacity: '1',
        margin: '0',
        transform: 'none',
        overflow: 'hidden',
      },
      fetchRequestInit: { credentials: 'omit' },
      imagePlaceholder:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
      filter: (node) =>
        !(node instanceof Element) ||
        (!(node.matches('.product-assistant') && !assistantTarget) &&
          !node.matches(
            'script,iframe,video,audio,.account-trigger,.auth-portal,[type="password"],.assistant-pet,.assistant-pet-dialog,.assistant-pet-bubble,.chat-message-menu,.chat-image-viewer,.chat-tool-result,.chat-reasoning-viewer',
          )),
    })
    if (signal.aborted) throw new DOMException('截图已停止', 'AbortError')
    return {
      id: crypto.randomUUID(),
      name: `${scope.title}${currentView ? '当前界面' : '效果截图（页面上部）'}.jpg`,
      dataUrl,
      result: true,
    }
  } finally {
    clone.remove()
    frame?.remove()
  }
}
