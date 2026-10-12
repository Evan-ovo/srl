<script setup lang="ts">
import FeatureAppHeader from './FeatureAppHeader.vue'
import {
  useFolderLibraryView,
  type FolderLibraryViewProps,
  type FolderLibraryViewEvents,
} from '../composables/UseFolderLibraryView'
const props = defineProps<FolderLibraryViewProps>()
const emit = defineEmits<FolderLibraryViewEvents>()
const {
  activeFolderId,
  cabinetGridStyle,
  isFolderEditMode,
  handlePagerPointerDown,
  handlePagerPointerMove,
  finishPagerGesture,
  cancelPagerGesture,
  folderPage,
  visibleCabinetEntries,
  activeDropId,
  folderDrag,
  activateDrop,
  dropIntoFolder,
  handleFolderPointerDown,
  openFolder,
  moveFolderByKeyboard,
  coverResources,
  thumbnailUrls,
  openRename,
  handleCoverFile,
  selectedResourceIds,
  addSelected,
  startDrag,
  handlePointerDown,
  handlePointerMove,
  finishTouchDrag,
  cancelTouchDrag,
  openCabinetResource,
  RESOURCE_TYPE_LABELS,
  folderPageCount,
  setFolderPage,
  openCabinetOrganizer,
  toggleFolderEditMode,
  clearSelection,
  searchQuery,
  trayResources,
  handleResourceClick,
  activeFolderEntry,
  returnToCabinet,
  openOrganizer,
  detailTypeOptions,
  detailType,
  detailQuery,
  visibleDetailResources,
  detailResources,
  detailLimit,
  isOrganizerOpen,
  closeOrganizer,
  organizerDestination,
  organizerType,
  unclassifiedResourceCount,
  organizerTypeOptions,
  organizerResources,
  availableOrganizerResources,
  pinSelected,
  touchDrag,
  orderedCategories,
  renamingCategory,
  closeRename,
  saveRename,
  renameDraft,
  coverUrlDraft,
  folderEditError,
  handleEditCoverFile,
  restoreAutomaticCover,
} = useFolderLibraryView(props, emit)
</script>

<template>
  <FeatureAppHeader
    :title="
      activeFolderId === undefined ? '收藏柜' : (activeFolderEntry?.category?.name ?? '未归档资源')
    "
    :back-label="activeFolderId === undefined ? '返回功能桌面' : '返回收藏柜'"
    @back="activeFolderId === undefined ? emit('back') : returnToCabinet()"
  >
    <template v-if="activeFolderEntry?.category" #actions>
      <button
        class="feature-header-action feature-header-action--icon"
        type="button"
        aria-label="添加资源到当前文件夹"
        title="添加资源"
        :disabled="busy"
        @click="openOrganizer"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
    </template>
  </FeatureAppHeader>
  <section
    ref="cabinetRoot"
    class="folder-library"
    :style="cabinetGridStyle"
    :class="{
      'folder-library--cabinet': activeFolderId === undefined,
      'folder-library--detail': activeFolderId !== undefined,
    }"
    aria-label="收藏柜桌面"
  >
    <template v-if="activeFolderId === undefined">
      <div
        class="folder-library__pager"
        :class="{ 'folder-library__pager--editing': isFolderEditMode }"
        @pointerdown="handlePagerPointerDown"
        @pointermove="handlePagerPointerMove"
        @pointerup="finishPagerGesture"
        @pointercancel="cancelPagerGesture"
      >
        <TransitionGroup
          :key="folderPage"
          name="cabinet-shift"
          tag="div"
          class="folder-library__grid"
        >
          <template v-for="entry in visibleCabinetEntries" :key="entry.id">
            <article
              v-if="entry.kind === 'folder'"
              class="visual-folder"
              :class="{
                'visual-folder--drop': activeDropId === entry.id,
                'visual-folder--editing': isFolderEditMode,
                'visual-folder--dragging': folderDrag?.folderId === entry.id,
              }"
              :data-folder-drop-id="entry.category.id"
              :data-folder-order-id="entry.category.id"
              :data-cabinet-slot="entry.slot"
              :style="{ '--folder-accent': entry.category.color }"
              @dragenter.prevent="activateDrop(entry.category)"
              @dragover.prevent
              @dragleave.self="activeDropId = ''"
              @drop.prevent="dropIntoFolder($event, entry.category.id)"
              @pointerdown="handleFolderPointerDown($event, entry.category)"
            >
              <button
                class="visual-folder__open"
                type="button"
                :aria-label="`${isFolderEditMode ? '调整' : '打开'}${entry.category.name}`"
                @click="openFolder(entry.id)"
                @keydown="moveFolderByKeyboard($event, entry.category.id)"
              >
                <span class="visual-folder__tab" aria-hidden="true"></span>
                <span class="visual-folder__cover">
                  <img
                    v-if="entry.category.coverImage"
                    class="visual-folder__custom-cover"
                    :src="entry.category.coverImage"
                    alt=""
                  />
                  <span
                    v-else-if="coverResources(entry.resources).length"
                    class="visual-folder__mosaic"
                    :class="`visual-folder__mosaic--${coverResources(entry.resources).length}`"
                  >
                    <img
                      v-for="resource in coverResources(entry.resources)"
                      :key="resource.id"
                      :src="thumbnailUrls.get(resource.id)"
                      alt=""
                    />
                  </span>
                  <span v-else class="visual-folder__empty-art" aria-hidden="true">
                    <svg viewBox="0 0 64 64">
                      <path d="M13 19.5h14l4.8 5H51v25H13v-30Z" />
                      <path d="M17.5 16h13l4.3 4.5H47" />
                      <path d="M19 31.5h26M19 37h17" />
                    </svg>
                    <b>{{ entry.category.name.slice(0, 1) }}</b>
                  </span>
                  <span class="visual-folder__sheen" aria-hidden="true"></span>
                </span>
                <span class="visual-folder__identity">
                  <strong>{{ entry.category.name }}</strong>
                  <small>{{ entry.resources.length }} 项资源</small>
                </span>
              </button>

              <button
                v-if="isFolderEditMode"
                class="visual-folder__rename"
                type="button"
                data-folder-action
                :aria-label="`编辑${entry.category.name}的名称和封面`"
                @click="openRename(entry.category)"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m5 16.5-.7 3.2 3.2-.7L18 8.5 15.5 6 5 16.5Z" />
                  <path d="m13.8 7.7 2.5 2.5" />
                </svg>
              </button>

              <div class="visual-folder__actions">
                <label class="visual-folder__cover-action">
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    :disabled="busy"
                    @change="handleCoverFile(entry.category, $event)"
                  />
                  <span>{{ entry.category.coverImage ? '更换封面' : '自定义封面' }}</span>
                </label>
                <button
                  v-if="entry.category.coverImage"
                  type="button"
                  :disabled="busy"
                  @click="emit('cover', { category: entry.category })"
                >
                  恢复自动
                </button>
                <button
                  v-if="selectedResourceIds.size"
                  class="visual-folder__add-selected"
                  type="button"
                  :disabled="busy"
                  @click="addSelected(entry.category.id)"
                >
                  加入 {{ selectedResourceIds.size }} 项
                </button>
              </div>
            </article>
            <article
              v-else-if="entry.kind === 'resource'"
              class="cabinet-resource"
              :class="{ 'cabinet-resource--editing': isFolderEditMode }"
              :data-cabinet-resource-id="entry.resource.id"
              :data-cabinet-slot="entry.slot"
              draggable="true"
              @dragstart="startDrag($event, entry.resource.id, true)"
              @pointerdown="handlePointerDown($event, entry.resource, true)"
              @pointermove="handlePointerMove"
              @pointerup="finishTouchDrag"
              @pointercancel="cancelTouchDrag"
            >
              <button
                type="button"
                :aria-label="`打开资源${entry.resource.name}`"
                @click="openCabinetResource(entry.resource)"
              >
                <span class="cabinet-resource__icon">
                  <img
                    v-if="thumbnailUrls.get(entry.resource.id)"
                    :src="thumbnailUrls.get(entry.resource.id)"
                    alt=""
                  />
                  <strong v-else aria-hidden="true">{{
                    RESOURCE_TYPE_LABELS[entry.resource.type].slice(0, 2)
                  }}</strong>
                </span>
                <span class="cabinet-resource__name">{{ entry.resource.name }}</span>
                <small>{{ RESOURCE_TYPE_LABELS[entry.resource.type] }}</small>
              </button>
              <button
                v-if="isFolderEditMode"
                class="cabinet-resource__remove"
                type="button"
                data-cabinet-action
                :aria-label="`从收藏柜移除${entry.resource.name}`"
                @pointerdown.stop
                @click.stop="emit('unpin', entry.resource.id)"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M7.5 12h9" />
                </svg>
              </button>
            </article>
            <div
              v-else
              class="visual-folder visual-folder--empty-slot"
              :data-cabinet-slot="entry.slot"
              aria-hidden="true"
            ></div>
          </template>
        </TransitionGroup>
      </div>

      <nav v-if="folderPageCount > 1" class="folder-library__pagination" aria-label="文件夹分页">
        <button
          type="button"
          aria-label="上一页文件夹"
          :disabled="folderPage === 0"
          @click="setFolderPage(folderPage - 1)"
        >
          ←
        </button>
        <div>
          <button
            v-for="pageIndex in folderPageCount"
            :key="pageIndex"
            type="button"
            :class="{ 'is-active': folderPage === pageIndex - 1 }"
            :aria-label="`第 ${pageIndex} 页`"
            :aria-current="folderPage === pageIndex - 1 ? 'page' : undefined"
            @click="setFolderPage(pageIndex - 1)"
          ></button>
        </div>
        <span>{{ folderPage + 1 }} / {{ folderPageCount }}</span>
        <button
          type="button"
          aria-label="下一页文件夹"
          :disabled="folderPage === folderPageCount - 1"
          @click="setFolderPage(folderPage + 1)"
        >
          →
        </button>
      </nav>

      <div v-if="isFolderEditMode" class="folder-library__dock" aria-label="收藏柜编辑操作">
        <button class="folder-library__organize" type="button" @click="openCabinetOrganizer">
          <span aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M5 5.5h4v4H5v-4Zm10 0h4v4h-4v-4ZM5 14.5h4v4H5v-4Z" />
              <path d="M16.5 13v6m-2.5-2.5 2.5 2.5 2.5-2.5" />
            </svg>
          </span>
          <small>放入资源</small>
        </button>
        <button
          class="folder-library__edit"
          type="button"
          :class="{ 'is-active': isFolderEditMode }"
          :aria-pressed="isFolderEditMode"
          @click="toggleFolderEditMode"
        >
          <span aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="7.5" />
              <path d="m8.5 12 2.2 2.3 4.8-5" />
            </svg>
          </span>
          <small>完成</small>
        </button>
        <button class="folder-library__manage" type="button" @click="emit('manage')">
          <span aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M4.5 7.5h5.7l1.6 1.8h7.7v9.2h-15v-11Z" />
              <path d="M8 12.5h8m-6 3h6" />
              <circle cx="11" cy="12.5" r="1" />
              <circle cx="14" cy="15.5" r="1" />
            </svg>
          </span>
          <small>新建 / 管理</small>
        </button>
      </div>

      <section class="folder-tray" aria-labelledby="folder-tray-title">
        <header>
          <div>
            <p>RESOURCE TRAY</p>
            <h3 id="folder-tray-title">拖放资源</h3>
            <span>桌面端直接拖动；触屏可长按拖动，也可以打开整理面板。</span>
          </div>
          <button v-if="selectedResourceIds.size" type="button" @click="clearSelection">
            清除 {{ selectedResourceIds.size }} 项选择
          </button>
        </header>
        <label class="folder-tray__search">
          <span aria-hidden="true">⌕</span>
          <input v-model="searchQuery" type="search" placeholder="搜索要添加的资源" />
        </label>
        <div v-if="trayResources.length" class="folder-tray__rail">
          <button
            v-for="resource in trayResources"
            :key="resource.id"
            class="folder-tray__resource"
            :class="{ 'folder-tray__resource--selected': selectedResourceIds.has(resource.id) }"
            type="button"
            draggable="true"
            :aria-pressed="selectedResourceIds.has(resource.id)"
            @click="handleResourceClick(resource.id)"
            @dragstart="startDrag($event, resource.id)"
            @pointerdown="handlePointerDown($event, resource)"
            @pointermove="handlePointerMove"
            @pointerup="finishTouchDrag"
            @pointercancel="cancelTouchDrag"
          >
            <span class="folder-tray__thumb">
              <img
                v-if="thumbnailUrls.get(resource.id)"
                :src="thumbnailUrls.get(resource.id)"
                alt=""
              />
              <i v-else>{{ RESOURCE_TYPE_LABELS[resource.type].slice(0, 1) }}</i>
            </span>
            <span>
              <strong>{{ resource.name }}</strong>
              <small>{{ RESOURCE_TYPE_LABELS[resource.type] }}</small>
            </span>
            <b aria-hidden="true">{{ selectedResourceIds.has(resource.id) ? '✓' : '⋮⋮' }}</b>
          </button>
        </div>
        <p v-else class="folder-tray__empty">没有找到可整理的资源。</p>
      </section>
    </template>

    <section
      v-else-if="activeFolderEntry"
      class="folder-detail"
      :style="{ '--folder-accent': activeFolderEntry.category?.color ?? 'var(--color-ink-soft)' }"
    >
      <label class="folder-detail__search">
        <span aria-hidden="true">⌕</span>
        <input
          v-model="detailQuery"
          type="search"
          placeholder="在当前文件夹中搜索"
          aria-label="在当前文件夹中搜索"
        />
      </label>

      <div v-if="detailTypeOptions.length > 1" class="folder-type-filter" aria-label="资源类型筛选">
        <button
          type="button"
          :class="{ 'is-active': detailType === 'all' }"
          :aria-pressed="detailType === 'all'"
          @click="detailType = 'all'"
        >
          全部 <small>{{ activeFolderEntry.resources.length }}</small>
        </button>
        <button
          v-for="option in detailTypeOptions"
          :key="option.type"
          type="button"
          :class="{ 'is-active': detailType === option.type }"
          :aria-pressed="detailType === option.type"
          @click="detailType = option.type"
        >
          {{ option.label }} <small>{{ option.count }}</small>
        </button>
      </div>

      <div v-if="visibleDetailResources.length" class="folder-detail__grid">
        <button
          v-for="resource in visibleDetailResources"
          :key="resource.id"
          class="folder-detail__resource"
          type="button"
          @click="emit('openResource', resource)"
        >
          <span class="folder-detail__thumb">
            <img
              v-if="thumbnailUrls.get(resource.id)"
              :src="thumbnailUrls.get(resource.id)"
              alt=""
            />
            <i v-else>{{ RESOURCE_TYPE_LABELS[resource.type].slice(0, 1) }}</i>
          </span>
          <span>
            <strong>{{ resource.name }}</strong>
            <small>{{ RESOURCE_TYPE_LABELS[resource.type] }}</small>
          </span>
        </button>
      </div>
      <div v-else class="folder-detail__empty">
        <strong>{{
          detailQuery || detailType !== 'all' ? '没有匹配的资源' : '这个文件夹还是空的'
        }}</strong>
        <span v-if="activeFolderEntry.category">点击右上角“+”添加资源。</span>
      </div>
      <button
        v-if="visibleDetailResources.length < detailResources.length"
        class="folder-detail__more"
        type="button"
        @click="detailLimit += 24"
      >
        再显示 {{ Math.min(24, detailResources.length - visibleDetailResources.length) }} 项
      </button>
    </section>

    <Teleport to="body">
      <div
        v-if="isOrganizerOpen"
        class="folder-organizer mobile-dialog-viewport"
        role="presentation"
        @click.self="closeOrganizer"
      >
        <section
          class="folder-organizer__sheet"
          role="dialog"
          aria-modal="true"
          aria-labelledby="folder-organizer-title"
        >
          <header>
            <div>
              <h2 id="folder-organizer-title">
                {{ organizerDestination === 'cabinet' ? '放入收藏柜' : '添加资源' }}
              </h2>
              <span>{{
                organizerDestination === 'cabinet'
                  ? '选择要放到收藏柜桌面的资源。'
                  : `所选资源将加入“${activeFolderEntry?.category?.name}”，原有文件夹归属会保留。`
              }}</span>
            </div>
            <button
              ref="organizerCloseButton"
              class="folder-organizer__close"
              type="button"
              aria-label="关闭添加资源"
              @click="closeOrganizer"
            >
              ×
            </button>
          </header>

          <div
            v-if="availableOrganizerResources.length"
            class="folder-type-filter folder-type-filter--organizer"
            aria-label="待整理资源类型筛选"
          >
            <button
              type="button"
              :class="{ 'is-active': organizerType === 'unclassified' }"
              :aria-pressed="organizerType === 'unclassified'"
              @click="organizerType = 'unclassified'"
            >
              未分类 <small>{{ unclassifiedResourceCount }}</small>
            </button>
            <button
              type="button"
              :class="{ 'is-active': organizerType === 'all' }"
              :aria-pressed="organizerType === 'all'"
              @click="organizerType = 'all'"
            >
              全部 <small>{{ availableOrganizerResources.length }}</small>
            </button>
            <button
              v-for="option in organizerTypeOptions"
              :key="option.type"
              type="button"
              :class="{ 'is-active': organizerType === option.type }"
              :aria-pressed="organizerType === option.type"
              @click="organizerType = option.type"
            >
              {{ option.label }} <small>{{ option.count }}</small>
            </button>
          </div>

          <label class="folder-tray__search">
            <span aria-hidden="true">⌕</span>
            <input v-model="searchQuery" type="search" placeholder="搜索要添加的资源" />
          </label>

          <div class="folder-organizer__selection" role="status" aria-live="polite">
            <span class="folder-organizer__step">
              <span>
                <small>选择资源</small>
                <strong>已选 {{ selectedResourceIds.size }} 项</strong>
              </span>
            </span>
            <button v-if="selectedResourceIds.size" type="button" @click="clearSelection">
              清除
            </button>
          </div>

          <div v-if="organizerResources.length" class="folder-organizer__resources">
            <button
              v-for="resource in organizerResources"
              :key="resource.id"
              class="folder-organizer__resource"
              :class="{
                'folder-organizer__resource--selected': selectedResourceIds.has(resource.id),
              }"
              type="button"
              :aria-pressed="selectedResourceIds.has(resource.id)"
              @click="handleResourceClick(resource.id)"
              @pointerdown="handlePointerDown($event, resource)"
              @pointermove="handlePointerMove"
              @pointerup="finishTouchDrag"
              @pointercancel="cancelTouchDrag"
            >
              <span class="folder-tray__thumb">
                <img
                  v-if="thumbnailUrls.get(resource.id)"
                  :src="thumbnailUrls.get(resource.id)"
                  alt=""
                />
                <i v-else>{{ RESOURCE_TYPE_LABELS[resource.type].slice(0, 1) }}</i>
              </span>
              <span>
                <strong>{{ resource.name }}</strong>
                <small>{{ RESOURCE_TYPE_LABELS[resource.type] }}</small>
              </span>
              <b aria-hidden="true">{{ selectedResourceIds.has(resource.id) ? '✓' : '⋮⋮' }}</b>
            </button>
          </div>
          <p v-else class="folder-tray__empty">
            {{
              !availableOrganizerResources.length
                ? '当前没有可添加的资源。'
                : organizerType === 'unclassified'
                  ? '没有未分类资源。'
                  : '没有找到匹配的资源。'
            }}
          </p>

          <footer
            v-if="organizerDestination === 'cabinet'"
            class="folder-organizer__cabinet-action"
          >
            <button
              type="button"
              :disabled="busy || !selectedResourceIds.size"
              @click="pinSelected"
            >
              放到收藏柜桌面（{{ selectedResourceIds.size }}）
            </button>
          </footer>
          <footer v-else-if="activeFolderEntry?.category" class="folder-organizer__folder-action">
            <button
              type="button"
              :disabled="busy || !selectedResourceIds.size"
              @click="addSelected(activeFolderEntry.category.id)"
            >
              添加到当前文件夹（{{ selectedResourceIds.size }}）
            </button>
          </footer>
        </section>
      </div>

      <div
        v-if="touchDrag"
        class="folder-touch-drag"
        :style="{ '--drag-x': `${touchDrag.x}px`, '--drag-y': `${touchDrag.y}px` }"
        aria-hidden="true"
      >
        <span>↗</span>
        {{ touchDrag.label }}
      </div>

      <div
        v-if="folderDrag"
        class="folder-order-drag"
        :style="{ '--drag-x': `${folderDrag.x}px`, '--drag-y': `${folderDrag.y}px` }"
        aria-hidden="true"
      >
        <span>移动</span>
        {{ orderedCategories.find((category) => category.id === folderDrag?.folderId)?.name }}
      </div>

      <div
        v-if="renamingCategory"
        class="folder-rename mobile-dialog-viewport"
        role="presentation"
        @click.self="closeRename"
      >
        <form
          class="folder-rename__sheet"
          role="dialog"
          aria-modal="true"
          aria-labelledby="folder-rename-title"
          @submit.prevent="saveRename"
        >
          <p>EDIT FOLDER</p>
          <h2 id="folder-rename-title">编辑文件夹</h2>
          <label>
            <span>名称</span>
            <input ref="renameInput" v-model="renameDraft" maxlength="40" autocomplete="off" />
          </label>
          <label>
            <span>HTTPS 封面直链</span>
            <input
              v-model="coverUrlDraft"
              type="url"
              inputmode="url"
              maxlength="2048"
              placeholder="https://example.com/cover.webp"
              autocomplete="off"
            />
          </label>
          <p v-if="folderEditError" class="folder-rename__error" role="alert">
            {{ folderEditError }}
          </p>
          <div class="folder-rename__cover-actions">
            <label>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                :disabled="busy"
                @change="handleEditCoverFile"
              />
              <span>导入本地图片</span>
            </label>
            <button
              v-if="renamingCategory.coverImage"
              type="button"
              :disabled="busy"
              @click="restoreAutomaticCover"
            >
              恢复自动拼贴
            </button>
          </div>
          <footer>
            <button type="button" @click="closeRename">取消</button>
            <button type="submit" :disabled="busy || !renameDraft.trim()">保存</button>
          </footer>
        </form>
      </div>
    </Teleport>
  </section>
</template>
<style src="../styles/FolderLibrary.css"></style>
