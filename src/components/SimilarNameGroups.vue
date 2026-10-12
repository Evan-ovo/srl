<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ResourceSummary } from '../types/Resource'
import { RESOURCE_TYPE_LABELS } from '../types/Resource'
import { findSimilarResourceNameGroups, type SimilarNameMode } from '../utils/SimilarResourceNames'
import FeatureAppHeader from './FeatureAppHeader.vue'

const props = defineProps<{ resources: ResourceSummary[] }>()
const emit = defineEmits<{
  back: []
  openResource: [resource: ResourceSummary]
  filterResources: [ids: string[]]
}>()

const selectedGroupId = ref<string>()
const mode = ref<SimilarNameMode>('precise')
const selectedIds = ref(new Set<string>())
const page = ref(1)
const groups = computed(() => findSimilarResourceNameGroups(props.resources, mode.value))
const pageCount = computed(() => Math.max(1, Math.ceil(groups.value.length / 40)))
const pageGroups = computed(() => groups.value.slice((page.value - 1) * 40, page.value * 40))
watch(mode, () => {
  selectedGroupId.value = undefined
  selectedIds.value = new Set()
  page.value = 1
})
const selectedGroup = computed(() =>
  groups.value.find((group) => group.id === selectedGroupId.value),
)
const resourcePage = ref(1)
const resourcePageCount = computed(() =>
  Math.max(1, Math.ceil((selectedGroup.value?.resources.length ?? 0) / 40)),
)
const pageResources = computed(
  () =>
    selectedGroup.value?.resources.slice((resourcePage.value - 1) * 40, resourcePage.value * 40) ??
    [],
)

watch(selectedGroup, (group) => {
  resourcePage.value = 1
  selectedIds.value = new Set(group?.resources.map((item) => item.id) ?? [])
})
function toggleResource(id: string): void {
  const next = new Set(selectedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedIds.value = next
}

function handleBack(): void {
  if (selectedGroupId.value) selectedGroupId.value = undefined
  else emit('back')
}
</script>

<template>
  <section class="similar-name-groups" aria-label="名称相似资源">
    <FeatureAppHeader
      layout="panel"
      :title="selectedGroup ? '相似资源' : '名称相似资源'"
      :back-label="selectedGroup ? '返回名称相似资源列表' : '返回资源库'"
      @back="handleBack"
    />
    <div class="similar-name-groups__mode" role="group" aria-label="查找范围">
      <button type="button" :aria-pressed="mode === 'precise'" @click="mode = 'precise'">
        精确查找
      </button>
      <button type="button" :aria-pressed="mode === 'broad'" @click="mode = 'broad'">
        广泛查找
      </button>
    </div>

    <template v-if="selectedGroup">
      <div class="similar-name-groups__selection">
        <span
          >已选 <strong>{{ selectedIds.size }}</strong> /
          {{ selectedGroup.resources.length }} 项</span
        >
        <button
          type="button"
          @click="
            selectedIds =
              selectedIds.size === selectedGroup.resources.length
                ? new Set()
                : new Set(selectedGroup.resources.map((item) => item.id))
          "
        >
          {{ selectedIds.size === selectedGroup.resources.length ? '取消全选' : '全选' }}
        </button>
      </div>
      <ul class="similar-name-groups__resources">
        <li
          v-for="resource in pageResources"
          :key="resource.id"
          :class="{ 'is-selected': selectedIds.has(resource.id) }"
        >
          <label class="similar-name-groups__resource-choice">
            <input
              type="checkbox"
              :aria-label="`选择 ${resource.name}`"
              :checked="selectedIds.has(resource.id)"
              @change="toggleResource(resource.id)"
            />
            <span>
              <strong>{{ resource.name }}</strong>
              <small>
                {{ RESOURCE_TYPE_LABELS[resource.type] ?? '其他资源' }} · {{ resource.fileName }}
              </small>
            </span>
          </label>
          <button
            class="similar-name-groups__view"
            type="button"
            :aria-label="`查看 ${resource.name}`"
            @click="emit('openResource', resource)"
          >
            查看
          </button>
        </li>
      </ul>
      <nav
        v-if="resourcePageCount > 1"
        class="similar-name-groups__pagination"
        aria-label="组内资源分页"
      >
        <button :disabled="resourcePage <= 1" @click="resourcePage--">上一页</button>
        <span>{{ resourcePage }} / {{ resourcePageCount }}</span>
        <button :disabled="resourcePage >= resourcePageCount" @click="resourcePage++">
          下一页
        </button>
      </nav>
      <button
        class="similar-name-groups__apply"
        type="button"
        :disabled="!selectedIds.size"
        @click="emit('filterResources', [...selectedIds])"
      >
        在资源库查看 <span>{{ selectedIds.size }} 项</span>
      </button>
    </template>

    <template v-else>
      <p class="similar-name-groups__summary">
        {{
          mode === 'broad' ? '包含版本号、正式版、番外等名称变体。' : '查找同名与细微名称差异。'
        }}仅作候选，不自动合并。
      </p>
      <div v-if="groups.length" class="similar-name-groups__selection">
        <span
          >找到 <strong>{{ groups.length }}</strong> 组</span
        ><span>选择一组查看</span>
      </div>
      <ul v-if="groups.length" class="similar-name-groups__list">
        <li v-for="group in pageGroups" :key="group.id">
          <button type="button" @click="selectedGroupId = group.id">
            <span>
              <strong>{{ group.names[0] }}</strong>
              <small v-if="group.names.length > 1" class="similar-name-groups__variants"
                >{{ group.names.slice(1, 3).join(' · ')
                }}{{ group.names.length > 3 ? '…' : '' }}</small
              >
              <small>{{ group.resources.length }} 项资源</small>
            </span>
            <span class="similar-name-groups__open">查看 ›</span>
          </button>
        </li>
      </ul>
      <nav v-if="pageCount > 1" class="similar-name-groups__pagination" aria-label="相似资源分页">
        <button :disabled="page <= 1" @click="page--">上一页</button>
        <span>{{ page }} / {{ pageCount }}</span>
        <button :disabled="page >= pageCount" @click="page++">下一页</button>
      </nav>
      <p v-if="!groups.length" class="similar-name-groups__empty">没有发现同名或名称相似的资源。</p>
    </template>
  </section>
</template>

<style scoped>
.similar-name-groups {
  display: flex;
  max-height: min(80dvh, 44rem);
  flex-direction: column;
  gap: 0.75rem;
  padding: 0.75rem 1rem 1rem;
  color: var(--color-ink);
  font-family: var(--font-body);
}
.similar-name-groups__mode {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.25rem;
  padding: 0.25rem;
  border-radius: 0.75rem;
  background: color-mix(in srgb, var(--color-accent) 8%, var(--color-surface));
}
.similar-name-groups__mode button {
  min-height: 40px;
  font: 600 0.875rem/1.4 var(--font-body);
  cursor: pointer;
}
.similar-name-groups__mode button[aria-pressed='true'] {
  border-color: var(--selection-border, var(--color-accent));
  background: var(--selection-background, var(--color-accent-soft));
  color: var(--selection-color, var(--color-ink));
  box-shadow: 0 1px 3px var(--color-shadow);
}
.similar-name-groups__summary,
.similar-name-groups__empty {
  margin: 0;
  color: var(--color-ink-soft);
  font-size: 0.8rem;
  line-height: 1.5;
}
.similar-name-groups__selection,
.similar-name-groups__pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  color: var(--color-ink-soft);
  font-size: 0.8rem;
}
.similar-name-groups__selection strong {
  color: var(--color-ink);
  font-variant-numeric: tabular-nums;
}
.similar-name-groups__selection button,
.similar-name-groups__pagination button,
.similar-name-groups__view {
  min-height: 44px;
  padding: 0 0.5rem;
  border: 0;
  background: var(--button-background, transparent);
  color: var(--button-color, var(--color-accent));
  font: 600 0.8rem/1.4 var(--font-body);
  cursor: pointer;
}
.similar-name-groups__list,
.similar-name-groups__resources {
  min-height: 0;
  overflow-y: auto;
  margin: 0;
  padding: 0;
  border: 1px solid var(--color-line);
  border-radius: 0.75rem;
  list-style: none;
}
.similar-name-groups__list > li + li,
.similar-name-groups__resources > li + li {
  border-top: 1px solid var(--color-line);
}
.similar-name-groups__resources > li {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding-right: 0.35rem;
}
.similar-name-groups__resources > li.is-selected {
  background: var(--selection-background, var(--color-accent-soft));
}
.similar-name-groups__resource-choice {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 64px;
  align-items: center;
  gap: 0.7rem;
  padding: 0.65rem 0.75rem;
  cursor: pointer;
}
.similar-name-groups__resource-choice input {
  appearance: none;
  position: relative;
  flex: 0 0 18px;
  width: 18px;
  height: 18px;
  border: 1px solid var(--control-border, var(--color-line-strong));
  border-radius: var(--control-radius, 5px);
  background: var(--control-background, var(--color-surface));
  margin: 0;
  cursor: pointer;
}
.similar-name-groups__resource-choice input:checked {
  border-color: var(--color-accent);
  background: var(--color-accent);
}
.similar-name-groups__resource-choice input:checked::after {
  content: '';
  position: absolute;
  left: 5px;
  top: 2px;
  width: 5px;
  height: 9px;
  border: solid var(--color-on-accent);
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}
.similar-name-groups__resource-choice > span,
.similar-name-groups__list button > span:first-child {
  display: grid;
  min-width: 0;
  gap: 0.2rem;
}
.similar-name-groups strong {
  font-size: 0.875rem;
  font-weight: 650;
  overflow-wrap: anywhere;
}
.similar-name-groups small {
  color: var(--color-ink-soft);
  font-size: 0.75rem;
  overflow-wrap: anywhere;
}
.similar-name-groups__list button {
  display: flex;
  width: 100%;
  min-height: 64px;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.7rem 0.85rem;
  border: 0;
  background: var(--button-background, transparent);
  color: var(--button-color, inherit);
  text-align: left;
  cursor: pointer;
}
.similar-name-groups__variants {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.similar-name-groups__open {
  flex: 0 0 auto;
  color: var(--color-accent);
  font-size: 0.8rem;
}
.similar-name-groups__apply {
  display: flex;
  min-height: 44px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  gap: 0.6rem;
  padding: 0.65rem 1rem;
  border: 0;
  border-radius: 0.7rem;
  background: var(--color-accent);
  color: var(--color-on-accent);
  font: 600 0.875rem/1.4 var(--font-body);
  cursor: pointer;
}
.similar-name-groups__apply span {
  padding-left: 0.6rem;
  border-left: 1px solid currentColor;
  font-weight: 400;
  font-size: 0.8rem;
}
.similar-name-groups button:disabled {
  opacity: 0.45;
  cursor: default;
}
.similar-name-groups button:focus-visible,
.similar-name-groups input:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
@media (max-width: 430px) {
  .similar-name-groups {
    padding: 0.5rem 0.75rem 0.75rem;
  }
}
</style>
