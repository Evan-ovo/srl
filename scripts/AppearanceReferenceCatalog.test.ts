import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createAppearanceReferenceCatalog,
  splitReferenceSources,
} from './AppearanceReferenceCatalog'
import { createVueReference } from './AppearanceVueReference'
import { UI_VIEW_HELPER } from '../src/core/UiViewStarter'
import { createReferenceChapters, referenceMarkdown } from '../src/core/AppearanceReference'
import { parseAppearanceCss } from '../src/core/AppearanceCssReference'

const bridge = readFileSync('src/services/UiViewRuntime.ts', 'utf8')
const types = readFileSync('src/types/UiCustomization.ts', 'utf8')

describe('接口手册随源码更新', () => {
  it('keeps interface content identity stable when only release metadata changes', () => {
    const read = (version: string) => (path: string) =>
      path === resolve('build-info.json')
        ? JSON.stringify({ buildId: version })
        : readFileSync(path, 'utf8')
    const first = createAppearanceReferenceCatalog(process.cwd(), read('srl-test-v1'))
    const next = createAppearanceReferenceCatalog(process.cwd(), read('srl-test-v2'))
    expect(next.version).toBe('srl-test-v2')
    expect(first.version).toBe('srl-test-v1')
    expect(next.fingerprint).toBe(first.fingerprint)
    expect(next.sources).toEqual(first.sources)
  })

  it('资源广场和原生读了么的公共主题映射进入实际 APP 手册', () => {
    const catalog = createAppearanceReferenceCatalog(process.cwd())
    const chapters = createReferenceChapters(catalog)
    for (const [appId, sourcePath] of [['chatReader', 'src/reader/ChatReader.css']]) {
      const source = catalog.sources.find((item) => item.path.startsWith(sourcePath + ':'))
      expect(source).toBeDefined()
      const chapter = chapters.find((item) => item.scope.appId === appId)
      expect(chapter?.sources).toContainEqual(source)
      expect(chapter?.variables.some((item) => item.name === '--color-canvas')).toBe(true)
    }
    const reader = chapters.find((item) => item.scope.appId === 'chatReader')!
    const canvas = reader.variables.find((item) => item.name === '--color-canvas')!
    expect(canvas.uses.some((use) => use.source.startsWith('src/reader/ChatReader.css:'))).toBe(
      true,
    )
    expect(referenceMarkdown([reader], 'css')).toContain('src/reader/ChatReader.css')
    expect(referenceMarkdown(chapters, 'css')).toContain('--folder-indicator-color')
  })
  it('分块保持完整规则、来源与顺序，普通分块不超过既有脚本预算', () => {
    const catalog = createAppearanceReferenceCatalog(process.cwd())
    const parts = splitReferenceSources(catalog.sources)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.flat()).toEqual(catalog.sources)
    expect(parts.every((part) => Buffer.byteLength(JSON.stringify(part)) < 500 * 1024)).toBe(true)
  })
  it('保留注册变量、Unicode变量、important、作用域/媒体条件与CSS依赖', () => {
    const imports: string[] = []
    const source = parseAppearanceCss(
      '@import url("./extra.css"); @property --圆角 { syntax: "<length>"; inherits: false; initial-value: 4px; } @media (width < 600px) { @scope (.app) { button { border-radius: var(--圆角) !important; } } }',
      'fixture.css',
      3,
      (path) => imports.push(path),
    )
    expect(imports).toEqual(['./extra.css'])
    const chapters = createReferenceChapters({
      sources: [source],
      scopes: { global: [source.path] },
    })
    const variable = chapters[0]!.variables.find((variable) => variable.name === '--圆角')!
    expect(variable.definitions[0]!.value).toBe('4px')
    expect(variable.uses[0]!.conditions).toBe('@media (width < 600px) / @scope (.app)')
    expect(variable.uses[0]!.value).toContain('!important')
    expect(variable.meaning).toContain('圆角')
  })
  it('新增/删除 Vue 方法、修改参数和说明直接进入手册与 Markdown', () => {
    const helper = UI_VIEW_HELPER.replace('has: selector =>', 'has: (selector, options) =>')
      .replace('/** 检查当前快照是否存在该区域。 */', '/** 新用途说明。 */')
      .replace('    attrs: selector => attrs(find(selector)),', '')
      .replace(
        '    click: selector =>',
        '    /** 新增菜单入口。 */\n    menu: (selector, enabled) => enabled,\n    /** 调用原按钮。 */\n    click: selector =>',
      )
    const vue = createVueReference(helper, bridge, types)
    expect(vue.find(([name]) => name === 'page.has(selector, options)')?.[1]).toContain(
      '新用途说明',
    )
    expect(vue.some(([name]) => name === 'page.attrs(selector)')).toBe(false)
    expect(vue.some(([name]) => name === 'page.menu(selector, enabled)')).toBe(true)
    const regionUpdate = createVueReference(
      UI_VIEW_HELPER.replace(
        '      body: Boolean,',
        '      body: Boolean,\n      /** 保留首个区域。 */\n      first: Boolean,',
      ),
      bridge,
      types,
    )
    expect(regionUpdate.some(([name]) => name === 'page.Region.first')).toBe(true)
    const nodeUpdate = createVueReference(
      UI_VIEW_HELPER.replace(
        "      key: element.getAttribute('data-srl-node'),",
        "      key: element.getAttribute('data-srl-node'),\n      /** 节点类型。 */\n      tag: element.tagName,",
      ),
      bridge,
      types,
    )
    expect(nodeUpdate.some(([name]) => name === 'page.nodes()[].tag')).toBe(true)
    const chapters = createReferenceChapters({ sources: [], scopes: {}, vue })
    const markdown = referenceMarkdown(chapters, 'vue')
    expect(markdown).toContain('page.menu(selector, enabled)')
    expect(markdown).not.toContain('page.attrs(selector)')
  })

  it('新增快照字段、事件枚举及底层桥方法自动更新；缺少说明明确失败', () => {
    const changedTypes = types
      .replace(
        '  theme: string',
        '  theme: "light" | "dark"\n  /** 当前布局方向。 */\n  orientation?: string',
      )
      .replace("'click' | 'input'", "'focus' | 'input'")
    const changedBridge = bridge.replace(
      '      invoke,',
      '      invoke,\n      /** 读取连接状态。 */\n      connected: () => Boolean(port),',
    )
    const vue = createVueReference(UI_VIEW_HELPER, changedBridge, changedTypes)
    expect(vue.map(([name]) => name)).toContain('UiViewSnapshot.orientation?: string')
    expect(vue.find(([name]) => name.startsWith('UiViewAction.event:'))?.[0]).toContain("'focus'")
    expect(vue.map(([name]) => name)).toContain('window.srlUi.connected()')
    expect(() =>
      createVueReference(
        UI_VIEW_HELPER.replace(
          '    click: selector =>',
          '    missing: () => true,\n    click: selector =>',
        ),
        bridge,
        types,
      ),
    ).toThrow('接口手册缺少用途说明')
    expect(() =>
      createVueReference(
        UI_VIEW_HELPER,
        bridge,
        types.replace('  theme: string', '  theme: string\n  missing: boolean'),
      ),
    ).toThrow('接口手册缺少用途说明')
  })

  it('追踪普通模块、动态加载及外部 SFC 样式；新变量/删除规则和逻辑变化使目录与指纹更新', () => {
    const root = process.cwd()
    const counts = new Map<string, number>()
    let style = '.new-selector { --new-color: #abc; color: var(--new-color); }'
    const watched = new Set<string>()
    const read = (path: string): string => {
      counts.set(path, (counts.get(path) ?? 0) + 1)
      if (path === resolve('src/components/PresetStitcherApp.vue'))
        return '<script setup>import "../services/AppearanceOriginalCssService"</script><style src="../styles/Foundation.css" />'
      if (path === resolve('src/services/AppearanceOriginalCssService.ts'))
        return 'export { default } from "../components/AppearanceOriginalCssActions.vue"; const lazy = () => import("../styles/AppearanceOriginalCssActions.css")'
      if (path === resolve('src/styles/AppearanceOriginalCssActions.css')) return style
      if (path.endsWith('.vue')) return '<template><main /></template>'
      if (path.endsWith('.css')) return ':root { --base: #fff; }'
      if (
        path.endsWith('.ts') &&
        !/UiViewStarter|UiViewRuntime|UiCustomization|FeatureAppLoaders|FeatureAppRegistry/u.test(
          path,
        )
      )
        return ''
      return readFileSync(path, 'utf8')
    }
    const first = createAppearanceReferenceCatalog(root, read, (path) => watched.add(path))
    expect(first.scopes.global).toContain('src/styles/Startup.css:1')
    expect(first.scopes.shell).toContain('src/styles/RecoveryControls.css:1')
    expect([...counts.values()].every((count) => count === 1)).toBe(true)
    expect(watched.has(resolve('src/styles/AppearanceOriginalCssActions.css'))).toBe(true)
    expect(watched.has(resolve('src/services/AppearanceOriginalCssService.ts'))).toBe(true)
    const stitch = createReferenceChapters(first).find(
      (chapter) => chapter.scope.value === 'stitch',
    )!
    expect(stitch.variables.find((variable) => variable.name === '--new-color')?.meaning).toContain(
      '文字或图标颜色',
    )
    expect(referenceMarkdown([stitch], 'css')).toContain('.new-selector')
    style = '.replacement { --space: 2px; gap: var(--space); }'
    const next = createAppearanceReferenceCatalog(root, read)
    expect(next.fingerprint).not.toBe(first.fingerprint)
    const updated = createReferenceChapters(next).find(
      (chapter) => chapter.scope.value === 'stitch',
    )!
    expect(updated.variables.map((variable) => variable.name)).not.toContain('--new-color')
    expect(referenceMarkdown([updated], 'both')).toContain('--space')
    expect(referenceMarkdown([updated], 'both')).not.toContain('.new-selector')
    expect(referenceMarkdown([updated], 'both')).toContain(`源码版本：${next.version}`)
  })
})
