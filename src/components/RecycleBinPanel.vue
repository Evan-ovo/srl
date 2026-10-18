<script setup lang="ts">
import '../FeatureStyles.css'
import { computed, ref, watch } from 'vue'

import type { BackupRecordSummary } from '../types/Resource'
import FeatureBackButton from './FeatureBackButton.vue'

const props = defineProps<{
  records: BackupRecordSummary[]
  busy: boolean
}>()
const emit = defineEmits<{
  close: []
  restore: [id: string]
  purge: [id: string]
  empty: []
}>()

const query = ref('')
const page = ref(1)
const PAGE_SIZE = 24

const matchingRecords = computed(() => {
  const keyword = query.value.trim().toLocaleLowerCase()
  if (!keyword) return props.records
  return props.records.filter((record) =>
    (record.reason ?? '').toLocaleLowerCase().includes(keyword),
  )
})
const totalPages = computed(() => Math.max(1, Math.ceil(matchingRecords.value.length / PAGE_SIZE)))
const visibleRecords = computed(() => {
  const start = (page.value - 1) * PAGE_SIZE
  return matchingRecords.value.slice(start, start + PAGE_SIZE)
})

watch([query, totalPages], () => {
  page.value = Math.min(page.value, totalPages.value)
})

function formatDate(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  )
}

function formatBytes(value = 0): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}
</script>

<template>
  <Teleport to="body">
    <div class="editor-overlay recycle-bin-overlay" role="presentation" @click.self="emit('close')">
      <section
        class="editor-sheet recycle-bin-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="recycle-bin-title"
      >
        <header class="editor-sheet__header recycle-bin-sheet__header">
          <FeatureBackButton
            class="recycle-bin-sheet__back"
            label="返回资源库"
            @click="emit('close')"
          />
          <div>
            <p>LOCAL RECOVERY / ARCHIVE</p>
            <h2 id="recycle-bin-title">回收站</h2>
          </div>
          <button
            class="editor-sheet__close"
            type="button"
            aria-label="关闭"
            @click="emit('close')"
          >
            ×
          </button>
        </header>

        <div class="recycle-bin-sheet__content">
          <section class="recycle-bin-summary" aria-label="回收站概览">
            <div>
              <span>待恢复档案</span>
              <strong>{{ records.length }}</strong>
              <small>删除的资源不会上传，恢复后会回到本地资源库。</small>
            </div>
            <button
              class="recycle-bin-summary__empty"
              type="button"
              :disabled="busy || !records.length"
              @click="emit('empty')"
            >
              清空回收站
            </button>
          </section>

          <div class="recycle-bin-tools">
            <label>
              <span class="sr-only">搜索回收站</span>
              <input v-model="query" type="search" placeholder="搜索已删除的资源" />
            </label>
            <small v-if="query">找到 {{ matchingRecords.length }} 项</small>
            <small v-else>按最近删除排序</small>
          </div>

          <section v-if="visibleRecords.length" class="recycle-bin-list" aria-label="已删除资源">
            <article v-for="record in visibleRecords" :key="record.id" class="recycle-bin-item">
              <span class="recycle-bin-item__marker" aria-hidden="true"></span>
              <div class="recycle-bin-item__copy">
                <strong>{{ record.reason || '未命名资源' }}</strong>
                <span>{{ formatDate(record.createdAt) }}</span>
                <small>
                  {{
                    record.itemKind === 'persona-version'
                      ? '1 个人设版本'
                      : record.itemKind === 'attachment-version'
                        ? '1 个附件历史版本'
                        : record.itemKind === 'persona-character'
                          ? '1 组角色卡人设'
                          : `${record.resourceCount} 项资源`
                  }}
                  · {{ formatBytes(record.size) }}
                  <template v-if="record.encrypted"> · 已加密</template>
                </small>
              </div>
              <div class="recycle-bin-item__actions">
                <button type="button" :disabled="busy" @click="emit('restore', record.id)">
                  恢复
                </button>
                <button
                  class="recycle-bin-item__purge"
                  type="button"
                  :disabled="busy"
                  @click="emit('purge', record.id)"
                >
                  彻底删除
                </button>
              </div>
            </article>
          </section>
          <section v-else class="recycle-bin-empty">
            <span aria-hidden="true">↺</span>
            <strong>{{ query ? '没有匹配的已删除资源' : '回收站是空的' }}</strong>
            <p>
              {{
                query ? '换一个名称或清除搜索条件。' : '删除资源或人设版本后，它会先保存在这里。'
              }}
            </p>
          </section>

          <nav v-if="totalPages > 1" class="recycle-bin-pagination" aria-label="回收站分页">
            <button type="button" :disabled="page <= 1" @click="page -= 1">上一页</button>
            <span>第 {{ page }} / {{ totalPages }} 页</span>
            <button type="button" :disabled="page >= totalPages" @click="page += 1">下一页</button>
          </nav>
        </div>
      </section>
    </div>
  </Teleport>
</template>
