<script setup lang="ts">
import '../FeatureStyles.css'
import { computed, onBeforeUnmount, onMounted, ref, toRaw, useTemplateRef, watch } from 'vue'
import { personalResourceService } from '../core/PersonalResourceContainer'
import { secretResourceService } from '../services/SecretResourceService'
import { isNativeSecurityAvailable } from '../core/NativeSecurity'
import { type Resource } from '../types/Resource'
import type { PersonalResourceDocument, PersonalResourceKind } from '../types/PersonalResource'
import { downloadBlob } from '../utils/LibraryFormatting'
import { confirmAction } from '../composables/UseConfirmDialog'
import PocketPhoneContents from './PocketPhoneContents.vue'
import PocketPhoneIconPicker from './PocketPhoneIconPicker.vue'
import { EXTRA_STORY_TEXT_ACCEPT, extractExtraStoryText } from '../parser/ExtraStoryText'

const props = defineProps<{
  kind: PersonalResourceKind
  resource?: Resource
  embedded?: boolean
  settingsOpen?: boolean
}>()
const emit = defineEmits<{
  close: []
  saved: [resource: Resource]
  busy: [value: boolean]
  'open-settings': []
}>()
const draft = ref<PersonalResourceDocument>({
  format: 'srl-personal-resource',
  version: 1,
  kind: props.kind,
  name: '',
  text: '',
  url: '',
  attachments: [],
  fields: [],
  ...(props.kind === 'secret' ? { protection: 'none' as const } : {}),
})
const currentResource = ref(props.resource)
const editing = ref(!props.resource)
const notesEditorAvailable = ref(props.kind === 'pocketPhone')
const notesEditorOpen = ref(false)
const inline = computed(() => props.embedded && !editing.value)
const loaded = ref(false)
const typeTitle = { extraStory: '番外指令', pocketPhone: '小手机', secret: '密钥资料' }
const creationTitle = {
  extraStory: '添加番外指令',
  pocketPhone: '收纳小手机',
  secret: '保存密钥资料',
}
const title = computed(() =>
  editing.value
    ? currentResource.value
      ? `编辑${typeTitle[props.kind]}`
      : creationTitle[props.kind]
    : draft.value.name || typeTitle[props.kind],
)
let editBaseline = ''
const files = new Map<string, File>()
const iconPicker = useTemplateRef<InstanceType<typeof PocketPhoneIconPicker>>('iconPicker')
async function readPhoneFile(path: string): Promise<Blob> {
  const file = files.get(path)
  if (file) return file
  if (currentResource.value) return personalResourceService.attachment(currentResource.value, path)
  throw new Error('附件不存在')
}
const apkInput = useTemplateRef<HTMLInputElement>('apkInput')
const sourceInput = useTemplateRef<HTMLInputElement>('sourceInput')
const folderInput = useTemplateRef<HTMLInputElement>('folderInput')
const extraTextInput = useTemplateRef<HTMLInputElement>('extraTextInput')
const importLifetime = new AbortController()
const password = ref('')
const passwordExists = ref(true)
const sessionReady = ref(false)
const locked = ref(false)
const busy = ref(false)
watch(busy, (value) => emit('busy', value), { flush: 'sync' })
const status = ref('')
const native = isNativeSecurityAvailable()
let stored: PersonalResourceDocument | undefined
const needsPassword = computed(
  () =>
    draft.value.protection !== 'none' &&
    draft.value.fields.some((field) => field.private) &&
    !locked.value,
)
const encryptFields = computed({
  get: () => draft.value.protection !== 'none',
  set: (encrypt: boolean) => {
    if (locked.value) return
    if (encrypt) {
      delete draft.value.protection
      void refreshProtection().catch((error: unknown) => {
        status.value = error instanceof Error ? error.message : '读取密码设置失败'
      })
    } else {
      draft.value.protection = 'none'
      delete draft.value.protected
    }
  },
})
function showProtectionHelp() {
  void confirmAction({
    title: '密钥加密说明',
    message: encryptFields.value
      ? '勾选私密的字段使用统一密码加密，名称和备注可直接读取。导出和云备份保留加密，换机查看时仍需原密码。'
      : '未启用密码加密。字段在本机原件和备份中以明文保存，有文件或云端访问权限的人可以读取。保存和恢复无需设置统一密码。',
    confirmLabel: '知道了',
    cancelLabel: '关闭',
  })
}

async function refreshProtection() {
  if (props.kind !== 'secret' || (draft.value.protection === 'none' && !draft.value.protected)) {
    sessionReady.value = secretResourceService.isUnlocked()
    return
  }
  passwordExists.value = await secretResourceService.hasPassword()
  sessionReady.value =
    secretResourceService.isUnlocked() ||
    (!editing.value && secretResourceService.hasRememberedPassword(draft.value))
}
watch(
  () => props.settingsOpen,
  async (open) => {
    if (open) return
    await refreshProtection()
    if (!sessionReady.value && !editing.value) lock()
  },
)
onMounted(async () => {
  busy.value = true
  try {
    if (props.resource) {
      stored = toRaw(await personalResourceService.read(props.resource))
      draft.value = structuredClone(stored)
      draft.value.name = props.resource.name
      locked.value = Boolean(stored.protected)
      if (props.kind === 'secret' && !stored.protected) draft.value.protection = 'none'
    }
    await refreshProtection()
    editBaseline = JSON.stringify(draft.value)
    loaded.value = true
  } catch (error) {
    status.value = error instanceof Error ? error.message : '读取失败'
  } finally {
    busy.value = false
  }
})
function startEditing() {
  if (locked.value || !loaded.value || busy.value) return
  if (props.resource) draft.value.name = props.resource.name
  editBaseline = JSON.stringify(draft.value)
  status.value = ''
  notesEditorAvailable.value =
    props.kind === 'pocketPhone' || (props.kind === 'secret' && Boolean(draft.value.text))
  notesEditorOpen.value = Boolean(draft.value.text)
  editing.value = true
  sessionReady.value = secretResourceService.isUnlocked()
}
function handleEnter(event: KeyboardEvent) {
  if (event.isComposing) return
  if (
    inline.value &&
    locked.value &&
    event.target instanceof HTMLInputElement &&
    event.target.type === 'password'
  ) {
    event.preventDefault()
    event.stopPropagation()
    void unlock()
  }
}
async function leaveEditing(): Promise<boolean> {
  if (busy.value) return false
  if (
    editing.value &&
    loaded.value &&
    JSON.stringify(draft.value) !== editBaseline &&
    !(await confirmAction({
      title: '放弃未保存的修改？',
      message: '离开后将恢复上次保存的内容。',
      confirmLabel: '放弃修改',
      cancelLabel: '继续编辑',
    }))
  )
    return false
  if (!currentResource.value) {
    emit('close')
    return true
  }
  if (stored) draft.value = structuredClone(stored)
  locked.value = Boolean(stored?.protected)
  sessionReady.value =
    secretResourceService.isUnlocked() || secretResourceService.hasRememberedPassword(draft.value)
  password.value = ''
  files.clear()
  status.value = ''
  editing.value = false
  editBaseline = ''
  return true
}
async function requestClose() {
  if (busy.value) return
  if (editing.value) {
    if ((await leaveEditing()) && currentResource.value && !props.embedded) emit('close')
  } else emit('close')
}
function requestBack() {
  if (editing.value) void leaveEditing()
  else void requestClose()
}
defineExpose({ requestBack, editing })
function lock(clearSession = false) {
  if (clearSession) {
    secretResourceService.lock()
    sessionReady.value = false
  }
  editBaseline = ''
  if (props.kind !== 'secret') return
  // Persisted private values are always restored from their encrypted source after a lock.
  if (stored?.protected) {
    draft.value.fields = structuredClone(stored.fields)
    draft.value.protected = stored.protected
    locked.value = true
  }
  password.value = ''
}

onBeforeUnmount(() => {
  importLifetime.abort()
  lock()
  files.clear()
})

async function importExtraText(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || busy.value) return
  busy.value = true
  status.value = '正在提取正文…'
  try {
    const text = await extractExtraStoryText(file, importLifetime.signal)
    if (
      draft.value.text &&
      !(await confirmAction({
        title: '替换现有番外正文？',
        message: `将使用“${file.name}”提取的文字替换当前正文，保存后才写入资源。`,
        confirmLabel: '替换正文',
        cancelLabel: '保留当前正文',
      }))
    ) {
      status.value = ''
      return
    }
    if (importLifetime.signal.aborted) return
    draft.value.text = text
    if (!draft.value.name.trim())
      draft.value.name = file.name.replace(/\.[^.]+$/u, '').slice(0, 160)
    status.value = `已提取 ${text.length} 字符，可编辑后保存`
  } catch (error) {
    if (!importLifetime.signal.aborted)
      status.value = error instanceof Error ? error.message : '正文提取失败'
  } finally {
    busy.value = false
  }
}

async function unlock(biometric = false) {
  busy.value = true
  try {
    draft.value.fields = biometric
      ? await secretResourceService.revealBiometric(draft.value)
      : await secretResourceService.reveal(draft.value, password.value || undefined)
    locked.value = false
    sessionReady.value =
      secretResourceService.isUnlocked() || secretResourceService.hasRememberedPassword(draft.value)
    if (sessionReady.value) password.value = ''
    status.value = ''
  } catch (error) {
    status.value = error instanceof Error ? error.message : '解锁失败'
    sessionReady.value = false
  } finally {
    busy.value = false
  }
}
function addField() {
  const id = crypto.randomUUID()
  draft.value.fields.push({ id, label: '', value: '', private: true })
}
async function addFiles(event: Event, kind: 'apk' | 'source') {
  const input = event.target as HTMLInputElement
  for (const file of Array.from(input.files ?? [])) {
    if (kind === 'apk' && !/\.apk$/i.test(file.name)) {
      status.value = 'APK 附件请选择 .apk 文件'
      continue
    }
    const path = `attachments/${crypto.randomUUID()}`
    files.set(path, file)
    draft.value.attachments.push({
      path,
      name: file.webkitRelativePath || file.name,
      kind,
      size: file.size,
    })
  }
  input.value = ''
  await iconPicker.value?.readFiles(kind)
}
function removeAttachment(path: string) {
  draft.value.attachments = draft.value.attachments.filter((item) => item.path !== path)
  files.delete(path)
}
async function copy(value: string) {
  try {
    await navigator.clipboard.writeText(value)
    status.value = '已复制到剪贴板'
  } catch {
    status.value = '复制失败，请选择文本后复制'
  }
}
async function downloadAttachment(path: string) {
  try {
    const item = draft.value.attachments.find((entry) => entry.path === path)!
    const blob =
      files.get(path) ??
      (currentResource.value
        ? await personalResourceService.attachment(currentResource.value, path)
        : undefined)
    if (blob) downloadBlob(blob, item.name.split('/').at(-1)!)
  } catch (error) {
    status.value = error instanceof Error ? error.message : '附件读取失败'
  }
}
async function save() {
  if (busy.value || !loaded.value) return
  busy.value = true
  try {
    iconPicker.value?.cancelPending()
    if (props.kind === 'pocketPhone' && !draft.value.url.trim() && !draft.value.attachments.length)
      throw new Error('请填写访问网址或添加文件')
    let document = structuredClone(toRaw(draft.value))
    if (props.kind === 'secret' && !locked.value && document.protection !== 'none') {
      document = await secretResourceService.protect(
        document,
        secretResourceService.isUnlocked() ? undefined : password.value || undefined,
      )
    }
    const resource = await personalResourceService.save(document, files, currentResource.value)
    currentResource.value = resource
    stored = structuredClone(document)
    draft.value = structuredClone(document)
    locked.value = Boolean(document.protected)
    passwordExists.value ||= Boolean(document.protected)
    sessionReady.value = secretResourceService.isUnlocked()
    password.value = ''
    files.clear()
    editing.value = false
    editBaseline = ''
    status.value = '已保存'
    emit('saved', resource)
  } catch (error) {
    status.value = error instanceof Error ? error.message : '保存失败'
  } finally {
    busy.value = false
  }
}
async function exportPlain() {
  if (locked.value) {
    status.value = '请先解锁私密字段'
    return
  }
  if (
    !(await confirmAction({
      title: '导出明文密钥资源',
      message: '文件包含当前卡片的私密字段，任何拿到文件的人都能读取。请只保存到你信任的位置。',
      confirmLabel: '导出明文',
    }))
  )
    return
  downloadBlob(
    new Blob(
      [JSON.stringify({ ...draft.value, protection: 'none', protected: undefined }, null, 2)],
      {
        type: 'application/json',
      },
    ),
    `${draft.value.name || '部署资料'}-明文.srl-resource.json`,
  )
}
</script>

<template>
  <Teleport to="body" :disabled="inline">
    <div
      v-show="!settingsOpen"
      :class="inline ? undefined : 'editor-overlay personal-resource-editor-overlay'"
      @click.self="!inline && requestClose()"
    >
      <section
        :class="[
          inline ? 'personal-resource-content' : 'editor-sheet personal-resource-editor',
          { 'personal-resource-content--phone': inline && kind === 'pocketPhone' },
        ]"
        :role="inline ? undefined : 'dialog'"
        :aria-modal="inline ? undefined : true"
        :aria-labelledby="inline ? undefined : 'personal-resource-title'"
      >
        <header v-if="!inline" class="editor-sheet__header">
          <h2 id="personal-resource-title">{{ title }}</h2>
          <button
            class="editor-sheet__close"
            :disabled="busy"
            aria-label="关闭"
            @click="requestClose"
          >
            ×
          </button>
        </header>
        <p v-if="!loaded" role="status">{{ status || '正在读取…' }}</p>
        <component
          :is="inline ? 'div' : 'form'"
          v-else
          :class="inline ? 'personal-resource-content__body' : 'editor-form'"
          @submit.prevent="editing ? save() : locked && unlock()"
          @keydown.enter="handleEnter"
        >
          <PocketPhoneContents
            v-if="kind === 'pocketPhone' && !editing"
            :document="draft"
            :busy="busy"
            @edit="startEditing"
            @download="downloadAttachment"
          />
          <fieldset v-else :disabled="busy" class="personal-resource-editor__body">
            <div
              v-if="!editing && !locked"
              class="personal-resource-editor__actions personal-resource-editor__actions--read"
            >
              <button
                v-if="kind === 'extraStory'"
                class="button button--primary"
                type="button"
                :disabled="!draft.text"
                @click="copy(draft.text)"
              >
                复制番外指令
              </button>
              <button class="button button--quiet" type="button" @click="startEditing">编辑</button>
              <button
                v-if="kind === 'secret' && !locked && stored?.protected"
                class="button button--quiet"
                type="button"
                @click="lock(true)"
              >
                锁定私密内容
              </button>
            </div>
            <template v-if="editing">
              <label v-if="!embedded" class="field"
                ><span>名称</span
                ><input v-model="draft.name" class="field__control" maxlength="160" required
              /></label>
              <div v-if="kind === 'extraStory'" class="field">
                <div class="personal-resource-editor__text-heading">
                  <label for="personal-extra-text">番外指令</label>
                  <button
                    class="button button--quiet personal-resource-editor__import"
                    type="button"
                    @click="extraTextInput?.click()"
                  >
                    导入 TXT/Word
                  </button>
                </div>
                <input
                  ref="extraTextInput"
                  type="file"
                  hidden
                  :accept="EXTRA_STORY_TEXT_ACCEPT"
                  aria-label="导入 TXT/Word 文件"
                  @change="importExtraText"
                />
                <textarea
                  id="personal-extra-text"
                  v-model="draft.text"
                  class="field__control"
                  rows="8"
                  required
                  placeholder="粘贴想保存、下次复制使用的番外指令"
                />
              </div>
              <template v-if="kind === 'pocketPhone'">
                <label class="field"
                  ><span>访问网址</span
                  ><input
                    v-model="draft.url"
                    type="url"
                    class="field__control"
                    placeholder="https://"
                    @change="iconPicker?.readWebsite()"
                /></label>
                <PocketPhoneIconPicker
                  ref="iconPicker"
                  :document="draft"
                  :read-file="readPhoneFile"
                  @change="
                    (icons, selected) => {
                      draft.icons = icons
                      draft.iconSource = selected
                    }
                  "
                />
                <details :open="draft.attachments.length > 0">
                  <summary>
                    安装包与源码附件<span v-if="draft.attachments.length"
                      >（{{ draft.attachments.length }}）</span
                    >
                  </summary>
                  <div class="personal-resource-editor__body">
                    <button class="button button--quiet" type="button" @click="apkInput?.click()">
                      添加 APK 安装包
                    </button>
                    <input
                      ref="apkInput"
                      hidden
                      aria-label="APK 安装包"
                      type="file"
                      accept=".apk"
                      multiple
                      @change="addFiles($event, 'apk')"
                    />
                    <button
                      class="button button--quiet"
                      type="button"
                      @click="sourceInput?.click()"
                    >
                      添加源码文件或 ZIP
                    </button>
                    <input
                      ref="sourceInput"
                      hidden
                      aria-label="源码文件或 ZIP"
                      type="file"
                      multiple
                      @change="addFiles($event, 'source')"
                    />
                    <details>
                      <summary>选择整个源码文件夹</summary>
                      <button
                        class="button button--quiet"
                        type="button"
                        @click="folderInput?.click()"
                      >
                        选择文件夹
                      </button>
                      <input
                        ref="folderInput"
                        hidden
                        aria-label="源码文件夹（浏览器支持时可用）"
                        type="file"
                        webkitdirectory
                        multiple
                        @change="addFiles($event, 'source')"
                      />
                    </details>
                  </div>
                </details>
              </template>
            </template>
            <p v-else-if="kind === 'extraStory'" class="personal-resource-editor__text">
              {{ draft.text || '尚未填写番外指令。' }}
            </p>
            <ul
              v-if="kind === 'pocketPhone' && draft.attachments.length"
              class="personal-resource-editor__files"
              aria-label="已收纳文件"
            >
              <li v-for="item in draft.attachments" :key="item.path">
                <span
                  >{{ item.name
                  }}<small
                    >{{ item.kind === 'apk' ? '安装包' : '源码' }} ·
                    {{ (item.size / 1024).toFixed(0) }} KB</small
                  ></span
                >
                <button
                  class="button button--quiet"
                  type="button"
                  @click="removeAttachment(item.path)"
                >
                  移除
                </button>
              </li>
            </ul>
            <template v-if="kind === 'secret'">
              <div v-if="editing" class="personal-resource-editor__protection">
                <label class="personal-resource-editor__privacy">
                  <input v-model="encryptFields" type="checkbox" aria-label="使用统一密码加密" />
                  使用统一密码加密（可选）
                </label>
                <button
                  class="personal-resource-editor__help"
                  type="button"
                  aria-label="密钥加密说明"
                  @click="showProtectionHelp"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.7"
                    aria-hidden="true"
                  >
                    <circle cx="12" cy="12" r="9" />
                    <path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4" stroke-linecap="round" />
                    <circle cx="12" cy="16.5" r=".8" fill="currentColor" stroke="none" />
                  </svg>
                </button>
              </div>
              <p v-else class="personal-resource-editor__hint">
                {{
                  locked
                    ? '私密内容已锁定，解锁后可查看、复制和编辑。'
                    : stored?.protected
                      ? '私密内容已解锁，离开后会重新锁定。'
                      : '此资料未使用密码加密，备份保留原有内容。'
                }}
              </p>
              <div
                v-for="(field, index) in draft.fields"
                :key="field.id"
                class="personal-resource-editor__field"
              >
                <template v-if="editing">
                  <div class="personal-resource-editor__field-heading">
                    <input
                      v-model="field.label"
                      class="field__control"
                      :aria-label="`字段名称 ${index + 1}`"
                      placeholder="字段名称"
                      required
                    />
                    <label class="personal-resource-editor__privacy"
                      ><input
                        v-model="field.private"
                        type="checkbox"
                        :aria-label="`私密 ${index + 1}`"
                      />私密</label
                    >
                    <button
                      class="button button--quiet"
                      type="button"
                      :aria-label="`删除字段 ${index + 1}`"
                      @click="draft.fields.splice(index, 1)"
                    >
                      ×
                    </button>
                  </div>
                  <textarea
                    v-model="field.value"
                    class="field__control"
                    rows="2"
                    :aria-label="field.label || `字段内容 ${index + 1}`"
                    placeholder="填写内容"
                    autocomplete="off"
                  />
                </template>
                <template v-else>
                  <span class="personal-resource-editor__field-value"
                    ><strong>{{ field.label || '未命名字段' }}</strong
                    ><span class="personal-resource-editor__text">{{
                      locked && field.private ? '••••••••' : field.value || '未填写'
                    }}</span></span
                  >
                  <button
                    class="button button--quiet"
                    type="button"
                    :aria-label="`复制${field.label || '字段'}`"
                    :disabled="(locked && field.private) || !field.value"
                    @click="copy(field.value)"
                  >
                    复制
                  </button>
                </template>
              </div>
              <button v-if="editing" class="button button--quiet" type="button" @click="addField">
                ＋添加字段
              </button>
              <template v-if="locked || (editing && needsPassword && !sessionReady)">
                <label v-if="(passwordExists || locked) && !sessionReady" class="field">
                  <span>统一密码</span
                  ><input
                    v-model="password"
                    type="password"
                    class="field__control"
                    autocomplete="off"
                    minlength="8"
                  />
                </label>
                <p v-if="!passwordExists && !locked" class="personal-resource-editor__hint">
                  请先在总设置中设置统一密码。返回后可继续填写，当前草稿会保留。
                </p>
                <button class="button button--quiet" type="button" @click="emit('open-settings')">
                  {{
                    passwordExists ? (native ? '密码设置 / 找回' : '密码设置') : '去总设置设置密码'
                  }}
                </button>
              </template>
              <p v-if="locked && !native" class="personal-resource-editor__hint">
                iOS 和网页端不支持密码找回。若已在安卓 APK 开启指纹找回，可在原设备上找回统一密码。
              </p>
              <div v-if="locked" class="personal-resource-editor__actions">
                <button
                  class="button button--primary"
                  :type="inline ? 'button' : 'submit'"
                  @click="inline && unlock()"
                >
                  解锁
                </button>
                <button
                  v-if="native"
                  class="button button--quiet"
                  type="button"
                  @click="unlock(true)"
                >
                  指纹解锁
                </button>
              </div>
              <details v-if="!editing && !locked">
                <summary>更多操作</summary>
                <button class="button button--quiet" type="button" @click="exportPlain">
                  导出当前卡片（明文）
                </button>
              </details>
            </template>
            <details
              v-if="editing && notesEditorAvailable"
              :open="notesEditorOpen"
              @toggle="notesEditorOpen = ($event.target as HTMLDetailsElement).open"
            >
              <summary>备注（可选，公开显示）</summary>
              <label class="field"
                ><span>备注</span
                ><textarea
                  v-model="draft.text"
                  class="field__control"
                  rows="3"
                  placeholder="用途或使用说明"
                />
              </label>
            </details>
            <p
              v-else-if="!editing && kind === 'pocketPhone' && draft.text"
              class="personal-resource-editor__text"
            >
              {{ draft.text }}
            </p>
          </fieldset>
          <p v-if="status" role="status">{{ status }}</p>
          <footer v-if="editing" class="personal-resource-editor__actions">
            <button
              class="button button--quiet"
              type="button"
              :disabled="busy"
              @click="leaveEditing"
            >
              {{ currentResource ? '取消编辑' : '取消' }}
            </button>
            <button class="button button--primary" type="submit" :disabled="busy">
              {{ busy ? '保存中…' : '保存' }}
            </button>
          </footer>
        </component>
      </section>
    </div>
  </Teleport>
</template>
<style scoped src="../styles/PersonalResourceEditor.css"></style>
