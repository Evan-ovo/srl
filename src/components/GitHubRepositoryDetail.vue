<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'

import type { GitHubResourceInspection } from '../services/GitHubResourceInspector'
import type { ResourceLink } from '../types/Resource'
import FeatureBackButton from './FeatureBackButton.vue'
import GitHubReadmeViewer from './GitHubReadmeViewer.vue'

const props = defineProps<{
  link: ResourceLink
  inspection: GitHubResourceInspection
}>()
const emit = defineEmits<{ close: [] }>()

const navigationOpen = ref(false)
const readmeOpen = ref(false)
const sections = computed(() => [
  { id: 'github-detail-overview', label: '仓库概览', note: props.inspection.fullName },
  {
    id: 'github-detail-readme',
    label: 'README',
    note: props.inspection.readmeHeadings.length
      ? `${props.inspection.readmeHeadings.length} 个章节`
      : '未找到目录',
  },
  {
    id: 'github-detail-release',
    label: '发布版本',
    note: props.inspection.latestRelease?.tagName || '没有公开 Release',
  },
  {
    id: 'github-detail-compatibility',
    label: '兼容性',
    note: props.inspection.manifest?.version || '没有 manifest',
  },
])

function formatDate(value: string): string {
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return value
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(timestamp)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

async function navigateTo(id: string): Promise<void> {
  navigationOpen.value = false
  await nextTick()
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
</script>

<template>
  <Teleport to="body">
    <div class="github-repository-detail-overlay" role="presentation">
      <article
        class="github-repository-detail"
        role="dialog"
        aria-modal="true"
        aria-labelledby="github-repository-detail-title"
      >
        <header class="github-repository-detail__header">
          <FeatureBackButton label="返回资源详情" @click="emit('close')" />
          <div>
            <small>GITHUB RESOURCE</small>
            <h2 id="github-repository-detail-title">{{ inspection.name }}</h2>
            <p>{{ inspection.fullName }}</p>
          </div>
        </header>

        <main class="github-repository-detail__content">
          <section id="github-detail-overview" class="github-repository-detail__section">
            <p class="github-repository-detail__eyebrow">仓库概览</p>
            <h3>
              {{ inspection.summary || inspection.repositoryDescription || '仓库未提供说明' }}
            </h3>
            <div class="github-repository-detail__facts">
              <dl>
                <dt>作者</dt>
                <dd>{{ inspection.manifest?.author || inspection.author || '未注明' }}</dd>
              </dl>
              <dl v-if="inspection.manifest?.version">
                <dt>版本</dt>
                <dd>{{ inspection.manifest.version }}</dd>
              </dl>
              <dl v-if="inspection.license">
                <dt>许可证</dt>
                <dd>{{ inspection.license }}</dd>
              </dl>
              <dl v-if="inspection.updatedAt">
                <dt>最近更新</dt>
                <dd>{{ formatDate(inspection.updatedAt) }}</dd>
              </dl>
            </div>
            <div v-if="inspection.topics.length" class="github-repository-detail__topics">
              <span v-for="topic in inspection.topics" :key="topic">#{{ topic }}</span>
            </div>
            <a
              class="github-repository-detail__repository-link"
              :href="link.url"
              target="_blank"
              rel="noopener noreferrer"
              >打开原仓库 ↗</a
            >
            <p v-if="inspection.warning" class="github-repository-detail__notice">
              {{ inspection.warning }}
            </p>
          </section>

          <section id="github-detail-readme" class="github-repository-detail__section">
            <div class="github-repository-detail__section-heading">
              <div>
                <p class="github-repository-detail__eyebrow">README</p>
                <h3>从公开 README 提取的内容</h3>
              </div>
              <button
                v-if="inspection.evidence.includes('README')"
                type="button"
                @click="readmeOpen = true"
              >
                阅读完整 README
              </button>
            </div>
            <p v-if="inspection.readmeExcerpt" class="github-repository-detail__excerpt">
              {{ inspection.readmeExcerpt }}
            </p>
            <ol v-if="inspection.readmeHeadings.length" class="github-repository-detail__headings">
              <li v-for="heading in inspection.readmeHeadings" :key="heading">{{ heading }}</li>
            </ol>
            <p v-else class="github-repository-detail__empty">此仓库没有可显示的 README 章节。</p>
          </section>

          <section id="github-detail-release" class="github-repository-detail__section">
            <p class="github-repository-detail__eyebrow">发布版本</p>
            <template v-if="inspection.latestRelease">
              <h3>{{ inspection.latestRelease.name }}</h3>
              <p class="github-repository-detail__release-meta">
                {{ inspection.latestRelease.tagName }}
                <template v-if="inspection.latestRelease.publishedAt">
                  · {{ formatDate(inspection.latestRelease.publishedAt) }}</template
                >
                <template v-if="inspection.latestRelease.prerelease"> · 预发布</template>
              </p>
              <div
                v-if="inspection.latestRelease.assets.length"
                class="github-repository-detail__assets"
              >
                <a
                  v-for="asset in inspection.latestRelease.assets"
                  :key="asset.downloadUrl"
                  :href="asset.downloadUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <span>{{ asset.name }}</span
                  ><small>{{ formatBytes(asset.size) }} ↗</small>
                </a>
              </div>
            </template>
            <p v-else class="github-repository-detail__empty">这个仓库没有可读取的公开 Release。</p>
          </section>

          <section id="github-detail-compatibility" class="github-repository-detail__section">
            <p class="github-repository-detail__eyebrow">兼容性</p>
            <template v-if="inspection.manifest">
              <h3>{{ inspection.manifest.displayName }}</h3>
              <p v-if="inspection.manifest.description" class="github-repository-detail__excerpt">
                {{ inspection.manifest.description }}
              </p>
              <dl class="github-repository-detail__compatibility">
                <div v-if="inspection.manifest.minimumClientVersion">
                  <dt>最低客户端版本</dt>
                  <dd>{{ inspection.manifest.minimumClientVersion }}</dd>
                </div>
                <div v-if="inspection.manifest.requires.length">
                  <dt>必需依赖</dt>
                  <dd>{{ inspection.manifest.requires.join('、') }}</dd>
                </div>
                <div v-if="inspection.manifest.optional.length">
                  <dt>可选依赖</dt>
                  <dd>{{ inspection.manifest.optional.join('、') }}</dd>
                </div>
              </dl>
            </template>
            <p v-else class="github-repository-detail__empty">
              未发现可识别的资源 manifest；请在原仓库核对安装要求。
            </p>
          </section>
          <footer>
            仅展示公开仓库元数据、README、manifest 与 Release；不会执行代码或下载文件。
          </footer>
        </main>
      </article>

      <button
        class="github-repository-detail__nav-handle"
        :class="{ 'is-open': navigationOpen }"
        type="button"
        :aria-label="navigationOpen ? '收起仓库导航' : '展开仓库导航'"
        @click="navigationOpen = !navigationOpen"
      >
        {{ navigationOpen ? '›' : '‹' }}
      </button>
      <button
        v-if="navigationOpen"
        class="github-repository-detail__nav-backdrop"
        type="button"
        aria-label="关闭仓库导航"
        @click="navigationOpen = false"
      ></button>
      <aside
        class="github-repository-detail__nav"
        :class="{ 'is-open': navigationOpen }"
        :aria-hidden="!navigationOpen"
        aria-label="仓库详情导航"
      >
        <header>
          <span
            ><strong>仓库导航</strong><small>{{ inspection.fullName }}</small></span
          >
          <button type="button" aria-label="关闭仓库导航" @click="navigationOpen = false">×</button>
        </header>
        <button
          v-for="section in sections"
          :key="section.id"
          type="button"
          @click="navigateTo(section.id)"
        >
          <strong>{{ section.label }}</strong
          ><span>{{ section.note }}</span>
        </button>
      </aside>
    </div>
    <GitHubReadmeViewer
      v-if="readmeOpen"
      :link="link"
      :title="inspection.name"
      :default-branch="inspection.defaultBranch"
      @close="readmeOpen = false"
    />
  </Teleport>
</template>

<style scoped>
.github-repository-detail-overlay {
  position: fixed;
  z-index: 1180;
  inset: 0;
  background: var(--color-surface);
}
.github-repository-detail {
  height: var(--app-viewport-height, 100vh);
  overflow-y: auto;
  overscroll-behavior: contain;
  color: var(--color-ink);
}
.github-repository-detail__header {
  position: sticky;
  z-index: 2;
  top: 0;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 1rem;
  padding: max(1rem, var(--safe-top)) max(1.25rem, var(--safe-right)) 0.875rem
    max(1.25rem, var(--safe-left));
  border-bottom: 1px solid var(--color-line);
  background: color-mix(in srgb, var(--color-surface) 96%, transparent);
  backdrop-filter: blur(0.75rem);
}
.github-repository-detail__header small,
.github-repository-detail__eyebrow {
  color: var(--color-ink-soft);
  font-size: 0.625rem;
  font-weight: 800;
  letter-spacing: 0.1em;
}
.github-repository-detail__header h2,
.github-repository-detail__header p {
  margin: 0;
}
.github-repository-detail__header h2 {
  margin-top: 0.15rem;
  font-size: 1.05rem;
  overflow-wrap: anywhere;
}
.github-repository-detail__header p {
  margin-top: 0.25rem;
  color: var(--color-ink-soft);
  font-size: 0.7rem;
}
.github-repository-detail__content {
  width: min(48rem, 100%);
  margin: 0 auto;
  padding: 1.5rem max(1.25rem, var(--safe-right)) 3rem max(1.25rem, var(--safe-left));
}
.github-repository-detail__section {
  scroll-margin-top: 5.5rem;
  padding: 1.5rem 0;
  border-bottom: 1px solid var(--color-line);
}
.github-repository-detail__section:first-child {
  padding-top: 0;
}
.github-repository-detail__section h3 {
  margin: 0.3rem 0 0;
  font-size: 1.05rem;
  line-height: 1.45;
}
.github-repository-detail__facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.8rem;
  margin-top: 1.25rem;
}
.github-repository-detail__facts dl {
  margin: 0;
}
.github-repository-detail__facts dt,
.github-repository-detail__compatibility dt {
  color: var(--color-ink-soft);
  font-size: 0.675rem;
}
.github-repository-detail__facts dd,
.github-repository-detail__compatibility dd {
  margin: 0.2rem 0 0;
  overflow-wrap: anywhere;
  font-size: 0.8rem;
}
.github-repository-detail__topics {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  margin-top: 1rem;
}
.github-repository-detail__topics span {
  padding: 0.2rem 0.45rem;
  border-radius: 999px;
  background: var(--color-accent-soft);
  font-size: 0.65rem;
}
.github-repository-detail__repository-link {
  display: inline-flex;
  margin-top: 1rem;
  color: var(--color-accent);
  font-size: 0.75rem;
  font-weight: 750;
  text-decoration: none;
}
.github-repository-detail__repository-link:hover {
  text-decoration: underline;
}
.github-repository-detail__notice,
.github-repository-detail__empty {
  margin: 1rem 0 0;
  color: var(--color-ink-soft);
  font-size: 0.8rem;
  line-height: 1.6;
}
.github-repository-detail__notice {
  padding: 0.65rem 0.75rem;
  border-left: 0.1875rem solid var(--color-danger);
  background: color-mix(in srgb, var(--color-danger) 7%, transparent);
  color: var(--color-danger);
}
.github-repository-detail__section-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}
.github-repository-detail__section-heading button {
  flex: none;
  min-height: 2.125rem;
  padding: 0 0.65rem;
  font-size: 0.7rem;
  font-weight: 750;
}
.github-repository-detail__excerpt,
.github-repository-detail__release-meta {
  margin: 0.8rem 0 0;
  color: var(--color-ink-soft);
  font-size: 0.82rem;
  line-height: 1.65;
}
.github-repository-detail__headings {
  display: grid;
  gap: 0.4rem;
  margin: 1rem 0 0;
  padding-left: 1.25rem;
  font-size: 0.8rem;
  line-height: 1.5;
}
.github-repository-detail__assets {
  display: grid;
  gap: 0.4rem;
  margin-top: 1rem;
}
.github-repository-detail__assets a {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.6rem 0.7rem;
  border: 1px solid var(--color-line);
  border-radius: 0.35rem;
  color: var(--color-ink);
  font-size: 0.76rem;
  text-decoration: none;
}
.github-repository-detail__assets a:hover {
  border-color: var(--color-accent);
  background: var(--color-accent-soft);
}
.github-repository-detail__assets span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.github-repository-detail__assets small {
  flex: none;
  color: var(--color-ink-soft);
}
.github-repository-detail__compatibility {
  display: grid;
  gap: 0.8rem;
  margin: 1rem 0 0;
}
.github-repository-detail__compatibility div {
  padding-left: 0.75rem;
  border-left: 0.15rem solid var(--color-line-strong);
}
.github-repository-detail footer {
  padding-top: 1rem;
  color: var(--color-ink-soft);
  font-size: 0.68rem;
  line-height: 1.55;
}
.github-repository-detail__nav-handle {
  position: fixed;
  z-index: 4;
  top: 50%;
  right: 0;
  width: 1.9rem;
  height: 3.25rem;
  transform: translateY(-50%);
  border: 1px solid var(--color-line-strong);
  border-right: 0;
  border-radius: 0.5rem 0 0 0.5rem;
  background: var(--color-surface);
  color: var(--color-ink-soft);
  font-size: 1.15rem;
}
.github-repository-detail__nav-handle.is-open {
  right: min(20rem, 85vw);
}
.github-repository-detail__nav-backdrop {
  position: fixed;
  z-index: 2;
  inset: 0;
  border: 0;
  background: var(--overlay-background);
}
.github-repository-detail__nav {
  position: fixed;
  z-index: 3;
  inset: 0 0 0 auto;
  width: min(20rem, 85vw);
  padding: max(1rem, var(--safe-top)) 0 max(1rem, var(--safe-bottom));
  overflow-y: auto;
  transform: translateX(100%);
  border-left: 1px solid var(--color-line);
  background: var(--color-surface);
  box-shadow: var(--dialog-shadow, var(--glass-shadow));
  transition: transform 160ms ease;
}
.github-repository-detail__nav.is-open {
  transform: translateX(0);
}
.github-repository-detail__nav header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  padding: 0 1rem 0.8rem;
  border-bottom: 1px solid var(--color-line);
}
.github-repository-detail__nav header strong,
.github-repository-detail__nav header small {
  display: block;
}
.github-repository-detail__nav header strong {
  font-size: 0.82rem;
}
.github-repository-detail__nav header small {
  margin-top: 0.2rem;
  color: var(--color-ink-soft);
  font-size: 0.65rem;
}
.github-repository-detail__nav header button {
  border: 0;
  background: var(--button-background, transparent);
  color: var(--button-color, var(--color-ink-soft));
  font-size: 1.2rem;
}
.github-repository-detail__nav > button {
  display: grid;
  width: 100%;
  gap: 0.25rem;
  padding: 0.8rem 1rem;
  border: 0;
  border-bottom: 1px solid var(--color-line);
  background: var(--button-background, transparent);
  color: var(--button-color, var(--color-ink));
  text-align: left;
}
.github-repository-detail__nav > button:hover {
  background: var(--button-background, var(--color-accent-soft));
}
.github-repository-detail__nav > button strong {
  font-size: 0.76rem;
}
.github-repository-detail__nav > button span {
  overflow: hidden;
  color: var(--color-ink-soft);
  font-size: 0.65rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@media (max-width: 32rem) {
  .github-repository-detail__header {
    padding-left: 1rem;
  }
  .github-repository-detail__content {
    padding: 1.1rem 1rem 2.5rem;
  }
  .github-repository-detail__facts {
    grid-template-columns: 1fr;
  }
  .github-repository-detail__section-heading {
    display: grid;
  }
  .github-repository-detail__section-heading button {
    justify-self: start;
  }
}
</style>
