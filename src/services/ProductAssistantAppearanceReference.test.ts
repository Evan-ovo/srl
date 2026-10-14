import { describe, expect, it } from 'vitest'
import { parseAppearanceCss } from '../core/AppearanceCssReference'
import { assistantAppearanceReference } from './ProductAssistantAppearanceReference'
import { createAppearanceReferenceReader } from './AppearanceReferenceService'
import type { AppearanceScope } from '../core/AppearanceScopes'
import type { ReferenceCatalog } from '../types/AppearanceReference'
import type { InstalledOfficialApp } from '../types/OfficialApp'

const scope: AppearanceScope = { value: 'library', title: '资源库', selector: '.library', hint: '' }
describe('助手复用接口手册', () => {
  it('可翻页找到第80条之后的规则，保留媒体条件、重要性、变量用途与原始行号', () => {
    const css =
      Array.from(
        { length: 85 },
        (_, index) => `.card-${index} { color: var(--color-accent) }`,
      ).join('\n') +
      '\n@media (max-width: 400px) { .narrow { color: var(--color-accent) !important } }'
    const catalog: ReferenceCatalog = {
      version: 'host',
      fingerprint: 'hash',
      scopes: { library: ['cards.css:1'] },
      sources: [parseAppearanceCss(css, 'cards.css')],
    }
    const first = assistantAppearanceReference(catalog, scope)
    expect(first.nextOffset).toBe(20)
    expect(first.total).toBe(86)
    const last = assistantAppearanceReference(catalog, scope, '', 80)
    expect(last.nextOffset).toBeNull()
    expect(last.rules[0]?.selector).toBe('.card-80')
    const filtered = assistantAppearanceReference(catalog, scope, '.narrow')
    expect(filtered.rules[0]).toMatchObject({
      conditions: '@media (max-width: 400px)',
      line: 86,
      declarations: { color: 'var(--color-accent) !important' },
    })
    expect(filtered.variables[0]).toMatchObject({
      name: '--color-accent',
      meaning: expect.stringContaining('主色'),
    })
    expect(assistantAppearanceReference(catalog, scope, 'missing').total).toBe(0)
  })

  it('安装版本替换宿主旧样式，使用APP别名仍指向实际包，后续更新不读旧章节', async () => {
    const app: InstalledOfficialApp = {
      schemaVersion: 1,
      id: 'frontendWorkshop',
      shellVersion: 'v2',
      installedAt: 1,
      entry: '/assets/app.js',
      styles: ['/assets/app.css'],
      files: [{ path: '/assets/app.css', sha256: 'a'.repeat(64), size: 100 }],
    }
    const catalog: ReferenceCatalog = {
      sources: [parseAppearanceCss('.obsolete{color:red}', 'old.css')],
      scopes: { frontendWorkshop: ['old.css:1'] },
    }
    const reader = createAppearanceReferenceReader(
      catalog,
      async () => [app],
      async () => '.actual{color:blue}',
    )
    const current = await reader.read(['frontendWorkshop'], new AbortController().signal)
    const result = assistantAppearanceReference(
      current,
      {
        value: 'frontend',
        title: '前端了么',
        selector: '.feature-hub',
        hint: '',
        appId: 'frontendWorkshop',
      },
      '.actual',
    )
    expect(result.sourceKind).toBe('installed-app')
    expect(result.version.version).toBe('v2')
    expect(result.rules[0]?.selector).toBe('.actual')
    expect(JSON.stringify(result)).not.toContain('obsolete')
    reader.clear()
  })
})
