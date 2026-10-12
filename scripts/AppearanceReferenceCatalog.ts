import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, extname, relative, resolve } from 'node:path'
import { parse as parseVue } from '@vue/compiler-sfc'
import ts from 'typescript'
import type { Plugin } from 'vite'
import { entries } from './OfficialAppPackages.js'
import type { ReferenceSource, ReferenceCatalog } from '../src/types/AppearanceReference.js'
import { FEATURE_APP_REGISTRY } from '../src/core/FeatureAppRegistry.js'
import { createVueReference } from './AppearanceVueReference.js'
import { parseAppearanceCss } from '../src/core/AppearanceCssReference.js'

/** Source-only UI graph; no installed packages, archives, database or user CSS. */
export function createAppearanceReferenceCatalog(
  root: string,
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
  watch: (path: string) => void = () => {},
): ReferenceCatalog {
  const sources = new Map<string, ReferenceSource>()
  const imports = new Map<string, string[]>()
  const descriptors = new Map<string, ReturnType<typeof parseVue>['descriptor']>()
  const resolvedImports = new Map<string, string | undefined>()
  const input = new Map<string, string>()
  const readSource = (path: string) => {
    const absolute = resolve(root, path)
    if (!input.has(absolute)) {
      input.set(absolute, read(absolute))
      watch(absolute)
    }
    return input.get(absolute)!
  }
  const roots: Record<string, string> = Object.fromEntries(
    Object.entries(entries).map(([id, file]) => [id, `src/components/${file}`]),
  )
  const loader = readSource('src/core/FeatureAppLoaders.ts')
  for (const match of loader.matchAll(/case '([^']+)':\s*return \(\) => import\('([^']+)'\)/gu))
    roots[match[1]!] = relative(root, resolve(root, 'src/core', match[2]!))
  roots.folders = 'src/components/FolderLibraryView.vue'
  Object.assign(roots, {
    library: 'src/App.vue',
    shell: 'src/Styles.css',
    details: 'src/components/ResourceOrganizer.vue',
    features: 'src/styles/FeatureDesktop.css',
    settings: 'src/components/LayoutSettingsPanel.vue',
    global: 'src/FeatureStyles.css',
  })
  // These entries are existing outer-page owners; fail instead of silently publishing empty docs.
  const resolveSource = (from: string, specifier: string) => {
    const key = `${from}\0${specifier}`
    if (resolvedImports.has(key)) return resolvedImports.get(key)
    const base = resolve(dirname(from), specifier.split('?')[0]!)
    const result = [
      base,
      base.replace(/\.js$/u, '.ts'),
      `${base}.ts`,
      `${base}.vue`,
      `${base}.css`,
    ].find(existsSync)
    resolvedImports.set(key, result)
    return result
  }
  function collect(entry: string, visited = new Set<string>()): ReferenceSource[] {
    const file = resolve(root, entry)
    if (visited.has(file)) return []
    visited.add(file)
    if (!input.has(file) && !existsSync(file)) throw new Error(`接口教程缺少源码入口：${entry}`)
    const path = relative(root, file).replaceAll('\\', '/')
    if (!/^(src|extensions)\//u.test(path)) return []
    const code = readSource(file)
    if (extname(file) === '.vue' && !descriptors.has(file))
      descriptors.set(file, parseVue(code, { filename: file }).descriptor)
    const descriptor = descriptors.get(file)
    const found: ReferenceSource[] = []
    const css = extname(file) === '.css'
    const styles = css
      ? [{ content: code, line: 1 }]
      : extname(file) === '.vue'
        ? descriptor!.styles.map((style) => ({
            content: style.content,
            line: style.loc.start.line,
          }))
        : []
    for (const style of styles) {
      const key = `${path}:${style.line}`
      let source = sources.get(key)
      if (!source) {
        const cssImports: string[] = []
        source = parseAppearanceCss(
          style.content,
          path,
          style.line,
          css ? (specifier) => cssImports.push(specifier) : undefined,
        )
        if (css) imports.set(file, cssImports)
        sources.set(key, source)
      }
      if (source.rules.length) found.push(source)
    }
    const specifiers = imports.get(file) ?? []
    if (!css && !imports.has(file)) {
      const script = descriptor
        ? [descriptor.script?.content, descriptor.scriptSetup?.content].filter(Boolean).join('\n')
        : code
      // TypeScript's lexical dependency scanner includes exports and dynamic imports,
      // without allocating a full syntax tree for every unrelated service body.
      for (const dependency of ts.preProcessFile(script, true, true).importedFiles) {
        const start = Math.max(
          script.lastIndexOf('import', dependency.pos),
          script.lastIndexOf('export', dependency.pos),
        )
        if (/^(?:import|export)\s+type\b/u.test(script.slice(start, dependency.pos))) continue
        specifiers.push(dependency.fileName)
      }
      if (descriptor?.script?.src) specifiers.push(descriptor.script.src)
    }
    if (descriptor && !imports.has(file))
      specifiers.push(...descriptor.styles.flatMap((style) => (style.src ? [style.src] : [])))
    imports.set(file, specifiers)
    for (const specifier of specifiers) {
      if (!specifier.startsWith('.')) continue
      const child = resolveSource(file, specifier)
      if (!child) {
        if (/\.(?:vue|css)(?:\?|$)/u.test(specifier))
          throw new Error(`接口教程缺少样式依赖：${path} → ${specifier}`)
        continue
      }
      const childPath = relative(root, child).replaceAll('\\', '/')
      // Follow local modules too: loaders and services can import lazily loaded UI/CSS.
      if (/\.(?:vue|css|ts|js)$/u.test(child) && !child.endsWith('.d.ts'))
        found.push(...collect(childPath, visited))
    }
    return found
  }
  const common = collect('src/styles/Foundation.css')
  const scopes: Record<string, string[]> = {}
  for (const [id, entry] of Object.entries(roots))
    scopes[id] = [...new Set([...common, ...collect(entry)].map((source) => source.path))]
  scopes.global = [
    ...new Set([...scopes.global!, ...collect('src/Styles.css').map((source) => source.path)]),
  ]
  for (const app of FEATURE_APP_REGISTRY.filter((app) => app.visible))
    if (!roots[app.id]) throw new Error(`接口手册缺少 APP 源码入口：${app.id}`)
  const starter = ts.createSourceFile(
    'UiViewStarter.ts',
    readSource('src/core/UiViewStarter.ts'),
    ts.ScriptTarget.Latest,
    true,
  )
  let helper: string | undefined
  const findHelper = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(starter) === 'UI_VIEW_HELPER' &&
      node.initializer &&
      ts.isNoSubstitutionTemplateLiteral(node.initializer)
    )
      helper = node.initializer.text
    ts.forEachChild(node, findHelper)
  }
  findHelper(starter)
  if (!helper) throw new Error('接口手册无法读取 Page.js 实现')
  const vue = createVueReference(
    helper,
    readSource('src/services/UiViewRuntime.ts'),
    readSource('src/types/UiCustomization.ts'),
  )
  const version = (JSON.parse(readSource('build-info.json')) as { buildId: string }).buildId
  readSource('src/core/FeatureAppRegistry.ts')
  // Content identity also changes for logic-only interface updates; never reuse yesterday's docs.
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify(
        [...input]
          .map(([file, content]) => [
            relative(root, file).replaceAll('\\', '/'),
            content.replaceAll('\r\n', '\n'),
          ])
          .sort(([left], [right]) => left!.localeCompare(right!)),
      ),
    )
    .digest('hex')
  return {
    sources: [...sources.values()].filter((source) => source.rules.length),
    scopes,
    vue,
    version,
    fingerprint,
  }
}

export function appearanceReferencePlugin(): Plugin {
  const id = 'virtual:srl-appearance-reference'
  const inputs = new Set<string>()
  return {
    name: 'srl-appearance-reference',
    resolveId: (value) => (value === id ? `\0${id}` : undefined),
    load(value) {
      if (value !== `\0${id}`) return
      inputs.clear()
      return `export default ${JSON.stringify(
        createAppearanceReferenceCatalog(process.cwd(), undefined, (path) => {
          inputs.add(path.replaceAll('\\', '/'))
          this.addWatchFile(path)
        }),
      )}`
    },
    handleHotUpdate(context) {
      // A changed source import graph must be recollected, including newly added styles.
      const module = context.server.moduleGraph.getModuleById(`\0${id}`)
      if (!module || !inputs.has(context.file.replaceAll('\\', '/'))) return
      context.server.moduleGraph.invalidateModule(module)
      return [...context.modules, module]
    },
  }
}
