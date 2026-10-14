<script setup lang="ts">
import { toRef, type ShallowUnwrapRef } from 'vue'
import type { useApp } from '../composables/UseApp'
type PanelModel = Pick<
  ShallowUnwrapRef<ReturnType<typeof useApp>>,
  | 'isFeatureHubOpen'
  | 'isMobileFiltersOpen'
  | 'theme'
  | 'applyTheme'
  | 'activeSecondaryFilterCount'
  | 'filters'
  | 'activeFilter'
  | 'selectFilter'
  | 'countFilter'
  | 'isCategoryManagerOpen'
  | 'activeCategoryId'
  | 'selectCategory'
  | 'countCategory'
  | 'visibleCategories'
  | 'activeTag'
  | 'tagFilters'
  | 'selectTag'
  | 'vaultStatus'
>
const input = defineProps<{ model: PanelModel }>()
const isFeatureHubOpen = toRef(input.model, 'isFeatureHubOpen')
const isMobileFiltersOpen = toRef(input.model, 'isMobileFiltersOpen')
const theme = toRef(input.model, 'theme')
const applyTheme = toRef(input.model, 'applyTheme')
const activeSecondaryFilterCount = toRef(input.model, 'activeSecondaryFilterCount')
const filters = toRef(input.model, 'filters')
const activeFilter = toRef(input.model, 'activeFilter')
const selectFilter = toRef(input.model, 'selectFilter')
const countFilter = toRef(input.model, 'countFilter')
const isCategoryManagerOpen = toRef(input.model, 'isCategoryManagerOpen')
const activeCategoryId = toRef(input.model, 'activeCategoryId')
const selectCategory = toRef(input.model, 'selectCategory')
const countCategory = toRef(input.model, 'countCategory')
const visibleCategories = toRef(input.model, 'visibleCategories')
const activeTag = toRef(input.model, 'activeTag')
const tagFilters = toRef(input.model, 'tagFilters')
const selectTag = toRef(input.model, 'selectTag')
const vaultStatus = toRef(input.model, 'vaultStatus')
</script>
<template>
  <aside
    v-if="!isFeatureHubOpen"
    class="sidebar"
    :class="{ 'sidebar--filters-open': isMobileFiltersOpen }"
  >
    <div class="brand">
      <span class="brand__seal">SRL</span>
      <div>
        <strong class="brand__name">酒馆资源库</strong>
      </div>
      <div class="mobile-brand-actions">
        <button
          type="button"
          :aria-label="theme === 'light' ? '切换为深色模式' : '切换为浅色模式'"
          @click="applyTheme(theme === 'light' ? 'dark' : 'light')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              :d="
                theme === 'light'
                  ? 'M20 15.1A8.2 8.2 0 0 1 8.9 4a8.2 8.2 0 1 0 11.1 11.1Z'
                  : 'M12 3v2m0 14v2M3 12h2m14 0h2M5.64 5.64l1.42 1.42m9.88 9.88 1.42 1.42m0-12.72-1.42 1.42M7.06 16.94l-1.42 1.42M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z'
              "
            />
          </svg>
        </button>
        <button
          class="mobile-filter-toggle"
          :class="{ 'mobile-filter-toggle--active': isMobileFiltersOpen }"
          type="button"
          :aria-expanded="isMobileFiltersOpen"
          aria-label="展开文件夹与标签筛选"
          @click="isMobileFiltersOpen = !isMobileFiltersOpen"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 6h16M7 12h10m-7 6h4" />
          </svg>
          <span v-if="activeSecondaryFilterCount">{{ activeSecondaryFilterCount }}</span>
        </button>
      </div>
    </div>

    <nav class="sidebar__nav" aria-label="资源筛选">
      <button
        v-for="filter in filters"
        :key="filter.value"
        class="nav-item"
        :class="{ 'nav-item--active': activeFilter === filter.value }"
        type="button"
        @click="selectFilter(filter.value)"
      >
        <span>{{ filter.label }}</span>
        <span class="nav-item__count">{{ countFilter(filter.value) }}</span>
      </button>
    </nav>

    <section class="sidebar__categories" aria-label="资源文件夹">
      <div class="sidebar__section-heading">
        <span>资源文件夹</span>
        <button type="button" @click="isCategoryManagerOpen = true">新建 / 管理</button>
      </div>
      <div class="sidebar__category-list">
        <button
          class="category-nav"
          :class="{ 'category-nav--active': activeCategoryId === undefined }"
          type="button"
          @click="selectCategory(undefined)"
        >
          <span class="category-nav__dot category-nav__dot--all"></span>
          <span>全部文件夹</span>
          <small>{{ countCategory(undefined) }}</small>
        </button>
        <button
          class="category-nav"
          :class="{ 'category-nav--active': activeCategoryId === null }"
          type="button"
          @click="selectCategory(null)"
        >
          <span class="category-nav__dot category-nav__dot--empty"></span>
          <span>未放入文件夹</span>
          <small>{{ countCategory(null) }}</small>
        </button>
        <button
          v-for="category in visibleCategories"
          :key="category.id"
          class="category-nav"
          :class="{ 'category-nav--active': activeCategoryId === category.id }"
          type="button"
          @click="selectCategory(category.id)"
        >
          <span
            class="category-nav__dot"
            :style="{ '--folder-saved-color': category.color }"
          ></span>
          <span>{{ category.name }}</span>
          <small>{{ countCategory(category.id) }}</small>
        </button>
      </div>
    </section>

    <section class="sidebar__tags" aria-label="标签筛选">
      <div class="sidebar__section-heading">
        <span>标签索引</span>
        <button v-if="activeTag" type="button" @click="activeTag = ''">清除</button>
      </div>
      <div v-if="tagFilters.length" class="tag-nav-list">
        <button
          v-for="item in tagFilters"
          :key="item.tag"
          class="tag-nav"
          :class="{ 'tag-nav--active': activeTag === item.tag }"
          type="button"
          @click="selectTag(item.tag)"
        >
          <span>#{{ item.tag }}</span>
          <small>{{ item.count }}</small>
        </button>
      </div>
      <p v-else class="sidebar__tags-empty">暂无标签</p>
    </section>

    <div class="sidebar__status">
      <span class="sidebar__status-light"></span>
      <div>
        <strong>{{ vaultStatus.enabled ? '本地加密已开启' : '仅保存在本机' }}</strong>
        <span>{{ vaultStatus.enabled ? 'AES-256-GCM' : 'IndexedDB 已连接' }}</span>
      </div>
    </div>
  </aside>
</template>
