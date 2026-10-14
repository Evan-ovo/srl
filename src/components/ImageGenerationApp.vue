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
  appendPrompt,
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
  error,
  canGenerate,
  generate,
  result,
  reuseResult,
  continueEditing,
  candidates,
  candidateIndex,
  hostingBusy,
  getImageGenerationCapabilities,
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
      @back="section === 'generate' ? $emit('back') : (section = 'generate')"
    >
      <template #actions
        ><button
          class="btn"
          type="button"
          @click="section = section === 'generate' ? 'result' : 'generate'"
        >
          {{ section === 'generate' ? '结果' : '返回' }}</button
        ><button class="btn" type="button" @click="$emit('open-album')">相册</button></template
      >
    </FeatureAppHeader>
    <main v-if="section === 'generate' || section === 'connection'" class="shell">
      <section class="panel editor">
        <div class="mobile-preview">
          <img v-if="resultUrl" class="mini-art" :src="resultUrl" alt="当前预览" />
          <div v-else class="mini-art" aria-hidden="true"></div>
          <div class="mini-copy">
            <div class="mini-title">当前预览</div>
            <div class="mini-meta">{{ previewMeta }}</div>
          </div>
          <button class="btn" type="button" @click="section = 'result'">展开</button>
        </div>
        <div class="providerbar">
          <div class="provider-switch image-generation-provider__switch">
            <button
              v-for="item in ['novelai', 'openai'] as const"
              :key="item"
              class="provider-btn"
              type="button"
              :disabled="busy"
              :class="{ active: provider === item }"
              @click="chooseProvider(item)"
            >
              {{ providerLabel(item) }}
            </button>
          </div>
          <div class="modelbox">
            <select
              v-model="config[provider].model"
              class="select"
              aria-label="模型列表"
              :disabled="busy"
              @change="applyModelMetadata"
            >
              <option v-for="model in visibleModels" :key="model.id" :value="model.id">
                {{ model.name }}
              </option>
            </select>
            <button class="btn" type="button" @click="section = 'connection'">模型 / 连接</button>
          </div>
        </div>
        <nav class="tabs" aria-label="供应商功能">
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
        <section class="scroll image-generation-controls">
          <template v-if="section === 'generate'">
            <template v-if="internalTab === 'prompt'">
              <div class="section">
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
                <div class="chips">
                  <button
                    v-for="fragment in ['电影感灯光', '半身构图', '低饱和色彩']"
                    :key="fragment"
                    class="chip"
                    type="button"
                    @click="appendPrompt(fragment)"
                  >
                    + {{ fragment }}</button
                  ><button
                    class="chip"
                    type="button"
                    @click="
                      notice = prompt.trim()
                        ? `当前 Prompt 共 ${prompt.length} 字，请检查主体和构图是否清晰。`
                        : '请先填写画面描述。'
                    "
                  >
                    检查 Prompt
                  </button>
                </div>
              </div>
              <div v-if="capabilities.textRendering === 'supported'" class="section">
                <div class="head">
                  <div>
                    <div class="title">图片中的文字</div>
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
              <div v-if="provider === 'openai'" class="section">
                <div class="head">
                  <div>
                    <div class="title">结构化辅助</div>
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
              <div v-if="provider !== 'openai'" class="workspace-notice">
                {{ capabilities.notes.join(' ') }}
              </div>
            </template>
            <ImageCharacterPromptPanel :model="panelModel" />
            <template v-if="provider === 'novelai' && internalTab === 'reference'">
              <div class="section">
                <div class="head">
                  <div>
                    <div class="title">添加参考图</div>
                    <div class="note">官方模型能力与项目接通状态分别显示。</div>
                  </div>
                </div>
                <div class="dropzone">项目参考图请求链尚未接通，暂不能上传。</div>
              </div>
              <div class="ref-grid">
                <div class="ref">
                  <div class="thumb"></div>
                  <strong>Vibe Transfer</strong>
                  <div class="small">
                    {{
                      capabilities.vibeTransfer === 'supported'
                        ? '官方支持，但项目当前尚未接通'
                        : '当前模型不支持'
                    }}
                  </div>
                </div>
                <div class="ref">
                  <div class="thumb"></div>
                  <strong>Precise Reference</strong>
                  <div class="small">
                    {{
                      capabilities.preciseReference === 'supported'
                        ? '官方支持，但项目当前尚未接通'
                        : '当前模型不支持'
                    }}
                  </div>
                </div>
              </div>
            </template>
            <template v-if="provider === 'openai' && internalTab === 'reference'">
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
                    capabilities.multiImage === 'supported' ? '最多 16 张' : '单张'
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
                  v-for="(image, index) in inputImages"
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
            <template v-if="provider === 'openai' && internalTab === 'edit'">
              <template v-if="capabilities.imageEdit === 'supported'">
                <div class="section">
                  <div class="head">
                    <div>
                      <div class="title">编辑当前图片</div>
                      <div class="note">告诉 GPT 只修改什么。</div>
                    </div>
                  </div>
                  <textarea
                    v-model="editInstruction"
                    class="textarea"
                    aria-label="修改指令"
                    placeholder="例如：把人物外套改成白色，其他内容保持不变。"
                  ></textarea>
                </div>
                <div class="section">
                  <div class="head">
                    <div>
                      <div class="title">保持不变</div>
                      <div class="note">编译为提示词约束，不保证像素完全一致。</div>
                    </div>
                  </div>
                  <label v-for="(label, key) in preserveLabels" :key="key" class="switch-row"
                    ><span>保持{{ label }}</span
                    ><input v-model="preserve[key]" class="switch" type="checkbox"
                  /></label>
                </div>
                <div class="section">
                  <div class="title">快捷编辑</div>
                  <div class="chips">
                    <button
                      v-for="instruction in [
                        '改衣服',
                        '改背景',
                        '改表情',
                        '去掉物体',
                        '添加物体',
                        '修文字',
                      ]"
                      :key="instruction"
                      class="chip"
                      type="button"
                      @click="editInstruction = `${instruction}：`"
                    >
                      {{ instruction }}
                    </button>
                  </div>
                </div>
                <details v-if="capabilities.mask === 'supported'">
                  <summary>Mask（可选）</summary>
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
                      >Quality Mode<select
                        v-model="novelAiQualityMode"
                        class="select"
                        :disabled="Boolean(activeImageText)"
                      >
                        <option value="off">Off</option>
                        <option
                          value="light"
                          :disabled="!capabilities.qualityModes.includes('light')"
                        >
                          Light
                        </option>
                        <option value="standard">Standard</option>
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
                      >Seed<input
                        v-model.number="novelAiSeed"
                        class="input"
                        type="number"
                        min="0"
                        max="4294967295"
                        placeholder="随机 Seed" /></label
                    ><label v-if="capabilities.ucPreset === 'supported'"
                      >UC Preset<select v-model="novelAiUcPreset" class="select">
                        <option value="none">None（手动排除内容）</option>
                        <option value="heavy">Heavy</option>
                        <option value="light">Light</option>
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
                    ><template v-if="capabilities.smea === 'supported'"
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
                  <label v-if="capabilities.background === 'supported'" class="switch-row"
                    ><span>透明背景</span
                    ><input
                      class="switch"
                      type="checkbox"
                      :checked="openAiBackground === 'transparent'"
                      @change="
                        openAiBackground = ($event.target as HTMLInputElement).checked
                          ? 'transparent'
                          : 'auto'
                      "
                  /></label>
                  <div class="row2 image-generation-grid">
                    <label v-if="capabilities.outputFormat === 'supported'"
                      >格式<select v-model="outputFormat" class="select">
                        <option value="png">PNG</option>
                        <option value="webp">WebP</option>
                        <option
                          value="jpeg"
                          :disabled="
                            openAiBackground === 'transparent' &&
                            capabilities.background === 'supported'
                          "
                        >
                          JPEG
                        </option>
                      </select></label
                    ><label
                      v-if="
                        capabilities.outputCompression === 'supported' &&
                        capabilities.outputFormat === 'supported'
                      "
                      >压缩<input
                        v-model.number="outputCompression"
                        class="input"
                        type="number"
                        min="0"
                        max="100"
                        :disabled="outputFormat === 'png'" /></label
                    ><label v-if="capabilities.background === 'supported'"
                      >背景<select v-model="openAiBackground" class="select">
                        <option value="auto">Auto</option>
                        <option value="opaque">普通</option>
                        <option value="transparent">透明</option>
                      </select></label
                    >
                  </div>
                  <div v-if="capabilities.background === 'supported'" class="workspace-notice">
                    透明背景需要 PNG / WebP；JPEG 已禁用。PNG 不发送压缩参数。
                  </div>
                </div>
              </template>
            </template>
            <template v-if="internalTab === 'request'"
              ><div class="section">
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
              <p v-if="requestPreview.error" class="workspace-notice" role="alert">
                {{ requestPreview.error }}
              </p>
              <pre v-else class="code">{{ requestPreview.text }}</pre>
            </template>
          </template>
          <template v-if="section === 'connection' || internalTab === 'connection'">
            <div class="section image-generation-connection">
              <div class="head">
                <div class="title">{{ providerLabel(provider) }} 连接</div>
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
                <p v-if="notice" class="workspace-notice" role="status">{{ notice }}</p>
                <p v-if="error" class="workspace-notice error" role="alert">{{ error }}</p>
              </div>
            </div>
            <details
              v-if="provider === 'openai'"
              class="section image-generation-connection__capabilities"
            >
              <summary>
                兼容能力
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
                      v-if="!capabilities.sources[key] || capabilities.sources[key] === 'manual'"
                      class="check small"
                      ><input
                        type="checkbox"
                        :checked="capabilities[key] === 'supported'"
                        @change="confirmCapability(key, $event)"
                      />我已确认（实验）</label
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
              {{ capabilities.notes.join(' ') || '模型参数按当前能力显示。' }}
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
          <p
            v-if="notice && section !== 'connection' && internalTab !== 'connection'"
            class="workspace-notice"
            role="status"
          >
            {{ notice }}
          </p>
          <p
            v-if="error && section !== 'connection' && internalTab !== 'connection'"
            class="workspace-notice error"
            role="alert"
          >
            {{ error }}
          </p>
        </section>
        <footer class="footerbar image-generation-generate-bar">
          <div class="cost">
            <strong>预计费用未知</strong
            ><span class="small">{{
              provider === 'novelai' ? '以 NovelAI 实际 Anlas 计费为准' : '以供应商实际计费为准'
            }}</span>
          </div>
          <button class="generate" type="button" :disabled="!canGenerate" @click="generate">
            {{ busy ? '取消生成' : '生成图片' }}
          </button>
        </footer>
      </section>
      <aside class="panel preview">
        <div class="stage">
          <img v-if="resultUrl" class="result-art" :src="resultUrl" alt="生成结果" />
          <div v-else class="art">预览区域</div>
        </div>
        <div class="preview-foot">
          <div class="meta">
            <span>{{ previewMeta }}</span
            ><span>最近结果</span>
          </div>
          <div class="preview-actions">
            <button class="btn" type="button" :disabled="!result" @click="reuseResult">
              {{ result?.provider === 'novelai' ? '复用提示 / Seed' : '复用提示词' }}</button
            ><button
              class="btn"
              type="button"
              :disabled="!result"
              @click="result?.provider === 'novelai' ? reuseResult() : continueEditing()"
            >
              {{ result?.provider === 'novelai' ? '继续生成' : '继续编辑' }}</button
            ><button
              class="btn primary"
              type="button"
              :disabled="!result"
              @click="section = 'storage'"
            >
              保存
            </button>
          </div>
        </div>
      </aside>
    </main>
    <section v-else-if="section === 'result'" class="panel secondary">
      <header>
        <div><strong>生成结果</strong><small>当前结果可以继续保存或托管。</small></div>
      </header>
      <div v-if="resultUrl" class="stage image-generation-result">
        <img :src="resultUrl" alt="生成结果" />
      </div>
      <div v-else class="image-generation-empty">还没有生成结果。</div>
      <nav v-if="candidates.length > 1" class="image-generation-actions" aria-label="生成候选">
        <button
          type="button"
          aria-label="上一张生成结果"
          :disabled="candidateIndex === 0 || hostingBusy"
          @click="candidateIndex--"
        >
          上一张
        </button>
        <span>{{ candidateIndex + 1 }} / {{ candidates.length }}</span>
        <button
          type="button"
          aria-label="下一张生成结果"
          :disabled="candidateIndex === candidates.length - 1 || hostingBusy"
          @click="candidateIndex++"
        >
          下一张
        </button>
      </nav>
      <div class="image-generation-actions">
        <button type="button" @click="section = 'generate'">返回调整</button
        ><button
          v-if="
            result &&
            getImageGenerationCapabilities(
              result.provider,
              result.manifest?.model ?? '',
              config[result.provider].relayCapabilities,
              config[result.provider].endpoint,
            ).imageEdit === 'supported'
          "
          type="button"
          @click="continueEditing"
        >
          继续编辑</button
        ><button type="button" :disabled="!result" @click="section = 'storage'">保存结果</button>
      </div>
    </section>

    <section v-else-if="section === 'storage'" class="panel secondary">
      <header>
        <div><strong>存储</strong><small>统一保存到生图相册，供其他功能检索和复用。</small></div>
      </header>
      <button class="btn" type="button" @click="section = 'cloud'">云端生成直链</button>
      <label
        ><span>名称</span><input v-model="assetName" type="text" placeholder="图片名称"
      /></label>
      <label
        ><span>分类</span
        ><input v-model="category" type="text" placeholder="例如：背景、立绘、装饰"
      /></label>
      <button
        class="btn primary image-generation-primary"
        type="button"
        :disabled="!result || albumSaved"
        @click="saveToAlbum"
      >
        {{ albumSaved ? '已保存到生图相册' : '保存到生图相册' }}
      </button>
      <button class="btn" type="button" :disabled="!result || !canSaveToPhone" @click="saveToPhone">
        保存到手机相册
      </button>
    </section>

    <section v-else class="panel secondary">
      <header>
        <div><strong>云端</strong><small>生成稳定 HTTPS 直链；结果会同步写回生图相册。</small></div>
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

    <div v-if="section !== 'generate' && section !== 'connection'" class="secondary-messages">
      <p v-if="notice" class="workspace-notice" role="status">{{ notice }}</p>
      <p v-if="error" class="workspace-notice error" role="alert">{{ error }}</p>
    </div>
  </section>
</template>

<style scoped src="../styles/ImageGenerationApp.css"></style>
