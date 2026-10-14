<script setup lang="ts">
import { frontendWorkshopGreetingTemplates } from '../utils/FrontendWorkshopGreetingTemplates'
import type { FrontendWorkshopNodeKind } from '../types/FrontendWorkshopProject'
import FeatureAppHeader from './FeatureAppHeader.vue'
import FrontendWorkshopProjectBar from './FrontendWorkshopProjectBar.vue'
import FrontendWorkshopAssetLibrary from './FrontendWorkshopAssetLibrary.vue'
import FrontendWorkshopLayerPanel from './FrontendWorkshopLayerPanel.vue'
import FrontendWorkshopNodeEditor from './FrontendWorkshopNodeEditor.vue'
import FrontendWorkshopToolRail from './FrontendWorkshopToolRail.vue'
import FrontendWorkshopTutorial from './FrontendWorkshopTutorial.vue'
import FrontendWorkshopWorkspace from './FrontendWorkshopWorkspace.vue'
import RichContentPreview from './RichContentPreview.vue'
import {
  useFrontendWorkshopWorkbench,
  type FrontendWorkshopWorkbenchProps,
  type FrontendWorkshopWorkbenchEvents,
} from '../composables/UseFrontendWorkshopWorkbench'
const props = withDefaults(defineProps<FrontendWorkshopWorkbenchProps>(), {
  sourceOwnerState: 'visual',
  sourceCanUndo: false,
  sourceCanRedo: false,
  sourceMarkup: '',
  sourceSaving: false,
  sourceViewport: undefined,
})
const emit = defineEmits<FrontendWorkshopWorkbenchEvents>()
const {
  workspaceOwner,
  currentProject,
  returnToProjectHome,
  loading,
  createProject,
  createTemplateProject,
  projects,
  openProject,
  duplicateProject,
  deleteProject,
  saveStatus,
  canvasMode,
  selectedNode,
  projectCompatibilityIssues,
  renameCurrentProject,
  requestPreview,
  copyDeliveryMarkup,
  deliverySaving,
  requestCompatibility,
  requestCanvasViewport,
  pageStripCollapsed,
  currentPage,
  selectGreetingPage,
  addGreetingPage,
  renameGreetingPage,
  duplicateGreetingPage,
  deleteGreetingPage,
  activeToolRailTool,
  canUndoCurrentProject,
  canRedoCurrentProject,
  selectToolRailTool,
  requestUndo,
  requestRedo,
  toolRailCollapsed,
  quickAddOpen,
  addFromQuickMenu,
  NODE_LABELS,
  layersOpen,
  activeLayerId,
  selectedNodeId,
  commitWorkspaceGesture,
  status,
  moreToolsOpen,
  openComponentLibrary,
  copySelectedStyle,
  copiedNodeStyle,
  pasteSelectedStyle,
  openAssetLibrary,
  openTutorial,
  openAdvancedSource,
  selectNode,
  clearSelection,
  replaceCurrentProject,
  hideNode,
  toggleNodeLock,
  duplicateNode,
  removeNodeById,
  activePanel,
  MANUAL_PANELS,
  toggleInspector,
  PANEL_LABELS,
  inspectorTab,
  editorRoute,
  closeAssetLibrary,
  insertAssetFromLibrary,
  compatibilityOpen,
  previewOpen,
  closePreview,
  previewWidth,
  previewRenderedProject,
  previewCssWidth,
  previewScale,
  renderedGreetingBundle,
  previewGreetingIndex,
  navigatePreviewGreeting,
  copyCurrentGreetingMarkup,
} = useFrontendWorkshopWorkbench(props, emit)
</script>

<template>
  <section
    class="fw-workbench"
    data-srl-controls
    :class="{
      'is-editing': Boolean(currentProject),
      'has-source-canvas': Boolean(currentProject) && props.sourceOwnerState !== 'visual',
    }"
  >
    <FeatureAppHeader
      v-if="!currentProject"
      title="前端了么"
      @back="currentProject ? returnToProjectHome() : emit('back')"
    >
    </FeatureAppHeader>

    <main v-if="!currentProject && !loading" class="fw-home">
      <div class="fw-home__create">
        <button type="button" aria-label="新建开场白" @click="createProject">
          <i aria-hidden="true"
            ><svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6zM14 3v5h5M9 14h6M9 18h4" /></svg></i
          ><span><strong>新建开场白</strong><small>可视化编辑</small></span
          ><b aria-hidden="true">›</b>
        </button>
        <button
          v-for="template in frontendWorkshopGreetingTemplates"
          :key="template.id"
          type="button"
          @click="createTemplateProject(template.id)"
        >
          <i aria-hidden="true"
            ><svg viewBox="0 0 24 24"><path d="M6 3h12v18H6zM9 7h6M9 11h6M9 15h4" /></svg></i
          ><span
            ><strong>{{ template.name }}</strong
            ><small>{{ template.description }}</small></span
          ><b aria-hidden="true">›</b>
        </button>
      </div>
      <section
        v-if="projects.some((project) => project.kind === 'greeting')"
        class="fw-home__recent"
      >
        <h2>继续制作</h2>
        <article
          v-for="project in projects.filter((item) => item.kind === 'greeting')"
          :key="project.id"
        >
          <button type="button" class="fw-home__project" @click="openProject(project.id)">
            <span
              ><strong>{{ project.name }}</strong
              ><small>{{ new Date(project.updatedAt).toLocaleDateString('zh-CN') }}</small></span
            >
          </button>
          <nav>
            <button type="button" @click="duplicateProject(project.id)">复制</button
            ><button type="button" @click="deleteProject(project.id)">删除</button>
          </nav>
        </article>
      </section>
    </main>

    <main v-else-if="currentProject" v-show="editorRoute === 'workspace'" class="fw-editor">
      <FrontendWorkshopProjectBar
        :name="currentProject.name"
        :save-status="
          props.sourceOwnerState === 'visual'
            ? saveStatus
            : props.sourceSaving
              ? '保存中…'
              : '已保存'
        "
        :mode="
          props.sourceOwnerState === 'visual' ? canvasMode : (props.sourceViewport?.mode ?? 'phone')
        "
        :zoom-percent="
          props.sourceOwnerState === 'visual'
            ? (workspaceOwner?.zoomPercent ?? 100)
            : (props.sourceViewport?.zoomPercent ?? 100)
        "
        :has-selection="
          props.sourceOwnerState === 'visual'
            ? Boolean(selectedNode)
            : Boolean(props.sourceViewport?.hasSelection)
        "
        :delivery-disabled="
          props.sourceOwnerState === 'visual'
            ? projectCompatibilityIssues.length > 0
            : !props.sourceMarkup || props.sourceSaving || deliverySaving
        "
        :delivery-label="props.sourceOwnerState !== 'visual' ? '存入资源库' : undefined"
        :delivery-text="
          props.sourceOwnerState !== 'visual' ? (deliverySaving ? '保存中' : '存入') : undefined
        "
        @back="returnToProjectHome"
        @rename="renameCurrentProject"
        @preview="requestPreview"
        @delivery="copyDeliveryMarkup"
        @compatibility="requestCompatibility"
        @viewport="requestCanvasViewport"
      />
      <p
        v-if="props.sourceOwnerState === 'visual' && projectCompatibilityIssues.length"
        class="fw-delivery-note"
      >
        不能交付：{{ projectCompatibilityIssues[0] }}
      </p>
      <section
        v-if="props.sourceOwnerState === 'visual'"
        class="fw-pages"
        :class="{ 'is-collapsed': pageStripCollapsed }"
      >
        <template v-if="pageStripCollapsed">
          <span>当前：{{ currentPage?.name }}</span>
          <button type="button" @click="pageStripCollapsed = false">展开</button>
        </template>
        <template v-else>
          <nav>
            <button
              v-for="(page, index) in currentProject.pages"
              :key="page.id"
              type="button"
              :class="{ 'is-active': page.id === currentPage?.id }"
              @click="selectGreetingPage(page.id)"
            >
              {{ index === 0 ? '主' : `备用${index}` }} · {{ page.name }}
            </button>
            <button
              type="button"
              :disabled="currentProject.pages.length >= 12"
              @click="addGreetingPage"
            >
              ＋
            </button>
          </nav>
          <div>
            <input :value="currentPage?.name" maxlength="80" @change="renameGreetingPage" />
            <button type="button" @click="duplicateGreetingPage">复制为变体</button>
            <button
              type="button"
              :disabled="currentProject.pages[0]?.id === currentPage?.id"
              @click="deleteGreetingPage"
            >
              删除备用
            </button>
            <button type="button" @click="pageStripCollapsed = true">收起</button>
          </div>
        </template>
      </section>

      <FrontendWorkshopToolRail
        :hide-ai="props.sourceOwnerState === 'source'"
        :hide-quick-add="props.sourceOwnerState !== 'visual'"
        :active-tool="activeToolRailTool"
        :can-undo="canUndoCurrentProject"
        :can-redo="canRedoCurrentProject"
        @select-tool="selectToolRailTool"
        @undo="requestUndo"
        @redo="requestRedo"
        @collapsed-change="toolRailCollapsed = $event"
      >
        <template #selection-tools><slot name="source-selection-tools"></slot></template>
        <section
          v-if="quickAddOpen && props.sourceOwnerState === 'visual'"
          class="fw-popover fw-popover--quick"
        >
          <header>
            <strong>快速添加</strong><button type="button" @click="quickAddOpen = false">×</button>
          </header>
          <div>
            <button
              v-for="kind in [
                'text',
                'image',
                'divider',
                'block',
                'control',
              ] as FrontendWorkshopNodeKind[]"
              :key="kind"
              type="button"
              @click="addFromQuickMenu(kind)"
            >
              {{ NODE_LABELS[kind] }}
            </button>
            <button type="button" @click="addFromQuickMenu('button')">按钮</button>
          </div>
        </section>

        <slot
          v-if="layersOpen && props.sourceOwnerState === 'source'"
          name="source-layers"
          :close="() => (layersOpen = false)"
        ></slot>
        <FrontendWorkshopLayerPanel
          v-if="layersOpen && props.sourceOwnerState === 'visual'"
          :project="currentProject"
          :page-id="currentPage?.id ?? ''"
          :active-layer-id="activeLayerId"
          :selected-node-id="selectedNodeId"
          @close="layersOpen = false"
          @active-layer-change="activeLayerId = $event"
          @selected-node-change="selectedNodeId = $event"
          @commit-project="commitWorkspaceGesture"
          @status="status = $event"
        />

        <section v-if="moreToolsOpen" class="fw-popover fw-popover--more">
          <header>
            <strong>更多工具</strong><button type="button" @click="moreToolsOpen = false">×</button>
          </header>
          <div>
            <button type="button" @click="openComponentLibrary">组件库</button>
            <button
              v-if="props.sourceOwnerState === 'visual'"
              type="button"
              :disabled="!selectedNode"
              @click="copySelectedStyle"
            >
              复制样式
            </button>
            <button
              v-if="props.sourceOwnerState === 'visual'"
              type="button"
              :disabled="!selectedNode || !copiedNodeStyle"
              @click="pasteSelectedStyle"
            >
              粘贴样式
            </button>
            <button type="button" @click="openAssetLibrary('library')">图片素材</button>
            <button type="button" @click="openTutorial">效果参考库</button>
            <button type="button" @click="openAdvancedSource">源码</button>
          </div>
        </section>
      </FrontendWorkshopToolRail>

      <section v-if="props.sourceOwnerState !== 'visual'" class="fw-source-canvas">
        <slot name="source-canvas"><p>正在读取源码…</p></slot>
      </section>
      <FrontendWorkshopWorkspace
        v-else
        ref="workspaceOwner"
        :project="currentProject"
        :page-id="currentPage?.id ?? ''"
        :selected-node-id="selectedNodeId"
        :active-layer-id="activeLayerId"
        :canvas-mode="canvasMode"
        :hotspot-draw-mode="false"
        @select-node="selectNode"
        @clear-selection="clearSelection"
        @canvas-mode-change="canvasMode = $event"
        @preview-project="replaceCurrentProject"
        @commit-gesture="commitWorkspaceGesture"
        @status="status = $event"
        @hide-node="hideNode"
        @toggle-node-lock="toggleNodeLock"
        @duplicate-node="duplicateNode"
        @delete-node="removeNodeById"
      >
      </FrontendWorkshopWorkspace>

      <section
        v-if="props.sourceOwnerState === 'visual'"
        class="fw-inspector-dock"
        :class="{ 'is-open': activePanel }"
      >
        <header v-if="selectedNode">
          <strong>{{ selectedNode.label }}</strong>
          <button type="button" class="fw-inspector-dock__source" @click="openAdvancedSource">
            源码
          </button>
        </header>
        <nav aria-label="手动属性">
          <button
            v-for="panel in MANUAL_PANELS"
            :key="panel"
            type="button"
            :class="{ 'is-active': activePanel === panel }"
            :disabled="!selectedNode"
            @click="toggleInspector(panel)"
          >
            {{ PANEL_LABELS[panel] }}
          </button>
        </nav>
        <FrontendWorkshopNodeEditor
          v-if="activePanel && selectedNode"
          :project="currentProject"
          :page-id="currentPage?.id ?? ''"
          :node-id="selectedNode.id"
          :requested-tab="inspectorTab"
          :viewport="canvasMode"
          @commit-project="commitWorkspaceGesture"
          @status="status = $event"
          @open-image-hosting="openAssetLibrary('hosting')"
        />
      </section>
    </main>

    <FrontendWorkshopAssetLibrary
      v-if="currentProject"
      ref="assetLibraryOwner"
      :project="currentProject"
      @close="closeAssetLibrary"
      @insert-asset="insertAssetFromLibrary"
      @commit-project="commitWorkspaceGesture"
      @status="status = $event"
    />

    <FrontendWorkshopTutorial
      ref="tutorialOwner"
      :can-use-ai="props.sourceOwnerState === 'source'"
      @use-prompt="emit('sourceAiRequested', $event)"
    />

    <section v-if="compatibilityOpen" class="fw-preview" @click.self="compatibilityOpen = false">
      <article role="dialog" aria-label="兼容检查">
        <header>
          <strong>兼容检查</strong
          ><button type="button" aria-label="关闭兼容检查" @click="compatibilityOpen = false">
            ×
          </button>
        </header>
        <div class="fw-compatibility">
          <p v-for="issue in projectCompatibilityIssues" :key="issue">{{ issue }}</p>
          <p v-if="!projectCompatibilityIssues.length">
            未发现结构化开场白交付问题；真实酒馆运行效果请在最终预览及目标宿主确认。
          </p>
        </div>
      </article>
    </section>

    <section v-if="previewOpen" class="fw-preview" @click.self="closePreview">
      <article>
        <header>
          <strong>开场白预览</strong>
          <span>
            <button
              v-for="width in [320, 390, 720]"
              :key="width"
              type="button"
              :class="{ 'is-active': previewWidth === width }"
              @click="previewWidth = width"
            >
              {{ width }}
            </button>
            <button
              type="button"
              :class="{ 'is-active': previewWidth === 'fit' }"
              @click="previewWidth = 'fit'"
            >
              适应
            </button>
          </span>
          <button type="button" @click="closePreview">关闭</button>
        </header>
        <div ref="previewStage" class="fw-preview__stage">
          <RichContentPreview
            :source="previewRenderedProject"
            :title="currentProject?.name ?? '开场白'"
            :viewport-width="previewCssWidth"
            :scale="previewScale"
            :greeting-contents="renderedGreetingBundle.greetings"
            :greeting-index="previewGreetingIndex"
            :frontend-workshop-behavior-runtime="true"
            @navigate-greeting="navigatePreviewGreeting"
          />
        </div>
        <footer>
          <button type="button" @click="copyCurrentGreetingMarkup">复制当前 HTML</button>
          <button type="button" @click="copyDeliveryMarkup">复制全部交付</button>
        </footer>
      </article>
    </section>

    <p v-if="status" class="fw-status" role="status">{{ status }}</p>
  </section>
</template>

<style scoped src="../styles/FrontendWorkshopWorkbench.css"></style>
