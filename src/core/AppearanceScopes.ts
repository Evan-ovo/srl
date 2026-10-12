import { FEATURE_APP_REGISTRY, type FeatureAppDescriptor } from './FeatureAppRegistry'
import { isOfficialAppId } from '../types/OfficialApp'
import type { CustomCssPreset, CustomCssScope } from '../types/BrowserPreferences'
import { normalizeUiViews } from './UiCustomization'

export const SCOPED_CSS_REMOVED_EVENT = 'srl:scoped-css-removed'
export const APPLIED_CSS_CHANGED_EVENT = 'srl:applied-css-changed'

export interface AppearanceScope {
  value: CustomCssScope
  title: string
  selector: string
  hint: string
  appId?: string
}
// Stable aliases keep existing saved presets readable. New apps use their registry ID.
const aliases: Record<string, CustomCssScope> = {
  draw: 'draw',
  folders: 'cabinet',
  appearance: 'appearance',
  cloud: 'cloud',
  tavernBridge: 'bridge',
  stitch: 'stitch',
  frontendWorkshop: 'frontend',
  userPersona: 'persona',
}
export function appAppearanceKey(id: string): CustomCssScope {
  return aliases[id] ?? `app:${id}`
}
export function appearanceScopes(
  registry: readonly FeatureAppDescriptor[] = FEATURE_APP_REGISTRY,
): AppearanceScope[] {
  return [
    {
      value: 'shell',
      title: '整个应用界面',
      selector: '.app-shell',
      hint: '侧栏、底栏与当前页面的整体布局',
    },
    { value: 'library', title: '资源库', selector: '.library', hint: '主界面、筛选栏与资源卡片' },
    {
      value: 'details',
      title: '资源详情',
      selector: '.resource-detail-sheet, .personal-resource-editor',
      hint: '各类资源的详情与编辑页',
    },
    {
      value: 'features',
      title: '功能桌面',
      selector: '.feature-hub',
      hint: '功能 APP 列表与公共区域',
    },
    ...registry
      .filter((app) => app.visible)
      .map((app): AppearanceScope => ({
        value: appAppearanceKey(app.id),
        title: app.name,
        appId: app.id,
        // SRL-PUBLIC-SYNC: BEGIN REPLACE id=appearance-official-ready-selector
        selector: `.feature-hub[data-feature-page="${app.page}"]${isOfficialAppId(app.id) ? `:has([data-official-app-ready="${app.id}"])` : ''}`,
        // SRL-PUBLIC-SYNC: END REPLACE id=appearance-official-ready-selector
        hint: app.description,
      })),
    {
      value: 'settings',
      title: '设置页面',
      selector: '.layout-settings-page',
      hint: '设置与数据安全面板',
    },
  ]
}
export function scopeCss(scope: AppearanceScope, css: string): string {
  return `@scope (${scope.selector}) {\n${css.trim()}\n}`
}
export function compileAppearancePreset(preset: CustomCssPreset): string {
  const chunks = [preset.globalCss.trim()]
  for (const scope of appearanceScopes()) {
    const css = preset.scopedCss?.[scope.value]
    if (typeof css === 'string' && css.trim()) chunks.push(scopeCss(scope, css))
  }
  return chunks.filter(Boolean).join('\n\n')
}

export function upgradeLegacyAppearanceCss(css: string, presets: CustomCssPreset[]): string {
  for (const scope of appearanceScopes()) {
    if (!scope.appId || !isOfficialAppId(scope.appId)) continue
    const legacy = { ...scope, selector: `.feature-hub[data-feature-page="${scope.appId}"]` }
    for (const preset of presets) {
      const value = preset.scopedCss?.[scope.value]
      if (typeof value === 'string' && value.trim())
        css = css.split(scopeCss(legacy, value)).join(scopeCss(scope, value))
    }
  }
  return css
}

export function parseAppearancePreset(value: unknown): CustomCssPreset {
  const data = value as { format?: string; version?: number; preset?: CustomCssPreset } | null
  const preset = data?.preset
  if (
    data?.format !== 'srl-appearance-preset' ||
    data.version !== 1 ||
    !preset ||
    typeof preset.name !== 'string' ||
    typeof preset.globalCss !== 'string' ||
    !preset.scopedCss ||
    typeof preset.scopedCss !== 'object' ||
    Array.isArray(preset.scopedCss) ||
    Object.entries(preset.scopedCss).some(
      ([key, css]) => !/^[a-zA-Z0-9:_-]{1,100}$/.test(key) || typeof css !== 'string',
    )
  )
    throw new Error('外观预设格式无效')
  const views = normalizeUiViews(preset.views, true)
  const now = new Date().toISOString()
  return {
    id: crypto.randomUUID(),
    name: preset.name.slice(0, 160),
    globalCss: preset.globalCss,
    scopedCss: { ...preset.scopedCss },
    ...(preset.views !== undefined ? { views } : {}),
    createdAt: now,
    updatedAt: now,
  }
}
/** Locate generated top-level scope blocks without interpreting their CSS declarations. */
function removeScopedBlocks(css: string, headers: string[]): string {
  let depth = 0
  let quote = ''
  let comment = false
  let start = -1
  let copied = 0
  const kept: string[] = []
  for (let index = 0; index < css.length; index++) {
    const char = css[index]
    if (comment) {
      if (char === '*' && css[index + 1] === '/') {
        comment = false
        index++
      }
      continue
    }
    if (char === '\\') {
      index++
      continue
    }
    if (quote) {
      if (char === quote) quote = ''
      continue
    }
    if (char === '/' && css[index + 1] === '*') {
      comment = true
      index++
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (depth === 0 && headers.some((header) => css.startsWith(header, index))) start = index
    if (char === '{') depth++
    if (char === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        kept.push(css.slice(copied, start))
        copied = index + 1
        start = -1
      }
    }
  }
  kept.push(css.slice(copied))
  return kept.join('')
}

/** Preserve saved global CSS verbatim and remove only this APP's generated scope wrappers. */
export function removeAppAppearanceCss(
  css: string,
  presets: CustomCssPreset[],
  appId: string,
): string {
  const scope = appearanceScopes().find((item) => item.appId === appId)
  if (!scope) return css
  const legacy = {
    ...scope,
    selector: scope.selector.replace(/:has\(\[data-official-app-ready="[^"]+"\]\)$/, ''),
  }
  const global =
    presets
      .map((preset) => preset.globalCss.trim())
      .filter((value) => value && css.startsWith(value))
      .sort((left, right) => right.length - left.length)[0] ?? ''
  return (
    global +
    removeScopedBlocks(
      css.slice(global.length),
      [scope, legacy].map((definition) => `@scope (${definition.selector}) {\n`),
    )
  ).trim()
}
