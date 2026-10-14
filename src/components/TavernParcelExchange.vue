<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { tavernHttpFetch } from '../services/TavernHttpTransport'
import { acquireRelayWorkerTarget } from '../services/RelayWorkerSettingsService'
import { browserStorageService, exportService, resourceService } from '../core/AppContainer'
import type { TavernSendContent } from '../types/BrowserPreferences'
import { confirmAction } from '../composables/UseConfirmDialog'
import { disableChatArchiveReadingScripts } from '../services/TavernChatArchiveCodec.mjs'
import { prepareChatReturn } from '../services/TavernChatReturn'
import {
  createParcel,
  readParcel,
  removeParcel,
  type ParcelFile,
} from '../services/BridgeParcelCodec.mjs'
import { bridgeKindOfResource } from '../utils/TavernBridgeDiff'
import type { ResourceSummary } from '../types/Resource'

const props = withDefaults(
  defineProps<{
    resources: ResourceSummary[]
    initialIds?: string[]
    includeChatScripts?: boolean
    sendContent?: TavernSendContent
  }>(),
  { sendContent: 'modified', includeChatScripts: true, initialIds: undefined },
)
const emit = defineEmits<{ 'import-files': [files: File[], onComplete?: () => void] }>()
const selected = ref<string[]>(props.initialIds ?? [])
const includeChatRegex = ref(false)
const hasSelectedChat = computed(() =>
  props.resources.some((item) => item.type === 'chat' && selected.value.includes(item.id)),
)
const resources = computed(() => props.resources.filter((item) => bridgeKindOfResource(item)))
const busy = ref(false)
const progress = ref('')
const error = ref('')
const outgoing = ref('')
const incoming = ref('')
const files = ref<ParcelFile[]>([])
const search = ref('')
const mode = ref<'receive' | 'send'>('receive')
const shown = ref(50)
let operation: AbortController | undefined
onBeforeUnmount(() => operation?.abort())
const visible = computed(() =>
  resources.value.filter((item) =>
    item.name.toLocaleLowerCase().includes(search.value.toLocaleLowerCase()),
  ),
)
// SRL-PUBLIC-SYNC: BEGIN WORKER-URL id=tavern-parcel-relay
let outgoingBase = ''
// SRL-PUBLIC-SYNC: END WORKER-URL id=tavern-parcel-relay
async function run(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  operation = new AbortController()
  error.value = ''
  progress.value = '正在准备…'
  try {
    await action()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '暂存失败'
  } finally {
    busy.value = false
    operation = undefined
  }
}
async function send() {
  const content = props.sendContent
  const options = { syncCharacterTags: browserStorageService.getModifiedResourceSyncTags() }
  // SRL-PUBLIC-SYNC: BEGIN REPLACE id=parcel-send-worker-setup
  await run(async () => {
    const worker = acquireRelayWorkerTarget()
    const base = worker.target.origin
    try {
      if (outgoing.value) throw new Error('请先复制当前口令，或删除当前暂存后再发送')
      if (selected.value.length > 100) throw new Error('每次最多暂存 100 项，请分批发送')
      const payload: ParcelFile[] = []
      const chatTargets: string[] = []
      let bytes = 0
      for (const id of selected.value) {
        if (operation?.signal.aborted) throw new Error('已取消暂存')
        const resource = await resourceService.get(id)
        const kind = resource && bridgeKindOfResource(resource)
        if (!resource || !kind) throw new Error('所选资源已不存在或不支持暂存')
        const chatPlan =
          kind === 'chat'
            ? await prepareChatReturn(resource, resourceService, undefined, includeChatRegex.value)
            : undefined
        if (chatPlan) chatTargets.push(`${resource.name} → ${chatPlan.targetLabel}`)
        const file = await exportService.createTavernTransferFile(
          resource,
          content,
          resourceService,
          undefined,
          options,
        )
        bytes += file.size
        if (bytes > 16 * 1024 * 1024)
          throw new Error('所选内容超过 16 MiB，请分批暂存或使用实时互传')
        payload.push({
          file,
          kind,
          displayName: resource.name,
          targetName: chatPlan
            ? chatPlan.avatar
            : typeof resource.metadata.extractedFromCharacterName === 'string'
              ? resource.metadata.extractedFromCharacterName
              : typeof resource.metadata.extractedFromPresetName === 'string'
                ? resource.metadata.extractedFromPresetName
                : typeof resource.metadata.sourceName === 'string'
                  ? resource.metadata.sourceName
                  : undefined,
        })
        if (chatPlan?.regexFile) {
          bytes += chatPlan.regexFile.size
          if (bytes > 16 * 1024 * 1024) throw new Error('聊天与配套正则超过 16 MiB，请使用实时互传')
          payload.push({
            file: chatPlan.regexFile,
            kind: 'regexCharacter',
            targetName: chatPlan.avatar,
            displayName: '聊天配套正则（停用）',
          })
        }
      }
      if (
        chatTargets.length &&
        !(await confirmAction({
          title: '确认聊天暂存范围',
          message:
            chatTargets.join('\n') +
            '\n\n领取时请再次核对酒馆角色。聊天将保留为新记录。' +
            (includeChatRegex.value
              ? '配套正则会添加到目标角色并保持停用。'
              : '只导入聊天记录，酒馆原有正则保持不变。'),
          confirmLabel: '确认并生成口令',
        }))
      )
        return
      const result = await createParcel(
        base,
        payload,
        (message) => {
          progress.value = message
        },
        { signal: operation?.signal, fetcher: tavernHttpFetch },
      )
      outgoing.value = result.ticket
      outgoingBase = base
    } finally {
      worker.release()
    }
  })
  // SRL-PUBLIC-SYNC: END REPLACE id=parcel-send-worker-setup
}
async function receive() {
  // SRL-PUBLIC-SYNC: BEGIN REPLACE id=parcel-receive-worker-setup
  await run(async () => {
    const worker = acquireRelayWorkerTarget()
    try {
      const base = worker.target.origin
      files.value = []
      files.value = await readParcel(
        base,
        incoming.value,
        (message) => {
          progress.value = message
        },
        { signal: operation?.signal, fetcher: tavernHttpFetch },
      )
    } finally {
      worker.release()
    }
  })
  // SRL-PUBLIC-SYNC: END REPLACE id=parcel-receive-worker-setup
}
async function copy() {
  await run(async () => {
    try {
      await navigator.clipboard.writeText(outgoing.value)
    } catch {
      throw new Error('复制未成功，请长按下方口令全选复制')
    }
    progress.value = '口令已复制，现在可以切换到酒馆领取'
  })
}
async function remove() {
  // SRL-PUBLIC-SYNC: BEGIN REPLACE id=parcel-remove-worker-setup
  await run(async () => {
    await removeParcel(outgoingBase, outgoing.value, {
      signal: operation?.signal,
      fetcher: tavernHttpFetch,
    })
    outgoing.value = ''
    progress.value = '暂存已删除'
  })
  // SRL-PUBLIC-SYNC: END REPLACE id=parcel-remove-worker-setup
}
async function importReceived() {
  const includeScripts = props.includeChatScripts
  await run(async () => {
    const received: File[] = []
    for (const item of files.value) {
      operation?.signal.throwIfAborted()
      received.push(
        !includeScripts && item.file.name.toLowerCase().endsWith('.srlchat')
          ? await disableChatArchiveReadingScripts(item.file)
          : item.file,
      )
    }
    emit('import-files', received)
    files.value = []
    progress.value = '文件已交给资源库导入；请查看导入结果通知。暂存将在到期后删除。'
  })
}
</script>

<template>
  <details class="tavern-parcel" data-srl-controls>
    <summary>
      <span><strong>加密暂存</strong><small>两端不方便同时在线时使用</small></span
      ><span class="tavern-parcel__chevron" aria-hidden="true">⌄</span>
    </summary>
    <div class="tavern-parcel__body">
      <!-- SRL-PUBLIC-SYNC: BEGIN REPLACE id=parcel-worker-settings-hint -->
      <p class="tavern-parcel__hint">
        实时互传仍可正常使用。暂存完成后再切换应用，30 分钟内凭口令领取；每次最多 16
        MiB。两端需使用相同中继，可在设置中配置自建 Worker。
      </p>
      <!-- SRL-PUBLIC-SYNC: END REPLACE id=parcel-worker-settings-hint -->
      <div class="tavern-parcel__modes" aria-label="暂存方向">
        <button
          type="button"
          :aria-pressed="mode === 'receive'"
          :disabled="busy"
          @click="mode = 'receive'"
        >
          从酒馆领取
        </button>
        <button
          type="button"
          :aria-pressed="mode === 'send'"
          :disabled="busy"
          @click="mode = 'send'"
        >
          发给酒馆
        </button>
      </div>
      <fieldset v-if="mode === 'receive'" :disabled="busy">
        <label
          >提取口令<textarea
            v-model="incoming"
            rows="3"
            placeholder="粘贴 SRL1 或 SRL2 开头的完整口令"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
          />
        </label>
        <button
          class="tavern-parcel__primary"
          type="button"
          :disabled="!incoming.trim()"
          @click="receive"
        >
          领取并校验
        </button>
        <div v-if="files.length" class="tavern-parcel__result">
          <strong>已校验 {{ files.length }} 项</strong>
          <ul>
            <li v-for="(item, index) in files" :key="index">{{ item.displayName }}</li>
          </ul>
          <button class="tavern-parcel__primary" type="button" @click="importReceived">
            导入资源库
          </button>
        </div>
      </fieldset>
      <fieldset v-else :disabled="busy">
        <template v-if="!outgoing">
          <label v-if="hasSelectedChat"
            >聊天导入范围<select v-model="includeChatRegex">
              <option :value="false">只导入聊天记录（默认）</option>
              <option :value="true">同时导入配套正则（停用）</option>
            </select></label
          >
          <label
            >选择资源<input
              v-model="search"
              type="search"
              placeholder="搜索资源名称"
              @input="shown = 50"
          /></label>
          <div class="tavern-parcel__resources">
            <label v-for="item in visible.slice(0, shown)" :key="item.id"
              ><input v-model="selected" type="checkbox" :value="item.id" /><span
                >{{ item.name }}<small>{{ item.fileName }}</small></span
              ></label
            >
            <p v-if="!visible.length" class="tavern-parcel__hint">没有匹配的资源</p>
            <button v-if="visible.length > shown" type="button" @click="shown += 50">
              再显示 50 项
            </button>
          </div>
          <button
            class="tavern-parcel__primary"
            type="button"
            :disabled="!selected.length"
            @click="send"
          >
            暂存所选 {{ selected.length }} 项
          </button>
        </template>
        <div v-else class="tavern-parcel__result">
          <strong>暂存就绪，可以切换到酒馆</strong>
          <label
            >提取口令<textarea
              :value="outgoing"
              readonly
              rows="3"
              @focus="($event.target as HTMLTextAreaElement).select()"
            />
          </label>
          <small>口令包含解密密钥，仅交给接收方。关闭本页前请先复制。</small>
          <div class="tavern-parcel__actions">
            <button class="tavern-parcel__primary" type="button" @click="copy">复制口令</button
            ><button type="button" @click="remove">删除暂存</button>
          </div>
        </div>
      </fieldset>
      <div v-if="busy || progress || error" class="tavern-parcel__feedback">
        <p v-if="error" role="alert">{{ error }}</p>
        <p v-else role="status">{{ progress }}</p>
        <button v-if="busy" type="button" @click="operation?.abort()">取消</button>
      </div>
    </div>
  </details>
</template>

<style scoped>
.tavern-parcel {
  width: min(100%, 34rem);
  min-width: 0;
  margin: 0.75rem auto;
  border-block: 1px solid var(--color-line);
  color: var(--color-ink);
}
summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.85rem 0.25rem;
  cursor: pointer;
  list-style: none;
}
summary::-webkit-details-marker {
  display: none;
}
summary > span:first-child {
  display: grid;
  gap: 0.2rem;
}
summary strong {
  font-size: var(--text-body);
}
small,
.tavern-parcel__hint {
  color: var(--color-ink-soft);
  font-size: var(--text-caption);
  line-height: 1.5;
}
.tavern-parcel__chevron {
  font-size: 1.2rem;
}
.tavern-parcel[open] .tavern-parcel__chevron {
  transform: rotate(180deg);
}
.tavern-parcel__body {
  display: grid;
  gap: 0.75rem;
  padding: 0 0.25rem 0.85rem;
}
p {
  margin: 0;
  overflow-wrap: anywhere;
  line-height: 1.5;
}
.tavern-parcel__modes {
  display: flex;
  padding: 0.2rem;
  border-radius: var(--radius-control);
  background: var(--color-surface-raised);
  border: 1px solid var(--color-line);
}
.tavern-parcel__modes button {
  flex: 1;
}
.tavern-parcel__modes button[aria-pressed='true'] {
  background: var(--selection-background, var(--color-accent-soft));
  color: var(--selection-color, var(--color-accent));
  border-color: var(--selection-border, var(--color-accent));
  font-weight: 700;
}
fieldset {
  display: grid;
  gap: 0.75rem;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
label {
  display: grid;
  gap: 0.35rem;
  min-width: 0;
  font-size: var(--text-body);
}
select,
input:not([type='checkbox']),
textarea {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  padding: 0.65rem 0.75rem;
  font: inherit;
  font-size: 16px;
  resize: vertical;
}
button {
  min-height: 44px;
  padding: 0.5rem 0.75rem;
  font: inherit;
  font-size: var(--text-body);
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
button.tavern-parcel__primary {
  background: var(--button-primary-background, var(--color-accent));
  color: var(--button-primary-color, var(--color-on-accent));
  border-color: var(--button-primary-border, var(--color-accent));
  font-weight: 650;
}
.tavern-parcel__resources {
  max-height: 240px;
  overflow: auto;
  border-block: 1px solid var(--color-line);
}
.tavern-parcel__resources label {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  min-height: 48px;
  padding: 0.5rem 0.25rem;
  border-bottom: 1px solid var(--color-line);
  cursor: pointer;
}
.tavern-parcel__resources span {
  display: grid;
  min-width: 0;
  overflow-wrap: anywhere;
  gap: 0.15rem;
}
input[type='checkbox'] {
  flex: none;
  width: 18px;
  height: 18px;
  accent-color: var(--color-accent);
}
.tavern-parcel__result {
  display: grid;
  gap: 0.6rem;
}
.tavern-parcel__actions,
.tavern-parcel__feedback {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.tavern-parcel__actions > button:first-child,
.tavern-parcel__feedback p {
  flex: 1;
}
.tavern-parcel__feedback {
  padding-top: 0.5rem;
  font-size: var(--text-caption);
}
.tavern-parcel__feedback button {
  flex: none;
}
ul {
  margin: 0;
  padding-inline-start: 1.25rem;
  max-height: 180px;
  overflow: auto;
  overflow-wrap: anywhere;
}
</style>
