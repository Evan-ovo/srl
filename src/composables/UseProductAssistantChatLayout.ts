import { nextTick, onBeforeUnmount, watch, type Ref } from 'vue'

/** Owns the existing input sizing and message-scroll layout, without keyboard geometry listeners. */
export function useProductAssistantChatLayout(
  messages: Ref<HTMLElement | undefined>,
  inputElement: Ref<HTMLTextAreaElement | undefined>,
  input: Ref<string>,
  hidden: () => boolean,
): () => Promise<void> {
  let observed: HTMLElement | undefined
  let observer: ResizeObserver | undefined
  let followsLatest = true
  let previousHeight = 0
  const updateFollow = () => {
    if (!observed?.clientHeight || observed.clientHeight !== previousHeight) return
    followsLatest = observed.scrollHeight - observed.scrollTop - observed.clientHeight <= 1
  }
  function disconnect(): void {
    observer?.disconnect()
    observer = undefined
    observed?.removeEventListener('scroll', updateFollow)
    observed = undefined
  }
  watch(
    messages,
    (element) => {
      disconnect()
      if (!element) return
      observed = element
      previousHeight = element.clientHeight
      followsLatest = element.scrollHeight - element.scrollTop - element.clientHeight <= 1
      element.addEventListener('scroll', updateFollow, { passive: true })
      if (typeof ResizeObserver === 'undefined') return
      observer = new ResizeObserver(() => {
        if (
          observed !== element ||
          !element.clientHeight ||
          previousHeight === element.clientHeight
        )
          return
        previousHeight = element.clientHeight
        // The focused input is outside this scroller. Resizing the message area cannot move it
        // or feed back into Main's focus avoidance; a manually scrolled history stays untouched.
        if (followsLatest) element.scrollTop = element.scrollHeight
      })
      observer.observe(element)
    },
    { flush: 'post' },
  )
  onBeforeUnmount(disconnect)
  watch([input, hidden], async () => {
    await nextTick()
    if (inputElement.value && !hidden()) {
      inputElement.value.style.height = 'auto'
      inputElement.value.style.height = `${Math.min(112, Math.max(44, inputElement.value.scrollHeight))}px`
    }
  })
  return async () => {
    await nextTick()
    if (messages.value) {
      followsLatest = true
      messages.value.scrollTop = messages.value.scrollHeight
    }
  }
}
