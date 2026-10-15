import { computed, reactive, watch, type ComputedRef } from 'vue'

export interface OverlayRegistration {
  id: string
  isOpen: () => boolean
  close: () => void
  canClose?: () => boolean
}

export interface OverlayStack {
  isOpen: ComputedRef<boolean>
  topId: ComputedRef<string | undefined>
  closeTop(): 'closed' | 'blocked' | 'none'
}

export function useOverlayStack(registrations: OverlayRegistration[]): OverlayStack {
  const order = reactive<string[]>([])
  const byId = new Map(registrations.map((registration) => [registration.id, registration]))

  for (const registration of registrations) {
    watch(
      registration.isOpen,
      (open) => {
        const index = order.indexOf(registration.id)
        if (index >= 0) order.splice(index, 1)
        if (open) order.push(registration.id)
      },
      { immediate: true, flush: 'sync' },
    )
  }

  const topId = computed(() => {
    for (let index = order.length - 1; index >= 0; index -= 1) {
      const id = order[index]
      if (id && byId.get(id)?.isOpen()) return id
    }
    return undefined
  })

  return {
    isOpen: computed(() => registrations.some((registration) => registration.isOpen())),
    topId,
    closeTop() {
      const id = topId.value
      if (!id) return 'none'
      const registration = byId.get(id)
      if (!registration) return 'none'
      if (registration.canClose && !registration.canClose()) return 'blocked'
      registration.close()
      return 'closed'
    },
  }
}
