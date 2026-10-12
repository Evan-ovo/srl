import type { PreviewRuntimeScript } from './RichContentPreview'
import {
  buildRenderCompatibilityScriptHost,
  type PreviewScriptHostContext,
} from './RenderCompatibilityScriptHost'

export const RENDER_COMPATIBILITY_PROTOCOL = 'srl-render-compat-v1' as const

export const RENDER_COMPATIBILITY_EVENTS = {
  diagnostic: 'SRL_RENDER_COMPAT_DIAGNOSTIC',
  greetingNavigate: 'SRL_GREETING_NAVIGATE',
  frameReady: 'SRL_RENDER_COMPAT_FRAME_READY',
  swipeTransition: 'SRL_RENDER_COMPAT_SWIPE_TRANSITION',
} as const

export const RENDER_COMPATIBILITY_TAVERN_EVENTS = {
  APP_READY: 'app_ready',
  CHAT_CHANGED: 'chat_id_changed',
  MESSAGE_SWIPED: 'message_swiped',
  MESSAGE_UPDATED: 'message_updated',
  CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
  CHARACTER_FIRST_MESSAGE_SELECTED: 'character_first_message_selected',
} as const

export type RenderCompatibilityImplementationStatus =
  'IMPLEMENTED' | 'PARTIAL' | 'UNSUPPORTED' | 'UNVERIFIED'

export type RenderCompatibilityParityStatus =
  'VERIFIED' | 'PARTIAL' | 'UNSUPPORTED_HOST_BOUND' | 'UNVERIFIED'

export interface RenderCompatibilityReferenceEvidence {
  kind: 'BLACK_BOX' | 'OFFICIAL_PUBLIC_CONTRACT'
  reference: string
  version?: string
  locator: string
}

export interface RenderCompatibilityDiagnostic {
  capability: string
  implementationStatus: RenderCompatibilityImplementationStatus
  parityStatus: RenderCompatibilityParityStatus
  parityEvidence?: RenderCompatibilityReferenceEvidence[]
  source: string
  callCount: number
  failureReason?: string
  impact?: string
}

export interface PreviewSessionContext {
  scriptHost?: PreviewScriptHostContext
  character?: {
    name?: string
    data?: Record<string, unknown>
  }
  user?: {
    name?: string
  }
  messages?: {
    greetings: readonly string[]
    formattedGreetings?: readonly string[]
    renderedGreetings?: readonly string[]
    activeSwipe?: number
    swipesData?: readonly Record<string, unknown>[]
    swipesInfo?: readonly Record<string, unknown>[]
  }
  variables?: {
    global?: Record<string, unknown>
    chat?: Record<string, unknown>
    character?: Record<string, unknown>
    message?: readonly Record<string, unknown>[]
  }
  mvu?: {
    recognized: boolean
    swipesData?: readonly Record<string, unknown>[]
    errors?: readonly string[]
    unsupportedOpeningUpdates?: readonly string[]
  }
}

/** An exported floor, not a reconstructed conversation or a greeting at message zero. */
export interface ArchivedMessageSnapshot {
  message_id: number
  last_message_id: number
  name: string
  role: 'user' | 'assistant' | 'system'
  is_hidden: boolean
  message: string
  data: Record<string, unknown>
  extra: Record<string, unknown>
  swipe_id: number
}

export interface RenderCompatibilityContextInput {
  scriptHost?: PreviewScriptHostContext
  greetings: string[]
  formattedGreetings: string[]
  renderedGreetings?: string[]
  greetingIndex: number
  swipesData?: Record<string, unknown>[]
  swipesInfo?: Record<string, unknown>[]
  mvuRecognized?: boolean
  mvuErrors?: string[]
  unsupportedMvuOpeningUpdates?: string[]
  charName?: string
  userName?: string
  characterData?: Record<string, unknown>
  globalVariables?: Record<string, unknown>
  chatVariables?: Record<string, unknown>
  characterVariables?: Record<string, unknown>
  characterContextAvailable?: boolean
  messageContextAvailable?: boolean
}

export interface RenderCompatibilityContext {
  scriptHost?: PreviewScriptHostContext
  greetings: string[]
  formattedGreetings: string[]
  renderedGreetings: string[]
  greetingIndex: number
  swipesData: Record<string, unknown>[]
  swipesInfo: Record<string, unknown>[]
  charName: string
  userName: string
  characterData: Record<string, unknown>
  globalVariables: Record<string, unknown>
  chatVariables: Record<string, unknown>
  characterVariables: Record<string, unknown>
  characterContextAvailable: boolean
  messageContextAvailable: boolean
  mvuRecognized: boolean
  mvuErrors: string[]
  unsupportedMvuOpeningUpdates: string[]
  diagnostics: RenderCompatibilityDiagnostic[]
}

const IMPLEMENTATION_STATUSES = new Set<RenderCompatibilityImplementationStatus>([
  'IMPLEMENTED',
  'PARTIAL',
  'UNSUPPORTED',
  'UNVERIFIED',
])

const PARITY_STATUSES = new Set<RenderCompatibilityParityStatus>([
  'VERIFIED',
  'PARTIAL',
  'UNSUPPORTED_HOST_BOUND',
  'UNVERIFIED',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function clonePreviewValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => clonePreviewValue(item)) as T
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, clonePreviewValue(item)]),
    ) as T
  }
  return value
}

function previewValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => previewValuesEqual(item, right[index]))
    )
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false
    const leftKeys = Object.keys(left).sort()
    const rightKeys = Object.keys(right).sort()
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) => key === rightKeys[index] && previewValuesEqual(left[key], right[key]),
      )
    )
  }
  return false
}

function resolvePreviewMessageVariables(
  session: PreviewSessionContext,
): readonly Record<string, unknown>[] | undefined {
  const sources: Array<readonly [string, readonly Record<string, unknown>[]]> = []
  if (session.messages?.swipesData !== undefined) {
    sources.push(['messages.swipesData', session.messages.swipesData])
  }
  if (session.variables?.message !== undefined) {
    sources.push(['variables.message', session.variables.message])
  }
  if (session.mvu?.swipesData !== undefined) {
    sources.push(['mvu.swipesData', session.mvu.swipesData])
  }
  const first = sources[0]
  if (!first) return undefined
  for (const candidate of sources.slice(1)) {
    if (!previewValuesEqual(first[1], candidate[1])) {
      throw new Error(
        `PreviewSessionContext message variable sources conflict: ${first[0]} vs ${candidate[0]}`,
      )
    }
  }
  return first[1]
}

function normalizeSettingsRecord(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value
  if (!Array.isArray(value)) return undefined
  const entries = value.filter(
    (entry): entry is [string, unknown] =>
      Array.isArray(entry) && entry.length >= 2 && typeof entry[0] === 'string',
  )
  return Object.fromEntries(entries)
}

export function extractRenderCompatibilityCharacterVariables(
  characterData: Record<string, unknown>,
): Record<string, unknown> {
  const extensions = isRecord(characterData.extensions) ? characterData.extensions : undefined
  const helper = normalizeSettingsRecord(extensions?.tavern_helper)
  const current = helper?.variables
  if (isRecord(current)) return clonePreviewValue(current)
  const legacy = extensions?.TavernHelper_characterScriptVariables
  return isRecord(legacy) ? clonePreviewValue(legacy) : {}
}

export function isRenderCompatibilityDiagnostic(
  value: unknown,
): value is RenderCompatibilityDiagnostic {
  if (!isRecord(value)) return false
  const parityEvidence = value.parityEvidence
  const validParityEvidence =
    parityEvidence === undefined ||
    (Array.isArray(parityEvidence) &&
      parityEvidence.every(
        (item) =>
          isRecord(item) &&
          (item.kind === 'BLACK_BOX' || item.kind === 'OFFICIAL_PUBLIC_CONTRACT') &&
          typeof item.reference === 'string' &&
          item.reference.length > 0 &&
          item.reference.length <= 256 &&
          (item.version === undefined ||
            (typeof item.version === 'string' && item.version.length <= 64)) &&
          typeof item.locator === 'string' &&
          item.locator.length > 0 &&
          item.locator.length <= 1000,
      ))
  const parityStatus = value.parityStatus as RenderCompatibilityParityStatus
  return (
    typeof value.capability === 'string' &&
    value.capability.length > 0 &&
    value.capability.length <= 128 &&
    IMPLEMENTATION_STATUSES.has(
      value.implementationStatus as RenderCompatibilityImplementationStatus,
    ) &&
    PARITY_STATUSES.has(parityStatus) &&
    validParityEvidence &&
    (parityStatus !== 'VERIFIED' || (Array.isArray(parityEvidence) && parityEvidence.length > 0)) &&
    typeof value.source === 'string' &&
    value.source.length > 0 &&
    value.source.length <= 128 &&
    Number.isInteger(value.callCount) &&
    Number(value.callCount) >= 0 &&
    (value.failureReason === undefined ||
      (typeof value.failureReason === 'string' && value.failureReason.length <= 2000)) &&
    (value.impact === undefined ||
      (typeof value.impact === 'string' && value.impact.length <= 2000))
  )
}

function initialDiagnostics(
  hasCharacterContext: boolean,
  hasCharacterData: boolean,
  hasMvuOpeningState: boolean,
  hasMessageContext: boolean,
): RenderCompatibilityDiagnostic[] {
  return [
    {
      capability: 'events.preview-session',
      implementationStatus: 'IMPLEMENTED',
      parityStatus: 'UNVERIFIED',
      source: 'srl-virtual-host',
      callCount: 0,
    },
    {
      capability: 'chat.messages',
      implementationStatus: 'PARTIAL',
      parityStatus: 'UNVERIFIED',
      source: 'preview-session',
      callCount: 0,
      failureReason: hasMessageContext
        ? 'only message 0 exists in preview'
        : 'no host message context was provided for this preview session',
      impact: hasMessageContext
        ? 'multi-message chat history is unavailable'
        : 'message-dependent APIs expose no chat message instead of fabricating one',
    },
    {
      capability: 'chat.swipes',
      implementationStatus: hasMessageContext ? 'IMPLEMENTED' : 'PARTIAL',
      parityStatus: 'UNVERIFIED',
      source: 'preview-context',
      callCount: 0,
      ...(hasMessageContext
        ? {}
        : {
            failureReason: 'no host message context was provided for this preview session',
            impact: 'swipe state is unavailable until a PreviewSession message context is supplied',
          }),
    },
    {
      capability: 'message.format',
      implementationStatus: 'PARTIAL',
      parityStatus: 'UNVERIFIED',
      source: 'SillyTavernMessageFormatter',
      callCount: 0,
      failureReason: 'only registered preview messages have precomputed formatter output',
      impact: 'unknown dynamic source is returned synchronously as source text',
    },
    {
      capability: 'variables.ephemeral',
      implementationStatus: 'PARTIAL',
      parityStatus: 'UNVERIFIED',
      source: 'preview-session',
      callCount: 0,
      failureReason: 'preview variables are disposable',
      impact: 'state is cleared when the preview is unloaded',
    },
    {
      capability: 'character.current',
      implementationStatus: hasCharacterData ? 'IMPLEMENTED' : 'PARTIAL',
      parityStatus: 'UNVERIFIED',
      source: hasCharacterContext ? 'preview-context' : 'capability-boundary',
      callCount: 0,
      ...(!hasCharacterContext
        ? {
            failureReason: 'no host character context was provided for this preview session',
            impact: 'character APIs expose no current character instead of fabricating one',
          }
        : hasCharacterData
          ? {}
          : {
              failureReason: 'only the preview character name was provided',
              impact: 'character card data is unavailable',
            }),
    },
    {
      capability: 'viewport.min-height.vh',
      implementationStatus: 'IMPLEMENTED',
      parityStatus: 'UNVERIFIED',
      source: 'RenderCompatibilityFrontend',
      callCount: 0,
      failureReason: 'live SillyTavern and TavernHelper differential evidence is unavailable',
      impact: 'SRL behavior is tested, but reference parity is not asserted',
    },
    ...['viewport.height', 'viewport.max-height', 'viewport.dvh-svh-lvh'].map(
      (capability): RenderCompatibilityDiagnostic => ({
        capability,
        implementationStatus: 'PARTIAL',
        parityStatus: 'UNVERIFIED',
        source: 'browser-native-nested-viewport',
        callCount: 0,
        failureReason: 'the public compatibility contract does not map this case to host height',
        impact: 'the child browser applies native iframe viewport semantics; parity is unverified',
      }),
    ),
    {
      capability: 'mvu.opening-preview',
      implementationStatus: hasMvuOpeningState ? 'PARTIAL' : 'UNSUPPORTED',
      parityStatus: hasMvuOpeningState ? 'UNVERIFIED' : 'UNSUPPORTED_HOST_BOUND',
      source: hasMvuOpeningState ? 'preview-session' : 'capability-boundary',
      callCount: 0,
      failureReason: hasMvuOpeningState
        ? 'only deterministic opening initialization is available'
        : 'no valid MVU opening state exists in the active preview message',
      impact: hasMvuOpeningState
        ? 'generation-time and external-lorebook MVU lifecycle remains unavailable'
        : 'no Mvu global is fabricated',
    },
    ...['slash', 'world-info', 'generation', 'extension-host', 'parent-app-dom'].map(
      (capability): RenderCompatibilityDiagnostic => ({
        capability,
        implementationStatus: 'UNSUPPORTED',
        parityStatus: 'UNSUPPORTED_HOST_BOUND',
        source: 'capability-boundary',
        callCount: 0,
        failureReason: 'requires a real SillyTavern host capability',
        impact: 'the dependent script may be partial; other preview output remains available',
      }),
    ),
  ]
}

export function createRenderCompatibilityContext(
  input: RenderCompatibilityContextInput,
): RenderCompatibilityContext {
  const characterContextAvailable =
    input.characterContextAvailable ??
    Boolean(
      input.charName?.trim() ||
      (isRecord(input.characterData) && Object.keys(input.characterData).length),
    )
  const messageContextAvailable = input.messageContextAvailable ?? input.greetings.length > 0
  const greetings = input.greetings.length ? [...input.greetings] : ['']
  const formattedGreetings = greetings.map(
    (source, index) => input.formattedGreetings[index] ?? source,
  )
  const renderedGreetings = greetings.map(
    (source, index) => input.renderedGreetings?.[index] ?? formattedGreetings[index] ?? source,
  )
  const greetingIndex = Math.min(
    greetings.length - 1,
    Math.max(0, Math.trunc(Number(input.greetingIndex) || 0)),
  )
  const characterData = isRecord(input.characterData) ? clonePreviewValue(input.characterData) : {}
  const extractedCharacterVariables = extractRenderCompatibilityCharacterVariables(characterData)
  const characterVariables = isRecord(input.characterVariables)
    ? clonePreviewValue(input.characterVariables)
    : extractedCharacterVariables
  const globalVariables = isRecord(input.globalVariables)
    ? clonePreviewValue(input.globalVariables)
    : {}
  const chatVariables = isRecord(input.chatVariables) ? clonePreviewValue(input.chatVariables) : {}
  const swipesData = greetings.map((_, index) =>
    isRecord(input.swipesData?.[index]) ? clonePreviewValue(input.swipesData[index]) : {},
  )
  const swipesInfo = greetings.map((_, index) =>
    isRecord(input.swipesInfo?.[index]) ? clonePreviewValue(input.swipesInfo[index]) : {},
  )
  const activeMvuState = swipesData[greetingIndex]
  const mvuRecognized =
    input.mvuRecognized === true &&
    messageContextAvailable &&
    isRecord(activeMvuState) &&
    isRecord(activeMvuState.stat_data) &&
    isRecord(activeMvuState.schema)
  return {
    greetings,
    formattedGreetings,
    renderedGreetings,
    greetingIndex,
    swipesData,
    swipesInfo,
    charName: input.charName?.trim() || '角色',
    scriptHost: input.scriptHost ? clonePreviewValue(input.scriptHost) : undefined,
    userName: input.userName?.trim() || '用户',
    characterData,
    globalVariables,
    chatVariables,
    characterVariables,
    characterContextAvailable,
    messageContextAvailable,
    mvuRecognized,
    mvuErrors: input.mvuErrors?.map(String) ?? [],
    unsupportedMvuOpeningUpdates: input.unsupportedMvuOpeningUpdates?.map(String) ?? [],
    diagnostics: initialDiagnostics(
      characterContextAvailable,
      Object.keys(characterData).length > 0,
      mvuRecognized,
      messageContextAvailable,
    ),
  }
}

export function createRenderCompatibilityContextFromPreviewSession(
  session: PreviewSessionContext,
): RenderCompatibilityContext {
  const messages = session.messages
  const messageContextAvailable = Boolean(messages?.greetings.length)
  const activeSwipe = messages?.greetings.length
    ? Math.min(
        messages.greetings.length - 1,
        Math.max(0, Math.trunc(Number(messages.activeSwipe) || 0)),
      )
    : 0
  const resolvedMessageVariables = resolvePreviewMessageVariables(session)
  const messageVariables = messageContextAvailable ? resolvedMessageVariables : undefined
  return createRenderCompatibilityContext({
    scriptHost: session.scriptHost,
    greetings: messages ? [...messages.greetings] : [],
    formattedGreetings: messages?.formattedGreetings
      ? [...messages.formattedGreetings]
      : messages
        ? [...messages.greetings]
        : [],
    renderedGreetings: messages?.renderedGreetings ? [...messages.renderedGreetings] : undefined,
    greetingIndex: activeSwipe,
    swipesData: messageVariables?.map((value) => clonePreviewValue(value)),
    swipesInfo: messages?.swipesInfo?.map((value) => clonePreviewValue(value)),
    charName: session.character?.name,
    userName: session.user?.name,
    characterData: session.character?.data,
    globalVariables: session.variables?.global,
    chatVariables: session.variables?.chat,
    characterVariables: session.variables?.character,
    characterContextAvailable: session.character !== undefined,
    messageContextAvailable,
    mvuRecognized: session.mvu?.recognized === true,
    mvuErrors: session.mvu?.errors ? [...session.mvu.errors] : undefined,
    unsupportedMvuOpeningUpdates: session.mvu?.unsupportedOpeningUpdates
      ? [...session.mvu.unsupportedOpeningUpdates]
      : undefined,
  })
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</gu, '\\u003c')
    .replace(/>/gu, '\\u003e')
    .replace(/&/gu, '\\u0026')
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029')
}

export function normalizeRenderCompatibilityScript(content: string): string {
  const fenced = content.match(/^\s*```[^\n]*\n([\s\S]*)\n```\s*$/i)
  return (fenced?.[1] ?? content).replace(/<\/script/gi, '<\\/script').trim()
}

export function buildRenderCompatibilityHostRuntime(
  context: RenderCompatibilityContext,
  expectedFrameCount: number,
  archivedMessage?: ArchivedMessageSnapshot,
): string {
  const payload = scriptJson(context)
  const events = scriptJson(RENDER_COMPATIBILITY_TAVERN_EVENTS)
  const protocol = scriptJson(RENDER_COMPATIBILITY_PROTOCOL)
  const messages = scriptJson(RENDER_COMPATIBILITY_EVENTS)

  return `<script>(()=>{'use strict';
const context=${payload};const tavernEvents=${events};const protocol=${protocol};const control=${messages};
const archived=${scriptJson(archivedMessage ?? null)};
const clone=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
const diagnostics=new Map(context.diagnostics.map(item=>[item.capability,{...item}]));
const report=item=>{try{parent.postMessage({protocol,type:control.diagnostic,diagnostic:clone(item)},'*')}catch{}};
const touch=(capability,patch={})=>{const previous=diagnostics.get(capability)||{capability,implementationStatus:'UNVERIFIED',parityStatus:'UNVERIFIED',source:'runtime',callCount:0};const next={...previous,...patch,callCount:(previous.callCount||0)+1};diagnostics.set(capability,next);report(next);return next};
  const listeners=new Map();const subscriptions=new Map();const globals=new Map();const globalWaiters=new Map();const swipeTransitionWaiters=new Map();
const on=(type,listener,owner,once=false)=>{if(typeof listener!=='function')return{stop(){}};touch('events.preview-session');const item={listener,owner,once};const list=listeners.get(String(type))||[];list.push(item);listeners.set(String(type),list);subscriptions.set(owner,(subscriptions.get(owner)||new Set()).add(item));return{stop:()=>off(type,listener)}};
const off=(type,listener)=>{const key=String(type);const list=listeners.get(key)||[];listeners.set(key,list.filter(item=>item.listener!==listener))};
const emit=async(type,...args)=>{touch('events.preview-session');const key=String(type);const list=[...(listeners.get(key)||[])];for(const item of list){try{await item.listener(...args)}catch(error){touch('events.preview-session',{implementationStatus:'PARTIAL',failureReason:String(error?.message||error),impact:'one event listener failed; remaining listeners continue'})}if(item.once)off(key,item.listener)}};
const waitForSwipeTransition=target=>new Promise(resolve=>{const key=String(target);const waiters=swipeTransitionWaiters.get(key)||[];waiters.push(resolve);swipeTransitionWaiters.set(key,waiters)});
const settleSwipeTransition=(target,changed)=>{const key=String(target);const waiters=swipeTransitionWaiters.get(key)||[];swipeTransitionWaiters.delete(key);for(const resolve of waiters)resolve(changed)};
  const variables={global:clone(context.globalVariables),chat:clone(context.chatVariables),character:clone(context.characterVariables),scripts:new Map()};
  const messageIdFrom=value=>{if(!context.messageContextAvailable)throw new Error('Preview message context is unavailable');if(value===undefined||value==='latest'||Number(value)===-1||Number(value)===0)return 0;throw new RangeError('Preview message_id is outside [-1, 1): '+String(value))};
  const scriptTarget=(options={},meta={})=>{const key=String(options?.script_id||meta.scriptId||'');if(!key)throw new Error('Script variable scope requires a script id');if(!variables.scripts.has(key))variables.scripts.set(key,clone(meta.scriptData&&typeof meta.scriptData==='object'?meta.scriptData:{}));return variables.scripts.get(key)};
  const variableTarget=(options={},meta={})=>{const type=String(options?.type||'chat');switch(type){case'global':case'chat':case'character':return variables[type];case'message':messageIdFrom(options?.message_id);return context.swipesData[context.greetingIndex];case'script':return scriptTarget(options,meta);case'preset':touch('variables.preset',{implementationStatus:'PARTIAL',parityStatus:'UNVERIFIED',source:'capability-boundary',failureReason:'no active preset exists in resource preview',impact:'preset variables are unavailable'});throw new Error('Preset variables are unavailable in resource preview');case'extension':touch('variables.extension',{implementationStatus:'UNSUPPORTED',parityStatus:'UNSUPPORTED_HOST_BOUND',source:'capability-boundary',failureReason:'no extension host exists in resource preview',impact:'extension variables are unavailable'});throw new Error('Extension variables require a SillyTavern extension host');default:throw new TypeError('Unknown variable type: '+type)}};
  const unsafeKey=key=>key==='__proto__'||key==='prototype'||key==='constructor';
  const mergeVariables=(target,source,overwrite)=>{for(const [key,value] of Object.entries(source||{})){if(unsafeKey(key))continue;const existing=target[key];if(value&&typeof value==='object'&&!Array.isArray(value)&&existing&&typeof existing==='object'&&!Array.isArray(existing)){mergeVariables(existing,value,overwrite);continue}if(overwrite||!(key in target))target[key]=clone(value)}return target};
  const variablePathParts=path=>{const parts=String(path??'').replace(/\\[(?:'([^']*)'|"([^"]*)"|(\\d+))\\]/g,(_match,single,double,index)=>'.'+String(single??double??index)).split('.').filter(Boolean);if(!parts.length||parts.some(unsafeKey))throw new TypeError('Variable path is invalid');return parts};
  const deleteVariablePath=(target,path)=>{const parts=variablePathParts(path);let owner=target;for(const key of parts.slice(0,-1)){if(!owner||typeof owner!=='object'||!(key in owner))return false;owner=owner[key]}if(!owner||typeof owner!=='object'||!(parts.at(-1) in owner))return false;return delete owner[parts.at(-1)]};
  const normalizeSwipeArrays=()=>{const length=Math.max(1,context.greetings.length,context.swipesData.length,context.swipesInfo.length);context.greetings=Array.from({length},(_,index)=>typeof context.greetings[index]==='string'?context.greetings[index]:'');context.formattedGreetings=Array.from({length},(_,index)=>typeof context.formattedGreetings[index]==='string'?context.formattedGreetings[index]:context.greetings[index]);context.renderedGreetings=Array.from({length},(_,index)=>typeof context.renderedGreetings[index]==='string'?context.renderedGreetings[index]:context.formattedGreetings[index]);context.swipesData=Array.from({length},(_,index)=>context.swipesData[index]&&typeof context.swipesData[index]==='object'?context.swipesData[index]:{});context.swipesInfo=Array.from({length},(_,index)=>context.swipesInfo[index]&&typeof context.swipesInfo[index]==='object'?context.swipesInfo[index]:{});context.greetingIndex=Math.min(length-1,Math.max(0,Math.trunc(Number(context.greetingIndex)||0)))};
  normalizeSwipeArrays();
  const message=(includeSwipes=false)=>{normalizeSwipeArrays();const swipeId=context.greetingIndex;const base={message_id:0,name:context.charName,role:'assistant',is_hidden:false};if(includeSwipes)return{...base,swipe_id:swipeId,swipes:[...context.greetings],swipes_data:clone(context.swipesData),swipes_info:clone(context.swipesInfo)};return{...base,message:context.greetings[swipeId]||'',data:clone(context.swipesData[swipeId]||{}),extra:clone(context.swipesInfo[swipeId]||{}),swipe_id:swipeId,swipes:[...context.greetings],swipes_data:clone(context.swipesData)}};
  const renderCurrentSwipe=()=>{const content=document.querySelector('[data-srl-preview-message-content]');if(!content)return;const previousHeight=Math.ceil(content.getBoundingClientRect().height);if(previousHeight>0)content.style.minHeight=previousHeight+'px';content.innerHTML=context.renderedGreetings[context.greetingIndex]||context.formattedGreetings[context.greetingIndex]||'';window.__SRL_RENDER_COMPAT_REFRESH_MESSAGE_FRAMES__?.();if(!content.querySelector('div.TH-render>iframe'))content.style.removeProperty('min-height')};
  const selectInitialFirstMessage=async()=>{if(!context.messageContextAvailable||!context.characterContextAvailable)return false;normalizeSwipeArrays();const selected=context.greetingIndex;const eventArgs={input:context.greetings[selected]||'',output:'',character:clone(context.characterData)};await emit(tavernEvents.CHARACTER_FIRST_MESSAGE_SELECTED,eventArgs);if(typeof eventArgs.output==='string'&&eventArgs.output){context.greetings[selected]=eventArgs.output;context.formattedGreetings[selected]=eventArgs.output;context.renderedGreetings[selected]=eventArgs.output;renderCurrentSwipe()}return true};
  const transitionSwipe=async(target,notifyParent=false,rendered)=>{if(!context.messageContextAvailable)return false;normalizeSwipeArrays();const requested=Math.min(context.greetings.length-1,Math.max(0,Math.trunc(Number(target)||0)));if(typeof rendered==='string')context.renderedGreetings[requested]=rendered;if(requested===context.greetingIndex){settleSwipeTransition(requested,false);return false}context.greetingIndex=requested;touch('chat.swipes');renderCurrentSwipe();if(notifyParent)parent.postMessage({protocol,type:control.greetingNavigate,target:requested},'*');await emit(tavernEvents.MESSAGE_SWIPED,0);settleSwipeTransition(requested,true);return true};
  const rangeFrom=value=>{const source=String(value??'0-{{lastMessageId}}').replaceAll('{{lastMessageId}}','0').trim();const clamp=index=>Math.min(0,Math.max(0,index<0?index+1:index));if(/^[-+]?\\d+$/.test(source)){const id=clamp(Number(source));return{idStart:id,idEnd:id}}const match=source.match(/^(-?\\d+)-(-?\\d+)$/);if(!match)return null;const ids=[clamp(Number(match[1])),clamp(Number(match[2]))].sort((left,right)=>left-right);return{idStart:ids[0],idEnd:ids[1]}};
  const matchesMessageFilter=options=>{const role=String(options?.role||'all');if(role!=='all'&&role!=='assistant')return false;const hideState=String(options?.hide_state||'all');return hideState==='all'||hideState==='unhidden'};
  const mvuRecord=(data,category='stat')=>{if(!data||typeof data!=='object')throw new TypeError('MvuData is required');if(category==='stat')return data.stat_data;if(category==='display')return data.display_data;if(category==='delta')return data.delta_data;throw new TypeError('Unknown Mvu category: '+String(category))};
  const mvuPath=(root,path,defaultValue)=>{const parts=String(path||'').replace(/\\[(?:'([^']*)'|"([^"]*)"|(\\d+))\\]/g,(_match,single,double,index)=>'.'+String(single??double??index)).split('.').filter(Boolean);let value=root;for(const part of parts){if(!value||typeof value!=='object'||!(part in value))return defaultValue;value=value[part]}return Array.isArray(value)&&value.length===2&&typeof value[1]==='string'?value[0]:value};
  const api={
  getChatMessages(meta,range='0-{{lastMessageId}}',options={}){touch('chat.messages');if(!context.messageContextAvailable)return[];const parsed=rangeFrom(range);return parsed&&parsed.idStart<=0&&parsed.idEnd>=0&&matchesMessageFilter(options)?[clone(message(options?.include_swipes===true))]:[]},
  async setChatMessages(meta,updates=[],options={}){
    touch('chat.messages');
    if(!context.messageContextAvailable)return;
    const refresh=String(options?.refresh||'affected');
    if(!['none','affected','all'].includes(refresh))throw new TypeError('Unknown setChatMessages refresh mode: '+refresh);
    let navigationRequested=false;
    const navigationWaits=[];
    for(const update of Array.isArray(updates)?updates:[]){
      if(Number(update?.message_id)!==0)continue;
      normalizeSwipeArrays();
      const current=context.greetingIndex;
      if(typeof update?.message==='string'){
        context.greetings[current]=update.message;
        context.formattedGreetings[current]=update.message;
        context.renderedGreetings[current]=update.message;
      }
      if(update?.data&&typeof update.data==='object')context.swipesData[current]=clone(update.data);
      if(update?.extra&&typeof update.extra==='object')context.swipesInfo[current]=clone(update.extra);
      const hasSwipeShape=update?.swipe_id!==undefined||Array.isArray(update?.swipes)||Array.isArray(update?.swipes_data)||Array.isArray(update?.swipes_info);
      if(hasSwipeShape){
        const length=Math.max(1,Array.isArray(update.swipes)?update.swipes.length:0,Array.isArray(update.swipes_data)?update.swipes_data.length:0,Array.isArray(update.swipes_info)?update.swipes_info.length:0,context.greetings.length);
        if(Array.isArray(update.swipes))context.greetings=Array.from({length},(_,index)=>typeof update.swipes[index]==='string'?update.swipes[index]:(context.greetings[index]||''));
        if(Array.isArray(update.swipes_data))context.swipesData=Array.from({length},(_,index)=>update.swipes_data[index]&&typeof update.swipes_data[index]==='object'?clone(update.swipes_data[index]):clone(context.swipesData[index]||{}));
        if(Array.isArray(update.swipes_info))context.swipesInfo=Array.from({length},(_,index)=>update.swipes_info[index]&&typeof update.swipes_info[index]==='object'?clone(update.swipes_info[index]):clone(context.swipesInfo[index]||{}));
        normalizeSwipeArrays();
        const requested=Math.min(context.greetings.length-1,Math.max(0,Math.trunc(Number(update.swipe_id??context.greetingIndex)||0)));
        if(requested!==context.greetingIndex){
          navigationRequested=true;
          if(String(meta.frameName||''))navigationWaits.push(waitForSwipeTransition(requested));
          parent.postMessage({protocol,type:control.greetingNavigate,target:requested},'*');
        }
      }
      touch('chat.messages',{implementationStatus:'PARTIAL',failureReason:'message mutation is preview-session only',impact:'the source resource is unchanged'});
    }
    if(navigationWaits.length)await Promise.all(navigationWaits);
    if(refresh==='all'){touch('chat.messages',{implementationStatus:'PARTIAL',parityStatus:'UNVERIFIED',failureReason:'refresh all cannot reload a real chat in resource preview',impact:'the current isolated message emits CHAT_CHANGED without a persistent chat reload'});await emit(tavernEvents.CHAT_CHANGED)}
    if(refresh==='affected'&&!navigationRequested)await emit(tavernEvents.CHARACTER_MESSAGE_RENDERED,0);
  },
  setChatMessage(meta,fields,messageId,options={}){if(!context.messageContextAvailable||Number(messageId)!==0)return Promise.resolve();const requested=options?.swipe_id==='current'||options?.swipe_id===undefined?context.greetingIndex:Number(options.swipe_id);if(!Number.isInteger(requested)||requested<0)throw new Error('Invalid preview swipe_id: '+String(options?.swipe_id));normalizeSwipeArrays();const length=Math.max(context.greetings.length,requested+1);const swipes=Array.from({length},(_,index)=>context.greetings[index]||'');const swipesData=Array.from({length},(_,index)=>clone(context.swipesData[index]||{}));const swipesInfo=Array.from({length},(_,index)=>clone(context.swipesInfo[index]||{}));if(typeof fields?.message==='string')swipes[requested]=fields.message;if(fields?.data&&typeof fields.data==='object')swipesData[requested]=clone(fields.data);if(fields?.extra&&typeof fields.extra==='object')swipesInfo[requested]=clone(fields.extra);return api.setChatMessages(meta,[{message_id:0,swipe_id:requested,swipes,swipes_data:swipesData,swipes_info:swipesInfo}],{refresh:options?.refresh})},
  getLastMessageId(){touch('chat.messages');return context.messageContextAvailable?0:-1},
  getIframeName(meta){const name=String(meta.frameName||'');if(!name)throw new Error('Preview iframe name is unavailable');return name},
  getScriptId(meta){if(!meta.scriptId||!String(meta.frameName||'').startsWith('TH-script--'))throw new Error('getScriptId is only available in a script iframe');return String(meta.scriptId)},
  getCurrentMessageId(meta){const name=String(meta.frameName||'');if(!name.startsWith('TH-message--'))throw new Error('getCurrentMessageId is only available in a message iframe');return 0},
  getMessageId(meta,iframeName){const name=String(iframeName||meta.frameName||'');const match=name.match(/^TH-message--(\\d+)--\\d+(?:_\\d+)?$/);if(!match)throw new Error('getMessageId is unavailable outside a message iframe: '+name);return Number(match[1])},
  getVariables(meta,options={}){touch('variables.ephemeral');return clone(variableTarget(options,meta))},
  getAllVariables(meta){touch('variables.ephemeral');const result=Object.assign({},clone(variables.global),clone(variables.character));if(String(meta.frameName||'').startsWith('TH-script--'))Object.assign(result,clone(scriptTarget({},meta)));Object.assign(result,clone(variables.chat));if(context.messageContextAvailable&&String(meta.frameName||'').startsWith('TH-message--'))Object.assign(result,clone(context.swipesData[context.greetingIndex]));return result},
  replaceVariables(meta,value,options={}){touch('variables.ephemeral');if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('Variables replacement must be an object');const target=variableTarget(options,meta);for(const key of Object.keys(target))delete target[key];mergeVariables(target,value,true);return clone(target)},
  updateVariablesWith(meta,updater,options={}){touch('variables.ephemeral');if(typeof updater!=='function')throw new TypeError('Variables updater must be a function');const current=clone(variableTarget(options,meta));const updated=updater(current);if(updated&&typeof updated.then==='function')return Promise.resolve(updated).then(value=>api.replaceVariables(meta,value,options));return api.replaceVariables(meta,updated,options)},
  insertOrAssignVariables(meta,value,options={}){touch('variables.ephemeral');if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('Variables patch must be an object');const target=variableTarget(options,meta);mergeVariables(target,value,true);return clone(target)},
  insertVariables(meta,value,options={}){touch('variables.ephemeral');if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('Variables patch must be an object');const target=variableTarget(options,meta);mergeVariables(target,value,false);return clone(target)},
  deleteVariable(meta,path,options={}){touch('variables.ephemeral');const target=variableTarget(options,meta);const delete_occurred=deleteVariablePath(target,path);return{variables:clone(target),delete_occurred}},
  initializeGlobal(meta,name,value){touch('globals.preview-session',{implementationStatus:'IMPLEMENTED',parityStatus:'VERIFIED',parityEvidence:[{kind:'BLACK_BOX',reference:'TavernHelper',version:'4.9.3',locator:'fixture-global-semantics-2026-08-29'}],source:'preview-session'});const key=String(name||'').trim();if(!key)throw new TypeError('Global name is required');globals.set(key,value);const waiters=globalWaiters.get(key)||[];globalWaiters.delete(key);for(const resolve of waiters)resolve();void emit('global_'+key+'_initialized')},
  waitGlobalInitialized(meta,name){touch('globals.preview-session',{implementationStatus:'IMPLEMENTED',parityStatus:'VERIFIED',parityEvidence:[{kind:'BLACK_BOX',reference:'TavernHelper',version:'4.9.3',locator:'fixture-global-semantics-2026-08-29'}],source:'preview-session'});const key=String(name||'').trim();if(!key)return Promise.reject(new TypeError('Global name is required'));if(globals.has(key))return Promise.resolve();return new Promise(resolve=>{const waiters=globalWaiters.get(key)||[];waiters.push(resolve);globalWaiters.set(key,waiters)})},
  eventOff(meta,type,listener){touch('events.preview-session');off(type,listener)},
  getCurrentCharacterName(){touch('character.current');return context.characterContextAvailable?context.charName:undefined},getCurrentCharacterId(){touch('character.current');return context.characterContextAvailable?0:-1},
  getCharacter(){touch('character.current');return context.characterContextAvailable?clone(context.characterData):undefined},getCharData(){touch('character.current');return context.characterContextAvailable?clone(context.characterData):undefined},
  formatAsDisplayedMessage(meta,value,options={}){touch('message.format');const source=String(value??(context.messageContextAvailable?message().message:''));const requested=options?.message_id??'last';if(requested==='last_user')throw new Error('No user message exists in the opening PreviewSession');if(requested!=='last'&&requested!=='last_char'&&Number(requested)!==0&&Number(requested)!==-1)throw new RangeError('Preview format message_id is outside [-1, 0]: '+String(requested));const index=context.messageContextAvailable?context.greetings.indexOf(source):-1;if(index>=0)return context.formattedGreetings[index]||'';touch('message.format',{implementationStatus:'PARTIAL',parityStatus:'UNVERIFIED',source:'SillyTavernMessageFormatter',failureReason:'dynamic source is not precomputed inside the isolated synchronous boundary',impact:'dynamic input is returned synchronously as source text'});return source},
  retrieveDisplayedMessage(meta,messageId){touch('message.displayed-dom',{implementationStatus:'IMPLEMENTED',parityStatus:'UNVERIFIED',source:'isolated-preview-dom',failureReason:'only the current opening preview DOM exists',impact:'message ids absent from the preview return an empty JQuery collection'});return Number(messageId)},
  };
  const mvuEvents={VARIABLE_INITIALIZED:'mag_variable_initialized',VARIABLE_UPDATE_STARTED:'mag_variable_update_started',VARIABLE_UPDATE_ENDED:'mag_variable_update_ended',BEFORE_MESSAGE_UPDATE:'mag_before_message_update',SINGLE_VARIABLE_UPDATED:'mag_variable_updated'};
${buildRenderCompatibilityScriptHost()}
  const requireMvu=options=>{const target=options||{type:'message',message_id:'latest'};const data=archived?api.getVariables({},target):variableTarget(target,{});if(!data||typeof data!=='object'||!data.stat_data||!data.schema)throw new Error('MVU Opening Preview State is unavailable');return data};
  const archivedMvu=archived?.data&&typeof archived.data.stat_data==='object'&&archived.data.stat_data!==null&&!Array.isArray(archived.data.stat_data)&&typeof archived.data.schema==='object'&&archived.data.schema!==null&&!Array.isArray(archived.data.schema);
  const mvu=(archived?archivedMvu:context.mvuRecognized)?Object.freeze({events:Object.freeze(mvuEvents),getMvuData:(options={type:'message',message_id:'latest'})=>clone(requireMvu(options)),replaceMvuData:async(data,options={type:'message',message_id:'latest'})=>{if(archived)throw new Error('Archived chat snapshots are read-only');if(!data||typeof data!=='object'||!data.stat_data||!data.schema)throw new TypeError('Invalid MvuData');await emit(mvuEvents.VARIABLE_UPDATE_STARTED,clone(data));api.replaceVariables({},data,options);await emit(mvuEvents.VARIABLE_UPDATE_ENDED,clone(data));return clone(data)},getCurrentMvuData:()=>clone(requireMvu({type:'message',message_id:'latest'})),replaceCurrentMvuData:async data=>mvu.replaceMvuData(data,{type:'message',message_id:'latest'}),getMvuVariable:(data,path,options={})=>clone(mvuPath(mvuRecord(data,options?.category||'stat'),path,options?.default_value)),getRecordFromMvuData:(data,category)=>clone(mvuRecord(data,category))}):undefined;
  if(mvu){touch(archived?'mvu.archived-snapshot':'mvu.opening-preview',{implementationStatus:'PARTIAL',parityStatus:'UNVERIFIED',source:'preview-session',failureReason:archived?'only the saved reply is available':[...context.mvuErrors,...context.unsupportedMvuOpeningUpdates].join('; ')||'only opening initialization is implemented',impact:archived?'archived MVU data is read-only; initialization and updates are unavailable':'generation-time MVU lifecycle remains unavailable'});api.initializeGlobal({},'Mvu',mvu);if(!archived)void emit(mvuEvents.VARIABLE_INITIALIZED,clone(context.swipesData[context.greetingIndex]),context.greetingIndex)}
  let disposed=false;let handleHostMessage;let handlePagehide;let boot;
  if(archived){
    const selected=value=>value===undefined||value==='latest'||Number(value)===archived.message_id||Number(value)===archived.message_id-archived.last_message_id-1;
    const snapshot=()=>{const {last_message_id,...message}=archived;return clone(message)};
    api.getCurrentMessageId=()=>archived.message_id;
    api.getMessageId=()=>archived.message_id;
    api.getLastMessageId=()=>archived.last_message_id;
    api.getChatMessages=(_meta,range='0-{{lastMessageId}}',options={})=>{
      const text=String(range).replaceAll('{{lastMessageId}}',String(archived.last_message_id));
      const ids=text.match(/^(-?\\d+)(?:-(-?\\d+))?$/);
      if(!ids)return[];
      const resolve=id=>Number(id)<0?archived.last_message_id+1+Number(id):Number(id);
      const start=resolve(ids[1]),end=resolve(ids[2]??ids[1]);
      if(archived.message_id<Math.min(start,end)||archived.message_id>Math.max(start,end))return[];
      if(options.role&&options.role!=='all'&&options.role!==archived.role)return[];
      if(options.hide_state&&options.hide_state!=='all'&&options.hide_state!==(archived.is_hidden?'hidden':'unhidden'))return[];
      if(options.include_swipes)throw new Error('Archived preview exposes only the saved reply');
      return[snapshot()];
    };
    api.getVariables=(meta,options={})=>{
      if(options.type==='script'&&meta.scriptId&&(!options.script_id||options.script_id===meta.scriptId))return clone(meta.scriptData||{});
      if(options.type!=='message'||!selected(options.message_id))throw new Error('Only this archived floor has a variable snapshot');
      return clone(archived.data);
    };
    api.getAllVariables=()=>clone(archived.data);
    for(const name of ['setChatMessages','setChatMessage','replaceVariables','updateVariablesWith','insertVariables','insertOrAssignVariables','deleteVariable'])api[name]=()=>{throw new Error('Archived chat snapshots are read-only')};
  }
  const host={registerScript,protocol,events:tavernEvents,diagnostics:()=>clone([...diagnostics.values()]),getInitializedGlobal(name){return globals.get(String(name))},invoke(name,args=[],meta={}){if(disposed)throw new Error('Preview host has been disposed');const fn=api[name];if(typeof fn!=='function'){touch(String(name),{implementationStatus:'UNSUPPORTED',parityStatus:'UNSUPPORTED_HOST_BOUND',source:'capability-boundary',failureReason:'API is not available in the SRL preview host',impact:'the calling script may be partial'});throw new Error('Unsupported host capability: '+String(name))}return fn(meta,...args)},subscribe(type,listener,owner,once=false){if(disposed)return{stop(){}};return on(type,listener,owner,once)},emit(type,args=[]){return disposed?Promise.resolve():emit(type,...args)},transitionSwipe,detach(owner){const owned=subscriptions.get(owner);if(!owned)return;for(const [type,list] of listeners)listeners.set(type,list.filter(item=>!owned.has(item)));subscriptions.delete(owner)},teardown(){if(disposed)return;disposed=true;window.removeEventListener('message',handleHostMessage);window.removeEventListener('pagehide',handlePagehide);document.removeEventListener('DOMContentLoaded',boot);for(const waiters of swipeTransitionWaiters.values())for(const resolve of waiters)resolve(false);swipeTransitionWaiters.clear();for(const waiters of globalWaiters.values())for(const resolve of waiters)resolve(undefined);globalWaiters.clear();globals.clear();listeners.clear();subscriptions.clear();scriptRegistry.clear();books.clear();if(window.__SRL_RENDER_COMPAT_HOST__===host)delete window.__SRL_RENDER_COMPAT_HOST__;if(window.tavern_events===tavernEvents)delete window.tavern_events},context(){return{chat:context.messageContextAvailable?[clone(message())]:[],characters:context.characterContextAvailable?[clone(context.characterData)]:[],characterId:context.characterContextAvailable?0:-1,eventSource:{emit:(type,...args)=>emit(type,...args)}}}};
Object.defineProperty(window,'__SRL_RENDER_COMPAT_HOST__',{configurable:true,value:host});window.tavern_events=tavernEvents;
  const expected=${Math.max(0, Math.trunc(expectedFrameCount))};const ready=new Set();let booted=false;
 handleHostMessage=event=>{if(disposed)return;const data=event.data;if(!data||data.protocol!==protocol)return;if(data.type===control.swipeTransition&&event.source===window.parent){void(async()=>{if(await transitionSwipe(data.target,false,data.rendered))await emit(tavernEvents.CHARACTER_MESSAGE_RENDERED,0)})();return}if(data.type==='SRL_SCRIPT_BUTTON_CLICK'&&event.source===window.parent){const item=scriptRegistry.get(String(data.scriptId));if(item?.buttons.some(button=>button.visible&&button.name===data.name))void emit(buttonEvent(item.id,data.name));return}if(data.type!==control.frameReady)return;ready.add(String(data.frameId||ready.size));if(!booted&&ready.size>=expected){booted=true;void(async()=>{await selectInitialFirstMessage();await emit(tavernEvents.CHARACTER_MESSAGE_RENDERED,archived?.message_id??0)})()}};
  boot=()=>{if(disposed)return;void emit(tavernEvents.APP_READY);if(expected===0)booted=true};handlePagehide=()=>host.teardown();window.addEventListener('message',handleHostMessage);window.addEventListener('pagehide',handlePagehide,{once:true});if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();</script>`
}

export function buildRenderCompatibilityChildAdapter(
  script?: Pick<
    PreviewRuntimeScript,
    'id' | 'name' | 'source' | 'data' | 'buttons' | 'buttonDefinitions' | 'info'
  >,
  options: { hostScope?: 'parent' | 'self' } = {},
): string {
  const metadata = scriptJson(
    script
      ? {
          id: script.id,
          name: script.name,
          source: script.source,
          data: script.data ?? {},
          buttons: script.buttonDefinitions ?? script.buttons ?? [],
          info: script.info ?? '',
        }
      : {},
  )
  const hostOwner = options.hostScope === 'self' ? 'window' : 'window.parent'
  const displayedDocument = options.hostScope === 'self' ? 'document' : 'window.parent.document'
  const readyTarget = options.hostScope === 'self' ? 'window' : 'parent'
  return `<script>(()=>{'use strict';
const host=${hostOwner}.__SRL_RENDER_COMPAT_HOST__;if(!host)throw new Error('SRL Render Compatibility Host is unavailable');
  const meta=${metadata};host.registerScript({scriptId:meta.id,scriptName:meta.name,scriptButtons:meta.buttons,scriptInfo:meta.info});const invoke=(name,...args)=>host.invoke(name,args,{scriptId:meta.id,scriptName:meta.name,scriptData:meta.data,frameName:window.name});
  // Hidden companion iframes do not receive animation frames; their UI lives in the visible isolated parent.
  const animationFrames=new Set();const originalAnimationFrame=window.requestAnimationFrame;const originalCancelAnimationFrame=window.cancelAnimationFrame;
  const animationOwner=meta.id&&${hostOwner}!==window?${hostOwner}:null;
  if(animationOwner&&typeof animationOwner.requestAnimationFrame==='function'&&typeof animationOwner.cancelAnimationFrame==='function'){
    window.requestAnimationFrame=callback=>{if(typeof callback!=='function')throw new TypeError('Animation callback must be a function');let id;id=animationOwner.requestAnimationFrame(time=>{animationFrames.delete(id);callback.call(window,time)});animationFrames.add(id);return id};
    window.cancelAnimationFrame=id=>{animationFrames.delete(id);animationOwner.cancelAnimationFrame(id)};
  }
  const exposedGlobals=new Set();const exposeGlobal=(name,value)=>{const key=String(name);exposedGlobals.add(key);Object.defineProperty(window,key,{configurable:true,get:()=>value});return value};
  const retrieveDisplayedMessage=messageId=>{const normalized=invoke('retrieveDisplayedMessage',messageId);return window.$('#chat > .mes[mesid = "'+normalized+'"]',${displayedDocument}).find('div.mes_text')};
  const errorCatched=fn=>{const onError=error=>{const value=error instanceof Error?error:new Error(String(error));try{window.toastr?.error('<pre style="white-space: pre-wrap">'+String(value.stack||value.message)+'</pre>',value.name,{escapeHtml:false,toastClass:'toastr w-fit! min-w-[300px]'})}catch{}throw error};return(...args)=>{try{const result=fn(...args);return result&&typeof result.then==='function'?result.then(undefined,onError):result}catch(error){return onError(error)}}};
  const scriptApiNames=['getScriptName','getScriptInfo','getButtonEvent','getScriptButtons','replaceScriptButtons','updateScriptButtonsWith','appendInexistentScriptButtons','getWorldbookNames','getCharWorldbookNames','getWorldbook','createWorldbook','createOrReplaceWorldbook','replaceWorldbook','updateWorldbookWith','createWorldbookEntries','deleteWorldbookEntries','getLorebookEntries','setLorebookEntries','deleteLorebookEntries','getTavernRegexes','replaceTavernRegexes','triggerSlash'];
const scriptApis=Object.fromEntries(scriptApiNames.map(name=>[name,(...args)=>invoke(name,...args)]));
const api={...scriptApis,getChatMessages:(...args)=>invoke('getChatMessages',...args),setChatMessages:(...args)=>invoke('setChatMessages',...args),setChatMessage:(...args)=>invoke('setChatMessage',...args),getLastMessageId:(...args)=>invoke('getLastMessageId',...args),getIframeName:(...args)=>invoke('getIframeName',...args),getScriptId:(...args)=>invoke('getScriptId',...args),getCurrentMessageId:(...args)=>invoke('getCurrentMessageId',...args),getMessageId:(...args)=>invoke('getMessageId',...args),getVariables:(...args)=>invoke('getVariables',...args),getAllVariables:(...args)=>invoke('getAllVariables',...args),replaceVariables:(...args)=>invoke('replaceVariables',...args),setVariables:(...args)=>invoke('replaceVariables',...args),updateVariablesWith:(...args)=>invoke('updateVariablesWith',...args),insertOrAssignVariables:(...args)=>invoke('insertOrAssignVariables',...args),insertVariables:(...args)=>invoke('insertVariables',...args),deleteVariable:(...args)=>invoke('deleteVariable',...args),initializeGlobal:(name,value)=>{invoke('initializeGlobal',name,value);exposeGlobal(name,value)},waitGlobalInitialized:async name=>{await invoke('waitGlobalInitialized',name);exposeGlobal(name,host.getInitializedGlobal(name))},getCurrentCharacterName:(...args)=>invoke('getCurrentCharacterName',...args),getCurrentCharacterId:(...args)=>invoke('getCurrentCharacterId',...args),getCharacter:(...args)=>invoke('getCharacter',...args),getCharData:(...args)=>invoke('getCharData',...args),formatAsDisplayedMessage:(...args)=>invoke('formatAsDisplayedMessage',...args),retrieveDisplayedMessage,errorCatched,eventOn:(type,listener)=>host.subscribe(type,listener,window,false),eventOnce:(type,listener)=>host.subscribe(type,listener,window,true),eventOff:(type,listener)=>host.invoke('eventOff',[type,listener]),eventEmit:(type,...args)=>host.emit(type,args)};
Object.assign(window,api);window.tavern_events=host.events;window.TavernHelper=Object.freeze({...api,tavern_events:host.events,eventEmitAndWait:api.eventEmit,eventRemoveListener:api.eventOff});window.tavern_helper=window.TavernHelper;
const inheritedMvu=host.getInitializedGlobal('Mvu');if(inheritedMvu!==undefined)exposeGlobal('Mvu',inheritedMvu);
const getContext=()=>({...host.context(),...api,eventSource:{on:api.eventOn,once:api.eventOnce,off:api.eventOff,emit:api.eventEmit}});Object.defineProperty(window,'SillyTavern',{configurable:true,value:Object.freeze({getContext,isMobile:()=>matchMedia('(pointer: coarse)').matches||/Android|iPhone|iPad/i.test(navigator.userAgent)})});
 window.__SRL_SCRIPT_META__=meta;const injectedGlobals=[...Object.keys(api),'tavern_events','TavernHelper','tavern_helper','SillyTavern','__SRL_SCRIPT_META__'];const cleanup=()=>{for(const id of animationFrames)animationOwner?.cancelAnimationFrame(id);animationFrames.clear();window.requestAnimationFrame=originalAnimationFrame;window.cancelAnimationFrame=originalCancelAnimationFrame;host.detach(window);for(const name of [...injectedGlobals,...exposedGlobals]){try{delete window[name]}catch{}};exposedGlobals.clear()};window.addEventListener('pagehide',cleanup,{once:true});window.addEventListener('load',()=>${readyTarget}.postMessage({protocol:host.protocol,type:'${RENDER_COMPATIBILITY_EVENTS.frameReady}',frameId:window.frameElement?.id||window.name},'*'),{once:true});
})();</script>`
}
