import { describe, expect, it, vi } from 'vitest'
import { appearanceScopes } from '../core/AppearanceScopes'
import { applyAssistantComparison } from './ProductAssistantAppearanceComparison'
import { captureAssistantPage } from './ProductAssistantScreenshot'
vi.mock('./ProductAssistantScreenshot', () => ({ captureAssistantPage: vi.fn() }))
const scope = appearanceScopes()[0]!

describe('appearance write record without automatic screenshots', () => {
  it('performs the original write once and records keep/undo without rendering', async () => {
    const apply = vi.fn(async () => {})
    const result = await applyAssistantComparison(scope, new AbortController().signal, apply)
    expect(apply).toHaveBeenCalledOnce()
    expect(captureAssistantPage).not.toHaveBeenCalled()
    expect(result).toMatchObject({ scope: scope.value, state: 'applied' })
    expect(result.before).toBeUndefined()
    expect(result.after).toBeUndefined()
    expect(result.captureError).toBeUndefined()
  })
  it('does not write after cancellation or claim success after a failed write', async () => {
    const controller = new AbortController()
    controller.abort()
    const apply = vi.fn(async () => {})
    await expect(applyAssistantComparison(scope, controller.signal, apply)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(apply).not.toHaveBeenCalled()
    apply.mockRejectedValueOnce(new Error('write failed'))
    await expect(
      applyAssistantComparison(scope, new AbortController().signal, apply),
    ).rejects.toThrow('write failed')
    expect(captureAssistantPage).not.toHaveBeenCalled()
  })
})
