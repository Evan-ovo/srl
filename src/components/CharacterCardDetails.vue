<script setup lang="ts">
import { ref, useTemplateRef, watch } from 'vue'
import GreetingPreviewDialog from './GreetingPreviewDialog.vue'
import FeatureBackButton from './FeatureBackButton.vue'
import CharacterCardContentWorkbench from './CharacterCardContentWorkbench.vue'
import WorldBookBrowser from './WorldBookBrowser.vue'
import {
  useCharacterCardDetails,
  type CharacterCardDetailsProps,
  type CharacterCardDetailsEvents,
} from '../composables/UseCharacterCardDetails'
const props = withDefaults(defineProps<CharacterCardDetailsProps>(), {
  boundResources: () => [],
  overrides: () => ({}),
  contentEdits: () => [],
})
const emit = defineEmits<CharacterCardDetailsEvents>()
const controller = useCharacterCardDetails(props, emit)
const worldBrowser = useTemplateRef<{ closeDetail: () => boolean }>('worldBrowser')
function handleClosePage() {
  if (!worldBrowser.value?.closeDetail()) controller.closePage()
}
function selectGreetingPageInput(event: FocusEvent) {
  ;(event.currentTarget as HTMLInputElement).select()
}
function jumpToGreetingPage(event: Event) {
  const input = event.currentTarget as HTMLInputElement
  const requested = /^\d+$/u.test(input.value) ? Number(input.value) : Number.NaN
  if (Number.isSafeInteger(requested) && requested >= 1)
    scrollToGreeting(Math.min(greetings.value.length, requested) - 1, false)
  input.value = String(activeGreetingIndex.value + 1).padStart(2, '0')
}
const showContentWorkbench = ref(false)
watch(showContentWorkbench, (open) => emit('workbench-open', open), { immediate: true })
const contentWorkbench = useTemplateRef<{ prepareSave: () => Promise<boolean> }>('contentWorkbench')
defineExpose({
  prepareSave: async () => {
    const ready = (await contentWorkbench.value?.prepareSave()) ?? true
    if (!ready) {
      showContentWorkbench.value = true
      controller.activePage.value = 'overview'
    }
    return ready
  },
})
const {
  sourceCard,
  cardData,
  activePage,
  creator,
  characterVersion,
  spec,
  worldBookReplacementSources,
  greetingReplacementSources,
  updateReplacement,
  greetings,
  greetingCards,
  openPage,
  embeddedBookEntries,
  embeddedBookName,
  embeddedBookBadge,
  embeddedRegexScripts,
  embeddedRegexBadge,
  embeddedHelperScripts,
  embeddedHelperBadge,
  sections,
  pageTitle,
  pageCount,
  activeGreetingIndex,
  greetingRegexStatus,
  greetingRegexState,
  greetingRegexStatusTitle,
  openGreetingPreview,
  scrollGreetings,
  updateGreetingIndex,
  handleGreetingKeydown,
  handleGreetingTouchStart,
  handleGreetingTouchEnd,
  handleGreetingCardDoubleClick,
  scrollToGreeting,
  PAGE_SIZE,
  selectedRegexScript,
  selectedRegexScriptId,
  setRegexEnabled,
  previewPolicy,
  hasBlockedRegexPreviewContent,
  embeddedRegexQuery,
  pagedEmbeddedRegexScripts,
  embeddedRegexPage,
  filteredEmbeddedRegexScripts,
  embeddedRegexPageCount,
  selectedHelperScript,
  selectedHelperScriptId,
  helperScriptLocation,
  greetingPreviewIndex,
  greetingRuntimeScripts,
  characterName,
  greetingRegexRules,
  contentEdits,
  handleGreetingPreviewClose,
} = controller
</script>

<template>
  <section
    v-if="cardData"
    ref="characterRoot"
    class="character-record"
    :aria-labelledby="showContentWorkbench ? undefined : 'character-record-title'"
    :aria-label="showContentWorkbench ? '卡内内容编辑' : undefined"
  >
    <header
      v-if="activePage === 'overview' && !showContentWorkbench"
      class="character-record__header"
    >
      <h3 id="character-record-title">角色档案</h3>
      <button
        type="button"
        class="character-record__edit-button"
        :disabled="disabled"
        @click="showContentWorkbench = true"
      >
        编辑卡内内容
      </button>
      <div class="character-record__badges">
        <span v-if="creator">作者 · {{ creator }}</span>
        <span v-if="characterVersion">版本 · {{ characterVersion }}</span>
        <span v-if="spec">{{ spec }}</span>
      </div>
    </header>
    <CharacterCardContentWorkbench
      v-if="sourceCard"
      v-show="showContentWorkbench && activePage === 'overview'"
      ref="contentWorkbench"
      :card="sourceCard"
      :edits="contentEdits"
      :disabled="disabled"
      :overridden-sections="[
        ...(overrides.worldBookResourceId ? ['worldBook' as const] : []),
        ...(overrides.greetingResourceId ? ['greeting' as const] : []),
      ]"
      @update:edits="emit('update:contentEdits', $event)"
      @draft-change="emit('draft-change', $event)"
      @back="showContentWorkbench = false"
      @use-original="
        updateReplacement($event === 'worldBook' ? 'worldBookResourceId' : 'greetingResourceId', '')
      "
    >
      <template #save><slot name="content-save" /></template>
    </CharacterCardContentWorkbench>
    <Transition name="character-page" mode="out-in">
      <div
        v-if="activePage === 'overview'"
        v-show="!showContentWorkbench"
        key="overview"
        class="character-record__overview"
      >
        <section
          v-if="worldBookReplacementSources.length || greetingReplacementSources.length"
          class="character-source-panel"
          aria-labelledby="character-source-panel-title"
        >
          <header>
            <span>
              <strong id="character-source-panel-title">卡内内容来源</strong>
            </span>
            <em>只显示已绑定资源</em>
          </header>
          <p>原文件不会被改写；这里的选择只影响资源库预览和“修改版导出”。</p>
          <div>
            <label v-if="greetingReplacementSources.length">
              <span>开场白</span>
              <select
                :value="overrides.greetingResourceId ?? ''"
                @change="
                  updateReplacement(
                    'greetingResourceId',
                    ($event.target as HTMLSelectElement).value,
                  )
                "
              >
                <option value="">使用角色卡原始开场白</option>
                <option
                  v-for="source in greetingReplacementSources"
                  :key="source.resource.id"
                  :value="source.resource.id"
                >
                  {{ source.resource.name }} · {{ source.content.greetings?.length ?? 0 }} 条
                </option>
              </select>
            </label>
            <label v-if="worldBookReplacementSources.length">
              <span>世界书</span>
              <select
                :value="overrides.worldBookResourceId ?? ''"
                @change="
                  updateReplacement(
                    'worldBookResourceId',
                    ($event.target as HTMLSelectElement).value,
                  )
                "
              >
                <option value="">使用角色卡内嵌世界书</option>
                <option
                  v-for="source in worldBookReplacementSources"
                  :key="source.resource.id"
                  :value="source.resource.id"
                >
                  {{ source.resource.name }}
                </option>
              </select>
            </label>
          </div>
        </section>

        <nav class="character-content-index" aria-label="角色卡内容导航">
          <button
            v-if="greetings.length"
            type="button"
            class="character-content-index__item character-content-index__item--primary"
            @click="openPage('greetings')"
          >
            <small>OPENING MESSAGES</small>
            <strong>开场白</strong>
            <span>{{ greetings.length }} 个版本 · 左右滑动查看</span>
            <i aria-hidden="true">→</i>
          </button>
          <button
            v-if="embeddedBookEntries.length"
            type="button"
            class="character-content-index__item"
            @click="openPage('worldBook')"
          >
            <small>世界书条目</small>
            <strong>{{ embeddedBookName }}</strong>
            <span>{{ embeddedBookBadge }}</span>
            <i aria-hidden="true">→</i>
          </button>
          <button
            v-if="embeddedRegexScripts.length"
            type="button"
            class="character-content-index__item"
            @click="openPage('regex')"
          >
            <small>REGEX RULES</small>
            <strong>角色专属正则</strong>
            <span>{{ embeddedRegexBadge }}</span>
            <i aria-hidden="true">→</i>
          </button>
          <button
            v-if="embeddedHelperScripts.length"
            type="button"
            class="character-content-index__item"
            @click="openPage('helper')"
          >
            <small>TAVERN HELPER</small>
            <strong>酒馆助手脚本</strong>
            <span>{{ embeddedHelperBadge }}</span>
            <i aria-hidden="true">→</i>
          </button>
        </nav>

        <div class="character-record__sections">
          <details
            v-for="section in sections"
            :key="section.key"
            class="character-record__section"
            :open="section.open"
          >
            <summary>{{ section.label }}</summary>
            <div>{{ section.content }}</div>
          </details>
        </div>
      </div>

      <section v-else :key="activePage" class="character-subpage">
        <header class="character-subpage__header">
          <FeatureBackButton label="返回角色档案" @click="handleClosePage" />
          <div>
            <h3>{{ pageTitle }}</h3>
          </div>
          <span>{{ pageCount }}</span>
        </header>

        <div v-if="activePage === 'greetings'" class="character-greetings-page">
          <div class="character-greetings-page__toolbar">
            <span>
              <input
                class="inline-page-jump"
                style="width: 2ch"
                :value="String(activeGreetingIndex + 1).padStart(2, '0')"
                type="text"
                inputmode="numeric"
                :maxlength="String(greetings.length).length"
                aria-label="跳转到开场白"
                @focus="selectGreetingPageInput"
                @change="jumpToGreetingPage"
                @keydown.enter.prevent="jumpToGreetingPage"
              />
              /
              {{ String(greetings.length).padStart(2, '0') }}
            </span>
            <small
              v-if="greetingRegexStatus"
              class="character-greetings-page__regex-status"
              :class="{ 'is-error': greetingRegexState === 'failed' }"
              :title="greetingRegexStatusTitle"
            >
              {{ greetingRegexStatus }}
            </small>
            <div class="character-greetings__controls">
              <button
                type="button"
                class="character-greetings__fullscreen"
                @click="openGreetingPreview(activeGreetingIndex, $event)"
              >
                全屏预览
                <span aria-hidden="true">↗</span>
              </button>
              <button
                v-if="greetings.length > 1"
                type="button"
                aria-label="查看上一条开场白"
                :disabled="activeGreetingIndex === 0"
                @click="scrollGreetings(-1)"
              >
                ←
              </button>
              <button
                v-if="greetings.length > 1"
                type="button"
                aria-label="查看下一条开场白"
                :disabled="activeGreetingIndex === greetings.length - 1"
                @click="scrollGreetings(1)"
              >
                →
              </button>
            </div>
          </div>
          <div
            ref="greetingTrack"
            class="character-greetings__track character-greetings__track--page"
            style="display: flex"
            role="list"
            tabindex="0"
            aria-label="开场白横向列表"
            @scroll.passive="updateGreetingIndex"
            @keydown="handleGreetingKeydown"
            @touchstart.passive="handleGreetingTouchStart"
            @touchend.passive="handleGreetingTouchEnd"
          >
            <article
              v-for="(greeting, index) in greetingCards"
              :key="greeting.key"
              role="listitem"
              :class="{ 'is-active': activeGreetingIndex === index }"
              style="flex: 0 0 100%"
              @dblclick="handleGreetingCardDoubleClick(index, $event)"
            >
              <header class="character-greeting-card__header">
                <span>
                  <small>OPENING {{ String(index + 1).padStart(2, '0') }}</small>
                  <strong>{{ greeting.label }}</strong>
                </span>
                <span class="character-greeting-card__badges">
                  <em v-if="greeting.group">{{ greeting.group }}</em>
                  <em v-if="greeting.theme && greeting.theme !== greeting.group">
                    {{ greeting.theme }}
                  </em>
                  <em>{{ greeting.richContent ? '富内容' : '纯文本' }}</em>
                </span>
              </header>
              <p class="character-greeting-card__excerpt">
                {{ greeting.excerpt }}
              </p>
              <footer class="character-greeting-card__footer">
                <small>左右滑动切换，本页只展示摘要</small>
                <button
                  type="button"
                  @click.stop="openGreetingPreview(index, $event)"
                  @touchend.stop
                >
                  全屏预览
                  <span aria-hidden="true">↗</span>
                </button>
              </footer>
            </article>
          </div>
          <nav
            v-if="greetings.length > 1"
            class="character-greetings-page__dots"
            aria-label="开场白页码"
          >
            <button
              v-for="(greeting, index) in greetings"
              :key="greeting.key"
              type="button"
              :class="{ 'is-active': activeGreetingIndex === index }"
              :aria-label="`查看${greeting.label}`"
              :aria-current="activeGreetingIndex === index ? 'page' : undefined"
              @click="scrollToGreeting(index)"
            ></button>
          </nav>
          <p class="character-greetings-page__hint">
            左右滑动切换开场白；需要完整操作富内容时，请进入全屏阅读。
          </p>
        </div>

        <WorldBookBrowser
          v-else-if="activePage === 'worldBook'"
          ref="worldBrowser"
          :entries="embeddedBookEntries"
          page-input-label="跳转到内嵌世界书条目页"
        />

        <div v-else-if="activePage === 'regex'" class="character-asset-page">
          <article
            v-if="selectedRegexScript"
            class="character-asset-detail character-asset-detail--regex"
          >
            <button
              type="button"
              class="character-asset-detail__back"
              @click="selectedRegexScriptId = ''"
            >
              <span aria-hidden="true">←</span>
              返回正则目录
            </button>
            <header>
              <small>REGEX RULE · {{ selectedRegexScript.effect.kind }}</small>
              <h4>{{ selectedRegexScript.name }}</h4>
              <button
                type="button"
                class="character-regex-toggle"
                :class="{ 'is-enabled': !selectedRegexScript.disabled }"
                :aria-pressed="!selectedRegexScript.disabled"
                @click="setRegexEnabled(selectedRegexScript, selectedRegexScript.disabled)"
              >
                {{ selectedRegexScript.disabled ? '启用此正则' : '停用此正则' }}
              </button>
            </header>
            <div class="regex-effect" :class="`regex-effect--${selectedRegexScript.effect.kind}`">
              <section>
                <small>匹配示例</small>
                <code>{{ selectedRegexScript.effect.before }}</code>
              </section>
              <i aria-hidden="true">→</i>
              <section>
                <small>最终效果</small>
                <code>{{ selectedRegexScript.effect.after }}</code>
              </section>
            </div>
            <p class="regex-effect__explanation">{{ selectedRegexScript.effect.explanation }}</p>
            <section v-if="selectedRegexScript.previewDocument" class="regex-rendered-preview">
              <header>
                <div>
                  <small>{{
                    previewPolicy.allowScripts ? 'ISOLATED RUNTIME' : 'STATIC RENDER'
                  }}</small>
                  <strong>{{
                    previewPolicy.allowScripts ? 'HTML / CSS 隔离运行效果' : 'HTML / CSS 静态效果'
                  }}</strong>
                </div>
                <span>{{
                  previewPolicy.allowScripts
                    ? '隔离脚本已允许'
                    : previewPolicy.allowRemoteResources
                      ? '联网内容已允许'
                      : '脚本与联网内容已阻止'
                }}</span>
              </header>
              <iframe
                :key="`${selectedRegexScript.id}-${selectedRegexScript.replace.length}-${previewPolicy.allowRemoteResources}-${previewPolicy.allowScripts}`"
                :srcdoc="selectedRegexScript.previewDocument"
                :sandbox="previewPolicy.allowScripts ? 'allow-scripts' : ''"
                loading="lazy"
                :title="`${selectedRegexScript.name} 的隔离替换效果`"
              ></iframe>
              <p v-if="hasBlockedRegexPreviewContent(selectedRegexScript.effect)">
                {{
                  previewPolicy.allowScripts
                    ? '脚本与远程资源已在无同源权限的隔离预览中启用；原文件不受影响。'
                    : previewPolicy.allowRemoteResources
                      ? '远程图片与字体已允许，脚本仍被阻止；原文件不受影响。'
                      : '脚本与远程资源已阻止；可在设置中统一调整预览权限，原文件不受影响。'
                }}
              </p>
            </section>
            <div
              v-else-if="selectedRegexScript.effect.kind === 'dynamic'"
              class="regex-dynamic-notice"
            >
              <strong>此替换依赖动态脚本</strong>
              <p>资源库不会执行未知脚本；原代码仍完整保留，可在下方按需检查。</p>
            </div>
            <details class="regex-raw-rule">
              <summary>查看原始正则与替换代码</summary>
              <div class="regex-flow__pipeline">
                <section>
                  <small>查找 FIND</small>
                  <code>{{ selectedRegexScript.find || '未提供查找表达式' }}</code>
                </section>
                <i aria-hidden="true">→</i>
                <section>
                  <small>替换 REPLACE</small>
                  <code>{{ selectedRegexScript.replace || '空内容（删除匹配项）' }}</code>
                </section>
              </div>
            </details>
          </article>
          <template v-else>
            <label v-if="embeddedRegexScripts.length > 6" class="character-asset-page__search">
              <span>搜索正则</span>
              <input
                v-model="embeddedRegexQuery"
                type="search"
                placeholder="名称、查找或替换内容"
              />
            </label>
            <ol class="character-asset-directory">
              <li v-for="(script, index) in pagedEmbeddedRegexScripts" :key="script.id">
                <div class="character-regex-directory-row">
                  <button type="button" @click="selectedRegexScriptId = script.id">
                    <i>{{
                      String((embeddedRegexPage - 1) * PAGE_SIZE + index + 1).padStart(2, '0')
                    }}</i>
                    <span>
                      <strong>{{ script.name }}</strong>
                      <small>{{ script.effect.explanation }}</small>
                    </span>
                    <b aria-hidden="true">›</b>
                  </button>
                  <button
                    type="button"
                    class="character-regex-toggle"
                    :class="{ 'is-enabled': !script.disabled }"
                    :aria-label="`${script.disabled ? '启用' : '停用'}${script.name}`"
                    :aria-pressed="!script.disabled"
                    @click="setRegexEnabled(script, script.disabled)"
                  >
                    {{ script.disabled ? '启用' : '停用' }}
                  </button>
                </div>
              </li>
            </ol>
            <p v-if="!pagedEmbeddedRegexScripts.length" class="character-asset-page__empty">
              没有匹配的正则规则。
            </p>
            <nav
              v-if="filteredEmbeddedRegexScripts.length > PAGE_SIZE"
              class="character-asset-page__pagination"
            >
              <button type="button" :disabled="embeddedRegexPage <= 1" @click="embeddedRegexPage--">
                上一页
              </button>
              <span>第 {{ embeddedRegexPage }} / {{ embeddedRegexPageCount }} 页</span>
              <button
                type="button"
                :disabled="embeddedRegexPage >= embeddedRegexPageCount"
                @click="embeddedRegexPage++"
              >
                下一页
              </button>
            </nav>
          </template>
        </div>

        <div v-else-if="activePage === 'helper'" class="character-asset-page">
          <article v-if="selectedHelperScript" class="character-asset-detail">
            <button
              type="button"
              class="character-asset-detail__back"
              @click="selectedHelperScriptId = ''"
            >
              <span aria-hidden="true">←</span>
              返回脚本目录
            </button>
            <header>
              <small>TAVERN HELPER · {{ helperScriptLocation(selectedHelperScript) }}</small>
              <h4>{{ selectedHelperScript.name }}</h4>
            </header>
            <p v-if="selectedHelperScript.info">{{ selectedHelperScript.info }}</p>
            <div v-if="selectedHelperScript.buttons.length" class="embedded-helper-list__buttons">
              <span v-for="button in selectedHelperScript.buttons" :key="button">
                按钮 · {{ button }}
              </span>
            </div>
            <pre>{{ selectedHelperScript.content || '此脚本没有代码内容。' }}</pre>
          </article>
          <template v-else>
            <p class="embedded-assets__warning">
              详情页只展示代码；开场白预览在允许脚本时，会在当前预览运行环境中执行已启用脚本。运行前请确认来源可信。
            </p>
            <ol class="character-asset-directory">
              <li v-for="(script, index) in embeddedHelperScripts" :key="script.id">
                <button type="button" @click="selectedHelperScriptId = script.id">
                  <i>{{ String(index + 1).padStart(2, '0') }}</i>
                  <span>
                    <strong>{{ script.name }}</strong>
                    <small>{{ helperScriptLocation(script) }}</small>
                  </span>
                  <em>{{ script.buttons.length }} 按钮</em>
                  <b aria-hidden="true">›</b>
                </button>
              </li>
            </ol>
          </template>
        </div>
      </section>
    </Transition>
  </section>

  <GreetingPreviewDialog
    v-model="greetingPreviewIndex"
    :items="greetings"
    :runtime-scripts="greetingRuntimeScripts"
    :macro-char-name="characterName"
    :character-data="cardData"
    :display-regex-rules="greetingRegexRules"
    :preload-resources="previewPolicy.preloadGreetingResources === true"
    context-title="角色开场白"
    @close="handleGreetingPreviewClose"
  />
</template>
