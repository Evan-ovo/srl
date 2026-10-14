<script setup lang="ts">
import { computed, toRaw } from 'vue'

import {
  findFrontendWorkshopNode,
  type FrontendWorkshopLayoutViewport,
  type FrontendWorkshopNode,
  type FrontendWorkshopProject,
  type FrontendWorkshopSpacingValue,
} from '../types/FrontendWorkshopProject'
import { applyFrontendWorkshopCommand } from '../utils/FrontendWorkshopCommandSystem'
import {
  cloneFrontendWorkshopProject,
  ensureFrontendWorkshopNodePlacement,
  readFrontendWorkshopNodePlacement,
} from '../utils/FrontendWorkshopProjectGeometry'
import {
  FRONTEND_WORKSHOP_PARAMETER_REGISTRY,
  frontendWorkshopParameterValue,
  normalizeFrontendWorkshopParameterValue,
  type FrontendWorkshopParameterKey,
} from '../utils/FrontendWorkshopParameterRegistry'
import type { FrontendWorkshopInspectorTab } from '../utils/FrontendWorkshopInspectorRegistry'

/**
 * 扁平手动 Inspector：内容 / 外观 / 布局 / 交互四个稳定页签直接编辑普通属性。
 * 不再存在 choice -> detail -> parameter、recipe、guided、effect/token 等内部路由。
 */
const props = withDefaults(
  defineProps<{
    project?: FrontendWorkshopProject
    pageId?: string
    node?: FrontendWorkshopNode
    nodeId?: string
    requestedTab: FrontendWorkshopInspectorTab
    viewport?: FrontendWorkshopLayoutViewport
  }>(),
  {
    project: undefined,
    pageId: '',
    node: undefined,
    nodeId: '',
    viewport: 'phone',
  },
)

const emit = defineEmits<{
  commitProject: [
    payload: { previousProject: FrontendWorkshopProject; project: FrontendWorkshopProject },
  ]
  status: [message: string]
  openImageHosting: []
}>()

const currentPage = computed(
  () => props.project?.pages.find((page) => page.id === props.pageId) ?? props.project?.pages[0],
)
const selectedNode = computed(() =>
  currentPage.value && (props.nodeId || props.node?.id)
    ? findFrontendWorkshopNode(currentPage.value.nodes, props.nodeId || props.node!.id)
    : props.node,
)
const selectedIndex = computed(() =>
  Math.max(
    0,
    currentPage.value?.nodes.findIndex((item) => item.id === selectedNode.value?.id) ?? 0,
  ),
)
const selectedPlacement = computed(() =>
  selectedNode.value
    ? readFrontendWorkshopNodePlacement(selectedNode.value, props.viewport, selectedIndex.value)
    : undefined,
)
const currentLayers = computed(() => currentPage.value?.layers ?? [])
const selectedBehaviors = computed(() => {
  const id = selectedNode.value?.id
  return id && props.project
    ? (props.project.behaviors ?? []).filter((behavior) => behavior.targetNodeIds.includes(id))
    : []
})

function commit(mutator: (project: FrontendWorkshopProject) => void): boolean {
  if (!props.project) return false
  const previousProject = cloneFrontendWorkshopProject(props.project)
  const result = applyFrontendWorkshopCommand(toRaw(props.project), mutator)
  if (!result.ok) {
    emit('status', result.issues.map((issue) => issue.message).join('；'))
    return false
  }
  emit('commitProject', { previousProject, project: result.project })
  return true
}

function mutateSelected(mutator: (node: FrontendWorkshopNode) => void): void {
  const pageId = currentPage.value?.id
  const nodeId = selectedNode.value?.id
  if (!pageId || !nodeId) return
  commit((project) => {
    const page = project.pages.find((item) => item.id === pageId)
    const node = page ? findFrontendWorkshopNode(page.nodes, nodeId) : undefined
    if (node) mutator(node)
  })
}

function eventString(event: Event): string {
  return (event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value
}

function eventNumber(event: Event): number {
  return Number((event.target as HTMLInputElement).value)
}

function parameterValue(key: FrontendWorkshopParameterKey): unknown {
  return selectedNode.value ? frontendWorkshopParameterValue(selectedNode.value.style, key) : ''
}

function parameterDefinition(key: FrontendWorkshopParameterKey) {
  return FRONTEND_WORKSHOP_PARAMETER_REGISTRY[key]
}

function updateParameter(key: FrontendWorkshopParameterKey, rawValue: unknown): void {
  mutateSelected((node) => {
    ;(node.style as Record<string, unknown>)[key] = normalizeFrontendWorkshopParameterValue(
      key,
      rawValue,
    )
    if (key === 'cornerRadius') delete node.style.cornerRadii
  })
}

function updateLabel(event: Event): void {
  const value = eventString(event).trim().slice(0, 120)
  if (!value) return
  mutateSelected((node) => {
    node.label = value
  })
}

function updateText(event: Event): void {
  const value = eventString(event).slice(0, 20_000)
  mutateSelected((node) => {
    node.text = value
    node.contentSource = { kind: 'manual' }
  })
}

function updateImageUrl(event: Event): void {
  const value = eventString(event).trim().slice(0, 4_000)
  mutateSelected((node) => {
    node.imageUrl = value
  })
}

function updateImageFit(event: Event): void {
  const value = eventString(event)
  mutateSelected((node) => {
    node.style.imageFit = value === 'contain' ? 'contain' : 'cover'
  })
}

function updateImageTone(event: Event): void {
  const value = eventString(event)
  mutateSelected((node) => {
    node.style.imageTone = value === 'sepia' || value === 'mono' ? value : 'natural'
  })
}

function updateSurfaceColor(event: Event): void {
  mutateSelected((node) => {
    node.style.surfaceColor = eventString(event)
  })
}

function updateSpacing(
  key: 'padding' | 'margin',
  side: 'top' | 'right' | 'bottom' | 'left',
  event: Event,
): void {
  const current = parameterValue(key) as {
    top: number
    right: number
    bottom: number
    left: number
  }
  updateParameter(key, { ...current, [side]: eventNumber(event) })
}

function updatePlacement(key: 'x' | 'y' | 'width' | 'height' | 'zIndex', event: Event): void {
  const pageId = currentPage.value?.id
  const nodeId = selectedNode.value?.id
  if (!pageId || !nodeId) return
  const value = Math.round(eventNumber(event))
  commit((project) => {
    const page = project.pages.find((item) => item.id === pageId)
    const node = page ? findFrontendWorkshopNode(page.nodes, nodeId) : undefined
    if (!node) return
    const placement = ensureFrontendWorkshopNodePlacement(node, props.viewport, selectedIndex.value)
    if (key === 'width') placement.width = Math.max(8, value)
    else if (key === 'height') placement.height = Math.max(8, value)
    else if (key === 'zIndex') placement.zIndex = Math.max(0, Math.min(999, value))
    else placement[key] = value
  })
}

function togglePlacementLock(event: Event): void {
  const checked = (event.target as HTMLInputElement).checked
  const pageId = currentPage.value?.id
  const nodeId = selectedNode.value?.id
  if (!pageId || !nodeId) return
  commit((project) => {
    const page = project.pages.find((item) => item.id === pageId)
    const node = page ? findFrontendWorkshopNode(page.nodes, nodeId) : undefined
    if (!node) return
    ensureFrontendWorkshopNodePlacement(node, props.viewport, selectedIndex.value).locked = checked
  })
}

function updateLayer(event: Event): void {
  const layerId = eventString(event)
  mutateSelected((node) => {
    node.layerId = layerId || undefined
  })
}

function moveLayer(direction: 'back' | 'forward' | 'bottom' | 'top'): void {
  const pageId = currentPage.value?.id
  const nodeId = selectedNode.value?.id
  if (!pageId || !nodeId) return
  commit((project) => {
    const page = project.pages.find((item) => item.id === pageId)
    const node = page ? findFrontendWorkshopNode(page.nodes, nodeId) : undefined
    if (!node) return
    const placement = ensureFrontendWorkshopNodePlacement(node, props.viewport, selectedIndex.value)
    if (direction === 'bottom') placement.zIndex = 0
    else if (direction === 'top') placement.zIndex = 999
    else
      placement.zIndex = Math.max(
        0,
        Math.min(999, placement.zIndex + (direction === 'forward' ? 1 : -1)),
      )
  })
}

function resetTransform(): void {
  mutateSelected((node) => {
    node.style.rotation = 0
  })
}

function removeBehavior(behaviorId: string): void {
  commit((project) => {
    const behavior = project.behaviors?.find((item) => item.id === behaviorId)
    if (!behavior || !selectedNode.value) return
    behavior.targetNodeIds = behavior.targetNodeIds.filter((id) => id !== selectedNode.value!.id)
    if (!behavior.targetNodeIds.length) {
      project.behaviors = project.behaviors?.filter((item) => item.id !== behaviorId)
      project.hotspots = project.hotspots?.filter((hotspot) => hotspot.behaviorId !== behaviorId)
    }
  })
  emit('status', '已移除当前交互。')
}
</script>

<template>
  <section class="fw-inspector" data-srl-controls>
    <div v-if="!selectedNode" class="fw-inspector__empty">先在画布中选择一个元素。</div>

    <template v-else>
      <section v-if="requestedTab === 'content'" class="fw-inspector__body">
        <div class="fw-inspector__group">
          <h3>内容</h3>
          <label class="fw-inspector__row">
            <span>元素名称</span>
            <input :value="selectedNode.label" maxlength="120" @change="updateLabel" />
          </label>
          <label v-if="selectedNode.kind === 'text'" class="fw-inspector__stack">
            <span>文字内容</span>
            <textarea :value="selectedNode.text ?? ''" rows="4" @change="updateText"></textarea>
          </label>
          <template v-if="selectedNode.kind === 'image'">
            <label class="fw-inspector__stack">
              <span>图片 URL</span>
              <input
                :value="selectedNode.imageUrl ?? ''"
                inputmode="url"
                @change="updateImageUrl"
              />
            </label>
            <button
              type="button"
              class="fw-inspector__plain-action"
              @click="emit('openImageHosting')"
            >
              打开图片素材
            </button>
          </template>
          <p v-if="selectedNode.kind === 'control'" class="fw-inspector__note">
            复杂表单绑定不在快捷手动面板中维护；需要时直接使用源码或详细 AI 工作台。
          </p>
        </div>
      </section>

      <section v-else-if="requestedTab === 'appearance'" class="fw-inspector__body">
        <div v-if="selectedNode.kind === 'text'" class="fw-inspector__group">
          <h3>文字</h3>
          <label
            v-for="key in [
              'fontSize',
              'fontWeight',
              'lineHeight',
              'letterSpacing',
            ] as FrontendWorkshopParameterKey[]"
            :key="key"
            class="fw-inspector__row"
          >
            <span>{{ parameterDefinition(key).label }}</span>
            <input
              type="number"
              :min="parameterDefinition(key).minimum"
              :max="parameterDefinition(key).maximum"
              :step="parameterDefinition(key).step"
              :value="parameterValue(key)"
              @change="updateParameter(key, eventNumber($event))"
            />
          </label>
          <label class="fw-inspector__row">
            <span>文字颜色</span>
            <input
              type="color"
              :value="String(parameterValue('textColor'))"
              @input="updateParameter('textColor', eventString($event))"
            />
          </label>
          <label class="fw-inspector__row">
            <span>对齐</span>
            <select
              :value="String(parameterValue('align'))"
              @change="updateParameter('align', eventString($event))"
            >
              <option value="start">左</option>
              <option value="center">中</option>
              <option value="end">右</option>
            </select>
          </label>
        </div>

        <div v-if="selectedNode.kind === 'image'" class="fw-inspector__group">
          <h3>图片</h3>
          <label class="fw-inspector__row">
            <span>适应方式</span>
            <select :value="selectedNode.style.imageFit ?? 'cover'" @change="updateImageFit">
              <option value="cover">覆盖</option>
              <option value="contain">完整显示</option>
            </select>
          </label>
          <label class="fw-inspector__row">
            <span>基础色调</span>
            <select :value="selectedNode.style.imageTone ?? 'natural'" @change="updateImageTone">
              <option value="natural">原图</option>
              <option value="sepia">暖色</option>
              <option value="mono">黑白</option>
            </select>
          </label>
        </div>

        <div class="fw-inspector__group">
          <h3>填充</h3>
          <label class="fw-inspector__row">
            <span>背景颜色</span>
            <input
              type="color"
              :value="selectedNode.style.surfaceColor ?? '#ffffff'"
              @input="updateSurfaceColor"
            />
          </label>
          <label class="fw-inspector__row">
            <span>透明度</span>
            <input
              type="number"
              min="0"
              max="100"
              step="1"
              :value="parameterValue('opacity')"
              @change="updateParameter('opacity', eventNumber($event))"
            />
          </label>
        </div>

        <div class="fw-inspector__group">
          <h3>边框</h3>
          <label class="fw-inspector__row">
            <span>宽度</span>
            <input
              type="number"
              min="0"
              max="20"
              step="1"
              :value="parameterValue('borderWidth')"
              @change="updateParameter('borderWidth', eventNumber($event))"
            />
          </label>
          <label class="fw-inspector__row">
            <span>颜色</span>
            <input
              type="color"
              :value="String(parameterValue('borderColor'))"
              @input="updateParameter('borderColor', eventString($event))"
            />
          </label>
          <label class="fw-inspector__row">
            <span>样式</span>
            <select
              :value="String(parameterValue('borderStyle'))"
              @change="updateParameter('borderStyle', eventString($event))"
            >
              <option value="solid">实线</option>
              <option value="dashed">虚线</option>
              <option value="dotted">点线</option>
              <option value="double">双线</option>
            </select>
          </label>
          <label class="fw-inspector__row">
            <span>圆角</span>
            <input
              type="number"
              min="0"
              max="999"
              step="1"
              :value="parameterValue('cornerRadius')"
              @change="updateParameter('cornerRadius', eventNumber($event))"
            />
          </label>
        </div>

        <div class="fw-inspector__group">
          <h3>阴影</h3>
          <label class="fw-inspector__row">
            <span>颜色</span>
            <input
              type="color"
              :value="String(parameterValue('shadowColor'))"
              @input="updateParameter('shadowColor', eventString($event))"
            />
          </label>
          <label
            v-for="key in [
              'shadowOffsetX',
              'shadowOffsetY',
              'shadowBlur',
              'shadowSpread',
            ] as FrontendWorkshopParameterKey[]"
            :key="key"
            class="fw-inspector__row"
          >
            <span>{{ parameterDefinition(key).label }}</span>
            <input
              type="number"
              :min="parameterDefinition(key).minimum"
              :max="parameterDefinition(key).maximum"
              :step="parameterDefinition(key).step"
              :value="parameterValue(key)"
              @change="updateParameter(key, eventNumber($event))"
            />
          </label>
        </div>
      </section>

      <section v-else-if="requestedTab === 'layout'" class="fw-inspector__body">
        <div class="fw-inspector__group">
          <h3>位置与尺寸</h3>
          <label
            v-for="key in ['x', 'y', 'width', 'height'] as const"
            :key="key"
            class="fw-inspector__row"
          >
            <span>{{ { x: 'X', y: 'Y', width: '宽度', height: '高度' }[key] }}</span>
            <input
              type="number"
              :value="selectedPlacement?.[key] ?? 0"
              @change="updatePlacement(key, $event)"
            />
          </label>
          <label class="fw-inspector__row">
            <span>旋转</span>
            <input
              type="number"
              min="-180"
              max="180"
              step="1"
              :value="parameterValue('rotation')"
              @change="updateParameter('rotation', eventNumber($event))"
            />
          </label>
          <button type="button" class="fw-inspector__plain-action" @click="resetTransform">
            复位旋转
          </button>
        </div>

        <div class="fw-inspector__group">
          <h3>间距</h3>
          <div
            v-for="key in ['padding', 'margin'] as const"
            :key="key"
            class="fw-inspector__spacing"
          >
            <strong>{{ key === 'padding' ? '内间距' : '外间距' }}</strong>
            <label v-for="side in ['top', 'right', 'bottom', 'left'] as const" :key="side">
              <span>{{ { top: '上', right: '右', bottom: '下', left: '左' }[side] }}</span>
              <input
                type="number"
                :value="(parameterValue(key) as FrontendWorkshopSpacingValue)[side]"
                @change="updateSpacing(key, side, $event)"
              />
            </label>
          </div>
        </div>
        <div class="fw-inspector__group">
          <h3>图层</h3>
          <label class="fw-inspector__row">
            <span>所属图层</span>
            <select :value="selectedNode.layerId ?? ''" @change="updateLayer">
              <option value="">默认</option>
              <option v-for="layer in currentLayers" :key="layer.id" :value="layer.id">
                {{ layer.name }}
              </option>
            </select>
          </label>
          <label class="fw-inspector__row">
            <span>层级</span>
            <input
              type="number"
              min="0"
              max="999"
              :value="selectedPlacement?.zIndex ?? 0"
              @change="updatePlacement('zIndex', $event)"
            />
          </label>
          <div class="fw-inspector__actions">
            <button type="button" @click="moveLayer('bottom')">置底</button>
            <button type="button" @click="moveLayer('back')">下移</button>
            <button type="button" @click="moveLayer('forward')">上移</button>
            <button type="button" @click="moveLayer('top')">置顶</button>
          </div>
          <label class="fw-inspector__row">
            <span>锁定</span>
            <input
              type="checkbox"
              :checked="Boolean(selectedPlacement?.locked)"
              @change="togglePlacementLock"
            />
          </label>
        </div>
      </section>

      <section v-else class="fw-inspector__body">
        <div class="fw-inspector__group">
          <h3>已有交互</h3>
          <p v-if="!selectedBehaviors.length" class="fw-inspector__note">
            当前元素没有已识别的交互。复杂交互请直接修改源码，或使用 AI 生成。
          </p>
          <article
            v-for="behavior in selectedBehaviors"
            :key="behavior.id"
            class="fw-inspector__behavior"
          >
            <span>
              <strong>{{ behavior.name }}</strong>
              <small>{{ behavior.trigger }} · {{ behavior.actions.length }} 个动作</small>
            </span>
            <button type="button" @click="removeBehavior(behavior.id)">移除</button>
          </article>
        </div>
      </section>
    </template>
  </section>
</template>

<style scoped src="../styles/FrontendWorkshopNodeEditorControls.css"></style>
