/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const component = readFileSync(
  new URL('./FrontendWorkshopSourceEditor.vue', import.meta.url),
  'utf8',
)
const source = readFileSync(
  new URL('../styles/FrontendWorkshopSourceEditor.css', import.meta.url),
  'utf8',
)

describe('FrontendWorkshopSourceEditor safe areas', () => {
  it('keeps the fullscreen editor out of every device safe area', () => {
    expect(component).toContain('src="../styles/FrontendWorkshopSourceEditor.css"')
    expect(source).toContain(
      'padding: var(--safe-top) max(8px, var(--safe-right)) max(4px, var(--safe-bottom))',
    )
    expect(source).toContain('max(8px, var(--safe-left))')
    expect(component).toContain('mobile-dialog-viewport')
    expect(component).toContain('layout="panel"')
  })

  it('does not reuse the left safe inset for the right edge', () => {
    expect(source).toContain('max(8px, var(--safe-right))')
    expect(source).toContain('max(8px, var(--safe-left))')
    expect(source).toContain('grid-template-rows: auto minmax(0, 1fr)')
    expect(source).toContain('overflow: auto')
  })
})
