import { computed, nextTick, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { usePreviewPolicy } from '../composables/UsePreviewPolicy'
import { RESOURCE_TYPE, type Resource, type ResourceSummary } from '../types/Resource'
import { parseGreetingMetadata } from '../utils/GreetingMetadata'
import { listPresetPromptEntries } from '../utils/PresetStitcher'
import { summarizeRegexEffect, type RegexEffectSummary } from '../utils/RegexEffectPreview'
import {
  buildRegexPreviewDocument,
  hasBlockedRegexPreviewContent,
} from '../utils/RegexStaticPreview'
import { isRecord } from '../utils/UnknownValue'
import { readWorldBookEntries } from '../utils/WorldBookEntries'

export type StructuredResourceDetailsProps = {
  resource: Resource
  relatedResources?: ResourceSummary[]
  disabled?: boolean
}

export type PresetPage = 'overview' | 'prompts' | 'regex'

export interface RegexScriptView {
  id: string
  scope: string
  name: string
  find: string
  replace: string
  placements: string[]
  disabled: boolean
  effect: RegexEffectSummary
  previewDocument: string
}

export interface DetailValue {
  label: string
  value: string
}

export interface HelperScriptView {
  id: string
  folder: string
  name: string
  info: string
  content: string
  enabled: boolean
  buttons: string[]
  dataCount: number
  exportData: boolean
  exportButtons: boolean
}

export function useStructuredResourceDetails(props: Readonly<StructuredResourceDetailsProps>) {
  const previewPolicy = usePreviewPolicy()

  const rawContent = shallowRef<unknown>()

  const rawError = shallowRef('')

  const regexQuery = ref('')

  const regexFilter = ref<'all' | 'enabled' | 'disabled' | 'html'>('all')

  const regexPage = ref(1)

  const selectedRegexScriptId = ref('')

  const greetingPreviewIndex = ref<number | null>(null)

  let greetingPreviewTrigger: HTMLElement | undefined

  const REGEX_PAGE_SIZE = 10

  const REGEX_FILTERS = [
    { id: 'all', label: '全部' },
    { id: 'enabled', label: '已启用' },
    { id: 'disabled', label: '已停用' },
    { id: 'html', label: 'HTML / CSS' },
  ] as const

  const structuredRoot = useTemplateRef<HTMLElement>('structuredRoot')

  const presetPage = ref<PresetPage>('overview')

  const presetPromptQuery = ref('')

  const presetPromptPage = ref(1)

  const selectedPresetPromptId = ref('')

  const PRESET_PROMPT_PAGE_SIZE = 10

  let loadGeneration = 0

  function readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
  }

  function readStringArray(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
    }
    const single = readString(value)
    return single
      ? single
          .split(/[,，]/)
          .map((item) => item.trim())
          .filter(Boolean)
      : []
  }

  function formatSimpleValue(value: unknown): string {
    if (typeof value === 'boolean') return value ? '开启' : '关闭'
    if (typeof value === 'number') return String(value)
    if (typeof value === 'string') return value || '空字符串'
    if (Array.isArray(value)) return `${value.length} 项`
    if (isRecord(value)) return `${Object.keys(value).length} 个字段`
    return value == null ? '未设置' : String(value)
  }

  watch(
    () => `${props.resource.id}:${props.resource.contentHash}`,
    async () => {
      const resource = props.resource
      const generation = ++loadGeneration
      rawContent.value = undefined
      rawError.value = ''
      regexQuery.value = ''
      regexFilter.value = 'all'
      regexPage.value = 1
      selectedRegexScriptId.value = ''
      greetingPreviewIndex.value = null
      presetPage.value = 'overview'
      presetPromptQuery.value = ''
      presetPromptPage.value = 1
      selectedPresetPromptId.value = ''
      try {
        const text = await resource.originalBlob.text()
        const isJson = resource.fileName.toLocaleLowerCase().endsWith('.json')
        const value: unknown = isJson ? JSON.parse(text) : text
        if (generation === loadGeneration) rawContent.value = value
      } catch {
        if (generation === loadGeneration) rawError.value = '原始内容读取失败，仍可下载文件后查看。'
      }
    },
    { immediate: true },
  )

  const rootRecord = computed(() => (isRecord(rawContent.value) ? rawContent.value : undefined))

  const worldEntries = computed(() => readWorldBookEntries(rootRecord.value?.entries))

  const REGEX_PLACEMENTS: Record<number, string> = {
    0: 'Markdown 显示（旧版）',
    1: '用户输入',
    2: 'AI 输出',
    3: '斜杠命令',
    5: '世界书',
    6: '推理内容',
  }

  const REGEX_EFFECT_LABELS: Record<RegexEffectSummary['kind'], string> = {
    delete: '删除内容',
    html: 'HTML / CSS',
    dynamic: '动态脚本',
    capture: '捕获替换',
    text: '文本替换',
  }

  function regexEffectLabel(effect: RegexEffectSummary): string {
    return REGEX_EFFECT_LABELS[effect.kind]
  }

  function toRegexScript(
    value: unknown,
    scope: string,
    index: number,
  ): RegexScriptView | undefined {
    if (typeof value === 'string') {
      return {
        id: `${scope}-${index}`,
        scope,
        name: value,
        find: '',
        replace: '',
        placements: [],
        disabled: false,
        effect: summarizeRegexEffect('', value),
        previewDocument: '',
      }
    }
    if (!isRecord(value)) return undefined
    const find = readString(value.findRegex ?? value.find_regex)
    const replace = readString(value.replaceString ?? value.replace_string)
    const source = isRecord(value.source) ? value.source : undefined
    const destination = isRecord(value.destination) ? value.destination : undefined
    const name =
      readString(value.scriptName ?? value.script_name ?? value.name) || `正则 ${index + 1}`
    const effect = summarizeRegexEffect(find, replace)
    const helperPlacements = source
      ? [
          source.user_input === true ? '用户输入' : '',
          source.ai_output === true ? 'AI 输出' : '',
          source.slash_command === true ? '斜杠命令' : '',
          source.world_info === true ? '世界书' : '',
          source.reasoning === true ? '推理内容' : '',
          destination?.display === true ? '显示文本' : '',
          destination?.prompt === true ? '发送提示词' : '',
        ].filter(Boolean)
      : []
    return {
      id: readString(value.id) || `${scope}-${index}`,
      scope: readString(value.scope) || scope,
      name,
      find,
      replace,
      placements: Array.isArray(value.placement)
        ? value.placement.map((item) => REGEX_PLACEMENTS[Number(item)] ?? `位置 ${String(item)}`)
        : helperPlacements,
      disabled: value.disabled === true || value.enabled === false,
      effect,
      previewDocument: buildRegexPreviewDocument(effect, name, replace, previewPolicy.value),
    }
  }

  const regexScripts = computed<RegexScriptView[]>(() => {
    const content = rawContent.value
    if (Array.isArray(content)) {
      return content.flatMap((item, index) => {
        const script = toRegexScript(item, '正则集合', index)
        return script ? [script] : []
      })
    }
    if (!isRecord(content)) return []
    if (props.resource.type === RESOURCE_TYPE.PRESET) {
      const extensions = isRecord(content.extensions) ? content.extensions : undefined
      const scripts = Array.isArray(extensions?.regex_scripts) ? extensions.regex_scripts : []
      return scripts.flatMap((item, index) => {
        const script = toRegexScript(item, '预设', index)
        return script ? [script] : []
      })
    }
    if (typeof content.findRegex === 'string' || typeof content.find_regex === 'string') {
      const script = toRegexScript(content, '单条脚本', 0)
      return script ? [script] : []
    }

    const groups: Array<[string, unknown]> = [
      ['全局', content.global],
      ['角色', content.scoped],
      ['预设', content.preset],
    ]
    return groups.flatMap(([scope, values]) =>
      Array.isArray(values)
        ? values.flatMap((item, index) => {
            const script = toRegexScript(item, scope, index)
            return script ? [script] : []
          })
        : [],
    )
  })

  const filteredRegexScripts = computed(() => {
    const query = regexQuery.value.trim().toLocaleLowerCase()
    return regexScripts.value.filter((script) => {
      const matchesFilter =
        regexFilter.value === 'all' ||
        (regexFilter.value === 'enabled' && !script.disabled) ||
        (regexFilter.value === 'disabled' && script.disabled) ||
        (regexFilter.value === 'html' && script.effect.kind === 'html')
      if (!matchesFilter) return false
      if (!query) return true
      return [
        script.name,
        script.scope,
        script.find,
        script.replace,
        script.effect.explanation,
        ...script.placements,
      ]
        .join('\n')
        .toLocaleLowerCase()
        .includes(query)
    })
  })

  const regexPageCount = computed(() =>
    Math.max(1, Math.ceil(filteredRegexScripts.value.length / REGEX_PAGE_SIZE)),
  )

  const pagedRegexScripts = computed(() => {
    const start = (regexPage.value - 1) * REGEX_PAGE_SIZE
    return filteredRegexScripts.value.slice(start, start + REGEX_PAGE_SIZE)
  })

  const selectedRegexScript = computed(() =>
    regexScripts.value.find((script) => script.id === selectedRegexScriptId.value),
  )

  const selectedRegexStatus = computed(() => {
    const script = selectedRegexScript.value
    return script ? `${script.scope} · ${script.disabled ? '已停用' : '已启用'}` : ''
  })

  const regexPageLabel = computed(
    () =>
      `第 ${regexPage.value} / ${regexPageCount.value} 页 · ${filteredRegexScripts.value.length} 条`,
  )

  watch([regexQuery, regexFilter], () => {
    regexPage.value = 1
    selectedRegexScriptId.value = ''
  })

  watch(regexPageCount, (count) => {
    if (regexPage.value > count) regexPage.value = count
  })

  function selectRegexScript(script: RegexScriptView): void {
    selectedRegexScriptId.value = script.id
    scrollToStructuredTop()
  }

  function closeRegexScript(): void {
    selectedRegexScriptId.value = ''
  }

  function changeRegexPage(offset: number): void {
    regexPage.value = Math.min(regexPageCount.value, Math.max(1, regexPage.value + offset))
    scrollToStructuredTop()
  }

  const samplerValues = computed<DetailValue[]>(() => {
    const record = rootRecord.value
    if (!record) return []
    const fields: Array<[string, string]> = [
      ['temperature', '随机度 Temperature'],
      ['top_p', 'Top P'],
      ['top_k', 'Top K'],
      ['min_p', 'Min P'],
      ['repetition_penalty', '重复惩罚'],
      ['frequency_penalty', '频率惩罚'],
      ['presence_penalty', '存在惩罚'],
      ['openai_max_context', '上下文长度'],
      ['openai_max_tokens', '最大回复长度'],
    ]
    return fields
      .filter(([key]) => record[key] != null)
      .map(([key, label]) => ({ label, value: formatSimpleValue(record[key]) }))
  })

  const presetPrompts = computed(() => {
    const preset = rootRecord.value
    if (!preset) return []
    return listPresetPromptEntries(preset).map(({ prompt, enabled }, index) => ({
      id: readString(prompt.identifier ?? prompt.id) || String(index),
      name: readString(prompt.name) || `提示词 ${index + 1}`,
      role: readString(prompt.role) || '未指定角色',
      content: readString(prompt.content ?? prompt.prompt),
      enabled,
    }))
  })

  const filteredPresetPrompts = computed(() => {
    const query = presetPromptQuery.value.trim().toLocaleLowerCase()
    if (!query) return presetPrompts.value
    return presetPrompts.value.filter((prompt) =>
      [prompt.name, prompt.role, prompt.content].join('\n').toLocaleLowerCase().includes(query),
    )
  })

  const presetPromptPageCount = computed(() =>
    Math.max(1, Math.ceil(filteredPresetPrompts.value.length / PRESET_PROMPT_PAGE_SIZE)),
  )

  const pagedPresetPrompts = computed(() => {
    const start = (presetPromptPage.value - 1) * PRESET_PROMPT_PAGE_SIZE
    return filteredPresetPrompts.value.slice(start, start + PRESET_PROMPT_PAGE_SIZE)
  })

  const selectedPresetPrompt = computed(() =>
    presetPrompts.value.find((prompt) => prompt.id === selectedPresetPromptId.value),
  )

  watch(presetPromptQuery, () => {
    presetPromptPage.value = 1
    selectedPresetPromptId.value = ''
  })

  watch(presetPromptPageCount, (count) => {
    if (presetPromptPage.value > count) presetPromptPage.value = count
  })

  function scrollToStructuredTop(): void {
    nextTick(() => structuredRoot.value?.scrollIntoView({ block: 'start', behavior: 'smooth' }))
  }

  function openPresetPage(page: Exclude<PresetPage, 'overview'>): void {
    presetPage.value = page
    selectedPresetPromptId.value = ''
    selectedRegexScriptId.value = ''
    scrollToStructuredTop()
  }

  function closePresetPage(): void {
    if (selectedPresetPromptId.value) {
      selectedPresetPromptId.value = ''
      scrollToStructuredTop()
      return
    }
    if (selectedRegexScriptId.value) {
      selectedRegexScriptId.value = ''
      scrollToStructuredTop()
      return
    }
    presetPage.value = 'overview'
    scrollToStructuredTop()
  }

  function changePresetPromptPage(offset: number): void {
    presetPromptPage.value = Math.min(
      presetPromptPageCount.value,
      Math.max(1, presetPromptPage.value + offset),
    )
    scrollToStructuredTop()
  }

  function selectPresetPrompt(id: string): void {
    selectedPresetPromptId.value = id
    scrollToStructuredTop()
  }

  const presetTemplates = computed<DetailValue[]>(() => {
    const record = rootRecord.value
    if (!record) return []
    const fields: Array<[string, string]> = [
      ['story_string', '故事串模板'],
      ['input_sequence', '输入序列'],
      ['output_sequence', '输出序列'],
      ['system_sequence', '系统序列'],
      ['example_separator', '示例分隔符'],
    ]
    return fields
      .map(([key, label]) => ({ label, value: readString(record[key]) }))
      .filter((item) => item.value)
  })

  const quickReplies = computed(() => {
    const values = rootRecord.value?.qrList
    if (!Array.isArray(values)) return []
    return values.filter(isRecord).map((item, index) => ({
      id: readString(item.id) || String(index),
      label: readString(item.label ?? item.name) || `快速回复 ${index + 1}`,
      message: readString(item.message ?? item.content),
      enabled: item.isHidden !== true && item.disabled !== true,
    }))
  })

  const standaloneGreetings = computed(() => {
    const record = rootRecord.value
    if (!record) return []
    const primary = readString(record.first_mes ?? record.firstMessage ?? record.opening_message)
    const alternates = readStringArray(record.alternate_greetings ?? record.greetings)
    const toGreeting = (message: string, id: string, fallbackLabel: string) => {
      const parsed = parseGreetingMetadata(message)
      return {
        id,
        label: parsed.title || fallbackLabel,
        message: parsed.content,
        description: parsed.description,
        group: parsed.group,
        theme: parsed.theme,
      }
    }
    return [
      ...(primary ? [toGreeting(primary, 'primary', '主开场')] : []),
      ...alternates.map((message, index) =>
        toGreeting(message, `alternate-${index}`, `备用开场 ${String(index + 1).padStart(2, '0')}`),
      ),
    ]
  })

  const greetingPreviewItems = computed(() =>
    standaloneGreetings.value.map((item) => ({
      key: item.id,
      label: item.label,
      content: item.message,
      description: item.description,
      group: item.group,
      theme: item.theme,
    })),
  )

  function openGreetingPreview(index: number, event?: Event): void {
    if (!standaloneGreetings.value.length) return
    const target = event?.currentTarget
    greetingPreviewTrigger = target instanceof HTMLElement ? target : undefined
    greetingPreviewIndex.value = Math.min(standaloneGreetings.value.length - 1, Math.max(0, index))
  }

  function handleGreetingPreviewClose(): void {
    nextTick(() => greetingPreviewTrigger?.focus({ preventScroll: true }))
  }

  const scriptText = computed(
    () => readString(rootRecord.value?.script) || readString(rootRecord.value?.content),
  )

  function toHelperScript(
    value: unknown,
    index: number,
    folder = '',
  ): HelperScriptView | undefined {
    if (!isRecord(value)) return undefined
    const hasTypedShape = value.type === 'script'
    const hasLegacyShape =
      typeof value.id === 'string' &&
      typeof value.name === 'string' &&
      typeof value.content === 'string' &&
      (typeof value.info === 'string' || Array.isArray(value.buttons))
    if (!hasTypedShape && !hasLegacyShape) return undefined

    const button = isRecord(value.button) ? value.button : undefined
    const buttonValues = Array.isArray(button?.buttons)
      ? button.buttons
      : Array.isArray(value.buttons)
        ? value.buttons
        : []
    const exportWith = isRecord(value.export_with) ? value.export_with : undefined
    return {
      id: readString(value.id) || `${folder}-${index}`,
      folder,
      name: readString(value.name) || `酒馆助手脚本 ${index + 1}`,
      info: readString(value.info),
      content: readString(value.content),
      enabled: value.enabled !== false,
      buttons: buttonValues
        .filter(isRecord)
        .map((item) => readString(item.name))
        .filter(Boolean),
      dataCount: isRecord(value.data) ? Object.keys(value.data).length : 0,
      exportData: exportWith?.data !== false,
      exportButtons: exportWith?.button !== false,
    }
  }

  function flattenHelperTrees(values: unknown[]): HelperScriptView[] {
    return values.flatMap((tree, treeIndex) => {
      if (!isRecord(tree)) return []
      if (tree.type === 'folder' && Array.isArray(tree.scripts)) {
        const folder = readString(tree.name) || `文件夹 ${treeIndex + 1}`
        return tree.scripts.flatMap((script, scriptIndex) => {
          const view = toHelperScript(script, scriptIndex, folder)
          return view ? [view] : []
        })
      }
      const view = toHelperScript(tree, treeIndex)
      return view ? [view] : []
    })
  }

  const helperScripts = computed<HelperScriptView[]>(() => {
    const content = rawContent.value
    if (Array.isArray(content)) return flattenHelperTrees(content)
    if (!isRecord(content)) return []

    const extensions = isRecord(content.extensions) ? content.extensions : undefined
    const helperExtension = isRecord(extensions?.tavern_helper)
      ? extensions.tavern_helper
      : undefined
    const scriptSettings = isRecord(content.script) ? content.script : undefined
    const sources = [
      Array.isArray(content.scripts) ? content.scripts : [],
      Array.isArray(scriptSettings?.scripts) ? scriptSettings.scripts : [],
      Array.isArray(helperExtension?.scripts) ? helperExtension.scripts : [],
    ]
    const direct = toHelperScript(content, 0)
    return [...(direct ? [direct] : []), ...sources.flatMap(flattenHelperTrees)]
  })

  function helperScriptLocation(script: HelperScriptView): string {
    return `${script.folder ? `${script.folder} · ` : ''}${script.enabled ? '启用' : '停用'}`
  }

  function helperScriptExport(script: HelperScriptView, owner: '预设' | '资源'): string {
    const data = script.exportData ? '数据' : '不含数据'
    const buttons = script.exportButtons ? '按钮' : '不含按钮'
    return `随${owner}导出 · ${data} / ${buttons}`
  }

  const genericValues = computed<DetailValue[]>(() => {
    const record = rootRecord.value
    if (!record) return []
    return Object.entries(record)
      .filter(([key]) => !['content', 'script', 'entries', 'prompts', 'qrList'].includes(key))
      .slice(0, 30)
      .map(([label, value]) => ({ label, value: formatSimpleValue(value) }))
  })

  const recordCountLabel = computed(() => {
    if (props.resource.type === RESOURCE_TYPE.WORLD_BOOK)
      return `${worldEntries.value.length} 个条目`
    if (props.resource.type === RESOURCE_TYPE.REGEX) return `${regexScripts.value.length} 条逻辑`
    if (props.resource.type === RESOURCE_TYPE.PRESET) {
      return `${presetPrompts.value.length} 段提示词 · ${regexScripts.value.length} 条正则`
    }
    if (props.resource.type === RESOURCE_TYPE.SCRIPT && helperScripts.value.length)
      return `${helperScripts.value.length} 个酒馆助手脚本`
    return ''
  })

  const hasPresetContent = computed(
    () =>
      samplerValues.value.length > 0 ||
      presetPrompts.value.length > 0 ||
      presetTemplates.value.length > 0 ||
      helperScripts.value.length > 0 ||
      regexScripts.value.length > 0,
  )
  return {
    rawContent,
    RESOURCE_TYPE,
    presetPage,
    recordCountLabel,
    rawError,
    worldEntries,
    selectedRegexScript,
    closeRegexScript,
    selectedRegexStatus,
    regexEffectLabel,
    previewPolicy,
    hasBlockedRegexPreviewContent,
    regexQuery,
    REGEX_FILTERS,
    regexFilter,
    pagedRegexScripts,
    selectRegexScript,
    regexPage,
    REGEX_PAGE_SIZE,
    regexScripts,
    filteredRegexScripts,
    changeRegexPage,
    regexPageLabel,
    regexPageCount,
    presetPrompts,
    samplerValues,
    openPresetPage,
    presetTemplates,
    helperScripts,
    helperScriptLocation,
    helperScriptExport,
    hasPresetContent,
    selectedPresetPrompt,
    closePresetPage,
    presetPromptQuery,
    pagedPresetPrompts,
    selectPresetPrompt,
    presetPromptPage,
    PRESET_PROMPT_PAGE_SIZE,
    filteredPresetPrompts,
    changePresetPromptPage,
    presetPromptPageCount,
    standaloneGreetings,
    openGreetingPreview,
    quickReplies,
    scriptText,
    genericValues,
    greetingPreviewIndex,
    greetingPreviewItems,
    handleGreetingPreviewClose,
  }
}
