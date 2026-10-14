<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import FrontendWorkshopGreetingStrip from './FrontendWorkshopGreetingStrip.vue'
import FrontendWorkshopAiComponentDraft from './FrontendWorkshopAiComponentDraft.vue'
import { readFrontendWorkshopCharacterData } from '../utils/FrontendWorkshopSourceDelivery'
import FrontendWorkshopSourceAiReplyDetails from './FrontendWorkshopSourceAiReplyDetails.vue'
import FeatureBackButton from './FeatureBackButton.vue'
import FrontendWorkshopSourcePreview from './FrontendWorkshopSourcePreview.vue'
import {
  useFrontendWorkshopSourceAiWorkspace,
  type FrontendWorkshopSourceAiWorkspaceProps,
  type FrontendWorkshopSourceAiWorkspaceEvents,
} from '../composables/UseFrontendWorkshopSourceAiWorkspace'
const props = defineProps<FrontendWorkshopSourceAiWorkspaceProps>()
const emit = defineEmits<FrontendWorkshopSourceAiWorkspaceEvents>()
const controller = useFrontendWorkshopSourceAiWorkspace(props, emit)
const {
  planDraft,
  planGenerationId,
  reviewPlan,
  approvePlan,
  previewExpanded,
  networkMode,
  previewSizing,
  previewSizingMode,
  scrollComparison,
  settingsOpen,
  settingsReady,
  applyPending,
  clearConversation,
  onlineResearch,
  researchBudget,
  tavernHelperVersion,
  sillyTavernVersion,
  mode,
  busy,
  compareOpen,
  previewRatio,
  previewScopeLabel,
  previewProjection,
  panPreviewFromPointer,
  previewPanX,
  previewPanY,
  comparePosition,
  compareDragging,
  startCompareDividerHold,
  adjustComparePosition,
  startDividerDrag,
  visibleConversation,
  openActions,
  startLongPress,
  stopLongPress,
  formatTime,
  actionMenuId,
  editTurn,
  deleteTurn,
  expandedThoughts,
  toggleExpanded,
  expandedChanges,
  requiresAdditionalProviderConsent,
  regenerate,
  repairReply,
  getFrontendWorkshopSourceAiRepairReceipt,
  canSelectSibling,
  selectSibling,
  generationPosition,
  expandedDiffs,
  deleteGeneration,
  branchNotice,
  localError,
  session,
  pendingImages,
  removePendingImage,
  addReferenceImages,
  FRONTEND_WORKSHOP_SOURCE_AI_MAX_REFERENCE_IMAGES,
  openImagePicker,
  instruction,
  editingTurnId,
  submitInstruction,
  frontendWorkshopSourceAiSessionService,
} = controller
const previewGreetingIndex = ref(0)
watch(
  () => props.projectId,
  () => {
    previewGreetingIndex.value = 0
  },
)
const beforeGreetingIndex = computed(() => {
  try {
    const greetings = readFrontendWorkshopCharacterData(
      previewProjection.value.before?.authorSource ?? '',
    )?.alternate_greetings as string[] | undefined
    const count = greetings?.length ?? 0
    return Math.min(previewGreetingIndex.value, count)
  } catch {
    return 0
  }
})
</script>

<template>
  <section
    class="source-ai-workspace mobile-dialog-viewport"
    data-srl-controls
    :class="{ 'is-preview-expanded': previewExpanded, 'is-planning': mode === 'plan' }"
    role="dialog"
    aria-modal="true"
    aria-label="肘肘更健康"
  >
    <header class="source-ai-workspace__header">
      <FeatureBackButton label="返回工作台" @click="emit('close')" />
      <strong>肘肘更健康</strong>
      <select
        v-model="mode"
        class="source-ai-workspace__mode"
        aria-label="工作模式"
        :disabled="busy"
      >
        <option value="edit">工作</option>
        <option value="plan">方案</option>
        <option value="explain">问答</option>
      </select>
      <button
        type="button"
        class="source-ai-workspace__icon-button"
        aria-label="AI 设置"
        :aria-expanded="settingsOpen"
        @click="settingsOpen = !settingsOpen"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path
            d="M19 13.4v-2.8l-2-.7-.7-1.7.9-1.9-2-2-1.9.9-1.7-.7-.7-2H9.6l-.7 2-1.7.7-1.9-.9-2 2 .9 1.9-.7 1.7-2 .7v2.8l2 .7.7 1.7-.9 1.9 2 2 1.9-.9 1.7.7.7 2h2.8l.7-2 1.7-.7 1.9.9 2-2-.9-1.9.7-1.7 2-.7Z"
          />
        </svg>
      </button>
    </header>

    <aside v-if="settingsOpen" class="source-ai-workspace__settings" aria-label="AI 设置面板">
      <label class="source-ai-workspace__switch">
        <span>修改前后对比</span>
        <input v-model="compareOpen" type="checkbox" />
      </label>
      <label>
        <span>预览方式</span>
        <select
          :value="previewSizingMode"
          @change="
            previewSizing = ($event.target as HTMLSelectElement).value as 'content' | 'viewport'
          "
        >
          <option value="viewport">页面内滚动</option>
          <option value="content">随内容展开</option>
        </select>
      </label>
      <label class="source-ai-workspace__switch">
        <span>按需联网查接口</span>
        <input v-model="onlineResearch" type="checkbox" :disabled="busy" />
      </label>
      <template v-if="onlineResearch">
        <label>
          <span>每次最多额外调用 AI</span>
          <input v-model.number="researchBudget" type="number" min="0" step="1" :disabled="busy" />
          <small>缺接口资料时自动续问的上限，0 表示不额外调用；可随时停止。</small>
        </label>
        <label>
          <span>酒馆助手资料版本</span>
          <input v-model="tavernHelperVersion" :disabled="busy" aria-label="酒馆助手资料版本" />
        </label>
        <label>
          <span>酒馆资料版本</span>
          <input v-model="sillyTavernVersion" :disabled="busy" aria-label="酒馆资料版本" />
        </label>
        <p class="source-ai-workspace__research-note">
          选择保存在本机。缺资料时读取 GitHub 官方接口文件，相关片段交给你配置的 AI，可能增加费用。
          不向 GitHub 发送作品或聊天；请按已安装版本填写，默认值不代表已检测。受网络与资料许可限制。
        </p>
      </template>
      <button type="button" :disabled="busy || !settingsReady" @click="clearConversation">
        清空本作品的 AI 对话与恢复记录
      </button>
    </aside>

    <div
      ref="splitHost"
      class="source-ai-workspace__split"
      :style="{ '--preview-ratio': `${previewRatio}%` }"
    >
      <section class="source-ai-workspace__preview" aria-label="实时预览">
        <header class="source-ai-workspace__preview-header">
          <strong>
            <span aria-hidden="true">✦</span> 预览
            <small>{{ previewScopeLabel }}</small>
          </strong>
          <div class="source-ai-workspace__preview-actions">
            <button
              type="button"
              :aria-label="previewExpanded ? '收起预览' : '放大预览'"
              :aria-pressed="previewExpanded"
              @click="previewExpanded = !previewExpanded"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path v-if="previewExpanded" d="M3 9h6V3M21 9h-6V3M3 15h6v6M21 15h-6v6" />
                <path v-else d="M9 3H3v6M15 3h6v6M3 15v6h6M21 15v6h-6" />
              </svg>
            </button>
            <button
              type="button"
              :class="{ 'is-active': compareOpen }"
              :aria-pressed="compareOpen"
              aria-label="切换修改前后对比"
              @click="compareOpen = !compareOpen"
            >
              <svg class="source-ai-workspace__compare-icon" viewBox="0 0 24 24" aria-hidden="true">
                <rect x="3" y="4" width="18" height="16" rx="3" />
                <path d="M12 4v16M9 10l-2 2 2 2M15 10l2 2-2 2" />
              </svg>
            </button>
          </div>
        </header>
        <FrontendWorkshopGreetingStrip
          v-if="previewProjection.after"
          v-model="previewGreetingIndex"
          :source-document="previewProjection.after"
          readonly
        />
        <div
          v-if="previewProjection.after"
          ref="previewViewport"
          class="source-ai-workspace__preview-viewport"
        >
          <div
            ref="previewStage"
            class="source-ai-workspace__preview-stage"
            :class="{ 'is-comparing': compareOpen }"
            :data-sizing-mode="previewSizingMode"
            @pointerdown="panPreviewFromPointer"
            @wheel="scrollComparison"
          >
            <div
              class="source-ai-workspace__preview-content"
              :style="{
                transform: `translate3d(${previewPanX}px, ${previewPanY}px, 0)`,
              }"
            >
              <FrontendWorkshopSourcePreview
                v-if="compareOpen && previewProjection.before"
                ref="beforePreview"
                class="source-ai-workspace__preview-before"
                :source-document="previewProjection.before"
                :network-mode="networkMode"
                :sizing-mode="previewSizingMode"
                :greeting-index="beforeGreetingIndex"
                @greeting-change="previewGreetingIndex = $event"
              />
              <div
                class="source-ai-workspace__preview-after"
                :class="{ 'is-comparing': compareOpen }"
                :style="
                  compareOpen ? { clipPath: `inset(0 ${100 - comparePosition}% 0 0)` } : undefined
                "
              >
                <FrontendWorkshopSourcePreview
                  ref="afterPreview"
                  :source-document="previewProjection.after"
                  :network-mode="networkMode"
                  :sizing-mode="previewSizingMode"
                  :greeting-index="previewGreetingIndex"
                  @greeting-change="previewGreetingIndex = $event"
                />
              </div>
            </div>
          </div>
          <button
            v-if="compareOpen"
            type="button"
            class="source-ai-workspace__compare-divider"
            :class="{ 'is-dragging': compareDragging }"
            :style="{ left: `${comparePosition}%` }"
            role="slider"
            aria-label="长按拖动修改前后分隔线"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-valuenow="comparePosition"
            @pointerdown.stop="startCompareDividerHold"
            @keydown="adjustComparePosition"
          >
            <span aria-hidden="true">•••</span>
          </button>
        </div>
        <p v-else-if="previewProjection.error" class="source-ai-workspace__preview-error">
          {{ previewProjection.error }}
        </p>
        <p v-else>正在准备预览…</p>
      </section>

      <button
        v-show="!previewExpanded"
        type="button"
        class="source-ai-workspace__divider"
        aria-label="拖动调整预览与对话高度"
        @pointerdown="startDividerDrag"
      >
        <span></span>
      </button>

      <section
        v-show="!previewExpanded"
        class="source-ai-workspace__conversation"
        aria-label="AI 对话"
        aria-live="polite"
      >
        <div v-if="!visibleConversation.length" class="source-ai-workspace__empty">
          <strong>想改哪里，直接告诉我</strong>
          <p>我会先校验修改，再通过现有源码历史写入。</p>
        </div>

        <template v-for="item in visibleConversation" :key="item.turn.id">
          <article
            class="source-ai-message is-user"
            tabindex="0"
            @contextmenu.prevent="openActions(item.turn.id)"
            @pointerdown="startLongPress(item.turn.id)"
            @pointerup="stopLongPress"
            @pointercancel="stopLongPress"
          >
            <p>{{ item.turn.content }}</p>
            <div v-if="item.turn.referenceImages.length" class="source-ai-message__images">
              <img
                v-for="image in item.turn.referenceImages"
                :key="image.id"
                :src="image.dataUrl"
                :alt="`参考图片：${image.name}`"
              />
            </div>
            <small>{{ formatTime(item.turn.createdAt) }}</small>
            <div v-if="actionMenuId === item.turn.id" class="source-ai-message__actions">
              <button type="button" @click="editTurn(item.turn)">编辑</button>
              <button type="button" @click="deleteTurn(item.turn)">删除</button>
            </div>
          </article>

          <article
            class="source-ai-message is-assistant"
            tabindex="0"
            @contextmenu.prevent="openActions(item.generation.id)"
            @pointerdown="startLongPress(item.generation.id)"
            @pointerup="stopLongPress"
            @pointercancel="stopLongPress"
          >
            <div class="source-ai-message__avatar-wrap">
              <span class="source-ai-message__avatar" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path
                    d="M8 8.5a4 4 0 0 1 8 0v1h1.5A2.5 2.5 0 0 1 20 12v5.5a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5V12a2.5 2.5 0 0 1 2.5-2.5H8v-1Z"
                  />
                  <circle cx="9" cy="14.5" r="1" />
                  <circle cx="15" cy="14.5" r="1" />
                </svg>
              </span>
              <button
                type="button"
                class="source-ai-message__thought"
                aria-label="查看思考"
                :aria-expanded="expandedThoughts.has(item.generation.id)"
                @click="toggleExpanded('thoughts', item.generation.id)"
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M3 3.5h10v6H7l-3 2v-2H3v-6Z" />
                </svg>
              </button>
            </div>
            <div class="source-ai-message__body">
              <p>
                {{
                  item.generation.assistantContent ||
                  (item.generation.status === 'pending' ? '正在处理…' : '本次生成失败')
                }}
              </p>

              <FrontendWorkshopSourceAiReplyDetails :generation="item.generation" />
              <FrontendWorkshopAiComponentDraft
                v-if="
                  item.generation.proposal?.componentDraft &&
                  ['ready', 'applied'].includes(item.generation.status)
                "
                :draft="item.generation.proposal.componentDraft"
                :generation-id="item.generation.id"
                :network-mode="networkMode"
                :disabled="busy || !!item.generation.recoveryBlocked"
              />
              <button
                v-if="
                  item.generation.bundle?.mode === 'plan' &&
                  item.generation.proposal?.generationPrompt
                "
                type="button"
                class="button"
                :disabled="busy"
                @click="reviewPlan(item.generation)"
              >
                审阅方案与生成提示词
              </button>
              <div v-if="item.generation.status !== 'pending'" class="source-ai-message__toolbar">
                <button
                  v-if="
                    item.generation.status === 'ready' &&
                    item.generation.proposal?.edits.length &&
                    !item.generation.recoveryBlocked
                  "
                  type="button"
                  :disabled="busy"
                  @click="applyPending(item.generation)"
                >
                  应用已收到的修改
                </button>
                <button
                  v-if="item.generation.proposal?.edits.length"
                  type="button"
                  @click="toggleExpanded('changes', item.generation.id)"
                >
                  {{ expandedChanges.has(item.generation.id) ? '收起修改' : '查看修改' }}
                  <span aria-hidden="true">&lt;/&gt;</span>
                </button>
                <button
                  v-if="getFrontendWorkshopSourceAiRepairReceipt(item.generation)"
                  type="button"
                  :disabled="busy"
                  @click="repairReply(item.generation)"
                >
                  修复这份回复（调用 1 次 AI）
                </button>
                <button
                  v-if="requiresAdditionalProviderConsent(item.generation)"
                  type="button"
                  class="source-ai-message__consent"
                  aria-label="补充资料并继续，额外使用 1 次 AI 请求"
                  :disabled="busy"
                  @click="regenerate(item.generation)"
                >
                  <svg viewBox="0 0 20 20" aria-hidden="true">
                    <path d="M16 7a6.5 6.5 0 1 0 .1 5M16 3v4h-4" />
                  </svg>
                  <span>
                    补充资料并继续
                    <small>额外使用 1 次 AI 请求</small>
                  </span>
                </button>
                <button v-else type="button" :disabled="busy" @click="regenerate(item.generation)">
                  <svg viewBox="0 0 20 20" aria-hidden="true">
                    <path d="M16 7a6.5 6.5 0 1 0 .1 5M16 3v4h-4" />
                  </svg>
                  重新生成
                </button>
                <div
                  v-if="item.turn.generationIds.length > 1"
                  class="source-ai-message__generations"
                >
                  <button
                    type="button"
                    aria-label="上一个生成"
                    :disabled="!canSelectSibling(item.generation, -1)"
                    @click="selectSibling(item.generation, -1)"
                  >
                    ‹
                  </button>
                  <span>{{ generationPosition(item.generation) }}</span>
                  <button
                    type="button"
                    aria-label="下一个生成"
                    :disabled="!canSelectSibling(item.generation, 1)"
                    @click="selectSibling(item.generation, 1)"
                  >
                    ›
                  </button>
                </div>
              </div>

              <section
                v-if="expandedChanges.has(item.generation.id)"
                class="source-ai-message__details"
              >
                <p>{{ item.generation.summary }}</p>
                <button type="button" @click="toggleExpanded('diffs', item.generation.id)">
                  {{ expandedDiffs.has(item.generation.id) ? '收起 Code Diff' : '查看 Code Diff' }}
                </button>
                <pre
                  v-if="expandedDiffs.has(item.generation.id)"
                ><code v-for="(edit, index) in item.generation.proposal?.edits" :key="index">- {{ edit.expectedText }}
+ {{ edit.replacement }}
</code></pre>
              </section>

              <section
                v-if="expandedThoughts.has(item.generation.id) && item.generation.diagnostics"
                class="source-ai-message__details is-thought"
              >
                <p v-if="item.generation.diagnostics.providerReasoning">
                  {{ item.generation.diagnostics.providerReasoning }}
                </p>
                <dl v-else>
                  <dt>理解</dt>
                  <dd>{{ item.generation.diagnostics.instruction }}</dd>
                  <dt>目标</dt>
                  <dd>{{ item.generation.diagnostics.target }}</dd>
                  <dt>选中内容</dt>
                  <dd>{{ item.generation.diagnostics.selection }}</dd>
                  <dt>Source Context</dt>
                  <dd>{{ item.generation.diagnostics.sourceContext }}</dd>
                  <dt>Write Scope</dt>
                  <dd>{{ item.generation.diagnostics.writeScope }}</dd>
                  <dt>Context 截断</dt>
                  <dd>{{ item.generation.diagnostics.contextTruncated ? '是' : '否' }}</dd>
                  <dt>Host Reference</dt>
                  <dd>
                    {{
                      item.generation.diagnostics.hostReferenceMissing
                        ? '缺失，已停止写入'
                        : item.generation.diagnostics.hostReferenceRequired
                          ? '已使用'
                          : '不需要'
                    }}
                  </dd>
                  <dt>准备修改</dt>
                  <dd>
                    {{ item.generation.diagnostics.plannedAreas.join('；') || '不修改 Source' }}
                  </dd>
                </dl>
              </section>

              <div v-if="actionMenuId === item.generation.id" class="source-ai-message__actions">
                <button
                  v-if="requiresAdditionalProviderConsent(item.generation)"
                  type="button"
                  @click="regenerate(item.generation)"
                >
                  补充资料并继续（额外使用 1 次 AI 请求）
                </button>
                <button v-else type="button" @click="regenerate(item.generation)">重新生成</button>
                <button type="button" @click="toggleExpanded('changes', item.generation.id)">
                  查看修改
                </button>
                <button type="button" @click="deleteGeneration(item.generation)">删除</button>
              </div>
            </div>
          </article>
        </template>
      </section>
    </div>

    <footer v-show="!previewExpanded" class="source-ai-workspace__composer">
      <p v-if="mode === 'plan'" class="source-ai-workspace__plan-note">
        先讨论需求，批准方案后才生成代码。
      </p>
      <section
        v-if="planGenerationId"
        class="source-ai-workspace__plan-review"
        aria-label="审阅生成方案"
      >
        <label for="workshop-plan-prompt">生成提示词（可修改）</label>
        <textarea
          id="workshop-plan-prompt"
          v-model="planDraft"
          rows="6"
          :disabled="busy"
        ></textarea>
        <div class="source-ai-workspace__plan-actions">
          <button type="button" class="button" :disabled="busy" @click="planGenerationId = ''">
            继续讨论
          </button>
          <button
            type="button"
            class="button button--primary"
            :disabled="busy || !planDraft.trim()"
            @click="approvePlan"
          >
            批准并生成
          </button>
        </div>
      </section>
      <p v-if="branchNotice" class="source-ai-workspace__branch-note">
        从这里继续将创建新的对话分支
      </p>
      <p v-if="localError || session?.error" class="source-ai-workspace__error" role="status">
        {{ localError || session?.error }}
      </p>
      <div v-if="pendingImages.length" class="source-ai-workspace__attachments">
        <figure v-for="image in pendingImages" :key="image.id">
          <img :src="image.dataUrl" :alt="image.name" />
          <button
            type="button"
            :aria-label="`移除参考图片 ${image.name}`"
            @click="removePendingImage(image.id)"
          >
            ×
          </button>
        </figure>
      </div>
      <div class="source-ai-workspace__composer-row">
        <input
          ref="fileInput"
          class="source-ai-workspace__file-input"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          tabindex="-1"
          @change="addReferenceImages"
        />
        <button
          type="button"
          class="button button--icon source-ai-workspace__add-image"
          aria-label="添加参考图片"
          :disabled="
            busy || pendingImages.length >= FRONTEND_WORKSHOP_SOURCE_AI_MAX_REFERENCE_IMAGES
          "
          @click="openImagePicker"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
        <textarea
          v-model="instruction"
          rows="1"
          :placeholder="
            editingTurnId
              ? '编辑这条消息'
              : mode === 'plan'
                ? '说说你想做什么，也可以请 AI 给你几个方案'
                : mode === 'edit'
                  ? '描述修改，也可以说“把人物资料提取成组件”'
                  : '询问当前源码'
          "
          :disabled="busy"
          @keydown.enter.exact.prevent="submitInstruction"
        ></textarea>
        <button
          v-if="session?.pending"
          type="button"
          class="button button--primary source-ai-workspace__send"
          @click="frontendWorkshopSourceAiSessionService.cancelRequest(projectId)"
        >
          停止
        </button>
        <button
          v-else
          type="button"
          class="button button--primary source-ai-workspace__send"
          aria-label="发送"
          :disabled="!instruction.trim() || busy"
          @click="submitInstruction"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m4 5 16 7-16 7 3-7-3-7Zm3 7h13" />
          </svg>
        </button>
      </div>
    </footer>
  </section>
</template>

<style scoped src="../styles/FrontendWorkshopSourceAiWorkspace.css"></style>
