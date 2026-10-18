<script setup lang="ts">
import { isResourceOwnedFile, isResourceAttachment } from '../types/ResourceAttachment'
import '../FeatureStyles.css'
import { computed, ref, toRefs, watch } from 'vue'

import BackupScopeTree from './BackupScopeTree.vue'
import { resourceRestoreScopeIds, type BackupScopeId } from '../services/BackupScopeRegistry'
import { isResourceGalleryImage, includeResourceGalleryIds } from '../types/ResourceGallery'
import type { PreparedRestore, RestoreMode, RestoreReport } from '../types/Backup'
import { canRestoreOnlyPortableData } from '../services/BackupRestoreSelection'
import ProjectActivityCenter from './ProjectActivityCenter.vue'

const props = defineProps<{
  prepared?: PreparedRestore
  report?: RestoreReport
  busy: boolean
  preflightBusy?: boolean
  entry?: 'import' | 'export'
  completedMode?: RestoreMode
}>()
const { prepared, report, busy, entry, completedMode } = toRefs(props)
const emit = defineEmits<{
  close: []
  stop: []
  inspect: [file: File]
  confirm: [
    mode: RestoreMode,
    resourceIds: string[],
    includeGallery: boolean,
    includeAttachments: boolean,
  ]
}>()

const restoreMode = ref<RestoreMode>('merge')
const stopRequested = ref(false)
function stopPreflight() {
  stopRequested.value = true
  emit('stop')
}
const selectedResourceIds = ref(new Set<string>())
const selectedScopeIds = ref<BackupScopeId[]>([])
const portableOnly = computed(() => {
  const value = prepared.value
  if (!value?.portableData) return false
  return canRestoreOnlyPortableData({
    ...value,
    portableData: {
      ...value.portableData,
      resourceGalleryCategories: selectedScopeIds.value.includes('extra.resourceGallery')
        ? value.portableData.resourceGalleryCategories
        : undefined,
    },
  })
})
const restoreResources = computed(() => [
  ...(prepared.value?.resources ?? []),
  ...(prepared.value?.galleryOwners ?? []),
])
const scopeIds = computed(() => [
  ...new Set<BackupScopeId>([
    ...resourceRestoreScopeIds(restoreResources.value),
    ...(prepared.value?.portableData?.resourceGalleryCategories
      ? ['extra.resourceGallery' as const]
      : []),
  ]),
])
const scopeModel = computed({
  get: () => ({ resourceIds: [...selectedResourceIds.value], scopeIds: selectedScopeIds.value }),
  set: (value: { resourceIds: string[]; scopeIds: BackupScopeId[] }) => {
    selectedResourceIds.value = new Set(value.resourceIds)
    selectedScopeIds.value = value.scopeIds
  },
})
function confirmSelection() {
  const ids = new Set(selectedResourceIds.value)
  const includeGallery = selectedScopeIds.value.includes('extra.resourceGallery')
  includeResourceGalleryIds(
    restoreResources.value,
    ids,
    includeGallery,
    selectedScopeIds.value.includes('extra.resourceAttachments'),
  )
  emit(
    'confirm',
    restoreMode.value,
    [...ids],
    includeGallery,
    selectedScopeIds.value.includes('extra.resourceAttachments'),
  )
}

watch(
  prepared,
  () => {
    restoreMode.value = 'merge'
    selectedResourceIds.value = new Set(
      restoreResources.value.filter((r) => !isResourceOwnedFile(r)).map((r) => r.id),
    )
    selectedScopeIds.value = [...scopeIds.value]
  },
  { immediate: true },
)

watch(
  () => props.preflightBusy,
  (active) => {
    if (!active) stopRequested.value = false
  },
)

const selectedResources = computed(() =>
  restoreResources.value.filter(
    (resource) => !isResourceOwnedFile(resource) && selectedResourceIds.value.has(resource.id),
  ),
)
const selectedVersionCount = computed(() => {
  const ids = selectedResourceIds.value
  return (prepared.value?.versions ?? []).filter(
    (version) => version.versionGroupId && ids.has(version.versionGroupId),
  ).length
})
const allResourcesSelected = computed(
  () =>
    Boolean(prepared.value) &&
    restoreResources.value
      .filter((r) => !isResourceOwnedFile(r))
      .every((r) => selectedResourceIds.value.has(r.id)) &&
    (!(
      restoreResources.value.some(isResourceGalleryImage) ||
      prepared.value?.portableData?.resourceGalleryCategories
    ) ||
      selectedScopeIds.value.includes('extra.resourceGallery')) &&
    (!restoreResources.value.some(isResourceAttachment) ||
      selectedScopeIds.value.includes('extra.resourceAttachments')),
)

function handleFile(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file) emit('inspect', file)
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}
</script>

<template>
  <Teleport to="body">
    <div class="editor-overlay" role="presentation" @click.self="emit('close')">
      <section
        class="editor-sheet restore-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="restore-panel-title"
      >
        <header class="editor-sheet__header">
          <div>
            <h2 id="restore-panel-title">{{ entry === 'import' ? '识别到备份包' : '恢复备份' }}</h2>
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

        <template v-if="report">
          <section class="restore-result">
            <span class="restore-result__seal">完成</span>
            <h3>备份已安全恢复</h3>
            <p>资源与历史版本已恢复。</p>
          </section>

          <dl class="restore-stats">
            <div>
              <dt>{{ completedMode === 'replace' ? '恢复资源' : '新增资源' }}</dt>
              <dd>{{ report.restoredResources }}</dd>
            </div>
            <div>
              <dt>跳过重复</dt>
              <dd>{{ report.skippedDuplicates }}</dd>
            </div>
            <div>
              <dt>冲突副本</dt>
              <dd>{{ report.preservedConflicts }}</dd>
            </div>
            <div>
              <dt>新建文件夹</dt>
              <dd>{{ report.createdCategories }}</dd>
            </div>
            <div>
              <dt>复用文件夹</dt>
              <dd>{{ report.reusedCategories }}</dd>
            </div>
          </dl>

          <button
            class="button button--primary restore-sheet__final"
            type="button"
            @click="emit('close')"
          >
            返回资源库
          </button>
        </template>

        <template v-else>
          <label class="restore-picker" :class="{ 'restore-picker--busy': busy }">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 7h6l2 2h8v10H4V7Zm8 9V11m0 0-3 3m3-3 3 3" />
            </svg>
            <span>
              <strong>{{ prepared ? '重新选择备份包' : '选择备份 ZIP' }}</strong>
              <small>只接受酒馆资源库生成、清单完整的 ZIP</small>
            </span>
            <input
              type="file"
              accept=".zip,application/zip"
              :disabled="busy"
              @change="handleFile"
            />
          </label>

          <ProjectActivityCenter v-if="busy" :inline-task-names="['备份预检', '恢复备份']" />

          <button
            v-if="preflightBusy"
            class="button restore-sheet__stop"
            type="button"
            :disabled="stopRequested"
            @click="stopPreflight"
          >
            {{ stopRequested ? '正在停止并清理…' : '停止识别并清理' }}
          </button>

          <template v-if="prepared && !busy">
            <section class="restore-source">
              <div>
                <strong :title="prepared.preview.fileName">{{ prepared.preview.fileName }}</strong>
                <span>
                  {{ prepared.preview.mode === 'full' ? '完整备份' : '分包备份' }} ·
                  {{ formatDate(prepared.preview.createdAt) }}
                </span>
              </div>
              <small>{{ prepared.preview.archiveResourceCount }} 项</small>
            </section>

            <section class="restore-selection" aria-labelledby="restore-selection-title">
              <div class="restore-selection__heading">
                <strong id="restore-selection-title">选择要恢复的资源</strong>
                <span
                  >已选 {{ selectedResources.length }} 项 · 历史 {{ selectedVersionCount }} 项</span
                >
              </div>
              <BackupScopeTree
                v-model="scopeModel"
                :resources="restoreResources"
                :categories="prepared.categories"
                :available-scope-ids="scopeIds"
                mode="restore"
              />
            </section>

            <div
              v-if="prepared.preview.portableSections?.length"
              class="restore-note restore-note--portable"
            >
              <strong>同时恢复应用数据</strong>
              <span>{{ prepared.preview.portableSections.join('、') }}</span>
              <small>如包含云端凭证，只会写入当前浏览器会话。</small>
            </div>

            <dl v-if="restoreMode === 'merge'" class="restore-stats">
              <div class="restore-stats__primary">
                <dt>将新增</dt>
                <dd>{{ prepared.preview.resourcesToAdd }}</dd>
              </div>
              <div>
                <dt>重复跳过</dt>
                <dd>{{ prepared.preview.duplicatesToSkip }}</dd>
              </div>
              <div>
                <dt>冲突副本</dt>
                <dd>{{ prepared.preview.conflictsToPreserve }}</dd>
              </div>
              <div>
                <dt>新建文件夹</dt>
                <dd>{{ prepared.preview.categoriesToCreate }}</dd>
              </div>
              <div>
                <dt>复用文件夹</dt>
                <dd>{{ prepared.preview.categoriesToReuse }}</dd>
              </div>
            </dl>

            <section v-else class="restore-replace-summary">
              <strong>{{ prepared.preview.archiveResourceCount }}</strong>
              <span>项资源将成为恢复后的完整资源库</span>
            </section>

            <div
              v-if="
                restoreMode === 'merge' &&
                (prepared.preview.duplicatesToSkip || prepared.preview.conflictsToPreserve)
              "
              class="restore-note"
            >
              <strong>不会覆盖现有资源</strong>
              <span>相同内容会跳过；相同 ID 但内容不同的资源会作为新副本保存。</span>
            </div>

            <fieldset class="restore-mode-picker">
              <legend>选择写入方式</legend>
              <label :class="{ 'is-selected': restoreMode === 'merge' }">
                <input v-model="restoreMode" type="radio" value="merge" />
                <span>
                  <strong>安全新增</strong>
                  <small>保留现有资源；相同内容跳过，ID 冲突保留为副本。</small>
                </span>
              </label>
              <label
                :class="{
                  'is-selected': restoreMode === 'replace',
                  'is-disabled': prepared.preview.mode !== 'full' || !allResourcesSelected,
                }"
              >
                <input
                  v-model="restoreMode"
                  type="radio"
                  value="replace"
                  :disabled="prepared.preview.mode !== 'full' || !allResourcesSelected"
                />
                <span>
                  <strong>整库覆盖</strong>
                  <small v-if="prepared.preview.mode === 'full'">{{
                    allResourcesSelected
                      ? '将用备份完整替换当前资源库，成功后无法自动撤销，建议先导出当前库。'
                      : '整库覆盖必须选择全部资源；部分选择请使用安全新增。'
                  }}</small>
                  <small v-else>分包/部分备份不能用于整库覆盖，避免误删未包含的资源。</small>
                </span>
              </label>
            </fieldset>

            <footer class="restore-footer">
              <span>
                {{
                  restoreMode === 'replace'
                    ? '当前资源库会被完整替换；下一步将确认覆盖，建议先导出当前库。'
                    : selectedResources.length
                      ? '现有资源会保留，只写入上方选中的备份内容。'
                      : portableOnly
                        ? '原件均已存在，仅恢复备份中的 APP 数据与设置。'
                        : '请至少选择一项资源后继续。'
                }}
              </span>
              <button
                class="button button--primary"
                type="button"
                :disabled="
                  busy ||
                  (restoreMode === 'merge' && selectedResources.length === 0 && !portableOnly)
                "
                @click="confirmSelection"
              >
                {{ restoreMode === 'replace' ? '确认覆盖' : '确认新增' }}
              </button>
            </footer>
          </template>
        </template>
      </section>
    </div>
  </Teleport>
</template>
