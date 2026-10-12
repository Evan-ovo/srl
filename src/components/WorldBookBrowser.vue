<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue'
import FeatureBackButton from './FeatureBackButton.vue'
import type { WorldBookEntry, WorldBookMode } from '../utils/WorldBookEntries'
import '../styles/WorldBookBrowser.css'

const props = withDefaults(defineProps<{ entries: WorldBookEntry[]; pageInputLabel?: string }>(), {
  pageInputLabel: '跳转到世界书条目页',
})
const query = ref('')
const status = ref('all')
const mode = ref<WorldBookMode | 'all'>('all')
const position = ref('all')
const page = ref(1)
const selectedKey = ref('')
const root = useTemplateRef<HTMLElement>('root')
const detailTitle = useTemplateRef<HTMLElement>('detailTitle')
const filters = useTemplateRef<HTMLDetailsElement>('filters')
let trigger: HTMLButtonElement | undefined
const PAGE_SIZE = 10
const positions = computed(() => [...new Set(props.entries.map((entry) => entry.position))])
const activeFilters = computed(
  () => [status.value, mode.value, position.value].filter((value) => value !== 'all').length,
)
const filtered = computed(() => {
  const search = query.value.trim().toLocaleLowerCase()
  return props.entries.filter(
    (entry) =>
      (status.value === 'all' || entry.enabled === (status.value === 'enabled')) &&
      (mode.value === 'all' || entry.mode === mode.value) &&
      (position.value === 'all' || entry.position === position.value) &&
      (!search ||
        [entry.title, entry.content, ...entry.primaryKeys, ...entry.secondaryKeys].some((value) =>
          value.toLocaleLowerCase().includes(search),
        )),
  )
})
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / PAGE_SIZE)))
const visible = computed(() =>
  filtered.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE),
)
const selected = computed(() => props.entries.find((entry) => entry.key === selectedKey.value))
function clearFilters() {
  status.value = mode.value = position.value = 'all'
}
function select(entry: WorldBookEntry, event: Event) {
  trigger = event.currentTarget as HTMLButtonElement
  selectedKey.value = entry.key
  nextTick(() => {
    root.value?.scrollIntoView({ block: 'start' })
    detailTitle.value?.focus({ preventScroll: true })
  })
}
function closeDetail(): boolean {
  if (!selectedKey.value) return false
  selectedKey.value = ''
  nextTick(() => {
    const target = [
      ...(root.value?.querySelectorAll<HTMLButtonElement>('[data-entry-key]') ?? []),
    ].find((button) => button.dataset.entryKey === trigger?.dataset.entryKey)
    target?.focus({ preventScroll: true })
    target?.scrollIntoView({ block: 'nearest' })
  })
  return true
}
function changePage(offset: number) {
  page.value = Math.min(pageCount.value, Math.max(1, page.value + offset))
  root.value?.scrollIntoView({ block: 'start' })
}
function selectPageInput(event: FocusEvent) {
  ;(event.currentTarget as HTMLInputElement).select()
}
function jumpToPage(event: Event) {
  const input = event.currentTarget as HTMLInputElement
  const requested = /^\d+$/u.test(input.value) ? Number(input.value) : Number.NaN
  if (!Number.isSafeInteger(requested) || requested < 1) {
    input.value = String(page.value)
    return
  }
  changePage(requested - page.value)
  input.value = String(page.value)
}
watch([query, status, mode, position], () => {
  page.value = 1
})
watch(
  () => props.entries,
  () => {
    query.value = ''
    clearFilters()
    page.value = 1
    selectedKey.value = ''
    trigger = undefined
  },
)
defineExpose({ closeDetail })
</script>

<template>
  <section ref="root" class="lore-browser" aria-label="世界书条目">
    <article v-if="selected" class="lore-detail">
      <header class="lore-detail__toolbar">
        <FeatureBackButton label="返回条目列表" @click="closeDetail" />
        <span>条目 {{ selected.id }}</span>
        <span class="lore-status" :class="{ 'is-disabled': !selected.enabled }">{{
          selected.enabled ? '已启用' : '已停用'
        }}</span>
      </header>
      <div class="lore-detail__heading">
        <span class="lore-mode" :data-mode="selected.mode"
          ><i aria-hidden="true">{{ selected.mode === 'vector' ? '↗' : '' }}</i
          >{{ selected.modeLabel }}</span
        >
        <h4 ref="detailTitle" tabindex="-1">{{ selected.title }}</h4>
      </div>
      <dl class="lore-facts">
        <div v-for="fact in selected.facts" :key="fact.label">
          <dt>{{ fact.label }}</dt>
          <dd>{{ fact.value }}</dd>
        </div>
      </dl>
      <div v-if="selected.primaryKeys.length || selected.secondaryKeys.length" class="lore-keys">
        <div v-if="selected.primaryKeys.length">
          <span>主触发词</span>
          <ul>
            <li v-for="(key, index) in selected.primaryKeys" :key="index">{{ key }}</li>
          </ul>
        </div>
        <div v-if="selected.secondaryKeys.length">
          <span>辅助触发词</span>
          <ul>
            <li v-for="(key, index) in selected.secondaryKeys" :key="index">{{ key }}</li>
          </ul>
        </div>
      </div>
      <details v-if="selected.conditions.length" class="lore-conditions">
        <summary>
          更多触发条件 <span>{{ selected.conditions.length }}</span>
        </summary>
        <dl class="lore-facts">
          <div v-for="fact in selected.conditions" :key="fact.label">
            <dt>{{ fact.label }}</dt>
            <dd>{{ fact.value }}</dd>
          </div>
        </dl>
      </details>
      <p class="lore-detail__note">这里显示文件中的配置；实际注入还受酒馆设置和聊天内容影响。</p>
      <pre class="lore-detail__content">{{ selected.content || '此条目没有正文内容。' }}</pre>
    </article>
    <template v-else>
      <div class="lore-tools">
        <label class="lore-search"
          ><span class="lore-sr-only">搜索世界书条目</span
          ><svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="10.5" cy="10.5" r="6.5" />
            <path d="m16 16 4 4" /></svg
          ><input v-model="query" type="search" placeholder="搜索名称、触发词或正文"
        /></label>
        <details ref="filters" class="lore-filters">
          <summary>
            筛选<span v-if="activeFilters" class="lore-filter-count">{{ activeFilters }}</span>
          </summary>
          <div class="lore-filters__fields">
            <label
              >状态<select v-model="status" aria-label="状态">
                <option value="all">全部状态</option>
                <option value="enabled">已启用</option>
                <option value="disabled">已停用</option>
              </select></label
            >
            <label
              >触发方式<select v-model="mode" aria-label="触发方式">
                <option value="all">全部方式</option>
                <option value="constant">蓝灯 · 常驻</option>
                <option value="keyword">绿灯 · 关键词</option>
                <option value="vector">向量</option>
              </select></label
            >
            <label
              >注入位置<select v-model="position" aria-label="注入位置">
                <option value="all">全部位置</option>
                <option v-for="item in positions" :key="item" :value="item">{{ item }}</option>
              </select></label
            >
            <div class="lore-filters__actions">
              <button type="button" :disabled="!activeFilters" @click="clearFilters">重置</button
              ><button type="button" @click="filters && (filters.open = false)">收起</button>
            </div>
          </div>
        </details>
      </div>
      <div class="lore-list-info">
        <span
          >{{
            query || activeFilters ? `${filtered.length} / ${entries.length}` : entries.length
          }}
          条</span
        ><span class="lore-legend"><i class="is-blue" />常驻<i class="is-green" />关键词</span>
      </div>
      <ol v-if="visible.length" class="lore-list">
        <li v-for="entry in visible" :key="entry.key">
          <button
            type="button"
            class="lore-row"
            :class="{ 'is-disabled': !entry.enabled }"
            :data-entry-key="entry.key"
            @click="select(entry, $event)"
          >
            <span class="lore-row__heading"
              ><span class="lore-mode" :data-mode="entry.mode"
                ><i aria-hidden="true">{{ entry.mode === 'vector' ? '↗' : '' }}</i
                >{{ entry.modeLabel }}</span
              ><strong>{{ entry.title }}</strong
              ><span v-if="!entry.enabled" class="lore-status is-disabled">停用</span
              ><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg
            ></span>
            <span class="lore-row__placement"
              >{{ entry.placement }}<span>顺序 {{ entry.order }}</span></span
            >
            <span v-if="entry.primaryKeys.length" class="lore-row__keys"
              >触发词：{{ entry.primaryKeys.slice(0, 3).join('、')
              }}{{ entry.primaryKeys.length > 3 ? ` 等 ${entry.primaryKeys.length} 个` : '' }}</span
            >
            <span v-else-if="entry.mode === 'keyword'" class="lore-row__keys">未设置主触发词</span>
          </button>
        </li>
      </ol>
      <p v-else class="lore-empty">
        {{
          entries.length ? '没有匹配的条目，试试其他搜索词或筛选条件。' : '没有读取到世界书条目。'
        }}
      </p>
      <nav v-if="filtered.length > PAGE_SIZE" class="lore-pagination" aria-label="世界书分页">
        <button type="button" :disabled="page === 1" @click="changePage(-1)">上一页</button
        ><span
          ><input
            class="inline-page-jump"
            :style="{ width: `${String(page).length}ch` }"
            :value="page"
            type="text"
            inputmode="numeric"
            :maxlength="String(pageCount).length"
            :aria-label="pageInputLabel"
            @focus="selectPageInput"
            @change="jumpToPage"
            @keydown.enter.prevent="jumpToPage"
          />
          / {{ pageCount }}</span
        ><button type="button" :disabled="page === pageCount" @click="changePage(1)">下一页</button>
      </nav>
    </template>
  </section>
</template>
