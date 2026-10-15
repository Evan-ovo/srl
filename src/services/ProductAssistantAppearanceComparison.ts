import type { AppearanceScope } from '../core/AppearanceScopes'
import type { AssistantImage } from './ProductAssistantService'
export interface AssistantAppearanceComparison {
  id: string
  scope: string
  title: string
  before?: AssistantImage
  after?: AssistantImage
  captureError?: string
  state: 'applied' | 'kept' | 'undone'
}
/** Records the existing write for keep/undo; screenshots are separate explicit tools. */
export async function applyAssistantComparison(
  scope: AppearanceScope,
  signal: AbortSignal,
  apply: () => Promise<void>,
): Promise<AssistantAppearanceComparison> {
  const comparison: AssistantAppearanceComparison = {
    id: crypto.randomUUID(),
    scope: scope.value,
    title: scope.title,
    state: 'applied',
  }
  if (signal.aborted) throw new DOMException('已停止', 'AbortError')
  await apply()
  return comparison
}
