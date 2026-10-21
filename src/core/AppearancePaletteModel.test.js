import { describe, expect, it } from 'vitest'
import postcss from 'postcss'
import { readFileSync } from 'node:fs'
import { URL } from 'node:url'
import {
  defaults,
  specs,
  shapeDefaults,
  compilePaletteCss,
  mergePaletteCss,
  readPaletteCss,
  inspectPaletteCss,
  packPaletteDesign,
  unpackPaletteDesign,
  validateDesign,
} from './AppearancePaletteModel.js'

describe('public palette CSS', () => {
  it('extracts modern RGB, variable aliases, automatic gradient stops and rem shapes without rewriting complex CSS', () => {
    const source = `:root { --color-ink: #574650; --color-canvas: #fff8fb; --glass-panel: linear-gradient(145deg, rgb(255 255 255 / 86%), rgb(255 239 246 / 78%)); --button-color: var(--color-ink); --button-radius: .9rem; --radius-control: .86rem; --page-background: radial-gradient(ellipse at 6% 0%, color-mix(in srgb, var(--color-ink) 68%, transparent), transparent 42%), var(--color-canvas); } :root[data-theme="dark"] { --color-ink: #f7edf2; --button-radius: .86rem; } .resource-card { padding: 3px; }`
    const found = inspectPaletteCss(source)
    expect(found.colors).toBe(4)
    expect(found.shapes).toBe(2)
    expect(found.unsupported).toEqual(['页面背景'])
    expect(found.design.values.light.panel.stops).toEqual([
      { hex: '#ffffff', pos: 0, alpha: 86 },
      { hex: '#ffeff6', pos: 100, alpha: 78 },
    ])
    expect(found.design.values.light.normalText.stops[0].hex).toBe('#574650')
    expect(found.design.values.dark.normalText.stops[0].hex).toBe('#f7edf2')
    expect(found.design.values.light.canvas.stops[0].hex).toBe('#fff8fb')
    expect(found.design.radius).toBe(14.4)
    expect(found.design.radii.controlShape).toBe(13.76)
    expect(inspectPaletteCss(source, 'dark').design.radius).toBe(13.76)
    const reshaped = globalThis.structuredClone(found.design)
    reshaped.radius = 4
    const shapeCss = mergePaletteCss(source, reshaped, found.design)
    expect(shapeCss).toContain(source)
    const shapePatch = postcss.parse(shapeCss.split('/* SRL 调色开始 */')[1])
    for (const selector of [":root:not([data-theme='dark'])", ":root[data-theme='dark']"])
      expect(shapePatch.nodes.find((node) => node.selector === selector)?.toString()).toContain(
        '--button-radius: 4px',
      )
    expect(mergePaletteCss(source, found.design, found.design)).toBe(source)
    const edited = globalThis.structuredClone(found.design)
    edited.values.light.panel.stops[1].hex = '#eeaabb'
    expect(mergePaletteCss(source, edited, found.design)).toContain(source)
    expect(() => inspectPaletteCss(':root {')).toThrow('CSS 格式不完整')
  })
  it('preserves author layout and untouched variables, including important colors, across repeated edits', () => {
    const source = `/* 我的排版 */\n:root { --page-background: #123456 !important; --button-radius: 23px; --glass-panel: var(--my-panel); }\n.resource-card { width: 91%; padding: 3px 9px; font-size: 13px; }\n@media (max-width: 600px) { .resource-card { gap: 7px; } }\n`
    const baseline = readPaletteCss(source)
    expect(mergePaletteCss(source, baseline, baseline)).toBe(source)
    const edited = globalThis.structuredClone(baseline)
    edited.values.light.canvas.stops[0].hex = '#abcdef'
    const first = mergePaletteCss(source, edited, baseline)
    expect(first.split('/* SRL 调色开始 */')[0]?.trimEnd()).toBe(source.trimEnd())
    expect(first).toContain('--page-background: rgba(171,205,239,1) !important')
    const patch = first.split('/* SRL 调色开始 */')[1]
    expect(patch).not.toMatch(/button-radius|glass-panel|shadow|width|padding/)
    const nextBase = readPaletteCss(first),
      next = globalThis.structuredClone(nextBase)
    next.values.light.canvas.stops[0].hex = '#fedcba'
    const second = mergePaletteCss(first, next, nextBase)
    expect(second.match(/SRL 调色开始/g)).toHaveLength(1)
    expect(second.match(/SRL 调色结束/g)).toHaveLength(1)
    expect(second).toContain('--page-background: rgba(254,220,186,1) !important')
    expect(second).not.toContain('rgba(171,205,239,1)')
    expect(second.split('/* SRL 调色开始 */')[0]?.trimEnd()).toBe(source.trimEnd())
  })
  it('changes only an explicitly edited shape and can undo a color without injecting default dimensions', () => {
    const source =
      ':root { --button-radius: 23px; --control-radius: 17px; } .icon-button { width: 27px; height: 27px; }'
    const baseline = readPaletteCss(source),
      edited = globalThis.structuredClone(baseline)
    edited.radii.controlShape = 4
    const css = mergePaletteCss(source, edited, baseline)
    const patch = css.split('/* SRL 调色开始 */')[1]
    expect(patch).toContain('--control-radius: 4px')
    expect(patch).not.toMatch(/button-radius|card|dialog|background/)
    expect(mergePaletteCss(source, baseline, baseline)).toBe(source)
  })
  it('round trips public declarations and per-class shapes, with no dependency on custom Vue', () => {
    const design = {
      values: globalThis.structuredClone(defaults),
      radius: 16,
      radii: { ...shapeDefaults, iconShape: 999, filterShape: 0 },
    }
    design.values.light.panel.stops[0].hex = '#123456'
    design.values.dark.text.stops[0].hex = '#c0ffee'
    const css = compilePaletteCss(design)
    const restored = readPaletteCss(css)
    expect(compilePaletteCss(restored)).toBe(css)
    expect(validateDesign(unpackPaletteDesign(packPaletteDesign(design)))).toEqual(design)
  })
  it('covers Foundation public color/material tokens and emits valid light/dark CSS', () => {
    const design = {
      values: globalThis.structuredClone(defaults),
      radius: 8,
      radii: { ...shapeDefaults },
    }
    const props = new Set()
    postcss.parse(compilePaletteCss(design)).walkDecls((decl) => props.add(decl.prop))
    const foundation = postcss.parse(
      readFileSync(new URL('../styles/Foundation.css', import.meta.url), 'utf8'),
    )
    foundation.walkDecls((decl) => {
      if (
        (/^--color-/.test(decl.prop) && !/^--color-(brand-|on-brand)/.test(decl.prop)) ||
        /^--(?:glass-(?:panel|border|shadow)|overlay-background|dialog-background|control-(?:background|shadow)|viewer-)/.test(
          decl.prop,
        )
      )
        expect(props.has(decl.prop), decl.prop).toBe(true)
    })
    expect(specs).toHaveLength(41)
    expect(readPaletteCss('broken {{{').values).toEqual(defaults)
  })
})
