<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import FeatureAppHeader from './FeatureAppHeader.vue'
import {
  createFrontendWorkshopSourceDelivery,
  createFrontendWorkshopSplitGreetingFile,
  createFrontendWorkshopHelperScriptsFile,
} from '../utils/FrontendWorkshopSourceDelivery'
import { downloadBlob } from '../utils/LibraryFormatting'

import {
  frontendWorkshopProjectService,
  frontendWorkshopSourceDocumentService,
  loadFrontendWorkshopBrowserSourceCompilerService,
} from '../core/FrontendWorkshopContainer'
import {
  FrontendWorkshopSourceAlreadyExistsError,
  FrontendWorkshopSourceRevisionConflictError,
} from '../services/FrontendWorkshopSourceDocumentService'
import type {
  FrontendWorkshopSourceDocument,
  FrontendWorkshopSourceOrigin,
} from '../types/FrontendWorkshopSourceDocument'
import { parseTavernHelperFrontendEnvelope } from '../utils/FrontendWorkshopTavernFrontendEnvelope'

const props = defineProps<{
  projectId: string
  initialRange?: { start: number; end: number }
  initialSourceRevision?: number
}>()

const emit = defineEmits<{
  close: []
  applied: [source: FrontendWorkshopSourceDocument, wasCreated: boolean]
}>()

const loading = ref(false)
const saving = ref(false)
const importing = ref(false)
const exporting = ref(false)
const draft = ref('')
const projectTitle = ref('我的开场白')
const sourceTextarea = ref<HTMLTextAreaElement>()
const browserFilesInput = ref<HTMLInputElement>()
const browserFolderInput = ref<HTMLInputElement>()
const expectedRevision = ref<number>()
const sourceOrigin = ref<FrontendWorkshopSourceOrigin>('new')
const errorMessage = ref('')
const transferMessage = ref('')
const selectedFrontendBlockIndex = ref(0)
let loadGeneration = 0

const toolsMenu = ref<HTMLDetailsElement>()
const tavernEnvelope = computed(() => parseTavernHelperFrontendEnvelope(draft.value))
const hasCompanionScripts = computed(() =>
  Boolean(
    new DOMParser()
      .parseFromString(draft.value, 'text/html')
      .querySelector('script[type="application/json"][data-tavern-helper-script]'),
  ),
)
const selectedFrontendBlock = computed(
  () => tavernEnvelope.value.blocks[selectedFrontendBlockIndex.value],
)

function envelopeBlockingMessage(): string {
  const analysis = tavernEnvelope.value
  if (analysis.kind === 'malformed') {
    return '这段草稿看起来像 TavernHelper 前端消息格式，但按当前 SillyTavern + TavernHelper 规则没有形成可执行前端代码块。为避免把传输格式误存为 Author Source，请先修正或移除消息围栏。'
  }
  if (analysis.kind === 'mixed') {
    return '检测到普通消息正文 + TavernHelper 前端块。正文不会被静默丢弃；请明确选择要导入的前端块后再保存。'
  }
  if (analysis.kind === 'multiple') {
    return '检测到多个 TavernHelper 前端块。真实宿主会把它们分别渲染为 iframe；请明确选择一个前端块导入 Source，不能自动拼接。'
  }
  return '检测到 TavernHelper 消息前端格式。请先“按 TavernHelper 前端导入”，Author Source 只保存纯前端源码。'
}

async function focusInitialRange(): Promise<void> {
  const range = props.initialRange
  if (!range) return
  if (
    props.initialSourceRevision !== undefined &&
    props.initialSourceRevision !== expectedRevision.value
  ) {
    transferMessage.value = '源码已更新，旧定位已失效；请返回画布重新选择'
    return
  }
  if (
    !Number.isInteger(range.start) ||
    !Number.isInteger(range.end) ||
    range.start < 0 ||
    range.end < range.start ||
    range.end > draft.value.length
  )
    return
  await nextTick()
  const textarea = sourceTextarea.value
  if (!textarea) return
  const start = Math.max(0, Math.min(draft.value.length, Math.floor(range.start)))
  const end = Math.max(start, Math.min(draft.value.length, Math.floor(range.end)))
  textarea.focus({ preventScroll: true })
  textarea.setSelectionRange(start, end)
  const line = draft.value.slice(0, start).split('\n').length - 1
  const lineHeight = Number.parseFloat(getComputedStyle(textarea).lineHeight) || 20
  textarea.scrollTop = Math.max(0, line * lineHeight - textarea.clientHeight * 0.35)
}

async function load(): Promise<void> {
  const targetProjectId = props.projectId
  if (!targetProjectId) return
  const generation = ++loadGeneration
  loading.value = true
  errorMessage.value = ''
  transferMessage.value = ''
  try {
    const [source, projects] = await Promise.all([
      frontendWorkshopSourceDocumentService.get(targetProjectId),
      frontendWorkshopProjectService.list(),
    ])
    if (generation !== loadGeneration || props.projectId !== targetProjectId) return
    const project = projects.find((candidate) => candidate.id === targetProjectId)
    if (!project) throw new Error('当前项目已不存在，请返回后重新打开')
    projectTitle.value = project.name
    if (project.kind !== 'greeting')
      throw new Error('状态栏项目由旧状态栏编辑器负责，不能在开场白源码编辑器中打开')

    expectedRevision.value = source?.revision
    sourceOrigin.value = source?.origin ?? 'new'
    draft.value = source?.authorSource ?? ''
  } catch (error) {
    if (generation !== loadGeneration || props.projectId !== targetProjectId) return
    errorMessage.value = error instanceof Error ? error.message : '源码暂时无法读取'
  } finally {
    if (generation === loadGeneration) {
      loading.value = false
      void focusInitialRange()
    }
  }
}

async function save(): Promise<void> {
  const targetProjectId = props.projectId
  if (!targetProjectId || loading.value || saving.value) return
  if (tavernEnvelope.value.kind !== 'none') {
    errorMessage.value = envelopeBlockingMessage()
    return
  }

  saving.value = true
  errorMessage.value = ''
  try {
    const revision = expectedRevision.value
    const saved =
      revision === undefined
        ? await frontendWorkshopSourceDocumentService.createAuthorSourceIfMissing(
            targetProjectId,
            draft.value,
            { origin: sourceOrigin.value },
          )
        : await frontendWorkshopSourceDocumentService.saveAuthorSourceAtRevision(
            targetProjectId,
            revision,
            draft.value,
            { origin: sourceOrigin.value },
          )

    if (props.projectId !== targetProjectId) return
    expectedRevision.value = saved.revision
    emit('applied', saved, revision === undefined)
  } catch (error) {
    if (
      error instanceof FrontendWorkshopSourceRevisionConflictError ||
      error instanceof FrontendWorkshopSourceAlreadyExistsError
    ) {
      errorMessage.value = `${error.message}。为避免覆盖新内容，本次保存已取消。`
    } else {
      errorMessage.value = error instanceof Error ? error.message : 'Source 保存失败'
    }
  } finally {
    saving.value = false
  }
}

async function importBrowserSource(event: Event): Promise<void> {
  const input = event.currentTarget as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  if (!files.length || loading.value || saving.value || importing.value) return
  importing.value = true
  errorMessage.value = ''
  transferMessage.value = ''
  try {
    const [{ createFrontendWorkshopBrowserSourceProjectFromFiles }, compiler] = await Promise.all([
      import('../services/FrontendWorkshopBrowserSourceCompilerService'),
      loadFrontendWorkshopBrowserSourceCompilerService(),
    ])
    const project = await createFrontendWorkshopBrowserSourceProjectFromFiles(files)
    const compiled = await compiler.compile(project)
    draft.value = compiled.authorSource
    sourceOrigin.value = 'imported'
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Browser Source 编译失败'
  } finally {
    importing.value = false
  }
}

function importTavernFrontendBlock(): void {
  const block = selectedFrontendBlock.value
  if (!block) {
    errorMessage.value = envelopeBlockingMessage()
    return
  }
  draft.value = block.source
  sourceOrigin.value = 'imported'
  errorMessage.value = ''
  transferMessage.value =
    '已提取 TavernHelper iframe 实际执行的前端 payload；保存后才会成为 Author Source。'
  selectedFrontendBlockIndex.value = 0
}

async function exportJson(kind: 'greeting' | 'scripts'): Promise<void> {
  if (exporting.value || loading.value) return
  if (tavernEnvelope.value.kind !== 'none') {
    errorMessage.value = envelopeBlockingMessage()
    return
  }
  exporting.value = true
  try {
    const file =
      kind === 'greeting'
        ? createFrontendWorkshopSplitGreetingFile(draft.value, projectTitle.value)
        : createFrontendWorkshopHelperScriptsFile(draft.value)
    await downloadBlob(file, file.name)
    errorMessage.value = ''
    transferMessage.value =
      kind === 'greeting'
        ? '已导出开场白 JSON：导入资源库后应用到目标角色卡；不包含独立助手脚本。'
        : '已导出助手脚本 JSON：在酒馆助手脚本库导入，核对后启用。'
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '导出 JSON 失败'
  } finally {
    exporting.value = false
  }
}
function requestClose(): void {
  if (!saving.value) emit('close')
}

async function exportDelivery(): Promise<void> {
  if (exporting.value || loading.value) return
  if (tavernEnvelope.value.kind !== 'none') {
    errorMessage.value = envelopeBlockingMessage()
    return
  }
  exporting.value = true
  errorMessage.value = ''
  try {
    const blob = await createFrontendWorkshopSourceDelivery(draft.value)
    await downloadBlob(blob, '酒馆前端与配套脚本.zip')
    transferMessage.value = '已导出当前源码及配套脚本；脚本导入后需手动启用。'
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '导出失败'
  } finally {
    exporting.value = false
  }
}

watch(
  () => props.projectId,
  () => {
    draft.value = ''
    expectedRevision.value = undefined
    sourceOrigin.value = 'new'
    errorMessage.value = ''
    transferMessage.value = ''
    selectedFrontendBlockIndex.value = 0
    void load()
  },
  { immediate: true },
)

watch(
  () => props.initialRange,
  () => {
    if (!loading.value) void focusInitialRange()
  },
  { deep: true },
)

watch(
  () => tavernEnvelope.value.blocks.length,
  () => {
    selectedFrontendBlockIndex.value = 0
  },
)
</script>

<template>
  <section
    class="frontend-workshop-source-editor mobile-dialog-viewport"
    data-srl-controls
    role="dialog"
    aria-modal="true"
    aria-label="源码编辑"
  >
    <div class="frontend-workshop-source-editor__header">
      <FeatureAppHeader
        layout="panel"
        title="源码"
        back-label="关闭源码编辑"
        :back-disabled="saving"
        @back="requestClose"
      >
        <template #actions>
          <details ref="toolsMenu" class="frontend-workshop-source-editor__tools">
            <summary>工具</summary>
            <div class="frontend-workshop-source-editor__tool-menu">
              <button
                class="button button--secondary"
                type="button"
                :disabled="loading || saving || importing"
                @click="browserFilesInput?.click()"
              >
                {{ importing ? '编译中…' : '导入网页源文件' }}
              </button>
              <button
                class="button button--secondary"
                type="button"
                :disabled="loading || saving || importing"
                @click="browserFolderInput?.click()"
              >
                导入网页项目文件夹
              </button>
              <button
                class="button button--secondary"
                type="button"
                :disabled="loading || saving || exporting"
                @click="exportDelivery"
              >
                {{ exporting ? '打包中…' : '导出完整作品包' }}
              </button>
              <button
                class="button button--secondary"
                type="button"
                :disabled="loading || saving || exporting"
                @click="exportJson('greeting')"
              >
                导出开场白 JSON
              </button>
              <button
                v-if="hasCompanionScripts"
                class="button button--secondary"
                type="button"
                :disabled="loading || saving || exporting"
                @click="exportJson('scripts')"
              >
                导出助手脚本 JSON
              </button>
              <button
                class="button button--secondary"
                type="button"
                :disabled="loading || saving"
                @click="load"
              >
                重新载入
              </button>
              <small
                >网页文件会合并编译；缺少的外部库需自行提供。完整作品包包含已配置的角色卡、备用开场白和脚本。</small
              >
              <small
                >开场白 JSON：导入资源库，再应用到角色卡；助手脚本
                JSON：导入酒馆助手脚本库。网页内的动效脚本随开场白保留，独立助手脚本单独导出。</small
              >
            </div>
          </details>
          <button
            type="button"
            class="button button--primary is-primary"
            :disabled="loading || saving"
            @click="save"
          >
            {{ saving ? '保存中…' : '保存源码' }}
          </button>
        </template>
      </FeatureAppHeader>
    </div>
    <input
      ref="browserFilesInput"
      type="file"
      hidden
      multiple
      accept=".html,.htm,.js,.mjs,.jsx,.ts,.tsx,.vue,.css,.json,.svg,image/*,font/*"
      @change="importBrowserSource"
    />
    <input
      ref="browserFolderInput"
      type="file"
      hidden
      multiple
      webkitdirectory
      @change="importBrowserSource"
    />
    <div class="frontend-workshop-source-editor__body">
      <div
        v-if="!loading && tavernEnvelope.kind !== 'none'"
        class="frontend-workshop-source-editor__envelope"
        :data-envelope-kind="tavernEnvelope.kind"
      >
        <template v-if="tavernEnvelope.kind === 'malformed'">
          <strong>检测到疑似 TavernHelper 消息格式，但真实 ST/TH 链没有识别出可执行前端。</strong>
          <small>不会自动去围栏，也不会把它交给 Browser Compiler。</small>
        </template>
        <template v-else>
          <strong v-if="tavernEnvelope.kind === 'single'"
            >检测到 TavernHelper 消息前端格式。</strong
          >
          <strong v-else-if="tavernEnvelope.kind === 'mixed'">
            检测到普通消息正文与 TavernHelper 前端块混合。
          </strong>
          <strong v-else>检测到多个 TavernHelper 前端块。</strong>
          <small v-if="tavernEnvelope.hasNonFrontendContent">
            普通消息内容会保留在当前草稿中，只有你明确选择后才提取前端 payload。
          </small>
          <small v-else-if="tavernEnvelope.blocks.length > 1">
            真实 TavernHelper 会分别创建多个 iframe；FrontendWorkshop 不会擅自合并它们。
          </small>
          <select
            v-if="tavernEnvelope.blocks.length > 1"
            v-model.number="selectedFrontendBlockIndex"
            aria-label="选择 TavernHelper 前端块"
          >
            <option v-for="(_, index) in tavernEnvelope.blocks" :key="index" :value="index">
              前端块 {{ index + 1 }}
            </option>
          </select>
          <button type="button" @click="importTavernFrontendBlock">
            按 TavernHelper 前端导入{{ tavernEnvelope.blocks.length > 1 ? '选中块' : '' }}
          </button>
          <small v-if="selectedFrontendBlock && !selectedFrontendBlock.officialBodyEnvelope">
            当前宿主源码事实上可识别该 payload，但它不满足官方“闭合
            body”写法；导入会原样保留，重新导出时才补 transport body。
          </small>
        </template>
      </div>

      <div v-if="loading" class="frontend-workshop-source-editor__state">正在读取当前源码…</div>
      <textarea
        v-else
        ref="sourceTextarea"
        v-model="draft"
        aria-label="HTML CSS JavaScript 源码"
        spellcheck="false"
        autocapitalize="off"
        autocomplete="off"
        placeholder="粘贴或编辑 HTML / CSS / JavaScript"
        @focus="toolsMenu && (toolsMenu.open = false)"
      ></textarea>
      <p v-if="transferMessage" class="frontend-workshop-source-editor__transfer" role="status">
        {{ transferMessage }}
      </p>
      <p v-if="errorMessage" class="frontend-workshop-source-editor__error" role="alert">
        {{ errorMessage }}
      </p>
    </div>
  </section>
</template>

<style scoped src="../styles/FrontendWorkshopSourceEditor.css"></style>
