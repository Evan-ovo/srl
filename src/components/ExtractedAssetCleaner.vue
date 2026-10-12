<script setup lang="ts">
import '../styles/DuplicateCleaner.css'
import { computed, ref } from 'vue'

import { confirmAction } from '../composables/UseConfirmDialog'
import { recycleBinService } from '../core/AppContainer'
import { RESOURCE_TYPE_LABELS, type ResourceSummary } from '../types/Resource'
import { listExtractedCleanupCandidates } from '../utils/ExtractedAssetCleanup'
import FeatureBackButton from './FeatureBackButton.vue'

const props = defineProps<{ resources: ResourceSummary[] }>()
const emit = defineEmits<{
  back: []
  openResource: [resource: ResourceSummary]
  'library-changed': []
}>()

const isBusy = ref(false)
const message = ref('')
/** 勾选覆盖表：未覆盖时按默认规则（可能已修改的默认不勾）。 */
const overrides = ref<Record<string, boolean>>({})

const candidates = computed(() => listExtractedCleanupCandidates(props.resources))
const isSelected = (id: string): boolean => {
  const candidate = candidates.value.find((item) => item.resource.id === id)
  return overrides.value[id] ?? !candidate?.possiblyModified
}
const selectedIds = computed(() =>
  candidates.value.filter((item) => isSelected(item.resource.id)).map((item) => item.resource.id),
)

function toggle(id: string): void {
  overrides.value[id] = !isSelected(id)
}

function selectAll(): void {
  for (const candidate of candidates.value) overrides.value[candidate.resource.id] = true
}

function invertSelection(): void {
  for (const candidate of candidates.value) {
    overrides.value[candidate.resource.id] = !isSelected(candidate.resource.id)
  }
}

function formatDate(value: number): string {
  return new Date(value).toLocaleString('zh-CN')
}

async function cleanSelected(): Promise<void> {
  const ids = selectedIds.value
  if (!ids.length || isBusy.value) return
  isBusy.value = true
  try {
    const confirmed = await confirmAction({
      title: '清理拆分副本',
      message: `确定将选中的 ${ids.length} 个拆分副本移入回收站吗？\n只会移除独立副本，角色卡内嵌的世界书与正则不受影响；可在回收站保留期内恢复。`,
      confirmLabel: '清理',
      danger: true,
    })
    if (!confirmed) return
    message.value = ''
    await recycleBinService.moveToRecycleBin(ids)
    overrides.value = {}
    message.value = `已清理 ${ids.length} 项拆分副本；角色卡内嵌内容与关联已同步整理。`
    emit('library-changed')
  } catch (error) {
    message.value = error instanceof Error ? error.message : '拆分副本清理失败'
  } finally {
    isBusy.value = false
  }
}
</script>

<template>
  <section class="duplicate-cleaner extracted-cleaner" aria-label="清理拆分副本">
    <header class="duplicate-cleaner__header">
      <FeatureBackButton label="返回资源库" @click="emit('back')" />
      <div>
        <small>EXTRACTED COPIES</small>
        <h1>清理拆分副本</h1>
        <p>
          「拆分配套」提取的世界书与正则副本可以在这里批量删除。拆分从不修改角色卡原件，
          只有溯源卡仍在库中且卡内仍保留对应内嵌内容的副本才会列出，删除不会丢失任何数据。
        </p>
      </div>
    </header>

    <p v-if="message" class="duplicate-cleaner__message" role="status">{{ message }}</p>

    <p v-if="!candidates.length" class="duplicate-cleaner__empty">没有可清理的拆分副本。</p>

    <template v-else>
      <div class="extracted-cleaner__toolbar">
        <p class="duplicate-cleaner__summary">
          共 {{ candidates.length }} 项，已选 {{ selectedIds.length }} 项。
        </p>
        <div>
          <button type="button" :disabled="isBusy" @click="selectAll">全选</button>
          <button type="button" :disabled="isBusy" @click="invertSelection">反选</button>
        </div>
      </div>

      <ul class="extracted-cleaner__list">
        <li v-for="candidate in candidates" :key="candidate.resource.id">
          <label>
            <input
              type="checkbox"
              :checked="isSelected(candidate.resource.id)"
              :disabled="isBusy"
              @change="toggle(candidate.resource.id)"
            />
            <span class="duplicate-cleaner__name">
              <strong>
                {{ candidate.resource.name }}
                <em v-if="candidate.possiblyModified" class="extracted-cleaner__badge"
                  >可能已修改</em
                >
              </strong>
              <small>
                {{ RESOURCE_TYPE_LABELS[candidate.resource.type] }} · 来自「{{
                  candidate.source.name
                }}」 · 更新于 {{ formatDate(candidate.resource.updatedAt) }}
              </small>
            </span>
          </label>
          <button
            type="button"
            :disabled="isBusy"
            @click="emit('openResource', candidate.resource)"
          >
            查看
          </button>
        </li>
      </ul>

      <footer class="extracted-cleaner__footer">
        <span>「可能已修改」的副本默认不勾选，请先确认内容再决定。</span>
        <button
          type="button"
          class="duplicate-cleaner__clean"
          :disabled="isBusy || !selectedIds.length"
          @click="cleanSelected"
        >
          {{ isBusy ? '正在清理' : `清理选中的 ${selectedIds.length} 项` }}
        </button>
      </footer>
    </template>
  </section>
</template>

<style scoped>
.extracted-cleaner__toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 0.8rem;
  align-items: center;
  justify-content: space-between;
}

.extracted-cleaner__toolbar > div {
  display: flex;
  gap: 0.5rem;
}

.extracted-cleaner__toolbar button {
  min-height: 44px;
  padding: 0 0.9rem;
}

.extracted-cleaner__list {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.extracted-cleaner__list li {
  display: flex;
  gap: 0.6rem;
  align-items: center;
  justify-content: space-between;
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--color-line);
  border-radius: 0.75rem;
}

.extracted-cleaner__list label {
  display: flex;
  flex: 1;
  min-width: 0;
  gap: 0.6rem;
  align-items: center;
  cursor: pointer;
}

.extracted-cleaner__list input {
  flex: none;
  width: 1.15rem;
  height: 1.15rem;
}

.extracted-cleaner__list li > button {
  flex: none;
  min-height: 44px;
  padding: 0 0.8rem;
}

.extracted-cleaner__badge {
  margin-left: 0.4rem;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  background: var(--color-danger-soft);
  color: var(--color-danger);
  font-style: normal;
  font-size: 0.72rem;
  vertical-align: middle;
}

.extracted-cleaner__footer {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
  align-items: center;
  justify-content: space-between;
}

.extracted-cleaner__footer > span {
  font-size: 0.82rem;
  opacity: 0.65;
}
</style>
