<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  getResourceCategoryIds,
  RESOURCE_TYPE_LABELS,
  type Category,
  type ResourceSummary,
  type ResourceType,
} from '../types/Resource'
import FeatureStateView from './FeatureStateView.vue'
import { resourceAuthorSearchText, resourceAuthorLabel } from '../utils/ResourceAuthors'

const props = withDefaults(
  defineProps<{
    resources: readonly ResourceSummary[]
    modelValue: readonly string[]
    title?: string
    multiple?: boolean
    allowedTypes?: readonly ResourceType[]
    categories?: readonly Category[]
    disabled?: boolean
    showActions?: boolean
    matchBadges?: Readonly<Record<string, readonly ('作' | '名')[]>>
  }>(),
  {
    title: '选择资源',
    multiple: true,
    allowedTypes: undefined,
    categories: undefined,
    disabled: false,
    showActions: true,
    matchBadges: undefined,
  },
)

const emit = defineEmits<{
  'update:modelValue': [ids: string[]]
  confirm: [ids: string[]]
  cancel: []
}>()

const query = ref('')
const typeFilter = ref<ResourceType | 'all'>('all')
const categoryFilter = ref('all')
const page = ref(1)
const pageSize = 30
const selected = computed(() => new Set(props.modelValue))
const typeOptions = computed(() => {
  const allowed = props.allowedTypes ? new Set(props.allowedTypes) : undefined
  return Array.from(new Set(props.resources.map((resource) => resource.type))).filter(
    (type) => !allowed || allowed.has(type),
  )
})
const filteredResources = computed(() => {
  const terms = query.value.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean)
  const allowed = props.allowedTypes ? new Set(props.allowedTypes) : undefined
  return props.resources.filter((resource) => {
    if (allowed && !allowed.has(resource.type)) return false
    if (typeFilter.value !== 'all' && resource.type !== typeFilter.value) return false
    const categoryIds = getResourceCategoryIds(resource)
    if (categoryFilter.value === 'uncategorized' && categoryIds.length) return false
    if (
      categoryFilter.value !== 'all' &&
      categoryFilter.value !== 'uncategorized' &&
      !categoryIds.includes(categoryFilter.value)
    )
      return false
    if (!terms.length) return true
    const text =
      `${resource.name}\n${resource.fileName}\n${resource.tags.join('\n')}\n${resourceAuthorSearchText(resource)}`.toLocaleLowerCase()
    return terms.every((term) => text.includes(term))
  })
})
const pageCount = computed(() => Math.max(1, Math.ceil(filteredResources.value.length / pageSize)))
const visibleResources = computed(() =>
  filteredResources.value.slice((page.value - 1) * pageSize, page.value * pageSize),
)
const selectedResource = computed(() =>
  !props.multiple ? props.resources.find((resource) => selected.value.has(resource.id)) : undefined,
)
watch(filteredResources, () => {
  page.value = 1
})

function toggle(id: string): void {
  if (props.disabled) return
  if (!props.multiple) {
    emit('update:modelValue', [id])
    return
  }
  const next = new Set(selected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  emit('update:modelValue', Array.from(next))
}
</script>

<template>
  <section class="resource-picker" :aria-label="title">
    <header>
      <div>
        <h2>{{ title }}</h2>
        <small>{{
          selectedResource ? `已选：${selectedResource.name}` : `已选 ${modelValue.length} 项`
        }}</small>
      </div>
      <div class="resource-picker__toolbar">
        <input
          v-model="query"
          class="field__control"
          type="search"
          aria-label="搜索资源"
          placeholder="搜索名称、文件名、标签或作者"
          :disabled="disabled"
        />
        <select
          v-if="typeOptions.length > 1"
          v-model="typeFilter"
          class="field__control"
          aria-label="资源类型"
          :disabled="disabled"
        >
          <option value="all">全部类型</option>
          <option v-for="type in typeOptions" :key="type" :value="type">
            {{ RESOURCE_TYPE_LABELS[type] }}
          </option>
        </select>
        <select
          v-if="categories"
          v-model="categoryFilter"
          class="field__control"
          aria-label="文件夹分类"
          :disabled="disabled"
        >
          <option value="all">全部文件夹</option>
          <option value="uncategorized">未分类</option>
          <option v-for="category in categories" :key="category.id" :value="category.id">
            {{ category.name }}
          </option>
        </select>
      </div>
    </header>

    <FeatureStateView
      v-if="!filteredResources.length"
      state="empty"
      title="没有匹配的资源"
      description="调整搜索词或分类后再试。"
    />
    <div v-else class="resource-picker__list" role="listbox" :aria-multiselectable="multiple">
      <button
        v-for="resource in visibleResources"
        :key="resource.id"
        type="button"
        role="option"
        :aria-selected="selected.has(resource.id)"
        :disabled="disabled"
        @click="toggle(resource.id)"
      >
        <span class="resource-picker__check" aria-hidden="true">
          {{ selected.has(resource.id) ? '✓' : '' }}
        </span>
        <span>
          <strong>{{ resource.name }}</strong>
          <small>{{ RESOURCE_TYPE_LABELS[resource.type] }} · {{ resource.fileName }}</small>
          <small v-if="resourceAuthorLabel(resource)">{{ resourceAuthorLabel(resource) }}</small>
          <span v-if="matchBadges?.[resource.id]?.length" class="resource-picker__match-badges">
            <small
              v-for="badge in matchBadges[resource.id]"
              :key="badge"
              class="resource-picker__match-badge"
              :aria-label="badge === '名' ? '角色卡名称出现在帖子中' : '角色卡作者出现在帖子中'"
              :title="badge === '名' ? '名称命中' : '作者命中'"
              >{{ badge }}</small
            >
          </span>
        </span>
      </button>
    </div>

    <nav v-if="pageCount > 1" class="resource-picker__pagination" aria-label="资源分页">
      <button
        class="button button--quiet"
        type="button"
        :disabled="disabled || page === 1"
        @click="page -= 1"
      >
        上一页
      </button>
      <small>{{ page }} / {{ pageCount }} · {{ filteredResources.length }} 项</small>
      <button
        class="button button--quiet"
        type="button"
        :disabled="disabled || page === pageCount"
        @click="page += 1"
      >
        下一页
      </button>
    </nav>
    <footer v-if="showActions">
      <button
        class="button button--quiet"
        type="button"
        :disabled="disabled"
        @click="emit('cancel')"
      >
        取消
      </button>
      <button
        type="button"
        class="button button--primary"
        :disabled="disabled"
        @click="emit('confirm', [...modelValue])"
      >
        确认选择
      </button>
    </footer>
  </section>
</template>

<style scoped>
.resource-picker {
  display: grid;
  min-height: 0;
  gap: 0.75rem;
  font-size: 0.75rem;
  line-height: 1.45;
}

.resource-picker header,
.resource-picker footer,
.resource-picker__toolbar {
  display: flex;
  gap: 0.6rem;
  align-items: center;
}

.resource-picker__toolbar {
  flex-wrap: wrap;
  min-width: 0;
}
.resource-picker__pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
}
.resource-picker__pagination button {
  min-height: 2.25rem;
}

.resource-picker header,
.resource-picker footer {
  justify-content: space-between;
  flex-wrap: wrap;
}

.resource-picker header > div:first-child {
  min-width: 0;
  overflow-wrap: anywhere;
}

.resource-picker h2,
.resource-picker small {
  margin: 0;
}

.resource-picker h2 {
  font-size: 0.875rem;
  line-height: 1.4;
}

.resource-picker small {
  color: var(--color-ink-soft);
  font-size: 0.6875rem;
  line-height: 1.4;
}

.resource-picker__toolbar input {
  min-width: 0;
  width: 100%;
  flex: 1 1 12rem;
}

.resource-picker__toolbar input,
.resource-picker__toolbar select,
.resource-picker footer button {
  min-height: 2.25rem;
}

.resource-picker__toolbar select {
  min-width: 0;
  max-width: 100%;
  font-size: 0.75rem;
}

.resource-picker__list {
  display: grid;
  grid-auto-rows: max-content;
  align-content: start;
  gap: 0.4rem;
  overflow: auto;
  max-height: 22rem;
}

.resource-picker__list > button {
  display: grid;
  grid-template-columns: 1.5rem 1fr;
  gap: 0.7rem;
  align-items: center;
  min-height: 3.25rem;
  padding: 0.5rem 0.75rem;
  text-align: left;
  font-size: 0.75rem;
  line-height: 1.45;
}

.resource-picker__list > button[aria-selected='true'] {
  border-color: var(--selection-border, var(--color-accent));
  background: var(--selection-background, var(--color-accent-soft));
}

.resource-picker__list span:last-child {
  display: grid;
  min-width: 0;
  overflow-wrap: anywhere;
}

.resource-picker__check {
  display: grid;
  width: 1.35rem;
  height: 1.35rem;
  place-items: center;
  border: 1px solid var(--color-line-strong);
  border-radius: 0.35rem;
}

.resource-picker__match-badges {
  display: flex;
  gap: 0.3rem;
  margin-top: 0.15rem;
}

.resource-picker__match-badge {
  display: inline-grid;
  width: 1.15rem;
  height: 1.15rem;
  place-items: center;
  border: 1px solid var(--color-accent);
  border-radius: 50%;
  color: var(--color-accent);
  font-size: 0.65rem;
  font-weight: 700;
}

.resource-picker footer {
  justify-content: flex-end;
}

@media (max-width: 640px) {
  .resource-picker header {
    align-items: stretch;
    flex-direction: column;
  }

  .resource-picker__toolbar {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    width: 100%;
  }

  .resource-picker__toolbar input {
    grid-column: 1 / -1;
  }
}
</style>
