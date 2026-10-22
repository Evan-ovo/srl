<script setup lang="ts">
// Keep the complete detail-tab appearance bundle with this lazy panel. It includes
// the statistics, tabs, and archive-owned mobile rules used by this screen.
import '../FeatureStyles.css'
import ResourceSourceLinks from './ResourceSourceLinks.vue'
import ResourceAttachmentEntry from './ResourceAttachmentEntry.vue'
import FeatureBackButton from './FeatureBackButton.vue'
import ResourcePicker from './ResourcePicker.vue'
import UserPersonaOverviewBindings from './UserPersonaOverviewBindings.vue'
import { computed, ref, useTemplateRef, watch } from 'vue'
import ResourceCoverEditor from './ResourceCoverEditor.vue'
import ResourceVersionCarriers from './ResourceVersionCarriers.vue'
import { resourceCoverId } from '../types/ResourceGallery'
import type { Resource } from '../types/Resource'
import { createAsyncPanel } from '../core/AsyncPanel'
import { isPersonalResourceType } from '../types/PersonalResource'
const PersonalResourceEditor = createAsyncPanel(
  '个人资源内容',
  () => import('./PersonalResourceEditor.vue'),
)
import {
  useResourceOrganizer,
  type ResourceOrganizerProps,
  type ResourceOrganizerEvents,
} from '../composables/UseResourceOrganizer'
const ResourceGalleryPanel = createAsyncPanel(
  '资源图库',
  () => import('./ResourceGalleryPanel.vue'),
)
const galleryCount = ref(0)
const attachmentsOpen = ref(false)
const attachmentEntry = useTemplateRef<{ requestBack: () => void }>('attachmentEntry')
const props = defineProps<ResourceOrganizerProps>()
const emit = defineEmits<ResourceOrganizerEvents>()
const controller = useResourceOrganizer(props, emit)
const galleryContent = useTemplateRef<{ busy: boolean; editing: boolean; requestBack: () => void }>(
  'galleryContent',
)
const coverContent = useTemplateRef<{
  busy: boolean
  editing: boolean
  requestBack: () => void
  restoreDefault: () => Promise<void>
}>('coverContent')
const galleryVisited = ref(props.initialTab === 'gallery')
watch(
  () => props.resource.id,
  () => {
    galleryCount.value = 0
  },
)
watch(
  () => controller.activeTab.value,
  (tab) => {
    if (tab === 'gallery') galleryVisited.value = true
  },
)
const personalContent = useTemplateRef<{ editing: boolean; requestBack: () => void }>(
  'personalContent',
)
function requestClose() {
  if (attachmentsOpen.value) {
    attachmentEntry.value?.requestBack()
    return
  }
  if (galleryContent.value?.busy || coverContent.value?.busy) return
  if (coverContent.value?.editing) coverContent.value.requestBack()
  else if (galleryContent.value?.editing) galleryContent.value.requestBack()
  else if (personalContent.value?.editing) personalContent.value.requestBack()
  else void controller.requestClose()
}
defineExpose({ requestClose })
const {
  authorNote,
  parsedAuthor,
  handlePersonalSaved,
  isCharacter,
  fileExtension,
  name,
  characterIdentity,
  RESOURCE_TYPE_LABELS,
  formattedFileSize,
  visibleTags,
  hiddenTagCount,
  artworkPickerStatus,
  handleSubmit,
  visibleDetailTabs,
  activeTab,
  preparedTabs,
  preparingTab,
  preparationError,
  prepareActiveTab,
  selectTab,
  relatedResourceIds,
  summaryStats,
  resourceType,
  typeOptions,
  description,
  categoryIds,
  toggleCategory,
  tagText,
  sourceLinks,
  CharacterCardDetails,
  availableBoundResources,
  characterOverrides,
  characterContentEdits,
  characterEditorDirty,
  characterWorkbenchOpen,
  structuredEditorDirty,
  structuredWorkbenchOpen,
  StructuredResourceDetails,
  relatedDownloadCount,
  relatedDownloadIds,
  relationQuery,
  relationCategoryId,
  relationTypeFilter,
  relationTypeOptions,
  relationPage,
  relationPageCount,
  relationCandidates,
  hideBoundRelationCandidates,
  boundElsewhereCandidateCount,
  relationGroups,
  handleRelationDoubleClick,
  toggleRelation,
  toggleRelatedDownload,
  openRelatedResource,
  RESOURCE_TYPE,
  chooseArtworkFile,
  handleArtworkFileChange,
  manualVersionResourceId,
  manualVersionCandidates,
  manualVersionNote,
  submitManualVersionMerge,
  versionNotes,
  diffTarget,
  createdDate,
  updatedDate,
  metadataJson,
  isDirty,
  VersionDiffDialog,
} = controller
const isContentEditing = computed(
  () =>
    activeTab.value === 'content' &&
    (characterWorkbenchOpen.value || structuredWorkbenchOpen.value),
)
const editingCarrierNoteId = ref<string>()
const carrierImageDiff = ref<{ current: Resource; other: Resource }>()

function editCarrierNote(carrier: { id: string; versionNote?: string }): void {
  versionNotes.value[carrier.id] = carrier.versionNote ?? ''
  editingCarrierNoteId.value = carrier.id
}

function cancelCarrierNote(carrier: { id: string; versionNote?: string }): void {
  versionNotes.value[carrier.id] = carrier.versionNote ?? ''
  editingCarrierNoteId.value = undefined
}
</script>

<template>
  <Teleport to="#srl-independent-page-outlet">
    <main
      v-show="!settingsOpen && !attachmentsOpen"
      class="srl-independent-page resource-detail-page"
      :class="{ 'resource-detail-page--content-editor': isContentEditing }"
      role="main"
    >
      <section
        class="editor-sheet resource-detail-sheet"
        :class="{
          'resource-detail-sheet--character': isCharacter,
          'resource-detail-sheet--gallery': activeTab === 'gallery',
          'resource-detail-sheet--content-editor': isContentEditing,
        }"
        aria-labelledby="resource-detail-title"
      >
        <header class="editor-sheet__header resource-detail__header">
          <FeatureBackButton
            v-if="!isContentEditing"
            class="resource-detail__back"
            label="返回资源库"
            @click="requestClose"
          />
          <div>
            <h2 id="resource-detail-title">
              {{
                isContentEditing
                  ? `${name || resource.name} · ${characterWorkbenchOpen ? '卡内编辑' : '内容编辑'}`
                  : activeTab === 'gallery'
                    ? name || resource.name
                    : '资源详情'
              }}
            </h2>
          </div>
          <button
            v-if="isContentEditing && !characterWorkbenchOpen"
            class="button button--primary resource-detail__editor-save"
            type="submit"
            form="resource-organize-section"
            aria-label="保存修改"
            :disabled="busy || !name.trim() || !isDirty"
          >
            {{ busy ? '保存中' : '保存' }}
          </button>
          <button
            v-else-if="!isContentEditing"
            class="editor-sheet__close resource-detail__close-desktop"
            type="button"
            aria-label="关闭"
            @click="requestClose"
          >
            ×
          </button>
        </header>

        <div ref="detailSheet" class="resource-detail__layout">
          <aside
            v-show="activeTab !== 'gallery' && !isContentEditing"
            class="resource-detail__folio"
          >
            <ResourceCoverEditor
              ref="coverContent"
              :resource="resource"
              @saved="handlePersonalSaved"
            />

            <div class="resource-detail__identity">
              <h3>{{ name || resource.name }}</h3>
              <p v-if="isCharacter">
                {{ characterIdentity.version }} · {{ characterIdentity.creator }}
              </p>
              <p v-else>{{ RESOURCE_TYPE_LABELS[resource.type] }} · {{ formattedFileSize }}</p>
              <div v-if="visibleTags.length" class="resource-detail__summary-tags">
                <span v-for="tag in visibleTags" :key="tag">#{{ tag }}</span>
                <span v-if="hiddenTagCount">+{{ hiddenTagCount }}</span>
              </div>
            </div>

            <div class="resource-detail__summary-actions">
              <button class="button" type="button" @click="emit('download', resource)">
                下载资源
              </button>
              <button
                class="button button--quiet"
                type="button"
                :disabled="!resourceCoverId(resource) || coverContent?.busy"
                @click="coverContent?.restoreDefault()"
              >
                恢复默认封面
              </button>
            </div>
            <p v-if="artworkPickerStatus" class="resource-detail__preview-status" role="status">
              {{ artworkPickerStatus }}
            </p>
          </aside>

          <div class="resource-detail__content">
            <form
              id="resource-organize-section"
              class="editor-form resource-detail__form"
              @submit.prevent="handleSubmit"
            >
              <p v-if="preparingTab" role="status">正在读取详情…</p>
              <p v-if="preparationError" role="alert">
                {{ preparationError }}
                <button class="button button--quiet" type="button" @click="prepareActiveTab">
                  重试读取
                </button>
              </p>
              <nav
                v-show="!isContentEditing"
                ref="detailTabs"
                class="resource-detail__tabs"
                role="tablist"
                aria-label="资源详情分页"
              >
                <button
                  v-for="tab in visibleDetailTabs"
                  :id="`resource-tab-${tab.value}`"
                  :key="tab.value"
                  type="button"
                  role="tab"
                  :aria-selected="activeTab === tab.value"
                  :aria-controls="`resource-panel-${tab.value}`"
                  :class="{ 'resource-detail__tab--active': activeTab === tab.value }"
                  @click="selectTab(tab.value)"
                >
                  <span>{{ tab.label }}</span>
                  <small v-if="tab.value === 'relations'">{{ relatedResourceIds.size }}</small>
                  <small v-else-if="tab.value === 'versions'">{{ versions.length }}</small>
                  <small v-else-if="tab.value === 'gallery' && galleryCount">{{
                    galleryCount
                  }}</small>
                </button>
              </nav>
              <section
                v-if="galleryVisited"
                v-show="activeTab === 'gallery'"
                id="resource-panel-gallery"
                class="resource-detail__tab-panel"
                role="tabpanel"
                aria-labelledby="resource-tab-gallery"
              >
                <ResourceGalleryPanel
                  ref="galleryContent"
                  :resource="resource"
                  @saved="handlePersonalSaved"
                  @count="galleryCount = $event"
                />
              </section>

              <section
                v-show="activeTab === 'overview'"
                id="resource-panel-overview"
                class="resource-detail__tab-panel"
                role="tabpanel"
                aria-labelledby="resource-tab-overview"
              >
                <header class="resource-detail__tab-heading">
                  <h3>资源概览</h3>
                  <p>编辑基础信息、文件夹和标签；解析内容与文件信息已分开放置。</p>
                </header>

                <dl class="resource-detail__stats">
                  <div v-for="stat in summaryStats" :key="stat.label">
                    <dt>{{ stat.label }}</dt>
                    <dd>{{ stat.value }}</dd>
                  </div>
                </dl>

                <UserPersonaOverviewBindings
                  v-if="resource.type === RESOURCE_TYPE.USER_PERSONA"
                  :resource="resource"
                  :related-resources="props.boundResources"
                />

                <label class="field">
                  <span class="field__label">资源名称</span>
                  <input v-model="name" class="field__control" maxlength="160" required />
                </label>

                <label class="field">
                  <span class="field__label">资源类型</span>
                  <select v-model="resourceType" class="field__control">
                    <option v-for="option in typeOptions" :key="option.value" :value="option.value">
                      {{ option.label }}
                    </option>
                  </select>
                  <span class="field__hint">自动识别不准确时，可以在这里手动修正。</span>
                </label>

                <label class="field">
                  <span class="field__label">备注作者</span>
                  <input
                    v-model="authorNote"
                    aria-label="备注作者"
                    class="field__control"
                    maxlength="160"
                    placeholder="填写你确认的作者，可留空"
                  />
                  <span class="field__hint"
                    >解析作者：{{ parsedAuthor }}。备注不会修改原文件或解析作者。</span
                  >
                </label>

                <label class="field">
                  <span class="field__label">资源描述</span>
                  <textarea
                    v-model="description"
                    class="field__control field__control--textarea resource-detail__description"
                    rows="5"
                    maxlength="5000"
                    placeholder="记录用途、版本或使用说明"
                  ></textarea>
                </label>

                <fieldset class="field resource-detail__folder-fieldset">
                  <legend class="field__label">所属文件夹</legend>
                  <span class="field__hint">一个资源可以同时放入多个文件夹。</span>
                  <div v-if="categories.length" class="resource-detail__folder-options">
                    <label
                      v-for="category in categories"
                      :key="category.id"
                      :class="{
                        'resource-detail__folder-option--selected': categoryIds.has(category.id),
                      }"
                      class="resource-detail__folder-option"
                    >
                      <input
                        type="checkbox"
                        :checked="categoryIds.has(category.id)"
                        @change="toggleCategory(category.id)"
                      />
                      <i :style="{ backgroundColor: category.color }"></i>
                      <span>{{ category.name }}</span>
                    </label>
                  </div>
                  <p v-else class="resource-detail__folder-empty">
                    还没有文件夹，可关闭详情后从侧栏新建。
                  </p>
                </fieldset>

                <label class="field">
                  <span class="field__label">标签</span>
                  <input
                    v-model="tagText"
                    class="field__control"
                    placeholder="常用，奇幻，待完善"
                  />
                  <span class="field__hint">支持中英文逗号或换行；不会自动删除原标签。</span>
                </label>

                <ResourceSourceLinks v-model:links="sourceLinks" :resource-id="resource.id" />
                <ResourceAttachmentEntry
                  ref="attachmentEntry"
                  v-model:open="attachmentsOpen"
                  :resource="resource"
                  :disabled="busy"
                  @changed="emit('attachmentsChanged', $event)"
                />
              </section>

              <section
                v-if="preparedTabs.has('content')"
                v-show="activeTab === 'content'"
                id="resource-panel-content"
                class="resource-detail__tab-panel resource-detail__tab-panel--content"
                role="tabpanel"
                aria-labelledby="resource-tab-content"
              >
                <header
                  v-if="
                    !isPersonalResourceType(resource.type) &&
                    resource.type !== RESOURCE_TYPE.GREETING &&
                    !characterWorkbenchOpen &&
                    !structuredWorkbenchOpen
                  "
                  class="resource-detail__tab-heading"
                >
                  <h3>
                    {{
                      isCharacter
                        ? '角色档案与配套内容'
                        : `${RESOURCE_TYPE_LABELS[resource.type]}内容`
                    }}
                  </h3>
                  <p v-if="resource.type !== RESOURCE_TYPE.WORLD_BOOK">
                    完整解析内容集中在这里，长条目可逐项展开查看。
                  </p>
                </header>
                <CharacterCardDetails
                  v-if="isCharacter"
                  :key="`${resource.id}:${resource.contentHash}`"
                  ref="characterContent"
                  :metadata="resource.metadata"
                  :bound-resources="availableBoundResources"
                  :overrides="characterOverrides"
                  :content-edits="characterContentEdits"
                  :disabled="busy"
                  @update:overrides="characterOverrides = $event"
                  @update:content-edits="characterContentEdits = $event"
                  @draft-change="characterEditorDirty = $event"
                  @workbench-open="characterWorkbenchOpen = $event"
                >
                  <template #content-save>
                    <button
                      v-if="characterWorkbenchOpen"
                      class="is-primary resource-detail__editor-save"
                      type="submit"
                      form="resource-organize-section"
                      aria-label="保存修改"
                      :disabled="busy || !name.trim() || !isDirty"
                    >
                      {{ busy ? '保存中' : '保存' }}
                    </button>
                  </template>
                </CharacterCardDetails>
                <PersonalResourceEditor
                  v-else-if="isPersonalResourceType(resource.type)"
                  :key="`${resource.id}:${resource.contentHash}`"
                  ref="personalContent"
                  embedded
                  :kind="resource.type"
                  :resource="resource"
                  :settings-open="settingsOpen"
                  @open-settings="emit('openSecretSettings')"
                  @saved="handlePersonalSaved"
                  @busy="emit('personalBusy', $event)"
                />
                <StructuredResourceDetails
                  v-else
                  ref="structuredContent"
                  :resource="resource"
                  :disabled="busy"
                  :related-resources="availableBoundResources"
                  @saved="handlePersonalSaved"
                  @draft-change="structuredEditorDirty = $event"
                  @workbench-open="structuredWorkbenchOpen = $event"
                  @busy="emit('personalBusy', $event)"
                />
              </section>

              <section
                v-show="activeTab === 'relations'"
                id="resource-panel-relations"
                class="resource-detail__tab-panel"
                role="tabpanel"
                aria-labelledby="resource-tab-relations"
              >
                <section class="resource-relations" aria-labelledby="resource-relations-title">
                  <header class="resource-relations__header">
                    <div>
                      <h3 id="resource-relations-title">关联文件</h3>
                    </div>
                    <button
                      class="button button--quiet"
                      type="button"
                      :disabled="!relatedDownloadCount"
                      @click="emit('downloadRelated', Array.from(relatedDownloadIds))"
                    >
                      下载选中 {{ relatedDownloadCount || '' }}
                    </button>
                  </header>
                  <p class="resource-relations__description">
                    关联角色卡、世界书、正则或预设。保存后关系会双向建立，并按资源类型分组显示。
                  </p>
                  <div class="resource-relations__filters">
                    <label class="resource-relations__search">
                      <span>查找可关联资源</span>
                      <input
                        v-model="relationQuery"
                        class="field__control"
                        type="search"
                        placeholder="搜索名称、文件名或资源类型"
                      />
                    </label>
                    <label class="resource-relations__bound-filter">
                      <input v-model="hideBoundRelationCandidates" type="checkbox" />
                      <span>
                        隐藏已被其他资源关联的项目
                        <small v-if="boundElsewhereCandidateCount">
                          {{ boundElsewhereCandidateCount }} 项
                        </small>
                      </span>
                    </label>
                    <div class="resource-relations__selectors">
                      <label class="resource-relations__search">
                        <span>资源类型</span>
                        <select
                          v-model="relationTypeFilter"
                          class="field__control"
                          aria-label="关联资源类型"
                        >
                          <option value="all">全部类型</option>
                          <option
                            v-for="option in relationTypeOptions"
                            :key="option.value"
                            :value="option.value"
                          >
                            {{ option.label }}
                          </option>
                        </select>
                      </label>
                      <label class="resource-relations__search">
                        <span>文件夹筛选</span>
                        <select
                          v-model="relationCategoryId"
                          class="field__control"
                          aria-label="关联资源文件夹"
                        >
                          <option value="all">全部文件夹</option>
                          <option value="uncategorized">未分类</option>
                          <option
                            v-for="category in categories"
                            :key="category.id"
                            :value="category.id"
                          >
                            {{ category.name }}
                          </option>
                        </select>
                      </label>
                    </div>
                  </div>
                  <nav
                    v-if="relationPageCount > 1"
                    class="resource-relations__pagination"
                    aria-label="关联资源分页"
                  >
                    <button
                      class="button button--quiet"
                      type="button"
                      :disabled="relationPage === 1"
                      @click="relationPage -= 1"
                    >
                      上一页
                    </button>
                    <small
                      >{{ relationPage }} / {{ relationPageCount }} ·
                      {{ relationCandidates.length }} 项</small
                    >
                    <button
                      class="button button--quiet"
                      type="button"
                      :disabled="relationPage === relationPageCount"
                      @click="relationPage += 1"
                    >
                      下一页
                    </button>
                  </nav>
                  <div v-if="relationGroups.length" class="resource-relations__groups">
                    <section v-for="group in relationGroups" :key="group.type">
                      <header>
                        <strong>{{ group.label }}</strong>
                        <small>
                          本页 {{ group.visibleItems.length }} / {{ group.items.length }} 项{{
                            group.selectedCount ? ' · 已关联 ' + group.selectedCount : ''
                          }}
                        </small>
                      </header>
                      <div class="resource-relations__list">
                        <article
                          v-for="candidate in group.visibleItems"
                          :key="candidate.id"
                          class="resource-relation"
                          :class="{
                            'resource-relation--selected': relatedResourceIds.has(candidate.id),
                          }"
                          :title="
                            relatedResourceIds.has(candidate.id)
                              ? '双击打开这个关联文件'
                              : '勾选后建立关联'
                          "
                          @dblclick="handleRelationDoubleClick($event, candidate)"
                        >
                          <label class="resource-relation__select">
                            <input
                              type="checkbox"
                              :checked="relatedResourceIds.has(candidate.id)"
                              @change="toggleRelation(candidate.id)"
                            />
                            <span>
                              <strong>{{ candidate.name }}</strong>
                              <small>{{ candidate.fileName }}</small>
                            </span>
                          </label>
                          <div
                            v-if="relatedResourceIds.has(candidate.id)"
                            class="resource-relation__actions"
                          >
                            <label title="加入配套 ZIP">
                              <input
                                type="checkbox"
                                :checked="relatedDownloadIds.has(candidate.id)"
                                @change="toggleRelatedDownload(candidate.id)"
                              />
                              <span>打包</span>
                            </label>
                            <button type="button" @click="emit('download', candidate)">下载</button>
                            <button type="button" @click="openRelatedResource(candidate)">
                              打开
                            </button>
                          </div>
                        </article>
                      </div>
                    </section>
                  </div>
                  <p v-else class="resource-relations__empty">
                    {{
                      resources.length <= 1 ? '资源库里还没有其他文件。' : '没有匹配的可关联文件。'
                    }}
                  </p>
                </section>
              </section>

              <section
                v-if="preparedTabs.has('versions')"
                v-show="activeTab === 'versions'"
                id="resource-panel-versions"
                class="resource-detail__tab-panel"
                role="tabpanel"
                aria-labelledby="resource-tab-versions"
              >
                <header class="resource-detail__tab-heading">
                  <h3>版本历史</h3>
                  <p>所有版本都保存在本机；当前版本决定资源库卡面、解析内容和下载文件。</p>
                  <p v-if="isDirty">当前有未保存修改，请先保存，再切换版本。</p>
                </header>

                <section
                  v-if="resource.type === RESOURCE_TYPE.CHARACTER_CARD"
                  class="character-artwork-panel"
                >
                  <div>
                    <small>CARD ARTWORK</small>
                    <h4>更换卡面</h4>
                    <p>选择喜欢的图片生成新的 PNG 封装；原卡面、JSON 和原始文件不会被覆盖。</p>
                  </div>
                  <button
                    class="button button--primary"
                    type="button"
                    :disabled="busy"
                    @click="chooseArtworkFile"
                  >
                    {{ busy ? '处理中…' : '选择新卡面' }}
                  </button>
                  <input
                    ref="artworkInput"
                    type="file"
                    accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
                    hidden
                    @change="handleArtworkFileChange"
                  />
                </section>

                <details class="manual-version-panel" aria-labelledby="manual-version-title">
                  <summary>
                    <span class="manual-version-panel__summary-content">
                      <h4 id="manual-version-title">手动加入版本</h4>
                      <small>可选资源 {{ manualVersionCandidates.length }} 个</small>
                    </span>
                  </summary>
                  <div class="manual-version-panel__content">
                    <div class="manual-version-panel__intro">
                      <p>
                        如果系统没有识别出同一资源的不同版本，可以从库里选择一个同类型资源，把它收入当前资源的历史版本。
                      </p>
                    </div>
                    <ResourcePicker
                      title="选择库内资源"
                      :resources="manualVersionCandidates"
                      :model-value="manualVersionResourceId ? [manualVersionResourceId] : []"
                      :categories="categories"
                      :multiple="false"
                      :show-actions="false"
                      :disabled="busy"
                      @update:model-value="manualVersionResourceId = $event[0] ?? ''"
                    />
                    <label>
                      <span>版本备注</span>
                      <input
                        v-model="manualVersionNote"
                        type="text"
                        maxlength="240"
                        placeholder="可选：例如 2026.7 修订版 / 人设小改"
                      />
                    </label>
                    <button
                      class="button button--primary"
                      type="button"
                      :disabled="busy || !manualVersionResourceId"
                      @click="submitManualVersionMerge"
                    >
                      加入为历史版本
                    </button>
                    <p v-if="!manualVersionCandidates.length" class="manual-version-panel__empty">
                      当前没有可合并的同类型资源。
                    </p>
                  </div>
                </details>

                <div class="resource-version-list">
                  <article
                    v-for="version in versions"
                    :key="version.resource.id"
                    :class="{ 'resource-version-card--active': version.active }"
                    class="resource-version-card"
                  >
                    <div class="resource-version-card__marker">
                      <span>{{ version.active ? 'CURRENT' : 'ARCHIVE' }}</span>
                      <i></i>
                    </div>
                    <div class="resource-version-card__body">
                      <header>
                        <div>
                          <strong>{{
                            version.resource.versionLabel || version.resource.fileName
                          }}</strong>
                          <small>{{ version.resource.fileName }}</small>
                        </div>
                        <span
                          v-if="
                            version.active ||
                            version.resource.metadata.versionVariantKind === 'container'
                          "
                        >
                          {{
                            version.active
                              ? '当前显示'
                              : version.resource.metadata.versionVariantKind === 'container'
                                ? '立绘/封装变体'
                                : ''
                          }}
                        </span>
                      </header>
                      <ResourceVersionCarriers
                        :version="version"
                        :current-resource-id="resource.id"
                        :busy="busy"
                        :editing-carrier-note-id="editingCarrierNoteId"
                        :version-notes="versionNotes"
                        @download="emit('download', $event)"
                        @activate-version="emit('activateVersion', $event)"
                        @detach-version="emit('detachVersion', $event)"
                        @delete-version="emit('deleteVersion', $event)"
                        @update-version-note="(id, note) => emit('updateVersionNote', id, note)"
                        @update-note="(id, note) => (versionNotes[id] = note)"
                        @compare-carrier-image="carrierImageDiff = $event"
                        @edit-carrier-note="editCarrierNote"
                        @cancel-carrier-note="cancelCarrierNote"
                      />
                      <dl>
                        <div>
                          <dt>导入时间</dt>
                          <dd>
                            {{
                              new Date(
                                version.resource.versionImportedAt || version.resource.createdAt,
                              ).toLocaleString('zh-CN')
                            }}
                          </dd>
                        </div>
                        <div>
                          <dt>文件大小</dt>
                          <dd>{{ (version.resource.fileSize / 1024).toFixed(1) }} KB</dd>
                        </div>
                        <div>
                          <dt>内容指纹</dt>
                          <dd>{{ version.resource.contentHash.slice(0, 12) }}</dd>
                        </div>
                      </dl>
                      <label
                        v-if="(version.carriers?.length ?? 0) <= 1"
                        class="resource-version-card__note"
                      >
                        <span>版本备注</span>
                        <textarea
                          v-model="versionNotes[version.resource.id]"
                          rows="2"
                          maxlength="240"
                          placeholder="给这个版本写一句容易辨认的备注"
                        ></textarea>
                        <small>{{ (versionNotes[version.resource.id] ?? '').length }}/240</small>
                      </label>
                      <div class="resource-version-card__actions">
                        <button
                          type="button"
                          :disabled="
                            busy ||
                            (versionNotes[version.resource.id] ?? '').trim() ===
                              (version.resource.versionNote ?? '')
                          "
                          @click="
                            emit(
                              'updateVersionNote',
                              version.resource.id,
                              versionNotes[version.resource.id] ?? '',
                            )
                          "
                        >
                          保存备注
                        </button>
                        <button
                          type="button"
                          :disabled="busy"
                          @click="emit('download', version.resource)"
                        >
                          下载此版
                        </button>
                        <button
                          v-if="!version.active"
                          type="button"
                          :disabled="busy"
                          @click="diffTarget = version.resource"
                        >
                          对比当前
                        </button>
                        <button
                          v-if="!version.active"
                          type="button"
                          :disabled="busy || isDirty"
                          :title="isDirty ? '请先保存当前修改，再切换版本' : undefined"
                          @click="emit('activateVersion', version.resource.id)"
                        >
                          设为当前
                        </button>
                        <button
                          v-if="!version.active"
                          type="button"
                          :disabled="busy"
                          @click="emit('detachVersion', version.resource.id)"
                        >
                          解除绑定
                        </button>
                        <button
                          v-if="!version.active"
                          class="button--danger"
                          type="button"
                          :disabled="busy"
                          @click="
                            emit(
                              'deleteVersion',
                              (version.carriers ?? [version.resource]).map((carrier) => carrier.id),
                            )
                          "
                        >
                          删除版本
                        </button>
                      </div>
                    </div>
                  </article>
                </div>
              </section>

              <section
                v-if="activeTab === 'file'"
                id="resource-panel-file"
                class="resource-detail__tab-panel"
                role="tabpanel"
                aria-labelledby="resource-tab-file"
              >
                <header class="resource-detail__tab-heading">
                  <h3>文件与技术信息</h3>
                  <p>这里展示原始文件属性和解析元数据，不与资源内容混排。</p>
                </header>
                <dl class="resource-detail__file-facts">
                  <div>
                    <dt>原始文件</dt>
                    <dd>{{ resource.fileName }}</dd>
                  </div>
                  <div>
                    <dt>格式</dt>
                    <dd>{{ fileExtension }} · {{ resource.mimeType || '未知 MIME' }}</dd>
                  </div>
                  <div>
                    <dt>文件大小</dt>
                    <dd>{{ formattedFileSize }}</dd>
                  </div>
                  <div>
                    <dt>导入时间</dt>
                    <dd>{{ createdDate }}</dd>
                  </div>
                  <div>
                    <dt>最近整理</dt>
                    <dd>{{ updatedDate }}</dd>
                  </div>
                  <div>
                    <dt>内容指纹</dt>
                    <dd>{{ resource.contentHash }}</dd>
                  </div>
                </dl>
                <button
                  class="button resource-detail__download"
                  type="button"
                  @click="emit('download', resource)"
                >
                  下载资源
                </button>
                <details class="resource-detail__metadata">
                  <summary>查看解析元数据</summary>
                  <pre>{{ metadataJson }}</pre>
                </details>
              </section>
            </form>
          </div>
        </div>
        <div
          v-if="!isContentEditing && (activeTab !== 'gallery' || isDirty)"
          class="editor-form__actions resource-detail__actions"
        >
          <span :class="{ 'resource-detail__save-state--dirty': isDirty }">
            {{ busy ? '正在保存' : isDirty ? '有未保存修改' : '当前内容已保存' }}
          </span>
          <div>
            <button class="button button--quiet" type="button" @click="requestClose">取消</button>
            <button
              class="button button--primary"
              type="submit"
              form="resource-organize-section"
              :disabled="busy || !name.trim() || !isDirty"
            >
              {{ busy ? '正在保存' : '保存修改' }}
            </button>
          </div>
        </div>
      </section>
    </main>
  </Teleport>

  <Teleport to="body">
    <VersionDiffDialog
      v-if="carrierImageDiff"
      :current="carrierImageDiff.current"
      :other="carrierImageDiff.other"
      mode="carrier-pair"
      @close="carrierImageDiff = undefined"
    />
    <VersionDiffDialog
      v-else-if="diffTarget"
      :current="resource"
      :other="diffTarget"
      @close="diffTarget = undefined"
    />
  </Teleport>
</template>
