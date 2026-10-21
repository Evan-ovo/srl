import postcss from 'postcss'

const color = (hex, pos = 0, alpha = 100) => ({ hex, pos, alpha }),
  fill = (type, stops) => ({
    type,
    stops,
    angle: 125,
    strength: 55,
    overlay: [color('#86bada', 0, 70), color('#dbaad7', 100, 0)],
  })
const defaults = {
  light: {
    canvas: fill('solid', [color('#e8f3f5')]),
    panel: fill('gradient', [color('#ffffff', 0, 68), color('#ebf9fb', 100, 42)]),
    button: fill('solid', [color('#1d707b')]),
    buttonText: fill('solid', [color('#ffffff')]),
    text: fill('solid', [color('#183842')]),
    border: fill('solid', [color('#ffffff', 0, 56)]),
  },
  dark: {
    canvas: fill('solid', [color('#17272e')]),
    panel: fill('gradient', [color('#304953', 0, 88), color('#1f343e', 100, 82)]),
    button: fill('solid', [color('#92d7d3')]),
    buttonText: fill('solid', [color('#17272e')]),
    text: fill('solid', [color('#eef8f8')]),
    border: fill('solid', [color('#d3eff1', 0, 13)]),
  },
}
defaults.light.panel.angle = 145
defaults.dark.panel.angle = 145
const define = (id, name, group, vars, preview, scope, seeds, flat = false, scene = 'library') => ({
  id,
  name,
  group,
  vars,
  preview,
  scope,
  seeds,
  flat,
  scene,
})
const specs = [
  define(
    'canvas',
    '页面背景',
    '页面',
    ['--page-background'],
    'preview',
    '资源库、功能页与设置页的公共背景；实色区域使用第一个颜色。',
    ['#e8f3f5', '#17272e'],
  ),
  define(
    'surface',
    '区域底色',
    '页面',
    ['--color-surface'],
    'demo-surface',
    '列表分区、导航和使用公共底色的区域。',
    ['#f2f9fa', '#1f323a'],
    true,
    'dialog',
  ),
  define(
    'raised',
    '浮层底色',
    '页面',
    ['--color-surface-raised'],
    'demo-raised',
    '浮起面板、菜单及实色浮层。',
    ['#fbfefe', '#293f48'],
    true,
    'dialog',
  ),
  define(
    'overlay',
    '遮罩',
    '页面',
    ['--overlay-background'],
    'preview',
    '弹窗后方的遮罩，不改变弹窗本身。',
    ['#1c3943', '#040f15', 58, 76],
    true,
    'dialog',
  ),
  define(
    'panel',
    '卡片底色',
    '卡片',
    ['--glass-panel'],
    'card',
    '资源卡片、侧栏、设置面板和公共面板。',
  ),
  define(
    'panelStrong',
    '强调面板',
    '卡片',
    ['--glass-panel-strong'],
    'search',
    '工具栏、强调面板及较厚的玻璃材质。',
    ['#ffffff', '#39545e', 78, 94],
  ),
  define(
    'panelMuted',
    '轻面板',
    '卡片',
    ['--glass-panel-muted'],
    'secondary',
    '轻量面板、辅助区域与弱化材质。',
    ['#ffffff', '#263d47', 40, 74],
  ),
  define(
    'dialog',
    '弹窗底色',
    '卡片',
    ['--dialog-background'],
    'demo-dialog',
    '资源详情、编辑、导入导出和公共弹窗。',
    ['#fbfefe', '#293f48'],
    false,
    'dialog',
  ),
  define(
    'button',
    '主要按钮',
    '按钮',
    ['--button-primary-background'],
    'action',
    '保存、导入等接入公共主要按钮材质的操作。',
  ),
  define(
    'buttonText',
    '主要文字',
    '按钮',
    ['--button-primary-color', '--color-on-accent'],
    'action',
    '主要按钮及强调底色上的文字。',
    null,
    true,
  ),
  define(
    'buttonBorder',
    '主要边框',
    '按钮',
    ['--button-primary-border'],
    'action',
    '主要按钮的边框。',
    ['#1d707b', '#92d7d3'],
    true,
  ),
  define(
    'normal',
    '普通按钮',
    '按钮',
    ['--button-background'],
    'ordinary',
    '取消、返回、更多和公共普通按钮；图标按钮共用。',
    ['#ffffff', '#263d47', 40, 74],
  ),
  define(
    'normalText',
    '普通文字',
    '按钮',
    ['--button-color'],
    'ordinary',
    '普通按钮和公共图标按钮的文字、图标。',
    ['#183842', '#eef8f8'],
    true,
  ),
  define(
    'normalBorder',
    '普通边框',
    '按钮',
    ['--button-border'],
    'ordinary',
    '普通按钮和筛选按钮的边框。',
    ['#356a7a', '#c4e5e8', 31, 28],
    true,
  ),
  define(
    'selected',
    '选中底色',
    '按钮',
    ['--selection-background'],
    'filter',
    '选中的分类、文件夹、标签和导航项。',
    ['#d8eeec', '#31575c'],
  ),
  define(
    'selectedText',
    '选中文字',
    '按钮',
    ['--selection-color'],
    'filter',
    '已选中按钮与导航项的文字和图标。',
    ['#1d707b', '#92d7d3'],
    true,
  ),
  define(
    'selectedBorder',
    '选中边框',
    '按钮',
    ['--selection-border'],
    'filter',
    '已选中按钮与导航项的边框。',
    ['#1d707b', '#92d7d3'],
    true,
  ),
  define(
    'text',
    '主要文字',
    '文字',
    ['--color-ink'],
    'title',
    '标题、正文及公共主要界面文字。',
    null,
    true,
  ),
  define(
    'textSoft',
    '次要文字',
    '文字',
    ['--color-ink-soft', '--color-ink-muted'],
    'secondary',
    '分类、文件名、时间、说明及占位文字。',
    ['#59727c', '#b5c8cc'],
    true,
  ),
  define(
    'accent',
    '链接图标',
    '文字',
    ['--color-accent'],
    'link',
    '链接、强调图标、焦点轮廓和公共控件强调色。',
    ['#1d707b', '#92d7d3'],
    true,
  ),
  define(
    'accentSoft',
    '强调底色',
    '文字',
    ['--color-accent-soft'],
    'demo-highlight',
    '强调区域的浅底色与焦点柔光；选中按钮另设。',
    ['#d8eeec', '#31575c'],
    true,
    'dialog',
  ),
  define(
    'control',
    '输入框底色',
    '控件',
    ['--control-background'],
    'demo-field',
    '输入框、下拉框及公共表单控件。',
    ['#ffffff', '#293f48', 62, 72],
    false,
    'dialog',
  ),
  define(
    'controlBorder',
    '输入框边框',
    '控件',
    ['--control-border'],
    'demo-field',
    '表单控件边框；焦点色由“链接图标”调整。',
    ['#356a7a', '#c4e5e8', 31, 28],
    true,
    'dialog',
  ),
  define(
    'border',
    '卡片边框',
    '边框',
    ['--glass-border'],
    'card',
    '资源卡片、玻璃面板及公共面板边框。',
    null,
    true,
  ),
  define(
    'line',
    '分隔线',
    '边框',
    ['--color-line'],
    'demo-surface',
    '列表、分区和公共细分隔线。',
    ['#437180', '#c4e3e6', 18, 15],
    true,
    'dialog',
  ),
  define(
    'lineStrong',
    '强调边线',
    '边框',
    ['--color-line-strong'],
    'demo-raised',
    '较明显的区域边线与公共描边。',
    ['#356a7a', '#c4e5e8', 31, 28],
    true,
    'dialog',
  ),
  define(
    'dialogBorder',
    '弹窗边框',
    '边框',
    ['--dialog-border'],
    'demo-dialog',
    '详情、编辑和公共弹窗的边框。',
    ['#ffffff', '#d3eff1', 56, 13],
    true,
    'dialog',
  ),
  define(
    'danger',
    '危险色',
    '提示',
    ['--color-danger'],
    'danger-button',
    '删除、危险操作和错误提示的强调色。',
    ['#a8495a', '#f0a8b0'],
    true,
    'notice',
  ),
  define(
    'dangerSoft',
    '危险底色',
    '提示',
    ['--color-danger-soft'],
    'danger',
    '错误及危险提示的背景。',
    ['#f7e7ea', '#573a43'],
    true,
    'notice',
  ),
  define(
    'dangerText',
    '危险按钮文字',
    '提示',
    ['--color-on-danger'],
    'danger-button',
    '填色危险按钮上的文字和图标。',
    ['#ffffff', '#17272e'],
    true,
    'notice',
  ),
  define(
    'success',
    '成功文字',
    '提示',
    ['--color-success'],
    'success',
    '成功、完成和已保存状态的文字图标。',
    ['#1f6a54', '#a4e0c6'],
    true,
    'notice',
  ),
  define(
    'successSoft',
    '成功底色',
    '提示',
    ['--color-success-soft'],
    'success',
    '成功、完成和已保存状态的背景。',
    ['#e3f6ee', '#224b3c'],
    true,
    'notice',
  ),
  define(
    'warning',
    '警告图标',
    '提示',
    ['--color-warning'],
    'warning',
    '待检查、冲突等警告强调色。',
    ['#9a6a24', '#e2bd78'],
    true,
    'notice',
  ),
  define(
    'warningSoft',
    '警告底色',
    '提示',
    ['--color-warning-soft'],
    'warning',
    '警告和待检查提示的背景。',
    ['#f7efdf', '#4a4032'],
    true,
    'notice',
  ),
  define(
    'warningInk',
    '警告文字',
    '提示',
    ['--color-warning-ink'],
    'warning',
    '警告提示的文字。',
    ['#765018', '#f3dba8'],
    true,
    'notice',
  ),
  define(
    'warningLine',
    '警告边框',
    '提示',
    ['--color-warning-line'],
    'warning',
    '警告提示的描边。',
    ['#9a6a24', '#e2bd78', 42, 38],
    true,
    'notice',
  ),
  define(
    'shadow',
    '阴影颜色',
    '边框',
    ['--color-shadow'],
    'card',
    '面板、弹窗、按钮、控件与看图工具的公共阴影颜色。',
    ['#265568', '#040f14', 16, 26],
    true,
  ),
  define(
    'viewer',
    '看图背景',
    '看图',
    ['--viewer-background'],
    'viewer-scene',
    '图片查看器背景，不修改图片内容。',
    ['#111713', '#111713'],
    true,
    'viewer',
  ),
  define(
    'viewerText',
    '看图文字',
    '看图',
    ['--viewer-color', '--viewer-control-color'],
    'viewer-scene',
    '图片查看器文字、计数与公共图标。',
    ['#ffffff', '#ffffff'],
    true,
    'viewer',
  ),
  define(
    'viewerControl',
    '看图按钮',
    '看图',
    ['--viewer-control-background'],
    'viewer-save',
    '图片查看器的保存、关闭等工具按钮底色。',
    ['#080c0a', '#080c0a', 70, 70],
    false,
    'viewer',
  ),
  define(
    'viewerBorder',
    '看图边框',
    '看图',
    ['--viewer-control-border'],
    'viewer-save',
    '图片查看器工具按钮的边框。',
    ['#ffffff', '#ffffff', 38, 38],
    true,
    'viewer',
  ),
]
for (const s of specs)
  for (const theme of ['light', 'dark'])
    if (!defaults[theme][s.id]) {
      const dark = theme === 'dark',
        seed = s.seeds
      defaults[theme][s.id] = fill('solid', [
        color(seed[dark ? 1 : 0], 0, seed[dark ? 3 : 2] ?? 100),
      ])
    }
const shapeSpecs = [
  ['shape', '全部按钮', 'action'],
  ['iconShape', '图标按钮', 'icon'],
  ['filterShape', '筛选按钮', 'filter'],
  ['controlShape', '输入框', 'demo-field'],
  ['cardShape', '卡片', 'card'],
  ['dialogShape', '弹窗', 'demo-dialog'],
].map(([id, name, preview]) => ({
  id,
  name,
  preview,
  group: '形状',
  shape: true,
  scope: id === 'shape' ? '统一操作、图标与筛选按钮的圆角。' : `调整${name}圆角，浅深色共用。`,
  scene: ['controlShape', 'dialogShape'].includes(id) ? 'dialog' : 'library',
}))
const allSpecs = [...specs, ...shapeSpecs],
  byId = Object.fromEntries(allSpecs.map((s) => [s.id, s])),
  names = Object.fromEntries(allSpecs.map((s) => [s.id, s.name])),
  impact = Object.fromEntries(allSpecs.map((s) => [s.id, s.scope]))
const shapeDefaults = {
  iconShape: null,
  filterShape: null,
  controlShape: 8,
  cardShape: 12,
  dialogShape: 12,
}
function rgba(c, scale = 1) {
  return `rgba(${parseInt(c.hex.slice(1, 3), 16)},${parseInt(c.hex.slice(3, 5), 16)},${parseInt(c.hex.slice(5, 7), 16)},${(c.alpha / 100) * scale})`
}
function stops(list, scale = 1) {
  return [...list]
    .sort((a, b) => a.pos - b.pos)
    .map((c) => `${rgba(c, scale)} ${c.pos}%`)
    .join(',')
}
function paint(f) {
  if (f.type === 'solid') return rgba(f.stops[0])
  const base = `linear-gradient(${f.angle}deg,${stops(f.stops)})`
  return f.type === 'mix'
    ? `radial-gradient(ellipse at 85% 10%,${stops(f.overlay, f.strength / 100)}),${base}`
    : base
}
function compilePaletteCss(state) {
  const block = (theme, selector) => {
    const v = state.values[theme],
      lines = []
    for (const s of specs)
      for (const variable of s.vars)
        lines.push(`  ${variable}: ${s.flat ? rgba(v[s.id].stops[0]) : paint(v[s.id])};`)
    lines.push(`  --color-canvas: ${rgba(v.canvas.stops[0])};`)
    for (const name of [
      'glass-shadow',
      'control-shadow',
      'dialog-shadow',
      'button-shadow',
      'button-primary-shadow',
      'button-hover-shadow',
      'selection-shadow',
      'viewer-control-shadow',
    ])
      lines.push(`  --${name}: 0 4px 12px var(--color-shadow);`)
    lines.push('  --control-focus-shadow: 0 0 0 2px var(--color-accent-soft);')
    return `${selector} {\n${lines.join('\n')}\n}`
  }
  const r = state.radii,
    shapes = `:root {\n  --button-radius: ${state.radius}px;\n  --control-radius: ${r.controlShape}px;\n  --radius-control: ${r.controlShape}px;\n  --radius-card: ${r.cardShape}px;\n  --radius-panel: ${r.cardShape}px;\n  --glass-radius-panel: ${r.cardShape}px;\n  --glass-radius-control: ${r.controlShape}px;\n  --dialog-radius: ${r.dialogShape}px;\n}`
  const overrides = []
  if (r.iconShape !== null)
    overrides.push(`:root .icon-button { border-radius: ${r.iconShape}px; }`)
  if (r.filterShape !== null)
    overrides.push(
      `:root :is(.category-nav, .tag-nav, .nav-item, .resource-card__category, .resource-card__tag, .export-chip) { border-radius: ${r.filterShape}px; }`,
    )
  return `/* SRL 原生公共界面配色；图片、系统界面和自定义 Vue 不在范围内。 */\n${shapes}\n\n${block('light', ":root:not([data-theme='dark'])")}\n\n${block('dark', ":root[data-theme='dark']")}\n\n${overrides.join('\n')}\n`
}
/** Keep author layout verbatim; update only palette-owned declarations that actually changed. */
function mergePaletteCss(source, state, baseline) {
  const before = postcss.parse(compilePaletteCss(baseline))
  const after = postcss.parse(compilePaletteCss(state))
  const declarations = (rule) => new Map(rule.nodes.map((node) => [node.prop, node.value]))
  const previous = new Map(
    before.nodes
      .filter((node) => node.type === 'rule')
      .map((rule) => [rule.selector, declarations(rule)]),
  )
  const changes = postcss.root()
  after.walkRules((rule) => {
    const old = previous.get(rule.selector)
    const changed = rule.nodes.filter((decl) => old?.get(decl.prop) !== decl.value)
    if (changed.length) {
      const selectors =
        rule.selector === ':root'
          ? [":root:not([data-theme='dark'])", ":root[data-theme='dark']"]
          : [rule.selector]
      for (const selector of selectors)
        changes.append(rule.clone({ selector, nodes: changed.map((decl) => decl.clone()) }))
    }
    previous.delete(rule.selector)
  })
  for (const [selector] of previous) {
    if (selector.startsWith(':root ')) {
      const rule = postcss.rule({ selector })
      rule.append(postcss.decl({ prop: 'border-radius', value: 'var(--button-radius)' }))
      changes.append(rule)
    }
  }
  if (!changes.nodes.length) return source
  const startText = 'SRL 调色开始',
    endText = 'SRL 调色结束'
  try {
    const sheet = postcss.parse(source)
    const start = sheet.nodes.findIndex(
      (node) => node.type === 'comment' && node.text === startText,
    )
    const end = sheet.nodes.findIndex(
      (node, index) => index > start && node.type === 'comment' && node.text === endText,
    )
    // Only our bounded block may be rewritten; all author rules stay in place.
    const owned = start >= 0 && end > start ? sheet.nodes.slice(start + 1, end) : []
    const merged = postcss.root({ nodes: owned.map((node) => node.clone()) })
    changes.walkRules((rule) => {
      const existing = merged.nodes.find(
        (node) => node.type === 'rule' && node.selector === rule.selector,
      )
      if (!existing) merged.append(rule.clone())
      else
        for (const decl of rule.nodes) {
          const current = existing.nodes.find(
            (node) => node.type === 'decl' && node.prop === decl.prop,
          )
          if (current) current.value = decl.value
          else existing.append(decl.clone())
        }
    })
    // Respect an author's important public variable while allowing the requested color change.
    merged.walkRules((rule) =>
      rule.walkDecls((decl) => {
        sheet.walkRules((original) => {
          if (original.parent.type !== 'root') return
          const selector = original.selector.replace(/"/g, "'")
          if (selector !== rule.selector && selector !== ':root') return
          original.walkDecls(decl.prop, (value) => {
            if (value.important) decl.important = true
          })
        })
      }),
    )
    const nodes = [
      postcss.comment({ text: startText }),
      ...merged.nodes,
      postcss.comment({ text: endText }),
    ]
    if (start >= 0 && end > start) {
      const anchor = sheet.nodes[start],
        closing = sheet.nodes[end]
      for (const node of nodes) sheet.insertBefore(anchor, node)
      for (const node of [anchor, ...owned, closing]) node.remove()
    } else for (const node of nodes) sheet.append(node)
    return sheet.toString()
  } catch {
    // Unsupported author syntax remains untouched and can still be edited as CSS.
    return `${source}\n/* ${startText} */\n${changes.toString()}\n/* ${endText} */\n`
  }
}
const packColor = (c) => [c.hex, c.pos, c.alpha],
  unpackColor = (a) => color(a[0], a[1], a[2])
function packPaletteDesign(state) {
  const values = {}
  for (const t of ['light', 'dark']) {
    values[t] = {}
    for (const s of specs) {
      const f = state.values[t][s.id]
      if (JSON.stringify(f) === JSON.stringify(defaults[t][s.id])) continue
      values[t][s.id] = s.flat
        ? [f.stops[0].hex, f.stops[0].alpha]
        : [
            ['solid', 'gradient', 'mix'].indexOf(f.type),
            f.stops.map(packColor),
            f.angle,
            f.strength,
            f.overlay.map(packColor),
          ]
    }
  }
  return { values, radius: state.radius, radii: { ...state.radii } }
}
function unpackPaletteDesign(design) {
  const values = globalThis.structuredClone(defaults)
  for (const t of ['light', 'dark'])
    for (const [id, a] of Object.entries(design.values?.[t] || {})) {
      const s = byId[id]
      if (!s || s.shape || !Array.isArray(a)) continue
      values[t][id] = s.flat
        ? fill('solid', [color(a[0], 0, a[1])])
        : {
            type: ['solid', 'gradient', 'mix'][a[0]],
            stops: a[1].map(unpackColor),
            angle: a[2],
            strength: a[3],
            overlay: a[4].map(unpackColor),
          }
    }
  return { values, radius: design.radius ?? 8, radii: { ...shapeDefaults, ...design.radii } }
}
function rgb(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
}
function hexFromRgb(values) {
  return '#' + values.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
}
function hexToHsv(hex, fallback = 0) {
  const [r, g, b] = rgb(hex).map((v) => v / 255),
    max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    d = max - min
  let h = fallback
  if (d) {
    h = max === r ? (g - b) / d : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    h = (((h * 60) % 360) + 360) % 360
  }
  return { h, s: max ? d / max : 0, v: max }
}
function hsvToHex({ h, s, v }) {
  const c = v * s,
    x = c * (1 - Math.abs(((h / 60) % 2) - 1)),
    m = v - c,
    sector = Math.floor((h % 360) / 60),
    parts = [
      [c, x, 0],
      [x, c, 0],
      [0, c, x],
      [0, x, c],
      [x, 0, c],
      [c, 0, x],
    ][sector]
  return hexFromRgb(parts.map((n) => (n + m) * 255))
}
function validateDesign(design) {
  for (const t of ['light', 'dark'])
    for (const s of specs) {
      const f = design.values[t][s.id]
      if (
        !['solid', 'gradient', 'mix'].includes(f.type) ||
        !f.stops?.length ||
        f.stops.length > 6 ||
        f.overlay?.length !== 2 ||
        !Number.isFinite(f.angle) ||
        !Number.isFinite(f.strength)
      )
        throw Error('Invalid fill')
      for (const c of [...f.stops, ...f.overlay])
        if (
          !/^#[0-9a-f]{6}$/i.test(c.hex) ||
          !Number.isFinite(c.pos) ||
          !Number.isFinite(c.alpha) ||
          c.alpha < 0 ||
          c.alpha > 100
        )
          throw Error('Invalid color')
    }
  for (const value of [design.radius, ...Object.values(design.radii)])
    if (value !== null && (!Number.isFinite(value) || (value !== 999 && (value < 0 || value > 32))))
      throw Error('Invalid radius')
  return design
}

function readColor(value) {
  value = value.trim().toLowerCase()
  const named = { white: '#ffffff', black: '#000000', transparent: '#00000000' }
  value = named[value] ?? value
  const hex = value.match(/^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i)
  if (hex) {
    const raw = hex[1].length <= 4 ? [...hex[1]].map((c) => c + c).join('') : hex[1]
    return color(
      '#' + raw.slice(0, 6).toLowerCase(),
      0,
      raw.length === 8 ? parseInt(raw.slice(6), 16) / 2.55 : 100,
    )
  }
  const rgb = value.match(/^rgba?\(([^()]*)\)$/)
  if (!rgb) return
  const parts = rgb[1].trim().split(/[\s,/]+/)
  if (parts.length < 3 || parts.length > 4 || parts.some((v) => !/^[\d.]+%?$/.test(v))) return
  const channels = parts.slice(0, 3).map((v) => parseFloat(v) * (v.endsWith('%') ? 2.55 : 1))
  const alpha = parts[3] ?? '1'
  const opacity = parseFloat(alpha) * (alpha.endsWith('%') ? 1 : 100)
  if (
    channels.some((v) => !Number.isFinite(v) || v > 255.0001) ||
    !Number.isFinite(opacity) ||
    opacity > 100
  )
    return
  return color(hexFromRgb(channels), 0, opacity)
}

function splitCssList(value) {
  let depth = 0,
    start = 0
  const parts = []
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '(') depth++
    else if (value[i] === ')') depth--
    else if (value[i] === ',' && depth === 0) {
      parts.push(value.slice(start, i).trim())
      start = i + 1
    }
  }
  parts.push(value.slice(start).trim())
  return parts
}
function readFill(value, flat) {
  const plain = readColor(value)
  if (plain) return { ...fill('solid', [plain]) }
  if (flat) return
  const linear = value.lastIndexOf('linear-gradient(')
  if (linear < 0) return
  const args = splitCssList(value.slice(linear + 'linear-gradient('.length, -1))
  const angle = args[0].match(/^(-?[\d.]+)deg$/)
  const directions = { 'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270 }
  let degrees = 180
  if (angle || args[0] in directions) degrees = angle ? +angle[1] : directions[args[0]]
  if (angle || args[0] in directions) args.shift()
  const stops = args.map((part) => {
    const positioned = part.match(/^(.*?)\s+([\d.]+)%$/)
    const c = readColor(positioned ? positioned[1] : part)
    return c && { ...c, pos: positioned ? +positioned[2] : null }
  })
  if (stops.length < 2 || stops.length > 6 || stops.some((c) => !c)) return
  if (stops[0].pos === null) stops[0].pos = 0
  if (stops.at(-1).pos === null) stops.at(-1).pos = 100
  for (let i = 0; i < stops.length - 1; i++) {
    if (stops[i + 1].pos !== null) continue
    let end = i + 1
    while (stops[end].pos === null) end++
    for (let j = i + 1; j < end; j++)
      stops[j].pos = stops[i].pos + ((stops[end].pos - stops[i].pos) * (j - i)) / (end - i)
  }
  const parseStops = (text) =>
    [...text.matchAll(/(rgba?\([^)]*\)|#[\da-f]{3,8})\s+([\d.]+)%/gi)].map((m) => {
      const c = readColor(m[1])
      return c && { ...c, pos: +m[2] }
    })
  const result = fill('gradient', stops)
  result.angle = degrees
  if (linear > 0 && value.startsWith('radial-gradient(')) {
    const overlay = parseStops(value.slice(0, linear))
    if (overlay.length !== 2 || overlay.some((c) => !c)) return
    result.type = 'mix'
    result.overlay = overlay
    result.strength = 100
  }
  return result
}

/** Read supported public declarations once on entry; arbitrary CSS remains in its original preset. */
function readPaletteCss(css, shapeTheme = 'light', report) {
  const result = {
    values: globalThis.structuredClone(defaults),
    radius: 8,
    radii: { ...shapeDefaults },
  }
  try {
    const sheet = postcss.parse(css),
      variables = { light: new Map(), dark: new Map() }
    const themesFor = (selector) =>
      selector === ':root' ? ['light', 'dark'] : selector.includes(':not(') ? ['light'] : ['dark']
    const eligible = (rule) =>
      rule.parent.type === 'root' &&
      [
        ':root',
        ":root:not([data-theme='dark'])",
        ":root[data-theme='dark']",
        ":root:where([data-theme='dark'])",
      ].includes(rule.selector.replace(/"/g, "'"))
    sheet.walkRules((rule) => {
      if (!eligible(rule)) return
      for (const theme of themesFor(rule.selector))
        rule.walkDecls((decl) => {
          const old = variables[theme].get(decl.prop)
          if (!old?.important || decl.important) variables[theme].set(decl.prop, decl)
        })
    })
    const resolve = (value, vars, seen = new Set()) =>
      value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (original, name, fallback) => {
        if (seen.has(name)) return original
        const found = vars.get(name)?.value ?? fallback
        return found === undefined ? original : resolve(found, vars, new Set([...seen, name]))
      })
    sheet.walkRules((rule) => {
      if (rule.parent.type !== 'root') return
      const selector = rule.selector.replace(/"/g, "'")
      const radiusValue = (v) => {
        const m = v.match(/^(\d+(?:\.\d+)?|\.\d+)(px|rem|em)?$/)
        if (!m || (!m[2] && +m[1] !== 0)) return
        const n = +m[1] * (m[2] === 'rem' || m[2] === 'em' ? 16 : 1)
        return n <= 32 || n === 999 ? n : undefined
      }
      if (selector === ':root .icon-button' || selector.startsWith(':root :is(.category-nav,')) {
        rule.walkDecls('border-radius', (decl) => {
          const value = radiusValue(decl.value)
          if (value !== undefined)
            result.radii[selector.includes('icon-button') ? 'iconShape' : 'filterShape'] = value
          if (value !== undefined) report?.shapes.add(selector)
        })
        return
      }
      if (
        ![
          ':root',
          ":root:not([data-theme='dark'])",
          ":root[data-theme='dark']",
          ":root:where([data-theme='dark'])",
        ].includes(selector)
      )
        return
      const themes = themesFor(selector)
      rule.walkDecls((decl) => {
        const spec = specs.find(
          (s) =>
            s.vars.includes(decl.prop) || (s.id === 'canvas' && decl.prop === '--color-canvas'),
        )
        if (spec) {
          // The scalar fallback must not replace a gradient already read from --page-background.
          for (const theme of themes) {
            const vars = variables[theme]
            if (vars.get(decl.prop) !== decl) continue
            if (
              decl.prop === '--color-canvas' &&
              readFill(resolve(vars.get('--page-background')?.value ?? '', vars), false)
            )
              continue
            const f = readFill(resolve(decl.value, vars), spec.flat)
            if (f) {
              result.values[theme][spec.id] = globalThis.structuredClone(f)
              report?.colors.add(spec.id)
            } else report?.unsupported.add(spec.name)
          }
        }
        const key = {
          '--control-radius': 'controlShape',
          '--radius-control': 'controlShape',
          '--radius-card': 'cardShape',
          '--dialog-radius': 'dialogShape',
        }[decl.prop]
        const radius = radiusValue(resolve(decl.value, variables[shapeTheme]))
        if (
          radius !== undefined &&
          themes.includes(shapeTheme) &&
          variables[shapeTheme].get(decl.prop) === decl
        ) {
          if (key) result.radii[key] = radius
          if (decl.prop === '--button-radius') result.radius = radius
          if (key || decl.prop === '--button-radius') report?.shapes.add(key ?? 'shape')
        }
      })
    })
  } catch {
    if (report) throw new Error('CSS 格式不完整，未导入；请检查括号和声明')
    // A hand-written stylesheet may contain syntax this palette cannot represent.
  }
  return result
}
function inspectPaletteCss(css, theme = 'light') {
  const report = { colors: new Set(), shapes: new Set(), unsupported: new Set() }
  const design = readPaletteCss(css, theme, report)
  return {
    design,
    colors: report.colors.size,
    shapes: report.shapes.size,
    unsupported: [...report.unsupported],
  }
}

export {
  readPaletteCss,
  inspectPaletteCss,
  color,
  defaults,
  specs,
  shapeSpecs,
  byId,
  names,
  impact,
  shapeDefaults,
  rgba,
  paint,
  compilePaletteCss,
  mergePaletteCss,
  packPaletteDesign,
  unpackPaletteDesign,
  validateDesign,
  rgb,
  hexFromRgb,
  hexToHsv,
  hsvToHex,
}
