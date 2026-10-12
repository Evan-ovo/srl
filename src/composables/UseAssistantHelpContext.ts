import { onBeforeUnmount, watch } from 'vue'
import {
  setAssistantHelpSurface,
  type AssistantHelpContext,
} from '../core/ProductAssistantGuidance'

/** Lifecycle-owned registration, with no page polling, content reading or model inference. */
export function useAssistantHelpContext(
  context: AssistantHelpContext,
  visible: () => boolean = () => true,
) {
  const owner = Symbol(context)
  watch(visible, (active) => setAssistantHelpSurface(owner, active ? context : undefined), {
    immediate: true,
  })
  onBeforeUnmount(() => setAssistantHelpSurface(owner))
}
