<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId } from 'vue'
import type { ReferenceCatalog } from '../types/AppearanceReference'
import type { AppearanceReferenceReader } from '../services/AppearanceReferenceService'
import { downloadBlob } from '../utils/LibraryFormatting'
import '../styles/AppearanceOriginalCssActions.css'
import FeatureAppIcon from './FeatureAppIcon.vue'
import { FEATURE_APP_REGISTRY } from '../core/FeatureAppRegistry'
import {
  CARD_REFERENCE,
  CSS_REFERENCE_INTRO,
  VUE_REFERENCE_BOUNDARY,
  createReferenceChapters,
  referenceMarkdown,
  referenceProperty,
  vueReferenceExample,
  type ReferenceChapter,
  type ReferenceExportKind,
} from '../core/AppearanceReference'

const titleId = useId()
const dialog = ref<HTMLDialogElement>()
const content = ref<HTMLElement>()
const chapters = ref<ReferenceChapter[]>(createReferenceChapters({ sources: [], scopes: {} }))
let catalog: ReferenceCatalog | undefined
let displayedCatalog: ReferenceCatalog | undefined
let catalogLoading: Promise<void> | undefined
let installedReader: Promise<AppearanceReferenceReader> | undefined
let request = new AbortController()
let selectionRevision = 0
const opened = ref(new Set<string>())
function disclosure(event: Event, key: string) {
  const target = event.currentTarget as HTMLDetailsElement
  if (!target.isConnected || request.signal.aborted) return
  if (target.open) opened.value.add(key)
  else opened.value.delete(key)
}
function close() {
  request.abort()
  selectionRevision++
  loading.value = false
  exportOpen.value = false
  opened.value.clear()
}
onBeforeUnmount(() => {
  close()
  void installedReader?.then(
    (reader) => reader.clear(),
    () => {},
  )
})
async function loadCatalog() {
  if (catalog) return
  const signal = request.signal
  catalogLoading ??= import('virtual:srl-appearance-reference')
    .then(({ default: generated }) => {
      if (signal.aborted) throw new DOMException('已取消读取教程', 'AbortError')
      catalog = generated
      displayedCatalog = generated
      chapters.value = createReferenceChapters(generated)
    })
    .finally(() => {
      catalogLoading = undefined
    })
  await catalogLoading
}
async function synchronize(appIds: string[]) {
  await loadCatalog()
  if (!appIds.length) return chapters.value
  const signal = request.signal
  installedReader ??= import('../services/AppearanceReferenceService')
    .then(({ createInstalledAppearanceReferenceReader }) =>
      createInstalledAppearanceReferenceReader(catalog!),
    )
    .catch((error: unknown) => {
      installedReader = undefined
      throw error
    })
  const reader = await installedReader
  const nextCatalog = await reader.read(appIds, signal)
  if (signal.aborted) throw new DOMException('已取消读取教程', 'AbortError')
  if (nextCatalog === displayedCatalog) return chapters.value
  displayedCatalog = nextCatalog
  const updated = createReferenceChapters(nextCatalog)
  chapters.value = updated
  return updated
}
async function synchronizeSelection(chapter: ReferenceChapter) {
  const revision = ++selectionRevision
  loading.value = true
  status.value = ''
  try {
    const updated = await synchronize(chapter.scope.appId ? [chapter.scope.appId] : [])
    if (revision === selectionRevision && selected.value)
      selected.value = updated.find((item) => item.scope.value === chapter.scope.value)
  } catch (error) {
    if (revision === selectionRevision && !request.signal.aborted)
      status.value = error instanceof Error ? error.message : '教程更新失败'
  } finally {
    if (revision === selectionRevision) loading.value = false
  }
}
const mode = ref<'choice' | 'global' | 'app'>('choice')
const activeId = ref('all')
const selected = ref<ReferenceChapter>()
const query = ref('')
const status = ref('')
const loading = ref(false)
const busy = ref(false)
const exportOpen = ref(false)
const navigationOpen = ref(false)
const navigationQuery = ref('')
const navigationToggle = ref<HTMLButtonElement>()
const fullScreen = computed(() => mode.value === 'global' || !!selected.value)
const title = computed(() =>
  mode.value === 'choice'
    ? '接口参考'
    : mode.value === 'global'
      ? '全局接口'
      : selected.value
        ? `${selected.value.scope.title}接口`
        : '单独 APP 接口',
)
const appChapters = computed(() =>
  chapters.value.filter((chapter) => chapter.scope.value !== 'all'),
)
const documentChapters = computed(() => (selected.value ? [selected.value] : chapters.value))
const exportChapters = computed(() =>
  mode.value === 'global' ? chapters.value : selected.value ? [selected.value] : [],
)
const chapterIcon = (chapter: ReferenceChapter) =>
  FEATURE_APP_REGISTRY.find((app) => app.id === chapter.scope.appId)?.icon ?? 'appearance'
const matches = (text: string) =>
  text.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())
const matchesChapter = (chapter: ReferenceChapter) =>
  matches(chapter.scope.title) ||
  matches(chapter.scope.hint) ||
  chapter.variables.some((variable) => matches(variable.name + ' ' + variable.meaning)) ||
  chapter.sources.some((source) => source.rules.some((rule) => matches(rule.selector)))
const filteredChapters = computed(() => documentChapters.value.filter(matchesChapter))
const visibleChapters = computed(() =>
  mode.value === 'app' || query.value.trim()
    ? filteredChapters.value
    : filteredChapters.value.filter((chapter) => chapter.scope.value === activeId.value),
)
const navigationGroups = computed(() => {
  const search = navigationQuery.value.trim().toLocaleLowerCase()
  const apps = chapters.value.filter((chapter) =>
    (chapter.scope.title + ' ' + chapter.scope.hint).toLocaleLowerCase().includes(search),
  )
  return [
    { title: '全局与外层', apps: apps.filter((chapter) => !chapter.scope.appId) },
    { title: '内置 APP', apps: apps.filter((chapter) => chapter.scope.appId) },
  ].filter((group) => group.apps.length)
})
function visibleVariables(chapter: ReferenceChapter) {
  return !query.value.trim() || matches(chapter.scope.title)
    ? chapter.variables
    : chapter.variables.filter((variable) =>
        matches(
          variable.name +
            ' ' +
            variable.meaning +
            ' ' +
            variable.uses.map((use) => use.selector).join(' '),
        ),
      )
}
function sourceText(source: ReferenceChapter['sources'][number]) {
  return source.rules
    .filter(
      (rule) =>
        !query.value.trim() ||
        matches(rule.selector) ||
        Object.keys(rule.declarations).some(matches),
    )
    .map(
      (rule) =>
        `${rule.selector}\n作用：${Object.keys(rule.declarations).map(referenceProperty).join('、')}${rule.conditions ? '\n条件：' + rule.conditions : ''}`,
    )
    .join('\n\n')
}
function open() {
  if (request.signal.aborted) request = new AbortController()
  mode.value = 'choice'
  selected.value = undefined
  query.value = ''
  status.value = ''
  exportOpen.value = false
  navigationOpen.value = false
  navigationQuery.value = ''
  opened.value.clear()
  dialog.value?.showModal()
}
async function choose(value: 'global' | 'app') {
  opened.value.clear()
  selectionRevision++
  loading.value = false
  mode.value = value
  activeId.value = 'all'
  selected.value = undefined
  query.value = ''
  status.value = ''
  navigationOpen.value = false
  navigationQuery.value = ''
  if (value === 'global') await synchronizeSelection(chapters.value[0]!)
}
async function selectApp(chapter: ReferenceChapter) {
  opened.value.clear()
  selected.value = chapter
  activeId.value = chapter.scope.value
  query.value = ''
  content.value?.scrollTo({ top: 0 })
  await synchronizeSelection(chapter)
}
function back() {
  opened.value.clear()
  selectionRevision++
  loading.value = false
  if (selected.value) selected.value = undefined
  else mode.value = 'choice'
  query.value = ''
  exportOpen.value = false
  status.value = ''
}
async function jump(id: string) {
  opened.value.clear()
  selectionRevision++
  loading.value = false
  activeId.value = id
  query.value = ''
  navigationOpen.value = false
  await nextTick()
  content.value?.scrollTo({ top: 0 })
  navigationToggle.value?.focus({ preventScroll: true })
  const chapter = chapters.value.find((item) => item.scope.value === id)
  if (chapter) await synchronizeSelection(chapter)
}
function dismissNavigation(event?: Event) {
  if (!navigationOpen.value) return
  event?.preventDefault()
  navigationOpen.value = false
  navigationToggle.value?.focus()
}
async function toggleNavigation() {
  navigationOpen.value = !navigationOpen.value
  exportOpen.value = false
  if (navigationOpen.value) {
    await nextTick()
    dialog.value
      ?.querySelector<HTMLElement>('.reference-navigation [aria-current]')
      ?.scrollIntoView({ block: 'nearest' })
  }
}
function toggleExport() {
  exportOpen.value = !exportOpen.value
  navigationOpen.value = false
}
async function transfer(kind: ReferenceExportKind, copy = false) {
  if (busy.value) return
  busy.value = true
  status.value = ''
  const signal = request.signal
  try {
    const chosen = exportChapters.value
    const filenameTitle = title.value
    await loadCatalog()
    if (signal.aborted) return
    const updated =
      kind === 'vue'
        ? chapters.value
        : await synchronize(
            chosen.flatMap((chapter) => (chapter.scope.appId ? [chapter.scope.appId] : [])),
          )
    const markdown = referenceMarkdown(
      updated.filter((chapter) => chosen.some((item) => item.scope.value === chapter.scope.value)),
      kind,
    )
    if (copy) {
      if (!navigator.clipboard?.writeText) throw new Error('浏览器不支持复制，请导出 Markdown')
      await navigator.clipboard.writeText(markdown)
      status.value = '当前教程已复制'
    } else {
      await downloadBlob(
        new Blob([markdown], { type: 'text/markdown;charset=utf-8' }),
        `SRL-${filenameTitle}-${kind}.md`,
      )
      status.value = 'Markdown 教程已导出'
    }
    exportOpen.value = false
  } catch (error) {
    if (!signal.aborted) status.value = error instanceof Error ? error.message : '操作失败，请重试'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <button
    class="appearance-code-help"
    type="button"
    aria-label="接口参考"
    aria-haspopup="dialog"
    title="接口参考"
    @click="open"
  >
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9a2.5 2.5 0 0 1 5 .5c0 1.5-2.5 1.5-2.5 3.5M12 16.5h.01" />
    </svg>
  </button>
  <Teleport to="body">
    <dialog
      ref="dialog"
      class="appearance-code-reference"
      :class="{ 'appearance-code-reference--full': fullScreen }"
      :aria-labelledby="titleId"
      @click.self="dialog?.close()"
      @close="close"
      @cancel="dismissNavigation"
    >
      <header class="reference-header">
        <button
          v-if="mode !== 'choice'"
          type="button"
          class="reference-icon"
          aria-label="返回教程列表"
          @click="back"
        >
          ←
        </button>
        <h2 :id="titleId">{{ title }}</h2>
        <button
          v-if="fullScreen"
          type="button"
          class="reference-icon"
          aria-label="导出教程"
          title="导出 Markdown 教程"
          :aria-expanded="exportOpen"
          @click="toggleExport"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M12 3v12m-4-4 4 4 4-4M5 15v5h14v-5" />
          </svg>
        </button>
        <button
          type="button"
          class="reference-icon"
          aria-label="关闭接口参考"
          @click="dialog?.close()"
        >
          ×
        </button>
        <div v-if="exportOpen" class="reference-export" aria-label="选择导出内容">
          <button
            type="button"
            class="appearance-action-hit"
            :disabled="busy"
            @click="transfer('css')"
          >
            <span class="appearance-action-face">仅导出 CSS 接口</span>
          </button>
          <button
            type="button"
            class="appearance-action-hit"
            :disabled="busy"
            @click="transfer('vue')"
          >
            <span class="appearance-action-face">仅导出 Vue 教程</span>
          </button>
          <button
            type="button"
            class="appearance-action-hit"
            :disabled="busy"
            @click="transfer('both')"
          >
            <span class="appearance-action-face">两者都导出</span>
          </button>
        </div>
      </header>
      <div v-if="mode === 'choice'" class="reference-choice">
        <button
          type="button"
          class="appearance-action-hit"
          :disabled="loading || !chapters.length"
          @click="choose('global')"
        >
          <span class="appearance-action-face">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              aria-hidden="true"
            >
              <path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5" /></svg
            ><strong>全局接口</strong></span
          >
        </button>
        <button
          type="button"
          class="appearance-action-hit"
          :disabled="loading || !chapters.length"
          @click="choose('app')"
        >
          <span class="appearance-action-face">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              aria-hidden="true"
            >
              <rect x="4" y="4" width="16" height="16" rx="3" />
              <path d="M4 10h16M10 10v10" /></svg
            ><strong>单独 APP 接口</strong></span
          >
        </button>
      </div>
      <template v-else>
        <label class="reference-search"
          ><span>查找</span
          ><input
            v-model="query"
            type="search"
            :placeholder="fullScreen ? 'APP、变量、用途或选择器' : '搜索 APP 或界面'"
        /></label>
        <div v-if="mode === 'app' && !selected" class="reference-app-list">
          <button
            v-for="chapter in appChapters.filter(matchesChapter)"
            :key="chapter.scope.value"
            type="button"
            :title="chapter.scope.hint"
            @click="selectApp(chapter)"
          >
            <span class="reference-app-icon"><FeatureAppIcon :name="chapterIcon(chapter)" /></span>
            <strong>{{ chapter.scope.title }}</strong
            ><b aria-hidden="true">›</b>
          </button>
          <p v-if="!appChapters.filter(matchesChapter).length">没有找到匹配的 APP 或界面。</p>
        </div>
        <div v-else class="reference-workspace">
          <template v-if="mode === 'global'">
            <button
              ref="navigationToggle"
              type="button"
              class="reference-navigation-handle"
              :class="{ 'reference-navigation-handle--open': navigationOpen }"
              :aria-label="navigationOpen ? '收起教程导航' : '展开教程导航'"
              :aria-expanded="navigationOpen"
              title="教程目录"
              @click="toggleNavigation"
            >
              <span>
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="m14 7-5 5 5 5" />
                </svg>
              </span>
            </button>
            <aside
              class="reference-navigation"
              :class="{ 'reference-navigation--open': navigationOpen }"
              aria-label="教程快速跳转"
              @keydown.esc.stop.prevent="dismissNavigation()"
            >
              <header>
                <strong>教程目录</strong>
              </header>
              <label class="reference-search reference-navigation-search">
                <input
                  v-model="navigationQuery"
                  type="search"
                  aria-label="搜索教程目录"
                  placeholder="搜索 APP 或界面"
                />
              </label>
              <nav class="reference-navigation-list" aria-label="接口章节">
                <section v-for="group in navigationGroups" :key="group.title">
                  <h3>{{ group.title }}</h3>
                  <button
                    v-for="chapter in group.apps"
                    :key="chapter.scope.value"
                    type="button"
                    :title="chapter.scope.hint"
                    :aria-current="activeId === chapter.scope.value ? 'location' : undefined"
                    @click="jump(chapter.scope.value)"
                  >
                    <span class="reference-navigation-face">
                      <FeatureAppIcon :name="chapterIcon(chapter)" />
                      <span>{{ chapter.scope.title }}</span>
                      <b v-if="activeId === chapter.scope.value" aria-hidden="true">✓</b>
                    </span>
                  </button>
                </section>
                <p v-if="!navigationGroups.length">没有找到匹配的 APP。</p>
              </nav>
            </aside>
          </template>
          <main ref="content" class="reference-content">
            <p v-if="!filteredChapters.length">没有找到匹配的接口。</p>
            <section
              v-for="chapter in visibleChapters"
              :key="chapter.scope.value"
              class="reference-chapter"
              :data-reference-chapter="chapter.scope.value"
            >
              <h3 v-if="mode === 'global'">{{ chapter.scope.title }} · CSS 变量</h3>
              <div class="reference-chapter-body">
                <details class="reference-instructions">
                  <summary>CSS 用法与作用范围</summary>
                  <p>
                    作用范围：<code>{{ chapter.scope.selector }}</code>
                  </p>
                  <p v-if="chapter.scope.appId === 'chatReader'">
                    读了么使用宿主内置界面，正文样式由 Shadow DOM
                    隔离。正文请使用阅读器的外观设置；ChatReader.css 中的变量属于阅读器内部。
                  </p>
                  <p v-if="mode === 'app' || chapter.scope.value === 'all'">
                    {{ CSS_REFERENCE_INTRO }}
                  </p>
                  <p v-if="chapter.scope.value === 'library'">{{ CARD_REFERENCE }}</p>
                  <pre><code>{{ chapter.scope.value === 'all' ? ':root' : ':scope' }} {
  --color-accent: #7d4be2;
}</code></pre>
                </details>
                <h3 v-if="mode === 'app'" class="reference-variables-title">CSS 变量</h3>
                <p v-if="!visibleVariables(chapter).length">
                  没有匹配的变量，可展开下方选择器查找。
                </p>
                <details
                  v-for="variable in visibleVariables(chapter)"
                  :key="variable.name"
                  class="reference-variable"
                  @toggle="disclosure($event, `${chapter.scope.value}:var:${variable.name}`)"
                >
                  <summary>
                    <code>{{ variable.name }}</code
                    ><span>{{ variable.meaning }}</span>
                  </summary>
                  <ul v-if="opened.has(`${chapter.scope.value}:var:${variable.name}`)">
                    <li
                      v-for="(definition, index) in variable.definitions"
                      :key="`definition-${index}`"
                    >
                      定义：<code>{{ definition.value }}</code
                      ><br /><code>{{ definition.selector }}</code> {{ definition.conditions
                      }}<small>{{ definition.source }}</small>
                    </li>
                    <li v-for="(use, index) in variable.uses" :key="`use-${index}`">
                      使用：{{ referenceProperty(use.property) }}（<code>{{ use.property }}</code
                      >）<br /><code>{{ use.value }}</code
                      ><br /><code>{{ use.selector }}</code> {{ use.conditions
                      }}<small>{{ use.source }}</small>
                    </li>
                  </ul>
                </details>
                <details
                  class="reference-selectors"
                  @toggle="disclosure($event, `${chapter.scope.value}:sources`)"
                >
                  <summary>样式选择器</summary>
                  <template v-if="opened.has(`${chapter.scope.value}:sources`)">
                    <details
                      v-for="source in chapter.sources.filter(
                        (source) =>
                          chapter.scope.value === 'all' ||
                          !source.path.startsWith('src/styles/Foundation.css:'),
                      )"
                      :key="source.path"
                      @toggle="disclosure($event, `${chapter.scope.value}:source:${source.path}`)"
                    >
                      <summary>{{ source.path }}</summary>
                      <pre
                        v-if="opened.has(`${chapter.scope.value}:source:${source.path}`)"
                      ><code>{{ sourceText(source) }}</code></pre>
                    </details>
                  </template>
                </details>
                <details
                  v-if="chapter.scope.value !== 'all'"
                  class="reference-vue"
                  @toggle="disclosure($event, `${chapter.scope.value}:vue`)"
                >
                  <summary>高级：Vue 接口与教程</summary>
                  <template v-if="opened.has(`${chapter.scope.value}:vue`)">
                    <p>{{ VUE_REFERENCE_BOUNDARY }}</p>
                    <dl>
                      <template v-for="[name, description] in chapter.vue" :key="name"
                        ><dt>
                          <code>{{ name }}</code>
                        </dt>
                        <dd>{{ description }}</dd></template
                      >
                    </dl>
                    <pre><code>{{ vueReferenceExample(chapter) }}</code></pre>
                  </template>
                </details>
              </div>
            </section>
          </main>
        </div>
      </template>
      <footer v-if="loading || status || fullScreen" class="reference-footer">
        <span role="status">{{ loading ? '正在读取教程…' : status }}</span
        ><button
          v-if="fullScreen"
          type="button"
          class="appearance-action-hit"
          :disabled="busy"
          @click="transfer('both', true)"
        >
          <span class="appearance-action-face">一键复制</span>
        </button>
      </footer>
    </dialog>
  </Teleport>
</template>

<style scoped>
.appearance-code-help {
  display: grid;
  place-items: center;
  flex: 0 0 2.75rem;
  width: 2.75rem;
  min-height: 2.75rem;
  padding: 0;
  color: var(--color-ink-soft);
  background: transparent;
  border: 0;
  cursor: pointer;
}
.appearance-code-help svg,
.reference-icon svg {
  width: 1.25rem;
  height: 1.25rem;
}
.appearance-code-reference {
  top: var(--visual-viewport-offset-top, 0px);
  bottom: calc(
    100% - var(--visual-viewport-offset-top, 0px) - var(--visual-viewport-height, 100dvh)
  );
  width: min(34rem, calc(100vw - 2rem));
  max-width: calc(100vw - 2rem);
  max-height: calc(var(--visual-viewport-height, 100dvh) - 2rem);
  box-sizing: border-box;
  padding: 0;
  color: var(--color-ink);
  background: var(--dialog-background, var(--color-surface));
  border: 1px solid var(--dialog-border, var(--color-line));
  border-radius: var(--dialog-radius, var(--glass-radius-panel));
  box-shadow: var(--dialog-shadow, var(--glass-shadow));
  overflow: hidden;
  font-family: var(--font-body);
  font-size: var(--text-body);
  line-height: var(--line-body);
}
.appearance-code-reference[open] {
  display: flex;
  flex-direction: column;
}
.appearance-code-reference--full {
  width: 100vw;
  height: var(--visual-viewport-height, 100dvh);
  max-width: none;
  max-height: none;
  margin: 0;
  border: 0;
  border-radius: 0;
  background: var(--page-background, var(--color-surface-raised));
}
.appearance-code-reference::backdrop {
  background: var(--overlay-background);
}
.reference-header {
  display: flex;
  flex: none;
  align-items: center;
  gap: 0.375rem;
  position: relative;
  padding: max(0.375rem, var(--safe-top)) 0.5rem 0.375rem;
  border-bottom: 1px solid var(--color-line);
}
.reference-header h2 {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: var(--text-body);
  overflow-wrap: anywhere;
}
.appearance-code-reference button:not(.appearance-action-hit),
.appearance-code-reference select,
.appearance-code-reference input {
  font: inherit;
  color: var(--button-color, var(--color-ink));
  background: var(--button-background, var(--color-surface));
  border: 1px solid var(--button-border, var(--color-line));
  border-radius: var(--button-radius, var(--glass-radius-control));
}
.appearance-code-reference button:not(.appearance-action-hit) {
  cursor: pointer;
  min-height: 2.75rem;
  padding: 0.375rem 0.625rem;
}
.appearance-code-reference button:disabled {
  cursor: wait;
  opacity: 0.6;
}
.appearance-code-reference button.reference-icon {
  display: grid;
  place-items: center;
  flex: 0 0 2.5rem;
  min-height: 2.5rem;
  padding: 0;
  background: transparent;
  border-color: transparent;
}
.reference-choice {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.375rem;
  padding: 0.5rem 0.75rem;
}
.reference-choice svg {
  flex: none;
  width: 1.125rem;
  height: 1.125rem;
  color: var(--color-accent);
}
.reference-choice strong {
  font-size: var(--text-body);
  font-weight: var(--weight-title);
}
.reference-export {
  position: absolute;
  top: 100%;
  right: 0.5rem;
  z-index: 1;
  width: min(17rem, calc(100vw - 1rem));
  padding: 0.375rem;
  display: grid;
  gap: 0.25rem;
  background: var(--dialog-background, var(--color-surface));
  border: 1px solid var(--color-line);
  border-radius: var(--glass-radius-panel);
  box-shadow: var(--glass-shadow);
}
.reference-export button {
  text-align: left;
}
.reference-export .appearance-action-face {
  justify-content: flex-start;
}
.reference-search {
  display: flex;
  flex: none;
  align-items: center;
  gap: 0.5rem;
  margin: 0.25rem 0.75rem;
  font-size: var(--text-body);
  min-height: var(--size-touch);
}
.appearance-code-reference .reference-search input[type='search'] {
  flex: 1;
  width: 0;
  min-width: 0;
  height: 2.25rem;
  min-height: 2.25rem;
  padding: 0.25rem 0.5rem;
  font-size: var(--text-body);
  line-height: var(--line-body);
  border-radius: var(--control-radius, var(--glass-radius-control));
  background: var(--control-background, var(--color-surface));
  border-color: var(--control-border, var(--color-line));
}
.reference-app-list {
  overflow: auto;
  overscroll-behavior: contain;
  flex: 1;
  min-height: 0;
  padding: 0 0.75rem 0.5rem;
  display: flex;
  flex-direction: column;
}
.appearance-code-reference .reference-app-list button {
  flex: none;
  width: 100%;
  display: grid;
  grid-template-columns: 1.5rem minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.5rem;
  padding: 0.25rem 0.125rem;
  text-align: left;
  border: 0;
  border-bottom: 1px solid var(--color-line);
  border-radius: 0;
  background: transparent;
  font-size: var(--text-body);
}
.reference-app-list .reference-app-icon {
  grid-column: 1;
  display: grid;
  place-items: center;
  align-self: center;
  width: 1.5rem;
  height: 1.5rem;
  color: var(--color-accent);
}
.reference-app-icon :deep(svg) {
  width: 1.375rem;
  height: 1.375rem;
  stroke: currentColor;
  color: var(--color-accent);
  stroke-width: 2.5;
}
.reference-app-list strong {
  font-weight: var(--weight-ui);
  min-width: 0;
  overflow-wrap: anywhere;
}
.reference-app-list b {
  grid-column: 3;
  align-self: center;
}
.reference-workspace {
  flex: 1;
  min-height: 0;
  display: flex;
  position: relative;
}
.appearance-code-reference button.reference-navigation-handle {
  position: absolute;
  z-index: 4;
  top: 0.5rem;
  right: 0;
  display: flex;
  justify-content: flex-end;
  align-items: center;
  width: 2.75rem;
  height: 3.25rem;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
}
.reference-navigation-handle > span {
  display: grid;
  place-items: center;
  width: 1.5rem;
  height: 3rem;
  color: var(--color-accent);
  background: var(--dialog-background, var(--color-surface));
  border: 1px solid var(--dialog-border, var(--color-line));
  border-right: 0;
  border-radius: var(--control-radius, var(--glass-radius-control)) 0 0
    var(--control-radius, var(--glass-radius-control));
}
.reference-navigation-handle svg {
  width: 1rem;
  height: 1rem;
}
.appearance-code-reference button.reference-navigation-handle--open {
  right: min(calc(100vw - 2.75rem), 17rem);
}
.reference-navigation-handle--open svg {
  transform: rotate(180deg);
}
.reference-navigation {
  position: fixed;
  z-index: 3;
  inset: 0 0 0 auto;
  display: none;
  flex-direction: column;
  box-sizing: border-box;
  width: min(calc(100vw - 2.75rem), 17rem);
  min-height: 0;
  padding: var(--safe-top) 0.5rem var(--safe-bottom);
  border-left: 1px solid var(--dialog-border, var(--color-line));
  background: var(--dialog-background, var(--color-surface));
  box-shadow: var(--dialog-shadow, var(--glass-shadow));
}
.reference-navigation--open {
  display: flex;
}
.reference-navigation header {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  min-height: 2.25rem;
  padding-left: 0.5rem;
  border-bottom: 1px solid var(--color-line);
}
.reference-navigation-search {
  margin: 0.25rem 0;
}
.reference-navigation-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  padding-bottom: 0.5rem;
}
.reference-navigation section {
  padding: 0.25rem 0;
}
.appearance-code-reference .reference-navigation h3 {
  margin: 0.375rem 0 0.125rem;
  padding: 0 0.5rem;
  color: var(--color-ink-soft);
  font-size: var(--text-caption);
  font-weight: var(--weight-ui);
}
.appearance-code-reference .reference-navigation section button {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 2.75rem;
  padding: 0;
  text-align: left;
  border: 0;
  border-radius: 0;
  background: transparent;
}
.reference-navigation-face {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  box-sizing: border-box;
  width: 100%;
  min-height: 2rem;
  padding: 0.25rem 0.5rem;
  border-left: 2px solid transparent;
  border-radius: var(--control-radius, var(--glass-radius-control));
  font-size: var(--text-body);
  font-weight: var(--weight-ui);
}
.reference-navigation-face > span {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.reference-navigation-face :deep(svg) {
  flex: none;
  width: 1rem;
  height: 1rem;
  color: var(--color-ink-soft);
  stroke: currentColor;
}
.reference-navigation button:is(:hover, :focus-visible) .reference-navigation-face {
  background: var(--glass-panel-muted, var(--color-surface-raised));
}
.reference-navigation button[aria-current] .reference-navigation-face {
  color: var(--selection-color, var(--color-accent));
  background: var(--selection-background, var(--color-accent-soft));
  border-left-color: var(--selection-border, var(--color-accent));
  font-weight: var(--weight-title);
}
.reference-navigation button[aria-current] :deep(svg) {
  color: inherit;
}
.reference-content {
  flex: 1;
  min-width: 0;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 0.5rem 0.75rem 1rem;
  font-size: var(--text-body);
  line-height: var(--line-body);
}
.reference-instructions {
  border-bottom: 1px solid var(--color-line);
  color: var(--color-ink-soft);
}
.reference-instructions > summary {
  font-size: var(--text-caption);
}
.reference-variables-title {
  font-size: var(--text-body-strong);
}
.reference-chapter {
  border-bottom: 1px solid var(--color-line);
  scroll-margin-top: 0.5rem;
}
.reference-chapter > h3 {
  font-size: var(--text-body-strong);
  font-weight: var(--weight-title);
}
.reference-chapter-body {
  padding-bottom: 1rem;
}
.appearance-code-reference summary {
  cursor: pointer;
  padding: 0.625rem 0.25rem;
  overflow-wrap: anywhere;
}
.appearance-code-reference p {
  margin: 0.5rem 0;
}
.appearance-code-reference h3,
.appearance-code-reference h4 {
  margin: 0.875rem 0 0.375rem;
}
.appearance-code-reference code,
.appearance-code-reference pre {
  font-family: var(--font-code);
  overflow-wrap: anywhere;
}
.appearance-code-reference pre {
  white-space: pre-wrap;
  background: var(--control-background, var(--color-surface));
  padding: 0.625rem;
  border: 1px solid var(--color-line);
  border-radius: var(--glass-radius-control);
}
.reference-variable {
  margin: 0;
  border-bottom: 1px solid var(--color-line);
}
.reference-variable > summary {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 1rem;
  align-items: center;
  gap: 0.125rem 0.5rem;
  padding: 0.25rem 0.125rem;
  list-style: none;
  min-height: 2.75rem;
  box-sizing: border-box;
}
.reference-variable > summary::-webkit-details-marker {
  display: none;
}
.reference-variable > summary::after {
  content: '›';
  grid-column: 3;
  grid-row: 1 / 3;
  font-size: 1.25rem;
  color: var(--color-accent);
  justify-self: center;
}
.reference-variable[open] > summary::after {
  transform: rotate(90deg);
}
.reference-variable > summary code {
  font-size: 0.8125rem;
  font-weight: var(--weight-title);
  color: var(--color-accent);
}
.reference-variable > summary span {
  display: block;
  font-size: var(--text-caption);
  color: var(--color-ink-soft);
}
.reference-variable ul {
  padding: 0 0.75rem 0 1.75rem;
}
.reference-variable li {
  margin: 0.625rem 0;
}
.reference-variable small {
  display: block;
  color: var(--color-ink-soft);
}
.reference-selectors,
.reference-vue {
  margin-top: 0.75rem;
  padding: 0.25rem 0.5rem;
  background: var(--glass-panel-muted, var(--color-surface));
  border-radius: var(--glass-radius-control);
}
.reference-vue dt {
  margin-top: 0.75rem;
}
.reference-vue dd {
  margin: 0.25rem 0 0.5rem;
  color: var(--color-ink-soft);
}
.reference-footer {
  display: flex;
  flex: none;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.75rem max(0.375rem, var(--safe-bottom));
  border-top: 1px solid var(--color-line);
}
.reference-footer span {
  flex: 1;
  font-size: var(--text-caption);
  overflow-wrap: anywhere;
}
@media (max-width: 360px) {
  .reference-choice svg {
    display: none;
  }
}
@media (max-width: 560px) {
  .reference-variable > summary {
    grid-template-columns: minmax(0, 1fr) 1rem;
  }
  .reference-variable > summary::after {
    grid-column: 2;
  }
  .reference-variable > summary span {
    grid-column: 1;
  }
}
</style>
