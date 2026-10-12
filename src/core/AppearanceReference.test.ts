import { describe, expect, it, vi } from 'vitest'
import { createAppearanceReferenceCatalog } from '../../scripts/AppearanceReferenceCatalog'
import { createReferenceChapters, referenceMarkdown } from './AppearanceReference'
import { FEATURE_APP_REGISTRY } from './FeatureAppRegistry'
import { UI_VIEW_HELPER } from './UiViewStarter'
import { createVueReference } from '../../scripts/AppearanceVueReference'
import { readFileSync } from 'node:fs'
const vue = () =>
  createVueReference(
    UI_VIEW_HELPER,
    readFileSync('src/services/UiViewRuntime.ts', 'utf8'),
    readFileSync('src/types/UiCustomization.ts', 'utf8'),
  )

describe('源码接口教程', () => {
  it('覆盖当前全部内置 APP，包含 SFC 外部样式与子界面样式', () => {
    const catalog = createAppearanceReferenceCatalog(process.cwd())
    for (const app of FEATURE_APP_REGISTRY.filter((app) => app.visible))
      expect(catalog.scopes[app.id]?.length, app.name).toBeGreaterThan(1)
    expect(
      catalog.scopes.details!.some((path) => path.includes('DiscordCommunitySources.css')),
    ).toBe(true)
    expect(
      catalog.scopes.frontendWorkshop!.some((path) => path.includes('FrontendWorkshopSource')),
    ).toBe(true)
    expect(catalog.scopes.chatReader!.some((path) => path.includes('reader.css'))).toBe(true)
    const chapters = createReferenceChapters(catalog)
    expect(
      chapters
        .find((chapter) => chapter.scope.value === 'stitch')!
        .variables.some(
          (variable) => variable.name === '--button-background' && variable.uses.length > 0,
        ),
    ).toBe(true)
    expect(
      chapters.find((chapter) => chapter.scope.value === 'frontend')!.sources.length,
    ).toBeGreaterThan(1)
  })
  it('目录不分析 CSS；只分析所选章节并复用章节结果', () => {
    const readRules = vi.fn(() => [
      { selector: '.target', conditions: '', declarations: { color: 'var(--local)' } },
    ])
    const source = {
      path: 'fixture.css:1',
      get rules() {
        return readRules()
      },
    }
    const chapters = createReferenceChapters({
      sources: [source],
      scopes: { stitch: [source.path] },
    })
    expect(readRules).not.toHaveBeenCalled()
    expect(chapters.map((chapter) => chapter.scope.title)).toContain('缝了么')
    expect(readRules).not.toHaveBeenCalled()
    const stitch = chapters.find((chapter) => chapter.scope.value === 'stitch')!
    const variables = stitch.variables
    const reads = readRules.mock.calls.length
    expect(variables.map((variable) => variable.name)).toContain('--local')
    expect(stitch.variables).toBe(variables)
    expect(readRules).toHaveBeenCalledTimes(reads)
  })
  it('按实际声明解释未知变量，保留主题/媒体条件、源码位置与继承依赖', () => {
    const chapters = createReferenceChapters({
      sources: [
        {
          path: 'src/styles/Foundation.css:1',
          rules: [
            {
              selector: ':root',
              conditions: '',
              declarations: { '--base': '#fff', '--unused': '#f00' },
            },
          ],
        },
        {
          path: 'fixture.css:1',
          rules: [
            {
              selector: '.stitch',
              conditions: '@media (max-width: 680px)',
              declarations: {
                '--local': 'var(--base)',
                color: 'var(--local)',
                gap: 'var(--spacing)',
              },
            },
          ],
        },
      ],
      scopes: {
        stitch: ['src/styles/Foundation.css:1', 'fixture.css:1'],
        global: ['src/styles/Foundation.css:1'],
      },
    })
    const chapter = chapters.find((item) => item.scope.value === 'stitch')!
    expect(chapter.variables.map((variable) => variable.name)).toEqual([
      '--base',
      '--local',
      '--spacing',
    ])
    const variable = chapter.variables.find((variable) => variable.name === '--local')!
    expect(variable.meaning).toContain('文字或图标颜色')
    expect(variable.uses[0]).toMatchObject({
      selector: '.stitch',
      property: 'color',
      conditions: '@media (max-width: 680px)',
      source: 'fixture.css:1',
    })
    expect(referenceMarkdown([chapter], 'css')).toContain('@media (max-width: 680px)')
  })
  it('Vue 帮助的方法均有实际 Page.js 实现，Markdown 两种内容不互相混入', () => {
    for (const [name] of vue()) {
      const method = name.match(/^page\.(\w+)\(/u)?.[1]
      if (method) expect(UI_VIEW_HELPER).toMatch(new RegExp(`\\b${method}:`))
    }
    const chapter = createReferenceChapters({ sources: [], scopes: {}, vue: vue() }).find(
      (item) => item.scope.value === 'stitch',
    )!
    expect(referenceMarkdown([chapter], 'css')).not.toContain('Vue 用法与接口')
    expect(referenceMarkdown([chapter], 'vue')).not.toContain('### 样式选择器')
    expect(referenceMarkdown([chapter], 'vue')).toContain("import { usePage } from './Page.js'")
  })
})
