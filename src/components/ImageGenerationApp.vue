<script setup lang="ts">
import '../styles/ImageGenerationTouchFeedback.css'
import ImageCharacterPromptPanel from './ImageCharacterPromptPanel.vue'
import { proxyRefs } from 'vue'
import FeatureAppHeader from './FeatureAppHeader.vue'
import {
  useImageGenerationApp,
  type ImageGenerationAppEvents,
} from '../composables/UseImageGenerationApp'
defineEmits<ImageGenerationAppEvents>()
const controller = useImageGenerationApp()
const panelModel = proxyRefs(controller)
const {
  section,
  resultUrl,
  previewMeta,
  provider,
  busy,
  chooseProvider,
  providerLabel,
  config,
  applyModelMetadata,
  visibleModels,
  loadModels,
  internalTabs,
  internalTab,
  selectTab,
  prompt,
  notice,
  capabilities,
  imageText,
  promptHints,
  uploadImages,
  inputImages,
  removeInputImage,
  editInstruction,
  preserveLabels,
  preserve,
  uploadMask,
  mask,
  openAiSize,
  novelAiQualityMode,
  activeImageText,
  novelAiTransparentBackground,
  novelAiSeed,
  novelAiUcPreset,
  novelAiSampler,
  novelAiSteps,
  novelAiScale,
  width,
  height,
  negativePrompt,
  novelAiSmea,
  novelAiSmeaDyn,
  openAiQuality,
  openAiBackground,
  outputFormat,
  outputCompression,
  additionalJson,
  requestPreview,
  modelsBusy,
  saveConnection,
  resetEndpoint,
  RELAY_CAPABILITY_KEYS,
  capabilityLabels,
  confirmCapability,
  templates,
  saveTemplate,
  templateName,
  useTemplate,
  overwriteTemplate,
  deleteTemplate,
  feedbackError,
  clearFeedback,
  openSection,
  resultBusy,
  sizeOptions,
  imageEditReady,
  officialOpenAiConnection,
  relayModelProfile,
  OPENAI_IMAGE_MODEL_PROFILES,
  resultEditReady,
  maskReady,
  reportPreviewFailure,
  generateAnother,
  canGenerate,
  generate,
  result,
  reuseResult,
  continueEditing,
  candidates,
  candidateIndex,
  hostingBusy,
  assetName,
  category,
  albumSaved,
  saveToAlbum,
  canSaveToPhone,
  saveToPhone,
  selfHostedOrigin,
  selfHostedToken,
  rememberSelfHosted,
  saveSelfHostedConnection,
  selfHostedReady,
  hostResult,
  hostedUrl,
} = controller
</script>

<template>
  <section
    class="image-generation-app"
    data-srl-controls
    role="dialog"
    aria-modal="true"
    aria-label="AI 生图"
  >
    <FeatureAppHeader
      title="AI 生图"
      layout="panel"
      @back="
        section === 'generate'
          ? $emit('back')
          : openSection(section === 'cloud' ? 'result' : 'generate')
      "
    >
      <template #actions
        ><button
          class="btn"
          type="button"
          :disabled="busy || hostingBusy || resultBusy || (!result && section === 'generate')"
          @click="openSection(section === 'generate' ? 'result' : 'generate')"
        >
          {{ section === 'generate' ? '看图' : '创作' }}</button
        ><button class="btn" type="button" @click="$emit('open-album')">相册</button></template
      >
    </FeatureAppHeader>
    <main v-if="section === 'generate' || section === 'connection'" class="shell">
      <section class="panel editor" :class="{ 'is-connection': section === 'connection' }">
        <div class="providerbar">
          <select
            v-model="config[provider].model"
            class="select"
            aria-label="模型列表"
            :disabled="busy || hostingBusy || resultBusy"
            @change="applyModelMetadata"
          >
            <option v-for="model in visibleModels" :key="model.id" :value="model.id">
              {{ model.name }}
            </option>
          </select>
          <button
            class="btn"
            type="button"
            :disabled="busy || hostingBusy || resultBusy"
            @click="openSection(section === 'connection' ? 'generate' : 'connection')"
          >
            {{
              section === 'connection'
                ? '完成'
                : config[provider].apiKey.trim()
                  ? '连接设置'
                  : '配置连接'
            }}
          </button>
        </div>
        <nav
          v-if="section !== 'connection' && internalTabs.length"
          class="tabs"
          aria-label="供应商功能"
        >
          <button
            v-for="item in internalTabs"
            :key="item.id"
            class="tab"
            type="button"
            :class="{ active: section === 'generate' && internalTab === item.id }"
            @click="selectTab(item.id)"
          >
            {{ item.label }}
          </button>
        </nav>
        <fieldset
          class="scroll image-generation-controls"
          :class="{ 'is-prompt': section === 'generate' && internalTab === 'prompt' }"
          :disabled="busy || hostingBusy || resultBusy"
        >
          <template v-if="section === 'generate' && capabilities.textToImage === 'supported'">
            <template v-if="internalTab === 'prompt'">
              <div class="section prompt-main">
                <div class="head">
                  <div>
                    <div class="title">画面描述</div>
                    <div class="note">
                      {{
                        provider === 'novelai'
                          ? '支持自然语言、Tags 或混合输入。'
                          : '用自然语言描述主体、场景和构图。'
                      }}
                    </div>
                  </div>
                </div>
                <textarea
                  v-model="prompt"
                  class="textarea"
                  aria-label="画面描述"
                  placeholder="描述你想生成的画面"
                ></textarea>
                <div class="quick-sizes" aria-label="画面尺寸">
                  <button
                    v-for="size in sizeOptions"
                    :key="size"
                    class="size-choice"
                    type="button"
                    :aria-pressed="openAiSize === size"
                    @click="((openAiSize = size), clearFeedback())"
                  >
                    <span>{{
                      Number(size.split('x')[0]) < Number(size.split('x')[1])
                        ? '竖图'
                        : Number(size.split('x')[0]) > Number(size.split('x')[1])
                          ? '横图'
                          : '方图'
                    }}</span>
                    <small>{{ size.replace('x', ' × ') }}</small>
                  </button>
                </div>
              </div>
              <details v-if="capabilities.textRendering === 'supported'" class="section">
                <summary>图片中的文字</summary>
                <div class="adv">
                  <div class="head">
                    <div>
                      <div class="note">
                        作为提示词编译；填写后 NAI 自动关闭含 no text 的质量预设。
                      </div>
                    </div>
                  </div>
                  <input
                    v-model="imageText"
                    class="input"
                    aria-label="图片中的文字"
                    placeholder="例如：今夜营业"
                  />
                </div>
              </details>
              <details v-if="provider === 'openai'" class="section">
                <summary>补充人物、场景与风格</summary>
                <div class="adv">
                  <div class="head">
                    <div>
                      <div class="note">可选，作为 Prompt 编译辅助。</div>
                    </div>
                  </div>
                  <div class="row2">
                    <input
                      v-for="(_, key) in promptHints"
                      :key="key"
                      v-model="promptHints[key]"
                      class="input"
                      :aria-label="key"
                      :placeholder="`${key}：可选补充描述`"
                    />
                  </div>
                </div>
              </details>
            </template>
            <ImageCharacterPromptPanel :model="panelModel" />
            <template v-if="provider === 'openai' && imageEditReady && internalTab === 'reference'">
              <div class="section">
                <div class="head">
                  <div>
                    <div class="title">参考图片</div>
                    <div class="note">每张图的用途编译进提示词。</div>
                  </div>
                </div>
                <label
                  v-if="
                    capabilities.imageInput === 'supported' &&
                    capabilities.imageEdit === 'supported'
                  "
                  class="dropzone"
                  >上传参考图（{{
                    capabilities.multiImage === 'supported'
                      ? `最多 ${capabilities.maxInputImages} 张`
                      : '单张'
                  }}）<input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    :multiple="capabilities.multiImage === 'supported'"
                    @change="uploadImages"
                /></label>
                <div v-else class="workspace-notice">
                  图片输入 / 编辑能力未确认；当前只使用文生图。
                </div>
              </div>
              <div class="ref-grid">
                <article
                  v-for="(image, index) in inputImages.slice(0, capabilities.maxInputImages)"
                  :key="image.url"
                  class="ref image-generation-entry"
                >
                  <img class="thumb" :src="image.url" :alt="image.name" /><label
                    >图片 {{ index + 1 }} 用途<select v-model="image.role" class="select">
                      <option value="identity">人物身份</option>
                      <option value="outfit">服装</option>
                      <option value="composition">构图</option>
                      <option value="scene">场景</option>
                      <option value="reference">普通参考</option>
                    </select></label
                  ><button class="btn field-gap" type="button" @click="removeInputImage(index)">
                    移除图片
                  </button>
                </article>
              </div>
            </template>
            <template v-if="provider === 'openai' && imageEditReady && internalTab === 'reference'">
              <template v-if="capabilities.imageEdit === 'supported'">
                <div class="section">
                  <div class="head">
                    <div>
                      <div class="title">编辑当前图片</div>
                      <div class="note">先添加上方原图，再填写希望修改的内容。</div>
                    </div>
                  </div>
                  <textarea
                    v-model="editInstruction"
                    class="textarea"
                    aria-label="修改指令"
                    placeholder="例如：把人物外套改成白色，其他内容保持不变。"
                  ></textarea>
                </div>
                <details class="section">
                  <summary>保持不变（可选）</summary>
                  <div class="adv">
                    <div class="head">
                      <div>
                        <div class="title">保持不变（可选）</div>
                        <div class="note">编译为提示词约束，不保证像素完全一致。</div>
                      </div>
                    </div>
                    <label v-for="(label, key) in preserveLabels" :key="key" class="switch-row"
                      ><span>保持{{ label }}</span
                      ><input v-model="preserve[key]" class="switch" type="checkbox"
                    /></label>
                  </div>
                </details>
                <details v-if="maskReady">
                  <summary>局部修改遮罩（Mask）</summary>
                  <div class="adv">
                    <label
                      >与第一张 PNG 同尺寸、带透明通道<input
                        type="file"
                        accept="image/png"
                        @change="uploadMask" /></label
                    ><button v-if="mask" class="btn" type="button" @click="mask = undefined">
                      移除 Mask：{{ mask.name }}
                    </button>
                  </div>
                </details>
              </template>
              <p v-else class="workspace-notice">当前模型的图片编辑能力未确认。</p>
            </template>
            <template v-if="internalTab === 'settings'">
              <template v-if="provider === 'novelai'">
                <details
                  v-if="
                    capabilities.vibeTransfer === 'supported' ||
                    capabilities.preciseReference === 'supported'
                  "
                  class="section"
                >
                  <summary>参考图能力说明</summary>
                  <div class="adv note">
                    当前项目尚未接通 NovelAI 的 Vibe Transfer{{
                      capabilities.preciseReference === 'supported' ? ' 与 Precise Reference' : ''
                    }}
                    请求，暂不提供上传；可继续使用文字和角色描述生成。
                  </div>
                </details>
                <div class="section">
                  <div class="head">
                    <div>
                      <div class="title">常用设置</div>
                      <div class="note">采样器等技术参数放高级设置。</div>
                    </div>
                  </div>
                  <div class="row2">
                    <label
                      >尺寸<select v-model="openAiSize" class="select">
                        <option value="832x1216">832 × 1216 · 竖图</option>
                        <option value="1216x832">1216 × 832 · 横图</option>
                        <option value="1024x1024">1024 × 1024 · 方图</option>
                        <option
                          v-if="!['832x1216', '1216x832', '1024x1024'].includes(openAiSize)"
                          :value="openAiSize"
                        >
                          {{ openAiSize }}
                        </option>
                      </select></label
                    ><label v-if="capabilities.qualityMode === 'supported'"
                      >质量预设<select
                        v-model="novelAiQualityMode"
                        class="select"
                        :disabled="Boolean(activeImageText)"
                      >
                        <option value="off">关闭</option>
                        <option v-if="capabilities.qualityModes.includes('light')" value="light">
                          轻量
                        </option>
                        <option value="standard">标准</option>
                      </select></label
                    >
                  </div>
                  <label
                    v-if="capabilities.transparentBackground === 'supported'"
                    class="switch-row"
                    ><span>透明背景</span
                    ><input v-model="novelAiTransparentBackground" class="switch" type="checkbox"
                  /></label>
                  <div class="row2 field-gap">
                    <label v-if="capabilities.seed === 'supported'"
                      >种子（Seed，留空随机）<input
                        v-model.number="novelAiSeed"
                        class="input"
                        type="number"
                        min="0"
                        max="4294967295"
                        placeholder="每次随机；填入数值可锁定" /></label
                    ><label v-if="capabilities.ucPreset === 'supported'"
                      >排除内容预设<select v-model="novelAiUcPreset" class="select">
                        <option value="none">关闭（手动排除内容）</option>
                        <option value="heavy">较强</option>
                        <option value="light">较轻</option>
                      </select></label
                    >
                  </div>
                </div>
                <details>
                  <summary>高级设置</summary>
                  <div class="adv">
                    <div class="row2">
                      <label v-if="capabilities.sampler === 'supported'"
                        >Sampler<select v-model="novelAiSampler" class="select">
                          <option value="k_dpmpp_2m">DPM++ 2M</option>
                          <option value="k_euler_ancestral">Euler Ancestral</option>
                          <option value="k_euler">Euler</option>
                          <option value="k_dpm_2">DPM2</option>
                          <option value="k_dpmpp_2s_ancestral">DPM++ 2S Ancestral</option>
                          <option value="k_dpmpp_sde">DPM++ SDE</option>
                          <option value="k_dpm_fast">DPM Fast</option>
                          <option value="ddim">DDIM</option>
                        </select></label
                      ><label v-if="capabilities.steps === 'supported'"
                        >Steps<input
                          v-model.number="novelAiSteps"
                          class="input"
                          type="number"
                          min="1"
                          max="50" /></label
                      ><label v-if="capabilities.guidance === 'supported'"
                        >Guidance<input
                          v-model.number="novelAiScale"
                          class="input"
                          type="number"
                          min="0"
                          max="10"
                          step="0.1" /></label
                      ><label
                        >宽度<input
                          v-model.number="width"
                          class="input"
                          type="number"
                          min="64"
                          max="1536"
                          step="64" /></label
                      ><label
                        >高度<input
                          v-model.number="height"
                          class="input"
                          type="number"
                          min="64"
                          max="1536"
                          step="64"
                      /></label>
                    </div>
                    <label v-if="capabilities.negativePrompt === 'supported'" class="field-gap"
                      >追加排除内容<textarea
                        v-model="negativePrompt"
                        class="textarea"
                        rows="3"
                      ></textarea></label
                    ><template v-if="capabilities.smea === 'supported' && novelAiSampler !== 'ddim'"
                      ><label class="check"
                        ><input v-model="novelAiSmea" type="checkbox" />SMEA</label
                      ><label class="check"
                        ><input
                          v-model="novelAiSmeaDyn"
                          type="checkbox"
                          :disabled="!novelAiSmea"
                        />SMEA Dyn</label
                      ></template
                    >
                  </div>
                </details>
              </template>
              <template v-else>
                <div class="section">
                  <div class="head">
                    <div>
                      <div class="title">尺寸</div>
                      <div class="note">选择接口支持的实际尺寸。</div>
                    </div>
                  </div>
                  <div class="row3">
                    <button
                      v-for="size in capabilities.sizes"
                      :key="size"
                      class="price-card"
                      type="button"
                      :class="{ active: openAiSize === size }"
                      @click="openAiSize = size"
                    >
                      <strong>{{ size }}</strong>
                    </button>
                  </div>
                </div>
                <div v-if="capabilities.quality === 'supported'" class="section">
                  <div class="head">
                    <div>
                      <div class="title">质量</div>
                      <div class="note">费用以供应商实际计费为准。</div>
                    </div>
                    <button class="btn" type="button" @click="openAiQuality = 'auto'">
                      {{ openAiQuality === 'auto' ? 'Auto ✓' : 'Auto' }}
                    </button>
                  </div>
                  <div class="row3">
                    <button
                      v-for="quality in ['low', 'medium', 'high'] as const"
                      :key="quality"
                      class="price-card"
                      type="button"
                      :class="{ active: openAiQuality === quality }"
                      @click="openAiQuality = quality"
                    >
                      <strong>{{
                        { low: '快速 · Low', medium: '标准 · Medium', high: '精细 · High' }[quality]
                      }}</strong>
                    </button>
                  </div>
                </div>
                <div class="section">
                  <div class="row2 image-generation-grid">
                    <label v-if="capabilities.outputFormat === 'supported'"
                      >格式<select v-model="outputFormat" class="select">
                        <option value="png">PNG</option>
                        <option value="webp">WebP</option>
                        <option
                          v-if="
                            !(
                              openAiBackground === 'transparent' &&
                              capabilities.transparentBackground === 'supported'
                            )
                          "
                          value="jpeg"
                        >
                          JPEG
                        </option>
                      </select></label
                    ><label
                      v-if="
                        capabilities.outputCompression === 'supported' &&
                        capabilities.outputFormat === 'supported' &&
                        outputFormat !== 'png'
                      "
                      >压缩<input
                        v-model.number="outputCompression"
                        class="input"
                        type="number"
                        min="0"
                        max="100" /></label
                    ><label v-if="capabilities.background === 'supported'"
                      >背景<select v-model="openAiBackground" class="select">
                        <option value="auto">Auto</option>
                        <option value="opaque">普通</option>
                        <option
                          v-if="capabilities.transparentBackground === 'supported'"
                          value="transparent"
                        >
                          透明
                        </option>
                      </select></label
                    >
                  </div>
                  <div v-if="capabilities.background === 'supported'" class="workspace-notice">
                    透明背景使用 PNG / WebP；PNG 不显示压缩选项。
                  </div>
                </div>
              </template>
            </template>
            <details v-if="provider === 'openai' && internalTab === 'settings'" class="section">
              <summary>接口高级选项与请求预览</summary>
              <div class="adv">
                <div class="section">
                  <div class="head">
                    <div>
                      <div class="title">请求预览</div>
                      <div class="note">不显示 Authorization / API Key；与发送使用同一构造器。</div>
                    </div>
                  </div>
                  <label
                    >附加 JSON（仅私有字段）<textarea
                      v-model="additionalJson"
                      class="textarea"
                      placeholder="例如：填写供应商文档确认的私有参数对象"
                    ></textarea>
                  </label>
                </div>
                <pre v-if="!requestPreview.error" class="code">{{ requestPreview.text }}</pre>
              </div>
            </details>
          </template>
          <template v-if="section === 'connection'">
            <div class="section image-generation-connection">
              <div class="head">
                <div class="title">连接设置</div>
              </div>
              <div class="provider-switch image-generation-provider__switch">
                <button
                  v-for="item in ['novelai', 'openai'] as const"
                  :key="item"
                  class="provider-btn"
                  type="button"
                  :disabled="busy || modelsBusy || hostingBusy || resultBusy"
                  :aria-pressed="provider === item"
                  :class="{ active: provider === item }"
                  @click="(chooseProvider(item), openSection('connection'))"
                >
                  {{ providerLabel(item) }}
                </button>
              </div>
              <div class="image-generation-connection__fields">
                <label
                  >API 地址<input
                    v-model="config[provider].endpoint"
                    class="input"
                    type="url"
                    :disabled="busy"
                /></label>
                <label
                  >API 密钥<input
                    v-model="config[provider].apiKey"
                    class="input"
                    type="password"
                    autocomplete="off"
                    :disabled="busy"
                /></label>
                <label
                  >模型 ID
                  <div class="image-generation-connection__model">
                    <input
                      v-model="config[provider].model"
                      aria-label="模型 ID"
                      class="input"
                      type="text"
                      :disabled="busy"
                      @change="applyModelMetadata"
                    />
                    <button
                      class="btn"
                      type="button"
                      :disabled="modelsBusy || busy"
                      @click="loadModels"
                    >
                      {{ modelsBusy ? '拉取中…' : '拉取模型' }}
                    </button>
                  </div>
                </label>
                <template v-if="provider === 'openai' && !officialOpenAiConnection">
                  <label
                    >实际模型类型<select
                      v-model="relayModelProfile"
                      class="select"
                      aria-label="实际模型类型"
                      :disabled="busy || modelsBusy"
                    >
                      <option value="">其他 / 不确定（仅使用已确认能力）</option>
                      <option
                        v-for="profile in OPENAI_IMAGE_MODEL_PROFILES"
                        :key="profile.id"
                        :value="profile.id"
                      >
                        {{ profile.name }}
                      </option>
                    </select></label
                  >
                  <p class="note">
                    按所选类型显示功能；发送的模型 ID
                    保持上方填写的值。接口有差异时可展开下方单独调整。
                  </p>
                </template>
                <details class="image-generation-connection__advanced">
                  <summary>
                    更多设置
                    <small>{{
                      config[provider].credentialPersistence === 'session'
                        ? '密钥仅本次使用'
                        : '密钥保存在本机'
                    }}</small>
                  </summary>
                  <label
                    >密钥保存方式<select
                      v-model="config[provider].credentialPersistence"
                      aria-label="密钥保存方式"
                      class="select"
                    >
                      <option value="local">本机受保护存储</option>
                      <option value="session">仅本次使用</option>
                    </select></label
                  >
                  <p class="note">配置与凭据使用现有本机受保护存储。</p>
                  <button class="btn" type="button" :disabled="busy" @click="resetEndpoint">
                    恢复默认地址
                  </button>
                </details>
                <button class="btn primary" type="button" :disabled="busy" @click="saveConnection">
                  保存连接
                </button>
              </div>
            </div>
            <details
              v-if="provider === 'openai' && !officialOpenAiConnection"
              class="section image-generation-connection__capabilities"
            >
              <summary>
                单独调整能力
                <span>{{
                  { basic: '基础兼容', enhanced: '增强兼容', editing: '完整图像编辑' }[
                    capabilities.compatibilityLevel
                  ]
                }}</span>
              </summary>
              <div class="head">
                <div>
                  <div class="title">兼容级别</div>
                  <div class="note">只发送已确认能力的参数。</div>
                </div>
                <span class="status warn">{{
                  { basic: '基础兼容', enhanced: '增强兼容', editing: '完整图像编辑' }[
                    capabilities.compatibilityLevel
                  ]
                }}</span>
              </div>
              <div class="cap-grid">
                <div class="cap">
                  <span>prompt / model / size</span><strong class="yes">✓ 支持</strong>
                </div>
                <div v-for="key in RELAY_CAPABILITY_KEYS" :key="key" class="cap">
                  <div>
                    <span>{{ capabilityLabels[key] }}</span
                    ><label
                      v-if="
                        !capabilities.sources[key] ||
                        capabilities.sources[key] === 'manual' ||
                        capabilities.sources[key] === 'selection'
                      "
                      class="check small"
                      ><input
                        type="checkbox"
                        :checked="capabilities[key] === 'supported'"
                        @change="confirmCapability(key, $event)"
                      />启用此能力</label
                    >
                    <div v-else class="small">
                      {{ capabilities.sources[key] === 'profile' ? '模型约束' : '接口声明' }}
                    </div>
                  </div>
                  <strong
                    :class="{
                      yes: capabilities[key] === 'supported',
                      no: capabilities[key] === 'unsupported',
                      maybe: capabilities[key] === 'unknown',
                    }"
                    >{{
                      { supported: '✓ 支持', unknown: '? 未确认', unsupported: '× 不支持' }[
                        capabilities[key]
                      ]
                    }}</strong
                  >
                </div>
              </div>
            </details>
            <div class="workspace-notice">
              {{
                capabilities.notes.join(' ') ||
                (officialOpenAiConnection
                  ? '官方接口已按当前模型自动匹配功能，无需额外选择模型类型。'
                  : '模型参数按当前能力显示。')
              }}
            </div>
          </template>
          <details v-if="section !== 'connection' && internalTab === 'prompt'" class="section">
            <summary>模板 {{ templates.length }}</summary>
            <form class="row2" @submit.prevent="saveTemplate">
              <input
                v-model="templateName"
                class="input"
                aria-label="模板名称"
                placeholder="模板名称"
              />
              <button class="btn" type="submit">保存模板</button>
            </form>
            <div v-for="template in templates" :key="template.id" class="image-generation-actions">
              <span>{{ template.name }}</span>
              <button type="button" @click="useTemplate(template)">套用</button>
              <button type="button" @click="overwriteTemplate(template)">覆盖</button>
              <button type="button" @click="deleteTemplate(template)">删除</button>
            </div>
          </details>
        </fieldset>
        <footer v-if="section !== 'connection'" class="footerbar image-generation-generate-bar">
          <span class="small">{{
            busy ? '正在等待图片，可取消等待' : '生成会按供应商规则计费'
          }}</span>
          <button
            v-if="capabilities.textToImage === 'supported'"
            class="generate"
            type="button"
            :disabled="!canGenerate"
            @click="generate"
          >
            {{ busy ? '取消等待' : '生成图片' }}
          </button>
        </footer>
      </section>
      <aside class="panel preview">
        <div class="stage">
          <img
            v-if="resultUrl"
            class="result-art"
            :src="resultUrl"
            alt="生成结果"
            @error="reportPreviewFailure"
          />
          <div v-else class="art">预览区域</div>
        </div>
        <div class="preview-foot">
          <div class="meta">
            <span>{{ previewMeta }}</span
            ><span>最近结果</span>
          </div>
          <div class="preview-actions">
            <button
              class="btn"
              type="button"
              :disabled="!result || busy || hostingBusy || resultBusy"
              @click="openSection('result')"
            >
              查看与保存
            </button>
          </div>
        </div>
      </aside>
    </main>
    <section v-else-if="section === 'result'" class="panel secondary">
      <header>
        <div>
          <strong>生成结果</strong
          ><small class="image-generation-result-meta">{{ previewMeta }}</small
          ><small>未保存的结果仅在本次打开期间保留，请及时保存。</small>
        </div>
      </header>
      <div v-if="resultUrl" class="stage image-generation-result">
        <img :src="resultUrl" alt="生成结果" @error="reportPreviewFailure" />
      </div>
      <div v-else class="image-generation-empty">还没有生成结果。</div>
      <nav v-if="candidates.length > 1" class="image-generation-actions" aria-label="生成候选">
        <button
          type="button"
          aria-label="上一张生成结果"
          :disabled="candidateIndex === 0 || hostingBusy || resultBusy || busy"
          @click="(candidateIndex--, clearFeedback())"
        >
          上一张
        </button>
        <span>{{ candidateIndex + 1 }} / {{ candidates.length }}</span>
        <button
          type="button"
          aria-label="下一张生成结果"
          :disabled="candidateIndex === candidates.length - 1 || hostingBusy || resultBusy || busy"
          @click="(candidateIndex++, clearFeedback())"
        >
          下一张
        </button>
      </nav>
      <div v-if="result" class="image-generation-actions result-actions">
        <button
          class="btn"
          type="button"
          :disabled="busy || hostingBusy || resultBusy"
          @click="openSection('generate')"
        >
          调整描述
        </button>
        <button
          class="btn"
          type="button"
          :disabled="busy || hostingBusy || resultBusy"
          @click="reuseResult"
        >
          {{ result?.provider === 'novelai' ? '复用描述与种子' : '复用描述' }}
        </button>
        <button
          v-if="resultEditReady"
          class="btn"
          type="button"
          :disabled="busy || hostingBusy || resultBusy"
          @click="continueEditing"
        >
          修改这张图
        </button>
        <button
          class="btn primary"
          type="button"
          :disabled="albumSaved || resultBusy || hostingBusy || busy"
          @click="saveToAlbum"
        >
          {{ albumSaved ? '已保存到生图相册' : resultBusy ? '处理中…' : '保存到生图相册' }}
        </button>
      </div>
      <button
        v-if="result"
        class="btn"
        type="button"
        :disabled="busy || hostingBusy || resultBusy"
        @click="generateAnother"
      >
        {{ result?.provider === 'novelai' ? '再生成一张（随机种子）' : '再生成一张' }}
      </button>
      <details v-if="result" class="result-more">
        <summary>名称、分类与导出</summary>
        <div class="adv">
          <div class="row2">
            <label
              >名称<input
                v-model="assetName"
                class="input"
                :disabled="albumSaved || resultBusy || hostingBusy"
                placeholder="留空使用画面描述"
            /></label>
            <label
              >分类<input
                v-model="category"
                class="input"
                :disabled="albumSaved || resultBusy || hostingBusy"
                placeholder="例如：背景、立绘"
            /></label>
          </div>
          <div class="image-generation-actions field-gap">
            <button
              v-if="canSaveToPhone"
              class="btn"
              type="button"
              :disabled="resultBusy || hostingBusy || busy"
              @click="saveToPhone"
            >
              保存到手机相册
            </button>
            <button
              class="btn"
              type="button"
              :disabled="resultBusy || hostingBusy || busy"
              @click="openSection('cloud')"
            >
              上传图床获取直链
            </button>
          </div>
        </div>
      </details>
    </section>

    <section v-else class="panel secondary">
      <header>
        <div>
          <strong>上传图床获取直链</strong
          ><small>图片将发送到所选图床，并把链接记录到本机生图相册。</small>
        </div>
      </header>
      <!-- SRL-PUBLIC-SYNC: BEGIN REPLACE id=image-generation-hosting-controls -->
      <div class="image-generation-hosting-form">
        <label
          ><span>Origin</span
          ><input v-model="selfHostedOrigin" type="url" placeholder="https://img.example.com"
        /></label>
        <label><span>Token</span><input v-model="selfHostedToken" type="password" /></label>
        <label class="image-generation-check"
          ><input v-model="rememberSelfHosted" type="checkbox" /> 记住连接</label
        >
        <button type="button" @click="saveSelfHostedConnection">
          {{ selfHostedReady ? '更新连接' : '保存连接' }}
        </button>
      </div>
      <button
        class="btn primary image-generation-primary"
        type="button"
        :disabled="!result || hostingBusy || busy || !selfHostedReady"
        @click="hostResult"
      >
        {{ hostingBusy ? '生成直链中…' : '生成直链' }}
      </button>
      <!-- SRL-PUBLIC-SYNC: END REPLACE id=image-generation-hosting-controls -->
      <label v-if="hostedUrl"
        ><span>当前直链</span><input :value="hostedUrl" type="url" readonly
      /></label>
    </section>

    <div v-if="feedbackError || notice" class="image-generation-feedback">
      <p v-if="feedbackError" class="error" role="alert">{{ feedbackError }}</p>
      <p v-else role="status">{{ notice }}</p>
      <button
        v-if="!feedbackError || !requestPreview.error"
        class="btn"
        type="button"
        aria-label="关闭提示"
        @click="clearFeedback"
      >
        ×
      </button>
    </div>
  </section>
</template>

<style scoped src="../styles/ImageGenerationApp.css"></style>
