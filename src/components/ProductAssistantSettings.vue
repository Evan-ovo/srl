<script setup lang="ts">
import '../styles/ConfirmDialog.css'
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch, useTemplateRef } from 'vue'
import { mainApiService } from '../core/AppContainer'
import MainApiSettings from './MainApiSettings.vue'
import ProductAssistantMemory from './ProductAssistantMemory.vue'
import ProductAssistantProjects from './ProductAssistantProjects.vue'
import ProductAssistantTaskTemplates from './ProductAssistantTaskTemplates.vue'
import {
  DEFAULT_ASSISTANT_AVATAR,
  type AssistantPreferences,
  type AssistantConversationSummary,
  type ProductAssistantWorkspaceService,
  type AssistantMessageMatch,
  type AssistantTaskTemplate,
} from '../services/ProductAssistantWorkspaceService'
import { readAssistantImages } from '../services/ProductAssistantService'
import {
  clearAssistantPetAssets,
  downloadAssistantPetAssets,
  hasDownloadedAssistantPetAssets,
} from '../services/ProductAssistantPetAssets'
import { chooseAction, confirmAction } from '../composables/UseConfirmDialog'
import {
  ASSISTANT_MODE_LABELS,
  ASSISTANT_PROMPT_LABELS,
  DEFAULT_ASSISTANT_PROMPTS,
  normalizeAssistantPromptOverrides,
  type AssistantPromptSection,
  type AssistantMode,
} from '../core/ProductAssistantKnowledge'
import {
  normalizeAssistantToolCallLimit,
  MAX_ASSISTANT_TOOL_CALL_LIMIT,
} from '../services/ProductAssistantTools'
const props = defineProps<{
  workspace: ProductAssistantWorkspaceService
  preferences: AssistantPreferences
  activeId: string
  historyPage: boolean
  apiPage: boolean
  memoryPage?: boolean
  promptPage?: boolean
  favoritesPage?: boolean
  projectsPage?: boolean
  templatesPage?: boolean
  contextStatus?: string
  contextBusy?: boolean
  contextError?: string
}>()
const emit = defineEmits<{
  archive: []
  history: []
  api: []
  memory: []
  prompt: []
  favorites: []
  projects: []
  templates: []
  continueProject: [id: string]
  useTemplate: [value: AssistantTaskTemplate]
  memoriesSaved: []
  open: [id: string, turnId?: string]
  saved: [value: AssistantPreferences]
  compress: []
  cancelCompression: []
}>()
const form = ref<AssistantPreferences>({
  ...props.preferences,
  promptOverrides: normalizeAssistantPromptOverrides(props.preferences.promptOverrides),
  githubReadPersistence: props.preferences.githubReadPersistence || 'local',
  githubReadWithoutConfirmation: props.preferences.githubReadWithoutConfirmation === true,
  mode: props.preferences.mode || 'auto',
  toolCallingEnabled: props.preferences.toolCallingEnabled !== false,
  allowPageScripts: props.preferences.allowPageScripts === true,
  allowScreenshots: props.preferences.allowScreenshots !== false,
  toolCallLimit: normalizeAssistantToolCallLimit(props.preferences.toolCallLimit),
})
const templates = useTemplateRef<InstanceType<typeof ProductAssistantTaskTemplates>>('templates')
async function requestLeaveTemplate(): Promise<boolean> {
  return !props.templatesPage || (await templates.value?.requestLeave()) === true
}
const savedForm = ref<AssistantPreferences>({ ...form.value })
const promptSection = ref<AssistantPromptSection>('common')
const promptText = computed({
  get: () =>
    form.value.promptOverrides?.[promptSection.value] ??
    DEFAULT_ASSISTANT_PROMPTS[promptSection.value],
  set: (text: string) => {
    form.value.promptOverrides = normalizeAssistantPromptOverrides({
      ...form.value.promptOverrides,
      [promptSection.value]: text,
    })
  },
})
function restorePrompt() {
  const next = { ...form.value.promptOverrides }
  delete next[promptSection.value]
  form.value.promptOverrides = normalizeAssistantPromptOverrides(next)
}
const githubToken = ref('')
const savedGitHubToken = ref('')
const githubTokenReady = ref(false)
const githubTokenLoading = ref(false)
const promptHasChanges = computed(
  () =>
    JSON.stringify(form.value.promptOverrides) !== JSON.stringify(savedForm.value.promptOverrides),
)
const hasChanges = computed(
  () =>
    githubToken.value !== savedGitHubToken.value ||
    (Object.keys(form.value) as (keyof AssistantPreferences)[]).some((key) =>
      key === 'promptOverrides'
        ? JSON.stringify(form.value.promptOverrides) !==
          JSON.stringify(savedForm.value.promptOverrides)
        : form.value[key] !== savedForm.value[key],
    ),
)
const rows = ref<AssistantConversationSummary[]>([])
const page = ref(0)
const total = ref(0)
const query = ref('')
const searchedQuery = ref('')
const matches = ref<AssistantMessageMatch[]>([])
let loadId = 0
const busy = ref(false)
const leaving = ref(false)
const error = ref('')
const status = ref('')
const recoveringHistory = ref(false)
const recoveryStatus = ref('')
const recoveryError = ref('')
const historyRecoveryOpen = ref(false)
const recoveryDialog = useTemplateRef<HTMLDialogElement>('recoveryDialog')
let recoveryController: AbortController | undefined
let disposed = false
async function openHistoryRecovery() {
  if (!props.historyPage || disposed || historyRecoveryOpen.value) return
  historyRecoveryOpen.value = true
  await nextTick()
  recoveryDialog.value?.showModal()
}
function closeHistoryRecovery() {
  if (recoveringHistory.value) stopHistoryRecovery()
  recoveryDialog.value?.close()
  historyRecoveryOpen.value = false
}
onBeforeUnmount(() => {
  disposed = true
  recoveryController?.abort()
})
async function recoverHistory() {
  if (busy.value || disposed || !historyRecoveryOpen.value) return
  const controller = new AbortController()
  recoveryController = controller
  busy.value = true
  recoveringHistory.value = true
  recoveryError.value = ''
  recoveryStatus.value = '正在检查历史…'
  try {
    const result = await props.workspace.recoverHistory({
      signal: controller.signal,
      onProgress: (value) => {
        recoveryStatus.value = `已检查 ${value.scanned}/${value.total} 条，找回 ${value.recovered} 条`
      },
    })
    recoveryStatus.value =
      `${result.cancelled ? '已停止' : '检查完成'}：找回 ${result.recovered} 条，修复列表 ${result.repaired} 条` +
      (result.invalid ? `；${result.invalid} 条格式异常，原件保留` : '') +
      (result.missingProjects
        ? `；${result.missingProjects} 条对话的旧 APP 项目缺失，仅找回聊天`
        : '') +
      (!result.recovered && !result.repaired && !result.cancelled
        ? '；未发现可补回记录，可再检查旧副本恢复档或备份'
        : '')
    if (!disposed) {
      page.value = 0
      searchedQuery.value = ''
      query.value = ''
      await load()
    }
  } catch (cause) {
    recoveryError.value =
      '找回未完成，已补回的记录和旧库均保留：' +
      (cause instanceof Error ? cause.message : '读取或保存失败')
  } finally {
    recoveryController = undefined
    recoveringHistory.value = false
    busy.value = false
  }
}
function stopHistoryRecovery() {
  recoveryController?.abort()
  recoveryStatus.value = '正在停止，已完成的记录会保留…'
}
const petAssetsBusy = ref(false)
const petAssetsAvailable = ref(props.preferences.petAssetMode === 'images')
const petAssetsLabel = computed(() =>
  petAssetsAvailable.value ? '桌宠图片已下载（约 3.5 MiB）' : '未下载图片时使用轻量 SVG 悬浮球',
)
watch(
  () =>
    form.value.networkEnabled &&
    !props.historyPage &&
    !props.apiPage &&
    !props.memoryPage &&
    !props.promptPage &&
    !props.favoritesPage &&
    !props.projectsPage &&
    !props.templatesPage,
  async (visible) => {
    if (!visible || githubTokenReady.value || githubTokenLoading.value) return
    githubTokenLoading.value = true
    try {
      githubToken.value = await props.workspace.readGitHubCredential()
      savedGitHubToken.value = githubToken.value
      githubTokenReady.value = true
    } catch {
      error.value = 'GitHub 令牌未能载入，请重新打开设置后再修改'
    } finally {
      githubTokenLoading.value = false
    }
  },
  { immediate: true },
)
const avatarInput = ref<HTMLInputElement>()
const renamingId = ref('')
const renameTitle = ref('')
const renameInput = ref<HTMLInputElement[]>([])
async function startRename(row: AssistantConversationSummary) {
  renamingId.value = row.id
  renameTitle.value = row.title
  error.value = ''
  await nextTick()
  renameInput.value[0]?.focus()
  renameInput.value[0]?.select()
}
async function rename() {
  if (busy.value || !renamingId.value) return
  busy.value = true
  error.value = ''
  try {
    await props.workspace.rename(renamingId.value, renameTitle.value)
    renamingId.value = ''
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '重命名失败'
  } finally {
    busy.value = false
  }
}
const apiName = computed(() =>
  form.value.apiProfileId
    ? mainApiService.getProfilesState().profiles.find((p) => p.id === form.value.apiProfileId)
        ?.name || '主 API'
    : '主 API',
)
const avatarUrl = computed({
  get: () => (/^https?:\/\//iu.test(form.value.avatar) ? form.value.avatar : ''),
  set: (value: string) => {
    form.value.avatar = value
  },
})
async function load() {
  const id = ++loadId
  if (props.favoritesPage || searchedQuery.value.trim()) {
    const result = await props.workspace.search(
      searchedQuery.value,
      props.favoritesPage,
      page.value * 20,
    )
    if (id !== loadId) return
    matches.value = result.items
    total.value = result.total
  } else {
    const result = await props.workspace.list(page.value * 20)
    if (id !== loadId) return
    rows.value = result.items
    total.value = result.total
  }
}
async function search() {
  page.value = 0
  searchedQuery.value = query.value
  error.value = ''
  try {
    await load()
  } catch {
    error.value = '对话搜索失败'
  }
}
function openMatch(row: AssistantMessageMatch) {
  if (row.turnId) emit('open', row.conversationId, row.turnId)
  else emit('open', row.conversationId)
}
onMounted(() => {
  if (props.preferences.desktopPet)
    void hasDownloadedAssistantPetAssets()
      .then((available) => (petAssetsAvailable.value = available))
      .catch(() => (petAssetsAvailable.value = false))
  if (props.historyPage || props.favoritesPage)
    void load().catch((cause) => (error.value = String(cause)))
})
watch(
  () => props.historyPage || props.favoritesPage,
  (open) => {
    if (open) void load().catch(() => (error.value = '历史对话读取失败'))
  },
)
async function changePage(direction: number) {
  page.value += direction
  await load()
}
async function remove(row: AssistantConversationSummary) {
  if (
    !(await confirmAction({
      title: '删除历史对话',
      message: `删除“${row.title}”及其中的聊天和图片？独立 APP 项目、已应用样式和已安装 APP 保留。旧版尚未转为项目的聊天草稿会随对话删除。`,
      confirmLabel: '删除对话',
    }))
  )
    return
  try {
    await props.workspace.remove(row.id)
    if (rows.value.length === 1 && page.value) page.value--
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '删除失败'
  }
}
async function avatar(event: Event) {
  const element = event.target as HTMLInputElement
  try {
    const image = (await readAssistantImages(Array.from(element.files ?? []), 0))[0]
    if (image) form.value.avatar = image.dataUrl
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '图片读取失败'
  }
  element.value = ''
}
async function save(apiProfileId?: string): Promise<boolean> {
  if (busy.value || githubTokenLoading.value) return false
  busy.value = true
  error.value = ''
  status.value = ''
  const draftSnapshot = {
    ...form.value,
    promptOverrides: normalizeAssistantPromptOverrides(form.value.promptOverrides),
    ...(apiProfileId !== undefined ? { apiProfileId } : {}),
  }
  const snapshot = {
    ...draftSnapshot,
    toolCallLimit:
      (draftSnapshot.toolCallLimit as unknown) === '' ? undefined : draftSnapshot.toolCallLimit,
  }
  const keySnapshot = githubToken.value
  const readerChanged =
    keySnapshot !== savedGitHubToken.value ||
    snapshot.githubReadPersistence !== savedForm.value.githubReadPersistence
  try {
    const saved = readerChanged
      ? await props.workspace.savePreferences(snapshot, keySnapshot)
      : await props.workspace.savePreferences(snapshot)
    emit('saved', saved)
    if (apiProfileId !== undefined) form.value.apiProfileId = apiProfileId
    if (readerChanged) savedGitHubToken.value = keySnapshot
    savedForm.value = draftSnapshot
    status.value = '已保存'
    return true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '设置保存失败'
    return false
  } finally {
    busy.value = false
  }
}
async function setPetAssets(mode: 'images' | 'svg') {
  if (petAssetsBusy.value) return
  petAssetsBusy.value = true
  error.value = ''
  try {
    if (mode === 'images') await downloadAssistantPetAssets()
    const saved = await props.workspace.savePreferences({
      ...props.workspace.preferences(),
      petAssetMode: mode,
    })
    if (mode === 'images') window.dispatchEvent(new Event('srl:assistant-pet-assets-updated'))
    if (mode === 'svg') await clearAssistantPetAssets()
    form.value.petAssetMode = mode
    savedForm.value = { ...savedForm.value, petAssetMode: mode }
    petAssetsAvailable.value = mode === 'images'
    emit('saved', saved)
    status.value = mode === 'images' ? '桌宠图片已下载' : '图片已清除，已切换为 SVG 悬浮球'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '桌宠图片设置失败'
  } finally {
    petAssetsBusy.value = false
  }
}
async function requestLeave(promptOnly = false): Promise<boolean> {
  if (!(await requestLeaveTemplate())) return false
  if (busy.value || leaving.value) return false
  if (!(promptOnly ? promptHasChanges.value : hasChanges.value)) return true
  leaving.value = true
  try {
    const choice = await chooseAction({
      title: '有修改未保存',
      message: `${promptOnly ? '系统提示词' : '助手设置'}有修改未保存，是否保存后退出？`,
      confirmLabel: '保存并退出',
      alternativeLabel: '不保存退出',
      cancelLabel: '继续编辑',
    })
    if (choice === 'alternative') {
      if (promptOnly) {
        form.value.promptOverrides = normalizeAssistantPromptOverrides(
          savedForm.value.promptOverrides,
        )
      }
      return true
    }
    return choice === 'confirm' && (await save()) && !hasChanges.value
  } finally {
    leaving.value = false
  }
}
defineExpose({
  openHistoryRecovery,
  closeHistoryRecovery,
  historyRecoveryOpen,
  requestLeave,
  requestLeavePrompt: () => requestLeave(true),
  requestLeaveTemplate,
  newTemplate: () => templates.value?.newTemplate(),
})
async function selectApi(id: string) {
  await save(id)
}
async function compressContext() {
  if (await save()) emit('compress')
}
</script>
<template>
  <div
    class="chat-settings"
    :class="{ 'chat-settings--prompt-page': promptPage }"
    :aria-label="historyPage ? '历史对话' : '助手设置'"
  >
    <ProductAssistantProjects
      v-if="projectsPage"
      :workspace="workspace"
      @continue="emit('continueProject', $event)"
    />
    <ProductAssistantTaskTemplates
      v-else-if="templatesPage"
      ref="templates"
      :workspace="workspace"
      @use="emit('useTemplate', $event)"
    />
    <form v-else-if="promptPage" class="chat-prompt-page" @submit.prevent="save()">
      <section class="chat-settings-group chat-prompt-editor">
        <div class="chat-prompt-tools">
          <select v-model="promptSection" aria-label="提示词部分" :disabled="busy">
            <option
              v-for="(label, section) in ASSISTANT_PROMPT_LABELS"
              :key="section"
              :value="section"
            >
              {{ label }}
            </option>
          </select>
          <button
            type="button"
            :disabled="busy || form.promptOverrides?.[promptSection] === undefined"
            @click="restorePrompt"
          >
            恢复默认
          </button>
        </div>
        <textarea
          v-model="promptText"
          aria-label="系统提示词内容"
          :disabled="busy"
          spellcheck="false"
        />
      </section>
      <div class="chat-settings-save">
        <button type="submit" :disabled="busy">{{ busy ? '保存中…' : '保存提示词' }}</button>
        <span v-if="promptHasChanges || status" role="status">{{
          promptHasChanges ? '有修改，待保存' : status
        }}</span>
      </div>
    </form>
    <MainApiSettings
      v-else-if="apiPage"
      assistant
      :profile-id="form.apiProfileId"
      @selected="selectApi"
    />
    <ProductAssistantMemory
      v-else-if="memoryPage"
      :workspace="workspace"
      @saved="emit('memoriesSaved')"
    />
    <template v-else-if="historyPage || favoritesPage">
      <form class="chat-history-search" role="search" @submit.prevent="search">
        <input
          v-model="query"
          type="search"
          aria-label="搜索聊天记录"
          placeholder="搜索聊天记录"
          maxlength="100"
        />
        <button type="submit" aria-label="搜索对话">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m16 16 5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0z" />
          </svg>
        </button>
      </form>
      <div v-if="favoritesPage || searchedQuery.trim()" class="chat-history-list">
        <p v-if="!total" class="chat-empty">
          {{ favoritesPage ? '暂无收藏消息' : '没有找到相关对话' }}
        </p>
        <div
          v-for="row in matches"
          :key="row.conversationId + (row.turnId || '')"
          class="chat-history-row"
        >
          <button type="button" class="chat-history-open" @click="openMatch(row)">
            <strong>{{ row.title }}</strong
            ><span class="chat-history-snippet">{{ row.text || '对话标题匹配' }}</span>
          </button>
        </div>
      </div>
      <div v-else class="chat-history-list">
        <p v-if="!total" class="chat-empty">暂无历史对话</p>
        <div
          v-for="row in rows"
          :key="row.id"
          class="chat-history-row"
          :class="{ 'is-current': row.id === activeId }"
        >
          <span class="chat-history-icon" aria-hidden="true"
            ><svg viewBox="0 0 24 24"><path d="M4 5h16v12H9l-5 4V5zm4 4h8m-8 4h5" /></svg
          ></span>
          <form v-if="renamingId === row.id" class="chat-history-rename" @submit.prevent="rename">
            <input
              ref="renameInput"
              v-model="renameTitle"
              aria-label="对话名称"
              maxlength="60"
              :disabled="busy"
              @keydown.esc.prevent="renamingId = ''"
            />
            <button
              type="submit"
              class="chat-history-action"
              aria-label="保存对话名称"
              :disabled="busy || !renameTitle.trim()"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>
            </button>
            <button
              type="button"
              class="chat-history-action"
              aria-label="取消重命名"
              :disabled="busy"
              @click="renamingId = ''"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
            </button>
          </form>
          <button v-else type="button" class="chat-history-open" @click="emit('open', row.id)">
            <strong>{{ row.title }}</strong
            ><small
              >{{
                new Date(row.updatedAt).toLocaleString('zh-CN', {
                  month: 'numeric',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })
              }}<span v-if="row.id === activeId"> · 当前</span></small
            >
          </button>
          <button
            v-if="renamingId !== row.id"
            type="button"
            class="chat-history-action"
            :disabled="busy"
            :aria-label="`重命名对话 ${row.title}`"
            @click="startRename(row)"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m15 4 5 5M4 20l4-1L20 7l-3-3L5 16l-1 4z" />
            </svg>
          </button>
          <button
            v-if="renamingId !== row.id"
            type="button"
            class="chat-history-action"
            :disabled="busy || row.id === activeId"
            :aria-label="`删除对话 ${row.title}`"
            @click="remove(row)"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5m4-5v5" />
            </svg>
          </button>
        </div>
      </div>
      <nav v-if="total > 20" class="chat-history-pages" aria-label="历史对话翻页">
        <button type="button" :disabled="page === 0" @click="changePage(-1)">上一页</button
        ><span>{{ page + 1 }}</span
        ><button type="button" :disabled="(page + 1) * 20 >= total" @click="changePage(1)">
          下一页
        </button>
      </nav>
    </template>
    <form v-else @submit.prevent="save()">
      <section class="chat-settings-group">
        <div class="chat-profile-row">
          <button
            type="button"
            class="chat-profile-avatar"
            aria-label="上传助手头像"
            @click="avatarInput?.click()"
          >
            <img
              :src="form.avatar || DEFAULT_ASSISTANT_AVATAR"
              alt="助手头像"
              @error="($event.target as HTMLImageElement).src = DEFAULT_ASSISTANT_AVATAR"
            /><span>更换</span>
          </button>
          <label
            ><span>名字</span><input v-model="form.name" aria-label="助手名字" maxlength="40"
          /></label>
        </div>
        <label class="chat-settings-field"
          ><span>头像 URL</span
          ><input v-model="avatarUrl" aria-label="助手头像 URL" placeholder="https://"
        /></label>
        <input
          ref="avatarInput"
          hidden
          type="file"
          accept="image/png,image/jpeg,image/webp"
          @change="avatar"
        />
      </section>
      <section class="chat-settings-group chat-settings-links">
        <button type="button" @click="emit('projects')">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h7l2 3h9v11H3V6z" /></svg
          ><span>APP 项目</span><span aria-hidden="true">›</span>
        </button>
        <button type="button" @click="emit('templates')">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 4h14v16H5zM8 8h8m-8 4h8m-8 4h5" /></svg
          ><span>任务模板</span><span aria-hidden="true">›</span>
        </button>
        <slot name="task-context" />
        <button type="button" @click="emit('archive')">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 8h16v12H4zM3 4h18v4H3zM9 12h6M12 15v3m-1.5-1.5h3" /></svg
          ><span>归档并开始新对话</span><span aria-hidden="true">›</span>
        </button>
        <button type="button" @click="emit('history')">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 10a8 8 0 1 1 1 8M4 4v6h6M12 7v5l3 2" /></svg
          ><span>历史对话</span><span aria-hidden="true">›</span>
        </button>
        <button type="button" @click="emit('favorites')">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2-5.5-2.9-5.5 2.9 1-6.2L3 9.6l6.2-.9L12 3z"
            /></svg
          ><span>收藏消息</span><span aria-hidden="true">›</span>
        </button>
        <button type="button" @click="emit('memory')">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 4h14v16H5zM8 8h8m-8 4h8m-8 4h5" /></svg
          ><span>偏好记忆</span><span aria-hidden="true">›</span>
        </button>
        <button type="button" aria-label="系统提示词" @click="emit('prompt')">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M14 3H5v18h14v-9M14 3v6h6m-9 6 8-8 2 2-8 8-3 1 1-3z" />
          </svg>
          <span>系统提示词</span><span aria-hidden="true">›</span>
        </button>
      </section>
      <section class="chat-settings-group chat-settings-links">
        <button type="button" aria-label="助手 API" @click="emit('api')">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 7V3m8 4V3M6 7h12v4a6 6 0 0 1-12 0V7zm6 10v4" />
          </svg>
          <span>助手 API</span><small class="chat-settings-value">{{ apiName }}</small
          ><span aria-hidden="true">›</span>
        </button>
        <label class="chat-settings-field chat-settings-toggle"
          ><span>联网工具</span
          ><input v-model="form.networkEnabled" type="checkbox" role="switch" aria-label="联网工具"
        /></label>
        <label v-if="form.networkEnabled" class="chat-settings-field chat-settings-toggle"
          ><span>模型原生搜索</span
          ><input
            v-model="form.providerSearch"
            type="checkbox"
            role="switch"
            aria-label="模型原生搜索"
        /></label>
        <template v-if="form.networkEnabled">
          <label class="chat-settings-field chat-settings-toggle"
            ><span>公开源码免确认</span
            ><input
              v-model="form.githubReadWithoutConfirmation"
              type="checkbox"
              role="switch"
              aria-label="公开源码免确认"
          /></label>
          <label class="chat-settings-field"
            ><span>GitHub 令牌</span
            ><input
              v-model="githubToken"
              type="password"
              aria-label="GitHub 令牌"
              autocomplete="off"
              maxlength="4096"
              placeholder="访问令牌（可选）"
              :disabled="!githubTokenReady || busy"
          /></label>
          <label class="chat-settings-field"
            ><span>密钥保存</span
            ><select
              v-model="form.githubReadPersistence"
              aria-label="GitHub 令牌保存方式"
              :disabled="!githubTokenReady || busy"
            >
              <option value="local">保存在本机</option>
              <option value="session">仅本次使用</option>
            </select></label
          >
          <p class="chat-settings-hint">
            只读公开仓库；令牌仅发给 GitHub。<a
              href="https://github.com/settings/personal-access-tokens/new"
              target="_blank"
              rel="noopener noreferrer"
              >创建只读令牌</a
            >
          </p>
        </template>
      </section>
      <section class="chat-settings-group">
        <label class="chat-settings-field chat-settings-toggle"
          ><span>工具调用</span
          ><input
            v-model="form.toolCallingEnabled"
            type="checkbox"
            role="switch"
            aria-label="工具调用"
        /></label>
        <label v-if="form.toolCallingEnabled" class="chat-settings-field"
          ><span>工具上限</span
          ><input
            v-model.number="form.toolCallLimit"
            type="number"
            inputmode="numeric"
            min="1"
            :max="MAX_ASSISTANT_TOOL_CALL_LIMIT"
            step="1"
            aria-label="每次生成工具调用上限"
            placeholder="留空不限次数"
        /></label>
        <label v-if="form.toolCallingEnabled" class="chat-settings-field chat-settings-toggle"
          ><span>允许运行页面脚本</span
          ><input
            v-model="form.allowPageScripts"
            type="checkbox"
            role="switch"
            aria-label="允许蒜惹菈运行页面脚本"
        /></label>
        <p v-if="form.toolCallingEnabled" class="chat-settings-hint">
          {{
            form.allowPageScripts
              ? '已开启：脚本可访问页面、本机存储和网络，也可能接触 API 密钥、登录页面及其他隐私。只在信任当前模型时使用。'
              : '默认关闭。开启后，脚本可访问页面、本机存储和网络，也可能接触 API 密钥、登录页面及其他隐私。'
          }}
        </p>
        <label class="chat-settings-field"
          ><span>工作模式</span
          ><select v-model="form.mode" aria-label="助手工作模式">
            <option
              v-for="(label, mode) in ASSISTANT_MODE_LABELS"
              :key="mode"
              :value="mode as AssistantMode"
            >
              {{ label }}
            </option>
          </select></label
        >
      </section>

      <section class="chat-settings-group">
        <label class="chat-settings-field chat-settings-toggle"
          ><span>自动压缩</span
          ><input
            v-model="form.autoCompressContext"
            type="checkbox"
            role="switch"
            aria-label="自动压缩上下文"
        /></label>
        <label class="chat-settings-field"
          ><span>压缩阈值</span
          ><input
            v-model.number="form.compressionTokenThreshold"
            type="number"
            min="1"
            step="1"
            placeholder="留空不自动压缩"
            aria-label="自动压缩 token 阈值"
        /></label>
        <label class="chat-settings-field chat-settings-toggle"
          ><span>token 预估</span
          ><input
            v-model="form.estimateInputTokens"
            type="checkbox"
            role="switch"
            aria-label="发送前预估 token"
        /></label>
        <div class="chat-context-actions">
          <span v-if="contextStatus" role="status">{{ contextStatus }}</span>
          <button v-if="contextBusy" type="button" @click="emit('cancelCompression')">
            取消压缩
          </button>
          <button v-else type="button" :disabled="busy" @click="compressContext">
            压缩当前对话
          </button>
        </div>
      </section>
      <section class="chat-settings-group">
        <label class="chat-settings-field chat-settings-toggle"
          ><span>允许小助手截图</span
          ><input
            v-model="form.allowScreenshots"
            type="checkbox"
            role="switch"
            aria-label="允许小助手截图"
        /></label>
        <label class="chat-settings-field chat-settings-toggle"
          ><span>桌宠</span
          ><input
            v-model="form.desktopPet"
            type="checkbox"
            role="switch"
            aria-label="启用蒜惹菈桌宠"
        /></label>
        <label v-if="form.desktopPet" class="chat-settings-field chat-settings-toggle"
          ><span>走动动画</span
          ><input
            v-model="form.petWalkingAnimation"
            type="checkbox"
            role="switch"
            aria-label="桌宠走动动画"
        /></label>
        <label v-if="form.desktopPet" class="chat-settings-field chat-settings-toggle"
          ><span>AI 控制表情</span
          ><input
            v-model="form.aiPetExpressions"
            type="checkbox"
            role="switch"
            aria-label="AI 控制表情"
        /></label>
        <div v-if="form.desktopPet || petAssetsAvailable" class="chat-pet-assets">
          <span>{{ petAssetsLabel }}</span>
          <button
            v-if="!petAssetsAvailable"
            type="button"
            :disabled="petAssetsBusy"
            @click="setPetAssets('images')"
          >
            {{ petAssetsBusy ? '下载中…' : '下载桌宠图片' }}
          </button>
          <button v-else type="button" :disabled="petAssetsBusy" @click="setPetAssets('svg')">
            {{ petAssetsBusy ? '清理中…' : '清除图片' }}
          </button>
        </div>
      </section>
      <div class="chat-settings-save">
        <button type="submit" :disabled="busy">{{ busy ? '保存中…' : '保存设置' }}</button
        ><span v-if="hasChanges || status" role="status">{{
          hasChanges ? '有修改，待保存' : status
        }}</span>
      </div>
    </form>
    <p v-if="error || contextError" class="chat-error" role="alert">{{ error || contextError }}</p>
  </div>
  <Teleport to="body">
    <dialog
      v-if="historyRecoveryOpen"
      ref="recoveryDialog"
      class="confirm-dialog__overlay is-centered"
      aria-label="历史设置"
      @click.self="closeHistoryRecovery"
      @keydown.esc.stop.prevent="closeHistoryRecovery"
      @cancel.prevent="closeHistoryRecovery"
    >
      <section class="confirm-dialog chat-history-recovery">
        <h3>找回历史对话</h3>
        <p>尝试补回旧对话、图片和未发送输入。现有对话与设置会保留，旧 APP 草稿另存副本。</p>
        <p class="chat-history-recovery__hint">旧正文已删除且没有备份时，无法找回。</p>
        <p v-if="recoveryStatus" role="status">{{ recoveryStatus }}</p>
        <p v-if="recoveryError" role="alert">{{ recoveryError }}</p>
        <footer>
          <button type="button" autofocus @click="closeHistoryRecovery">关闭</button>
          <button
            type="button"
            :class="{ 'confirm-dialog__confirm': !recoveringHistory }"
            :disabled="busy && !recoveringHistory"
            @click="recoveringHistory ? stopHistoryRecovery() : recoverHistory()"
          >
            {{ recoveringHistory ? '停止找回' : '找回历史' }}
          </button>
        </footer>
      </section>
    </dialog>
  </Teleport>
</template>
<style scoped>
.chat-history-recovery__hint {
  font-size: 0.75rem;
  color: var(--color-ink-soft);
}
.chat-history-recovery [role='status'] {
  color: var(--color-accent);
}
.chat-history-recovery [role='alert'] {
  color: var(--color-danger);
}
.chat-context-actions {
  padding: 0.25rem 1rem 1rem;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
}
.chat-context-actions span {
  flex: 1;
  font-size: 12px;
  color: var(--color-ink-soft);
}
.chat-context-actions button {
  min-height: 44px;
  padding: 8px 14px;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.chat-pet-assets {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 0 4px 12px;
  color: var(--color-ink-soft);
  font-size: 12px;
}
.chat-pet-assets button {
  min-height: 36px;
  padding: 6px 10px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
</style>
