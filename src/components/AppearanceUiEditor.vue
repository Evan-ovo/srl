<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { CustomCssScope } from '../types/BrowserPreferences'
import type { CustomUiViews, CustomUiView } from '../types/UiCustomization'
import { createEditableUiView } from '../core/UiViewStarter'
import { normalizeUiViews } from '../core/UiCustomization'
import { confirmAction } from '../composables/UseConfirmDialog'
import '../styles/AppearanceOriginalCssActions.css'

const props = defineProps<{
  scope: CustomCssScope
  title: string
  views: CustomUiViews
}>()
const emit = defineEmits<{
  'update:views': [value: CustomUiViews]
  preview: []
}>()
const current = computed(() => props.views[props.scope])
const file = computed(() =>
  current.value?.files.find((item) => item.path === current.value?.entryPath),
)
const message = ref('')
const advancedOpen = ref(false)
function toggleAdvanced(event: Event) {
  advancedOpen.value = (event.target as HTMLDetailsElement).open
}
watch(
  () => props.scope,
  () => {
    advancedOpen.value = false
  },
)
const update = (view: CustomUiView | undefined) => {
  const next = normalizeUiViews(props.views)
  if (view) next[props.scope] = view
  else delete next[props.scope]
  emit('update:views', normalizeUiViews(next))
}
function create() {
  update(createEditableUiView(props.title))
}
function edit(value: string) {
  if (!current.value || !file.value) return
  const next = normalizeUiViews({ [props.scope]: current.value })[props.scope]!
  next.files.find((item) => item.path === file.value!.path)!.contents = value
  try {
    update(next)
    message.value = ''
  } catch (error) {
    message.value = String(error)
  }
}
async function restoreDefault() {
  if (!current.value) return
  if (
    !(await confirmAction({
      title: '恢复默认视图',
      message: '移除当前界面源码和素材，改回应用自带界面？',
      confirmLabel: '恢复默认',
      danger: true,
    }))
  )
    return
  update(undefined)
  message.value = '已恢复默认视图；保存主题后生效'
}
</script>

<template>
  <section class="appearance-ui-editor" data-ui-protected>
    <details class="appearance-ui-editor__vue" :open="advancedOpen" @toggle="toggleAdvanced">
      <summary>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"
        >
          <path d="m9 6 6 6-6 6" />
        </svg>
        <span>高级：Vue 自定义</span><small>{{ current?.enabled ? '随预设启用' : '不启用' }}</small>
      </summary>
      <p>当前界面：{{ title }}。通常只需修改上方 CSS；需要改文字、结构或交互时，再使用 Vue。</p>
      <button
        v-if="!current"
        type="button"
        class="appearance-ui-editor__create appearance-action-hit"
        @click="create"
      >
        <span class="appearance-action-face">创建 Vue 模板</span>
      </button>
      <template v-if="current">
        <div class="appearance-ui-editor__project-head">
          <strong>{{ title }} · Vue 源码</strong>
          <label class="appearance-ui-editor__enable"
            ><input
              type="checkbox"
              :checked="current.enabled"
              @change="update({ ...current, enabled: ($event.target as HTMLInputElement).checked })"
            />应用时启用此界面的 Vue</label
          >
        </div>
        <label
          v-if="file && !file.encoding"
          class="appearance-code-editor appearance-ui-editor__source"
          ><span>{{ file.path }}</span
          ><textarea
            :value="file.contents"
            spellcheck="false"
            rows="12"
            :aria-label="`编辑 ${file.path}`"
            @input="edit(($event.target as HTMLTextAreaElement).value)"
          ></textarea>
        </label>
        <p v-else-if="file" class="appearance-ui-editor__binary">{{ file.path }} · 素材文件</p>
        <p>
          可直接修改模板里的标题、按钮和交互；原列表、表单由 Region
          持续更新。“全屏预览”进入当前真实界面，支持交互；右上角“退出预览”恢复原外观并返回草稿。
          预览不会保存外观；保存、删除等业务操作会影响真实数据。 正式应用后仍可长按界面 2
          秒显示“恢复原界面”，或 3 秒内连点悬浮蒜惹菈 5 下打开外观快捷切换。
        </p>
        <div class="appearance-ui-editor__project-actions">
          <button type="button" class="appearance-action-hit" @click="emit('preview')">
            <span class="appearance-action-face">全屏预览</span>
          </button>
          <button
            type="button"
            class="appearance-ui-editor__restore appearance-action-hit"
            @click="restoreDefault"
          >
            <span class="appearance-action-face">恢复默认</span>
          </button>
        </div>
      </template>
      <p v-if="message" role="status">{{ message }}</p>
    </details>
  </section>
</template>

<style scoped>
.appearance-ui-editor {
  min-width: 0;
  border-top: 1px solid var(--color-line);
}
.appearance-ui-editor__vue > summary {
  gap: 0.5rem;
}
.appearance-ui-editor__vue > summary svg {
  width: 1rem;
  height: 1rem;
  flex: none;
}
.appearance-ui-editor__vue[open] > summary svg {
  transform: rotate(90deg);
}
.appearance-ui-editor__vue > summary span {
  flex: 1;
}
.appearance-ui-editor__vue > summary small {
  color: var(--color-ink-soft);
  font-size: var(--text-caption);
}
.appearance-ui-editor__project-head {
  flex-wrap: wrap;
}
.appearance-ui-editor__enable {
  font-size: var(--text-caption);
}
summary {
  min-height: var(--size-touch);
  display: flex;
  align-items: center;
  cursor: pointer;
}
p {
  margin-block: 0.375rem;
  font-size: var(--text-body);
  color: var(--color-ink-soft);
  overflow-wrap: anywhere;
}
label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 0;
}
label:has(input[type='checkbox']) {
  flex-direction: row;
  align-items: center;
}
input,
select,
button {
  min-height: var(--size-touch);
  min-width: 0;
  color: var(--color-ink);
  background: var(--color-surface);
  border: 1px solid var(--color-line);
  border-radius: var(--glass-radius-control);
  font: inherit;
}
input[type='checkbox'] {
  min-height: 0;
}
textarea {
  width: 100%;
  min-height: 10rem;
  resize: vertical;
  box-sizing: border-box;
  font-family: var(--font-code);
}
.appearance-ui-editor__project-head,
.appearance-ui-editor__project-actions {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 0.375rem;
}
.appearance-ui-editor__project-head {
  justify-content: space-between;
  margin-block: 0.5rem 0.375rem;
}
.appearance-ui-editor__project-actions {
  flex-wrap: wrap;
  margin-block: 0.5rem;
}
.appearance-ui-editor__source {
  display: grid;
  min-width: 0;
  margin-top: 0.5rem;
}
.appearance-ui-editor__source span {
  overflow-wrap: anywhere;
  color: var(--color-ink-soft);
  font-family: var(--font-code);
  font-size: var(--text-caption);
}
.appearance-ui-editor__source textarea {
  min-height: clamp(11rem, 32vh, 24rem);
  font-size: var(--text-body);
  tab-size: 2;
  line-height: 1.5;
}
@media (max-width: 53.75rem) {
  :root[data-visual-viewport-reduced='true'] .appearance-ui-editor__source textarea {
    min-height: min(11rem, calc(var(--visual-viewport-height, 100dvh) / 2));
    max-height: calc(var(--visual-viewport-height, 100dvh) / 2);
  }
}
.appearance-ui-editor__project-actions button {
  cursor: pointer;
}
.appearance-ui-editor__restore {
  margin-left: auto;
}
@media (max-width: 28rem) {
  .appearance-ui-editor__project-head {
    align-items: flex-start;
  }
  .appearance-ui-editor__project-head {
    flex-direction: column;
  }
  .appearance-ui-editor__project-actions button {
    flex: 0 1 auto;
  }
  .appearance-ui-editor__restore {
    margin-left: 0;
  }
}
</style>
