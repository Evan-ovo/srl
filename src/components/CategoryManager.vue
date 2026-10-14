<script setup lang="ts">
import '../styles/DataTransferPanels.css'
import { ref } from 'vue'

import type { Category } from '../types/Resource'

defineProps<{ categories: Category[]; busy: boolean }>()
const emit = defineEmits<{
  close: []
  create: [details: { name: string; color: string }]
  update: [details: { category: Category; name: string; color: string }]
  visibility: [category: Category]
  delete: [category: Category]
}>()

const newName = ref('')
const newColor = ref('#486b5d')
const editingId = ref('')
const editingName = ref('')
const editingColor = ref('#486b5d')

function createCategory(): void {
  emit('create', { name: newName.value, color: newColor.value })
}

function beginEditing(category: Category): void {
  editingId.value = category.id
  editingName.value = category.name
  editingColor.value = category.color
}

function saveCategory(category: Category): void {
  emit('update', {
    category,
    name: editingName.value,
    color: editingColor.value,
  })
}
</script>

<template>
  <Teleport to="body">
    <div class="editor-overlay" role="presentation" @click.self="emit('close')">
      <section
        class="editor-sheet editor-sheet--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="category-manager-title"
      >
        <header class="editor-sheet__header">
          <div>
            <h2 id="category-manager-title">管理资源文件夹</h2>
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

        <form class="category-create" @submit.prevent="createCategory">
          <input
            v-model="newColor"
            class="color-input"
            type="color"
            aria-label="新文件夹颜色"
            :disabled="busy"
          />
          <input
            v-model="newName"
            class="field__control"
            type="text"
            maxlength="40"
            placeholder="文件夹名称"
            :disabled="busy"
          />
          <button class="button button--primary" type="submit" :disabled="busy">新建文件夹</button>
        </form>

        <div v-if="categories.length" class="category-list">
          <article
            v-for="category in categories"
            :key="category.id"
            class="category-row"
            :class="{ 'category-row--hidden': category.hidden }"
          >
            <template v-if="editingId === category.id">
              <input
                v-model="editingColor"
                class="color-input"
                type="color"
                aria-label="文件夹颜色"
                :disabled="busy"
              />
              <input
                v-model="editingName"
                class="field__control"
                type="text"
                maxlength="40"
                :disabled="busy"
              />
              <button
                class="text-button"
                type="button"
                :disabled="busy"
                @click="saveCategory(category)"
              >
                保存
              </button>
              <button class="text-button" type="button" @click="editingId = ''">取消</button>
            </template>
            <template v-else>
              <span
                class="category-row__dot"
                :style="{ '--folder-saved-color': category.color }"
              ></span>
              <span class="category-row__identity">
                <strong class="category-row__name">{{ category.name }}</strong>
                <small>{{ category.hidden ? '已从资源库与抽卡隐藏' : '正常显示' }}</small>
              </span>
              <button
                class="text-button category-row__visibility"
                type="button"
                :disabled="busy"
                :aria-label="category.hidden ? `恢复显示${category.name}` : `隐藏${category.name}`"
                @click="emit('visibility', category)"
              >
                {{ category.hidden ? '恢复显示' : '隐藏' }}
              </button>
              <button class="text-button" type="button" @click="beginEditing(category)">
                编辑
              </button>
              <button
                class="text-button text-button--danger"
                type="button"
                :disabled="busy"
                @click="emit('delete', category)"
              >
                删除
              </button>
            </template>
          </article>
        </div>
        <p v-else class="category-empty">
          还没有文件夹。新建后可一次选择多张角色卡或其他资源放入其中。
        </p>
      </section>
    </div>
  </Teleport>
</template>
