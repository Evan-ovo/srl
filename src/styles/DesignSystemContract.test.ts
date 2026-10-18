import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from '@vue/compiler-sfc'

const foundation = readFileSync(new URL('./Foundation.css', import.meta.url), 'utf8')
const glass = readFileSync(new URL('./GlassRefinement.css', import.meta.url), 'utf8')
const refinement = readFileSync(new URL('./DesignSystemRefinement.css', import.meta.url), 'utf8')
const layout = readFileSync(new URL('./LayoutAndResponsive.css', import.meta.url), 'utf8')
const stylesEntry = readFileSync(new URL('../Styles.css', import.meta.url), 'utf8')
const header = readFileSync(new URL('./FeatureAppHeader.css', import.meta.url), 'utf8')
const backButton = readFileSync(new URL('./FeatureBackButton.css', import.meta.url), 'utf8')
const workshopResponsive = readFileSync(
  new URL('./FrontendWorkshopResponsive.css', import.meta.url),
  'utf8',
)
const workshopToolRail = readFileSync(
  new URL('./FrontendWorkshopToolRail.css', import.meta.url),
  'utf8',
)
const sourceSession = readFileSync(
  new URL('./FrontendWorkshopSourceSession.css', import.meta.url),
  'utf8',
)
const sourceHistory = readFileSync(
  new URL('./FrontendWorkshopSourceHistoryPanel.css', import.meta.url),
  'utf8',
)

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(?:css|vue)$/.test(entry.name) ? [path] : []
  })
}

describe('mobile design system contract', () => {
  it('does not discard UI declarations through retired undefined theme aliases', () => {
    const obsolete =
      /var\((?:--color-paper|--color-bg|--text-secondary|--color-muted|--color-border|--color-text-secondary|--color-grid|--shadow-soft|--color-surface-soft|--color-accent-contrast|--surface-muted|--text-muted|--line-soft|--accent-strong)\b/
    const failures: string[] = []
    for (const path of sourceFiles(fileURLToPath(new URL('../', import.meta.url)))) {
      // SRL-PUBLIC-SYNC: BEGIN REPLACE id=appearance-source-boundary-filter
      if (/ChatReader|ResourcePlaza|AppearanceUiEditor/.test(path)) continue
      // SRL-PUBLIC-SYNC: END REPLACE id=appearance-source-boundary-filter
      const source = readFileSync(path, 'utf8')
      const styles = path.endsWith('.vue')
        ? parse(source).descriptor.styles.map((style) => style.content)
        : [source]
      if (styles.some((style) => obsolete.test(style))) failures.push(path)
    }
    expect(failures).toEqual([])
  })

  it('defines semantic type, density, radius and icon tokens', () => {
    for (const token of [
      '--text-caption',
      '--text-label',
      '--text-body',
      '--text-title-md',
      '--line-body',
      '--row-compact',
      '--control-visual-compact',
      '--control-visual',
      '--control-visual-secondary',
      '--size-touch',
      '--icon-md',
      '--icon-stroke',
      '--radius-control',
      '--radius-panel',
    ]) {
      expect(foundation).toContain(token)
    }
  })

  it('locks the Chinese UI font family without overriding authored preview typography', () => {
    expect(refinement).toMatch(/--font-ui:\s*\n?\s*'HarmonyOS Sans SC'/)
    expect(refinement).toContain('--font-display: var(--font-ui)')
    expect(refinement).toContain('--font-body: var(--font-ui)')
    expect(refinement).toContain('--font-label: var(--font-ui)')
    expect(refinement).toContain('--font-code: ui-monospace')
    expect(refinement).toContain('FrontendWorkshop Preview')
  })

  it('locks the aqua glass palette, readable type scale and restrained radii', () => {
    for (const declaration of [
      '--color-canvas: #e8f3f5',
      '--color-surface: #f2f9fa',
      '--color-surface-raised: #fbfefe',
      '--color-ink: #183842',
      '--color-accent: #1d707b',
      '--text-caption: 0.75rem',
      '--text-body: 0.875rem',
      '--text-body-strong: 1rem',
      '--radius-control: 0.82rem',
      '--radius-card: 0.75rem',
      '--radius-panel: 1.35rem',
    ]) {
      expect(foundation).toContain(declaration)
    }
    expect(refinement).not.toContain('--color-canvas:')
    expect(refinement).not.toContain('--radius-control:')
    expect(glass).not.toContain('--color-canvas:')
    expect(glass).not.toContain('--radius-control:')
    expect(foundation.match(/--color-canvas:/g)).toHaveLength(2)
    expect(foundation.match(/--color-accent:/g)).toHaveLength(2)
    expect(foundation).not.toContain('--color-canvas: #161c19')
    expect(foundation).not.toContain('--color-accent: #8dbda9')
  })

  it('uses discrete font tiers without scaling the root font size', () => {
    expect(foundation).toContain(":root[data-font-scale='small']")
    expect(foundation).toContain(":root[data-font-scale='large']")
    expect(foundation).not.toMatch(
      /:root\[data-font-scale=['"](?:small|large)['"]\][^{]*\{[^}]*font-size:/,
    )
  })

  it('uses the locked tool header typography and shared action classes', () => {
    expect(foundation).toContain('writing-mode: horizontal-tb')
    expect(foundation).toContain('text-orientation: mixed')
    expect(header).toMatch(/\.feature-app-header h1\s*\{[^}]*font-family: var\(--font-body\);/)
    expect(header).toMatch(/\.feature-app-header h1\s*\{[^}]*font-size: var\(--text-title-md\);/)
    expect(header).toMatch(/\.feature-app-header h1\s*\{[^}]*white-space: nowrap;/)
    expect(header).toMatch(/\.feature-app-header h1\s*\{[^}]*text-overflow: ellipsis;/)
    for (const className of [
      'feature-header-action',
      'feature-header-action--primary',
      'feature-header-action--ghost',
      'feature-header-action--icon',
      'feature-header-status',
    ]) {
      expect(header).toContain(`.${className}`)
    }
  })

  it('owns every top return target through the shared 44px touch contract', () => {
    expect(backButton).toMatch(/\.feature-back-button\s*\{[^}]*width: var\(--size-touch\);/)
    expect(backButton).toMatch(/\.feature-back-button\s*\{[^}]*height: var\(--size-touch\);/)
    expect(backButton).toMatch(/\.feature-back-button:focus-visible/)
    expect(header).not.toMatch(/\.feature-app-header__back\s*\{/)
    expect(header).toContain('--feature-header-viewport-gutter: var(--mobile-gutter)')
    expect(header).toContain(
      'transform: translateX(calc(-50% - var(--feature-header-parent-inline-offset, 0px)))',
    )
  })

  it('keeps workshop readable typography paired with mobile overflow handling', () => {
    expect(workshopResponsive).not.toContain('font: 0.46rem var(--font-label)')
    expect(workshopResponsive).not.toContain('font: 700 0.64rem var(--font-ui)')
    expect(workshopResponsive).toContain('font-size: var(--text-caption)')
    expect(workshopResponsive).toContain('overflow-wrap: anywhere')
    expect(workshopResponsive).toContain('overflow-x: auto')
    expect(workshopResponsive).toContain('-webkit-line-clamp: 2')

    expect(workshopToolRail).toContain('font-size: var(--text-caption)')
    expect(workshopToolRail).toContain('.frontend-workbench__rail-tools > button span')
    expect(workshopToolRail).toContain('display: none')
    expect(workshopToolRail).toContain('min-height: 2.75rem')
    expect(workshopToolRail).toContain('max-height: min(70dvh, 32rem)')
    expect(workshopToolRail).not.toContain('font-size: 0.56rem')

    expect(sourceSession).toContain('flex-wrap: wrap')
    expect(sourceSession).toContain('overflow-wrap: anywhere')
    expect(sourceSession).toContain('font-size: var(--text-caption)')
    expect(sourceHistory).toContain('overflow-x: auto')
    expect(sourceHistory).toContain('text-overflow: ellipsis')
  })

  it('keeps the compact tool exception and retired legacy migration explicit', () => {
    expect(refinement).toContain('FrontendWorkshop 的 10/11/12/14px 层级由各正式 Owner')
    expect(refinement).not.toMatch(/\.frontend-workshop[^{}]*:where\([^)]*button/)
    expect(layout.replace(/\s+/g, '')).toContain(
      "input:not([type='checkbox'],[type='radio'],[type='range'],[type='color'],[type='file'],:where(.main-api-settingsinput))",
    )
    expect(layout).toMatch(
      /:is\(#app, \[role='dialog'\]\)\s*:where\([^{}]+\)\s*\{\s*font-size: 16px;/,
    )
    expect(refinement).not.toContain('font-size: 1rem')
    expect(stylesEntry).not.toContain('FrontendWorkshopLegacyUiMigration.css')
  })

  it('keeps direct iOS top inset reads in the host, startup and isolated shadow token owners', () => {
    const sourceRoot = fileURLToPath(new URL('../', import.meta.url))
    const directTopInset = ['env(', 'safe-area-inset-top'].join('')
    const consumers = sourceFiles(sourceRoot)
      .filter((path) => !path.endsWith('/styles/Foundation.css'))
      .filter((path) => !path.endsWith('/styles/Startup.css'))
      .filter((path) => !path.endsWith('/reader/ChatReader.css'))
      .filter((path) => !path.endsWith('/styles/RecoveryControls.css'))
      .filter((path) => readFileSync(path, 'utf8').includes(directTopInset))

    expect(consumers).toEqual([])
    // Startup runs before Foundation can load, so its safe inset has to be self-contained.
    const startup = readFileSync(new URL('./Startup.css', import.meta.url), 'utf8')
    expect(startup).toContain(directTopInset)
    expect(startup).toContain('#srl-boot,')
    expect(startup).toContain('#srl-native-preparation')
    // The reader runs in its own Shadow DOM and owns its safe-area tokens.
    const reader = readFileSync(new URL('../reader/ChatReader.css', import.meta.url), 'utf8')
    expect(reader).toMatch(/^:host\s*\{\s*--reader-safe-top: env\(safe-area-inset-top, 0px\);/)
    expect(reader.split(directTopInset)).toHaveLength(2)
    // Recovery runs in a protected Shadow DOM. Its exit control must not inherit
    // user-authored safe-area variables that could move the only exit offscreen.
    const recovery = readFileSync(new URL('./RecoveryControls.css', import.meta.url), 'utf8')
    expect(recovery).toMatch(
      /\.appearance-preview-controls\s*\{\s*--recovery-safe-top: env\(safe-area-inset-top, 0px\);/,
    )
    expect(recovery.split(directTopInset)).toHaveLength(2)
    expect(recovery).toContain(
      'inset: max(6px, var(--recovery-safe-top)) max(8px, var(--recovery-safe-right))',
    )
  })
})
