<script setup lang="ts">
import { computed, ref } from 'vue'

import type { NativeExportDestination } from '../core/NativeFileExport'

const props = defineProps<{
  fileName: string
  isImage: boolean
  busy: boolean
}>()

const emit = defineEmits<{
  close: []
  save: [destination: NativeExportDestination, remember: boolean]
  share: []
}>()

const destination = ref<NativeExportDestination>(props.isImage ? 'pictures' : 'downloads')
const remember = ref(false)
const title = computed(() => (props.isImage ? '保存角色卡图片' : '保存原始文件'))

function save(): void {
  emit('save', destination.value, remember.value)
}
</script>

<template>
  <Teleport to="body">
    <div
      class="editor-overlay native-export-overlay"
      role="presentation"
      @click.self="emit('close')"
    >
      <section
        class="editor-sheet native-export-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="native-export-title"
      >
        <header class="editor-sheet__header">
          <div>
            <h2 id="native-export-title">{{ title }}</h2>
            <p>{{ fileName }}</p>
          </div>
          <button
            class="editor-sheet__close"
            type="button"
            aria-label="关闭"
            @click="emit('close')"
          >
            ×
          </button>
        </header>

        <fieldset class="native-export-sheet__destinations" :disabled="busy">
          <label v-if="isImage" :class="{ 'is-selected': destination === 'pictures' }">
            <input v-model="destination" type="radio" value="pictures" />
            <span><strong>保存到相册</strong><small>Pictures/SRL，可在系统图库中查看</small></span>
          </label>
          <label :class="{ 'is-selected': destination === 'downloads' }">
            <input v-model="destination" type="radio" value="downloads" />
            <span
              ><strong>保存到下载</strong><small>Download/SRL，方便在文件管理器中导入</small></span
            >
          </label>
          <label :class="{ 'is-selected': destination === 'directory' }">
            <input v-model="destination" type="radio" value="directory" />
            <span><strong>选择文件夹</strong><small>首次使用会打开系统文件夹授权</small></span>
          </label>
        </fieldset>

        <label class="native-export-sheet__remember">
          <input v-model="remember" type="checkbox" :disabled="busy" />
          <span>以后同类文件默认保存到这里</span>
        </label>

        <footer class="editor-form__actions native-export-sheet__actions">
          <button
            class="button button--quiet"
            type="button"
            :disabled="busy"
            @click="emit('share')"
          >
            分享…
          </button>
          <button class="button button--primary" type="button" :disabled="busy" @click="save">
            {{ busy ? '正在保存' : '保存' }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.native-export-sheet {
  width: min(100% - 24px, 440px);
}
.native-export-overlay {
  z-index: 30;
}
.native-export-sheet__destinations {
  display: grid;
  gap: 10px;
  border: 0;
  padding: 0;
  margin: 0;
}
.native-export-sheet__destinations label {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  min-height: 68px;
  padding: 12px;
  border: 1px solid var(--color-line);
  border-radius: var(--control-radius, var(--glass-radius-control));
  cursor: pointer;
}
.native-export-sheet__destinations label.is-selected {
  border-color: var(--selection-border, var(--color-accent));
  background: var(--selection-background, var(--color-accent-soft));
}
.native-export-sheet__destinations input {
  margin-top: 4px;
  accent-color: var(--color-accent);
}
.native-export-sheet__destinations span {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.native-export-sheet__destinations small,
.native-export-sheet__remember {
  color: var(--color-ink-soft);
}
.native-export-sheet__remember {
  display: flex;
  gap: 8px;
  align-items: center;
  min-height: 44px;
  margin-top: 10px;
}
.native-export-sheet__actions {
  margin-top: 12px;
}
.native-export-sheet__actions .button {
  min-height: 44px;
}
</style>
