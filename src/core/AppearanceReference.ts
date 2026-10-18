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
  '--boot-background': '资源库启动加载页与本机数据库准备页的背景（支持渐变）',
  '--boot-color': '启动加载页与本机数据库准备页的文字颜色',
  '--boot-font': '启动加载页的完整字体设置，例如 15px/1.7 system-ui',
  '--boot-title-size': '启动加载与本机数据库准备页标题字号',
  '--notice-color': '系统迁移提示的文字颜色',
  '--recovery-background': 'CSS试用、启动恢复与安全模式提示的背景',
  '--recovery-color': '受保护恢复提示的标题和正文颜色',
  '--recovery-secondary-color': '受保护恢复提示的辅助文字颜色',
  '--recovery-border': '受保护恢复提示的边框颜色',
  '--recovery-radius': '受保护恢复提示的面板圆角',
  '--recovery-shadow': '受保护恢复提示的面板阴影',
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
  '--layer-resource-detail': '资源详情层级；子编辑器、对话框与普通图片查看器按此层派生',
  '--layer-resource-editor': '资源详情内个人资源编辑和版本对比的层级，默认高于详情一层',
  '--layer-resource-dialog': '资源详情内图库对话框的层级，默认高于详情六层',
  '--layer-resource-viewer': '资源详情内普通图片查看器的层级，默认高于详情八层',
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
  '--folder-indicator-color':
    '侧栏、文件夹管理与备份范围的小圆点显示色；留空沿用保存的分类颜色，不改颜色选择框的实际值',
  '--folder-saved-color': '文件夹已保存颜色的回退值；统一主题应修改 --folder-indicator-color',
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

// SRL-PUBLIC-SYNC: BEGIN REPLACE id=public-appearancereference-ts-1
export const CSS_REFERENCE_INTRO = `全局用 :root；APP 局部用 :scope，未改属性沿用全局。启动加载页 #srl-boot、本机准备页 #srl-native-preparation、系统迁移提示 .srl-native-migration-notice 使用全局 CSS；--boot-* 可单独改启动页。启动读取已保存的应用样式，试用未确认时恢复上一版，安全模式不应用自定义 CSS。CSS试用/启动恢复/Vue恢复提示位于受保护的 Shadow DOM，只能通过 --recovery-*、公共按钮与颜色变量改外观；普通选择器不能穿透保护层改内部布局。公共弹窗与通知需改全局。原生读了么的启动页/列表/导航/工具弹窗默认使用公共颜色和控件变量；读了么正文的纸色、护眼色、夜间模式与字号仍由阅读外观独立管理。读了么内部 UI 位于 Shadow DOM，普通全局选择器不能直接穿透；需改专属选择器时使用读了么 APP 局部 CSS，宿主会转发该作用域。以下变量与选择器来自源码或已安装 APP 的实际 CSS；更具体的定义可能覆盖局部变量。带 .appearance-action-face 的按钮只给内层画背景和边框，外层 .appearance-action-hit 保持透明。 data-srl-controls 区域的普通按钮、文本输入、下拉框和文本域共用公共材质；返回键、页头动作、滑杆、色盘、复选框及开关不按普通文本控件处理。data-srl-dialog 标记公共弹窗材质；这些标记不控制卡片方向、尺寸或页面布局。Vue 的 :deep() / :global() 需转成普通 CSS 选择器。宿主 CSS 不能直接改独立 iframe、图片或作者作品内容。`
// SRL-PUBLIC-SYNC: END REPLACE id=public-appearancereference-ts-1
export const CARD_REFERENCE = `卡片横竖方向只在手机宽度不超过 860px 生效。data-mobile-card-orientation：portrait / landscape / mixed；data-resource-card-height：natural / uniform / fixed。不要无条件写死 height、min-height、aspect-ratio 或加 !important，否则会覆盖系统切换。固定正文可按模式设置 --resource-card-fixed-body-length。`
export function vueReferenceExample(chapter: ReferenceChapter): string {
  const title = JSON.stringify(chapter.scope.title).replaceAll('<', '\\u003c')
  return `<script setup>\nimport { ref } from 'vue'\nimport { usePage } from './Page.js'\nconst page = usePage()\nconst { Layout, Region } = page\nconst title = ref(${title})\nconst menu = ref(false)\n</script>\n<template>\n  <Layout>\n    <h1>{{ title }}</h1>\n    <button @click="menu = !menu">更多操作</button>\n    <section v-if="menu">自己的菜单</section>\n    <Region body />\n  </Layout>\n</template>`
}
export const VUE_REFERENCE_BOUNDARY = `在对应 APP 创建 View.vue，Page.js 随新模板提供。用 page.controls() 查看当前可调用的原控件；CSS 类不等于操作接口。资源保存与导出仍由原 APP 执行，无法直接读取宿主数据库或凭据。原生图片长列表可在顶层自然高度容器加 data-srl-host-scroll，让模板与原图由宿主同层滚动；该容器不要用 iframe 的 100vh/dvh 作为最小高度，退出布局时移除标记。旧宿主不识别该标记时仍沿原滚动路线，需要更新宿主才能消除跨层滑动错位。原生区域支持属性变化、平移和轴向缩放，按祖先矩形裁切与常见定位遮罩限制可见和点击区域；动画仅在影响布局期间同步。用 Web Animations 等不改 DOM 属性的 API 启动动画后可调用 srlUi.refreshLayout()。读了么阅读工作区作为整体原生区域保留，正文不进入作者快照，内部阅读外观仍沿读了么设置管理。任意旋转、复杂非矩形路径和跨文档半透明混色不保证与单文档相同；几何动画仍有异步传递边界，不能宣称逐帧像素同步。先预览，再启用、保存与试用；恢复默认或 Alt + Shift + 0 可回到原界面。联网由设置“允许远程资源”控制，默认关闭。`

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
