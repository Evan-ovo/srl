import { appearanceScopes, type AppearanceScope } from './AppearanceScopes'
import type { ReferenceCatalog, ReferenceSource } from '../types/AppearanceReference'
export interface ReferenceUse {
  selector: string
  property: string
  source: string
  conditions: string
  value?: string
}
export interface ReferenceVariable {
  name: string
  meaning: string
  definitions: Array<ReferenceUse & { value: string }>
  uses: ReferenceUse[]
}
export interface ReferenceChapter {
  scope: Omit<AppearanceScope, 'value'> & { value: string }
  variables: ReferenceVariable[]
  sources: ReferenceSource[]
  vue: NonNullable<ReferenceCatalog['vue']>
  version?: string
  fingerprint?: string
  installed?: { version: string; fingerprint: string }
}
export type ReferenceExportKind = 'css' | 'vue' | 'both'

const meanings: Record<string, string> = {
  '--color-canvas': '页面与 APP 的基础底色',
  '--color-surface': '内容面板底色',
  '--color-surface-raised': '内层卡片与较高层级的内容底色',
  '--page-background': '整页背景，可写纯色或渐变',
  '--color-ink': '正文与标题颜色',
  '--color-ink-soft': '次要文字颜色',
  '--color-ink-muted': '弱化文字颜色',
  '--color-line': '分隔线与基础边框颜色',
  '--color-line-strong': '强调边框颜色',
  '--color-accent': '主色，影响主按钮、图标和选中强调',
  '--color-accent-soft': '主色对应的浅底色',
  '--color-on-accent': '主色底上的文字颜色',
  '--color-danger': '危险操作与错误强调色',
  '--color-on-danger': '危险操作底上的文字颜色',
  '--color-success': '成功状态色',
  '--color-warning': '警告状态色',
  '--glass-panel': '玻璃面板背景，支持渐变',
  '--glass-panel-strong': '较实的玻璃面板背景',
  '--glass-panel-muted': '弱化玻璃面板背景',
  '--glass-border': '玻璃面板边框颜色',
  '--glass-shadow': '玻璃面板阴影',
  '--glass-radius-panel': '玻璃面板圆角',
  '--glass-radius-control': '玻璃按钮与输入框默认圆角',
  '--radius-control': '基础控件圆角',
  '--radius-panel': '基础面板圆角',
  '--overlay-background': '弹窗后方遮罩的颜色与透明度',
  '--dialog-background': '公共弹窗背景',
  '--dialog-border': '公共弹窗边框颜色',
  '--dialog-radius': '公共弹窗圆角',
  '--dialog-shadow': '公共弹窗阴影',
  '--notice-background': '通知与任务浮层背景',
  '--notice-border': '通知与任务浮层边框',
  '--notice-radius': '通知与任务浮层圆角',
  '--notice-shadow': '通知与任务浮层阴影',
  '--button-background': '普通按钮背景',
  '--button-color': '普通按钮文字颜色',
  '--button-border': '普通按钮边框颜色',
  '--button-radius': '按钮圆角',
  '--button-shadow': '普通按钮阴影',
  '--button-primary-background': '主按钮背景',
  '--button-primary-color': '主按钮文字颜色',
  '--button-primary-border': '主按钮边框颜色',
  '--control-background': '输入框、下拉框等控件背景',
  '--control-border': '输入控件边框颜色',
  '--control-radius': '输入控件圆角',
  '--control-shadow': '输入控件阴影',
  '--selection-background': '已选项目背景',
  '--selection-border': '已选项目边框',
  '--selection-color': '已选项目文字颜色',
  '--folder-cover-background': '收藏柜无封面占位图背景',
  '--folder-cover-color': '无封面占位图图案与文字颜色',
  '--folder-indicator-color': '文件夹小圆点颜色，不改保存的分类颜色',
  '--resource-card-fixed-body-length': '固定长度模式的卡片正文高度；无封面时为最低高度',
  '--size-touch': '可操作控件的点击区域尺寸',
  '--font-body': '正文字体',
  '--font-display': '标题字体',
  '--font-code': '代码字体',
  '--visual-viewport-height': '运行时计算的可见视口高度，不建议手动覆盖',
  '--visual-viewport-offset-top': '运行时计算的视口顶部偏移，不建议手动覆盖',
  '--bottom-nav-reserved': '运行时计算的底部导航占位，不建议手动覆盖',
  '--bottom-action-reserved': '底部操作栏占位高度，修改可能遮住内容',
}
const properties: Record<string, string> = {
  color: '文字或图标颜色',
  background: '背景',
  'background-color': '背景色',
  'background-image': '背景图或渐变',
  border: '边框',
  'border-color': '边框颜色',
  'border-radius': '圆角',
  'box-shadow': '阴影',
  'font-size': '文字大小',
  'font-family': '字体',
  'font-weight': '字重',
  'line-height': '行高',
  width: '宽度',
  height: '高度',
  'min-height': '最小高度',
  'max-height': '最大高度',
  padding: '内边距',
  margin: '外边距',
  gap: '项目间距',
  opacity: '透明度',
  fill: 'SVG 填充色',
  stroke: 'SVG 描边',
  'aspect-ratio': '宽高比例',
  'grid-template-columns': '网格列布局',
  'grid-template-rows': '网格行布局',
  'z-index': '叠放层级',
  top: '顶部位置',
  bottom: '底部位置',
  left: '左侧位置',
  right: '右侧位置',
  'max-width': '最大宽度',
  'min-width': '最小宽度',
  'inline-size': '横向尺寸',
  'block-size': '纵向尺寸',
  'max-inline-size': '最大横向尺寸',
  'min-inline-size': '最小横向尺寸',
  'max-block-size': '最大纵向尺寸',
  'min-block-size': '最小纵向尺寸',
  transform: '位移、旋转或缩放',
  filter: '滤镜',
  'backdrop-filter': '背景模糊等滤镜',
  'outline-color': '焦点轮廓颜色',
  'outline-offset': '焦点轮廓间距',
  'outline-width': '焦点轮廓粗细',
  'stroke-width': 'SVG 描边粗细',
  'stroke-dasharray': 'SVG 虚线样式',
  'fill-opacity': 'SVG 填充透明度',
  'background-position': '背景位置',
  'background-size': '背景尺寸',
  'border-width': '边框粗细',
  transition: '过渡动画',
  animation: '动画',
  'animation-duration': '动画时长',
  'transition-duration': '过渡时长',
  'flex-basis': '弹性项目基础尺寸',
  'column-gap': '列间距',
  'row-gap': '行间距',
  'scroll-margin-top': '滚动定位的顶部间距',
  'scroll-padding-top': '滚动容器的顶部留白',
}
export function referenceProperty(property: string): string {
  if (property.startsWith('--')) return `派生变量 ${property}`
  return (
    properties[property] ??
    property.replace(
      /^(padding|margin)-(.+)$/u,
      (_, kind, side) => `${kind === 'padding' ? '内' : '外'}边距（${side}）`,
    )
  )
}
const variableNames = (value: string) =>
  [...value.matchAll(/var\(\s*(--[^\s,)]+)/gu)].map((match) => match[1]!)

export function createReferenceChapters(catalog: ReferenceCatalog): ReferenceChapter[] {
  const global: ReferenceChapter['scope'] = {
    value: 'all',
    title: '公共样式',
    selector: ':root',
    hint: '所有 APP 共用的主题、控件、弹窗与通知',
  }
  const scopes = [global, ...appearanceScopes()]
  return scopes.map((scope) => {
    let analysis: { variables: ReferenceVariable[]; sources: ReferenceSource[] } | undefined
    const analyze = () => {
      const files =
        catalog.scopes[scope.appId ?? (scope.value === 'all' ? 'global' : scope.value)] ?? []
      const sources = catalog.sources.filter((source) => files.includes(source.path))
      const variables = new Map<string, ReferenceVariable>()
      const ensure = (name: string) => {
        if (!variables.has(name))
          variables.set(name, { name, meaning: meanings[name] ?? '', definitions: [], uses: [] })
        return variables.get(name)!
      }
      for (const source of sources) {
        for (const rule of source.rules) {
          const location = rule.line ? source.path.replace(/:\d+$/u, `:${rule.line}`) : source.path
          const use = { selector: rule.selector, source: location, conditions: rule.conditions }
          for (const [property, value] of Object.entries(rule.declarations)) {
            if (
              property.startsWith('--') &&
              (scope.value === 'all' || !source.path.startsWith('src/styles/Foundation.css:'))
            )
              ensure(property)
            if (!source.path.startsWith('src/styles/Foundation.css:') || scope.value === 'all')
              for (const name of variableNames(value))
                ensure(name).uses.push({ ...use, property, value })
          }
        }
      }
      // Include inherited aliases transitively, without listing every unused foundation variable per APP.
      const definitions = catalog.sources.filter(
        (source) =>
          files.includes(source.path) || source.path.startsWith('src/styles/Foundation.css:'),
      )
      const pending = [...variables.keys()]
      for (let index = 0; index < pending.length; index++) {
        const name = pending[index]!
        for (const source of definitions)
          for (const rule of source.rules) {
            const value = rule.declarations[name]
            if (value === undefined) continue
            ensure(name).definitions.push({
              selector: rule.selector,
              source: rule.line ? source.path.replace(/:\d+$/u, `:${rule.line}`) : source.path,
              conditions: rule.conditions,
              property: name,
              value,
            })
            for (const dependency of variableNames(value))
              if (!variables.has(dependency)) {
                ensure(dependency)
                pending.push(dependency)
              }
          }
      }
      for (const item of variables.values()) {
        if (!item.meaning) {
          const effects = [
            ...new Set(
              item.uses
                .filter((use) => !use.property.startsWith('--'))
                .map((use) => referenceProperty(use.property)),
            ),
          ]
          const derived = [
            ...new Set(
              item.uses.filter((use) => use.property.startsWith('--')).map((use) => use.property),
            ),
          ]
          item.meaning = effects.length
            ? `调整${effects.join('、')}`
            : derived.length
              ? `用于计算 ${derived.join('、')}`
              : '源码定义的参数；未找到静态 CSS 使用位置'
        }
      }
      const priority = Object.keys(meanings)
      const rank = (name: string) => {
        const index = priority.indexOf(name)
        return index < 0 ? priority.length : index
      }
      return {
        variables: [...variables.values()].sort(
          (a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name),
        ),
        sources,
      }
    }
    const data = () => (analysis ??= analyze())
    return {
      scope,
      get variables() {
        return data().variables
      },
      get sources() {
        return data().sources
      },
      vue: catalog.vue ?? [],
      version: catalog.version,
      fingerprint: catalog.fingerprint,
      installed: scope.appId ? catalog.installed?.[scope.appId] : undefined,
    }
  })
}

export const CSS_REFERENCE_INTRO = `全局用 :root；APP 局部用 :scope，未改属性沿用全局。公共弹窗与通知需改全局。以下变量与选择器来自源码或已安装 APP 的实际 CSS；更具体的定义可能覆盖局部变量。带 .appearance-action-face 的按钮只给内层画背景和边框，外层 .appearance-action-hit 保持透明。Vue 的 :deep() / :global() 需转成普通 CSS 选择器。宿主 CSS 不能直接改独立 iframe、图片或作者作品内容。`
export const CARD_REFERENCE = `卡片横竖方向只在手机宽度不超过 860px 生效。data-mobile-card-orientation：portrait / landscape / mixed；data-resource-card-height：natural / uniform / fixed。不要无条件写死 height、min-height、aspect-ratio 或加 !important，否则会覆盖系统切换。固定正文可按模式设置 --resource-card-fixed-body-length。`
export function vueReferenceExample(chapter: ReferenceChapter): string {
  const title = JSON.stringify(chapter.scope.title).replaceAll('<', '\\u003c')
  return `<script setup>\nimport { ref } from 'vue'\nimport { usePage } from './Page.js'\nconst page = usePage()\nconst { Layout, Region } = page\nconst title = ref(${title})\nconst menu = ref(false)\n</script>\n<template>\n  <Layout>\n    <h1>{{ title }}</h1>\n    <button @click="menu = !menu">更多操作</button>\n    <section v-if="menu">自己的菜单</section>\n    <Region body />\n  </Layout>\n</template>`
}
export const VUE_REFERENCE_BOUNDARY = `在对应 APP 创建 View.vue，Page.js 随新模板提供。用 page.controls() 查看当前可调用的原控件；CSS 类不等于操作接口。资源保存与导出仍由原 APP 执行，无法直接读取宿主数据库或凭据。先预览，再启用、保存与试用；恢复默认或 Alt + Shift + 0 可回到原界面。联网由设置“允许远程资源”控制，默认关闭。`

export function referenceMarkdown(chapters: ReferenceChapter[], kind: ReferenceExportKind): string {
  const sections = [
    '# SRL 自定义接口教程',
    `导出内容：${kind === 'css' ? 'CSS 接口' : kind === 'vue' ? 'Vue 教程' : 'CSS 接口与 Vue 教程'}`,
  ]
  const identity = chapters[0]
  if (identity?.version && identity.fingerprint)
    sections.push(`源码版本：${identity.version}；接口指纹：${identity.fingerprint}`)
  const seenDefinitions = new Set<string>()
  const seenUses = new Set<string>()
  const seenSources = new Set<string>()
  if (chapters.length > 1)
    sections.push('公共定义、使用位置与选择器只列一次；各 APP 仍列出自己的变量名称与用途。')
  if (kind !== 'vue') sections.push('## CSS 用法', CSS_REFERENCE_INTRO)
  if (kind !== 'css') {
    sections.push('## Vue 用法与接口', VUE_REFERENCE_BOUNDARY)
    for (const [name, description] of chapters[0]?.vue ?? [])
      sections.push(`- \`${name}\`：${description}`)
    const sample = chapters.find((chapter) => chapter.scope.value !== 'all')
    if (sample) sections.push(`\`\`\`vue\n${vueReferenceExample(sample)}\n\`\`\``)
  }
  for (const chapter of chapters) {
    sections.push(
      `## ${chapter.scope.title}`,
      chapter.scope.hint,
      `作用范围：\`${chapter.scope.selector}\``,
    )
    if (kind !== 'vue' && chapter.installed)
      sections.push(
        `已安装 APP 样式：${chapter.installed.version}；资产指纹：${chapter.installed.fingerprint}`,
      )
    if (kind !== 'vue') {
      sections.push('### CSS 接口')
      if (chapter.scope.value === 'library') sections.push(CARD_REFERENCE)
      sections.push(
        `示例：\n\n\`\`\`css\n${chapter.scope.value === 'all' ? ':root' : ':scope'} {\n  --color-accent: #7d4be2;\n}\n\`\`\``,
      )
      for (const variable of chapter.variables) {
        sections.push(`#### ${variable.name}`, variable.meaning)
        for (const definition of variable.definitions) {
          const key = JSON.stringify([variable.name, definition])
          if (seenDefinitions.has(key)) continue
          seenDefinitions.add(key)
          sections.push(
            `- 定义：\`${definition.value}\`；\`${definition.selector}\` ${definition.conditions}（${definition.source}）`,
          )
        }
        for (const use of variable.uses) {
          const key = JSON.stringify([variable.name, use])
          if (seenUses.has(key)) continue
          seenUses.add(key)
          sections.push(
            `- 使用：${referenceProperty(use.property)}（\`${use.property}: ${use.value}\`）；\`${use.selector}\` ${use.conditions}（${use.source}）`,
          )
        }
      }
      sections.push('### 样式选择器')
      for (const source of chapter.sources) {
        if (source.path.startsWith('src/styles/Foundation.css:') && chapter.scope.value !== 'all')
          continue
        if (seenSources.has(source.path)) continue
        seenSources.add(source.path)
        sections.push(`#### ${source.path}`)
        for (const rule of source.rules)
          sections.push(
            `- \`${rule.selector}\`：${Object.keys(rule.declarations).map(referenceProperty).join('、')} ${rule.conditions}`,
          )
      }
    }
    if (kind !== 'css' && chapter.scope.value !== 'all') {
      sections.push(
        `Vue 编辑范围：\`${chapter.scope.value}\`；在“${chapter.scope.title}”下创建模板，使用前面的 Page.js 接口。`,
      )
    }
  }
  return sections.join('\n\n') + '\n'
}
