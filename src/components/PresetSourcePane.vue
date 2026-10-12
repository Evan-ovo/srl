<script setup lang="ts">
import { toRef, type ShallowUnwrapRef } from 'vue'
import PresetStitchEntryEditor, { type PresetEntryEditorModel } from './PresetStitchEntryEditor.vue'
import type { usePresetStitcherApp } from '../composables/UsePresetStitcherApp'

type PanelModel = PresetEntryEditorModel &
  Pick<
    ShallowUnwrapRef<ReturnType<typeof usePresetStitcherApp>>,
    | 'sourcePickerOpen'
    | 'sourceMode'
    | 'sourceSummary'
    | 'favoritePageItems'
    | 'expandedSourceKeys'
    | 'toggleExpanded'
    | 'startSourceDrag'
    | 'guardDragTouch'
    | 'insertFavoriteFromAction'
    | 'editor'
    | 'getPromptDisplayTokens'
    | 'beginFavoriteEdit'
    | 'copyEntryContent'
    | 'isCandidate'
    | 'toggleCandidateFromFavorite'
    | 'removeFavorite'
    | 'favorites'
    | 'favoritePageCount'
    | 'favoritePage'
    | 'setPage'
    | 'segmentSearch'
    | 'roleFiltersOpen'
    | 'ROLE_FILTERS'
    | 'roleFilter'
    | 'sourcePageItems'
    | 'pickedKeys'
    | 'roleLabels'
    | 'findSourceEntry'
    | 'toggleSegmentFromAction'
    | 'sourceKey'
    | 'beginSourceEdit'
    | 'isFavorite'
    | 'toggleFavorite'
    | 'toggleCandidateFromSource'
    | 'sourceRegexScripts'
    | 'sourceRegexPicked'
    | 'toggleRegexGroup'
    | 'sourcePageCount'
    | 'sourcePage'
  >
const input = defineProps<{ model: PanelModel }>()
const sourcePickerOpen = toRef(input.model, 'sourcePickerOpen')
const sourceMode = toRef(input.model, 'sourceMode')
const sourceSummary = toRef(input.model, 'sourceSummary')
const favoritePageItems = toRef(input.model, 'favoritePageItems')
const expandedSourceKeys = toRef(input.model, 'expandedSourceKeys')
const toggleExpanded = toRef(input.model, 'toggleExpanded')
const guardDragTouch = toRef(input.model, 'guardDragTouch')
const startSourceDrag = toRef(input.model, 'startSourceDrag')
const insertFavoriteFromAction = toRef(input.model, 'insertFavoriteFromAction')
const editor = toRef(input.model, 'editor')
const getPromptDisplayTokens = toRef(input.model, 'getPromptDisplayTokens')
const beginFavoriteEdit = toRef(input.model, 'beginFavoriteEdit')
const copyEntryContent = toRef(input.model, 'copyEntryContent')
const isCandidate = toRef(input.model, 'isCandidate')
const toggleCandidateFromFavorite = toRef(input.model, 'toggleCandidateFromFavorite')
const removeFavorite = toRef(input.model, 'removeFavorite')
const favorites = toRef(input.model, 'favorites')
const favoritePageCount = toRef(input.model, 'favoritePageCount')
const favoritePage = toRef(input.model, 'favoritePage')
const setPage = toRef(input.model, 'setPage')
const segmentSearch = toRef(input.model, 'segmentSearch')
const roleFiltersOpen = toRef(input.model, 'roleFiltersOpen')
const ROLE_FILTERS = toRef(input.model, 'ROLE_FILTERS')
const roleFilter = toRef(input.model, 'roleFilter')
const sourcePageItems = toRef(input.model, 'sourcePageItems')
const pickedKeys = toRef(input.model, 'pickedKeys')
const roleLabels = toRef(input.model, 'roleLabels')
const findSourceEntry = toRef(input.model, 'findSourceEntry')
const toggleSegmentFromAction = toRef(input.model, 'toggleSegmentFromAction')
const sourceKey = toRef(input.model, 'sourceKey')
const beginSourceEdit = toRef(input.model, 'beginSourceEdit')
const isFavorite = toRef(input.model, 'isFavorite')
const toggleFavorite = toRef(input.model, 'toggleFavorite')
const toggleCandidateFromSource = toRef(input.model, 'toggleCandidateFromSource')
const sourceRegexScripts = toRef(input.model, 'sourceRegexScripts')
const sourceRegexPicked = toRef(input.model, 'sourceRegexPicked')
const toggleRegexGroup = toRef(input.model, 'toggleRegexGroup')
const sourcePageCount = toRef(input.model, 'sourcePageCount')
const sourcePage = toRef(input.model, 'sourcePage')
function jumpToSourcePage(event: Event): void {
  const pageInput = event.currentTarget as HTMLInputElement
  const requestedPage = Number.parseInt(pageInput.value, 10)
  if (Number.isFinite(requestedPage)) setPage.value('source', requestedPage)
  pageInput.value = String(sourcePage.value)
}
</script>
<template>
  <section
    class="stitch-pane stitch-pane--source"
    aria-label="填充预设"
    @touchmove="guardDragTouch"
  >
    <header class="stitch-pane__header">
      <button
        type="button"
        class="button button--quiet stitch-pane__preset-name"
        @click="sourcePickerOpen = true"
      >
        <strong>{{
          sourceMode === 'favorites' ? '已收藏条目' : (sourceSummary?.name ?? '选择填充预设')
        }}</strong>
        <small class="stitch-pane__kind">填</small>
        <b>⌄</b>
      </button>
    </header>

    <template v-if="sourceMode === 'favorites'">
      <p class="stitch__hint">
        收藏是本机快照，原预设删除后仍可复用。点“加入”直接插入，长按“加入”可选位置。
      </p>
      <ul class="stitch-entry-list">
        <li v-for="favorite in favoritePageItems" :key="favorite.id" class="stitch-entry">
          <div class="stitch-entry__summary">
            <button
              type="button"
              class="stitch-entry__copy"
              aria-label="轻触展开收藏条目"
              title="点击展开；鼠标按住拖动，触屏长按拖动"
              :aria-expanded="expandedSourceKeys.has(`favorite:${favorite.id}`)"
              @pointerdown="startSourceDrag('favorite', favorite.id, $event)"
              @contextmenu.prevent
              @click="toggleExpanded('source', `favorite:${favorite.id}`)"
            >
              <strong :title="favorite.name">{{ favorite.name }}</strong>
              <small>{{ favorite.sourceName }} · {{ favorite.content.length }} 字</small>
            </button>
            <button
              type="button"
              class="button button--quiet stitch-entry__add"
              @pointerdown="startSourceDrag('favorite', favorite.id, $event)"
              @click="insertFavoriteFromAction(favorite)"
            >
              加入
            </button>
          </div>
          <div
            v-if="expandedSourceKeys.has(`favorite:${favorite.id}`)"
            class="stitch-entry__detail"
          >
            <template v-if="editor?.scope === 'favorite' && editor.key === favorite.id">
              <PresetStitchEntryEditor :model="model" />
            </template>
            <template v-else>
              <!-- eslint-disable-next-line vue/no-v-html -- 高亮函数先转义正文，仅插入固定 span。 -->
              <pre v-if="favorite.content" class="stitch-entry__content"><span
                      v-for="(token, tokenIndex) in getPromptDisplayTokens(favorite.content)"
                      :key="`${tokenIndex}:${token.text}`"
                      :class="token.kind === 'plain' ? undefined : ['stitch-macro', `stitch-macro--${token.kind}`]"
                    >{{ token.text }}</span></pre>
              <pre v-else>（没有正文）</pre>
              <div>
                <button
                  class="button button--quiet"
                  type="button"
                  @click="beginFavoriteEdit(favorite)"
                >
                  编辑</button
                ><button
                  class="button button--quiet"
                  type="button"
                  @click="copyEntryContent(favorite.content)"
                >
                  复制</button
                ><button
                  class="button button--quiet"
                  type="button"
                  :aria-pressed="isCandidate(favorite)"
                  @click="toggleCandidateFromFavorite(favorite)"
                >
                  {{ isCandidate(favorite) ? '移出候选' : '加入候选' }}
                </button>
                ><button
                  class="button button--quiet"
                  type="button"
                  @click="removeFavorite(favorite)"
                >
                  删除收藏
                </button>
              </div>
            </template>
          </div>
        </li>
        <li v-if="!favorites.length" class="stitch__empty">
          还没有收藏条目；从任意填充预设里点“收藏”。
        </li>
      </ul>
      <nav v-if="favoritePageCount > 1" class="stitch-pagination">
        <button
          class="button button--quiet"
          type="button"
          :disabled="favoritePage === 1"
          @click="setPage('favorite', favoritePage - 1)"
        >
          ←</button
        ><span>{{ favoritePage }} / {{ favoritePageCount }}</span
        ><button
          class="button button--quiet"
          type="button"
          :disabled="favoritePage === favoritePageCount"
          @click="setPage('favorite', favoritePage + 1)"
        >
          →
        </button>
      </nav>
    </template>

    <template v-else-if="sourceSummary">
      <label class="stitch__search"
        ><svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m16 16 4 4" /></svg
        ><input
          v-model="segmentSearch"
          type="search"
          aria-label="搜索条目名称或正文"
          placeholder="搜索条目名称或正文"
        /><button
          type="button"
          class="button button--quiet stitch__search-filter"
          :aria-expanded="roleFiltersOpen"
          aria-controls="stitch-source-role-filters"
          @click.prevent="roleFiltersOpen = !roleFiltersOpen"
        >
          筛选
        </button></label
      >
      <div
        v-if="roleFiltersOpen"
        id="stitch-source-role-filters"
        class="stitch__chips"
        role="group"
        aria-label="条目角色筛选"
      >
        <button
          v-for="option in ROLE_FILTERS"
          :key="option.value"
          class="button button--quiet"
          type="button"
          :class="{
            'is-active': roleFilter === option.value,
            'button--primary': roleFilter === option.value,
          }"
          @click="roleFilter = option.value"
        >
          {{ option.label }}
        </button>
      </div>
      <ul v-if="roleFilter !== 'regex'" class="stitch-entry-list">
        <li
          v-for="segment in sourcePageItems"
          :key="segment.identifier"
          class="stitch-entry"
          :class="{
            'is-picked': pickedKeys.has(`pick:${sourceSummary.id}:${segment.identifier}`),
          }"
        >
          <div class="stitch-entry__summary">
            <button
              type="button"
              class="stitch-entry__copy"
              :aria-label="`轻触展开${segment.name}`"
              title="点击展开；鼠标按住拖动，触屏长按拖动"
              :aria-expanded="expandedSourceKeys.has(segment.identifier)"
              @pointerdown="startSourceDrag('segment', segment.identifier, $event)"
              @contextmenu.prevent
              @click="toggleExpanded('source', segment.identifier)"
            >
              <strong :title="segment.name">{{ segment.name }}</strong>
              <small>{{ roleLabels[segment.role] ?? '未标注' }} · {{ segment.charCount }} 字</small>
            </button>
            <button
              type="button"
              class="button button--quiet stitch-entry__add"
              :aria-pressed="Boolean(findSourceEntry(segment.identifier))"
              :class="{ 'button--primary': Boolean(findSourceEntry(segment.identifier)) }"
              @pointerdown="startSourceDrag('segment', segment.identifier, $event)"
              @click="toggleSegmentFromAction(segment.identifier)"
            >
              {{ findSourceEntry(segment.identifier) ? '移除' : '加入' }}
            </button>
          </div>
          <div v-if="expandedSourceKeys.has(segment.identifier)" class="stitch-entry__detail">
            <template v-if="editor?.scope === 'source' && editor.key === sourceKey(segment)">
              <PresetStitchEntryEditor :model="model" />
            </template>
            <template v-else>
              <!-- eslint-disable-next-line vue/no-v-html -- 高亮函数先转义正文，仅插入固定 span。 -->
              <pre v-if="segment.content" class="stitch-entry__content"><span
                      v-for="(token, tokenIndex) in getPromptDisplayTokens(segment.content)"
                      :key="`${tokenIndex}:${token.text}`"
                      :class="token.kind === 'plain' ? undefined : ['stitch-macro', `stitch-macro--${token.kind}`]"
                    >{{ token.text }}</span></pre>
              <pre v-else>（没有正文）</pre>
              <div>
                <button
                  class="button button--quiet"
                  type="button"
                  @click="beginSourceEdit(segment)"
                >
                  编辑工作副本
                </button>
                <button
                  class="button button--quiet"
                  type="button"
                  @click="copyEntryContent(segment.content)"
                >
                  复制
                </button>
                <button
                  class="button button--quiet"
                  type="button"
                  :aria-pressed="isFavorite(segment)"
                  @click="toggleFavorite(segment)"
                >
                  {{ isFavorite(segment) ? '取消收藏' : '收藏条目' }}
                </button>
                <button
                  class="button button--quiet"
                  type="button"
                  :aria-pressed="
                    isCandidate({
                      sourceResourceId: sourceSummary.id,
                      identifier: segment.identifier,
                      name: segment.name,
                    })
                  "
                  @click="toggleCandidateFromSource(segment)"
                >
                  {{
                    isCandidate({
                      sourceResourceId: sourceSummary.id,
                      identifier: segment.identifier,
                      name: segment.name,
                    })
                      ? '移出候选'
                      : '加入候选'
                  }}
                </button>
              </div></template
            >
          </div>
        </li>
        <li v-if="!sourcePageItems.length" class="stitch__empty">这个筛选下没有可填充条目。</li>
      </ul>
      <ul v-else class="stitch-entry-list">
        <li v-if="sourceRegexScripts.length" class="stitch-entry">
          <div class="stitch-entry__summary">
            <span class="stitch-entry__copy"
              ><strong>配套正则整组</strong
              ><small>{{ sourceRegexScripts.length }} 条 · 追加到 regex_scripts</small></span
            ><button
              type="button"
              class="button button--quiet stitch-entry__add"
              :aria-pressed="sourceRegexPicked"
              :class="{ 'button--primary': sourceRegexPicked }"
              @click="toggleRegexGroup"
            >
              {{ sourceRegexPicked ? '移除' : '加入' }}
            </button>
          </div>
        </li>
        <li v-else class="stitch__empty">这个预设没有内嵌正则。</li>
      </ul>
      <nav
        v-if="roleFilter !== 'regex' && sourcePageCount > 1"
        class="stitch-pagination"
        aria-label="填充条目分页"
      >
        <button
          class="button button--quiet"
          type="button"
          :disabled="sourcePage === 1"
          @click="setPage('source', sourcePage - 1)"
        >
          ←</button
        ><label class="stitch-pagination__jump"
          ><input
            :value="sourcePage"
            type="text"
            inputmode="numeric"
            :maxlength="String(sourcePageCount).length"
            aria-label="跳转到填充预设条目页"
            @change="jumpToSourcePage"
            @keydown.enter.prevent="jumpToSourcePage"
          /><span>/ {{ sourcePageCount }} 页</span></label
        ><button
          class="button button--quiet"
          type="button"
          :disabled="sourcePage === sourcePageCount"
          @click="setPage('source', sourcePage + 1)"
        >
          →
        </button>
      </nav>
    </template>
    <div v-else class="stitch__empty">
      <p>先选择一个填充预设，或打开已收藏条目。</p>
      <button type="button" class="button button--primary" @click="sourcePickerOpen = true">
        选择填充内容
      </button>
    </div>
  </section>
</template>
<style scoped src="../styles/PresetStitcherApp.css"></style>
