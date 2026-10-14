<script setup lang="ts">
import FeatureAppHeader from './FeatureAppHeader.vue'
import FrontendWorkshopSourcePreview from './FrontendWorkshopSourcePreview.vue'
import {
  useFrontendWorkshopSourceComponentLibrary,
  type FrontendWorkshopSourceComponentLibraryProps,
  type FrontendWorkshopSourceComponentLibraryEvents,
} from '../composables/UseFrontendWorkshopSourceComponentLibrary'
const props = withDefaults(defineProps<FrontendWorkshopSourceComponentLibraryProps>(), {
  networkMode: 'offline',
})
const emit = defineEmits<FrontendWorkshopSourceComponentLibraryEvents>()
const controller = useFrontendWorkshopSourceComponentLibrary(props, emit)
const {
  handlePortablePackageChange,
  backOrClose,
  detailComponent,
  aiCreateOpen,
  addMenuOpen,
  activeScope,
  currentComponents,
  components,
  error,
  visibleComponents,
  componentPreview,
  handlePreviewRuntimeError,
  previewRuntimeErrors,
  provenanceLabel,
  busyAction,
  insertComponent,
  openComponentDetail,
  removeFromCurrentProject,
  deleteComponent,
  detailAssetUrls,
  dependencyDrafts,
  exportComponent,
  duplicateComponent,
  editComponentWithAi,
  aiEditInstruction,
  stopAiRequest,
  saveRuntimeMetadata,
  addDependency,
  removeDependency,
  requiresJavaScriptDraft,
  requiresNetworkDraft,
  hostApisDraft,
  saveSharePolicy,
  shareLicenseDraft,
  handleLicenseChange,
  licenseOptions,
  shareAllowedDraft,
  derivativesAllowedDraft,
  shareNoticeDraft,
  saveAssetUrl,
  assetUrlDraft,
  removeAssetUrl,
  generateComponentWithAi,
  aiNameDraft,
  aiInstructionDraft,
  openAiCreate,
  choosePortablePackage,
  handleBack,
} = controller
defineExpose({ handleBack })
</script>

<template>
  <section
    class="frontend-workshop-source-components mobile-dialog-viewport"
    data-srl-controls
    role="dialog"
    aria-modal="true"
  >
    <input
      ref="importFileInput"
      type="file"
      hidden
      accept=".srlcomponent.zip,application/zip"
      aria-label="选择 Source Component 组件包"
      @change="handlePortablePackageChange"
    />
    <div class="frontend-workshop-source-components__header">
      <FeatureAppHeader
        layout="panel"
        :title="detailComponent ? '组件详情' : aiCreateOpen ? '添加组件' : '组件库'"
        back-label="返回开场白编辑"
        @back="backOrClose"
      >
        <template #actions>
          <button
            v-if="!detailComponent && !aiCreateOpen"
            type="button"
            class="feature-header-action feature-header-action--icon"
            aria-label="添加组件"
            :aria-expanded="addMenuOpen"
            @click="addMenuOpen = true"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="1.75" />
            </svg>
          </button>
        </template>
      </FeatureAppHeader>
    </div>

    <template v-if="!detailComponent && !aiCreateOpen">
      <nav class="frontend-workshop-source-components__scopes" aria-label="组件范围">
        <button
          type="button"
          :class="{ 'is-active': activeScope === 'current' }"
          :aria-pressed="activeScope === 'current'"
          data-component-scope="current"
          @click="activeScope = 'current'"
        >
          当前组件 <small>{{ currentComponents.length }}</small>
        </button>
        <button
          type="button"
          :class="{ 'is-active': activeScope === 'mine' }"
          :aria-pressed="activeScope === 'mine'"
          data-component-scope="mine"
          @click="activeScope = 'mine'"
        >
          我的组件 <small>{{ components.length }}</small>
        </button>
      </nav>

      <main class="frontend-workshop-source-components__body">
        <p v-if="error" class="frontend-workshop-source-components__error" role="status">
          {{ error }}
        </p>
        <section
          class="frontend-workshop-source-components__library"
          :aria-label="activeScope === 'current' ? '当前组件' : '我的组件'"
        >
          <div v-if="visibleComponents.length" class="frontend-workshop-source-components__list">
            <article v-for="component in visibleComponents" :key="component.id">
              <div
                class="frontend-workshop-source-components__preview"
                :aria-label="`${component.name}组件预览`"
              >
                <FrontendWorkshopSourcePreview
                  v-if="componentPreview(component.id)?.document"
                  :source-document="componentPreview(component.id)!.document!"
                  :network-mode="networkMode"
                  :viewport-height="240"
                  @runtime-error="handlePreviewRuntimeError(component.id, $event)"
                />
                <small
                  v-if="componentPreview(component.id)?.error || previewRuntimeErrors[component.id]"
                >
                  预览不可用
                </small>
              </div>
              <div class="frontend-workshop-source-components__summary">
                <strong>{{ component.name }}</strong>
                <span v-if="component.description">{{ component.description }}</span>
                <small v-else>未填写组件说明</small>
                <span class="frontend-workshop-source-components__meta">
                  {{ provenanceLabel(component) }} · v{{ component.revision }}
                </span>
              </div>
              <button
                v-if="activeScope === 'current'"
                type="button"
                class="button button--primary frontend-workshop-source-components__primary-action"
                :disabled="Boolean(busyAction)"
                @click="emit('quickUse', component.id)"
              >
                快速使用
              </button>
              <button
                v-else
                type="button"
                class="button button--primary frontend-workshop-source-components__primary-action"
                :disabled="Boolean(busyAction)"
                @click="insertComponent(component)"
              >
                {{ busyAction === `insert:${component.id}` ? '插入中…' : '插入' }}
              </button>
              <footer>
                <button type="button" @click="openComponentDetail(component.id)">查看</button>
                <button
                  v-if="activeScope === 'current'"
                  type="button"
                  class="is-danger"
                  :disabled="Boolean(busyAction)"
                  @click="removeFromCurrentProject(component)"
                >
                  移出当前项目
                </button>
                <button
                  v-else
                  type="button"
                  class="is-danger"
                  :disabled="Boolean(busyAction)"
                  @click="deleteComponent(component)"
                >
                  删除
                </button>
              </footer>
            </article>
          </div>
          <div v-else class="frontend-workshop-source-components__empty">
            <strong>{{
              busyAction === 'load'
                ? '正在读取组件…'
                : activeScope === 'current'
                  ? '当前项目还没有组件'
                  : '还没有个人组件'
            }}</strong>
            <p v-if="activeScope === 'current'">
              从“我的组件”插入后，会自动收录到这里，方便再次使用。
            </p>
            <p v-else>在源码预览中选择元素并保存，或使用右上角加号添加组件。</p>
          </div>
        </section>
      </main>
    </template>

    <main v-else-if="detailComponent" class="frontend-workshop-source-components__body">
      <p v-if="error" class="frontend-workshop-source-components__error" role="status">
        {{ error }}
      </p>
      <article class="frontend-workshop-source-components__detail" aria-label="组件详情">
        <section
          class="frontend-workshop-source-components__detail-preview"
          :style="{ maxWidth: `${detailComponent.preview.viewportWidth}px` }"
          :aria-label="`${detailComponent.name}运行预览`"
        >
          <FrontendWorkshopSourcePreview
            v-if="componentPreview(detailComponent.id)?.document"
            :source-document="componentPreview(detailComponent.id)!.document!"
            :network-mode="networkMode"
            :viewport-height="320"
            @runtime-error="handlePreviewRuntimeError(detailComponent.id, $event)"
          />
          <p
            v-if="
              componentPreview(detailComponent.id)?.error ||
              previewRuntimeErrors[detailComponent.id]
            "
          >
            预览不可用：{{
              componentPreview(detailComponent.id)?.error ||
              previewRuntimeErrors[detailComponent.id]
            }}
          </p>
        </section>
        <div class="frontend-workshop-source-components__detail-title">
          <span
            ><strong>{{ detailComponent.name }}</strong
            ><small>{{ detailComponent.description || '未填写组件说明' }}</small></span
          >
        </div>
        <dl>
          <div>
            <dt>来源</dt>
            <dd>{{ provenanceLabel(detailComponent) }}</dd>
          </div>
          <div>
            <dt>版本</dt>
            <dd>v{{ detailComponent.revision }}</dd>
          </div>
          <div>
            <dt>素材直链</dt>
            <dd>{{ detailAssetUrls.length }} 个</dd>
          </div>
          <div>
            <dt>依赖</dt>
            <dd>{{ dependencyDrafts.length }} 个</dd>
          </div>
          <div>
            <dt>脚本</dt>
            <dd>
              {{ detailComponent.runtimeRequirements.requiresJavaScript ? '需要' : '不需要' }}
            </dd>
          </div>
          <div>
            <dt>分享</dt>
            <dd>{{ detailComponent.sharePolicy.allowShare ? '允许' : '私有' }}</dd>
          </div>
        </dl>
        <div class="frontend-workshop-source-components__detail-actions">
          <button
            type="button"
            :disabled="Boolean(busyAction)"
            @click="exportComponent(detailComponent)"
          >
            {{ busyAction === `export:${detailComponent.id}` ? '导出中…' : '导出组件' }}
          </button>
          <button
            type="button"
            :disabled="Boolean(busyAction)"
            @click="duplicateComponent(detailComponent)"
          >
            {{ busyAction === `duplicate:${detailComponent.id}` ? '复制中…' : '复制到我的组件' }}
          </button>
        </div>
        <form
          class="frontend-workshop-source-components__ai-edit"
          aria-label="AI 修改组件"
          @submit.prevent="editComponentWithAi(detailComponent)"
        >
          <label>
            <span
              ><strong>AI 修改</strong><small>只修改当前组件的 HTML / CSS / JavaScript</small></span
            >
            <textarea
              v-model="aiEditInstruction"
              rows="3"
              placeholder="例如：把状态标签改成圆角胶囊，并缩小上下留白"
              :disabled="Boolean(busyAction)"
            ></textarea>
          </label>
          <footer>
            <button
              v-if="busyAction === `ai-edit:${detailComponent.id}`"
              type="button"
              @click="stopAiRequest"
            >
              停止
            </button>
            <button
              v-else
              type="submit"
              class="button button--primary"
              :disabled="Boolean(busyAction) || !aiEditInstruction.trim()"
            >
              发送修改
            </button>
          </footer>
        </form>
        <form
          class="frontend-workshop-source-components__runtime-metadata"
          aria-label="依赖与运行需求"
          @submit.prevent="saveRuntimeMetadata(detailComponent)"
        >
          <header>
            <span
              ><strong>依赖与运行需求</strong
              ><small>随组件包一起保存，用于预览与兼容检查</small></span
            >
            <button type="button" :disabled="Boolean(busyAction)" @click="addDependency">
              添加依赖
            </button>
          </header>
          <div
            v-if="dependencyDrafts.length"
            class="frontend-workshop-source-components__dependency-list"
          >
            <div v-for="(dependency, index) in dependencyDrafts" :key="index">
              <select v-model="dependency.kind" :aria-label="`依赖 ${index + 1} 类型`">
                <option value="host-api">Host API</option>
                <option value="component">组件</option>
              </select>
              <input
                v-model="dependency.specifier"
                :aria-label="`依赖 ${index + 1} 标识`"
                placeholder="Host API 或组件标识"
                autocomplete="off"
                spellcheck="false"
              />
              <label>
                <input v-model="dependency.optional" type="checkbox" />
                <span>可选</span>
              </label>
              <button
                type="button"
                class="is-danger"
                :aria-label="`移除依赖 ${index + 1}`"
                :disabled="Boolean(busyAction)"
                @click="removeDependency(index)"
              >
                移除
              </button>
            </div>
          </div>
          <p v-else>没有额外依赖。</p>
          <div class="frontend-workshop-source-components__runtime-toggles">
            <label>
              <input v-model="requiresJavaScriptDraft" type="checkbox" />
              <span>需要 JavaScript</span>
            </label>
            <label>
              <input v-model="requiresNetworkDraft" type="checkbox" />
              <span>需要网络访问</span>
            </label>
          </div>
          <label class="frontend-workshop-source-components__host-apis">
            <span>使用的 Host API</span>
            <textarea
              v-model="hostApisDraft"
              rows="3"
              placeholder="每行一个，例如 TavernHelper.getChatMessages"
              spellcheck="false"
            ></textarea>
            <small>当前运行环境：TavernHelper 消息内容</small>
          </label>
          <footer>
            <button
              type="submit"
              :disabled="
                Boolean(busyAction) ||
                dependencyDrafts.some((dependency) => !dependency.specifier.trim())
              "
            >
              {{ busyAction === `runtime:${detailComponent.id}` ? '保存中…' : '保存运行需求' }}
            </button>
          </footer>
        </form>
        <form
          class="frontend-workshop-source-components__policy"
          aria-label="授权与分享"
          @submit.prevent="saveSharePolicy(detailComponent)"
        >
          <header>
            <span><strong>授权与分享</strong><small>导出包会携带这些信息</small></span>
          </header>
          <label>
            <span>授权方式</span>
            <select v-model="shareLicenseDraft" @change="handleLicenseChange">
              <option v-for="option in licenseOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
          </label>
          <label class="frontend-workshop-source-components__policy-toggle">
            <input
              v-model="shareAllowedDraft"
              type="checkbox"
              :disabled="shareLicenseDraft === 'private'"
            />
            <span>允许分享这个组件包</span>
          </label>
          <label class="frontend-workshop-source-components__policy-toggle">
            <input v-model="derivativesAllowedDraft" type="checkbox" />
            <span>允许他人制作衍生版本</span>
          </label>
          <label>
            <span>{{ shareLicenseDraft === 'custom' ? '自定义授权说明' : '补充说明' }}</span>
            <textarea
              v-model="shareNoticeDraft"
              rows="3"
              :required="shareLicenseDraft === 'custom' && shareAllowedDraft"
              placeholder="可填写署名、来源或自定义授权条款"
            ></textarea>
          </label>
          <footer>
            <button
              type="submit"
              :disabled="
                Boolean(busyAction) ||
                (shareLicenseDraft === 'custom' && shareAllowedDraft && !shareNoticeDraft.trim())
              "
            >
              {{ busyAction === `policy:${detailComponent.id}` ? '保存中…' : '保存授权设置' }}
            </button>
          </footer>
        </form>
        <section class="frontend-workshop-source-components__assets" aria-label="组件素材直链">
          <header>
            <span
              ><strong>素材直链</strong
              ><small>添加可由 HTML src 或 CSS url() 直接使用的 HTTPS 地址</small></span
            >
          </header>
          <form
            class="frontend-workshop-source-components__asset-editor"
            @submit.prevent="saveAssetUrl(detailComponent)"
          >
            <label>
              <span>图片或资源 URL</span>
              <input
                v-model="assetUrlDraft"
                type="url"
                inputmode="url"
                aria-label="组件素材 HTTPS 直链"
                placeholder="https://example.com/image.png"
                autocomplete="off"
                spellcheck="false"
              />
            </label>
            <footer>
              <button
                type="submit"
                class="button button--primary"
                :disabled="Boolean(busyAction) || !assetUrlDraft.trim()"
              >
                {{ busyAction === `asset-url:${detailComponent.id}` ? '保存中…' : '添加直链' }}
              </button>
            </footer>
          </form>
          <div
            v-if="detailAssetUrls.length"
            class="frontend-workshop-source-components__asset-list"
          >
            <article v-for="asset in detailAssetUrls" :key="asset.specifier">
              <span
                ><strong>{{ asset.specifier }}</strong
                ><small>{{ asset.optional ? '可选素材' : '组件素材' }}</small></span
              >
              <footer>
                <button
                  type="button"
                  class="is-danger"
                  :disabled="Boolean(busyAction)"
                  @click="removeAssetUrl(detailComponent, asset.specifier)"
                >
                  移除
                </button>
              </footer>
            </article>
          </div>
          <p v-else>还没有素材直链。添加后，AI 修改组件时也能看到这些可用地址。</p>
        </section>
      </article>
    </main>

    <main v-else class="frontend-workshop-source-components__body">
      <p v-if="error" class="frontend-workshop-source-components__error" role="status">
        {{ error }}
      </p>
      <form
        class="frontend-workshop-source-components__ai-create"
        aria-label="AI 生成组件"
        @submit.prevent="generateComponentWithAi"
      >
        <header>
          <strong>AI 生成组件</strong>
          <small>生成后保存到“我的组件”，不会自动插入当前项目</small>
        </header>
        <label>
          <span>组件名称</span>
          <input
            v-model="aiNameDraft"
            maxlength="120"
            autocomplete="off"
            placeholder="例如：角色信息折叠栏"
            :disabled="Boolean(busyAction)"
          />
        </label>
        <label>
          <span>描述你要的组件</span>
          <textarea
            v-model="aiInstructionDraft"
            rows="7"
            placeholder="说明内容、布局、交互和必要的酒馆能力"
            :disabled="Boolean(busyAction)"
          ></textarea>
        </label>
        <footer>
          <button v-if="busyAction === 'ai-generate'" type="button" @click="stopAiRequest">
            停止
          </button>
          <button
            v-else
            type="submit"
            class="button button--primary"
            :disabled="Boolean(busyAction) || !aiNameDraft.trim() || !aiInstructionDraft.trim()"
          >
            生成组件
          </button>
        </footer>
      </form>
    </main>

    <div
      v-if="addMenuOpen"
      class="frontend-workshop-source-components__sheet-backdrop"
      @click.self="addMenuOpen = false"
    >
      <section
        class="frontend-workshop-source-components__sheet"
        role="dialog"
        aria-label="添加组件方式"
      >
        <header>
          <strong>添加组件</strong>
          <button type="button" aria-label="关闭添加组件" @click="addMenuOpen = false">×</button>
        </header>
        <button type="button" @click="openAiCreate">
          <span><strong>AI 生成</strong><small>通过描述创建组件</small></span
          ><span aria-hidden="true">›</span>
        </button>
        <button type="button" :disabled="Boolean(busyAction)" @click="choosePortablePackage">
          <span><strong>导入</strong><small>从组件包加入我的组件</small></span
          ><span aria-hidden="true">›</span>
        </button>
      </section>
    </div>
  </section>
</template>

<style scoped src="../styles/FrontendWorkshopSourceComponentLibrary.css"></style>
