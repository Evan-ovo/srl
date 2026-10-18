<script setup lang="ts">
import { toRef, type ShallowUnwrapRef } from 'vue'
import type { useApp } from '../composables/UseApp'

type PanelModel = Pick<
  ShallowUnwrapRef<ReturnType<typeof useApp>>,
  | 'commitSearch'
  | 'searchScope'
  | 'isSearchIndexing'
  | 'contentSearchError'
  | 'retryContentSearch'
  | 'searchQuery'
  | 'handleSearchFocus'
  | 'handleSearchBlur'
  | 'cancelSearchInput'
  | 'isSearchFocused'
  | 'isSearchHistoryOpen'
  | 'searchHistory'
  | 'clearSearchHistory'
  | 'useSearchHistory'
  | 'sortValue'
  | 'filteredResourceCount'
  | 'isBatchMode'
  | 'toggleBatchMode'
  | 'openSimilarNameGroups'
>
const input = defineProps<{ model: PanelModel }>()
const commitSearch = toRef(input.model, 'commitSearch')
const searchScope = toRef(input.model, 'searchScope')
const isSearchIndexing = toRef(input.model, 'isSearchIndexing')
const contentSearchError = toRef(input.model, 'contentSearchError')
const retryContentSearch = toRef(input.model, 'retryContentSearch')
const searchQuery = toRef(input.model, 'searchQuery')
const handleSearchFocus = toRef(input.model, 'handleSearchFocus')
const handleSearchBlur = toRef(input.model, 'handleSearchBlur')
const cancelSearchInput = toRef(input.model, 'cancelSearchInput')
const isSearchFocused = toRef(input.model, 'isSearchFocused')
const isSearchHistoryOpen = toRef(input.model, 'isSearchHistoryOpen')
const searchHistory = toRef(input.model, 'searchHistory')
const clearSearchHistory = toRef(input.model, 'clearSearchHistory')
const useSearchHistory = toRef(input.model, 'useSearchHistory')
const sortValue = toRef(input.model, 'sortValue')
const filteredResourceCount = toRef(input.model, 'filteredResourceCount')
const isBatchMode = toRef(input.model, 'isBatchMode')
const toggleBatchMode = toRef(input.model, 'toggleBatchMode')
const openSimilarNameGroups = toRef(input.model, 'openSimilarNameGroups')
</script>
<template>
  <section class="toolbar">
    <form class="search-area" role="search" @submit.prevent="commitSearch">
      <label class="search-box">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="7"></circle>
          <path d="m16 16 4 4"></path>
        </svg>
        <select
          v-model="searchScope"
          aria-label="搜索范围"
          data-assistant-focus="library-search-scope"
        >
          <option value="name">名称</option>
          <option value="author">作者</option>
          <option value="content">全部内容</option>
        </select>
        <span v-if="searchScope === 'content' && isSearchIndexing" class="search-indexing">
          索引中…
        </span>
        <input
          v-model="searchQuery"
          data-assistant-focus="library-search"
          type="search"
          enterkeyhint="search"
          :placeholder="
            searchScope === 'name'
              ? '搜索名称或文件名'
              : searchScope === 'author'
                ? '搜索备注作者或解析作者'
                : '搜索名称、标签和解析内容'
          "
          @focus="handleSearchFocus"
          @blur="handleSearchBlur"
          @keydown.esc="cancelSearchInput"
        />
      </label>
      <button
        v-if="isSearchFocused || searchQuery"
        class="search-cancel"
        type="button"
        @mousedown.prevent
        @click="cancelSearchInput"
      >
        取消
      </button>
      <div v-if="isSearchHistoryOpen && searchHistory.length" class="search-history">
        <header>
          <span>最近搜索</span>
          <button type="button" @mousedown.prevent="clearSearchHistory">清空</button>
        </header>
        <button
          v-for="item in searchHistory"
          :key="item"
          type="button"
          @mousedown.prevent="useSearchHistory(item)"
        >
          {{ item }}
        </button>
      </div>
    </form>
    <div
      v-if="searchScope === 'content' && contentSearchError"
      class="search-failure"
      role="status"
    >
      <span>正文搜索未完成</span>
      <button type="button" class="batch-toggle" @click="retryContentSearch">重试</button>
    </div>
    <div class="toolbar__meta">
      <label class="sort-control">
        <span>排序</span>
        <select v-model="sortValue" aria-label="资源排序">
          <option value="newest">最近整理</option>
          <option value="name">名称</option>
          <option value="size">文件大小</option>
        </select>
      </label>
      <span class="toolbar__result" :aria-label="`显示 ${filteredResourceCount} 项`">
        {{ filteredResourceCount }} 项
      </span>
      <div class="toolbar__actions">
        <button
          class="batch-toggle toolbar__similar-names"
          type="button"
          @click="openSimilarNameGroups"
        >
          名称相似
        </button>
        <button
          class="batch-toggle"
          :class="{ 'batch-toggle--active': isBatchMode }"
          type="button"
          @click="toggleBatchMode"
        >
          {{ isBatchMode ? '退出多选' : '多选' }}
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.search-failure {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.375rem;
  color: var(--color-ink-soft);
  font-size: 0.75rem;
}
.toolbar:has(.search-failure) {
  flex-wrap: wrap;
}
</style>
