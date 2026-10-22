<script setup lang="ts">
import { toRef, type ShallowUnwrapRef } from 'vue'
import PresetStitchEditorPortal from './PresetStitchEditorPortal.vue'
import type { usePresetStitcherApp } from '../composables/UsePresetStitcherApp'

export type PresetEntryEditorModel = Pick<
  ShallowUnwrapRef<ReturnType<typeof usePresetStitcherApp>>,
  | 'editor'
  | 'mobileEditorOverlay'
  | 'ROLE_OPTIONS'
  | 'setEditorTextarea'
  | 'rememberEditorSelection'
  | 'QUICK_VARIABLES'
  | 'insertVariable'
  | 'openVariableWriter'
  | 'openSlotWriter'
  | 'unreadWrittenVariables'
  | 'insertUnreadWrittenVariable'
  | 'saveEdit'
  | 'cancelEdit'
>
const props = defineProps<{ model: PresetEntryEditorModel }>()
const editor = toRef(props.model, 'editor')
</script>

<template>
  <PresetStitchEditorPortal :active="model.mobileEditorOverlay">
    <div v-if="editor" class="stitch-editor" data-srl-controls>
      <label>
        名称<input
          v-model="editor.name"
          type="text"
          maxlength="160"
          :autofocus="editor.scope === 'new'"
        />
      </label>
      <label>
        角色<select v-model="editor.role">
          <option v-for="role in model.ROLE_OPTIONS" :key="role.value" :value="role.value">
            {{ role.label }}
          </option>
        </select>
      </label>
      <label>
        正文<textarea
          :ref="model.setEditorTextarea"
          v-model="editor.content"
          rows="8"
          @click="model.rememberEditorSelection"
          @focus="model.rememberEditorSelection"
          @input="model.rememberEditorSelection"
          @keyup="model.rememberEditorSelection"
          @select="model.rememberEditorSelection"
        ></textarea>
      </label>
      <div class="stitch-editor__macros">
        <button
          v-for="item in model.QUICK_VARIABLES"
          :key="item.value"
          class="button button--quiet"
          type="button"
          @click="model.insertVariable(item.value, item.placeholder, $event)"
        >
          {{ item.label }}
        </button>
        <button class="button button--quiet" type="button" @click="model.openVariableWriter">
          写入聊天变量
        </button>
        <button class="button button--quiet" type="button" @click="model.openSlotWriter($event)">
          插入填写占位
        </button>
        <select
          v-if="model.unreadWrittenVariables.length"
          aria-label="读取尚未使用的已写变量"
          @change="model.insertUnreadWrittenVariable"
        >
          <option value="">读取未使用的已写变量</option>
          <option
            v-for="variable in model.unreadWrittenVariables"
            :key="`${variable.scope}:${variable.name}`"
            :value="`${variable.scope}:${variable.name}`"
          >
            {{ variable.label }}
          </option>
        </select>
      </div>
      <div class="stitch-editor__actions">
        <button type="button" class="button button--primary" @click="model.saveEdit">
          {{ editor.scope === 'new' ? '添加到主预设' : '保存修改' }}
        </button>
        <button class="button button--quiet" type="button" @click="model.cancelEdit">取消</button>
      </div>
    </div>
  </PresetStitchEditorPortal>
</template>

<style scoped>
.stitch-editor {
  display: grid;
  gap: 0.55rem;
  padding-top: 0.65rem;
  font-family: var(--font-body);
  color: var(--color-ink);
}
.stitch-editor label {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 0.28rem;
  font-size: var(--text-caption);
}
.stitch-editor input,
.stitch-editor select,
.stitch-editor textarea {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  min-height: 44px;
  padding: 0.55rem 0.65rem;
  font: inherit;
  font-size: 16px;
}
.stitch-editor textarea {
  min-height: 9rem;
  resize: vertical;
  line-height: 1.5;
}
.stitch-editor input:focus-visible,
.stitch-editor select:focus-visible,
.stitch-editor textarea:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
.stitch-editor__macros,
.stitch-editor__actions {
  display: flex;
  gap: 0.45rem;
}
.stitch-editor__macros {
  flex-wrap: wrap;
  padding: 0.1rem 0;
}
.stitch-editor .button {
  flex: none;
  min-height: 36px;
  min-width: 0;
  padding: 4px 8px;
  font-size: var(--text-caption);
  line-height: 1.3;
}
.stitch-editor .button.button--primary {
  border-color: var(--button-primary-border, var(--color-accent));
  background: var(--button-primary-background, var(--color-accent));
  color: var(--button-primary-color, var(--color-on-accent));
}
.stitch-editor__actions {
  flex-wrap: wrap;
}
.stitch-editor .stitch-editor__actions button {
  min-height: 44px;
}
.stitch-editor__macros select {
  min-width: 10rem;
  flex: 1 0 10rem;
  padding-inline: 0.55rem;
}
@media (max-width: 53.75rem) {
  .stitch-editor {
    position: fixed;
    z-index: 360;
    inset: var(--visual-viewport-offset-top, 0px) 0 auto;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 6rem;
    grid-template-rows: auto minmax(auto, 1fr) max-content max-content;
    gap: 0.3rem;
    height: var(--app-viewport-height, 100dvh);
    max-height: none;
    overflow: auto;
    container-type: size;
    overscroll-behavior: contain;
    padding: max(0.65rem, var(--safe-top)) max(0.65rem, var(--safe-right))
      max(0.65rem, var(--safe-bottom)) max(0.65rem, var(--safe-left));
    border: 0;
    border-radius: 0;
    background: var(--color-canvas);
    box-shadow: none;
  }
  .stitch-editor textarea {
    /* 键盘压缩视口时正文也保留至少原始编辑高度；工具与操作沿外层滚动查看。 */
    min-height: 9rem;
    flex: 1;
    resize: none;
  }
  .stitch-editor > label:has(textarea) {
    min-height: min(16rem, 100cqh);
    grid-column: 1 / -1;
  }
  .stitch-editor__macros,
  .stitch-editor__actions {
    grid-column: 1 / -1;
  }
  .stitch-editor__actions {
    padding-top: 0.25rem;
  }
  .stitch-editor__macros {
    /* 工具横向滚动，不让按钮换行继续挤占正文；保留全部原操作。 */
    flex-wrap: nowrap;
    min-width: 0;
    overflow-x: auto;
    overscroll-behavior-x: contain;
    scrollbar-width: thin;
  }
}
</style>
