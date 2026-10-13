import { prepareRichContentPreviewMessage } from './RichPreviewMessagePreparation'

export {
  type PreviewMacroContext,
  replacePreviewMacros,
  prepareRichContentPreviewMessage,
} from './RichPreviewMessagePreparation'
/*
 * Provenance boundary:
 * The functions tagged AFPL-TH-INTEGRATION below retain modified integration
 * portions derived from TavernHelper / JS-Slash-Runner 4.8.19.
 * Upstream: https://github.com/N0VI028/JS-Slash-Runner
 * Modified for SillyTavern Resource Library by jixiangruyi117 on 2026-08-09.
 * Derived portions remain under the Aladdin Free Public License, Version 9;
 * see the repository LICENSE and NOTICE files for the full terms and scope.
 * RenderCompatibilityRuntime.ts, RenderCompatibilityFrontend.ts, viewport
 * mapping and layout measurement are independent behavior-contract Owners.
 */
import type { PreviewPolicy } from '../services/BrowserStorageService'

import { type CharacterGreetingRegexRule } from './CharacterGreetingRegex'

import { frontendWorkshopBehaviorRuntimeScript } from './FrontendWorkshopBehaviorRuntime'

import { type TavernPreviewSourceKind } from './OpeningPreviewContent'

import type { PreviewVendorLibs } from './PreviewVendorLibs'

import { buildPreviewFontStylesheet } from './PreviewFontStylesheet'

import {
  formatSillyTavernMessage,
  isTavernHelperFrontendContent,
  type SillyTavernMessageFormatResult,
} from './SillyTavernMessageFormatter'

import { mapRenderCompatibilityViewportMinimums } from './RenderCompatibilityFrontend'

import {
  buildRenderCompatibilityChildAdapter,
  buildRenderCompatibilityHostRuntime,
  createRenderCompatibilityContextFromPreviewSession,
  normalizeRenderCompatibilityScript,
  type PreviewSessionContext,
  type ArchivedMessageSnapshot,
  type RenderCompatibilityContext,
  type RenderCompatibilityDiagnostic,
} from './RenderCompatibilityRuntime'

export interface RichContentPreviewResult {
  document: string
  hasRichContent: boolean
  blockedScripts: boolean
  blockedExternalAssets: boolean
  audio: {
    present: boolean
    autoplay: boolean
    mediaOnly: boolean
    loop: boolean
    source?: string
    sourceBlocked: boolean
  }
  runtimeScriptCount: number
  dependencies: string[]
  tavernHelperCompatibility: 'none' | 'detected' | 'active'
  mvuCompatibility: 'none' | 'detected' | 'active' | 'opening-preview'
  compatibilityDiagnostics: RenderCompatibilityDiagnostic[]
}

export interface PreviewRuntimeScript {
  id?: string
  source?: 'character' | 'bound' | 'manual'
  name: string
  content: string
  data?: Record<string, unknown>
  buttons?: string[]
  buttonDefinitions?: Array<{ name: string; visible: boolean }>
  info?: string
}

export type SillyTavernMessageAvatarMode = 'visible' | 'hidden'
export type PreviewContentTheme = 'light' | 'dark'

interface ArchivedPanelAppearance {
  blendColor?: string
  colorScheme?: 'light' | 'dark'
  panelTheme?: 'paper' | 'green' | 'night'
}

export interface RichContentPreviewOptions {
  archivedMessage?: ArchivedMessageSnapshot
  archivedReaderCss?: string
  archivedPanelAppearance?: ArchivedPanelAppearance
  previewSessionContext?: PreviewSessionContext
  vendorLibs?: PreviewVendorLibs
  charAvatarUrl?: string
  inspectTargets?: boolean
  renderShell?: 'message' | 'content'
  messageAvatarMode?: SillyTavernMessageAvatarMode
  sourceKind?: TavernPreviewSourceKind
  macroCharName?: string
  macroUserName?: string
  greetingContents?: string[]
  greetingIndex?: number
  characterData?: Record<string, unknown>
  displayRegexRules?: CharacterGreetingRegexRule[]
  swipesData?: Record<string, unknown>[]
  swipesInfo?: Record<string, unknown>[]
  previewVariables?: PreviewSessionContext['variables']
  mvuRecognized?: boolean
  mvuErrors?: string[]
  unsupportedMvuOpeningUpdates?: string[]
  contentTheme?: PreviewContentTheme
  frontendWorkshopBehaviorRuntime?: boolean
  preparedMessage?: PreparedRichContentPreviewMessage
  preparedGreetingMessages?: Array<PreparedRichContentPreviewMessage | undefined>
}

export interface PreparedRichContentPreviewMessage {
  source: string
  previewSource: string
  substitutedSource: string
  formatted: SillyTavernMessageFormatResult
}

const TRANSPARENT_AVATAR = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function sanitizeAvatarUrl(value: string | undefined): string {
  return value && /^data:image\//i.test(value) && !/["'\s]/.test(value) ? value : TRANSPARENT_AVATAR
}

const SYNCHRONOUS_FORMATTER_LITERAL =
  /\bformatAsDisplayedMessage\s*\(|\.\s*formatAsDisplayedMessage\b|["']formatAsDisplayedMessage["']/
const UNCERTAIN_TAVERN_HELPER_PROPERTY_ACCESS =
  /\b(?:TavernHelper|window|globalThis)\s*\[\s*(?!["']formatAsDisplayedMessage["'])[^\]]+\]/

export function requiresSynchronousGreetingFormatting(
  greetings: Iterable<string>,
  runtimeScripts: Iterable<PreviewRuntimeScript> = [],
): boolean {
  for (const greeting of greetings) {
    if (
      SYNCHRONOUS_FORMATTER_LITERAL.test(greeting) ||
      UNCERTAIN_TAVERN_HELPER_PROPERTY_ACCESS.test(greeting)
    ) {
      return true
    }
  }
  for (const script of runtimeScripts) {
    if (
      SYNCHRONOUS_FORMATTER_LITERAL.test(script.content) ||
      UNCERTAIN_TAVERN_HELPER_PROPERTY_ACCESS.test(script.content)
    ) {
      return true
    }
  }
  return false
}

function readAttribute(markup: string, name: string): string {
  const match = markup.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, 'i'),
  )
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? '')
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .trim()
}

function detectAudioPreview(
  source: string,
  policy: PreviewPolicy,
): RichContentPreviewResult['audio'] {
  const audio = source.match(/<audio\b([^>]*)>([\s\S]*?)<\/audio\s*>/i)
  const selfClosing = source.match(/<audio\b([^>]*)\/?>/i)
  const attributes = audio?.[1] ?? selfClosing?.[1]
  if (attributes === undefined) {
    return {
      present: false,
      autoplay: false,
      mediaOnly: false,
      loop: false,
      sourceBlocked: false,
    }
  }

  const sourceTag = audio?.[2]?.match(/<source\b([^>]*)>/i)
  const rawSource = readAttribute(attributes, 'src') || readAttribute(sourceTag?.[1] ?? '', 'src')
  const isRemote = /^(?:https?:)?\/\//i.test(rawSource)
  const sourceAllowed =
    /^(?:https?:|data:audio\/|blob:)/i.test(rawSource) && (!isRemote || policy.allowRemoteResources)
  const visibleRemainder = source
    .replace(/<audio\b[^>]*>[\s\S]*?<\/audio\s*>/gi, '')
    .replace(/<audio\b[^>]*\/?>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!doctype\b[^>]*>/gi, '')
    .replace(/<\/?(?:html|head|body)\b[^>]*>/gi, '')
    .replace(/[\s\u200b-\u200d\ufeff]/g, '')

  return {
    present: true,
    autoplay: /\bautoplay(?:\s|=|>|$)/i.test(attributes),
    mediaOnly: visibleRemainder.length === 0,
    loop: /\bloop(?:\s|=|>|$)/i.test(attributes),
    source: sourceAllowed ? rawSource : undefined,
    sourceBlocked: Boolean(rawSource && !sourceAllowed),
  }
}

function stripExecutableContent(source: string): string {
  return source
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(
      /\s(?:href|xlink:href)\s*=\s*(?:"\s*javascript\s*:[^"]*"|'\s*javascript\s*:[^']*'|javascript\s*:[^\s>]+)/gi,
      '',
    )
}

function restoreTrustedGreetingNavigation(source: string): string {
  return source.replace(
    /<button\b([^>]*\bdata-srl-greeting-target\s*=\s*["']([0-9]{1,2})["'][^>]*)>/giu,
    (_match, attributes: string, target: string) =>
      `<button${attributes} onclick="setChatMessages([{message_id:0,swipe_id:${target}}])">`,
  )
}

function buildLocalThirdParty(libs: PreviewVendorLibs | undefined, isolated = false): string {
  const scripts: string[] = isolated ? [buildOuterVendorLibs(libs)] : []
  for (const key of SHARED_FRONTEND_VENDORS) {
    if (isolated && key === 'jquery') continue
    scripts.push(buildVendorSourceMarkup(key, libs?.[key]))
  }
  if (!isolated)
    scripts.push(
      '<script>window._=window.parent._;window.YAML=window.parent.YAML;window.showdown=window.parent.showdown;window.z=window.parent.z;</script>',
    )
  return scripts.join('')
}

// AFPL-TH-INTEGRATION: frontend third-party dependency composition.
function buildCompatibilityFrontendDependencies(
  libs: PreviewVendorLibs | undefined,
  _allowRemoteResources: boolean,
  isolated = false,
): string {
  return buildLocalThirdParty(libs, isolated)
}

function buildOuterVendorLibs(libs: PreviewVendorLibs | undefined, sharedVendors = false): string {
  const scripts: string[] = []
  if (libs?.lodash)
    scripts.push(`<script>${libs.lodash.replace(/<\/script/gi, '<\\/script')}</script>`)
  if (libs?.jquery)
    scripts.push(
      sharedVendors
        ? '<script>document.write(window.__SRL_PREVIEW_VENDOR_DOCUMENTS__.jquery)</script>'
        : `<script>${libs.jquery.replace(/<\/script/gi, '<\\/script')}</script>`,
    )
  if (libs?.showdown)
    scripts.push(`<script>${libs.showdown.replace(/<\/script/gi, '<\\/script')}</script>`)
  if (libs?.vendorGlobals)
    scripts.push(`<script>${libs.vendorGlobals.replace(/<\/script/gi, '<\\/script')}</script>`)
  return scripts.join('')
}

function buildScriptIframeVendorLibs(
  libs: PreviewVendorLibs | undefined,
  _allowRemoteResources: boolean,
): string {
  return SHARED_SCRIPT_VENDORS.map((key) => buildVendorSourceMarkup(key, libs?.[key])).join('')
}

const SHARED_FRONTEND_VENDORS = [
  'fontAwesomeCss',
  'jqueryUiCss',
  'toastrCss',
  'jquery',
  'jqueryUi',
  'jqueryUiTouchPunch',
  'vue',
  'vueRouter',
  'toastr',
  'tailwind',
] as const
const SHARED_SCRIPT_VENDORS = ['toastrCss', 'vue', 'vueRouter', 'toastr'] as const

function buildVendorSourceMarkup(
  key: (typeof SHARED_FRONTEND_VENDORS)[number],
  source: string | undefined,
): string {
  if (!source) return ''
  if (key === 'fontAwesomeCss') return buildPreviewFontStylesheet(source)
  return key.endsWith('Css')
    ? `<style>${source}</style>`
    : `<script>${source.replace(/<\/script/gi, '<\\/script')}</script>`
}

/** Static dependency markup is shared; each child still executes its own library instances. */
function buildSharedVendorDocuments(
  libs: PreviewVendorLibs | undefined,
  includeFrontends: boolean,
): string {
  const keys = includeFrontends
    ? SHARED_FRONTEND_VENDORS
    : (['jquery', ...SHARED_SCRIPT_VENDORS] as const)
  const sources = Object.fromEntries(
    keys.flatMap((key) => {
      const source = libs?.[key]
      if (!source) return []
      const markup = buildVendorSourceMarkup(key, source)
      return [[key, markup]]
    }),
  )
  const documents = JSON.stringify(sources)
    .replace(/</gu, '\\u003c')
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029')
  return `<script id="srl-preview-vendor-data" type="application/json">${documents}</script><script>(()=>{let sources=Object.freeze(JSON.parse(document.getElementById('srl-preview-vendor-data').textContent));Object.defineProperty(window,'__SRL_PREVIEW_VENDOR_DOCUMENTS__',{get:()=>sources});Object.defineProperty(window,'__SRL_UPDATE_PREVIEW_VENDOR_DOCUMENTS__',{value:next=>{sources=Object.freeze({...sources,...next})}})})();</script>`
}

function buildSharedChildVendors(kind: 'frontend' | 'script'): string {
  // srcdoc parses this in its head, before author code, preserving parser-blocking dependency order.
  const keys = kind === 'frontend' ? SHARED_FRONTEND_VENDORS : SHARED_SCRIPT_VENDORS
  return `<script>(()=>{const sources=window.parent.__SRL_PREVIEW_VENDOR_DOCUMENTS__;if(!sources)throw Error('Shared preview dependencies are unavailable');document.write(${JSON.stringify(keys)}.map(key=>sources[key]||'').join(''))})();</script>${kind === 'frontend' ? '<script>window._=window.parent._;window.YAML=window.parent.YAML;window.showdown=window.parent.showdown;window.z=window.parent.z;</script>' : ''}`
}

function buildCompatibilityLogRuntime(): string {
  return `<script>window.log=window.log||{trace:console.debug?.bind(console)||console.log.bind(console),debug:console.debug?.bind(console)||console.log.bind(console),info:console.info?.bind(console)||console.log.bind(console),warn:console.warn.bind(console),error:console.error.bind(console)};</script>`
}

function buildChildPolicy(policy: PreviewPolicy, httpsOnly = false): string {
  const remote = policy.allowRemoteResources ? (httpsOnly ? ' https:' : ' https: http:') : ''
  const script = policy.allowScripts
    ? ` 'unsafe-inline' 'unsafe-eval' data: blob:${remote}`
    : " 'unsafe-inline'"
  return [
    "default-src 'none'",
    `style-src 'self' 'unsafe-inline' data: blob:${remote}`,
    `img-src data: blob:${remote}`,
    `font-src 'self' data: blob:${remote}`,
    `media-src data: blob:${remote}`,
    `connect-src${remote || " 'none'"}`,
    `script-src 'self'${script}`,
    `frame-src${remote || " 'none'"}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
}

function buildEphemeralStorageRuntime(inheritFromParent: boolean): string {
  return `<script>(()=>{'use strict';
const createStorage=()=>{const values=new Map();return{get length(){return values.size},clear(){values.clear()},getItem(key){key=String(key);return values.has(key)?values.get(key):null},key(index){index=Number(index);return Number.isInteger(index)&&index>=0?Array.from(values.keys())[index]??null:null},removeItem(key){values.delete(String(key))},setItem(key,value){values.set(String(key),String(value))}}};
let storage;${inheritFromParent ? 'try{storage=window.parent?.__SRL_EPHEMERAL_STORAGE__}catch{}' : ''}if(!storage)storage=createStorage();
Object.defineProperty(window,'__SRL_EPHEMERAL_STORAGE__',{configurable:false,enumerable:false,value:storage});
Object.defineProperty(window,'localStorage',{configurable:true,enumerable:true,value:storage});
${inheritFromParent ? "try{const factory=window.parent?.__SRL_EPHEMERAL_INDEXEDDB__;if(factory){Object.defineProperty(window,'indexedDB',{configurable:true,value:factory});Object.defineProperty(window,'IDBKeyRange',{configurable:true,value:window.parent?.__SRL_EPHEMERAL_IDB_KEY_RANGE__})}}catch{}" : ''}
})();</script>`
}

function buildJavascriptHrefRuntime(): string {
  return `<script>(()=>{'use strict';
document.addEventListener('click',event=>{const target=event.target;const anchor=target instanceof Element?target.closest('a[href]'):null;const raw=anchor?.getAttribute('href')?.trim()||'';if(!/^javascript\\s*:/i.test(raw))return;event.preventDefault();const code=raw.replace(/^javascript\\s*:/i,'');if(!code)return;setTimeout(()=>{try{Function(code).call(window)}catch(error){console.error('[TavernHelper javascript href]',error)}},0)},true);
})();</script>`
}

function buildTrustedGreetingNavigationRuntime(): string {
  return `<script>(()=>{'use strict';
const activate=event=>{const target=event.currentTarget;const swipeId=Number(target?.getAttribute?.('data-srl-greeting-target'));if(!Number.isInteger(swipeId)||swipeId<0)return;event.preventDefault();if(typeof window.setChatMessages==='function'){void window.setChatMessages([{message_id:0,swipe_id:swipeId}]);return}parent.postMessage({type:'SRL_GREETING_NAVIGATE',target:swipeId},'*')};
const bind=()=>document.querySelectorAll('[data-srl-greeting-target]').forEach(target=>target.addEventListener('click',activate));
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind,{once:true});else bind();
})();</script>`
}

function buildCompatibilityLayoutRuntime(hasDeclaredViewportMinimum: boolean): string {
  return `<script>(()=>{'use strict';
let queued=false;let viewportHeight=0;let observer;
const hasViewportBoundLayer=()=>Array.from(document.body?.querySelectorAll('*')||[]).some(element=>{const style=getComputedStyle(element);return style.position==='fixed'&&style.top!=='auto'&&style.bottom!=='auto'});
const measure=()=>{queued=false;const body=document.body;if(!body)return;const contentHeight=body.scrollHeight;const viewportBound=${hasDeclaredViewportMinimum ? 'true' : 'hasViewportBoundLayer()'};const height=viewportBound&&viewportHeight>0?Math.max(contentHeight,viewportHeight):contentHeight;const frame=window.frameElement;if(frame&&Number.isFinite(height)&&height>0)frame.style.height=Math.ceil(height)+'px';parent.postMessage({type:'SRL_FRAME_LAYOUT_READY',viewportBound,height:Math.ceil(height)},'*')};
const queue=()=>{if(queued)return;queued=true;requestAnimationFrame(measure)};
const updateViewport=value=>{const next=Math.ceil(Number(value));if(!Number.isFinite(next)||next<=0||next===viewportHeight)return;viewportHeight=next;rootStyle().setProperty('--TH-viewport-height',viewportHeight+'px');queue()};
const rootStyle=()=>document.documentElement.style;
const mount=()=>{const body=document.body;if(!body)return;queue();if(typeof ResizeObserver==='function'){observer=new ResizeObserver(queue);observer.observe(body)}else{observer=new MutationObserver(queue);observer.observe(body,{subtree:true,childList:true,attributes:true,characterData:true})}};
window.addEventListener('message',event=>{if(event.data?.type==='SRL_VIEWPORT_HEIGHT')updateViewport(event.data.height)});
window.addEventListener('load',queue);window.addEventListener('pagehide',()=>observer?.disconnect?.(),{once:true});
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
})();</script>`
}

export function buildCompatibilityFrontendDocument(
  source: string,
  policy: PreviewPolicy,
  libs: PreviewVendorLibs | undefined,
  avatarUrl: string,
  isolated = false,
  archivedMessage?: ArchivedMessageSnapshot,
  sharedVendors = false,
): {
  document: string
  blockedScripts: boolean
  blockedExternalAssets: boolean
} {
  const blockedScripts = /<script\b|\son[a-z]+\s*=|javascript\s*:/i.test(source)
  const blockedExternalAssets =
    !policy.allowRemoteResources &&
    /(?:https?:)?\/\/|@import\s|url\s*\(\s*['"]?(?:https?:)?\/\//i.test(source)
  const content = mapRenderCompatibilityViewportMinimums(
    policy.allowScripts ? source : restoreTrustedGreetingNavigation(stripExecutableContent(source)),
  )
  const hasDeclaredViewportMinimum = content.includes('var(--TH-viewport-height)')
  const thirdParty = policy.allowScripts
    ? sharedVendors && !isolated
      ? buildSharedChildVendors('frontend')
      : buildCompatibilityFrontendDependencies(libs, policy.allowRemoteResources, isolated)
    : ''

  return {
    document: `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${buildChildPolicy(policy, isolated)}">
${policy.allowScripts ? buildEphemeralStorageRuntime(true) : ''}
<style>
${isolated ? ':root{--TH-viewport-height:100dvh}' : ''}
*,*::before,*::after{box-sizing:border-box;}
html,body{margin:0!important;padding:0;overflow:${isolated ? 'auto' : 'hidden!important'};max-width:100%!important;}
.user_avatar,.user-avatar{background-image:url('${TRANSPARENT_AVATAR}')}
.char_avatar,.char-avatar{background-image:url('${avatarUrl}')}
</style>
${thirdParty}
${isolated ? buildRenderCompatibilityHostRuntime(createRenderCompatibilityContextFromPreviewSession({}), 1, archivedMessage) : ''}
${buildRenderCompatibilityChildAdapter(undefined, { hostScope: isolated ? 'self' : 'parent' })}
${buildCompatibilityLogRuntime()}
${buildTrustedGreetingNavigationRuntime()}
${policy.allowScripts ? buildJavascriptHrefRuntime() : ''}
${buildCompatibilityLayoutRuntime(hasDeclaredViewportMinimum)}
</head>
<body>
${content}
</body>
</html>
`,
    blockedScripts,
    blockedExternalAssets,
  }
}

function mountCompatibilityFramesAndScripts(
  html: string,
  blocks: string[],
  scripts: PreviewRuntimeScript[],
  policy: PreviewPolicy,
  libs: PreviewVendorLibs | undefined,
  avatarUrl: string,
  messageId = 0,
  archivedAppearance?: ArchivedPanelAppearance,
  sharedVendors = false,
): {
  html: string
  companionHtml: string
  blockedScripts: boolean
  blockedExternalAssets: boolean
} {
  let blockedScripts = false
  let blockedExternalAssets = false
  let companionHtml = ''
  if (typeof document === 'undefined' || (!blocks.length && !scripts.length)) {
    return { html, companionHtml, blockedScripts, blockedExternalAssets }
  }

  const template = document.createElement('template')
  template.innerHTML = html
  const wrappers = Array.from(template.content.querySelectorAll<HTMLDivElement>('div.TH-render'))
  wrappers.forEach((wrapper, index) => {
    const pre = Array.from(wrapper.children).find((child) => child.tagName === 'PRE')
    const block = blocks[index]
    if (!pre || block === undefined) return
    const child = buildCompatibilityFrontendDocument(
      block,
      policy,
      libs,
      avatarUrl,
      false,
      undefined,
      sharedVendors,
    )
    blockedScripts ||= child.blockedScripts
    blockedExternalAssets ||= child.blockedExternalAssets

    wrapper.querySelectorAll(':scope > iframe').forEach((iframe) => iframe.remove())
    const iframe = document.createElement('iframe')
    iframe.id = `TH-message--${messageId}--${index}`
    iframe.name = iframe.id
    // Archived script windows restore position after their frontend layouts settle.
    // All bounded-window children must initialize before that first restore.
    iframe.setAttribute('loading', sharedVendors ? 'eager' : 'lazy')
    iframe.className = 'w-full'
    iframe.setAttribute('frameborder', '0')
    if (policy.allowRemoteResources) iframe.setAttribute('allow', 'autoplay')
    iframe.srcdoc = archivedAppearance
      ? decorateArchivedFrontend(child.document, policy, archivedAppearance)
      : child.document
    wrapper.append(iframe)
    Array.from(wrapper.children).forEach((childElement) => {
      if (childElement !== iframe) childElement.classList.add('hidden!')
    })
  })

  if (scripts.length) {
    const scriptContainer = document.createElement('div')
    scriptContainer.id = 'srl-tavern-helper-script-runtimes'
    scriptContainer.hidden = true
    scriptContainer.setAttribute('aria-hidden', 'true')

    for (const [index, script] of scripts.entries()) {
      const iframe = document.createElement('iframe')
      const id = script.id || `${script.source || 'character'}-${index}`
      iframe.id = `TH-script--${script.name}--${id}`
      iframe.name = iframe.id
      iframe.setAttribute('tabindex', '-1')
      iframe.srcdoc = buildCompatibilityScriptDocument(script, policy, libs, sharedVendors)
      scriptContainer.append(iframe)
    }
    companionHtml = scriptContainer.outerHTML
  }

  const container = document.createElement('div')
  container.append(template.content.cloneNode(true))
  return { html: container.innerHTML, companionHtml, blockedScripts, blockedExternalAssets }
}

export function buildRenderCompatibilitySwipeMarkup(
  source: string,
  policy: PreviewPolicy,
  options: Pick<
    RichContentPreviewOptions,
    | 'vendorLibs'
    | 'charAvatarUrl'
    | 'sourceKind'
    | 'macroCharName'
    | 'macroUserName'
    | 'displayRegexRules'
    | 'preparedMessage'
  > = {},
): string {
  const prepared =
    options.preparedMessage?.source === source
      ? options.preparedMessage
      : prepareRichContentPreviewMessage(source, policy, options)
  const formatted = prepared.formatted
  return mountCompatibilityFramesAndScripts(
    formatted.html,
    formatted.frontendBlocks,
    [],
    policy,
    options.vendorLibs,
    sanitizeAvatarUrl(options.charAvatarUrl),
  ).html
}

function buildCompatibilityScriptDocument(
  script: PreviewRuntimeScript,
  policy: PreviewPolicy,
  libs: PreviewVendorLibs | undefined,
  sharedVendors = false,
): string {
  const content = normalizeRenderCompatibilityScript(script.content)
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${buildChildPolicy(policy)}">
${policy.allowScripts ? buildEphemeralStorageRuntime(true) : ''}
<script>window.$=window.parent.$;window.jQuery=window.parent.jQuery;window._=window.parent._;window.YAML=window.parent.YAML;window.showdown=window.parent.showdown;window.z=window.parent.z;</script>
${sharedVendors ? buildSharedChildVendors('script') : buildScriptIframeVendorLibs(libs, policy.allowRemoteResources)}
${buildRenderCompatibilityChildAdapter(script)}
${buildCompatibilityLogRuntime()}
</head>
<body>
<script type="module">
${content}
</script>
</body>
</html>`
}

function buildFrameHostRuntime(): string {
  return `<script>(()=>{'use strict';
const frames=()=>Array.from(document.querySelectorAll('div.TH-render>iframe'));
let hostViewportHeight=0;
const broadcast=()=>{if(hostViewportHeight<=0)return;for(const frame of frames()){if(frame.dataset.srlViewportBound==='true')frame.contentWindow?.postMessage({type:'SRL_VIEWPORT_HEIGHT',height:hostViewportHeight},'*')}};
const attach=()=>{for(const frame of frames()){if(frame.dataset.srlLayoutListener==='1')continue;frame.dataset.srlLayoutListener='1';frame.addEventListener('load',broadcast)}};
const settleMessageHeight=()=>{const content=document.querySelector('[data-srl-preview-message-content]');const items=frames();if(content&&(items.length===0||items.every(frame=>frame.dataset.srlLayoutReady==='true')))content.style.removeProperty('min-height')};
const refresh=()=>{attach();broadcast();settleMessageHeight()};
Object.defineProperty(window,'__SRL_RENDER_COMPAT_REFRESH_MESSAGE_FRAMES__',{configurable:true,value:refresh});
window.addEventListener('message',event=>{const data=event.data;if(!data)return;if(data.type==='SRL_HOST_VIEWPORT_HEIGHT'){const height=Math.ceil(Number(data.height));if(Number.isFinite(height)&&height>0){hostViewportHeight=height;refresh()}return}if(data.type!=='SRL_FRAME_LAYOUT_READY')return;for(const frame of frames()){if(frame.contentWindow!==event.source)continue;frame.dataset.srlViewportBound=data.viewportBound===true?'true':'false';frame.dataset.srlLayoutReady='true';if(data.viewportBound===true&&hostViewportHeight>0)frame.contentWindow?.postMessage({type:'SRL_VIEWPORT_HEIGHT',height:hostViewportHeight},'*');settleMessageHeight();break}});
window.addEventListener('message',event=>{const data=event.data;if(!data||data.type!=='SRL_GREETING_NAVIGATE')return;for(const frame of frames()){if(frame.contentWindow===event.source){parent.postMessage(data,'*');return}}});
window.addEventListener('resize',broadcast);if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',refresh,{once:true});else refresh();window.addEventListener('load',refresh);
})();</script>`
}

function buildOuterHeightRuntime(): string {
  // Root offsetHeight includes collapsed body margins without the viewport floor of scrollHeight.
  return `<script>(()=>{'use strict';
let queued=false;const report=()=>{queued=false;if(window.__SRL_ARCHIVED_READER_LAYOUT__){window.__SRL_ARCHIVED_READER_LAYOUT__();return}const height=Math.max(document.body?.scrollHeight||0,document.documentElement?.offsetHeight||0);if(height>0)parent.postMessage({type:'SRL_PREVIEW_HEIGHT',height,floor:window.__SRL_ARCHIVED_READER_FLOOR__},'*')};const queue=()=>{if(queued)return;queued=true;requestAnimationFrame(report)};
const mount=()=>{const body=document.body;if(!body)return;queue();new ResizeObserver(queue).observe(body)};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
window.addEventListener('message',event=>{if(event.data?.type==='SRL_FRAME_LAYOUT_READY')queue()});
window.addEventListener('load',queue);
})();</script>`
}

function buildDetailsControlRuntime(): string {
  return `<script>(()=>{'use strict';
const details=()=>Array.from(document.querySelectorAll('.mes_text details'));
const report=()=>{const items=details();parent.postMessage({type:'SRL_PREVIEW_DETAILS_STATE',total:items.length,open:items.filter(item=>item.open).length},'*')};
const initialize=()=>{report();document.addEventListener('toggle',report,true)};
window.addEventListener('message',event=>{const data=event.data;if(!data||data.type!=='SRL_SET_DETAILS_OPEN')return;for(const item of details())item.open=data.open===true;report()});
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initialize,{once:true});else initialize();
})();</script>`
}

function buildOuterPolicy(policy: PreviewPolicy): string {
  const remote = policy.allowRemoteResources ? ' https: http:' : ''
  const script = policy.allowScripts
    ? `'unsafe-inline' 'unsafe-eval' data: blob:${remote}`
    : "'unsafe-inline'"
  return [
    "default-src 'none'",
    `style-src 'unsafe-inline' data: blob:${remote}`,
    `img-src data: blob:${remote}`,
    `font-src data: blob:${remote}`,
    `media-src data: blob:${remote}`,
    "connect-src 'none'",
    `script-src ${script}`,
    "frame-src 'self' data: blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
}

/** Opt-in reader palette. Does not change geometry, image pixels, variables or author source on disk. */
export function archivedPanelThemeCss(
  theme: 'paper' | 'green' | 'night',
  root = 'body',
  ink?: string,
): string {
  const palette = {
    paper: ['#f6f3ec', '#fffcf6', '#303a32', '#dddfd3', '#586c4e'],
    green: ['#e8eddf', '#f2f5ec', '#303a32', '#c9d3c0', '#45603c'],
    night: ['#202622', '#2b342e', '#d0d3c6', '#465249', '#b4c69b'],
  }[theme]
  return `${root}{background:transparent!important;color:${ink || (root === 'body' ? palette[2] : 'inherit')}!important}
${root} *{color:inherit!important;background-color:transparent!important;background-image:none!important;border-color:color-mix(in srgb,currentColor 25%,transparent)!important;box-shadow:none!important;text-shadow:none!important}
${root} :is(button,input,select,textarea,summary){background-color:color-mix(in srgb,currentColor 8%,transparent)!important}`
}

// Some authored disclosures animate from zero to a fixed cap. In an archive,
// expanding several children can exceed that cap and hide their last rows.
// Only relax an animated, hidden-overflow cap with a more specific zero-height
// state in the same stylesheet scope. Keep closed states and scroll areas intact.
function buildArchivedDisclosureLayoutRuntime(): string {
  return `<script data-srl-archive-disclosures>(()=>{'use strict';
const visit=rules=>{
 const styles=Array.from(rules).filter(rule=>rule.type===CSSRule.STYLE_RULE);
 for(const rule of styles){
  const style=rule.style,selector=rule.selectorText;
  if(selector.includes(',')||!/^\\d+(?:\\.\\d+)?px$/.test(style.maxHeight)||parseFloat(style.maxHeight)<=0||style.getPropertyPriority('max-height')||!/(?:^|[ ,])max-height(?:[ ,]|$)/.test(style.transitionProperty||style.transition)||!['hidden','clip'].includes(style.overflowY||style.overflow))continue;
  const closed=styles.some(other=>other!==rule&&/^0(?:px)?$/.test(other.style.maxHeight)&&other.selectorText.endsWith(' '+selector));
  if(closed)style.maxHeight='none';
 }
 for(const rule of rules)if(rule.cssRules)visit(rule.cssRules);
};
for(const sheet of document.styleSheets){if(sheet.href)continue;visit(sheet.cssRules)}
})();</script>`
}

/** Share archived panel appearance and disclosure behavior with companion-script floors. */
function decorateArchivedFrontend(
  document: string,
  policy: PreviewPolicy,
  { blendColor, colorScheme, panelTheme }: ArchivedPanelAppearance,
): string {
  const childStyle =
    (colorScheme ? `:root{color-scheme:${colorScheme}}` : '') +
    (blendColor
      ? `html,body{background:transparent!important}body{color:${blendColor}!important}`
      : '') +
    (panelTheme ? archivedPanelThemeCss(panelTheme, 'body', blendColor) : '')
  const childDocument = document.replace(
    '</body>',
    `<style>${childStyle}</style>${policy.allowScripts ? buildArchivedDisclosureLayoutRuntime() : ''}</body>`,
  )
  return policy.allowRemoteResources
    ? childDocument
    : childDocument.replace(
        '</head>',
        '<style>img:not([src^="data:"]):not([src^="blob:"]){display:none}</style></head>',
      )
}

/** Load this document via a data URL: an opaque outer origin, with same-origin TH children. */
export function buildArchivedChatFrontendDocument(
  source: string,
  policy: PreviewPolicy,
  libs: PreviewVendorLibs | undefined,
  snapshot: ArchivedMessageSnapshot,
  blendColor?: string,
  colorScheme?: 'light' | 'dark',
  panelTheme?: 'paper' | 'green' | 'night',
): string {
  const child = buildCompatibilityFrontendDocument(source, policy, libs, '')
  const frame = document.createElement('iframe')
  frame.id = `TH-message--${snapshot.message_id}--0`
  frame.name = frame.id
  frame.title = '状态栏'
  frame.srcdoc = decorateArchivedFrontend(child.document, policy, {
    blendColor,
    colorScheme,
    panelTheme,
  })
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${buildOuterPolicy(policy)}">
<style>${colorScheme ? `:root{color-scheme:${colorScheme}}` : ''}html,body{margin:0;padding:0;background:transparent}div.TH-render>iframe{display:block;width:100%;height:0;border:0}</style>
${policy.allowScripts ? buildEphemeralStorageRuntime(false) : ''}
${buildOuterVendorLibs(libs)}
${buildRenderCompatibilityHostRuntime(createRenderCompatibilityContextFromPreviewSession({}), 1, snapshot)}
${buildFrameHostRuntime()}
${buildOuterHeightRuntime()}
</head><body><div id="chat"><div class="mes" mesid="${snapshot.message_id}"><div class="mes_text"><div class="TH-render">${frame.outerHTML}</div></div></div></div></body></html>`
}

function buildPreviewMessageMarkup(title: string, html: string, avatarUrl: string): string {
  const safeTitle = escapeHtml(title)
  return `<main id="chat" data-srl-preview-shell="message"><article class="mes last_mes bot_mes" mesid="0" ch_name="${safeTitle}" is_user="false" is_system="false" bookmark_link="">
<aside class="mesAvatarWrapper"><div class="avatar"><img src="${avatarUrl}" alt=""></div><div class="mesIDDisplay"></div><div class="mes_timer"></div><div class="tokenCounterDisplay"></div></aside>
<button class="swipe_left" type="button" tabindex="-1" aria-hidden="true"></button>
<section class="mes_block"><header class="ch_name"><span class="name_text">${safeTitle}</span></header><div class="mes_text" data-srl-preview-message-content>${html}</div></section>
<div class="swipeRightBlock" aria-hidden="true"><button class="swipe_right" type="button" tabindex="-1"></button><div class="swipes-counter"></div></div>
</article></main>`
}

function buildPreviewShellStyles(contentColors: {
  body: string
  emphasis: string
  underline: string
}): string {
  return `
*,*::before,*::after{box-sizing:border-box}
:root{--avatar-base-height:50px;--avatar-base-width:50px;--mainFontSize:15px;--mainFontFamily:"Noto Sans",sans-serif;--mes-right-spacing:30px;--srl-message-gap:10px;--SmartThemeBodyColor:${contentColors.body};--SmartThemeEmColor:${contentColors.emphasis};--SmartThemeUnderlineColor:${contentColors.underline};--SmartThemeQuoteColor:#d48b35;--SmartThemeBorderColor:rgba(0,0,0,.5);--black50a:rgba(0,0,0,.5)}
html,body{margin:0;padding:0;max-width:100%;background:transparent;color:var(--SmartThemeBodyColor)}
body{overflow:hidden;font:var(--mainFontSize)/calc(var(--mainFontSize) + .5rem) var(--mainFontFamily)}
#chat{width:100%}
.mes{display:grid;grid-template-columns:auto minmax(0,1fr);grid-template-areas:"avatar message";align-items:start;position:relative;width:100%;min-width:0;padding:10px;color:var(--SmartThemeBodyColor)}
.mesAvatarWrapper{grid-area:avatar;min-width:var(--avatar-base-width)}
.avatar,.avatar img{width:var(--avatar-base-width);height:var(--avatar-base-height)}
.avatar img{display:block;object-fit:cover;object-position:center;border:1px solid var(--SmartThemeBorderColor);border-radius:50%;box-shadow:0 0 5px var(--black50a)}
.mes_block{grid-area:message;min-width:0;padding-inline-start:var(--srl-message-gap);overflow:hidden}
.ch_name{font-weight:700}
.mes_text{max-width:100%;padding-block:5px;padding-inline-end:var(--mes-right-spacing);overflow-wrap:anywhere;font-weight:500}
.swipe_left{position:absolute;left:20px;bottom:20px;width:25px;height:25px;border:0;background:transparent}
.swipeRightBlock{position:absolute;right:0;bottom:0;pointer-events:none}
.swipe_right{width:25px;height:25px;border:0;background:transparent}
.swipes-counter{min-width:40px;height:15px;margin-bottom:5px;padding-inline:5px}
body.no-timer .mes_timer,body.no-tokenCount .tokenCounterDisplay,body.no-mesIDDisplay .mesIDDisplay{display:none}
body.hideChatAvatars .mes{grid-template-columns:0 minmax(0,1fr)}
body.hideChatAvatars .mesAvatarWrapper{visibility:hidden;min-width:0;width:0;overflow:hidden}
body.hideChatAvatars .mes_block{padding-inline-start:0}
body.hideChatAvatars.no-timer.no-tokenCount.no-mesIDDisplay .swipe_left{left:0}
.srl-preview-content__text{padding:0}
.mes_text p{margin-top:0}.mes_text p:last-child{margin-bottom:0}
.mes_text q{color:var(--SmartThemeQuoteColor)}
.mes q::before,.mes q::after,.mes_text q::before,.mes_text q::after{content:''}
.mes_text img,.mes_text audio,.mes_text video,.mes_text canvas,.mes_text svg{max-width:100%}
div.TH-render{display:block;width:100%;max-width:100%}
div.TH-render>.hidden\\!{display:none!important}
div.TH-render>iframe{display:block;width:100%;height:0;margin:0;border:0;background:transparent}
`
}

function buildMessageDocument(
  html: string,
  title: string,
  policy: PreviewPolicy,
  renderShell: 'message' | 'content',
  libs: PreviewVendorLibs | undefined,
  helperContext: RenderCompatibilityContext,
  expectedIframeCount: number,
  helperRuntimeEnabled: boolean,
  messageAvatarMode: SillyTavernMessageAvatarMode,
  messageAvatarUrl: string,
  contentTheme: PreviewContentTheme,
  frontendWorkshopBehaviorRuntimeEnabled: boolean,
  companionHtml: string,
  archivedMessage?: ArchivedMessageSnapshot,
  archivedReaderCss = '',
  sharedVendorDocuments = '',
): string {
  const contentColors =
    renderShell === 'content'
      ? contentTheme === 'dark'
        ? {
            body: '#edf0e8',
            emphasis: '#a5afa8',
            underline: '#8dbda9',
          }
        : {
            body: '#1f2925',
            emphasis: '#66706a',
            underline: '#1f5b49',
          }
      : {
          body: 'rgb(220,220,210)',
          emphasis: 'rgb(145,145,145)',
          underline: 'rgb(188,231,207)',
        }
  const bodyClasses =
    renderShell === 'message'
      ? [
          'no-timer',
          'no-tokenCount',
          'no-mesIDDisplay',
          messageAvatarMode === 'hidden' ? 'hideChatAvatars' : '',
        ]
          .filter(Boolean)
          .join(' ')
      : ''
  const safeAvatarUrl = sanitizeAvatarUrl(messageAvatarUrl)
  const content =
    renderShell === 'content'
      ? archivedMessage
        ? `<div id="chat"><div class="mes" mesid="${archivedMessage.message_id}" is_user="${archivedMessage.role === 'user'}" ch_name="${escapeHtml(archivedMessage.name)}"><div class="mes_block"><div class="mes_text srl-preview-content__text" data-srl-preview-message-content>${html}</div></div></div></div>`
        : `<div class="mes_text srl-preview-content__text" data-srl-preview-message-content>${html}</div>`
      : buildPreviewMessageMarkup(title, html, safeAvatarUrl)
  return `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${buildOuterPolicy(policy)}">
<title>${escapeHtml(title)}</title>
${policy.allowScripts ? buildEphemeralStorageRuntime(false) : ''}
<style>
${buildPreviewShellStyles(contentColors)}
${renderShell === 'content' ? `:root{color-scheme:${contentTheme}}` : ''}
${archivedMessage ? `#chat>.mes{display:block;padding:0}#chat>.mes>.mes_block{padding:0;overflow:visible}#chat>.mes>.mes_block>.mes_text{padding:0;font-size:var(--reader-font,18px);line-height:var(--reader-leading,1.85)}` : ''}
${archivedReaderCss.replace(/<\/style/gi, '<\\/style')}
</style>
${sharedVendorDocuments}
${helperRuntimeEnabled ? buildOuterVendorLibs(libs, Boolean(sharedVendorDocuments)) : ''}
${helperRuntimeEnabled ? buildRenderCompatibilityHostRuntime(helperContext, expectedIframeCount, archivedMessage) : ''}
${archivedMessage ? `<script>window.addEventListener('message',event=>{if(event.source!==parent||event.data?.type!=='srl:reader-appearance')return;const {font,leading}=event.data;if(Number.isFinite(font)&&font>=14&&font<=30)document.documentElement.style.setProperty('--reader-font',font+'px');if(Number.isFinite(leading)&&leading>=1.5&&leading<=2.5)document.documentElement.style.setProperty('--reader-leading',leading)});</script>` : ''}
${helperRuntimeEnabled ? buildFrameHostRuntime() : ''}
${buildTrustedGreetingNavigationRuntime()}
${buildOuterHeightRuntime()}
${buildDetailsControlRuntime()}
</head><body class="${bodyClasses}">${content}${companionHtml}${
    frontendWorkshopBehaviorRuntimeEnabled ? `${frontendWorkshopBehaviorRuntimeScript()}` : ''
  }</body></html>`
}

export function hasRichPreviewContent(source: string): boolean {
  const formatted = formatSillyTavernMessage(source)
  return (
    formatted.frontendBlockCount > 0 ||
    /<style\b|<(?:audio|video|canvas|svg|img)\b/i.test(formatted.html)
  )
}

export function hasRenderCompatibilityRuntimeSource(
  source: string,
  runtimeScripts: PreviewRuntimeScript[] = [],
  allowRuntimeScripts = true,
  preparedMessage?: PreparedRichContentPreviewMessage,
): boolean {
  return (
    (allowRuntimeScripts && runtimeScripts.some((script) => script.content.trim())) ||
    (preparedMessage?.source === source
      ? preparedMessage.formatted.frontendBlockCount
      : formatSillyTavernMessage(source).frontendBlockCount) > 0
  )
}

export function createResourcePreviewSessionContext(
  options: RichContentPreviewOptions,
  greetings: readonly string[],
  formattedGreetings: readonly string[],
  activeSwipe: number,
): PreviewSessionContext {
  const character =
    options.macroCharName || options.characterData
      ? { name: options.macroCharName, data: options.characterData }
      : undefined
  const user = options.macroUserName ? { name: options.macroUserName } : undefined
  const mvu =
    options.mvuRecognized === true
      ? {
          recognized: true,
          swipesData: options.swipesData,
          errors: options.mvuErrors,
          unsupportedOpeningUpdates: options.unsupportedMvuOpeningUpdates,
        }
      : undefined

  return {
    character,
    user,
    messages: {
      greetings: [...greetings],
      formattedGreetings: [...formattedGreetings],
      activeSwipe,
      swipesData: options.swipesData,
      swipesInfo: options.swipesInfo,
    },
    variables: options.previewVariables,
    mvu,
  }
}

export function buildRichContentPreview(
  source: string,
  title: string,
  policy: PreviewPolicy = { allowRemoteResources: false, allowScripts: false },
  runtimeScripts: PreviewRuntimeScript[] = [],
  options: RichContentPreviewOptions = {},
): RichContentPreviewResult {
  const prepared =
    options.preparedMessage?.source === source
      ? options.preparedMessage
      : prepareRichContentPreviewMessage(source, policy, options)
  const { previewSource, substitutedSource, formatted } = prepared
  const audio = detectAudioPreview(substitutedSource, policy)
  const hasRuntimeScriptSource = runtimeScripts.some((script) => script.content.trim())
  if (!substitutedSource.trim() && !(policy.allowScripts && hasRuntimeScriptSource)) {
    return {
      document: '',
      hasRichContent: false,
      blockedScripts: false,
      blockedExternalAssets: false,
      audio,
      runtimeScriptCount: 0,
      dependencies: [],
      tavernHelperCompatibility: 'none',
      mvuCompatibility: 'none',
      compatibilityDiagnostics: [],
    }
  }

  const activeRuntimeScripts = policy.allowScripts
    ? runtimeScripts
        .filter((script) => script.content.trim())
        .map((script, index) => ({
          ...script,
          id: script.id || `${script.source || 'character'}-${index}`,
        }))
        .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    : []
  const greetingContents = options.greetingContents?.length
    ? options.greetingContents
    : [previewSource]
  const greetingIndex = Math.min(
    greetingContents.length - 1,
    Math.max(0, Math.trunc(options.greetingIndex ?? 0)),
  )
  const avatarUrl = sanitizeAvatarUrl(options.charAvatarUrl)
  const sharedVendors = Boolean(options.archivedMessage) && activeRuntimeScripts.length > 0
  const mounted = mountCompatibilityFramesAndScripts(
    formatted.html,
    formatted.frontendBlocks,
    activeRuntimeScripts,
    policy,
    options.vendorLibs,
    avatarUrl,
    options.archivedMessage?.message_id,
    options.archivedMessage ? options.archivedPanelAppearance || {} : undefined,
    sharedVendors,
  )
  const hasRichContent =
    formatted.frontendBlockCount > 0 ||
    /<style\b|<(?:audio|video|canvas|svg|img)\b/i.test(formatted.html) ||
    activeRuntimeScripts.length > 0
  const precomputeFormattedGreetings =
    policy.allowScripts &&
    requiresSynchronousGreetingFormatting(greetingContents, activeRuntimeScripts)
  const formattedGreetings = greetingContents.map((greeting, index) => {
    if (index === greetingIndex) return formatted.html
    if (!precomputeFormattedGreetings) return greeting
    const preparedGreeting = options.preparedGreetingMessages?.[index]
    return (
      preparedGreeting?.source === greeting
        ? preparedGreeting
        : prepareRichContentPreviewMessage(greeting, policy, options)
    ).formatted.html
  })
  const previewSessionContext =
    options.previewSessionContext ??
    createResourcePreviewSessionContext(
      options,
      greetingContents,
      formattedGreetings,
      greetingIndex,
    )
  const helperContext = createRenderCompatibilityContextFromPreviewSession(previewSessionContext)
  const hasHelperRuntime = formatted.frontendBlockCount > 0 || hasRuntimeScriptSource
  const helperRuntimeEnabled = formatted.frontendBlockCount > 0 || activeRuntimeScripts.length > 0

  return {
    document: buildMessageDocument(
      mounted.html,
      title,
      policy,
      options.renderShell ?? 'message',
      options.vendorLibs,
      helperContext,
      formatted.frontendBlockCount + activeRuntimeScripts.length,
      helperRuntimeEnabled,
      options.messageAvatarMode ?? 'visible',
      options.charAvatarUrl ?? TRANSPARENT_AVATAR,
      options.contentTheme ?? 'light',
      Boolean(
        options.frontendWorkshopBehaviorRuntime &&
        mounted.html.includes('data-srl-behavior-config'),
      ),
      mounted.companionHtml,
      options.archivedMessage,
      options.archivedReaderCss,
      sharedVendors
        ? buildSharedVendorDocuments(options.vendorLibs, formatted.frontendBlockCount > 0)
        : '',
    ),
    hasRichContent,
    blockedScripts:
      formatted.blockedScripts ||
      mounted.blockedScripts ||
      (!policy.allowScripts && hasRuntimeScriptSource),
    blockedExternalAssets: mounted.blockedExternalAssets,
    audio,
    runtimeScriptCount: activeRuntimeScripts.length,
    dependencies: [],
    tavernHelperCompatibility: hasHelperRuntime
      ? policy.allowScripts
        ? 'active'
        : 'detected'
      : 'none',
    mvuCompatibility: options.mvuRecognized ? 'opening-preview' : 'none',
    compatibilityDiagnostics: helperRuntimeEnabled ? helperContext.diagnostics : [],
  }
}

export { isTavernHelperFrontendContent }
