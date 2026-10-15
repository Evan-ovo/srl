<script setup lang="ts">
import PresetWorkbenchTools from './PresetWorkbenchTools.vue'
import PresetSourcePane from './PresetSourcePane.vue'
import PresetCandidateSheet from './PresetCandidateSheet.vue'
import PresetStitchEditorPortal from './PresetStitchEditorPortal.vue'
import PresetStitchEntryEditor from './PresetStitchEntryEditor.vue'
import { computed, proxyRefs, ref } from 'vue'
import { renderPromptReviewContent } from '../utils/PresetStitcher'
import { useStitchColumnResize } from '../composables/UseStitchColumnResize'
import FeatureAppHeader from './FeatureAppHeader.vue'
import {
  usePresetStitcherApp,
  type PresetStitcherAppProps,
  type PresetStitcherAppEvents,
} from '../composables/UsePresetStitcherApp'
const props = defineProps<PresetStitcherAppProps>()
const emit = defineEmits<PresetStitcherAppEvents>()
const controller = usePresetStitcherApp(props, emit)
const panelModel = proxyRefs(controller)
function reviewContent(content: string): string {
  return renderPromptReviewContent(content)
}
const {
  fullWorkspaceActive,
  step,
  requestBack,
  mainSide,
  baseSummary,
  errorMessage,
  notice,
  pendingDraft,
  draftBaseName,
  busy,
  restoreDraft,
  discardDraft,
  presetSearch,
  presetPageItems,
  chooseBase,
  presetSegmentCount,
  formatDate,
  presetPageCount,
  presetPage,
  setPage,
  sourceDrag,
  singleColumn,
  sourceDrawerOpen,
  startSourceDrag,
  guardDragTouch,
  sourcePickerOpen,
  toggleExpanded,
  editor,
  mobileEditorOverlay,
  insertPromptSlot,
  slotName,
  slotId,
  slotWriterError,
  slotWriterOpen,
  getPromptDisplayTokens,
  copyEntryContent,
  favorites,
  candidateSheetOpen,
  candidates,
  candidateCharacterCount,
  targetFiltersOpen,
  activeTargetFilterCount,
  showEnabledOnly,
  showModifiedOnly,
  showVariableReadsOnly,
  showVariableWritesOnly,
  targetPage,
  targetPageItems,
  insertionIndex,
  selectInsertionIndex,
  getEntryChangeKind,
  expandedTargetKeys,
  beginTargetEdit,
  beginNewEntry,
  promptSlotCount,
  moveEntry,
  assembly,
  removePickByKey,
  targetPageCount,
  blockingPromptIssues,
  reviewItems,
  openReview,
  reviewGroups,
  reviewAddedMacros,
  reviewRemovedMacros,
  productName,
  baseIsStitched,
  saveAsVersion,
  versionNote,
  generate,
  successName,
  resetAll,
  variableWriterOpen,
  variableName,
  variableValue,
  insertVariableWrite,
  openSlotWriterForVariable,
  chooseFavoriteSource,
  sourcePresetPageItems,
  chooseSource,
  sourcePresetPageCount,
} = controller
function jumpToTargetPage(event: Event): void {
  const input = event.currentTarget as HTMLInputElement
  const requestedPage = Number.parseInt(input.value, 10)
  if (Number.isFinite(requestedPage)) setPage('target', requestedPage)
  input.value = String(targetPage.value)
}
const {
  sourceShare,
  resizingColumns,
  resizeColumns,
  startColumnResize,
  resizeColumnsWithKeyboard,
} = useStitchColumnResize(mainSide)
const reviewChangedPage = ref(1)
const reviewChangedPageInput = ref('1')
const reviewChangedPageSize = ref(5)
const reviewChangedSearch = ref('')
const reviewChangedFilteredItems = computed(() => {
  const query = reviewChangedSearch.value.trim().toLocaleLowerCase()
  if (!query) return reviewGroups.value.changed
  return reviewGroups.value.changed.filter((item) =>
    `${item.title} ${item.detail}`.toLocaleLowerCase().includes(query),
  )
})
const reviewChangedPageCount = computed(() =>
  Math.max(1, Math.ceil(reviewChangedFilteredItems.value.length / reviewChangedPageSize.value)),
)
const reviewChangedPageItems = computed(() => {
  const start = (reviewChangedPage.value - 1) * reviewChangedPageSize.value
  return reviewChangedFilteredItems.value.slice(start, start + reviewChangedPageSize.value)
})
const reviewChangedRangeStart = computed(() =>
  reviewChangedFilteredItems.value.length
    ? (reviewChangedPage.value - 1) * reviewChangedPageSize.value + 1
    : 0,
)
const reviewChangedRangeEnd = computed(() =>
  Math.min(
    reviewChangedPage.value * reviewChangedPageSize.value,
    reviewChangedFilteredItems.value.length,
  ),
)
function resetReviewChangedPage(): void {
  reviewChangedPage.value = 1
  reviewChangedPageInput.value = '1'
}
function openReviewFromWorkbench(): void {
  reviewChangedSearch.value = ''
  reviewChangedPageSize.value = 5
  resetReviewChangedPage()
  openReview()
}
function setReviewChangedPage(page: number): void {
  reviewChangedPage.value = Math.max(1, Math.min(page, reviewChangedPageCount.value))
  reviewChangedPageInput.value = String(reviewChangedPage.value)
}
function jumpToReviewChangedPage(): void {
  const requestedPage = Number.parseInt(reviewChangedPageInput.value, 10)
  if (!Number.isFinite(requestedPage)) {
    reviewChangedPageInput.value = String(reviewChangedPage.value)
    return
  }
  setReviewChangedPage(requestedPage)
}
</script>

<template>
  <section
    class="stitch"
    data-srl-controls
    :class="{ 'is-reading': fullWorkspaceActive, 'is-workbench': step === 'workbench' }"
    aria-label="缝了么预设工作台"
  >
    <FeatureAppHeader title="缝了么" back-label="返回功能桌面" @back="requestBack">
      <template #actions>
        <PresetWorkbenchTools
          v-if="step === 'workbench' && !fullWorkspaceActive"
          :model="panelModel"
        />
      </template>
    </FeatureAppHeader>

    <div v-if="baseSummary && step === 'review'" class="stitch__contextbar">
      <span>当前主预设</span>
      <strong :title="baseSummary.name">{{ baseSummary.name }}</strong>
    </div>

    <div v-if="fullWorkspaceActive" class="stitch__focus-toolbar">
      <PresetWorkbenchTools :model="panelModel" />
    </div>

    <p v-if="errorMessage" class="stitch__error" role="alert">{{ errorMessage }}</p>
    <p
      v-else-if="notice && (step === 'base' || step === 'workbench')"
      class="stitch__notice"
      role="status"
    >
      {{ notice }}
    </p>

    <template v-if="step === 'base'">
      <div class="stitch-entry-layout">
        <div class="stitch-entry-layout__controls">
          <div v-if="pendingDraft" class="stitch__draft">
            <span>
              <strong>发现自动草稿</strong>
              <small>{{ draftBaseName ? `主预设「${draftBaseName}」` : '上次未完成的工作' }}</small>
            </span>
            <div>
              <button
                type="button"
                class="button button--primary"
                :disabled="busy"
                @click="restoreDraft()"
              >
                继续缝
              </button>
              <button
                class="button button--quiet"
                type="button"
                :disabled="busy"
                @click="discardDraft"
              >
                放弃
              </button>
            </div>
          </div>
          <p class="stitch__hint">选一份预设作为底板，保留其采样设置；原文件不会被修改。</p>
          <label class="stitch__search">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="10.5" cy="10.5" r="6.5" />
              <path d="m16 16 4 4" />
            </svg>
            <input
              v-model="presetSearch"
              type="search"
              aria-label="搜索主预设"
              data-assistant-focus="stitch-search"
              placeholder="搜索主预设"
            />
          </label>
        </div>
        <section class="stitch-entry-layout__presets" aria-labelledby="stitch-entry-presets-title">
          <header>
            <strong id="stitch-entry-presets-title">我的预设</strong>
          </header>
          <ul v-if="presetPageItems.length" class="stitch__preset-list">
            <li v-for="resource in presetPageItems" :key="resource.id">
              <button
                type="button"
                data-assistant-focus="stitch-base"
                :disabled="busy"
                @click="chooseBase(resource)"
              >
                <span>
                  <strong>{{ resource.name }}</strong>
                  <em v-if="Array.isArray(resource.metadata.stitchedFrom)">我的自缝版</em>
                  <em v-else>原始预设</em>
                </span>
                <small
                  >{{ presetSegmentCount(resource) }} 条 ·
                  {{ formatDate(resource.updatedAt) }}</small
                >
              </button>
            </li>
          </ul>
          <p v-else class="stitch__empty">
            {{ presetSearch ? '没有匹配的预设' : '资源库里还没有预设。' }}
          </p>
          <nav v-if="presetPageCount > 1" class="stitch-pagination" aria-label="主预设列表分页">
            <button
              class="button button--quiet"
              type="button"
              aria-label="上一页"
              :disabled="presetPage === 1"
              @click="setPage('preset', presetPage - 1)"
            >
              ←
            </button>
            <span>{{ presetPage }} / {{ presetPageCount }}</span>
            <button
              class="button button--quiet"
              type="button"
              aria-label="下一页"
              :disabled="presetPage === presetPageCount"
              @click="setPage('preset', presetPage + 1)"
            >
              →
            </button>
          </nav>
        </section>
      </div>
    </template>

    <template v-else-if="step === 'workbench'">
      <div
        class="stitch-workbench"
        :style="{
          '--stitch-source-share': `${sourceShare}%`,
          '--stitch-target-share': `${100 - sourceShare}%`,
        }"
        :class="{
          'is-main-left': mainSide === 'left',
          'is-dragging': sourceDrag?.picked,
          'is-single-column': singleColumn,
        }"
      >
        <button
          v-if="singleColumn"
          type="button"
          class="button button--quiet stitch-source-toggle"
          :aria-label="sourceDrawerOpen ? '收起填充预设' : '展开填充预设'"
          :aria-expanded="sourceDrawerOpen"
          aria-controls="stitch-source-drawer"
          @click="sourceDrawerOpen = !sourceDrawerOpen"
        >
          {{ sourceDrawerOpen ? '›' : '‹' }}
        </button>
        <PresetSourcePane
          v-show="!singleColumn || sourceDrawerOpen"
          id="stitch-source-drawer"
          :model="panelModel"
          :class="{ 'is-source-drawer': singleColumn }"
        />
        <div
          v-if="!singleColumn"
          class="stitch-column-separator"
          role="separator"
          tabindex="0"
          aria-label="调整填充区宽度"
          aria-orientation="vertical"
          :aria-valuenow="sourceShare"
          aria-valuemin="30"
          aria-valuemax="60"
          :aria-valuetext="`填充区 ${sourceShare}%，主预设 ${100 - sourceShare}%`"
          @pointerdown="startColumnResize"
          @pointermove="resizeColumns"
          @pointerup="resizingColumns = false"
          @pointercancel="resizingColumns = false"
          @lostpointercapture="resizingColumns = false"
          @keydown="resizeColumnsWithKeyboard"
        />

        <section
          class="stitch-pane stitch-pane--target"
          aria-label="主预设"
          @touchmove="guardDragTouch"
        >
          <header class="stitch-pane__header">
            <span class="stitch-pane__preset-name" :title="baseSummary?.name">
              <strong>{{ baseSummary?.name }}</strong
              ><small class="stitch-pane__kind">主</small>
            </span>
            <button
              type="button"
              class="button button--quiet stitch-pane__add-entry"
              aria-label="新建主预设条目"
              @click="beginNewEntry"
            >
              ＋ 新建
            </button>
          </header>
          <section class="stitch-pane__filter-disclosure">
            <button
              type="button"
              class="button button--quiet stitch-pane__filter-toggle"
              aria-label="条目筛选"
              :aria-expanded="targetFiltersOpen"
              aria-controls="stitch-target-filters"
              @click="targetFiltersOpen = !targetFiltersOpen"
            >
              <span>筛选</span>
              <small v-if="activeTargetFilterCount">已启用 {{ activeTargetFilterCount }} 项</small>
              <span class="stitch-pane__filter-chevron" aria-hidden="true">{{
                targetFiltersOpen ? '⌃' : '⌄'
              }}</span>
            </button>
            <button
              type="button"
              class="button button--quiet stitch-pane__candidates"
              :aria-label="`将入 ${candidates.length} · +${candidateCharacterCount}`"
              @click="candidateSheetOpen = true"
            >
              候选 {{ candidates.length }}
            </button>
            <div
              v-show="targetFiltersOpen"
              id="stitch-target-filters"
              class="stitch-pane__filters"
              role="group"
              aria-label="主预设显示筛选"
            >
              <label><input v-model="showEnabledOnly" type="checkbox" />只显示启用条目</label>
              <label><input v-model="showModifiedOnly" type="checkbox" />只显示本次修改条目</label>
              <label><input v-model="showVariableReadsOnly" type="checkbox" />只显示读取变量</label>
              <label
                ><input v-model="showVariableWritesOnly" type="checkbox" />只显示写入变量</label
              >
            </div>
          </section>
          <ol class="stitch-target-list">
            <li
              v-if="targetPageItems.length"
              class="stitch-insertion"
              role="presentation"
              :class="{
                'is-drag-over':
                  sourceDrag?.picked &&
                  sourceDrag.overDropSlot &&
                  sourceDrag.targetIndex === targetPageItems[0].index,
              }"
              :data-insertion-index="targetPageItems[0].index"
            >
              <span aria-hidden="true">松开插入</span>
            </li>
            <template v-for="{ entry, index: actualIndex } in targetPageItems" :key="entry.key">
              <li
                class="stitch-entry stitch-entry--target"
                :data-entry-index="actualIndex"
                :class="{
                  'is-marker': entry.marker,
                  'is-disabled': !entry.enabled,
                  'is-editing': editor?.scope === 'target' && editor.key === entry.key,
                  'is-inserted': getEntryChangeKind(entry) === 'inserted',
                  'is-modified': getEntryChangeKind(entry) === 'modified',
                }"
              >
                <div class="stitch-entry__summary">
                  <button
                    type="button"
                    class="stitch-entry__reorder"
                    aria-label="长按拖动条目排序"
                    title="长按拖动；也可展开条目使用上移、下移"
                    @pointerdown="startSourceDrag('target', entry.key, $event)"
                    @contextmenu.prevent
                  >
                    ⠿
                  </button>
                  <button
                    type="button"
                    class="stitch-entry__copy"
                    :aria-expanded="expandedTargetKeys.has(entry.key)"
                    @click="toggleExpanded('target', entry.key)"
                  >
                    <strong :title="entry.name">{{ entry.name }}</strong>
                    <small>
                      <span
                        v-if="getEntryChangeKind(entry)"
                        class="stitch-entry__change-badge"
                        :class="`is-${getEntryChangeKind(entry)}`"
                        >{{ getEntryChangeKind(entry) === 'inserted' ? '新增' : '修改' }}</span
                      >
                      {{
                        entry.origin === 'base' || !entry.sourceName ? '' : `${entry.sourceName} · `
                      }}
                      {{ entry.marker ? '结构项' : `${entry.charCount} 字` }}
                    </small>
                  </button>
                  <label class="stitch-entry__toggle"
                    ><input
                      v-model="entry.enabled"
                      type="checkbox"
                      :aria-label="`${entry.name}：启用`"
                    /><span>{{ entry.enabled ? '启用' : '停用' }}</span></label
                  >
                </div>
                <div v-if="expandedTargetKeys.has(entry.key)" class="stitch-entry__detail">
                  <template v-if="editor?.scope === 'target' && editor.key === entry.key">
                    <PresetStitchEntryEditor :model="panelModel" />
                  </template>
                  <template v-else>
                    <!-- eslint-disable-next-line vue/no-v-html -- 高亮函数先转义正文，仅插入固定 span。 -->
                    <pre v-if="entry.content" class="stitch-entry__content"><span
                      v-for="(token, tokenIndex) in getPromptDisplayTokens(entry.content)"
                      :key="`${tokenIndex}:${token.text}`"
                      :class="token.kind === 'plain' ? undefined : ['stitch-macro', `stitch-macro--${token.kind}`]"
                    >{{ token.text }}</span></pre>
                    <pre v-else>（结构项没有正文）</pre>
                    <div class="stitch-entry__actions">
                      <button
                        v-if="!entry.marker"
                        class="button button--quiet"
                        type="button"
                        @click="beginTargetEdit(entry)"
                      >
                        编辑
                      </button>
                      <button
                        class="button button--quiet"
                        type="button"
                        :disabled="!entry.content"
                        @click="copyEntryContent(entry.content)"
                      >
                        复制
                      </button>
                      <button
                        class="button button--quiet"
                        type="button"
                        :disabled="actualIndex === 0"
                        @click="moveEntry(actualIndex, -1)"
                      >
                        上移
                      </button>
                      <button
                        class="button button--quiet"
                        type="button"
                        :disabled="actualIndex === assembly.length - 1"
                        @click="moveEntry(actualIndex, 1)"
                      >
                        下移
                      </button>
                      <button
                        class="button button--quiet"
                        type="button"
                        :aria-pressed="insertionIndex === actualIndex"
                        @click="selectInsertionIndex(actualIndex)"
                      >
                        从此条前插入
                      </button>
                      <button
                        class="button button--quiet"
                        type="button"
                        :aria-pressed="insertionIndex === actualIndex + 1"
                        @click="selectInsertionIndex(actualIndex + 1)"
                      >
                        从此条后插入
                      </button>
                      <button
                        v-if="entry.origin === 'pick'"
                        type="button"
                        class="button button--quiet is-danger"
                        @click="removePickByKey(entry.key)"
                      >
                        移除
                      </button>
                    </div>
                  </template>
                </div>
              </li>
              <li
                class="stitch-insertion"
                role="presentation"
                :class="{
                  'is-drag-over':
                    sourceDrag?.picked &&
                    sourceDrag.overDropSlot &&
                    sourceDrag.targetIndex === actualIndex + 1,
                }"
                :data-insertion-index="actualIndex + 1"
              >
                <span aria-hidden="true">松开插入</span>
              </li>
            </template>
            <li v-if="!targetPageItems.length" class="stitch__empty">当前筛选下没有主预设条目。</li>
          </ol>
          <nav v-if="targetPageCount > 1" class="stitch-pagination" aria-label="主预设条目分页">
            <button
              class="button button--quiet"
              type="button"
              :disabled="targetPage === 1"
              @click="setPage('target', targetPage - 1)"
            >
              ←</button
            ><label class="stitch-pagination__jump"
              ><input
                :value="targetPage"
                type="text"
                inputmode="numeric"
                :maxlength="String(targetPageCount).length"
                aria-label="跳转到主预设条目页"
                @change="jumpToTargetPage"
                @keydown.enter.prevent="jumpToTargetPage"
              /><span>/ {{ targetPageCount }} 页</span></label
            ><button
              class="button button--quiet"
              type="button"
              :disabled="targetPage === targetPageCount"
              @click="setPage('target', targetPage + 1)"
            >
              →
            </button>
          </nav>
        </section>
      </div>

      <div id="stitch-entry-editor-portal"></div>
      <PresetStitchEditorPortal :active="mobileEditorOverlay">
        <div v-if="editor" class="stitch-editor-backdrop" aria-hidden="true"></div>
      </PresetStitchEditorPortal>

      <PresetStitchEntryEditor v-if="editor?.scope === 'new'" :model="panelModel" />

      <details v-if="blockingPromptIssues.length" class="stitch-audit" open>
        <summary>生成前检查 · {{ blockingPromptIssues.length }} 个错误</summary>
        <ul>
          <li
            v-for="issue in blockingPromptIssues"
            :key="`${issue.kind}:${issue.entryKeys.join(':')}:${issue.title}`"
            :class="`is-${issue.severity}`"
          >
            <strong>{{ issue.title }}</strong
            ><small>{{ issue.detail }}</small>
          </li>
        </ul>
      </details>

      <footer v-if="!fullWorkspaceActive" class="stitch__footer">
        <span
          ><strong>{{ reviewItems.length }}</strong> 项变更 · 草稿自动保存</span
        >
        <button type="button" class="button button--primary" @click="openReviewFromWorkbench">
          查看变更并导出
        </button>
      </footer>
    </template>

    <template v-else-if="step === 'review'">
      <div class="stitch-review__overview" aria-label="差异概览">
        <span class="stitch-review__count stitch-review__count--added"
          >新增 {{ reviewGroups.added.length }} 条目</span
        >
        <span class="stitch-review__count stitch-review__count--removed"
          >删除 {{ reviewGroups.removed.length }} 条目</span
        >
        <span class="stitch-review__count stitch-review__count--changed"
          >修改 {{ reviewGroups.changed.length }} 条目</span
        >
      </div>
      <div class="stitch-review">
        <p v-if="!reviewItems.length" class="stitch-review__empty">尚未修改，将保留主预设内容。</p>
        <details
          v-if="reviewGroups.added.length"
          class="stitch-review__group stitch-review__group--added"
          :open="reviewGroups.added.length <= 3"
        >
          <summary>
            <strong>新增 {{ reviewGroups.added.length }} 条目</strong>
          </summary>
          <ul v-if="reviewGroups.added.length">
            <li v-for="item in reviewGroups.added" :key="item.key">
              <span>
                <strong>{{ item.title }}</strong>
                <small
                  >{{ item.detail
                  }}<template v-if="item.sourceName">
                    · 来源：{{ item.sourceName }}</template
                  ></small
                >
              </span>
              <pre
                v-if="item.afterContent !== undefined"
                class="stitch-review__content"
                data-op="added"
                >{{ item.afterContent ? reviewContent(item.afterContent) : '（空内容）' }}</pre>
            </li>
          </ul>
        </details>
        <details
          v-if="reviewGroups.removed.length"
          class="stitch-review__group stitch-review__group--removed"
          :open="reviewGroups.removed.length > 0 && reviewGroups.removed.length <= 3"
        >
          <summary>
            <strong>删除 {{ reviewGroups.removed.length }} 条目</strong>
          </summary>
          <ul v-if="reviewGroups.removed.length">
            <li v-for="item in reviewGroups.removed" :key="item.key">
              <span>
                <strong>{{ item.title }}</strong>
                <small>{{ item.detail }}</small>
              </span>
              <pre
                v-if="item.beforeContent !== undefined"
                class="stitch-review__content"
                data-op="removed"
                >{{ item.beforeContent ? reviewContent(item.beforeContent) : '（空内容）' }}</pre>
            </li>
          </ul>
        </details>
        <details
          v-if="reviewGroups.changed.length"
          class="stitch-review__group stitch-review__group--changed"
          :open="reviewGroups.changed.length > 0 && reviewGroups.changed.length <= 3"
        >
          <summary>
            <strong>修改 {{ reviewGroups.changed.length }} 条目</strong>
          </summary>
          <div v-if="reviewGroups.changed.length > 5" class="stitch-review__controls">
            <input
              v-model="reviewChangedSearch"
              type="search"
              aria-label="按名称筛选修改条目"
              placeholder="按条目名称筛选"
              @input="resetReviewChangedPage"
            />
            <label>
              每页
              <select v-model.number="reviewChangedPageSize" @change="resetReviewChangedPage">
                <option :value="5">5 条</option>
                <option :value="10">10 条</option>
                <option :value="20">20 条</option>
              </select>
            </label>
            <small v-if="reviewChangedSearch.trim()"
              >筛选后 {{ reviewChangedFilteredItems.length }} /
              {{ reviewGroups.changed.length }} 条</small
            >
          </div>
          <ul v-if="reviewChangedPageItems.length">
            <li v-for="item in reviewChangedPageItems" :key="item.key">
              <span>
                <strong>{{ item.title }}</strong>
                <small v-if="item.detail">{{ item.detail }}</small>
              </span>
              <div
                v-if="item.beforeContent !== undefined || item.afterContent !== undefined"
                class="stitch-review__content-transition"
              >
                <div v-if="item.beforeContent !== undefined" data-op="removed">
                  <small>修改前</small>
                  <pre>{{
                    item.beforeContent ? reviewContent(item.beforeContent) : '（空内容）'
                  }}</pre>
                </div>
                <div v-if="item.afterContent !== undefined" data-op="added">
                  <small>修改后</small>
                  <pre>{{
                    item.afterContent ? reviewContent(item.afterContent) : '（空内容）'
                  }}</pre>
                </div>
              </div>
            </li>
          </ul>
          <p v-else-if="reviewChangedFilteredItems.length" class="stitch-review__empty">
            当前页没有修改条目
          </p>
          <p v-else class="stitch-review__empty">
            {{ reviewGroups.changed.length ? '没有符合条件的修改条目' : '没有修改条目' }}
          </p>
          <nav
            v-if="reviewChangedFilteredItems.length > reviewChangedPageSize"
            class="stitch-review__pagination"
            aria-label="修改条目分页"
          >
            <span class="stitch-review__range"
              >{{ reviewChangedRangeStart }}–{{ reviewChangedRangeEnd }} /
              {{ reviewChangedFilteredItems.length }}</span
            >
            <button
              type="button"
              :disabled="reviewChangedPage <= 1"
              @click="setReviewChangedPage(reviewChangedPage - 1)"
            >
              上一页
            </button>
            <label class="stitch-review__page-jump">
              第
              <input
                v-model="reviewChangedPageInput"
                type="number"
                min="1"
                :max="reviewChangedPageCount"
                aria-label="跳转到指定页"
                @change="jumpToReviewChangedPage"
                @keydown.enter.prevent="jumpToReviewChangedPage"
              />
              / {{ reviewChangedPageCount }} 页
            </label>
            <button
              type="button"
              :disabled="reviewChangedPage >= reviewChangedPageCount"
              @click="setReviewChangedPage(reviewChangedPage + 1)"
            >
              下一页
            </button>
          </nav>
        </details>
        <details
          v-if="reviewAddedMacros.length || reviewRemovedMacros.length"
          class="stitch-review__technical"
        >
          <summary>
            宏变化<em>{{ reviewAddedMacros.length + reviewRemovedMacros.length }}</em>
          </summary>
          <div class="stitch-review__technical-content">
            <ul class="stitch-review__code-list">
              <li v-for="macro in reviewAddedMacros" :key="`macro-add:${macro}`">
                <b>增加</b>
                <pre>{{ macro }}</pre>
              </li>
              <li v-for="macro in reviewRemovedMacros" :key="`macro-remove:${macro}`">
                <b>删除</b>
                <pre>{{ macro }}</pre>
              </li>
            </ul>
          </div>
        </details>
      </div>
      <div class="stitch__generate">
        <label
          ><span>自缝版预设名称</span><input v-model="productName" type="text" maxlength="160"
        /></label>
        <label v-if="baseIsStitched" class="stitch__version-toggle"
          ><input v-model="saveAsVersion" type="checkbox" /><span
            ><strong>存为现有自缝版的新版本</strong
            ><small>关闭后会作为独立“我的自缝版”预设入库</small></span
          ></label
        >
        <label v-if="baseIsStitched && saveAsVersion"
          ><span>版本备注（可选）</span
          ><input v-model="versionNote" type="text" maxlength="240" placeholder="这次改了什么"
        /></label>
        <p>保存为标准 SillyTavern 预设 JSON，可下载或通过酒馆互传使用。</p>
        <p v-if="promptSlotCount" class="stitch__slot-dependency">
          含
          {{ promptSlotCount }}
          个角色卡填写占位；酒馆端需安装支持该格式的互传扩展，未支持时占位宏会原样保留。
        </p>
        <div>
          <button class="button button--quiet" type="button" @click="step = 'workbench'">
            返回修改</button
          ><button type="button" class="button button--primary" :disabled="busy" @click="generate">
            {{ busy ? '正在生成并入库' : '生成并入库' }}
          </button>
        </div>
      </div>
    </template>

    <template v-else>
      <div class="stitch__done" role="status">
        <span>✓</span><strong>「{{ successName }}」已作为自缝版预设入库</strong>
        <p>文件仍是标准预设 JSON，可直接下载、导入 SillyTavern 或通过酒馆互传发送。</p>
        <div>
          <button type="button" class="button button--primary" @click="resetAll">再缝一个</button
          ><button class="button button--quiet" type="button" @click="emit('back')">
            返回功能桌面
          </button>
        </div>
      </div>
    </template>

    <Teleport to="body">
      <div
        v-if="variableWriterOpen"
        class="stitch-sheet mobile-dialog-viewport"
        data-srl-controls
        role="dialog"
        aria-modal="true"
        aria-label="写入聊天变量"
        @click.self="variableWriterOpen = false"
      >
        <section class="stitch-sheet__panel stitch-variable-writer">
          <header>
            <span><strong>写入聊天变量</strong></span>
            <button
              class="button button--quiet"
              type="button"
              aria-label="关闭"
              @click="variableWriterOpen = false"
            >
              ×
            </button>
          </header>
          <label><span>变量名</span><input v-model="variableName" type="text" autofocus /></label>
          <label><span>变量值</span><textarea v-model="variableValue" rows="4"></textarea></label>
          <button
            class="button button--quiet stitch-variable-writer__slot-button"
            type="button"
            @click="openSlotWriterForVariable($event)"
          >
            插入填写占位
          </button>
          <div class="stitch-variable-writer__actions">
            <button class="button button--quiet" type="button" @click="variableWriterOpen = false">
              取消
            </button>
            <button
              type="button"
              class="button button--primary"
              @click="insertVariableWrite($event)"
            >
              插入宏
            </button>
          </div>
        </section>
      </div>

      <div
        v-if="slotWriterOpen"
        class="stitch-sheet mobile-dialog-viewport"
        data-srl-controls
        role="dialog"
        aria-modal="true"
        aria-label="创建填写占位"
        @click.self="slotWriterOpen = false"
      >
        <section class="stitch-sheet__panel stitch-variable-writer stitch-slot-writer">
          <header>
            <span
              ><strong>{{ slotId ? '修改填写占位' : '创建填写占位' }}</strong></span
            >
            <button
              class="button button--quiet"
              type="button"
              aria-label="关闭"
              @click="slotWriterOpen = false"
            >
              ×
            </button>
          </header>
          <label
            ><span>占位名称</span
            ><input
              v-model="slotName"
              type="text"
              maxlength="80"
              placeholder="例如：文风、状态栏、角色服装"
              autofocus
          /></label>
          <p>进入酒馆后按角色卡填写；留空时自动隐藏包含该项的整条提示词。</p>
          <p v-if="slotWriterError" class="stitch__error" role="alert">
            {{ slotWriterError }}
          </p>
          <div class="stitch-variable-writer__actions">
            <button class="button button--quiet" type="button" @click="slotWriterOpen = false">
              取消
            </button>
            <button type="button" class="button button--primary" @click="insertPromptSlot($event)">
              {{ slotId ? '更新占位' : '插入占位' }}
            </button>
          </div>
        </section>
      </div>

      <div
        v-if="sourcePickerOpen"
        class="stitch-sheet mobile-dialog-viewport"
        data-srl-controls
        role="dialog"
        aria-modal="true"
        aria-label="选择填充内容"
        @click.self="sourcePickerOpen = false"
      >
        <section class="stitch-sheet__panel">
          <header>
            <span><strong>选择填充内容</strong></span
            ><button
              class="button button--quiet"
              type="button"
              aria-label="关闭"
              @click="sourcePickerOpen = false"
            >
              ×
            </button>
          </header>
          <div v-if="favorites.length" class="stitch-sheet__favorites">
            <button type="button" @click="chooseFavoriteSource">
              <strong>已收藏预设条目</strong
              ><small>{{ favorites.length }} 条 · 跨预设直接复用</small>
            </button>
          </div>
          <label class="stitch__search"
            ><svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="10.5" cy="10.5" r="6.5" />
              <path d="m16 16 4 4" /></svg
            ><input
              v-model="presetSearch"
              type="search"
              aria-label="搜索填充预设"
              placeholder="搜索填充预设"
          /></label>
          <ul class="stitch__preset-list">
            <li v-for="resource in sourcePresetPageItems" :key="resource.id">
              <button type="button" :disabled="busy" @click="chooseSource(resource)">
                <span
                  ><strong>{{ resource.name }}</strong
                  ><em v-if="Array.isArray(resource.metadata.stitchedFrom)">我的自缝版</em
                  ><em v-else>原始预设</em></span
                ><small
                  >{{ presetSegmentCount(resource) }} 条 ·
                  {{ formatDate(resource.updatedAt) }}</small
                >
              </button>
            </li>
            <li v-if="!sourcePresetPageItems.length" class="stitch__empty">
              {{ presetSearch ? '没有匹配的填充预设' : '没有其他可用预设。' }}
            </li>
          </ul>
          <nav v-if="sourcePresetPageCount > 1" class="stitch-pagination">
            <button
              class="button button--quiet"
              type="button"
              :disabled="presetPage === 1"
              @click="setPage('preset', presetPage - 1)"
            >
              ←</button
            ><span>{{ presetPage }} / {{ sourcePresetPageCount }}</span
            ><button
              class="button button--quiet"
              type="button"
              :disabled="presetPage === sourcePresetPageCount"
              @click="setPage('preset', presetPage + 1)"
            >
              →
            </button>
          </nav>
        </section>
      </div>

      <PresetCandidateSheet :model="panelModel" />

      <div
        v-if="sourceDrag?.picked"
        class="stitch-drag-ghost"
        :style="{ left: `${sourceDrag.x}px`, top: `${sourceDrag.y}px` }"
        role="status"
      >
        {{
          sourceDrag.overDropSlot
            ? `松手插入第 ${sourceDrag.targetIndex + 1} 位`
            : '移到主预设条目之间后松手'
        }}
      </div>
    </Teleport>
  </section>
</template>

<style scoped src="../styles/PresetStitcherApp.css"></style>
