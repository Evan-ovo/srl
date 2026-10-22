import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const readComponent = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')

const readStyle = (name: string) =>
  readFileSync(new URL(`../styles/${name}`, import.meta.url), 'utf8')

describe('Feature App visual contract', () => {
  it('uses shared Header actions instead of private feature buttons', () => {
    const hub = readComponent('FeatureHub.vue')
    const persona = readComponent('UserPersonaApp.vue')
    const extensions = readComponent('ExternalAppManager.vue')

    expect(hub).toContain('feature-header-action--ghost')
    expect(persona).toContain('feature-header-action--icon')
    expect(persona).toContain('feature-header-action--primary')
    expect(extensions).toContain('class="feature-header-action external-app-manager__add"')
    expect(extensions).toMatch(/<FeatureAppHeader\b[^>]*\btitle="扩展"/u)
    expect(extensions).not.toContain('feature-header-action--primary')

    expect(extensions).not.toContain('external-app-manager__guide-trigger')
  })

  it('keeps nonessential counters out of the shared Header', () => {
    const cloud = readComponent('CloudBackupCenter.vue')
    const album = readComponent('GeneratedImageAlbumApp.vue')

    expect(cloud).not.toContain('{{ resourceCount }} 项资源')
    expect(album).not.toContain('{{ page.total }} 张本地原图')
  })

  it('lays out settings as a full-viewport page instead of a centered sheet', () => {
    const settings = readComponent('LayoutSettingsPanel.vue')
    const responsive = readStyle('LayoutAndResponsive.css')
    const glass = readStyle('GlassRefinement.css')
    const appearance = readFileSync(new URL('../core/AppearanceScopes.ts', import.meta.url), 'utf8')

    expect(settings).toContain('class="srl-independent-page layout-settings-page"')
    expect(settings).not.toContain('layout-settings-sheet')
    const app = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
    expect(app).toContain('Teleport to="#srl-independent-page-outlet"')
    expect(settings).not.toContain('aria-modal="true"')
    expect(responsive).not.toContain('.layout-settings-overlay')
    expect(responsive).toContain('.layout-settings-page {\n  display: grid;')
    expect(responsive).toContain('width: 100%;\n  height: 100%;')
    expect(responsive).toContain('height: 100%;')
    expect(glass).toContain('.layout-settings-page {\n  border: 0;\n  border-radius: 0;')
    expect(glass).toContain('box-shadow: none;')
    expect(appearance).toContain("selector: '.layout-settings-page'")
  })

  it('removes dead private Header CSS from the first batch', () => {
    const desktop = readStyle('FeatureDesktop.css')
    const folders = readStyle('FolderLibrary.css')
    const persona = readStyle('UserPersonaApp.css')
    const album = readStyle('GeneratedImageAlbumApp.css')

    expect(desktop).not.toContain('.feature-hub__header')
    expect(desktop).not.toContain('.draw-app__header')
    expect(desktop).not.toContain('.feature-desktop__sections')
    expect(folders).not.toContain('.folder-app__header')
    expect(persona).not.toContain('.persona-app__header')
    expect(album).not.toContain('.generated-album__header')
  })

  it('keeps Feature Hub as a compact launcher without a competing pin control', () => {
    const desktop = readStyle('FeatureDesktop.css')
    const hub = readComponent('FeatureHub.vue')

    expect(desktop).toContain('grid-template-columns: repeat(3, minmax(0, 1fr));')
    expect(desktop).toContain('aspect-ratio: 1;')
    expect(desktop).toContain('grid-template-rows: auto minmax(2.6em, auto);')
    expect(desktop).not.toContain('grid-template-columns: 2.5rem minmax(0, 1fr);')
    expect(desktop).not.toContain('.feature-app__pin')
    expect(hub).not.toContain('class="feature-app__pin"')
    expect(hub).toContain('useFeatureHub(props, emit)')
    const controller = readFileSync(
      new URL('../composables/UseFeatureHub.ts', import.meta.url),
      'utf8',
    )
    expect(controller).toContain('FEATURE_DESKTOP_LONG_PRESS_MS = 550')
    expect(desktop).toContain('@media (min-width: 40rem) and (max-width: 53.75rem)')
    expect(desktop).toContain('grid-template-columns: repeat(4, minmax(0, 1fr));')
    expect(desktop).toContain(
      ".feature-hub[data-feature-page='home'] .feature-app--external > strong",
    )
    expect(desktop).toContain('text-overflow: ellipsis;')
  })

  it('uses a compact Resource Library header on tablet and small desktop', () => {
    const layout = readStyle('LayoutAndResponsive.css')

    expect(layout).toContain('@media (min-width: 53.8125rem) and (max-width: 75rem)')
    expect(layout).toContain('grid-template-columns: 11.75rem minmax(0, 1fr);')
    expect(layout).toContain(
      '.library__header > div:first-child {\n    display: grid;\n    min-width: 0;\n    grid-template-columns: auto minmax(0, 1fr);',
    )
    expect(layout).toContain('white-space: nowrap;')
    expect(layout).toContain(
      '.batch-bar__tags,\n  .batch-bar__move {\n    order: 1;\n    flex: 1 1 min(20rem, 100%);',
    )
    expect(layout).toMatch(/\.app-shell--batch \.notice\s*\{[^}]*top: auto;[^}]*bottom: calc\(/)
    expect(layout).toMatch(/\.app-shell--batch \.activity-center\s*\{[^}]*--activity-bottom:/)
  })

  it('puts Cloud primary operations before configuration on compact layouts', () => {
    const cloud = readComponent('CloudBackupCenter.vue')
    const cloudCss = readStyle('CloudBackup.css')

    expect(cloud).not.toContain('class="cloud-vault"')
    expect(cloud).toContain('class="cloud-credential-status"')
    expect(cloud.indexOf('class="cloud-operations"')).toBeLessThan(
      cloud.indexOf('class="cloud-config"'),
    )
    expect(cloud).toContain('class="cloud-connection"')
    expect(cloud).toContain(':open="snapshot.credentials[activeProvider] !== \'valid\'"')
    expect(cloudCss).toMatch(/\.cloud-workspace\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\)/)
    expect(cloudCss).not.toContain('.cloud-vault')
    expect(cloudCss).toContain('min-height: var(--size-touch);')
  })

  it('keeps the folder search page in normal scroll flow while the keyboard opens', () => {
    const folders = readStyle('FolderLibrary.css')
    const responsive = readStyle('LayoutAndResponsive.css')

    expect(folders).not.toMatch(
      /\.feature-hub\[data-feature-page='folders'\]\s*\{[^}]*position:\s*fixed/su,
    )
    expect(responsive).not.toContain(":root body .feature-hub[data-feature-page='folders']")
    expect(folders).toContain('.folder-detail__search input')
  })

  it('gives Stitch Entry a real tablet and desktop composition', () => {
    const stitch = readComponent('PresetStitcherApp.vue')
    const stitchCss = readStyle('PresetStitcherApp.css')

    expect(stitch).toContain('class="stitch-entry-layout"')
    expect(stitch).toContain('class="stitch-entry-layout__controls"')
    expect(stitch).toContain('class="stitch-entry-layout__presets"')
    expect(stitch).toContain('id="stitch-entry-presets-title"')
    expect(stitchCss).toContain('@media (min-width: 48rem)')
    expect(stitchCss).toContain('grid-template-columns: minmax(16rem, 0.8fr) minmax(20rem, 1.2fr);')
  })

  it('keeps mobile bottom bars flush while reserving their occupied height', () => {
    const foundation = readStyle('Foundation.css')
    const layout = readStyle('LayoutAndResponsive.css')
    const bridge = readStyle('TavernBridgeCenter.css')
    const glass = readStyle('GlassRefinement.css')
    const monitor = readStyle('PerformanceMonitor.css')
    expect(readComponent('ProjectActivityCenter.vue')).toContain(
      'src="../styles/ProjectActivityCenter.css"',
    )
    const activity = readStyle('ProjectActivityCenter.css')

    expect(foundation).toContain('--bottom-nav-block-size: 4.75rem;')
    expect(foundation).toContain('--bottom-notice-offset: max(1rem, var(--safe-bottom));')
    expect(foundation).toContain(":root[data-ios-keyboard-open='true']")
    expect(foundation).toContain('--safe-bottom: 0px !important;')
    expect(layout).toMatch(
      /--bottom-nav-reserved:\s*calc\(\s*var\(--bottom-nav-block-size\) \+ max\(0px, var\(--safe-bottom\) - 0\.375rem\)\s*\);/,
    )
    expect(layout).toContain('bottom: var(--bottom-nav-reserved);')
    expect(foundation).toMatch(/\*\s*\{\s*box-sizing: border-box;/)
    expect(layout).toMatch(/\.mobile-bottom-nav\s*\{[^}]*height: var\(--bottom-nav-reserved\);/)
    expect(glass).not.toMatch(/\.mobile-bottom-nav\s*[,{]/)
    expect(layout).toContain('bottom: var(--bottom-notice-offset);')
    expect(layout.split('bottom: var(--bottom-notice-offset);').length - 1).toBe(1)
    expect(layout).toContain(':root:has(.draw-actions) {\n    --bottom-action-reserved: 3.875rem;')
    expect(bridge).toContain('bottom: var(--bottom-nav-reserved);')
    expect(monitor).toContain('bottom: var(--bottom-notice-offset);')
    expect(activity).toContain('var(--activity-bottom, var(--bottom-notice-offset))')
    expect(activity).toContain('bottom: var(--activity-offset);')
    // The task panel was intentionally centered in 34aea7e3; the bottom trigger stays flush.
    const panel = activity.match(/\.activity-center__panel\s*\{([^}]+)\}/u)?.[1] ?? ''
    expect(panel).toContain('position: fixed;')
    expect(panel).toContain('top: 50%;')
    expect(panel).toContain('max-height: min(84dvh, 672px);')
    expect(panel).toContain('overflow: auto;')
    expect(panel).toContain('transform: translate(-50%, -50%);')
  })

  it('keeps the resizable Workshop inspector out of canvas layout', () => {
    const workbench = readStyle('FrontendWorkshopWorkbench.css')
    const sourceInspector = readStyle('FrontendWorkshopSourceInspector.css')
    expect(workbench).toContain('.fw-inspector-dock')
    expect(workbench).not.toContain('.frontend-workbench__transform-dock')
    expect(sourceInspector).toContain('position: absolute;')
    expect(sourceInspector).toContain('height: var(--inspector-size, 300px);')
    expect(sourceInspector).toContain('width: var(--inspector-size, 360px);')
    expect(sourceInspector).toContain('touch-action: none;')
    expect(readStyle('FrontendWorkshopSourceSession.css')).not.toContain('minmax(18rem, 22rem)')
    expect(readComponent('FrontendWorkshopSourceInspector.vue')).toContain('is-collapsed')
    expect(readComponent('FrontendWorkshopWorkbench.vue')).toContain('name="source-canvas"')
  })

  it('keeps Workshop on the shared Resource Library palette and primary action contract', () => {
    const workbench = readStyle('FrontendWorkshopWorkbench.css')
    const sourceSession = readStyle('FrontendWorkshopSourceSession.css')
    const sourceWorkspace = readStyle('FrontendWorkshopSourceWorkspace.css')
    const componentLibrary = readComponent('FrontendWorkshopSourceComponentLibrary.vue')
    const sourceEditor = readComponent('FrontendWorkshopSourceEditor.vue')
    const sourceAiWorkspace = readComponent('FrontendWorkshopSourceAiWorkspace.vue')

    expect(workbench).not.toContain('--color-canvas: #f7fafc;')
    expect(workbench).not.toContain('--color-accent: #136e8a;')
    expect(workbench).toContain('background: var(--color-surface-raised)')
    expect(sourceSession).not.toContain('--color-text')
    expect(sourceWorkspace).not.toContain('--color-text')
    expect(sourceEditor).not.toContain('--color-background')
    expect(sourceEditor).not.toContain('--color-text')
    expect(sourceAiWorkspace).not.toContain('--color-background')
    expect(componentLibrary).toContain(
      'class="button button--primary frontend-workshop-source-components__primary-action"',
    )
    expect(sourceEditor).toContain('class="button button--primary is-primary"')
    expect(sourceAiWorkspace).toContain('class="button button--primary source-ai-workspace__send"')
  })

  it('keeps the shared dark theme in Foundation as the unique semantic token owner', () => {
    const foundation = readStyle('Foundation.css')
    const glass = readStyle('GlassRefinement.css')

    expect(foundation).toContain('--color-canvas: #17272e;')
    expect(foundation).toContain('--color-surface: #1f323a;')
    expect(foundation).toContain('--color-surface-raised: #293f48;')
    expect(foundation).toContain('--color-ink-soft: #b5c8cc;')
    expect(foundation).toContain('--color-accent: #92d7d3;')
    expect(glass).not.toContain('--color-canvas:')
    expect(glass).not.toContain('--color-surface:')
    expect(glass).not.toContain('--color-surface-raised:')
    expect(glass).not.toContain('--color-ink-soft:')
    expect(glass).not.toContain('--color-accent:')
  })

  it('keeps Bridge and Stitch compact and Chinese-first', () => {
    const bridge = readComponent('TavernBridgeCenter.vue')
    const stitch = readComponent('PresetStitcherApp.vue')
    const bridgeCss = readStyle('TavernBridgeCenter.css')
    const stitchCss = readStyle('PresetStitcherApp.css')

    expect(bridge).not.toContain('tavern-bridge-pairing__mark')
    expect(bridge).not.toContain('CROSS-BROWSER')
    expect(bridge).not.toContain('ANDROID LOCAL')
    expect(bridge).toContain('连接帮助')
    expect(bridge).toContain('installGuideOpen')

    expect(bridgeCss).not.toContain('.tavern-bridge__header')
    expect(bridgeCss).not.toContain('.tavern-bridge-pairing__mark')

    const countSelector = (source: string, selector: string) => source.split(selector).length - 1

    expect(countSelector(bridgeCss, '.tavern-local-connect {')).toBe(1)
    expect(countSelector(bridgeCss, '.tavern-device-join {')).toBe(1)
    expect(bridgeCss.match(/\.tavern-device-join input(?=\s*[,{}])/gu)).toHaveLength(1)
    expect(countSelector(bridgeCss, '.tavern-device-join__code {')).toBe(1)
    expect(countSelector(bridgeCss, '.tavern-bridge__primary {')).toBe(1)

    expect(stitch).not.toContain('<small>FILL</small>')
    expect(stitch).not.toContain('<small>MAIN</small>')
    expect(stitch).not.toContain('FILL SOURCE')
    expect(stitch).not.toContain('CHAT VARIABLE')
    expect(stitch).not.toContain('CANDIDATE BASKET')
    expect(stitch).toContain('stitch__contextbar')

    expect(stitchCss).not.toContain('.stitch__header {')
    expect(stitchCss).not.toContain('.stitch__swap {')
    expect(stitchCss).not.toContain('.stitch__focus {')
  })
})
