<script setup lang="ts">
import '../styles/DuplicateCleaner.css'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import { confirmAction } from '../composables/UseConfirmDialog'
import { resourceService } from '../core/AppContainer'
import type { ParsedCharacterTagCandidate, ParsedTagProgress } from '../services/ResourceService'
import type { ResourceSummary } from '../types/Resource'
import FeatureBackButton from './FeatureBackButton.vue'

const emit = defineEmits<{
  back: []
  openResource: [resource: ResourceSummary]
  'library-changed': []
}>()

const candidates = ref<ParsedCharacterTagCandidate[]>([])
const selected = ref(new Set<string>())
const isScanning = ref(false)
const isBusy = ref(false)
const scanned = ref(false)
const message = ref('')
const scanController = new AbortController()
onBeforeUnmount(() => {
  scanController.abort()
  resourceService.clearParsedCharacterTagScan()
})
const lastRemoved = ref<Array<{ resourceId: string; tags: string[] }>>([])
const progress = ref<ParsedTagProgress>({ completed: 0, total: 0, resourceName: '', failed: 0 })
const tagSearch = ref('')
const page = ref(1)
const matchingCandidates = computed(() => {
  const query = tagSearch.value.trim().toLocaleLowerCase()
  return candidates.value.filter(
    ({ resource, tags }) =>
      !query ||
      resource.name.toLocaleLowerCase().includes(query) ||
      tags.some((tag) => tag.toLocaleLowerCase().includes(query)),
  )
})
const pageCount = computed(() => Math.max(1, Math.ceil(matchingCandidates.value.length / 40)))
const pageCandidates = computed(() =>
  matchingCandidates.value.slice((page.value - 1) * 40, page.value * 40),
)

function updateProgress(value: ParsedTagProgress): void {
  progress.value = value
}

function tagKey(resourceId: string, tag: string): string {
  return `${resourceId}\u0000${tag.toLocaleLowerCase()}`
}

const allTags = computed(() =>
  candidates.value.flatMap(({ resource, tags }) => tags.map((tag) => ({ resource, tag }))),
)
const selectedTags = computed(() =>
  allTags.value.filter(({ resource, tag }) => selected.value.has(tagKey(resource.id, tag))),
)
const groupedRemovals = computed(() => {
  const grouped = new Map<string, { resourceId: string; resourceName: string; tags: string[] }>()
  for (const { resource, tag } of selectedTags.value) {
    const entry = grouped.get(resource.id) ?? {
      resourceId: resource.id,
      resourceName: resource.name,
      tags: [],
    }
    entry.tags.push(tag)
    grouped.set(resource.id, entry)
  }
  return [...grouped.values()]
})

function toggleTag(resourceId: string, tag: string): void {
  const next = new Set(selected.value)
  const key = tagKey(resourceId, tag)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  selected.value = next
}

function selectAll(): void {
  selected.value = new Set(allTags.value.map(({ resource, tag }) => tagKey(resource.id, tag)))
}

function clearSelection(): void {
  selected.value = new Set()
}

async function scan(): Promise<void> {
  if (isScanning.value || isBusy.value) return
  isScanning.value = true
  scanned.value = false
  message.value = ''
  candidates.value = []
  selected.value = new Set()
  try {
    candidates.value = await resourceService.findParsedCharacterTags(
      updateProgress,
      scanController.signal,
    )
    page.value = 1
    scanned.value = true
    message.value = candidates.value.length
      ? `找到 ${candidates.value.length} 张角色卡，共 ${allTags.value.length} 个仍存在的解析标签。`
      : '没有找到可清理的自动解析标签。'
    if (progress.value.failed)
      message.value += ` ${progress.value.failed} 项读取失败，未列入清理范围。`
  } catch (error) {
    message.value = error instanceof Error ? error.message : '扫描角色卡标签失败'
  } finally {
    isScanning.value = false
  }
}

async function cleanSelected(): Promise<void> {
  const removals = groupedRemovals.value
  if (!removals.length || isBusy.value) return
  const scope = removals
    .map(({ resourceName, tags }) => `「${resourceName}」：${tags.join('、')}`)
    .join('\n')
  const confirmed = await confirmAction({
    title: '确认清理解析标签',
    message: `将从 ${removals.length} 张角色卡中移除 ${selectedTags.value.length} 个标签：\n${scope}\n\n只修改当前勾选的标签，不改角色卡原件。清理可在本面板内撤销。确定继续吗？`,
    confirmLabel: '确认清理',
    danger: true,
  })
  if (!confirmed) return
  isBusy.value = true
  message.value = ''
  try {
    const result = await resourceService.removeParsedCharacterTags(
      removals.map(({ resourceId, tags }) => ({ resourceId, tags })),
      updateProgress,
    )
    lastRemoved.value = result.entries.map(({ resourceId, tags }) => ({ resourceId, tags }))
    selected.value = new Set()
    const removedById = new Map(
      result.entries.map((entry) => [
        entry.resourceId,
        new Set(entry.tags.map((tag) => tag.toLocaleLowerCase())),
      ]),
    )
    candidates.value = candidates.value
      .map((candidate) => {
        const removed = removedById.get(candidate.resource.id) ?? new Set<string>()
        return {
          ...candidate,
          tags: candidate.tags.filter((tag) => !removed.has(tag.toLocaleLowerCase())),
        }
      })
      .filter((candidate) => candidate.tags.length)
    message.value = `已从 ${result.resourceCount} 张角色卡移除 ${result.tagCount} 个解析标签。可撤销本次清理。`
    if (result.failed) message.value += ` ${result.failed} 项未清理成功，可重新扫描后重试。`
    page.value = Math.min(page.value, pageCount.value)
    emit('library-changed')
  } catch (error) {
    message.value = error instanceof Error ? error.message : '清理解析标签失败'
  } finally {
    isBusy.value = false
  }
}

async function undoLastRemoval(): Promise<void> {
  if (!lastRemoved.value.length || isBusy.value) return
  isBusy.value = true
  progress.value = { completed: 0, total: 0, resourceName: '正在恢复标签', failed: 0 }
  try {
    await resourceService.restoreParsedCharacterTags(lastRemoved.value)
    lastRemoved.value = []
    isBusy.value = false
    await scan()
    message.value = '已恢复上次清理的标签。'
    emit('library-changed')
  } catch (error) {
    message.value = error instanceof Error ? error.message : '恢复解析标签失败'
  } finally {
    isBusy.value = false
  }
}
onMounted(() => {
  void scan()
})
</script>

<template>
  <section class="duplicate-cleaner parsed-tag-cleaner" aria-label="清理自动解析标签">
    <header class="duplicate-cleaner__header">
      <FeatureBackButton label="返回资源库" @click="emit('back')" />
      <div>
        <h1>清理自动解析标签</h1>
        <p>
          只列出原件标签与库内标签重合的部分，可逐项保留。未变化的原件复用扫描结果；不会修改角色卡原件。
        </p>
      </div>
    </header>

    <p v-if="message" class="duplicate-cleaner__message" role="status">{{ message }}</p>

    <div class="parsed-tag-cleaner__toolbar">
      <button type="button" :disabled="isScanning || isBusy" @click="scan">
        {{ isScanning ? '正在读取角色卡…' : scanned ? '重新扫描' : '扫描角色卡标签' }}
      </button>
      <button v-if="allTags.length" type="button" :disabled="isBusy" @click="selectAll">
        全选标签
      </button>
      <button v-if="allTags.length" type="button" :disabled="isBusy" @click="clearSelection">
        清空选择
      </button>
      <button
        v-if="lastRemoved.length"
        type="button"
        :disabled="isBusy || isScanning"
        @click="undoLastRemoval"
      >
        撤销上次清理
      </button>
    </div>

    <section v-if="isScanning || isBusy" role="status" class="parsed-tag-cleaner__progress">
      <p>
        {{ isScanning ? '扫描解析标签' : '更新标签' }} ·
        {{ progress.total ? `${progress.completed} / ${progress.total} 项` : '准备中' }}
      </p>
      <progress
        :value="progress.total ? progress.completed : undefined"
        :max="progress.total || 1"
        aria-label="标签处理进度"
      ></progress>
      <small>{{ progress.resourceName }}</small>
    </section>
    <label v-if="candidates.length"
      >筛选资源或标签
      <input v-model="tagSearch" type="search" placeholder="输入资源名或标签" @input="page = 1" />
    </label>
    <p v-if="scanned && !candidates.length" class="duplicate-cleaner__empty">
      没有可清理的自动解析标签。
    </p>
    <ul v-else class="parsed-tag-cleaner__list">
      <li v-for="candidate in pageCandidates" :key="candidate.resource.id">
        <div class="parsed-tag-cleaner__resource">
          <strong>{{ candidate.resource.name }}</strong>
          <button
            type="button"
            :disabled="isBusy"
            @click="emit('openResource', candidate.resource)"
          >
            查看资源
          </button>
        </div>
        <div class="parsed-tag-cleaner__tags">
          <label v-for="tag in candidate.tags" :key="tag">
            <input
              type="checkbox"
              :checked="selected.has(tagKey(candidate.resource.id, tag))"
              :disabled="isBusy"
              @change="toggleTag(candidate.resource.id, tag)"
            />
            <span>{{ tag }}</span>
          </label>
        </div>
      </li>
    </ul>
    <nav v-if="pageCount > 1" class="parsed-tag-cleaner__toolbar" aria-label="标签结果分页">
      <button :disabled="page <= 1" @click="page--">上一页</button>
      <span>{{ page }} / {{ pageCount }}</span>
      <button :disabled="page >= pageCount" @click="page++">下一页</button>
    </nav>

    <footer v-if="scanned && allTags.length" class="parsed-tag-cleaner__footer">
      <span>已选 {{ selectedTags.length }} 个标签 / {{ groupedRemovals.length }} 张角色卡</span>
      <button
        class="duplicate-cleaner__clean"
        type="button"
        :disabled="isBusy || !selectedTags.length"
        @click="cleanSelected"
      >
        {{ isBusy ? '正在清理' : '查看范围并清理' }}
      </button>
    </footer>
  </section>
</template>

<style scoped>
.parsed-tag-cleaner__progress progress {
  width: 100%;
}
.parsed-tag-cleaner__progress small {
  overflow-wrap: anywhere;
}
.parsed-tag-cleaner > label {
  display: grid;
  gap: 0.4rem;
}
.parsed-tag-cleaner input[type='search'] {
  width: 100%;
  min-height: 44px;
  font-size: 16px;
}
.parsed-tag-cleaner__toolbar,
.parsed-tag-cleaner__resource,
.parsed-tag-cleaner__footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.parsed-tag-cleaner__toolbar button,
.parsed-tag-cleaner__resource button {
  min-height: 44px;
  padding: 0 0.8rem;
}

.parsed-tag-cleaner__list {
  display: grid;
  gap: 0.5rem;
  margin: 0.75rem 0;
  padding: 0;
  list-style: none;
}

.parsed-tag-cleaner__list > li {
  display: grid;
  gap: 0.55rem;
  padding: 0.65rem 0.75rem;
  border: 1px solid var(--color-line);
  border-radius: 0.75rem;
}

.parsed-tag-cleaner__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.parsed-tag-cleaner__tags label {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  min-height: 40px;
  padding: 0.2rem 0.6rem;
  border: 1px solid var(--color-line);
  border-radius: 999px;
  cursor: pointer;
}

.parsed-tag-cleaner__tags input {
  width: 1rem;
  height: 1rem;
}
</style>
