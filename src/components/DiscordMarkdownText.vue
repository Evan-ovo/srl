<script setup lang="ts">
import { computed } from 'vue'

import { parseDiscordMarkdown } from '../utils/DiscordMessagePresentation'

const props = defineProps<{ content: string }>()
const blocks = computed(() => parseDiscordMarkdown(props.content))
</script>

<template>
  <div class="discord-markdown">
    <template v-for="(block, blockIndex) in blocks" :key="blockIndex">
      <pre v-if="block.type === 'code-block'" class="discord-markdown__code-block"><small
          v-if="block.language"
          >{{ block.language }}</small
        ><code>{{ block.code }}</code></pre>
      <div
        v-else
        class="discord-markdown__line"
        :class="[
          `discord-markdown__line--${block.kind}`,
          block.level ? `discord-markdown__line--heading-${block.level}` : '',
        ]"
      >
        <span v-if="block.kind === 'list-item'" class="discord-markdown__marker">
          {{ /^\d/u.test(block.marker ?? '') ? block.marker : '•' }}
        </span>
        <span class="discord-markdown__content">
          <template v-for="(token, tokenIndex) in block.tokens" :key="tokenIndex">
            <a
              v-if="token.href"
              :class="[
                { 'is-discord-message': token.discordMessage },
                ...token.marks.map((mark) => `is-${mark}`),
              ]"
              :href="token.href"
              target="_blank"
              rel="noopener noreferrer"
            >
              {{ token.text }}<template v-if="token.discordMessage"> ↗</template>
            </a>
            <code v-else-if="token.marks.includes('code')" class="discord-markdown__inline-code">
              {{ token.text }}
            </code>
            <span v-else :class="token.marks.map((mark) => `is-${mark}`)">{{ token.text }}</span>
          </template>
        </span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.discord-markdown {
  display: grid;
  gap: 0.2em;
  min-width: 0;
}

.discord-markdown__line {
  min-width: 0;
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.discord-markdown__line--blank {
  min-height: 0.65em;
}

.discord-markdown__line--heading {
  margin: 0.2em 0 0.05em;
  font-weight: 850;
  line-height: 1.35;
}

.discord-markdown__line--heading-1 {
  font-size: 1.2em;
}

.discord-markdown__line--heading-2 {
  font-size: 1.12em;
}

.discord-markdown__line--heading-3 {
  font-size: 1.05em;
}

.discord-markdown__line--quote {
  padding-left: 0.7em;
  border-left: 3px solid color-mix(in srgb, currentColor 25%, transparent);
}

.discord-markdown__line--list-item {
  display: grid;
  grid-template-columns: 1.6em minmax(0, 1fr);
  align-items: start;
}

.discord-markdown__content {
  min-width: 0;
}

.discord-markdown__marker {
  color: var(--color-ink-soft, #71878e);
  font-variant-numeric: tabular-nums;
}

.discord-markdown__code-block {
  display: grid;
  gap: 0.35em;
  max-width: 100%;
  margin: 0.35em 0;
  padding: 0.7em 0.8em;
  overflow-x: auto;
  border: 1px solid var(--color-line, #d7e3e5);
  border-radius: 8px;
  background: color-mix(in srgb, var(--glass-panel-muted) 82%, transparent);
  white-space: pre;
}

.discord-markdown__code-block small {
  color: var(--color-ink-soft, #71878e);
  font-family: inherit;
}

.discord-markdown__code-block code,
.discord-markdown__inline-code {
  font-family: ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace;
}

.discord-markdown__inline-code {
  padding: 0.08em 0.28em;
  border-radius: 4px;
  background: color-mix(in srgb, var(--glass-panel-muted) 88%, transparent);
}

.discord-markdown a {
  color: var(--color-accent, #397888);
  font-weight: 760;
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, currentColor 28%, transparent);
  text-underline-offset: 3px;
}

.discord-markdown a.is-discord-message {
  color: var(--color-accent);
}

.is-bold {
  font-weight: 850;
}

.is-italic {
  font-style: italic;
}

.is-underline {
  text-decoration: underline;
}

.is-strike {
  text-decoration: line-through;
}

.is-spoiler {
  padding: 0 0.15em;
  border-radius: 3px;
  background: color-mix(in srgb, currentColor 12%, transparent);
}
</style>
