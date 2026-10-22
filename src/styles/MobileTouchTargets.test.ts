/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

const cloudBackupCss = readFileSync(new URL('./CloudBackup.css', import.meta.url), 'utf8')
const mainApiSettings = readFileSync(
  new URL('../components/MainApiSettings.vue', import.meta.url),
  'utf8',
)
const inlineModelPicker = readFileSync(
  new URL('../components/InlineModelPicker.vue', import.meta.url),
  'utf8',
)
const richContentPreview = readFileSync(
  new URL('./RichContentPreview.css', import.meta.url),
  'utf8',
)
const frontendWorkshopCss = readFileSync(
  new URL('./FrontendWorkshopDesignAppearance.css', import.meta.url),
  'utf8',
)
const frontendWorkshopReferencesCss = readFileSync(
  new URL('./FrontendWorkshopDesignReferences.css', import.meta.url),
  'utf8',
)
const frontendWorkshopResponsiveCss = readFileSync(
  new URL('./FrontendWorkshopResponsive.css', import.meta.url),
  'utf8',
)
const frontendWorkshopProofCss = readFileSync(
  new URL('./FrontendWorkshopProof.css', import.meta.url),
  'utf8',
)
const performanceMonitorCss = readFileSync(
  new URL('./PerformanceMonitor.css', import.meta.url),
  'utf8',
)
const featureDesktopCss = readFileSync(new URL('./FeatureDesktop.css', import.meta.url), 'utf8')
const appearanceStudioCss = readFileSync(new URL('./AppearanceStudio.css', import.meta.url), 'utf8')
const dataTransferPanelsCss = readFileSync(
  new URL('./DataTransferPanels.css', import.meta.url),
  'utf8',
)
const tavernBridgeInstallGuideCss = readFileSync(
  new URL('./TavernBridgeInstallGuide.css', import.meta.url),
  'utf8',
)
const tavernBridgeCenterCss = readFileSync(
  new URL('./TavernBridgeCenter.css', import.meta.url),
  'utf8',
)
const layoutAndResponsiveCss = readFileSync(
  new URL('./LayoutAndResponsive.css', import.meta.url),
  'utf8',
)
const presetStitcherCss = readFileSync(new URL('./PresetStitcherApp.css', import.meta.url), 'utf8')
const userPersonaCss = readFileSync(new URL('./UserPersonaApp.css', import.meta.url), 'utf8')
const featureBackButtonCss = readFileSync(
  new URL('./FeatureBackButton.css', import.meta.url),
  'utf8',
)
const glassRefinementCss = readFileSync(new URL('./GlassRefinement.css', import.meta.url), 'utf8')
const versionArchiveCss = readFileSync(new URL('./VersionArchive.css', import.meta.url), 'utf8')

function readRule(source: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return source.match(new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\}`))?.[1] ?? ''
}

describe('移动端主要触控目标', () => {
  it('移动端文字输入框至少 16px，避免 iOS Safari 聚焦自动缩放', () => {
    expect(layoutAndResponsiveCss).toMatch(
      /@media \(max-width: 53\.75rem\)[\s\S]*?input:not\([\s\S]*?font-size: 16px/,
    )
    expect(layoutAndResponsiveCss).toContain("[type='checkbox']")
    expect(layoutAndResponsiveCss).toContain("[type='radio']")
    expect(glassRefinementCss).not.toMatch(/font-size:\s*16px/)
  })

  it('资源详情操作栏独立占位，正文不再为浮动按钮预留假空白', () => {
    expect(versionArchiveCss).not.toContain('top: -1.25rem')
    expect(versionArchiveCss).not.toContain('bottom: calc(-1 * max(')
    expect(versionArchiveCss).toMatch(
      /\.resource-detail__actions\s*\{[^}]*flex-shrink: 0;[^}]*margin-top: 0;/,
    )
    expect(dataTransferPanelsCss).not.toContain('.resource-detail__actions {')
    expect(versionArchiveCss).not.toContain('padding-bottom: calc(7rem + var(--safe-bottom))')
  })

  it('资源详情在手机上是覆盖完整 visual viewport 的二级页，而普通编辑仍是 sheet', () => {
    expect(layoutAndResponsiveCss).not.toMatch(
      /\.editor-sheet--wide,\s*\.resource-detail-sheet,\s*\.export-sheet/,
    )
    expect(layoutAndResponsiveCss).toMatch(
      /:root body \.mobile-dialog-viewport,[^{]*\.external-app-manager__overlay\s*\{[^}]*inset: var\(--visual-viewport-offset-top\) 0 auto;[^}]*height: var\(--visual-viewport-height\);/,
    )
    expect(layoutAndResponsiveCss).toMatch(
      /\.editor-overlay\s*\{[^}]*inset: var\(--visual-viewport-offset-top\) 0 auto;[^}]*height: var\(--layout-viewport-height, 100lvh\);/,
    )
    expect(
      readFileSync(new URL('../components/ResourceOrganizer.vue', import.meta.url), 'utf8'),
    ).toContain('class="srl-independent-page resource-detail-page"')
    expect(layoutAndResponsiveCss).not.toContain('.resource-detail-overlay')
    expect(layoutAndResponsiveCss).toMatch(
      /\.resource-detail-page \.resource-detail-sheet\s*\{[^}]*height: 100%;[^}]*max-height: none;[^}]*border-radius: 0;/,
    )
    expect(layoutAndResponsiveCss).toMatch(
      /\.resource-detail-sheet \.resource-detail__header\s*\{[^}]*padding: max\(0\.75rem, var\(--safe-top\)\)/,
    )
  })

  it('用户人设复用共享 44px 返回按钮且不被页面通配按钮覆盖', () => {
    expect(userPersonaCss).not.toContain('min-height: 42px')
    expect(readRule(featureBackButtonCss, '.feature-back-button')).toContain(
      'min-height: var(--size-touch)',
    )
    expect(glassRefinementCss).not.toMatch(/\.persona-app button(?:\b|:)/)
  })

  it('缝了么填充预设选择器把下拉标记约束在按钮内部', () => {
    const pickerRule = readRule(presetStitcherCss, '.stitch-pane__header > button')
    const markerRule = readRule(presetStitcherCss, '.stitch-pane__header > button b')

    expect(pickerRule).toContain('position: relative')
    expect(pickerRule).toContain('padding: 2px 14px 2px 3px')
    expect(pickerRule).toContain('overflow: hidden')
    expect(markerRule).toContain('position: absolute')
    expect(markerRule).toContain('right: 3px')
  })

  it('酒馆互传安装说明中的脚本源码链接不小于 44px', () => {
    const sourceLinkRule = readRule(tavernBridgeInstallGuideCss, '.tavern-bridge-install__notes a')

    expect(sourceLinkRule).toContain('min-height: 44px')
  })

  it('酒馆互传的其他小工具入口及弹窗操作不小于 44px', () => {
    expect(tavernBridgeCenterCss).toMatch(
      /\.tavern-bridge-author-tools > button,[\s\S]*?\.author-tools-dialog button,[\s\S]*?min-height: 44px/,
    )
    expect(tavernBridgeCenterCss).toContain('@media (max-width: 32rem)')
  })

  it('酒馆互传的小工具弹层覆盖手机底部栏，且内容容器可以滚动', () => {
    const dialogRule = readRule(tavernBridgeCenterCss, '.author-tools-dialog')
    const sheetRule = readRule(tavernBridgeCenterCss, '.author-tools-dialog__sheet')
    const dialogZIndex = Number(dialogRule.match(/z-index:\s*(\d+)/)?.[1])
    const bottomNavZIndex = Number(
      layoutAndResponsiveCss.match(
        /\.mobile-bottom-nav\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?z-index:\s*(\d+)/,
      )?.[1],
    )

    expect(dialogZIndex).toBeGreaterThan(bottomNavZIndex)
    expect(dialogRule).toContain('overflow-y: auto')
    expect(sheetRule).toContain('overflow: auto')
  })

  it('酒馆互传在手机以两列紧凑资源卡呈现，不保留全宽长条文件行', () => {
    expect(tavernBridgeCenterCss).toContain('.tavern-bridge-resource-grid')
    expect(tavernBridgeCenterCss).toContain('.tavern-bridge-resource-card')
    expect(tavernBridgeCenterCss).toMatch(
      /@media \(max-width: 760px\)[\s\S]*?\.tavern-bridge-resource-grid\s*\{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/,
    )
  })

  it('文件夹显隐按钮在移动端不小于 44px', () => {
    expect(dataTransferPanelsCss).toMatch(
      /\.category-row__visibility\s*\{[\s\S]*?min-height: 2\.75rem/,
    )
  })

  it('外观高级编辑器的复制按钮不小于 44px', () => {
    const copyButtonRule = readRule(appearanceStudioCss, '.appearance-scope-editor__header button')

    expect(copyButtonRule).toContain('min-height: 2.75rem')
  })

  it('抽卡揭晓页的返回资源库按钮在移动端不小于 44px', () => {
    expect(featureDesktopCss).toMatch(
      /\.gallery-reveal__actions \.gallery-reveal__tertiary\s*\{[\s\S]*?min-height: 2\.75rem/,
    )
  })

  it('抽了么的移动端结果保持两列，十连封面不被压成横图且操作栏不覆盖正文', () => {
    expect(featureDesktopCss).toMatch(
      /@media \(max-width: 53\.75rem\)[\s\S]*?\.draw-results__grid\s*\{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/,
    )
    expect(featureDesktopCss).toMatch(
      /\.draw-results__grid--single \.draw-result-card__cover\s*\{[\s\S]*?aspect-ratio: 2 \/ 3/,
    )
    expect(featureDesktopCss).toMatch(
      /\.draw-results__grid:not\(\.draw-results__grid--single\) \.draw-result-card__cover\s*\{[\s\S]*?aspect-ratio: 3 \/ 4/,
    )
    expect(featureDesktopCss).toMatch(
      /@media \(max-width: 53\.75rem\)[\s\S]*?\.draw-actions\s*\{[\s\S]*?position: fixed;[\s\S]*?bottom: max\(var\(--bottom-nav-reserved\), var\(--safe-bottom\)\);/,
    )
    expect(featureDesktopCss).toContain(
      'padding-bottom: calc(var(--bottom-action-reserved) + var(--safe-bottom) + 1rem)',
    )
  })

  it('资源详情的修改版下载按钮保留高对比主按钮背景', () => {
    const dom = new JSDOM()
    const { document, CSSStyleRule } = dom.window
    const actions = document.createElement('div')
    actions.className = 'resource-detail__summary-actions'
    const button = document.createElement('button')
    button.className = 'button button--primary'
    actions.append(button)
    const style = document.createElement('style')
    style.textContent = glassRefinementCss
    document.head.append(style)
    try {
      const primaryRule = Array.from(style.sheet!.cssRules).find(
        (rule): rule is CSSStyleRule =>
          rule instanceof CSSStyleRule &&
          rule.selectorText.includes('resource-detail__summary-actions') &&
          button.matches(rule.selectorText) &&
          rule.style.getPropertyValue('background').includes('--button-primary-background'),
      )
      expect(primaryRule).toBeDefined()
      expect(primaryRule!.style.getPropertyValue('color')).toBe(
        'var(--button-primary-color, var(--color-on-accent))',
      )
      expect(primaryRule!.style.getPropertyValue('background')).toBe(
        'var(--button-primary-background, var(--color-accent))',
      )
    } finally {
      dom.window.close()
    }
  })

  it('酒馆预览发送状态在手机端横跨资源详情摘要两列', () => {
    expect(versionArchiveCss).toMatch(
      /@media \(max-width: 53\.75rem\)[\s\S]*?\.resource-detail__preview-status\s*\{[\s\S]*?grid-column: 1 \/ -1;[\s\S]*?min-width: 0;/,
    )
  })

  it('性能观测浮层在移动底栏隐藏后才贴近视口底边', () => {
    const monitorRule = readRule(performanceMonitorCss, '#srl-performance-monitor')

    expect(performanceMonitorCss).toContain('bottom: var(--bottom-notice-offset)')
    expect(monitorRule).toContain('z-index: 85')
    expect(performanceMonitorCss).toContain('@media (min-width: 53.8125rem)')
    expect(performanceMonitorCss).not.toContain('@media (min-width: 48rem)')
  })

  it('主 API 设置的按钮和字段使用统一 44px 触控令牌', () => {
    const buttonRule = readRule(mainApiSettings, '.main-api-settings button')
    const fieldRule = readRule(
      mainApiSettings,
      ".main-api-settings input:not([type='range']),\n.main-api-settings select",
    )

    expect(buttonRule).toContain('min-height: var(--size-touch)')
    expect(fieldRule).toContain('min-height: var(--size-touch)')
  })

  it('主 API 的内联模型选择器使用统一 44px 触控令牌', () => {
    const fieldRule = readRule(inlineModelPicker, '.inline-model-picker input')
    const buttonRule = readRule(inlineModelPicker, '.inline-model-picker button')

    expect(fieldRule).toContain('min-height: var(--size-touch)')
    expect(buttonRule).toContain('min-height: var(--size-touch)')
  })

  it('开场白预览的查看方式按钮不小于 44px', () => {
    const toolbarButtonRule = readRule(richContentPreview, '.rich-content-preview__toolbar button')

    expect(toolbarButtonRule).toContain('min-height: 44px')
  })

  it('前端了么快捷模板按钮分离紧凑视觉高度与 44px 触控热区', () => {
    const presetRule = readRule(frontendWorkshopCss, '.frontend-workshop__presets button')
    const presetHitRule = readRule(
      frontendWorkshopCss,
      '.frontend-workshop__presets button::before',
    )
    const fieldRule = readRule(
      frontendWorkshopCss,
      ".frontend-workshop select,\n.frontend-workshop input:not([type='range'], [type='file'], [type='checkbox'], [type='radio'])",
    )

    expect(presetRule).toContain('min-height: var(--control-visual)')
    expect(presetHitRule).toContain('inset: -0.375rem 0')
    expect(fieldRule).toContain('min-height: var(--size-touch)')
  })

  it('前端了么普通输入框规则排除 checkbox，审美建议勾选框保持紧凑尺寸', () => {
    const reviewCheckboxRule = readRule(
      frontendWorkshopProofCss,
      ".frontend-workshop .frontend-workshop__review-suggestion input[type='checkbox']",
    )

    expect(frontendWorkshopCss).toContain("[type='checkbox'], [type='radio']")
    expect(frontendWorkshopResponsiveCss).toContain("[type='checkbox'], [type='radio']")
    expect(reviewCheckboxRule).toContain('width: 1.2rem')
    expect(reviewCheckboxRule).toContain('max-width: 1.2rem')
    expect(reviewCheckboxRule).toContain('max-height: 1.2rem')
  })

  it('前端了么提示词注入开关不继承普通输入框的整行尺寸', () => {
    const switchRule = readRule(
      frontendWorkshopReferencesCss,
      ".frontend-workshop .frontend-workshop__module-switch input[type='checkbox']",
    )
    const switchLayoutRule = readRule(
      frontendWorkshopReferencesCss,
      '.frontend-workshop__module-switch',
    )
    const switchTextRule = readRule(
      frontendWorkshopReferencesCss,
      '.frontend-workshop__module-switch span',
    )
    const mobileRootRule = readRule(frontendWorkshopResponsiveCss, '.frontend-workshop')

    expect(switchLayoutRule).toContain('grid-template-columns: auto minmax(0, 1fr)')
    expect(switchLayoutRule).toContain('min-height: var(--size-touch)')
    expect(switchLayoutRule).toContain('border-radius: var(--radius-control)')
    expect(switchRule).toContain('width: 1.1rem')
    expect(switchRule).toContain('max-width: 1.1rem')
    expect(switchRule).toContain('max-height: 1.1rem')
    expect(switchTextRule).toContain('writing-mode: horizontal-tb')
    expect(frontendWorkshopReferencesCss).toContain('label:not(.frontend-workshop__module-switch)')
    expect(mobileRootRule).toContain('padding-bottom: 0')
  })

  it('云备份持久凭据状态与操作按钮保持可触控', () => {
    const statusRule = readRule(cloudBackupCss, '.cloud-credential-status')
    const controlRule = readRule(
      cloudBackupCss,
      '.cloud-credential-status button,\n.cloud-credential-cancel',
    )

    expect(statusRule).toContain('min-height: var(--size-touch)')
    expect(controlRule).toContain('min-height: var(--size-touch)')
  })

  it('云备份折叠说明入口使用统一 44px 触控令牌', () => {
    const guideRule = readRule(cloudBackupCss, '.cloud-guide summary')

    expect(guideRule).toContain('min-height: var(--size-touch)')
  })

  it('云备份教程的真实外链保持至少 44px 高', () => {
    const tutorialLinkRule = readRule(cloudBackupCss, '.cloud-tutorial-step > a')
    const tutorialShotRule = readRule(cloudBackupCss, '.tutorial-real-shot')

    expect(tutorialLinkRule).toContain('min-height: var(--size-touch)')
    expect(tutorialShotRule).toContain('min-height: var(--size-touch)')
  })
})
