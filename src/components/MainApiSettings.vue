<script setup lang="ts">
import { computed, reactive, ref } from 'vue'

import { confirmAction } from '../composables/UseConfirmDialog'
import { mainApiService } from '../core/AppContainer'
import type { MainApiModelOption, MainApiProfile } from '../services/MainApiService'
import InlineModelPicker from './InlineModelPicker.vue'

const initialState = mainApiService.getProfilesState()
const props = withDefaults(defineProps<{ assistant?: boolean; profileId?: string }>(), {
  assistant: false,
  profileId: '',
})
const emit = defineEmits<{ selected: [id: string] }>()
const profiles = ref<MainApiProfile[]>(initialState.profiles)
const activeProfileId = ref(initialState.activeProfileId)
const selectedProfileId = ref(
  props.assistant
    ? props.profileId === initialState.activeProfileId
      ? ''
      : initialState.profiles.some((profile) => profile.id === props.profileId)
        ? props.profileId
        : ''
    : initialState.activeProfileId,
)
const config = reactive<MainApiProfile>({
  ...(initialState.profiles.find((p) => p.id === selectedProfileId.value) ??
    mainApiService.getActiveProfile()),
})
const status = ref('')
const testing = ref(false)
const loadingModels = ref(false)
const modelOptions = ref<MainApiModelOption[]>([])
const outputTokenLimit = computed<number | ''>({
  get: () => (config.maxTokens > 0 ? config.maxTokens : ''),
  set: (value) => {
    config.maxTokens = Number(value) || 0
  },
})

const isActive = computed(() => config.id === activeProfileId.value)
const editableProfiles = computed(() =>
  profiles.value.filter((profile) => !props.assistant || profile.id !== activeProfileId.value),
)

function refresh(profileId = selectedProfileId.value): void {
  const state = mainApiService.getProfilesState()
  profiles.value = state.profiles
  activeProfileId.value = state.activeProfileId
  const selected =
    state.profiles.find((profile) => profile.id === profileId) ??
    state.profiles.find((profile) => profile.id === state.activeProfileId) ??
    state.profiles[0]!
  selectedProfileId.value = selected.id
  Object.assign(config, selected)
  modelOptions.value = []
}

function selectProfile(): void {
  if (props.assistant && !selectedProfileId.value) {
    emit('selected', '')
    status.value = ''
    return
  }
  refresh(selectedProfileId.value)
  status.value = ''
}

async function save(announce = true): Promise<MainApiProfile> {
  const saved = mainApiService.saveProfile({ ...config })
  await mainApiService.awaitCredentialWrites()
  refresh(saved.id)
  if (props.assistant) emit('selected', saved.id)
  if (announce) status.value = `已保存“${saved.name}”`
  return saved
}

async function activate(): Promise<void> {
  const saved = await save(false)
  mainApiService.setActiveProfile(saved.id)
  refresh(saved.id)
  status.value = `“${saved.name}”已设为主 API`
}

async function addProfile(): Promise<void> {
  const profile = mainApiService.createProfile(`API ${profiles.value.length + 1}`)
  await mainApiService.awaitCredentialWrites()
  refresh(profile.id)
  status.value = '已新建空白 API 配置'
}

async function duplicateProfile(): Promise<void> {
  const profile = mainApiService.createProfile(`${config.name} 副本`)
  const copied = mainApiService.saveProfile({
    ...config,
    id: profile.id,
    name: profile.name,
  })
  await mainApiService.awaitCredentialWrites()
  refresh(copied.id)
  status.value = '已复制当前配置；密钥也只保存在本设备'
}

async function removeProfile(): Promise<void> {
  if (profiles.value.length <= 1) {
    status.value = '至少需要保留一个 API 配置'
    return
  }
  if (
    !(await confirmAction({
      title: '删除 API 配置',
      message: `删除“${config.name}”吗？此操作只影响当前设备。`,
      confirmLabel: '删除',
      danger: true,
    }))
  )
    return
  const next = mainApiService.deleteProfile(config.id)
  await mainApiService.awaitCredentialWrites()
  refresh(next.id)
  if (props.assistant) {
    selectedProfileId.value = ''
    emit('selected', '')
  }
  status.value = 'API 配置已删除'
}

async function test(): Promise<void> {
  testing.value = true
  status.value = '正在发起最小生成请求…'
  try {
    const saved = await save(false)
    status.value = await mainApiService.testConnection(saved)
  } catch (error) {
    status.value = error instanceof Error ? error.message : '连接失败'
  } finally {
    testing.value = false
  }
}

async function loadModels(): Promise<void> {
  loadingModels.value = true
  status.value = '正在从接口拉取可用模型…'
  try {
    modelOptions.value = await mainApiService.listModels({ ...config })
    status.value = modelOptions.value.length
      ? `已拉取 ${modelOptions.value.length} 个模型；可直接选择，也可以继续手动输入`
      : '接口返回了空模型列表；仍可手动填写模型名'
  } catch (error) {
    modelOptions.value = []
    status.value = error instanceof Error ? error.message : '模型列表拉取失败'
  } finally {
    loadingModels.value = false
  }
}
</script>

<template>
  <section
    class="settings-section main-api-settings"
    :class="{ 'main-api-settings--assistant': assistant }"
  >
    <header v-if="!assistant">
      <div>
        <h3>主 API 配置</h3>
      </div>
      <span>{{ profiles.length }} 个 · 本机配置</span>
    </header>

    <div class="main-api-settings__profilebar">
      <label>
        <span>正在编辑</span>
        <span class="main-api-settings__control">
          <select v-model="selectedProfileId" aria-label="API 配置" @change="selectProfile">
            <option v-if="assistant" value="">使用主 API</option>
            <option v-for="profile in editableProfiles" :key="profile.id" :value="profile.id">
              {{ profile.name }}{{ profile.id === activeProfileId ? '（主 API）' : '' }}
            </option>
          </select>
        </span>
      </label>
      <button type="button" @click="addProfile">
        <span class="main-api-settings__button-face">新增</span>
      </button>
      <details class="main-api-settings__profiletools">
        <summary aria-label="管理 API 配置">
          <span class="main-api-settings__button-face">更多</span>
        </summary>
        <div class="main-api-settings__profilemenu">
          <button
            type="button"
            :disabled="assistant && !selectedProfileId"
            @click="duplicateProfile"
          >
            复制
          </button>
          <button
            type="button"
            class="is-danger"
            :disabled="assistant && !selectedProfileId"
            @click="removeProfile"
          >
            删除
          </button>
        </div>
      </details>
    </div>

    <div
      v-if="!assistant || selectedProfileId"
      class="main-api-settings__grid main-api-settings__basic"
    >
      <label>
        <span>配置名称</span>
        <span class="main-api-settings__control">
          <input v-model.trim="config.name" autocomplete="off" placeholder="例如：日常生成" />
        </span>
      </label>
      <label>
        <span>接口协议</span>
        <span class="main-api-settings__control">
          <select v-model="config.protocol" aria-label="接口协议">
            <option value="openai-compatible">OpenAI 兼容</option>
            <option value="anthropic-compatible">Anthropic 兼容</option>
          </select>
        </span>
      </label>
      <label class="main-api-settings__wide">
        <span>模型</span>
        <InlineModelPicker
          v-model="config.model"
          :options="modelOptions"
          :loading="loadingModels"
          @load="loadModels"
        />
      </label>
      <label class="main-api-settings__wide">
        <span>API URL</span>
        <span class="main-api-settings__control">
          <input
            v-model.trim="config.url"
            inputmode="url"
            autocomplete="url"
            :placeholder="
              config.protocol === 'openai-compatible'
                ? 'https://example.com/v1（也可填完整 /chat/completions）'
                : 'https://api.anthropic.com/v1（也可填完整 /messages）'
            "
          />
        </span>
      </label>
      <label class="main-api-settings__wide">
        <span>API 密钥</span>
        <span class="main-api-settings__control">
          <input
            v-model="config.apiKey"
            type="password"
            autocomplete="new-password"
            placeholder="无密钥接口可留空"
          />
        </span>
      </label>
    </div>
    <details v-if="!assistant || selectedProfileId" class="main-api-settings__advanced">
      <summary>
        <svg
          class="main-api-settings__chevron"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          aria-hidden="true"
        >
          <path d="m9 5 7 7-7 7" />
        </svg>
        更多设置<span>{{
          config.credentialPersistence === 'local' ? '本机保存' : '仅本次使用'
        }}</span>
      </summary>
      <div class="main-api-settings__grid">
        <label
          class="main-api-settings__wide main-api-settings__parameter-line main-api-settings__credential-mode"
        >
          <span>密钥保存</span>
          <span class="main-api-settings__control">
            <select v-model="config.credentialPersistence" aria-label="密钥保存方式">
              <option value="local">本机保存</option>
              <option value="session">仅本次使用</option>
            </select>
          </span>
        </label>
        <label>
          <span class="main-api-settings__range-label"
            >温度 <output>{{ config.temperature }}</output></span
          >
          <input v-model.number="config.temperature" type="range" min="0" max="2" step="0.05" />
        </label>
        <label>
          <span class="main-api-settings__range-label"
            >Top P <output>{{ config.topP }}</output></span
          >
          <input v-model.number="config.topP" type="range" min="0" max="1" step="0.05" />
        </label>
        <label>
          <span>传输方式</span>
          <span class="main-api-settings__control">
            <select v-model="config.stream">
              <option :value="false">非流式</option>
              <option :value="true">流式</option>
            </select>
          </span>
        </label>
        <label v-if="config.protocol === 'openai-compatible'">
          <span>推理深度</span>
          <span class="main-api-settings__control">
            <select v-model="config.reasoningEffort">
              <option value="auto">自动</option>
              <option value="none">无推理</option>
              <option value="minimal">最少</option>
              <option value="low">低</option>
              <option value="medium">中</option>
              <option value="high">高</option>
              <option value="xhigh">很高</option>
              <option value="max">最高</option>
            </select>
          </span>
        </label>
        <label v-if="config.protocol === 'openai-compatible'">
          <span>频率惩罚</span>
          <span class="main-api-settings__control">
            <input
              v-model.number="config.frequencyPenalty"
              type="number"
              min="-2"
              max="2"
              step="0.1"
            />
          </span>
        </label>
        <label v-if="config.protocol === 'openai-compatible'">
          <span>存在惩罚</span>
          <span class="main-api-settings__control">
            <input
              v-model.number="config.presencePenalty"
              type="number"
              min="-2"
              max="2"
              step="0.1"
            />
          </span>
        </label>
        <label class="main-api-settings__wide main-api-settings__parameter-line">
          <span>输出 Token</span>
          <span class="main-api-settings__control">
            <input
              v-model.number="outputTokenLimit"
              type="number"
              min="1"
              step="1"
              placeholder="留空不限制"
              aria-label="输出 Token 上限"
            />
          </span>
          <small v-if="config.protocol === 'anthropic-compatible'" class="main-api-settings__hint"
            >此协议要求填写输出上限。</small
          >
        </label>
      </div>
      <details class="main-api-settings__help">
        <summary>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.5-2.5 1.5-2.5 3M12 16h.01" /></svg
          >接口与密钥说明
        </summary>
        <p>
          本机保存使用设备加密；导出和备份默认不携带密钥。仅本次使用会在关闭应用后清除。网页接口需允许
          CORS。
        </p>
      </details>
    </details>
    <div v-if="!assistant || selectedProfileId" class="main-api-settings__actions">
      <button
        type="button"
        class="is-primary"
        :aria-label="assistant ? '保存并用于助手' : undefined"
        @click="save()"
      >
        <span class="main-api-settings__button-face">{{
          assistant ? '保存并使用' : '保存配置'
        }}</span>
      </button>
      <button type="button" :disabled="testing" aria-label="保存并测试连接" @click="test">
        <span class="main-api-settings__button-face">{{ testing ? '测试中…' : '保存并测试' }}</span>
      </button>
      <button
        v-if="!assistant && !isActive"
        class="main-api-settings__activate"
        type="button"
        @click="activate"
      >
        <span class="main-api-settings__button-face">设为主 API</span>
      </button>
      <p v-if="status" role="status">{{ status }}</p>
    </div>
  </section>
</template>

<style scoped>
.main-api-settings.main-api-settings {
  margin: 0;
  padding: 0.75rem;
  border: 1px solid var(--color-line);
  border-radius: 0.75rem;
  background: var(--color-surface-raised);
}
.main-api-settings > header {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.25rem 0.5rem;
  margin-bottom: 0.625rem;
}
.main-api-settings > header h3 {
  margin: 0;
  font-size: 1rem;
}
.main-api-settings > header > span {
  margin-left: auto;
  font-size: 0.75rem;
}
.main-api-settings__profilebar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: end;
  gap: 0.375rem;
  padding-bottom: 0.625rem;
  margin-bottom: 0.625rem;
  border-bottom: 1px solid var(--color-line);
}
.main-api-settings__profilebar button,
.main-api-settings__actions button {
  min-height: var(--size-touch);
}
.main-api-settings__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.25rem 0.625rem;
}
.main-api-settings label {
  display: grid;
  min-width: 0;
  gap: 0;
}
.main-api-settings label > span {
  color: var(--color-ink-soft);
  font-size: 0.8125rem;
}
.main-api-settings__wide {
  grid-column: 1 / -1;
}
.main-api-settings__actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: center;
  gap: 0.25rem 0.5rem;
  margin-top: 0.375rem;
}
.main-api-settings__actions p,
.main-api-settings__activate {
  grid-column: 1 / -1;
}
.main-api-settings__actions > button,
.main-api-settings__actions .main-api-settings__button-face {
  width: 100%;
}
.main-api-settings__actions p {
  margin: 0.25rem 0 0;
  color: var(--color-ink-soft);
  font-size: 0.8125rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.main-api-settings__profiletools {
  position: relative;
}
.main-api-settings__profiletools summary {
  display: grid;
  place-items: center;
  min-width: var(--size-touch);
  min-height: var(--size-touch);
  color: var(--button-color, var(--color-ink));
  cursor: pointer;
  list-style: none;
  font-size: 0.875rem;
}
.main-api-settings__profiletools summary::-webkit-details-marker {
  display: none;
}
.main-api-settings__profilemenu {
  position: absolute;
  z-index: 1;
  top: calc(100% + 4px);
  right: 0;
  display: grid;
  width: 112px;
  padding: 4px;
  border: 1px solid var(--dialog-border, var(--glass-border));
  border-radius: var(--dialog-radius, var(--glass-radius-panel));
  background: var(--dialog-background);
  box-shadow: var(--dialog-shadow, var(--glass-shadow));
}
.main-api-settings__profilemenu button {
  width: 100%;
}
.main-api-settings__advanced {
  margin-top: 0.625rem;
  border-top: 1px solid var(--color-line);
}
.main-api-settings__advanced > summary {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: var(--size-touch);
  color: var(--button-color, var(--color-ink));
  cursor: pointer;
  font-size: 0.875rem;
  list-style: none;
}
:is(.main-api-settings__advanced, .main-api-settings__help) > summary::-webkit-details-marker {
  display: none;
}
.main-api-settings__chevron {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
}
.main-api-settings__advanced[open] > summary .main-api-settings__chevron {
  transform: rotate(90deg);
}
.main-api-settings__advanced > summary span {
  margin-left: auto;
  color: var(--color-ink-soft);
  font-size: 0.75rem;
}
.main-api-settings__advanced .main-api-settings__grid {
  gap: 0.25rem 0.625rem;
}
.main-api-settings__control {
  position: relative;
  display: flex;
  align-items: center;
  min-width: 0;
  min-height: var(--size-touch);
}
.main-api-settings__control::before {
  content: '';
  position: absolute;
  inset: 4px 0;
  box-sizing: border-box;
  height: 36px;
  border: 1px solid var(--control-border, var(--color-line-strong));
  border-radius: var(--control-radius, var(--glass-radius-control));
  background: var(--control-background);
  box-shadow: var(--control-shadow);
  pointer-events: none;
}
.main-api-settings label.main-api-settings__parameter-line {
  grid-template-columns: 76px minmax(0, 1fr);
  align-items: center;
  column-gap: 0.5rem;
}
.main-api-settings__parameter-line small {
  grid-column: 2;
}
.main-api-settings__range-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.main-api-settings__range-label output {
  color: var(--color-ink);
  font-variant-numeric: tabular-nums;
}
.main-api-settings input:not([type='range']),
.main-api-settings select {
  position: relative;
  width: 100%;
  min-width: 0;
  min-height: var(--size-touch);
  padding: 0 0.625rem;
  border: 0;
  border-radius: var(--control-radius, var(--glass-radius-control));
  background: transparent;
  box-shadow: none;
  color: var(--color-ink);
  font: inherit;
  font-size: 0.875rem;
}
.main-api-settings input[type='range'] {
  width: 100%;
  margin: 0;
  min-height: var(--size-touch);
  appearance: none;
  background: transparent;
}
.main-api-settings input[type='range']::-webkit-slider-runnable-track {
  height: 3px;
  border-radius: 4px;
  background: var(--color-line);
}
.main-api-settings input[type='range']::-webkit-slider-thumb {
  width: 12px;
  height: 12px;
  margin-top: -4.5px;
  border: 2px solid var(--color-surface-raised);
  border-radius: 50%;
  background: var(--color-accent);
  appearance: none;
}
.main-api-settings input[type='range']::-moz-range-track {
  height: 3px;
  border-radius: 4px;
  background: var(--color-line);
}
.main-api-settings input[type='range']::-moz-range-thumb {
  width: 8px;
  height: 8px;
  border: 2px solid var(--color-surface-raised);
  border-radius: 50%;
  background: var(--color-accent);
}
.main-api-settings button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: var(--size-touch);
  min-height: var(--size-touch);
  padding: 0;
  border: 0;
  font-size: 0.875rem;
  color: var(--button-color, var(--color-ink));
  background: transparent;
  box-shadow: none;
}
.main-api-settings__button-face {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 36px;
  padding: 0 0.875rem;
  cursor: pointer;
  font: inherit;
}
.main-api-settings .is-danger {
  border-color: var(--color-danger);
  color: var(--color-danger);
}
.main-api-settings .is-primary .main-api-settings__button-face {
  color: var(--button-primary-color, var(--color-on-accent));
  border-color: var(--button-primary-border, var(--color-accent));
  background: var(--button-primary-background, var(--color-accent));
}
.main-api-settings button:disabled {
  opacity: 0.5;
}
.main-api-settings__hint {
  color: var(--color-ink-soft);
  font-size: 0.75rem;
  line-height: 1.45;
}
.main-api-settings__help > summary {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  min-height: var(--size-touch);
  color: var(--button-color, var(--color-ink-soft));
  font-size: 0.75rem;
  cursor: pointer;
  list-style: none;
}
.main-api-settings__help svg {
  width: 14px;
  height: 14px;
}
.main-api-settings__help p {
  margin: 0 0 0.5rem;
  color: var(--color-ink-soft);
  font-size: 0.75rem;
  line-height: 1.5;
}
.main-api-settings :deep(.inline-model-picker input) {
  position: relative;
  border: 1px solid var(--control-border, var(--color-line-strong));
  border-radius: var(--control-radius, var(--glass-radius-control));
  font-size: 0.875rem;
  background: var(--control-background);
  box-shadow: var(--control-shadow);
}
.main-api-settings :deep(.inline-model-picker__field::before) {
  content: '';
  grid-area: 1 / 1;
  align-self: center;
  height: 36px;
  box-sizing: border-box;
  border: 1px solid var(--control-border, var(--color-line-strong));
  border-radius: var(--control-radius, var(--glass-radius-control));
  background: var(--control-background);
  box-shadow: var(--control-shadow);
  pointer-events: none;
}
.main-api-settings :deep(.inline-model-picker__field > input) {
  grid-area: 1 / 1;
  border: 0;
  background: transparent;
  box-shadow: none;
}
.main-api-settings :deep(.inline-model-picker button) {
  font-size: 0.875rem;
}
.main-api-settings :deep(.inline-model-picker__field > button) {
  position: relative;
  isolation: isolate;
  min-height: var(--size-touch);
  border: 0;
  background: transparent;
  box-shadow: none;
}
.main-api-settings :deep(.inline-model-picker__field > button::before) {
  content: '';
  position: absolute;
  z-index: -1;
  inset: 4px 0;
  border: 1px solid var(--button-border, var(--color-line-strong));
  border-radius: var(--button-radius, var(--glass-radius-control));
  background: var(--button-background, var(--glass-panel-strong));
  box-shadow: var(--button-shadow, var(--glass-shadow));
  pointer-events: none;
}
</style>
