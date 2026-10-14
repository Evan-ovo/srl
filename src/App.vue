<script setup lang="ts">
import './Styles.css'
import { discordSetupSession } from './services/AssistantBrowserRuntime'
import './styles/DuplicateCleaner.css'
import { useCustomUiViews } from './composables/UseCustomUiViews'
import ProductAssistantGuidance from './components/ProductAssistantGuidance.vue'
import { startAssistantGuidance } from './core/ProductAssistantGuidance'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { secretResourceService } from './services/SecretResourceService'
onBeforeUnmount(() => secretResourceService.lock())
import { secretPasswordRequest } from './composables/UseSecretPasswordPrompt'
const SecretPasswordDialog = createAsyncPanel(
  '密钥密码',
  () => import('./components/SecretPasswordDialog.vue'),
)
import LibraryLinkImportPanel from './components/LibraryLinkImportPanel.vue'
import CategoryManager from './components/CategoryManager.vue'
import DataVaultPanel from './components/DataVaultPanel.vue'
import FeatureBackButton from './components/FeatureBackButton.vue'
import { createAsyncPanel } from './core/AsyncPanel'
const loadAiTaggingPanel = () => import('./components/AiTaggingPanel.vue')
const AiTaggingPanel = createAsyncPanel('AI 标签实验台', loadAiTaggingPanel, { modal: true })
const ExportPanel = createAsyncPanel('导出', () => import('./components/ExportPanel.vue'))
const FeatureHub = createAsyncPanel('功能桌面', () => import('./components/FeatureHub.vue'))
const customUiViews = useCustomUiViews()
const UiCustomizationHost = createAsyncPanel(
  '自定义界面',
  () => import('./components/UiCustomizationHost.vue'),
)
const ProductAssistantPet = createAsyncPanel(
  '蒜惹菈',
  () => import('./components/ProductAssistantPet.vue'),
)
import { useProductAssistantPreferences } from './composables/UseProductAssistantPreferences'
import {
  ASSISTANT_LIBRARY_DESTINATIONS,
  getAssistantNavigationTargets,
} from './core/FeatureAppRegistry'
const assistantPreferences = useProductAssistantPreferences()
const fullAssistantVisible = ref(false)
const assistantBusy = ref(false)
const assistantDestination = ref<string>()
const assistantPetChatRequest = ref(0)
const NativeExportDialog = createAsyncPanel(
  '保存文件',
  () => import('./components/NativeExportDialog.vue'),
)
const LayoutSettingsPanel = createAsyncPanel(
  '设置',
  () => import('./components/LayoutSettingsPanel.vue'),
)
const ResourceOrganizer = createAsyncPanel(
  '资源详情',
  () => import('./components/ResourceOrganizer.vue'),
)
const RestorePanel = createAsyncPanel('恢复', () => import('./components/RestorePanel.vue'))
const VersionImportDialog = createAsyncPanel(
  '版本导入',
  () => import('./components/VersionImportDialog.vue'),
)
const DuplicateCleaner = createAsyncPanel(
  '重复清理',
  () => import('./components/DuplicateCleaner.vue'),
)
const SimilarNameGroups = createAsyncPanel(
  '名称相似资源',
  () => import('./components/SimilarNameGroups.vue'),
)
const ExtractedAssetCleaner = createAsyncPanel(
  '清理拆分副本',
  () => import('./components/ExtractedAssetCleaner.vue'),
)
const ParsedCharacterTagCleaner = createAsyncPanel(
  '清理自动解析标签',
  () => import('./components/ParsedCharacterTagCleaner.vue'),
)
const RecycleBinPanel = createAsyncPanel('回收站', () => import('./components/RecycleBinPanel.vue'))
const VersionRecognitionPanel = createAsyncPanel(
  '历史版本重识别',
  () => import('./components/VersionRecognitionPanel.vue'),
)
import LibrarySidebar from './components/LibrarySidebar.vue'
import LibraryToolbar from './components/LibraryToolbar.vue'
import LibraryProtectionPanel from './components/LibraryProtectionPanel.vue'
import { proxyRefs, useTemplateRef } from 'vue'
import { usePersonalResourceNavigation } from './composables/UsePersonalResourceNavigation'
const PersonalResourceEditor = createAsyncPanel(
  '个人资源',
  () => import('./components/PersonalResourceEditor.vue'),
)
import BatchBar from './components/BatchBar.vue'
import ProjectActivityCenter from './components/ProjectActivityCenter.vue'
import ResourceCard from './components/ResourceCard.vue'
import ResourceInspector from './components/ResourceInspector.vue'
import ResourceListRow from './components/ResourceListRow.vue'
import { useApp } from './composables/UseApp'
import { nativeFileSize } from './core/NativeFileSource'
import { shouldShowSharedImportRouteChoices } from './utils/ShareTargetIntake'
const controller = useApp()
watch(controller.isBatchMode, (active) => {
  // 进入多选时提前加载下一步界面；失败仍由打开面板时的原错误边界展示。
  if (active) void loadAiTaggingPanel().catch(() => undefined)
})
const panelModel = proxyRefs(controller)
const resourceGridElement = useTemplateRef<HTMLElement>('resourceGrid')
const personalEditor = useTemplateRef<{ requestBack: () => void }>('personalEditor')
const personalOrganizer = useTemplateRef<{ requestClose: () => void }>('personalOrganizer')
const { newPersonalKind, personalSaved, createPersonal, closePersonal } =
  usePersonalResourceNavigation(controller, personalEditor, personalOrganizer)

let uniformCardHeightFrame: number | undefined
function syncUniformResourceCardHeight(): void {
  if (uniformCardHeightFrame !== undefined) cancelAnimationFrame(uniformCardHeightFrame)

  uniformCardHeightFrame = requestAnimationFrame(() => {
    uniformCardHeightFrame = undefined
    const grid = resourceGridElement.value
    if (!grid) return

    const cards = Array.from(grid.querySelectorAll<HTMLElement>('.resource-card'))
    cards.forEach((card) => card.style.removeProperty('min-height'))
    if (resourceCardHeightMode.value !== 'uniform' || layoutMode.value !== 'grid') return

    const tallestCard = Math.max(...cards.map((card) => card.getBoundingClientRect().height), 0)
    if (tallestCard > 0) {
      const uniformHeight = `${Math.ceil(tallestCard)}px`
      cards.forEach((card) => card.style.setProperty('min-height', uniformHeight))
    }
  })
}

const {
  layoutMode,
  mobileCardOrientation,
  mobileCardFitMode,
  resourceCardHeightMode,
  noImageResourceCoverMode,
  isBatchMode,
  vaultStatus,
  isSystemFileDropActive,
  batchBarHeight,
  isFeatureAppActive,
  handleSystemFileDragOver,
  handleSystemFileDragLeave,
  handleSystemFileDrop,
  isFeatureHubOpen,
  isOverlayOpen,
  theme,
  applyTheme,
  activeFilter,
  isCategoryManagerOpen,
  activeCategoryId,
  activeTag,
  openFeatureHub,
  openAssistantDestination,
  isSettingsOpen,
  isExporting,
  isExportPanelOpen,
  isBusy,
  formatBytes,
  openImportChooser,
  handleImport,
  handleTavernBackupImport,
  handleLibraryBackupImport,
  handleResourceArchiveImport,
  pendingSharedFileBatch,
  chooseSharedImportRoute,
  downloadSharedDiscordAttachmentNow,
  cancelSharedDiscordAttachment,
  sharedAppImportFiles,
  handleSharedAppFilesConsumed,
  isImportChooserOpen,
  isLinkImportOpen,
  closeImportChooser,
  openLinkImportPanel,
  openFileImportPicker,
  openResourceArchivePicker,
  openLibraryBackupPicker,
  openTavernBackupPicker,
  statistics,
  backupOverdue,
  backupRecommended,
  isDataProtectionOpen,
  storageProtectionStatus,
  recycleBinEntries,
  isDuplicateCleanerOpen,
  isSimilarNameGroupsOpen,
  activeResourceIds,
  showSimilarResources,
  isExtractedCleanerOpen,
  isParsedTagCleanerOpen,
  hasBrowsingState,
  handleBrowseBack,
  activeFilterLabel,
  activeCategoryLabel,
  searchQuery,
  cancelSearchInput,
  clearBrowsingState,
  filteredResourceCount,
  activeScopeLabel,
  toggleBatchMode,
  paginatedResources,
  categoriesForResource,
  selectedResourceIds,
  blurThumbnails,
  autoDownloadDiscordShareLinks,
  persistResourceVersionMatchCache,
  skipVersionComparisonOnImport,
  sameNameVersionCandidates,
  handleFavorite,
  openResourceFromLayout,
  toggleResourceSelection,
  handleDelete,
  RESOURCE_LIST_COLUMNS,
  selectedSplitResourceId,
  selectedSplitResource,
  selectedSplitCategories,
  selectedSplitRelations,
  openResourceDetail,
  handleResourceDownload,
  copyResourceDeepLink,
  pageSize,
  currentPage,
  totalPages,
  managedResources,
  duplicateResources,
  visibleLibraryResources,
  organizingVersions,
  organizingInitialTab,
  categories,
  uiFontScale,
  customUiCss,
  isFolderViewBusy,
  cabinetResourceIds,
  openFolderManagerFromFeatureHub,
  handleFolderAdd,
  handleFolderCover,
  handleFolderRename,
  handleFolderReorder,
  handleCabinetPin,
  handleCabinetUnpin,
  applyLayoutMode,
  applyMobileCardOrientation,
  applyMobileCardFitMode,
  applyResourceCardHeightMode,
  applyNoImageResourceCoverMode,
  applyUiFontScale,
  saveCustomUiCss,
  handleLibraryChanged,
  importResourceFiles,
  selectMobileDestination,
  notice,
  recycleUndoEntry,
  handleRestoreRecycleBinEntry,
  allVisibleSelected,
  batchSelectionScope,
  batchSelectionScopeLabel,
  allBatchScopeSelected,
  selectedCharacterCount,
  isBatchBusy,
  toggleVisibleSelection,
  toggleBatchScopeSelection,
  handleBatchExtractCharacterAssets,
  handleBatchFavorite,
  handleBatchMove,
  handleBatchTag,
  openAiTagging,
  handleBatchDelete,
  isAiTaggingOpen,
  handleAiTagsApplied,
  isRecycleBinOpen,
  isRecycleBinBusy,
  handlePurgeRecycleBinEntry,
  handleEmptyRecycleBin,
  organizingResource,
  organizingBoundResources,
  isOrganizing,
  closeResourceDetail,
  handleRelatedDownload,
  handleActivateVersion,
  handleDeleteResourceVersion,
  handleDetachResourceVersion,
  handleUpdateVersionNote,
  handleMergeExistingVersion,
  handleReplaceCharacterCardArtwork,
  handleDetailSave,
  pendingNativeExport,
  isNativeExportBusy,
  handleNativeExportSelection,
  sharePendingNativeExport,
  activeVersionImport,
  pendingVersionImports,
  isVersionImportBusy,
  versionImportComparison,
  versionImportComparingId,
  handleVersionImportCompare,
  closeVersionImportCompare,
  handleVersionImportDecision,
  settingsPanelKey,
  previewPolicy,
  extractCharacterAssets,
  hideCharacterAssets,
  hideChatDisplayRegex,
  showManuallyBoundResources,
  showPerformanceMonitor,
  hiddenCharacterAssetCount,
  applyRemotePreviewPolicy,
  applyScriptPreviewPolicy,
  applyGreetingPreviewPreload,
  applyBeautificationPreviewPreload,
  applyIncreasedPreviewDownloads,
  applyExtractCharacterAssets,
  applyHideCharacterAssets,
  applyHideChatDisplayRegex,
  applyShowManuallyBoundResources,
  applyBlurThumbnails,
  applyAutoDownloadDiscordShareLinks,
  applyPersistResourceVersionMatchCache,
  applySkipVersionComparisonOnImport,
  applySameNameVersionCandidates,
  updatePerformanceMonitorVisibility,
  openFolderSettings,
  openVaultSettings,
  openVersionRecognition,
  handleManualUpdateCheck,
  categoryManagerKey,
  handleCategoryCreate,
  handleCategoryUpdate,
  handleCategoryVisibility,
  handleCategoryDelete,
  openRestorePanel,
  handleExport,
  isRestorePanelOpen,
  preparedRestore,
  restoreReport,
  isRestoring,
  isRestorePreflighting,
  stopRestoreInspection,
  restoreEntry,
  completedRestoreMode,
  handleRestoreInspect,
  handleRestoreConfirm,
  closeRestorePanel,
  isVaultPanelOpen,
  isVaultBusy,
  handleVaultUnlock,
  handleVaultEnable,
  handleVaultDisable,
  handleVaultLock,
  isVersionRecognitionOpen,
  refreshLibraryAndOpenVersions,
} = controller

const assistantHubRetained = ref(false)
const assistantFeatureHubProps = computed(() => ({
  navigateLibrary: navigateAssistantLibrary,
  assistantDestination: assistantDestination.value,
  sharedAssistantChat:
    Boolean(assistantPreferences.value.desktopPet) ||
    (discordSetupSession.active && discordSetupSession.purpose !== 'general'),
}))
const assistantFeatureHubListeners = computed(() => ({
  'assistant-destination-consumed': () => (assistantDestination.value = undefined),
  'assistant-visibility': (value: boolean) => (fullAssistantVisible.value = value),
  'assistant-activity': (value: boolean) => (assistantBusy.value = value),
  'assistant-retained': () => (assistantHubRetained.value = true),
  'open-assistant-chat': () => (assistantPetChatRequest.value += 1),
  'save-assistant-css': saveAssistantAppearance,
}))
function saveAssistantAppearance(
  value: string,
  options?: import('./types/UiCustomization').UiApplyOptions,
) {
  saveCustomUiCss(value, { ...options, assistant: true })
}

watch(
  [
    paginatedResources,
    resourceCardHeightMode,
    noImageResourceCoverMode,
    layoutMode,
    mobileCardOrientation,
    mobileCardFitMode,
    uiFontScale,
    isFeatureHubOpen,
  ],
  syncUniformResourceCardHeight,
  { flush: 'post', immediate: true },
)
watch(resourceGridElement, syncUniformResourceCardHeight, { flush: 'post' })
onMounted(() => {
  window.addEventListener('resize', syncUniformResourceCardHeight)
  syncUniformResourceCardHeight()
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', syncUniformResourceCardHeight)
  if (uniformCardHeightFrame !== undefined) cancelAnimationFrame(uniformCardHeightFrame)
})

type ImportChooserStep = 'home' | 'resource' | 'backup' | 'other'
const importChooserStep = ref<ImportChooserStep>('home')

function openImportMenu(): void {
  importChooserStep.value = 'home'
  openImportChooser()
}

async function navigateAssistantLibrary(id: string): Promise<void> {
  if (id === 'import') importChooserStep.value = 'home'
  openAssistantDestination(id)
}

function closeFeatureHub() {
  isFeatureHubOpen.value = false
  fullAssistantVisible.value = false
}
async function navigatePetDestination(id: string, guide?: string): Promise<void> {
  if (ASSISTANT_LIBRARY_DESTINATIONS.some((item) => item.id === id)) {
    await navigateAssistantLibrary(id)
    if (guide) startAssistantGuidance(guide, id)
    return
  }
  if (id !== 'assistant' && !getAssistantNavigationTargets().some((item) => item.id === id))
    throw new Error('这个界面的入口暂不可用')
  assistantDestination.value = id
  openFeatureHub()
  if (guide) startAssistantGuidance(guide, id)
}

function returnToImportMenu(): void {
  if (isLinkImportOpen.value) isLinkImportOpen.value = false
  else importChooserStep.value = 'home'
}

function selectPageInput(event: FocusEvent): void {
  const input = event.currentTarget as HTMLInputElement
  input.select()
}

function jumpToLibraryPage(event: Event): void {
  const input = event.currentTarget as HTMLInputElement
  const requestedPage = /^\d+$/u.test(input.value) ? Number(input.value) : Number.NaN
  if (Number.isSafeInteger(requestedPage)) {
    currentPage.value = Math.min(totalPages.value, Math.max(1, requestedPage))
  }
  input.value = String(currentPage.value)
}

const isBatchBarVisible = computed(
  () =>
    isBatchMode.value &&
    !isFeatureHubOpen.value &&
    !isFeatureAppActive.value &&
    !organizingResource.value &&
    !newPersonalKind.value &&
    !isAiTaggingOpen.value &&
    !isRecycleBinOpen.value &&
    !isDuplicateCleanerOpen.value &&
    !isSimilarNameGroupsOpen.value &&
    !isExtractedCleanerOpen.value &&
    !isParsedTagCleanerOpen.value &&
    !isVersionRecognitionOpen.value &&
    !isCategoryManagerOpen.value &&
    !isSettingsOpen.value &&
    !isExportPanelOpen.value &&
    !isRestorePanelOpen.value &&
    !isVaultPanelOpen.value &&
    !isImportChooserOpen.value &&
    !isLinkImportOpen.value &&
    !activeVersionImport.value &&
    !pendingNativeExport.value &&
    !secretPasswordRequest.value,
)
</script>

<template>
  <div
    class="app-shell"
    :style="{
      '--batch-bar-reserved': `${isBatchBarVisible ? batchBarHeight : 0}px`,
      '--bottom-nav-reserved': isFeatureAppActive ? '0px' : undefined,
    }"
    :class="[
      `app-shell--layout-${layoutMode}`,
      {
        'app-shell--batch': isBatchBarVisible,
        'app-shell--vault-locked': vaultStatus.locked,
        'app-shell--system-file-drop': isSystemFileDropActive,
      },
    ]"
    @dragover="handleSystemFileDragOver"
    @dragleave="handleSystemFileDragLeave"
    @drop="handleSystemFileDrop"
  >
    <div v-if="isSystemFileDropActive" class="app-shell__system-file-drop" role="status">
      松开以导入角色卡、世界书或 SRL ZIP
    </div>
    <LibrarySidebar :model="panelModel" />

    <main
      v-show="!isFeatureHubOpen"
      class="library"
      :inert="isFeatureHubOpen || undefined"
      :aria-hidden="isFeatureHubOpen || undefined"
    >
      <header class="library__header">
        <div>
          <h1 class="library__title">你的私人资源档案</h1>
          <p class="library__subtitle">没有上传，没有追踪。资源只在你的设备中整理和流转。</p>
        </div>

        <div class="library__header-actions">
          <button
            class="feature-hub-trigger"
            type="button"
            title="打开功能桌面"
            @click="openFeatureHub"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 0h6v6h-6v-6Z" />
            </svg>
            <span>功能</span>
          </button>
          <button
            class="layout-settings-trigger"
            type="button"
            aria-label="打开设置"
            title="设置"
            @click="isSettingsOpen = true"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M12 8.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7Zm0-5 1 2.1 2.3.6 1.9-1.3 1.9 1.9-1.3 1.9.6 2.3 2.1 1v2.7l-2.1 1-.6 2.3 1.3 1.9-1.9 1.9-1.9-1.3-2.3.6-1 2.1H9l-1-2.1-2.3-.6-1.9 1.3-1.9-1.9 1.3-1.9-.6-2.3-2.1-1V11l2.1-1 .6-2.3-1.3-1.9 1.9-1.9 1.9 1.3L8 5.6l1-2.1h3Z"
              />
            </svg>
          </button>
          <button
            class="theme-toggle"
            type="button"
            :aria-label="theme === 'light' ? '切换为深色模式' : '切换为浅色模式'"
            @click="applyTheme(theme === 'light' ? 'dark' : 'light')"
          >
            <svg v-if="theme === 'light'" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M12 3v2m0 14v2M3 12h2m14 0h2M5.64 5.64l1.42 1.42m9.88 9.88 1.42 1.42m0-12.72-1.42 1.42M7.06 16.94l-1.42 1.42M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z"
              />
            </svg>
            <svg v-else viewBox="0 0 24 24" aria-hidden="true">
              <path d="M20 15.1A8.2 8.2 0 0 1 8.9 4a8.2 8.2 0 1 0 11.1 11.1Z" />
            </svg>
          </button>

          <button
            class="export-button"
            type="button"
            :disabled="isExporting"
            @click="isExportPanelOpen = true"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 4v12m0 0 4-4m-4 4-4-4M5 19h14" />
            </svg>
            <span>导出</span>
          </button>

          <button
            class="import-button"
            :class="{ 'import-button--busy': isBusy }"
            type="button"
            :disabled="isBusy"
            @click="openImportMenu"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v5h14v-5" />
            </svg>
            <span>
              {{ isBusy ? '正在导入' : '导入' }}
              <small v-if="!isBusy">链接、资源或备份</small>
            </span>
          </button>
        </div>
      </header>

      <input
        ref="fileImportInput"
        class="import-button__input"
        type="file"
        accept=".png,.json,.jsonl,.srlchat,.css,.txt,image/png,application/json,text/css,text/plain"
        multiple
        :disabled="isBusy"
        aria-label="选择单个资源文件，可多选"
        @change="handleImport"
      />

      <input
        ref="resourceArchiveInput"
        class="import-button__input"
        type="file"
        accept=".zip,application/zip"
        :disabled="isBusy"
        aria-label="选择资源合集压缩包"
        @change="handleResourceArchiveImport"
      />

      <input
        ref="libraryBackupInput"
        class="import-button__input"
        type="file"
        accept=".zip,application/zip"
        :disabled="isBusy"
        aria-label="选择资源库备份 ZIP"
        @change="handleLibraryBackupImport"
      />

      <input
        ref="tavernBackupInput"
        class="import-button__input"
        type="file"
        accept=".zip,application/zip"
        :disabled="isBusy"
        aria-label="选择 SillyTavern 备份 ZIP"
        @change="handleTavernBackupImport"
      />

      <div
        v-if="isImportChooserOpen"
        class="import-choice-overlay"
        role="presentation"
        @click.self="
          pendingSharedFileBatch?.discordAttachment
            ? cancelSharedDiscordAttachment()
            : closeImportChooser()
        "
      >
        <section
          class="import-choice-sheet"
          :class="{ 'import-choice-sheet--link': isLinkImportOpen }"
          role="dialog"
          aria-modal="true"
          :aria-label="isLinkImportOpen ? '链接导入' : '选择导入方式'"
        >
          <header>
            <FeatureBackButton
              v-if="!pendingSharedFileBatch && (isLinkImportOpen || importChooserStep !== 'home')"
              label="返回导入方式"
              @click="returnToImportMenu"
            />
            <span class="import-choice-sheet__header-title">
              <small v-if="isLinkImportOpen">LINK IMPORT</small>
              <strong>
                {{
                  isLinkImportOpen
                    ? '导入脚本 / 外部扩展链接'
                    : pendingSharedFileBatch
                      ? '选择分享文件用途'
                      : importChooserStep === 'home'
                        ? '导入'
                        : importChooserStep === 'resource'
                          ? '导入资源'
                          : importChooserStep === 'backup'
                            ? '导入备份'
                            : '其他资源'
                }}
              </strong>
            </span>
            <button
              class="import-choice-sheet__close"
              type="button"
              aria-label="关闭导入"
              @click="
                pendingSharedFileBatch?.discordAttachment
                  ? cancelSharedDiscordAttachment()
                  : closeImportChooser()
              "
            >
              ×
            </button>
          </header>

          <section v-if="pendingSharedFileBatch" class="shared-import-routes">
            <template v-if="pendingSharedFileBatch.discordAttachment">
              <p>收到一个 Discord 附件直链，请核对文件后选择是否导入：</p>
              <ul>
                <li>{{ pendingSharedFileBatch.discordAttachment.name }}</li>
                <li>来源：cdn.discordapp.com</li>
                <li>下载时会校验实际响应并按资源文件导入</li>
              </ul>
              <p v-if="pendingSharedFileBatch.discordAttachment.error" role="alert">
                上次下载失败：{{ pendingSharedFileBatch.discordAttachment.error }}。可以重试或取消。
              </p>
              <button type="button" @click="downloadSharedDiscordAttachmentNow">
                <strong>下载并导入</strong>
                <small>下载附件到本机并按角色卡、世界书等资源识别</small>
              </button>
              <button type="button" @click="cancelSharedDiscordAttachment">
                <strong>取消</strong>
                <small>丢弃这条分享链接，不保存为资源链接</small>
              </button>
            </template>
            <template v-else>
              <template
                v-if="pendingSharedFileBatch.interrupted && pendingSharedFileBatch.onCancel"
              >
                <div class="shared-import-recovery" role="alert">
                  <strong>检测到上次解析中断</strong>
                  <p>
                    已下载文件仍在本机。重新解析会跳过已成功导入的资源；取消会停止云端任务并清理暂存。
                  </p>
                </div>
                <ul>
                  <li
                    v-for="file in pendingSharedFileBatch.files"
                    :key="`${file.name}-${file.size}`"
                  >
                    {{ file.name }} · {{ formatBytes(nativeFileSize(file)) }}
                  </li>
                </ul>
                <button type="button" @click="chooseSharedImportRoute('resource')">
                  <strong>重新解析</strong>
                  <small>继续导入尚未完成的资源</small>
                </button>
                <button type="button" @click="closeImportChooser">
                  <strong>取消这次任务</strong>
                  <small>停止云端任务并清理本机暂存</small>
                </button>
              </template>
              <template v-else>
                <div
                  v-if="pendingSharedFileBatch.interrupted"
                  class="shared-import-recovery"
                  role="status"
                >
                  <strong>检测到上次导入中断</strong>
                  <p>继续时会核对已完成内容，并重新尝试尚未完成的项目。</p>
                  <button
                    v-if="pendingSharedFileBatch.route"
                    type="button"
                    @click="chooseSharedImportRoute(pendingSharedFileBatch.route)"
                  >
                    继续上次导入
                  </button>
                </div>
                <template v-if="shouldShowSharedImportRouteChoices(pendingSharedFileBatch)">
                  <p>收到 {{ pendingSharedFileBatch.files.length }} 个分享文件，请选择导入用途：</p>
                  <ul>
                    <li
                      v-for="file in pendingSharedFileBatch.files"
                      :key="`${file.name}-${file.size}`"
                    >
                      {{ file.name }} · {{ formatBytes(nativeFileSize(file)) }}
                    </li>
                  </ul>
                  <button type="button" @click="chooseSharedImportRoute('libraryBackup')">
                    <strong>导入资源库备份</strong>
                    <small>SRL 导出的完整或选择性备份 ZIP；进入资源库恢复预检</small>
                  </button>
                  <button type="button" @click="chooseSharedImportRoute('tavernBackup')">
                    <strong>导入酒馆备份</strong>
                    <small>SillyTavern 完整备份 ZIP；仅提取支持的资源文件</small>
                  </button>
                  <button type="button" @click="chooseSharedImportRoute('resource')">
                    <strong>导入资源</strong>
                    <small>角色卡、世界书、正则、预设等资源文件或酒馆资源 ZIP</small>
                  </button>
                  <button type="button" @click="chooseSharedImportRoute('thirdPartyApp')">
                    <strong>导入第三方 APP</strong>
                    <small>HTML、ZIP 或 .srlapp；先预览并检查权限，再由你确认安装</small>
                  </button>
                </template>
              </template>
            </template>
          </section>

          <template v-else-if="!isLinkImportOpen && importChooserStep === 'home'">
            <button
              class="import-choice-card import-choice-card--link"
              type="button"
              @click="openLinkImportPanel"
            >
              <span class="import-choice-card__icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M10 13a5 5 0 0 0 7.1 0l1.4-1.4a5 5 0 0 0-7.1-7.1l-.8.8" />
                  <path d="M14 11a5 5 0 0 0-7.1 0l-1.4 1.4a5 5 0 0 0 7.1 7.1l.8-.8" />
                </svg>
              </span>
              <span class="import-choice-card__copy">
                <small>链接</small>
                <strong>链接导入</strong>
                <em>导入脚本、外部扩展或资源链接</em>
              </span>
            </button>
            <button
              class="import-choice-card"
              type="button"
              :disabled="isBusy"
              data-assistant-focus="import-resource"
              @click="importChooserStep = 'resource'"
            >
              <span class="import-choice-card__icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v5h14v-5" />
                </svg>
              </span>
              <span class="import-choice-card__copy">
                <small>本地文件</small>
                <strong>资源</strong>
                <em>选择单个资源文件，或导入包含多项资源的压缩包</em>
              </span>
            </button>
            <button
              class="import-choice-card"
              type="button"
              :disabled="isBusy"
              @click="importChooserStep = 'backup'"
            >
              <span class="import-choice-card__icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M4 7h16v12H4zM7 4h10v3M8 11h8M8 15h5" />
                </svg>
              </span>
              <span class="import-choice-card__copy">
                <small>备份文件</small>
                <strong>备份</strong>
                <em>选择酒馆备份或资源库备份，进入对应恢复流程</em>
              </span>
            </button>
            <button
              class="import-choice-card"
              type="button"
              :disabled="isBusy"
              @click="importChooserStep = 'other'"
            >
              <span class="import-choice-card__icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M4 5h16v14H4zM8 9h8M8 13h5" />
                </svg>
              </span>
              <span class="import-choice-card__copy">
                <small>个人资料</small>
                <strong>其他资源</strong>
                <em>新建番外指令、收纳小手机或保存密钥资料</em>
              </span>
            </button>
          </template>

          <template v-else-if="!isLinkImportOpen && importChooserStep === 'resource'">
            <button
              class="import-choice-card"
              type="button"
              :disabled="isBusy"
              data-assistant-focus="import-file"
              @click="openFileImportPicker"
            >
              <span class="import-choice-card__icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v5h14v-5" />
                </svg>
              </span>
              <span class="import-choice-card__copy">
                <small>可多选</small>
                <strong>单个资源文件</strong>
                <em>选择一个或多个 PNG、JSON、聊天、美化等资源文件</em>
              </span>
            </button>
            <button
              class="import-choice-card"
              type="button"
              :disabled="isBusy"
              @click="openResourceArchivePicker"
            >
              <span class="import-choice-card__icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M4 7h16v13H4zM4 10h16M9 4h6M9 13h6M9 16h6" />
                </svg>
              </span>
              <span class="import-choice-card__copy">
                <small>ZIP 压缩包</small>
                <strong>资源合集压缩包</strong>
                <em>从一个压缩包中提取多项资源；备份包请从“备份”进入</em>
              </span>
            </button>
          </template>

          <template v-else-if="!isLinkImportOpen && importChooserStep === 'backup'">
            <button
              class="import-choice-card"
              type="button"
              :disabled="isBusy"
              @click="openTavernBackupPicker"
            >
              <span class="import-choice-card__icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M4 7h16v12H4zM7 4h10v3M8 11h8M8 15h5" />
                </svg>
              </span>
              <span class="import-choice-card__copy">
                <small>SillyTavern</small>
                <strong>酒馆备份</strong>
                <em>提取备份中受支持的角色卡、世界书、预设与美化资源</em>
              </span>
            </button>
            <button
              class="import-choice-card"
              type="button"
              :disabled="isBusy"
              @click="openLibraryBackupPicker"
            >
              <span class="import-choice-card__icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M4 7h16v13H4zM4 10h16M8 4h8M8 14h8M8 17h5" />
                </svg>
              </span>
              <span class="import-choice-card__copy">
                <small>SRL</small>
                <strong>资源库备份</strong>
                <em>检查备份内容后，选择覆盖或合并恢复</em>
              </span>
            </button>
          </template>

          <template v-else-if="!isLinkImportOpen && importChooserStep === 'other'">
            <button class="import-choice-card" type="button" @click="createPersonal('extraStory')">
              <span class="import-choice-card__icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5" />
                </svg>
              </span>
              <span class="import-choice-card__copy">
                <small>个人资料</small>
                <strong>添加番外指令</strong>
                <em>创建一份新的番外指令资料</em>
              </span>
            </button>
            <button class="import-choice-card" type="button" @click="createPersonal('pocketPhone')">
              <span class="import-choice-card__icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M7 3h10v18H7zM10 6h4M11 18h2" />
                </svg>
              </span>
              <span class="import-choice-card__copy">
                <small>个人资料</small>
                <strong>收纳小手机</strong>
                <em>创建并整理一份小手机内容</em>
              </span>
            </button>
            <button class="import-choice-card" type="button" @click="createPersonal('secret')">
              <span class="import-choice-card__icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5zM12 14v3" />
                </svg>
              </span>
              <span class="import-choice-card__copy">
                <small>个人资料</small>
                <strong>保存密钥资料</strong>
                <em>在加密保护下新建密钥资料</em>
              </span>
            </button>
          </template>

          <LibraryLinkImportPanel v-else :model="panelModel" />
        </section>
      </div>

      <section class="archive-summary" aria-label="资源概况">
        <div class="archive-summary__counts">
          <p class="archive-summary__total">
            <strong>{{ statistics.total }}</strong>
            <span>项资源</span>
          </p>
          <span class="archive-summary__rule" aria-hidden="true"></span>
          <p>
            角色卡 <strong>{{ statistics.characterCards }}</strong>
          </p>
          <p>
            世界书 <strong>{{ statistics.worldBooks }}</strong>
          </p>
        </div>
        <button
          class="protection-trigger"
          :class="{ 'protection-trigger--warning': backupOverdue || backupRecommended }"
          type="button"
          data-assistant-focus="data-protection-open"
          :aria-expanded="isDataProtectionOpen"
          aria-controls="data-protection-panel"
          @click="isDataProtectionOpen = !isDataProtectionOpen"
        >
          <span class="protection-trigger__mark" aria-hidden="true"></span>
          <span class="protection-trigger__copy">
            <small>数据保护</small>
            <strong>{{ storageProtectionStatus }}</strong>
          </span>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path :d="isDataProtectionOpen ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'" />
          </svg>
        </button>
      </section>

      <Transition name="protection-reveal">
        <LibraryProtectionPanel :model="panelModel" />
      </Transition>

      <nav v-if="hasBrowsingState" class="browsing-context" aria-label="当前筛选条件">
        <button class="browsing-context__back" type="button" @click="handleBrowseBack">
          <span aria-hidden="true">←</span>
          返回上一层
        </button>
        <div class="browsing-context__trail">
          <button v-if="activeResourceIds" type="button" @click="activeResourceIds = undefined">
            相似资源 · 所选 {{ activeResourceIds.size }} 项 <span>×</span>
          </button>
          <button v-if="activeFilterLabel" type="button" @click="activeFilter = 'all'">
            类型 · {{ activeFilterLabel }} <span>×</span>
          </button>
          <button v-if="activeCategoryLabel" type="button" @click="activeCategoryId = undefined">
            文件夹 · {{ activeCategoryLabel }} <span>×</span>
          </button>
          <button v-if="activeTag" type="button" @click="activeTag = ''">
            标签 · #{{ activeTag }} <span>×</span>
          </button>
          <button v-if="searchQuery" type="button" @click="cancelSearchInput">
            搜索 · {{ searchQuery }} <span>×</span>
          </button>
        </div>
        <button class="browsing-context__clear" type="button" @click="clearBrowsingState">
          清除全部
        </button>
      </nav>

      <LibraryToolbar :model="panelModel" />

      <section
        v-if="filteredResourceCount && layoutMode === 'grid'"
        ref="resourceGrid"
        class="resource-grid"
        aria-live="polite"
      >
        <ResourceCard
          v-for="resource in paginatedResources"
          :key="resource.id"
          :resource="resource"
          :categories="categoriesForResource(resource)"
          :selectable="isBatchMode"
          :selected="selectedResourceIds.has(resource.id)"
          :blur-thumbnails="blurThumbnails"
          :resource-card-height-mode="resourceCardHeightMode"
          :no-image-resource-cover-mode="noImageResourceCoverMode"
          @favorite="handleFavorite"
          @edit="openResourceFromLayout"
          @select="toggleResourceSelection"
          @delete="handleDelete"
        />
      </section>

      <section
        v-else-if="filteredResourceCount && layoutMode === 'list'"
        class="resource-list"
        aria-live="polite"
      >
        <header class="resource-list__header" aria-hidden="true">
          <span v-for="column in RESOURCE_LIST_COLUMNS" :key="column">{{ column }}</span>
        </header>
        <ResourceListRow
          v-for="resource in paginatedResources"
          :key="resource.id"
          :resource="resource"
          :categories="categoriesForResource(resource)"
          :selectable="isBatchMode"
          :selected="selectedResourceIds.has(resource.id)"
          @favorite="handleFavorite"
          @open="openResourceFromLayout"
          @select="toggleResourceSelection"
          @delete="handleDelete"
        />
      </section>

      <section v-else-if="filteredResourceCount" class="split-workspace" aria-live="polite">
        <div class="split-workspace__list">
          <header class="split-workspace__heading">
            <div>
              <small>ACTIVE ARCHIVE</small><strong>{{ activeScopeLabel }}</strong>
            </div>
            <span>{{ filteredResourceCount }} 项</span>
          </header>
          <div class="resource-list resource-list--split">
            <ResourceListRow
              v-for="resource in paginatedResources"
              :key="resource.id"
              :resource="resource"
              :categories="categoriesForResource(resource)"
              :selectable="isBatchMode"
              :selected="selectedResourceIds.has(resource.id)"
              :active="selectedSplitResourceId === resource.id"
              compact
              @favorite="handleFavorite"
              @open="openResourceFromLayout"
              @select="toggleResourceSelection"
              @delete="handleDelete"
            />
          </div>
        </div>
        <ResourceInspector
          :resource="selectedSplitResource"
          :categories="selectedSplitCategories"
          :related-resources="selectedSplitRelations"
          @edit="openResourceDetail"
          @favorite="handleFavorite"
          @download="handleResourceDownload"
          @copy-link="copyResourceDeepLink"
        />
      </section>

      <nav v-if="filteredResourceCount > pageSize" class="pagination" aria-label="资源分页">
        <button
          type="button"
          :disabled="currentPage <= 1"
          @click="currentPage = Math.max(1, currentPage - 1)"
        >
          上一页
        </button>
        <span>
          第
          <input
            class="inline-page-jump"
            :style="{ width: `${String(currentPage).length}ch` }"
            :value="currentPage"
            type="text"
            inputmode="numeric"
            :maxlength="String(totalPages).length"
            aria-label="跳转到资源页"
            @focus="selectPageInput"
            @change="jumpToLibraryPage"
            @keydown.enter.prevent="jumpToLibraryPage"
          />
          / {{ totalPages }} 页
        </span>
        <label>
          每页
          <select v-model="pageSize" aria-label="每页资源数量">
            <option :value="24">24</option>
            <option :value="48">48</option>
            <option :value="96">96</option>
          </select>
        </label>
        <button
          type="button"
          :disabled="currentPage >= totalPages"
          @click="currentPage = Math.min(totalPages, currentPage + 1)"
        >
          下一页
        </button>
      </nav>

      <section v-if="!filteredResourceCount" class="empty-state">
        <div class="empty-state__folio" aria-hidden="true">
          <span></span><span></span><span></span>
        </div>
        <h2>{{ managedResources.length ? '没有找到匹配资源' : '档案柜还是空的' }}</h2>
        <p>
          {{
            visibleLibraryResources.length
              ? '换一个关键词或筛选条件试试。'
              : '从角色卡、世界书、正则、预设或美化文件开始建立你的私人收藏。'
          }}
        </p>
        <button
          v-if="visibleLibraryResources.length"
          class="button button--quiet empty-state__reset"
          type="button"
          @click="clearBrowsingState"
        >
          清除搜索与筛选
        </button>
      </section>
    </main>

    <FeatureHub
      v-if="isFeatureHubOpen || assistantHubRetained"
      v-show="isFeatureHubOpen"
      :active="isFeatureHubOpen"
      :resources="managedResources"
      :versions="organizingVersions"
      :categories="categories"
      :theme="theme"
      :layout-mode="layoutMode"
      :mobile-card-orientation="mobileCardOrientation"
      :mobile-card-fit-mode="mobileCardFitMode"
      :resource-card-height-mode="resourceCardHeightMode"
      :no-image-resource-cover-mode="noImageResourceCoverMode"
      :ui-font-scale="uiFontScale"
      :custom-css="customUiCss"
      :folder-busy="isFolderViewBusy"
      :cabinet-resource-ids="cabinetResourceIds"
      :shared-app-files="sharedAppImportFiles"
      v-bind="assistantFeatureHubProps"
      v-on="assistantFeatureHubListeners"
      @feature-app-active="isFeatureAppActive = $event"
      @close="closeFeatureHub"
      @open-resource="openResourceDetail"
      @open-persona-history="(resource) => openResourceDetail(resource, 'versions')"
      @manage-folders="openFolderManagerFromFeatureHub"
      @folder-add="handleFolderAdd"
      @folder-cover="handleFolderCover"
      @folder-rename="handleFolderRename"
      @folder-reorder="handleFolderReorder"
      @cabinet-pin="handleCabinetPin"
      @cabinet-unpin="handleCabinetUnpin"
      @update:theme="applyTheme"
      @update:layout-mode="applyLayoutMode"
      @update:mobile-card-orientation="applyMobileCardOrientation"
      @update:mobile-card-fit-mode="applyMobileCardFitMode"
      @update:resource-card-height-mode="applyResourceCardHeightMode"
      @update:no-image-resource-cover-mode="applyNoImageResourceCoverMode"
      @update:ui-font-scale="applyUiFontScale"
      @save-css="saveCustomUiCss"
      @library-changed="handleLibraryChanged"
      @import-files="
        (files, onComplete) => void importResourceFiles(files).finally(() => onComplete?.())
      "
      @shared-app-files-consumed="handleSharedAppFilesConsumed"
    />

    <ProductAssistantGuidance />
    <ProductAssistantPet
      v-if="
        assistantPreferences.desktopPet ||
        (discordSetupSession.active && discordSetupSession.purpose !== 'general')
      "
      :open-chat-request="assistantPetChatRequest"
      :assistant-busy="assistantBusy"
      :hidden="fullAssistantVisible"
      :theme="theme"
      :layout-mode="layoutMode"
      :mobile-card-orientation="mobileCardOrientation"
      :mobile-card-fit-mode="mobileCardFitMode"
      :resource-card-height-mode="resourceCardHeightMode"
      :no-image-resource-cover-mode="noImageResourceCoverMode"
      :ui-font-scale="uiFontScale"
      :custom-css="customUiCss"
      :navigate="navigatePetDestination"
      @activity="assistantBusy = $event"
      @save-assistant-css="saveAssistantAppearance"
    />

    <nav v-if="!isFeatureAppActive" class="mobile-bottom-nav" aria-label="移动端主要操作">
      <button
        type="button"
        :class="{
          'mobile-bottom-nav__item--active': !isFeatureHubOpen && activeFilter === 'all',
        }"
        @click="selectMobileDestination('all')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 5h6v6H4V5Zm10 0h6v6h-6V5ZM4 15h6v4H4v-4Zm10 0h6v4h-6v-4Z" />
        </svg>
        <span>资源库</span>
      </button>
      <button
        type="button"
        :class="{ 'mobile-bottom-nav__item--active': isFeatureHubOpen }"
        @click="openFeatureHub"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 0h6v6h-6v-6Z" />
        </svg>
        <span>功能</span>
      </button>
      <button
        class="mobile-bottom-nav__import"
        :class="{ 'mobile-bottom-nav__import--busy': isBusy }"
        type="button"
        :disabled="isBusy"
        @click="openImportMenu"
      >
        <span aria-hidden="true">+</span>
        <small>{{ isBusy ? '导入中' : '资源 / 备份' }}</small>
      </button>
      <button type="button" @click="isExportPanelOpen = true">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 4v12m0 0 4-4m-4 4-4-4M5 19h14" />
        </svg>
        <span>导出</span>
      </button>
      <button type="button" @click="isSettingsOpen = true">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M12 8.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7Zm0-5 1 2.1 2.3.6 1.9-1.3 1.9 1.9-1.3 1.9.6 2.3 2.1 1v2.7l-2.1 1-.6 2.3 1.3 1.9-1.9 1.9-1.9-1.3-2.3.6-1 2.1H9l-1-2.1-2.3-.6-1.9 1.3-1.9-1.9 1.3-1.9-.6-2.3-2.1-1V11l2.1-1 .6-2.3-1.3-1.9 1.9-1.9 1.9 1.3L8 5.6l1-2.1h3Z"
          />
        </svg>
        <span>设置</span>
      </button>
    </nav>

    <ProjectActivityCenter
      v-show="!secretPasswordRequest && !isOverlayOpen"
      :suppress-focused="isOverlayOpen"
      :hidden-notice-ids="['resource-plaza']"
      :hidden-task-names="[
        '蒜惹菈配置 Discord Bridge',
        ...(isRestorePanelOpen && isRestoring ? ['备份预检', '恢复备份'] : []),
        ...(isExportPanelOpen && isExporting ? ['导出备份'] : []),
      ]"
    />

    <div v-if="notice && recycleUndoEntry" class="notice">
      <span role="status">{{ notice }}</span>
      <button
        v-if="recycleUndoEntry"
        class="notice__undo"
        type="button"
        @click="handleRestoreRecycleBinEntry(recycleUndoEntry!.id)"
      >
        恢复刚删除
      </button>
      <button type="button" aria-label="关闭通知" @click="notice = ''">×</button>
    </div>

    <BatchBar
      v-if="isBatchBarVisible"
      :count="selectedResourceIds.size"
      :visible-count="paginatedResources.length"
      :all-visible-selected="allVisibleSelected"
      :scope-count="batchSelectionScope.length"
      :scope-label="batchSelectionScopeLabel"
      :all-scope-selected="allBatchScopeSelected"
      :selected-character-count="selectedCharacterCount"
      :categories="categories"
      :busy="isBatchBusy"
      @resize="batchBarHeight = $event"
      @close="toggleBatchMode"
      @toggle-visible="toggleVisibleSelection"
      @toggle-scope="toggleBatchScopeSelection"
      @extract-character-assets="handleBatchExtractCharacterAssets"
      @favorite="handleBatchFavorite"
      @move="handleBatchMove"
      @manage-folders="isCategoryManagerOpen = true"
      @tag="handleBatchTag"
      @ai-tag="openAiTagging"
      @delete="handleBatchDelete"
    />

    <AiTaggingPanel
      v-if="isAiTaggingOpen"
      :resources="managedResources"
      :categories="categories"
      :initial-selected-ids="Array.from(selectedResourceIds)"
      :suspended="Boolean(organizingResource)"
      @open-resource="openResourceDetail"
      @applied="handleAiTagsApplied"
      @close="isAiTaggingOpen = false"
    />

    <RecycleBinPanel
      v-if="isRecycleBinOpen"
      :records="recycleBinEntries"
      :busy="isRecycleBinBusy"
      @close="isRecycleBinOpen = false"
      @restore="handleRestoreRecycleBinEntry"
      @purge="handlePurgeRecycleBinEntry"
      @empty="handleEmptyRecycleBin"
    />

    <SecretPasswordDialog v-if="secretPasswordRequest" />
    <PersonalResourceEditor
      v-if="newPersonalKind"
      ref="personalEditor"
      :key="newPersonalKind"
      :kind="newPersonalKind"
      :settings-open="isSettingsOpen"
      @open-settings="isSettingsOpen = true"
      @close="closePersonal"
      @saved="personalSaved"
      @busy="isOrganizing = $event"
    />
    <ResourceOrganizer
      v-if="organizingResource"
      ref="personalOrganizer"
      :resource="organizingResource"
      :initial-tab="organizingInitialTab"
      :settings-open="isSettingsOpen"
      :resources="managedResources"
      :bound-resources="organizingBoundResources"
      :versions="organizingVersions"
      :categories="categories"
      :busy="isOrganizing"
      @open-secret-settings="isSettingsOpen = true"
      @close="closeResourceDetail"
      @personal-saved="personalSaved"
      @personal-busy="isOrganizing = $event"
      @download="handleResourceDownload"
      @download-related="handleRelatedDownload"
      @open="openResourceDetail"
      @activate-version="handleActivateVersion"
      @delete-version="handleDeleteResourceVersion"
      @detach-version="handleDetachResourceVersion"
      @update-version-note="handleUpdateVersionNote"
      @merge-version="handleMergeExistingVersion"
      @replace-artwork="handleReplaceCharacterCardArtwork"
      @save="handleDetailSave"
    />

    <NativeExportDialog
      v-if="pendingNativeExport"
      :file-name="pendingNativeExport.fileName"
      :is-image="pendingNativeExport.isImage"
      :busy="isNativeExportBusy"
      @close="pendingNativeExport = undefined"
      @save="handleNativeExportSelection"
      @share="sharePendingNativeExport"
    />

    <VersionImportDialog
      v-if="activeVersionImport"
      :candidate="activeVersionImport"
      :categories="categories"
      :remaining="pendingVersionImports.length"
      :busy="isVersionImportBusy"
      :comparison="versionImportComparison"
      :comparing-id="versionImportComparingId"
      @compare="handleVersionImportCompare"
      @close-comparison="closeVersionImportCompare"
      @resolve="handleVersionImportDecision"
    />

    <LayoutSettingsPanel
      v-if="isSettingsOpen"
      :key="settingsPanelKey"
      :vault-enabled="vaultStatus.enabled"
      :allow-remote-previews="previewPolicy.allowRemoteResources"
      :allow-script-previews="previewPolicy.allowScripts"
      :preload-greeting-previews="previewPolicy.preloadGreetingResources === true"
      :preload-beautification-previews="previewPolicy.preloadBeautificationResources === true"
      :increase-preview-downloads="previewPolicy.increaseDownloadConcurrency === true"
      :extract-character-assets="extractCharacterAssets"
      :hide-character-assets="hideCharacterAssets"
      :hide-chat-display-regex="hideChatDisplayRegex"
      :show-manually-bound-resources="showManuallyBoundResources"
      :blur-thumbnails="blurThumbnails"
      :auto-download-discord-share-links="autoDownloadDiscordShareLinks"
      :persist-resource-version-match-cache="persistResourceVersionMatchCache"
      :skip-version-comparison-on-import="skipVersionComparisonOnImport"
      :same-name-version-candidates="sameNameVersionCandidates"
      :show-performance-monitor="showPerformanceMonitor"
      :hidden-character-asset-count="hiddenCharacterAssetCount"
      @library-changed="handleLibraryChanged"
      @update:allow-remote-previews="applyRemotePreviewPolicy"
      @update:allow-script-previews="applyScriptPreviewPolicy"
      @update:preload-greeting-previews="applyGreetingPreviewPreload"
      @update:preload-beautification-previews="applyBeautificationPreviewPreload"
      @update:increase-preview-downloads="applyIncreasedPreviewDownloads"
      @update:extract-character-assets="applyExtractCharacterAssets"
      @update:hide-character-assets="applyHideCharacterAssets"
      @update:hide-chat-display-regex="applyHideChatDisplayRegex"
      @update:show-manually-bound-resources="applyShowManuallyBoundResources"
      @update:blur-thumbnails="applyBlurThumbnails"
      @update:auto-download-discord-share-links="applyAutoDownloadDiscordShareLinks"
      @update:persist-resource-version-match-cache="applyPersistResourceVersionMatchCache"
      @update:same-name-version-candidates="applySameNameVersionCandidates"
      @update:skip-version-comparison-on-import="applySkipVersionComparisonOnImport"
      @update:show-performance-monitor="updatePerformanceMonitorVisibility"
      @manage-folders="openFolderSettings"
      @open-vault="openVaultSettings"
      @open-version-recognition="openVersionRecognition"
      @manual-check-update="handleManualUpdateCheck"
      @close="isSettingsOpen = false"
    />

    <CategoryManager
      v-if="isCategoryManagerOpen"
      :key="categoryManagerKey"
      :categories="categories"
      :busy="isOrganizing"
      @close="isCategoryManagerOpen = false"
      @create="handleCategoryCreate"
      @update="handleCategoryUpdate"
      @visibility="handleCategoryVisibility"
      @delete="handleCategoryDelete"
    />

    <ExportPanel
      v-if="isExportPanelOpen"
      :resources="duplicateResources"
      :categories="categories"
      :busy="isExporting"
      @close="isExportPanelOpen = false"
      @restore="openRestorePanel"
      @full="handleExport({ mode: 'full', ...$event })"
      @partial="handleExport({ mode: 'partial', ...$event })"
    />

    <RestorePanel
      v-if="isRestorePanelOpen"
      :prepared="preparedRestore"
      :report="restoreReport"
      :busy="isRestoring"
      :preflight-busy="isRestorePreflighting"
      :entry="restoreEntry"
      :completed-mode="completedRestoreMode"
      @close="closeRestorePanel"
      @inspect="handleRestoreInspect"
      @confirm="handleRestoreConfirm"
      @stop="stopRestoreInspection"
    />

    <DataVaultPanel
      v-if="isVaultPanelOpen"
      :status="vaultStatus"
      :busy="isVaultBusy"
      :required="vaultStatus.locked"
      @close="isVaultPanelOpen = false"
      @unlock="handleVaultUnlock"
      @enable="handleVaultEnable"
      @disable="handleVaultDisable"
      @lock="handleVaultLock"
    />

    <div
      v-if="isDuplicateCleanerOpen"
      class="editor-overlay duplicate-cleaner-overlay"
      role="presentation"
      @click.self="isDuplicateCleanerOpen = false"
    >
      <div class="duplicate-cleaner-sheet" role="dialog" aria-modal="true" aria-label="重复清理">
        <DuplicateCleaner
          :resources="duplicateResources"
          @back="isDuplicateCleanerOpen = false"
          @open-resource="
            (resource) => {
              void openResourceDetail(resource)
            }
          "
          @library-changed="handleLibraryChanged"
        />
      </div>
    </div>

    <div
      v-if="isSimilarNameGroupsOpen"
      class="editor-overlay duplicate-cleaner-overlay"
      role="presentation"
      @click.self="isSimilarNameGroupsOpen = false"
    >
      <div
        class="duplicate-cleaner-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="名称相似资源"
      >
        <SimilarNameGroups
          :resources="visibleLibraryResources"
          @filter-resources="showSimilarResources"
          @back="isSimilarNameGroupsOpen = false"
          @open-resource="
            (resource) => {
              void openResourceDetail(resource)
            }
          "
        />
      </div>
    </div>

    <div
      v-if="isExtractedCleanerOpen"
      class="editor-overlay duplicate-cleaner-overlay"
      role="presentation"
      @click.self="isExtractedCleanerOpen = false"
    >
      <div
        class="duplicate-cleaner-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="清理拆分副本"
      >
        <ExtractedAssetCleaner
          :resources="managedResources"
          @back="isExtractedCleanerOpen = false"
          @open-resource="
            (resource) => {
              void openResourceDetail(resource)
            }
          "
          @library-changed="handleLibraryChanged"
        />
      </div>
    </div>

    <div
      v-if="isParsedTagCleanerOpen"
      class="editor-overlay duplicate-cleaner-overlay"
      role="presentation"
      @click.self="isParsedTagCleanerOpen = false"
    >
      <div
        class="duplicate-cleaner-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="清理自动解析标签"
      >
        <ParsedCharacterTagCleaner
          @back="isParsedTagCleanerOpen = false"
          @open-resource="
            (resource) => {
              void openResourceDetail(resource)
            }
          "
          @library-changed="handleLibraryChanged"
        />
      </div>
    </div>

    <div
      v-if="isVersionRecognitionOpen"
      class="editor-overlay duplicate-cleaner-overlay"
      role="presentation"
      @click.self="isVersionRecognitionOpen = false"
    >
      <div
        class="duplicate-cleaner-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="历史版本管理"
      >
        <VersionRecognitionPanel
          :same-name-version-candidates="sameNameVersionCandidates"
          :categories="categories"
          :resources="managedResources"
          @close="isVersionRecognitionOpen = false"
          @library-changed="refreshLibraryAndOpenVersions"
        />
      </div>
    </div>
    <UiCustomizationHost
      v-if="Object.values(customUiViews).some((view) => view?.enabled)"
      :views="customUiViews"
    />
  </div>
</template>
