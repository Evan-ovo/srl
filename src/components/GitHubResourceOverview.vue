<script setup lang="ts">
import { ref, watch } from 'vue'
import type { GitHubResourceInspection } from '../services/GitHubResourceInspector'
import type { ResourceLink } from '../types/Resource'
import GitHubRepositoryDetail from './GitHubRepositoryDetail.vue'

const props = defineProps<{ link: ResourceLink }>()
const inspection = ref<GitHubResourceInspection>()
const busy = ref(false)
const open = ref(false)
const detailOpen = ref(false)
const error = ref('')
let revision = 0

watch(
  () => props.link.url,
  () => {
    revision++
    inspection.value = undefined
    open.value = false
    busy.value = false
    detailOpen.value = false
  },
)

async function inspect(): Promise<void> {
  open.value = !open.value
  if (!open.value || inspection.value || busy.value) return
  busy.value = true
  error.value = ''
  const current = revision
  try {
    const { inspectGitHubResource } = await import('../services/GitHubResourceInspector')
    const result = await inspectGitHubResource(props.link)
    if (revision === current) inspection.value = result
  } catch {
    if (revision === current) error.value = '暂时无法读取，可打开原仓库查看；稍后点击重试。'
  } finally {
    if (revision === current) busy.value = false
  }
}
</script>

<template>
  <div class="github-resource-overview">
    <button class="github-resource-overview__trigger" type="button" @click="inspect">
      {{ open ? '收起仓库信息' : '提取仓库信息' }}
    </button>
    <section v-if="open" class="github-resource-overview__card" aria-label="GitHub 仓库说明">
      <p v-if="busy" class="github-resource-overview__status">正在读取公开仓库资料与 README…</p>
      <p v-else-if="error" class="github-resource-overview__notice" role="status">{{ error }}</p>
      <template v-else-if="inspection">
        <header>
          <div>
            <strong>{{ inspection.name }}</strong
            ><small>{{ inspection.fullName }}</small>
          </div>
          <span v-if="inspection.archived">已归档</span>
        </header>
        <p>{{ inspection.summary || inspection.repositoryDescription || '仓库未提供说明' }}</p>
        <button type="button" @click="detailOpen = true">查看仓库详情</button>
        <small>详情页提供 README、发布版本、兼容性和侧边章节导航。</small>
        <p v-if="inspection.warning" class="github-resource-overview__notice">
          {{ inspection.warning }}
        </p>
      </template>
      <p class="github-resource-overview__privacy">
        仅读取公开资料、README、manifest 与最新 Release 元数据；不会执行代码、下载文件或写回资源。
      </p>
    </section>
    <GitHubRepositoryDetail
      v-if="detailOpen && inspection"
      :link="link"
      :inspection="inspection"
      @close="detailOpen = false"
    />
  </div>
</template>

<style scoped>
.github-resource-overview {
  display: grid;
  gap: 0.5rem;
}
.github-resource-overview__trigger,
.github-resource-overview__card > button {
  justify-self: start;
  min-height: 2.25rem;
  padding: 0 0.75rem;
  font-size: 0.75rem;
  font-weight: 650;
  cursor: pointer;
}
.github-resource-overview__trigger:hover,
.github-resource-overview__card > button:hover {
  border-color: var(--color-accent);
  background: var(--color-accent-soft);
}
.github-resource-overview__card {
  display: grid;
  gap: 0.7rem;
  padding: 0.875rem;
  border: 1px solid var(--color-line);
  border-left: 3px solid var(--color-accent);
  background: var(--color-surface);
}
.github-resource-overview__card > header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
}
.github-resource-overview__card > header strong,
.github-resource-overview__card > header small {
  display: block;
}
.github-resource-overview__card > header strong {
  font-size: 0.875rem;
}
.github-resource-overview__card > header small,
.github-resource-overview__card > small,
.github-resource-overview__privacy,
.github-resource-overview__status {
  color: var(--color-ink-soft);
  font-size: 0.6875rem;
  line-height: 1.45;
}
.github-resource-overview__card > header > span {
  padding: 0.1875rem 0.375rem;
  color: var(--color-danger);
  background: color-mix(in srgb, var(--color-danger) 10%, transparent);
  font-size: 0.625rem;
}
.github-resource-overview__card > p {
  margin: 0;
  font-size: 0.75rem;
  line-height: 1.55;
}
.github-resource-overview__card > button {
  background: var(--button-background, var(--color-accent-soft));
  font-weight: 750;
}
.github-resource-overview__notice {
  padding: 0.5rem 0.625rem;
  border-left: 2px solid var(--color-danger);
  color: var(--color-danger);
  background: color-mix(in srgb, var(--color-danger) 7%, transparent);
}
.github-resource-overview__privacy {
  margin: 0;
  padding-top: 0.625rem;
  border-top: 1px solid var(--color-line);
}
</style>
