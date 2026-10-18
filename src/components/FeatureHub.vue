<script setup lang="ts">
import { computed, onUnmounted, provide, ref, toRef, watch } from 'vue'
import type { UiApplyOptions } from '../types/UiCustomization'
import {
  createFolderThumbnailCache,
  folderThumbnailCacheKey,
} from '../composables/FolderThumbnailCache'
import FeatureAppIcon from './FeatureAppIcon.vue'
import ActionSheet from './ActionSheet.vue'
import FeatureShell from './FeatureShell.vue'
import FeatureStateView from './FeatureStateView.vue'
import FolderLibraryView from './FolderLibraryView.vue'
import {
  useFeatureHub,
  type FeatureHubProps,
  type FeatureHubEvents,
} from '../composables/UseFeatureHub'
const props = withDefaults(defineProps<FeatureHubProps>(), { active: true })
const folderThumbnailCache = createFolderThumbnailCache()
provide(folderThumbnailCacheKey, folderThumbnailCache)
watch(
  () => props.active,
  (active) => {
    if (!active) folderThumbnailCache.clear()
  },
  { flush: 'sync' },
)
watch(
  () => props.resources,
  (resources) => folderThumbnailCache.prune(resources),
  { flush: 'sync' },
)
onUnmounted(() => folderThumbnailCache.clear())
const emit = defineEmits<FeatureHubEvents>()
function saveAppearance(value: string, options?: UiApplyOptions) {
  if (options) emit('save-css', value, options)
  else emit('save-css', value)
}
const controller = useFeatureHub(props, emit)
const assistantPages = ref<Array<'appearance' | 'assistant'>>([])
const assistantVisibility = ref({ appearance: false, assistant: false })
const assistantActivity = ref({ appearance: false, assistant: false })
const assistantBusy = computed(() =>
  assistantPages.value.some((page) => assistantActivity.value[page]),
)
const assistantVisible = computed(
  () =>
    props.active !== false &&
    (activePage.value === 'appearance' || activePage.value === 'assistant') &&
    assistantVisibility.value[activePage.value],
)
function setAssistantVisible(value: boolean, page: 'appearance' | 'assistant') {
  assistantVisibility.value[page] = value
}
function setAssistantActivity(value: boolean, page: 'appearance' | 'assistant') {
  assistantActivity.value[page] = value
}
function forwardImportFiles(files: File[], onComplete?: () => void): void {
  emit('import-files', files, onComplete)
}
const {
  activePage,
  desktopFilterOpen,
  desktopFilterButtonLabel,
  currentFeatureDesktopEntries,
  handleDesktopPointerDown,
  handleDesktopPointerUp,
  featureDesktopEntryKey,
  featureDesktopEntryClass,
  isFeatureDesktopEntryPinned,
  featureDesktopEntryName,
  handleFeatureDesktopEntryClick,
  openFeatureDesktopEntry,
  assistantNavigationTargets,
  navigateAssistant,
  handleFeatureDesktopEntryPointerDown,
  handleFeatureDesktopEntryPointerMove,
  handleFeatureDesktopEntryPointerEnd,
  featureDesktopEntryIconClass,
  featureDesktopEntryDescription,
  featureDesktopEntryBadge,
  featureDesktopPageCount,
  desktopPage,
  setFeatureDesktopPage,
  desktopFilterActions,
  selectDesktopFilter,
  DrawApp,
  OfficialAppManager,
  AppearanceStudio,
  TavernBridgeCenter,
  PresetStitcherApp,
  FrontendWorkshopApp,
  ImageGenerationApp,
  GeneratedImageAlbumApp,
  UserPersonaApp,
  ChatReaderApp,
  ExternalAppManager,
  handleExternalAppsChanged,
  handleExternalAppInstalled,
  activeExternalAppId,
  openExternalApp,
  ExternalAppHost,
  CloudBackupCenter,
  DiscordInboxCenter,
} = controller
const desktopPointerStart = toRef(controller, 'desktopPointerStart')
watch(
  activePage,
  (page) => {
    if ((page === 'appearance' || page === 'assistant') && !assistantPages.value.includes(page)) {
      assistantPages.value.push(page)
      emit('assistant-retained')
    }
  },
  { immediate: true },
)
watch(assistantVisible, (visible) => emit('assistant-visibility', visible), { immediate: true })
watch(assistantBusy, (busy) => emit('assistant-activity', busy), { immediate: true })
function forwardAssistantAppearance(
  value: string,
  options?: import('../types/UiCustomization').UiApplyOptions,
) {
  if (options) emit('save-assistant-css', value, options)
  else emit('save-assistant-css', value)
}
</script>

<template>
  <main
    class="feature-hub"
    :class="{
      'feature-hub--app': activePage !== 'home',
      'feature-hub--assistant': assistantVisible,
    }"
    :data-feature-page="activePage"
  >
    <template v-if="active">
      <template v-if="activePage === 'home'">
        <FeatureShell title="功能" back-label="返回资源库" @back="emit('close')">
          <template #actions>
            <button
              class="feature-header-action feature-header-action--ghost"
              type="button"
              @click="activePage = 'officialApps'"
            >
              APP 管理
            </button>
            <button
              class="feature-header-action feature-header-action--ghost"
              type="button"
              aria-label="筛选功能"
              @click="desktopFilterOpen = true"
            >
              {{ desktopFilterButtonLabel }}
            </button>
          </template>
          <section
            v-if="currentFeatureDesktopEntries.length"
            class="feature-desktop"
            aria-label="功能应用"
            @pointerdown="handleDesktopPointerDown"
            @pointerup="handleDesktopPointerUp"
            @pointercancel="desktopPointerStart = undefined"
          >
            <div
              v-for="entry in currentFeatureDesktopEntries"
              :key="featureDesktopEntryKey(entry)"
              :class="featureDesktopEntryClass(entry)"
              class="feature-app"
              role="button"
              tabindex="0"
              :aria-label="
                isFeatureDesktopEntryPinned(entry)
                  ? `${featureDesktopEntryName(entry)}，长按取消收藏`
                  : `${featureDesktopEntryName(entry)}，长按收藏`
              "
              @click="handleFeatureDesktopEntryClick(entry)"
              @contextmenu.prevent
              @keydown.enter="openFeatureDesktopEntry(entry)"
              @keydown.space.prevent="openFeatureDesktopEntry(entry)"
              @pointerdown="handleFeatureDesktopEntryPointerDown(entry, $event)"
              @pointermove="handleFeatureDesktopEntryPointerMove"
              @pointerup="handleFeatureDesktopEntryPointerEnd"
              @pointercancel="handleFeatureDesktopEntryPointerEnd"
              @pointerleave="handleFeatureDesktopEntryPointerEnd"
            >
              <span
                :class="featureDesktopEntryIconClass(entry)"
                class="feature-app__icon"
                aria-hidden="true"
              >
                <FeatureAppIcon v-if="entry.kind === 'builtIn'" :name="entry.app.icon" />
                <img v-else-if="entry.app.iconDataUrl" :src="entry.app.iconDataUrl" alt="" />
                <template v-else><i></i><i></i><i></i></template>
              </span>
              <strong>{{ featureDesktopEntryName(entry) }}</strong>
              <small>{{ featureDesktopEntryDescription(entry) }}</small>
              <em>{{ featureDesktopEntryBadge(entry) }}</em>
            </div>
          </section>
          <FeatureStateView v-else state="empty" title="还没有可用功能" />
          <nav
            v-if="featureDesktopPageCount > 1"
            class="feature-desktop__pagination"
            aria-label="功能应用分页"
          >
            <button
              type="button"
              aria-label="上一页应用"
              :disabled="desktopPage === 0"
              @click="setFeatureDesktopPage(desktopPage - 1)"
            >
              ‹
            </button>
            <button
              v-for="page in featureDesktopPageCount"
              :key="page"
              class="feature-desktop__page-dot"
              :class="{ 'is-active': desktopPage === page - 1 }"
              type="button"
              :aria-label="`第 ${page} 页应用`"
              :aria-current="desktopPage === page - 1 ? 'page' : undefined"
              @click="setFeatureDesktopPage(page - 1)"
            ></button>
            <button
              type="button"
              aria-label="下一页应用"
              :disabled="desktopPage === featureDesktopPageCount - 1"
              @click="setFeatureDesktopPage(desktopPage + 1)"
            >
              ›
            </button>
          </nav>
        </FeatureShell>
        <ActionSheet
          v-model:open="desktopFilterOpen"
          title="筛选功能"
          :actions="desktopFilterActions"
          @select="selectDesktopFilter"
        />
      </template>

      <DiscordInboxCenter
        v-else-if="activePage === 'inbox'"
        @back="activePage = 'home'"
        @open-resource="emit('openResource', $event)"
      />
      <!-- SRL-PUBLIC-SYNC: BEGIN PUBLIC-ONLY id=official-app-manager-route -->
      <OfficialAppManager v-else-if="activePage === 'officialApps'" @back="activePage = 'home'" />
      <!-- SRL-PUBLIC-SYNC: END PUBLIC-ONLY id=official-app-manager-route -->
      <DrawApp
        v-else-if="activePage === 'draw'"
        v-bind="props"
        @back="activePage = 'home'"
        @close="emit('close')"
        @open-resource="emit('openResource', $event)"
      />
      <template v-else-if="activePage === 'folders'">
        <FolderLibraryView
          :categories="categories"
          :resources="resources"
          :busy="folderBusy"
          :cabinet-resource-ids="cabinetResourceIds"
          @back="activePage = 'home'"
          @open-resource="emit('openResource', $event)"
          @manage="emit('manageFolders')"
          @add="emit('folderAdd', $event)"
          @cover="emit('folderCover', $event)"
          @rename="emit('folderRename', $event)"
          @reorder="emit('folderReorder', $event)"
          @pin="emit('cabinetPin', $event)"
          @unpin="emit('cabinetUnpin', $event)"
        />
      </template>

      <TavernBridgeCenter
        v-else-if="activePage === 'tavernBridge'"
        :resources="resources"
        :categories="categories"
        @back="activePage = 'home'"
        @import-files="forwardImportFiles"
      />
      <PresetStitcherApp
        v-else-if="activePage === 'stitch'"
        :resources="resources"
        :categories="categories"
        @back="activePage = 'home'"
        @library-changed="emit('library-changed')"
      />
      <FrontendWorkshopApp
        v-else-if="activePage === 'frontendWorkshop'"
        @back="activePage = 'home'"
        @library-changed="emit('library-changed')"
      />
      <ImageGenerationApp
        v-else-if="activePage === 'imageGeneration'"
        @back="activePage = 'home'"
        @open-album="activePage = 'imageAlbum'"
      />
      <GeneratedImageAlbumApp v-else-if="activePage === 'imageAlbum'" @back="activePage = 'home'" />
      <UserPersonaApp
        v-else-if="activePage === 'userPersona'"
        :resources="resources"
        :categories="categories"
        @back="activePage = 'home'"
        @library-changed="emit('library-changed')"
        @open-history="emit('openPersonaHistory', $event)"
      />
      <ChatReaderApp v-else-if="activePage === 'chatReader'" @back="activePage = 'home'" />
      <ExternalAppManager
        v-else-if="activePage === 'extensions'"
        :shared-files="sharedAppFiles ?? []"
        @back="activePage = 'home'"
        @changed="handleExternalAppsChanged"
        @installed="handleExternalAppInstalled"
        @open="openExternalApp"
        @shared-files-consumed="emit('shared-app-files-consumed')"
      />
      <ExternalAppHost
        v-else-if="activePage === 'externalApp' && activeExternalAppId"
        :app-id="activeExternalAppId"
        @back="activePage = 'home'"
      />
      <CloudBackupCenter
        v-else-if="activePage === 'cloud'"
        :resource-count="resources.length"
        :resources="resources"
        :categories="categories"
        @back="activePage = 'home'"
        @library-changed="emit('library-changed', $event)"
      />
    </template>
    <AppearanceStudio
      v-for="assistantPage in assistantPages"
      v-show="active !== false && activePage === assistantPage"
      :key="assistantPage"
      :active="active !== false && activePage === assistantPage"
      :assistant-only="assistantPage === 'assistant'"
      :navigation-targets="assistantNavigationTargets"
      :navigate="navigateAssistant"
      :theme="theme"
      :layout-mode="layoutMode"
      :mobile-card-orientation="mobileCardOrientation"
      :mobile-card-fit-mode="mobileCardFitMode"
      :resource-card-height-mode="resourceCardHeightMode"
      :no-image-resource-cover-mode="noImageResourceCoverMode"
      :ui-font-scale="uiFontScale"
      :custom-css="customCss"
      @back="activePage = 'home'"
      @update:theme="emit('update:theme', $event)"
      @update:layout-mode="emit('update:layoutMode', $event)"
      @update:mobile-card-orientation="emit('update:mobileCardOrientation', $event)"
      @update:mobile-card-fit-mode="emit('update:mobileCardFitMode', $event)"
      @update:resource-card-height-mode="emit('update:resourceCardHeightMode', $event)"
      @update:no-image-resource-cover-mode="emit('update:noImageResourceCoverMode', $event)"
      @update:ui-font-scale="emit('update:uiFontScale', $event)"
      @save-css="saveAppearance"
      @save-assistant-css="forwardAssistantAppearance"
      @preview-css="emit('preview-css', $event)"
      @assistant-visibility="setAssistantVisible($event, assistantPage)"
      @assistant-activity="setAssistantActivity($event, assistantPage)"
    />
  </main>
</template>

<style src="../styles/FeatureDesktop.css"></style>
