import type { BuildOptions, BuildResult, Loader, Message, OnLoadResult, Plugin } from 'esbuild-wasm'
import esbuildWasmUrl from 'esbuild-wasm/esbuild.wasm?url'

export const FRONTEND_WORKSHOP_BROWSER_SOURCE_MAX_FILES = 256
export const FRONTEND_WORKSHOP_BROWSER_SOURCE_MAX_FILE_BYTES = 5 * 1024 * 1024
export const FRONTEND_WORKSHOP_BROWSER_SOURCE_MAX_TOTAL_BYTES = 20 * 1024 * 1024

export type FrontendWorkshopBrowserSourceCapability =
  'browser-compatible' | 'browser-compile' | 'host-bound'

export interface FrontendWorkshopBrowserSourceFile {
  path: string
  contents: string | Uint8Array
}

export interface FrontendWorkshopBrowserSourceProject {
  entryPath: string
  files: readonly FrontendWorkshopBrowserSourceFile[]
}

export interface FrontendWorkshopBrowserSourceCompileDiagnostic {
  code:
    | 'host-bound'
    | 'invalid-project'
    | 'missing-entry'
    | 'missing-import'
    | 'unsupported-package'
    | 'compile-error'
  message: string
  path?: string
  line?: number
  column?: number
}

export interface FrontendWorkshopBrowserSourceCompileResult {
  capability: Exclude<FrontendWorkshopBrowserSourceCapability, 'host-bound'>
  entryPath: string
  authorSource: string
  diagnostics: readonly FrontendWorkshopBrowserSourceCompileDiagnostic[]
}

export class FrontendWorkshopBrowserSourceCompileError extends Error {
  readonly diagnostics: readonly FrontendWorkshopBrowserSourceCompileDiagnostic[]

  constructor(diagnostics: readonly FrontendWorkshopBrowserSourceCompileDiagnostic[]) {
    super(diagnostics.map((diagnostic) => diagnostic.message).join('\n'))
    this.name = 'FrontendWorkshopBrowserSourceCompileError'
    this.diagnostics = diagnostics.map((diagnostic) => ({ ...diagnostic }))
  }
}

export interface FrontendWorkshopBrowserBuildEngine {
  build(options: BuildOptions): Promise<BuildResult>
}

interface NormalizedProject {
  entryPath: string
  files: Map<string, string | Uint8Array>
}

interface CompiledEntry {
  javascript: string
  css: string
}

const TEXT_EXTENSIONS = new Set([
  'css',
  'htm',
  'html',
  'js',
  'jsx',
  'json',
  'mjs',
  'svg',
  'ts',
  'tsx',
  'txt',
  'vue',
])
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.json', '.css', '.vue']
const HOST_BOUND_IMPORT =
  /^(?:node:)?(?:assert|buffer|child_process|cluster|crypto|dgram|dns|events|fs|http|https|module|net|os|path|perf_hooks|process|readline|stream|string_decoder|timers|tls|tty|url|util|v8|vm|worker_threads|zlib)(?:\/|$)/u
const HOST_BOUND_SOURCE =
  /\b(?:process\.versions\.node|__dirname|__filename|Bun\.|Deno\.|next\/server|electron|prisma|mongoose|createServer\s*\()/u

let browserEnginePromise: Promise<FrontendWorkshopBrowserBuildEngine> | undefined

async function defaultBrowserEngine(): Promise<FrontendWorkshopBrowserBuildEngine> {
  browserEnginePromise ??= (async () => {
    const engine = await import('esbuild-wasm')
    if (typeof window !== 'undefined') await engine.initialize({ wasmURL: esbuildWasmUrl })
    return engine
  })()
  return browserEnginePromise
}

function pathExtension(path: string): string {
  return path.split('.').at(-1)?.toLowerCase() ?? ''
}

function normalizePath(path: string, label: string): string {
  if (typeof path !== 'string' || !path.trim() || path.includes('\0')) {
    throw new FrontendWorkshopBrowserSourceCompileError([
      { code: 'invalid-project', message: `${label}路径非法` },
    ])
  }
  const normalized: string[] = []
  for (const part of path.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!normalized.length) {
        throw new FrontendWorkshopBrowserSourceCompileError([
          { code: 'invalid-project', message: `${label}路径超出项目范围：${path}` },
        ])
      }
      normalized.pop()
      continue
    }
    normalized.push(part)
  }
  if (!normalized.length || /^[a-z][a-z0-9+.-]*:/iu.test(normalized[0]!)) {
    throw new FrontendWorkshopBrowserSourceCompileError([
      { code: 'invalid-project', message: `${label}路径非法：${path}` },
    ])
  }
  return normalized.join('/')
}

function byteLength(contents: string | Uint8Array): number {
  return typeof contents === 'string'
    ? new TextEncoder().encode(contents).byteLength
    : contents.byteLength
}

function normalizeProject(project: FrontendWorkshopBrowserSourceProject): NormalizedProject {
  if (!project || typeof project !== 'object' || !Array.isArray(project.files)) {
    throw new FrontendWorkshopBrowserSourceCompileError([
      { code: 'invalid-project', message: 'Browser Source 项目非法' },
    ])
  }
  if (!project.files.length || project.files.length > FRONTEND_WORKSHOP_BROWSER_SOURCE_MAX_FILES) {
    throw new FrontendWorkshopBrowserSourceCompileError([
      { code: 'invalid-project', message: 'Browser Source 文件数量为空或超出限制' },
    ])
  }
  const files = new Map<string, string | Uint8Array>()
  let totalBytes = 0
  for (const file of project.files) {
    const path = normalizePath(file.path, '文件')
    if (files.has(path)) {
      throw new FrontendWorkshopBrowserSourceCompileError([
        { code: 'invalid-project', message: `Browser Source 包含重复文件：${path}`, path },
      ])
    }
    if (typeof file.contents !== 'string' && !(file.contents instanceof Uint8Array)) {
      throw new FrontendWorkshopBrowserSourceCompileError([
        { code: 'invalid-project', message: `Browser Source 文件内容非法：${path}`, path },
      ])
    }
    const size = byteLength(file.contents)
    if (size > FRONTEND_WORKSHOP_BROWSER_SOURCE_MAX_FILE_BYTES) {
      throw new FrontendWorkshopBrowserSourceCompileError([
        { code: 'invalid-project', message: `Browser Source 单文件超出限制：${path}`, path },
      ])
    }
    totalBytes += size
    if (totalBytes > FRONTEND_WORKSHOP_BROWSER_SOURCE_MAX_TOTAL_BYTES) {
      throw new FrontendWorkshopBrowserSourceCompileError([
        { code: 'invalid-project', message: 'Browser Source 总大小超出限制' },
      ])
    }
    files.set(path, file.contents)
  }
  const entryPath = normalizePath(project.entryPath, '入口')
  if (!files.has(entryPath)) {
    throw new FrontendWorkshopBrowserSourceCompileError([
      {
        code: 'missing-entry',
        message: `Browser Source 入口不存在：${entryPath}`,
        path: entryPath,
      },
    ])
  }
  return { entryPath, files }
}

function readText(files: Map<string, string | Uint8Array>, path: string): string {
  const value = files.get(path)
  if (value === undefined) {
    throw new FrontendWorkshopBrowserSourceCompileError([
      { code: 'missing-import', message: `Browser Source 文件不存在：${path}`, path },
    ])
  }
  if (typeof value === 'string') return value
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value)
  } catch {
    throw new FrontendWorkshopBrowserSourceCompileError([
      { code: 'compile-error', message: `Browser Source 文本不是有效 UTF-8：${path}`, path },
    ])
  }
}

function hostBoundImport(source: string): string | undefined {
  const importPattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/gu
  for (const match of source.matchAll(importPattern)) {
    if (HOST_BOUND_IMPORT.test(match[1]!)) return match[1]
  }
  return undefined
}

export function classifyFrontendWorkshopBrowserSourceProject(
  project: FrontendWorkshopBrowserSourceProject,
): FrontendWorkshopBrowserSourceCapability {
  const normalized = normalizeProject(project)
  for (const [path] of normalized.files) {
    if (!TEXT_EXTENSIONS.has(pathExtension(path))) continue
    const source = readText(normalized.files, path)
    if (HOST_BOUND_SOURCE.test(source) || hostBoundImport(source)) return 'host-bound'
  }
  const extension = pathExtension(normalized.entryPath)
  if (extension === 'html' || extension === 'htm' || extension === 'svg') {
    const source = readText(normalized.files, normalized.entryPath)
    if (!/<script\b[^>]*\btype\s*=\s*['"]module['"]/iu.test(source)) {
      return 'browser-compatible'
    }
  }
  return 'browser-compile'
}

function assertBrowserBoundary(project: NormalizedProject): void {
  for (const [path] of project.files) {
    if (!TEXT_EXTENSIONS.has(pathExtension(path))) continue
    const source = readText(project.files, path)
    const imported = hostBoundImport(source)
    if (HOST_BOUND_SOURCE.test(source) || imported) {
      throw new FrontendWorkshopBrowserSourceCompileError([
        {
          code: 'host-bound',
          message: imported
            ? `检测到 Host/backend-bound import“${imported}”；Browser Source 不会伪造 Node 或服务端能力`
            : `检测到 Host/backend-bound 源码；Browser Source 不会伪造 Node 或服务端能力`,
          path,
        },
      ])
    }
  }
}

function resolveRelativePath(
  files: Map<string, string | Uint8Array>,
  importer: string,
  specifier: string,
): string | undefined {
  const clean = specifier.split(/[?#]/u, 1)[0]!
  const base = clean.startsWith('/') ? [] : importer.split('/').slice(0, -1)
  for (const segment of clean.replaceAll('\\', '/').split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (!base.length) return undefined
      base.pop()
    } else {
      base.push(segment)
    }
  }
  const candidate = base.join('/')
  const attempts = [candidate, ...SOURCE_EXTENSIONS.map((extension) => `${candidate}${extension}`)]
  for (const extension of SOURCE_EXTENSIONS) attempts.push(`${candidate}/index${extension}`)
  return attempts.find((path) => files.has(path))
}

function loaderFor(path: string): Loader {
  switch (pathExtension(path)) {
    case 'ts':
      return 'ts'
    case 'tsx':
      return 'tsx'
    case 'jsx':
      return 'jsx'
    case 'css':
      return 'css'
    case 'json':
      return 'json'
    case 'txt':
      return 'text'
    case 'js':
    case 'mjs':
      return 'js'
    default:
      return 'dataurl'
  }
}

function replaceVueImports(source: string): string {
  return source
    .replace(/\bimport\s+type\s*\{[^{}]*\}\s*from\s*['"]vue['"]\s*;?/gu, '')
    .replace(/\bimport\s*\{([^{}]*)\}\s*from\s*['"]vue['"]\s*;?/gu, (_match, raw: string) => {
      const entries = raw
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry && !entry.startsWith('type '))
        .map((entry) => entry.replace(/\s+as\s+/u, ': '))
      return entries.length ? `const { ${entries.join(', ')} } = window.Vue;` : ''
    })
    .replace(
      /\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]vue['"]\s*;?/gu,
      'const $1 = window.Vue;',
    )
    .replace(/\bimport\s+([A-Za-z_$][\w$]*)\s+from\s*['"]vue['"]\s*;?/gu, 'const $1 = window.Vue;')
}

async function compileVueSfc(
  path: string,
  source: string,
): Promise<{ code: string; css: string; loader: 'js' | 'ts' | 'tsx' }> {
  const { compileScript, compileStyleAsync, compileTemplate, parse } =
    await import('@vue/compiler-sfc')
  const parsed = parse(source, { filename: path })
  if (parsed.errors.length) {
    throw new FrontendWorkshopBrowserSourceCompileError(
      parsed.errors.map((error) => ({
        code: 'compile-error',
        message: typeof error === 'string' ? error : error.message,
        path,
      })),
    )
  }
  const descriptor = parsed.descriptor
  const id = Array.from(path)
    .reduce((value, character) => (value * 33 + character.charCodeAt(0)) >>> 0, 5381)
    .toString(36)
  let code = 'const __sfc__ = {}'
  let bindings: ReturnType<typeof compileScript>['bindings'] | undefined
  if (descriptor.script || descriptor.scriptSetup) {
    const compiled = compileScript(descriptor, { id, genDefaultAs: '__sfc__' })
    code = compiled.content
    bindings = compiled.bindings
  }
  if (descriptor.template) {
    const template = compileTemplate({
      id,
      filename: path,
      source: descriptor.template.content,
      scoped: descriptor.styles.some((style) => style.scoped),
      compilerOptions: { bindingMetadata: bindings },
    })
    if (template.errors.length) {
      throw new FrontendWorkshopBrowserSourceCompileError(
        template.errors.map((error) => ({
          code: 'compile-error',
          message: typeof error === 'string' ? error : error.message,
          path,
        })),
      )
    }
    code += `\n${template.code.replace(/export\s+function\s+render/u, 'function render')}\n__sfc__.render = render;`
  }
  if (descriptor.styles.some((style) => style.scoped))
    code += `\n__sfc__.__scopeId = 'data-v-${id}';`
  const styles = await Promise.all(
    descriptor.styles.map(async (style) => {
      const result = await compileStyleAsync({
        id: `data-v-${id}`,
        filename: path,
        source: style.content,
        scoped: style.scoped,
        modules: false,
      })
      if (result.errors.length) {
        throw new FrontendWorkshopBrowserSourceCompileError(
          result.errors.map((error) => ({
            code: 'compile-error',
            message: error instanceof Error ? error.message : String(error),
            path,
          })),
        )
      }
      return result.code
    }),
  )
  const scriptLanguage = descriptor.scriptSetup?.lang ?? descriptor.script?.lang
  return {
    code: replaceVueImports(`${code}\nexport default __sfc__;`),
    css: styles.join('\n'),
    loader: scriptLanguage === 'tsx' ? 'tsx' : scriptLanguage === 'ts' ? 'ts' : 'js',
  }
}

function messageDiagnostic(message: Message): FrontendWorkshopBrowserSourceCompileDiagnostic {
  const code = message.text.startsWith('Host/backend-bound import')
    ? 'host-bound'
    : message.text.startsWith('本地 import 不存在')
      ? 'missing-import'
      : message.text.startsWith('未提供 browser package')
        ? 'unsupported-package'
        : 'compile-error'
  return {
    code,
    message: message.text,
    ...(message.location
      ? {
          path: message.location.file,
          line: message.location.line,
          column: message.location.column,
        }
      : {}),
  }
}

function outputText(result: BuildResult, extension: '.js' | '.css'): string {
  return (result.outputFiles ?? [])
    .filter((file) => file.path.toLowerCase().endsWith(extension))
    .map((file) => file.text)
    .join('\n')
}

function escapeInlineScript(source: string): string {
  return source.replace(/<\/script/giu, '<\\/script')
}

function escapeInlineStyle(source: string): string {
  return source.replace(/<\/style/giu, '<\\/style')
}

function mediaType(path: string): string {
  switch (pathExtension(path)) {
    case 'avif':
      return 'image/avif'
    case 'gif':
      return 'image/gif'
    case 'jpeg':
    case 'jpg':
      return 'image/jpeg'
    case 'png':
      return 'image/png'
    case 'svg':
      return 'image/svg+xml'
    case 'webp':
      return 'image/webp'
    case 'woff':
      return 'font/woff'
    case 'woff2':
      return 'font/woff2'
    case 'mp3':
      return 'audio/mpeg'
    case 'mp4':
      return 'video/mp4'
    default:
      return 'application/octet-stream'
  }
}

function dataUrl(path: string, contents: string | Uint8Array): string {
  const bytes =
    typeof contents === 'string' ? new TextEncoder().encode(contents) : new Uint8Array(contents)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `data:${mediaType(path)};base64,${btoa(binary)}`
}

function selectEntryOutput(result: BuildResult): CompiledEntry {
  return { javascript: outputText(result, '.js'), css: outputText(result, '.css') }
}

function inlineCompiledEntry(output: CompiledEntry): string {
  return [
    output.css ? `<style>${escapeInlineStyle(output.css)}</style>` : '',
    output.javascript ? `<script>${escapeInlineScript(output.javascript)}</script>` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

function browserInputPaths(files: readonly File[]): string[] {
  const paths = files.map((file) => file.webkitRelativePath || file.name)
  const normalized = paths.map((path) => path.replaceAll('\\', '/'))
  const firstSegments = normalized.map((path) => path.split('/')[0])
  const stripRoot =
    normalized.length > 1 && firstSegments.every((value) => value === firstSegments[0])
  return normalized.map((path) => (stripRoot ? path.split('/').slice(1).join('/') : path))
}

function assertBrowserFileSelectionLimits(files: readonly File[]): void {
  if (!files.length || files.length > FRONTEND_WORKSHOP_BROWSER_SOURCE_MAX_FILES) {
    throw new FrontendWorkshopBrowserSourceCompileError([
      { code: 'invalid-project', message: 'Browser Source 文件数量为空或超出限制' },
    ])
  }
  let totalBytes = 0
  for (const file of files) {
    if (file.size > FRONTEND_WORKSHOP_BROWSER_SOURCE_MAX_FILE_BYTES) {
      throw new FrontendWorkshopBrowserSourceCompileError([
        {
          code: 'invalid-project',
          message: `Browser Source 单文件超出限制：${file.webkitRelativePath || file.name}`,
          path: file.webkitRelativePath || file.name,
        },
      ])
    }
    totalBytes += file.size
    if (totalBytes > FRONTEND_WORKSHOP_BROWSER_SOURCE_MAX_TOTAL_BYTES) {
      throw new FrontendWorkshopBrowserSourceCompileError([
        { code: 'invalid-project', message: 'Browser Source 总大小超出限制' },
      ])
    }
  }
}

export function selectFrontendWorkshopBrowserSourceEntry(files: readonly File[]): string {
  const projectPaths = browserInputPaths(files)
  const priorities = [
    /^index\.html?$/iu,
    /^(?:src\/)?main\.(?:ts|tsx|js|jsx|mjs)$/iu,
    /^(?:src\/)?app\.vue$/iu,
    /\.vue$/iu,
    /\.(?:ts|tsx|js|jsx|mjs|css|html?)$/iu,
  ]
  for (const pattern of priorities) {
    const match = projectPaths.find((path) => pattern.test(path))
    if (match) return match
  }
  throw new FrontendWorkshopBrowserSourceCompileError([
    { code: 'missing-entry', message: '未找到 HTML、TS、TSX、JS、CSS 或 Vue SFC 入口' },
  ])
}

export async function createFrontendWorkshopBrowserSourceProjectFromFiles(
  files: readonly File[],
): Promise<FrontendWorkshopBrowserSourceProject> {
  assertBrowserFileSelectionLimits(files)
  const paths = browserInputPaths(files)
  const entries = await Promise.all(
    files.map(async (file, index) => ({
      path: paths[index]!,
      contents: new Uint8Array(await file.arrayBuffer()),
    })),
  )
  return { entryPath: selectFrontendWorkshopBrowserSourceEntry(files), files: entries }
}

/**
 * The sole Browser Source compiler owner. It only converts an explicit external browser project to
 * Author Source; the existing Source Document and Source Runtime remain the persistence and mount
 * owners. It does not emulate Node, install packages, start services, or mount previews.
 */
export class FrontendWorkshopBrowserSourceCompilerService {
  private readonly engine?: FrontendWorkshopBrowserBuildEngine

  constructor(engine?: FrontendWorkshopBrowserBuildEngine) {
    this.engine = engine
  }

  private async buildEntry(
    project: NormalizedProject,
    entryPath: string,
    virtualContents?: string,
  ): Promise<CompiledEntry> {
    const vueStyles = new Map<string, string>()
    const files = new Map(project.files)
    if (virtualContents !== undefined) files.set(entryPath, virtualContents)
    const plugin: Plugin = {
      name: 'frontend-workshop-browser-source',
      setup: (build) => {
        build.onResolve({ filter: /.*/ }, (args) => {
          if (args.kind === 'entry-point')
            return { path: normalizePath(args.path, '入口'), namespace: 'fw-source' }
          if (HOST_BOUND_IMPORT.test(args.path)) {
            return { errors: [{ text: `Host/backend-bound import 不受支持：${args.path}` }] }
          }
          if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(args.path)) {
            return { errors: [{ text: `Browser Source 不会下载远程 module：${args.path}` }] }
          }
          if (!args.path.startsWith('.') && !args.path.startsWith('/')) {
            return { errors: [{ text: `未提供 browser package：${args.path}` }] }
          }
          const resolved = resolveRelativePath(files, args.importer, args.path)
          return resolved
            ? { path: resolved, namespace: 'fw-source' }
            : { errors: [{ text: `本地 import 不存在：${args.path}` }] }
        })
        build.onLoad(
          { filter: /.*/, namespace: 'fw-source' },
          async (args): Promise<OnLoadResult> => {
            const contents = files.get(args.path)
            if (contents === undefined)
              return { errors: [{ text: `Browser Source 文件不存在：${args.path}` }] }
            const extension = pathExtension(args.path)
            if (extension === 'vue') {
              const compiled = await compileVueSfc(args.path, readText(files, args.path))
              vueStyles.set(
                args.path,
                compiled.css.replace(
                  /url\(\s*(['"]?)([^'"()]+)\1\s*\)/giu,
                  (match, _quote, reference: string) => {
                    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/iu.test(reference)) return match
                    const path = resolveRelativePath(files, args.path, reference)
                    if (!path) throw new Error(`Vue 样式素材不存在：${reference}`)
                    return `url("${dataUrl(path, files.get(path)!)}")`
                  },
                ),
              )
              return {
                contents: compiled.code,
                loader: compiled.loader,
              }
            }
            const loader = loaderFor(args.path)
            const text = loader === 'dataurl' ? contents : readText(files, args.path)
            return {
              contents: typeof text === 'string' ? replaceVueImports(text) : text,
              loader,
            }
          },
        )
      },
    }
    try {
      const engine = this.engine ?? (await defaultBrowserEngine())
      const result = await engine.build({
        bundle: true,
        entryPoints: [entryPath],
        format: 'iife',
        jsxFactory: 'React.createElement',
        jsxFragment: 'React.Fragment',
        logLevel: 'silent',
        outfile: pathExtension(entryPath) === 'css' ? 'out.css' : 'out.js',
        platform: 'browser',
        plugins: [plugin],
        target: ['es2020'],
        write: false,
      })
      const output = selectEntryOutput(result)
      return {
        javascript: output.javascript,
        css: [...vueStyles.values(), output.css].filter(Boolean).join('\n'),
      }
    } catch (error) {
      if (error instanceof FrontendWorkshopBrowserSourceCompileError) throw error
      const messages = (error as { errors?: Message[] }).errors
      throw new FrontendWorkshopBrowserSourceCompileError(
        messages?.length
          ? messages.map(messageDiagnostic)
          : [
              {
                code: 'compile-error',
                message: error instanceof Error ? error.message : String(error),
              },
            ],
      )
    }
  }

  private async compileHtml(project: NormalizedProject): Promise<string> {
    const html = readText(project.files, project.entryPath)
    const parsed = new DOMParser().parseFromString(html, 'text/html')
    const modules = [...parsed.querySelectorAll('script[type="module"]')]
    const compiledModules: string[] = []
    for (let index = 0; index < modules.length; index += 1) {
      const element = modules[index]!
      const sourcePath = element.getAttribute('src')
      if (sourcePath) {
        const resolved = resolveRelativePath(project.files, project.entryPath, sourcePath)
        if (!resolved) {
          throw new FrontendWorkshopBrowserSourceCompileError([
            {
              code: 'missing-import',
              message: `HTML module 入口不存在：${sourcePath}`,
              path: project.entryPath,
            },
          ])
        }
        compiledModules.push(inlineCompiledEntry(await this.buildEntry(project, resolved)))
      } else {
        const virtualPath = `${project.entryPath}.inline-${index}.ts`
        compiledModules.push(
          inlineCompiledEntry(
            await this.buildEntry(project, virtualPath, element.textContent ?? ''),
          ),
        )
      }
      element.remove()
    }
    for (const link of [...parsed.querySelectorAll('link[rel="stylesheet"][href]')]) {
      const reference = link.getAttribute('href') ?? ''
      const resolved = resolveRelativePath(project.files, project.entryPath, reference)
      if (!resolved) {
        if (!/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/iu.test(reference)) {
          throw new FrontendWorkshopBrowserSourceCompileError([
            {
              code: 'missing-import',
              message: `HTML 本地样式不存在：${reference}`,
              path: project.entryPath,
            },
          ])
        }
        continue
      }
      const output = await this.buildEntry(project, resolved)
      const style = parsed.createElement('style')
      style.textContent = output.css
      link.replaceWith(style)
    }
    for (const element of [...parsed.querySelectorAll('[src]')]) {
      const reference = element.getAttribute('src') ?? ''
      const resolved = resolveRelativePath(project.files, project.entryPath, reference)
      if (!resolved) {
        if (!/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/iu.test(reference)) {
          throw new FrontendWorkshopBrowserSourceCompileError([
            {
              code: 'missing-import',
              message: `HTML 本地资源不存在：${reference}`,
              path: project.entryPath,
            },
          ])
        }
        continue
      }
      if (element.tagName.toLowerCase() === 'script') {
        if (pathExtension(resolved) !== 'js') {
          throw new FrontendWorkshopBrowserSourceCompileError([
            {
              code: 'compile-error',
              message: `HTML script 只接受本地 JavaScript 文本：${reference}`,
              path: project.entryPath,
            },
          ])
        }
        element.removeAttribute('src')
        element.textContent = readText(project.files, resolved)
      } else {
        element.setAttribute('src', dataUrl(resolved, project.files.get(resolved)!))
      }
    }
    const head = [...parsed.head.children]
      .filter((element) => !['base', 'meta', 'title'].includes(element.tagName.toLowerCase()))
      .map((element) => element.outerHTML)
      .join('\n')
    return [head, parsed.body.innerHTML, ...compiledModules].filter(Boolean).join('\n')
  }

  async compile(
    input: FrontendWorkshopBrowserSourceProject,
  ): Promise<FrontendWorkshopBrowserSourceCompileResult> {
    const project = normalizeProject(input)
    assertBrowserBoundary(project)
    const capability = classifyFrontendWorkshopBrowserSourceProject(input)
    const extension = pathExtension(project.entryPath)
    let authorSource: string
    if (extension === 'html' || extension === 'htm') {
      authorSource = await this.compileHtml(project)
    } else if (extension === 'svg') {
      authorSource = readText(project.files, project.entryPath)
    } else if (extension === 'vue') {
      const virtualEntry = `${project.entryPath}.entry.ts`
      const mountId = 'frontend-workshop-browser-source-root'
      const output = await this.buildEntry(
        project,
        virtualEntry,
        `import Component from './${project.entryPath.split('/').at(-1)}';\nimport { createApp } from 'vue';\ncreateApp(Component).mount(document.getElementById('${mountId}'));`,
      )
      authorSource = `<div id="${mountId}"></div>\n${inlineCompiledEntry(output)}`
    } else {
      authorSource = inlineCompiledEntry(await this.buildEntry(project, project.entryPath))
    }
    return {
      capability: capability === 'browser-compatible' ? 'browser-compatible' : 'browser-compile',
      entryPath: project.entryPath,
      authorSource,
      diagnostics: [],
    }
  }
}
