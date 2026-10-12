<script setup lang="ts">
import createDOMPurify from 'dompurify'
import showdown from 'showdown'
import { computed, onMounted, ref } from 'vue'

import { usePreviewPolicy } from '../composables/UsePreviewPolicy'
import type { ResourceLink } from '../types/Resource'

const props = defineProps<{
  link: ResourceLink
  title: string
  defaultBranch: string
}>()
const emit = defineEmits<{ close: [] }>()

const markdown = ref('')
const reference = ref('')
const readmeRef = ref('')
const busy = ref(true)
const error = ref('')
const view = ref<'rendered' | 'source'>('rendered')
const previewPolicy = usePreviewPolicy()
const remoteImagesEnabled = computed(() => previewPolicy.value.allowRemoteResources)

const markdownConverter = new showdown.Converter({
  tables: true,
  strikethrough: true,
  tasklists: true,
  simpleLineBreaks: false,
})

const renderedMarkdown = computed(() => createSafeMarkdownHtml(markdown.value))

function createSafeMarkdownHtml(source: string): string {
  if (!source || typeof document === 'undefined') return ''
  const purifier = createDOMPurify(window)
  const fragment = purifier.sanitize(markdownConverter.makeHtml(source), {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: [
      'a',
      'blockquote',
      'br',
      'code',
      'del',
      'details',
      'div',
      'em',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'hr',
      ...(remoteImagesEnabled.value ? ['img'] : []),
      'input',
      'li',
      'ol',
      'p',
      'pre',
      'span',
      'strong',
      'summary',
      'table',
      'tbody',
      'td',
      'th',
      'thead',
      'tr',
      'ul',
    ],
    ALLOWED_ATTR: [
      'checked',
      'colspan',
      'href',
      'open',
      'rowspan',
      'start',
      'type',
      ...(remoteImagesEnabled.value ? ['alt', 'height', 'src', 'width'] : []),
    ],
  }) as DocumentFragment
  fragment.querySelectorAll('a').forEach((link) => {
    const href = link.getAttribute('href')?.trim() ?? ''
    if (href && !href.startsWith('#')) {
      try {
        const github = props.link.github
        const base = github
          ? `https://github.com/${encodeURIComponent(github.owner)}/${encodeURIComponent(
              github.repo,
            )}/blob/${encodeURIComponent(readmeRef.value)}/`
          : undefined
        const resolved = base ? new URL(href, base) : new URL(href)
        if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:') {
          link.removeAttribute('href')
        } else {
          link.setAttribute('href', resolved.toString())
        }
      } catch {
        link.removeAttribute('href')
      }
    }
    link.setAttribute('target', '_blank')
    link.setAttribute('rel', 'noopener noreferrer')
  })
  fragment.querySelectorAll('img').forEach((image) => {
    const source = image.getAttribute('src')?.trim() ?? ''
    const github = props.link.github
    if (!source || !github || !readmeRef.value) {
      image.remove()
      return
    }
    try {
      const base = `https://raw.githubusercontent.com/${encodeURIComponent(
        github.owner,
      )}/${encodeURIComponent(github.repo)}/${encodeURIComponent(readmeRef.value)}/`
      const resolved = new URL(source, base)
      if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:') {
        image.remove()
        return
      }
      image.setAttribute('src', resolved.toString())
      image.setAttribute('loading', 'lazy')
      image.setAttribute('decoding', 'async')
      image.setAttribute('referrerpolicy', 'no-referrer')
    } catch {
      image.remove()
    }
  })
  const container = document.createElement('div')
  container.append(fragment)
  return container.innerHTML
}

onMounted(async () => {
  try {
    const { readGitHubReadme } = await import('../services/GitHubResourceInspector')
    const document = await readGitHubReadme(props.link, props.defaultBranch)
    if (!document) {
      error.value = '没有找到可读取的 README.md。'
      return
    }
    markdown.value = document.markdown
    reference.value = `${document.ref} · ${document.fileName}`
    readmeRef.value = document.ref
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'README 暂时无法读取。'
  } finally {
    busy.value = false
  }
})
</script>

<template>
  <Teleport to="body">
    <div class="github-readme-viewer__overlay" role="presentation" @click.self="emit('close')">
      <article
        class="github-readme-viewer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="github-readme-viewer-title"
      >
        <header class="github-readme-viewer__header">
          <div>
            <small>GITHUB README</small>
            <h2 id="github-readme-viewer-title">{{ title }}</h2>
            <p>{{ reference || '正在定位公开 README…' }}</p>
          </div>
          <button type="button" aria-label="关闭 README 阅读页" @click="emit('close')">×</button>
        </header>

        <div class="github-readme-viewer__toolbar">
          <div
            v-if="markdown"
            class="github-readme-viewer__toolbar-controls"
            role="group"
            aria-label="README 查看方式"
          >
            <button
              type="button"
              :class="{ 'is-active': view === 'rendered' }"
              @click="view = 'rendered'"
            >
              阅读
            </button>
            <button
              type="button"
              :class="{ 'is-active': view === 'source' }"
              @click="view = 'source'"
            >
              原文
            </button>
          </div>
          <a
            class="github-readme-viewer__repository-link"
            :href="link.url"
            target="_blank"
            rel="noopener noreferrer"
          >
            原仓库 ↗
          </a>
        </div>

        <p v-if="busy" class="github-readme-viewer__status">正在读取完整 README…</p>
        <p v-else-if="error" class="github-readme-viewer__notice" role="status">{{ error }}</p>
        <template v-else>
          <section v-if="view === 'rendered'" class="github-readme-viewer__document">
            <p v-if="!remoteImagesEnabled" class="github-readme-viewer__media-notice">
              README 中的远程图片已按当前设置隐藏；在“设置 → HTML / CSS
              预览安全”开启“允许远程资源”后会加载。
            </p>
            <!-- HTML is produced from Markdown and passed through the allowlist sanitizer above. -->
            <!-- eslint-disable-next-line vue/no-v-html -->
            <div v-html="renderedMarkdown"></div>
          </section>
          <pre v-else class="github-readme-viewer__source"><code>{{ markdown }}</code></pre>
        </template>

        <footer>
          <template v-if="remoteImagesEnabled">
            远程图片已按全局预览设置加载；仓库 HTML 与可执行内容仍不会执行。
          </template>
          <template v-else
            >仅读取公开 README；远程图片、仓库 HTML 与可执行内容不会加载或执行。</template
          >
        </footer>
      </article>
    </div>
  </Teleport>
</template>

<style scoped>
.github-readme-viewer__overlay {
  position: fixed;
  z-index: 1180;
  inset: 0;
  display: grid;
  place-items: center;
  padding: max(1rem, var(--safe-top)) max(1rem, var(--safe-right)) max(1rem, var(--safe-bottom))
    max(1rem, var(--safe-left));
  background: var(--overlay-background);
  backdrop-filter: blur(3px);
}

.github-readme-viewer {
  width: min(50rem, 100%);
  max-height: calc(var(--app-viewport-height, 100vh) - 2rem);
  overflow-y: auto;
  overscroll-behavior: contain;
  border: 1px solid var(--dialog-border, var(--glass-border));
  border-radius: var(--dialog-radius, var(--glass-radius-panel));
  background: var(--dialog-background);
  box-shadow: var(--dialog-shadow, var(--glass-shadow));
}

.github-readme-viewer__header {
  position: sticky;
  z-index: 1;
  top: 0;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 1rem 1.125rem 0.875rem;
  border-bottom: 1px solid var(--color-line);
  background: color-mix(in srgb, var(--color-surface) 96%, transparent);
  backdrop-filter: blur(0.75rem);
}

.github-readme-viewer__header small {
  color: var(--color-ink-soft);
  font-size: 0.625rem;
  font-weight: 800;
  letter-spacing: 0.12em;
}

.github-readme-viewer__header h2 {
  margin: 0.15rem 0;
  color: var(--color-ink);
  font-size: 1rem;
}

.github-readme-viewer__header p {
  margin: 0;
  color: var(--color-ink-soft);
  font-size: 0.6875rem;
}

.github-readme-viewer__header > button {
  width: 2rem;
  height: 2rem;
  flex: none;
  border: 0;
  border-radius: var(--button-radius, 50%);
  background: var(--button-background, transparent);
  color: var(--button-color, var(--color-ink-soft));
  font-size: 1.25rem;
}

.github-readme-viewer__toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-start;
  gap: 0.375rem;
  padding: 0.5rem 1.125rem;
  border-bottom: 1px solid var(--color-line);
}

.github-readme-viewer__toolbar-controls {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 0.125rem;
  padding: 0.125rem;
  border: 1px solid var(--color-line);
  border-radius: 0.375rem;
}

.github-readme-viewer__toolbar button,
.github-readme-viewer__repository-link {
  min-height: 1.875rem;
  padding: 0 0.5625rem;
  border: 0;
  border-radius: var(--button-radius, 0.25rem);
  background: var(--button-background, transparent);
  color: var(--button-color, var(--color-ink-soft));
  font-size: 0.6875rem;
  font-weight: 750;
  text-decoration: none;
}

.github-readme-viewer__toolbar button.is-active {
  background: var(--selection-background, var(--color-accent-soft));
  color: var(--selection-color, var(--color-ink));
}

.github-readme-viewer__toolbar button:disabled {
  cursor: wait;
  opacity: 0.58;
}

.github-readme-viewer__toolbar button.is-stop {
  color: var(--color-danger);
}

.github-readme-viewer__repository-link {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--color-line);
  color: var(--color-ink);
}

.github-readme-viewer__repository-link:hover {
  border-color: var(--color-accent);
  background: var(--color-accent-soft);
}

.github-readme-viewer__status,
.github-readme-viewer__notice {
  margin: 1rem 1.125rem;
  padding: 0.75rem;
  border: 1px solid var(--color-line);
  border-radius: 0.375rem;
  color: var(--color-ink-soft);
  font-size: 0.75rem;
}

.github-readme-viewer__media-notice {
  margin: 0 0 1rem;
  padding: 0.625rem 0.75rem;
  border-left: 0.1875rem solid var(--color-line-strong);
  background: color-mix(in srgb, var(--color-accent-soft) 48%, transparent);
  color: var(--color-ink-soft);
  font-size: 0.75rem;
  line-height: 1.55;
}

.github-readme-viewer__notice {
  border-color: color-mix(in srgb, var(--color-danger) 32%, var(--color-line));
  color: var(--color-danger);
}

.github-readme-viewer__document,
.github-readme-viewer__source {
  margin: 0;
  padding: 1.25rem 1.125rem 1.5rem;
  color: var(--color-ink);
  font-size: 0.875rem;
  line-height: 1.72;
}

.github-readme-viewer__document :deep(h1),
.github-readme-viewer__document :deep(h2),
.github-readme-viewer__document :deep(h3),
.github-readme-viewer__document :deep(h4) {
  margin: 1.6em 0 0.65em;
  color: var(--color-ink);
  line-height: 1.3;
}

.github-readme-viewer__document :deep(h1) {
  margin-top: 0;
  font-size: 1.45rem;
}

.github-readme-viewer__document :deep(h2) {
  padding-bottom: 0.35em;
  border-bottom: 1px solid var(--color-line);
  font-size: 1.15rem;
}

.github-readme-viewer__document :deep(p),
.github-readme-viewer__document :deep(ul),
.github-readme-viewer__document :deep(ol) {
  margin: 0.75em 0;
}

.github-readme-viewer__document :deep(li + li) {
  margin-top: 0.25em;
}

.github-readme-viewer__document :deep(a) {
  color: var(--color-accent);
  font-weight: 700;
  text-decoration: underline;
  text-underline-offset: 0.18em;
}

.github-readme-viewer__document :deep(pre),
.github-readme-viewer__source {
  overflow-x: auto;
  border: 1px solid var(--color-line);
  border-radius: 0.5rem;
  background: color-mix(in srgb, var(--color-accent-soft) 45%, transparent);
  font-family: ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace;
  font-size: 0.75rem;
  line-height: 1.55;
  white-space: pre;
}

.github-readme-viewer__document :deep(pre) {
  padding: 0.875rem;
}

.github-readme-viewer__document :deep(code:not(pre code)) {
  padding: 0.08em 0.28em;
  border-radius: 0.2rem;
  background: var(--color-accent-soft);
  font-family: ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace;
  font-size: 0.9em;
}

.github-readme-viewer__document :deep(blockquote) {
  margin: 1em 0;
  padding-left: 0.875rem;
  border-left: 0.2rem solid var(--color-line-strong);
  color: var(--color-ink-soft);
}

.github-readme-viewer__document :deep(img) {
  display: block;
  max-width: 100%;
  height: auto;
  margin: 1rem auto;
  border: 1px solid var(--color-line);
  border-radius: 0.5rem;
  background: var(--color-accent-soft);
}

.github-readme-viewer__document :deep(table) {
  width: 100%;
  margin: 1em 0;
  border-collapse: collapse;
  font-size: 0.8rem;
}

.github-readme-viewer__document :deep(th),
.github-readme-viewer__document :deep(td) {
  padding: 0.5rem;
  border: 1px solid var(--color-line);
  text-align: left;
  vertical-align: top;
}

.github-readme-viewer__document :deep(input[type='checkbox']) {
  margin-right: 0.4rem;
}

.github-readme-viewer footer {
  padding: 0.75rem 1.125rem 1rem;
  border-top: 1px solid var(--color-line);
  color: var(--color-ink-soft);
  font-size: 0.6875rem;
  line-height: 1.55;
}

@media (max-width: 28rem) {
  .github-readme-viewer__overlay {
    padding: 0;
  }

  .github-readme-viewer {
    max-height: var(--app-viewport-height, 100vh);
    border-radius: var(--dialog-radius, var(--glass-radius-panel));
  }

  .github-readme-viewer__toolbar {
    align-items: flex-start;
    gap: 0.5rem;
  }
}
</style>
