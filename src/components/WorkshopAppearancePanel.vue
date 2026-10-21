<script setup lang="ts">
import { toRef, type ShallowUnwrapRef } from 'vue'
import type { useFrontendWorkshopApp } from '../composables/UseFrontendWorkshopApp'
import type { WorkshopDesignTokens } from '../utils/FrontendWorkshop'
function submitOnEnter(event: KeyboardEvent, action: () => void): void {
  if (event.isComposing) return
  event.preventDefault()
  action()
}
type PanelModel = Pick<
  ShallowUnwrapRef<ReturnType<typeof useFrontendWorkshopApp>>,
  | 'activeDesignPanel'
  | 'interactionOptions'
  | 'interactions'
  | 'toggleInteraction'
  | 'style'
  | 'designTokenKeys'
  | 'designTokenOptions'
  | 'designTokens'
  | 'selectDesignToken'
  | 'selectedMaterialRecipe'
  | 'promptInjectionEnabled'
  | 'modulePromptPreviews'
  | 'promptCustomizations'
  | 'dataMode'
  | 'conditionRules'
  | 'conditionFieldPath'
  | 'parsedFields'
  | 'conditionOperator'
  | 'conditionOperatorOptions'
  | 'conditionValue'
  | 'conditionColor'
  | 'conditionBackground'
  | 'addConditionRule'
  | 'removeConditionRule'
  | 'blocks'
  | 'blockSceneOptions'
  | 'activeBlockSceneId'
  | 'applyBlockScene'
  | 'blockOptions'
  | 'toggleBlock'
  | 'mobileComplexity'
  | 'blockSkeleton'
  | 'imageUrlDraft'
  | 'addImageUrl'
  | 'imageUrls'
  | 'removeImageUrl'
  | 'selectedTargetSize'
  | 'targetSizePresets'
  | 'targetSizePreset'
  | 'applyTargetSizePreset'
  | 'targetWidth'
  | 'applyCustomTargetSize'
  | 'targetHeight'
  | 'openLayoutStudio'
  | 'layoutReference'
  | 'clearLayoutReference'
  | 'importPalette'
  | 'activePaletteId'
  | 'paletteOptions'
  | 'choosePalette'
  | 'removeImportedPalette'
  | 'paletteStatus'
  | 'titleTypography'
  | 'typographyOptions'
  | 'titleFontUrl'
  | 'bodyTypography'
  | 'bodyFontUrl'
  | 'selectedTitleStack'
  | 'selectedBodyStack'
  | 'customTextStyles'
  | 'customTextStyleName'
  | 'addCustomTextStyle'
  | 'removeCustomTextStyle'
  | 'typographyStack'
  | 'addReferenceImages'
  | 'referenceScopeOptions'
  | 'referenceScopes'
  | 'toggleReferenceScope'
  | 'referenceGuidance'
  | 'referenceImages'
  | 'removeReferenceImage'
  | 'lockedAspectOptions'
  | 'lockedAspects'
  | 'toggleLockedAspect'
>
const input = defineProps<{ model: PanelModel }>()
const activeDesignPanel = toRef(input.model, 'activeDesignPanel')
const interactionOptions = toRef(input.model, 'interactionOptions')
const interactions = toRef(input.model, 'interactions')
const toggleInteraction = toRef(input.model, 'toggleInteraction')
const style = toRef(input.model, 'style')
const designTokenKeys = toRef(input.model, 'designTokenKeys')
const designTokenOptions = toRef(input.model, 'designTokenOptions')
const designTokens = toRef(input.model, 'designTokens')
const selectDesignToken = toRef(input.model, 'selectDesignToken')
const selectedMaterialRecipe = toRef(input.model, 'selectedMaterialRecipe')
const promptInjectionEnabled = toRef(input.model, 'promptInjectionEnabled')
const modulePromptPreviews = toRef(input.model, 'modulePromptPreviews')
const promptCustomizations = toRef(input.model, 'promptCustomizations')
const dataMode = toRef(input.model, 'dataMode')
const conditionRules = toRef(input.model, 'conditionRules')
const conditionFieldPath = toRef(input.model, 'conditionFieldPath')
const parsedFields = toRef(input.model, 'parsedFields')
const conditionOperator = toRef(input.model, 'conditionOperator')
const conditionOperatorOptions = toRef(input.model, 'conditionOperatorOptions')
const conditionValue = toRef(input.model, 'conditionValue')
const conditionColor = toRef(input.model, 'conditionColor')
const conditionBackground = toRef(input.model, 'conditionBackground')
const addConditionRule = toRef(input.model, 'addConditionRule')
const removeConditionRule = toRef(input.model, 'removeConditionRule')
const blocks = toRef(input.model, 'blocks')
const blockSceneOptions = toRef(input.model, 'blockSceneOptions')
const activeBlockSceneId = toRef(input.model, 'activeBlockSceneId')
const applyBlockScene = toRef(input.model, 'applyBlockScene')
const blockOptions = toRef(input.model, 'blockOptions')
const toggleBlock = toRef(input.model, 'toggleBlock')
const mobileComplexity = toRef(input.model, 'mobileComplexity')
const blockSkeleton = toRef(input.model, 'blockSkeleton')
const imageUrlDraft = toRef(input.model, 'imageUrlDraft')
const addImageUrl = toRef(input.model, 'addImageUrl')
const imageUrls = toRef(input.model, 'imageUrls')
const removeImageUrl = toRef(input.model, 'removeImageUrl')
const selectedTargetSize = toRef(input.model, 'selectedTargetSize')
const targetSizePresets = toRef(input.model, 'targetSizePresets')
const targetSizePreset = toRef(input.model, 'targetSizePreset')
const applyTargetSizePreset = toRef(input.model, 'applyTargetSizePreset')
const targetWidth = toRef(input.model, 'targetWidth')
const applyCustomTargetSize = toRef(input.model, 'applyCustomTargetSize')
const targetHeight = toRef(input.model, 'targetHeight')
const openLayoutStudio = toRef(input.model, 'openLayoutStudio')
const layoutReference = toRef(input.model, 'layoutReference')
const clearLayoutReference = toRef(input.model, 'clearLayoutReference')
const importPalette = toRef(input.model, 'importPalette')
const activePaletteId = toRef(input.model, 'activePaletteId')
const paletteOptions = toRef(input.model, 'paletteOptions')
const choosePalette = toRef(input.model, 'choosePalette')
const removeImportedPalette = toRef(input.model, 'removeImportedPalette')
const paletteStatus = toRef(input.model, 'paletteStatus')
const titleTypography = toRef(input.model, 'titleTypography')
const typographyOptions = toRef(input.model, 'typographyOptions')
const titleFontUrl = toRef(input.model, 'titleFontUrl')
const bodyTypography = toRef(input.model, 'bodyTypography')
const bodyFontUrl = toRef(input.model, 'bodyFontUrl')
const selectedTitleStack = toRef(input.model, 'selectedTitleStack')
const selectedBodyStack = toRef(input.model, 'selectedBodyStack')
const customTextStyles = toRef(input.model, 'customTextStyles')
const customTextStyleName = toRef(input.model, 'customTextStyleName')
const addCustomTextStyle = toRef(input.model, 'addCustomTextStyle')
const removeCustomTextStyle = toRef(input.model, 'removeCustomTextStyle')
const typographyStack = toRef(input.model, 'typographyStack')
const addReferenceImages = toRef(input.model, 'addReferenceImages')
const referenceScopeOptions = toRef(input.model, 'referenceScopeOptions')
const referenceScopes = toRef(input.model, 'referenceScopes')
const toggleReferenceScope = toRef(input.model, 'toggleReferenceScope')
const referenceGuidance = toRef(input.model, 'referenceGuidance')
const referenceImages = toRef(input.model, 'referenceImages')
const removeReferenceImage = toRef(input.model, 'removeReferenceImage')
const lockedAspectOptions = toRef(input.model, 'lockedAspectOptions')
const lockedAspects = toRef(input.model, 'lockedAspects')
const toggleLockedAspect = toRef(input.model, 'toggleLockedAspect')
</script>
<template>
  <div
    class="frontend-workshop__design-panel"
    data-design-panel="appearance"
    :class="{ 'is-active': activeDesignPanel === 'appearance' }"
  >
    <section class="frontend-workshop__axis" aria-labelledby="workshop-interaction">
      <header>
        <span>
          <small>INTERACTION</small>
          <strong id="workshop-interaction">界面复杂度</strong>
        </span>
        <em>可多选</em>
      </header>
      <div class="frontend-workshop__interaction-grid">
        <button
          v-for="option in interactionOptions"
          :key="option.value"
          type="button"
          :class="{ 'is-active': interactions.includes(option.value) }"
          :aria-pressed="interactions.includes(option.value)"
          @click="toggleInteraction(option.value)"
        >
          <span aria-hidden="true"></span>
          <strong>{{ option.title }}</strong>
          <small>{{ option.description }}</small>
        </button>
      </div>
    </section>
    <label>
      <span>风格要求</span>
      <textarea
        v-model="style"
        rows="5"
        placeholder="颜色、材质、排版、氛围、移动端密度……"
      ></textarea>
    </label>
    <details class="frontend-workshop__design-tokens">
      <summary>
        <span>
          <small>VISUAL TOKENS</small>
          <strong>材质与精细度</strong>
        </span>
        <em>材质 · 阴影 · 边框 · 密度</em>
      </summary>
      <div>
        <fieldset v-for="tokenKey in designTokenKeys" :key="tokenKey">
          <legend>
            {{
              {
                material: '材质',
                shadow: '阴影',
                border: '边框',
                density: '信息密度',
              }[tokenKey]
            }}
          </legend>
          <button
            v-for="option in designTokenOptions[tokenKey]"
            :key="option[0]"
            type="button"
            :class="{ 'is-active': designTokens[tokenKey] === option[0] }"
            :aria-pressed="designTokens[tokenKey] === option[0]"
            @click="
              selectDesignToken(
                tokenKey,
                option[0] as WorkshopDesignTokens[typeof tokenKey],
                $event,
              )
            "
          >
            <strong>{{ option[1] }}</strong>
            <small>{{ option[2] }}</small>
          </button>
        </fieldset>
        <article class="frontend-workshop__material-recipe">
          <small>MATERIAL RECIPE</small>
          <strong>当前材质会按配方生成</strong>
          <p>{{ selectedMaterialRecipe }}</p>
        </article>
        <details class="frontend-workshop__module-prompt" data-prompt-module="material">
          <summary>查看并自定义材质提示词</summary>
          <label class="frontend-workshop__module-switch">
            <input v-model="promptInjectionEnabled.material" type="checkbox" />
            <span>注入材质与精细度提示词</span>
          </label>
          <pre>{{ modulePromptPreviews.material }}</pre>
          <label>
            <span>自定义材质与精细度提示词（填写后替代默认）</span>
            <textarea
              v-model="promptCustomizations.material"
              rows="4"
              maxlength="4000"
              placeholder="例如：纸面要有细微压纹，不要仿玻璃。"
            ></textarea>
          </label>
          <button type="button" @click="promptCustomizations.material = ''">恢复默认</button>
        </details>
      </div>
    </details>
    <details class="frontend-workshop__conditions">
      <summary>
        <span>
          <small>CONDITIONAL STYLE</small>
          <strong>条件样式</strong>
        </span>
        <em>{{ dataMode === 'mvu' ? `${conditionRules.length} 条` : '仅 MVU 可用' }}</em>
      </summary>
      <p>
        例如“好感度大于 80 时换色”。条件由本地编译器读取 MVU 楼层变量，不让 AI 自己编造判断代码。
      </p>
      <div class="frontend-workshop__condition-form">
        <select v-model="conditionFieldPath" :disabled="dataMode !== 'mvu'">
          <option value="">选择字段</option>
          <option v-for="field in parsedFields" :key="field.path" :value="field.path">
            {{ field.group }} / {{ field.label }}
          </option>
        </select>
        <select v-model="conditionOperator" :disabled="dataMode !== 'mvu'">
          <option
            v-for="option in conditionOperatorOptions"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </option>
        </select>
        <input
          v-model="conditionValue"
          :disabled="dataMode !== 'mvu'"
          placeholder="条件值，如 80"
        />
        <label>
          <span>文字</span>
          <input v-model="conditionColor" type="color" :disabled="dataMode !== 'mvu'" />
        </label>
        <label>
          <span>背景</span>
          <input v-model="conditionBackground" type="color" :disabled="dataMode !== 'mvu'" />
        </label>
        <button type="button" :disabled="dataMode !== 'mvu'" @click="addConditionRule">
          添加规则
        </button>
      </div>
      <ul v-if="conditionRules.length">
        <li v-for="rule in conditionRules" :key="rule.id">
          <span
            :style="{
              color: rule.color || undefined,
              background: rule.background || undefined,
            }"
          >
            {{ rule.fieldLabel }}
            {{ conditionOperatorOptions.find((option) => option.value === rule.operator)?.label }}
            {{ rule.value }}
          </span>
          <button type="button" aria-label="删除条件样式" @click="removeConditionRule(rule.id)">
            ×
          </button>
        </li>
      </ul>
      <details class="frontend-workshop__module-prompt" data-prompt-module="conditions">
        <summary>查看并自定义条件样式提示词</summary>
        <label class="frontend-workshop__module-switch">
          <input v-model="promptInjectionEnabled.conditions" type="checkbox" />
          <span>注入条件样式提示词</span>
        </label>
        <pre>{{ modulePromptPreviews.conditions }}</pre>
        <label>
          <span>自定义条件样式提示词（填写后替代默认）</span>
          <textarea
            v-model="promptCustomizations.conditions"
            rows="4"
            maxlength="4000"
            placeholder="例如：激活时只强调标题和数值，不要整卡变色。"
          ></textarea>
        </label>
        <button type="button" @click="promptCustomizations.conditions = ''">恢复默认</button>
      </details>
    </details>
    <details class="frontend-workshop__blocks">
      <summary>
        <span>
          <small>VERIFIED BLOCKS</small>
          <strong>组件积木</strong>
        </span>
        <em>AI 组合，本地校验</em>
      </summary>
      <p>
        积木不是代码课，而是告诉
        AI“成品里必须真的出现哪些区域”。系统会逐项验收并自动补漏一次；你只需要按想看到的效果选择。
        <template v-if="blocks.length >= 5">
          当前已选 {{ blocks.length }} 个，属于复杂方案；建议字段也准备足够，否则 AI
          可能只能把同一批字段分配到多个区域。
        </template>
      </p>
      <section class="frontend-workshop__block-scenes" aria-labelledby="workshop-scenes">
        <header>
          <span>
            <small>SCENE STARTERS</small>
            <strong id="workshop-scenes">先按使用场景选骨架</strong>
          </span>
          <em>会替换当前积木组合，不改字段和风格</em>
        </header>
        <div>
          <button
            v-for="scene in blockSceneOptions"
            :key="scene.id"
            type="button"
            :class="{ 'is-active': activeBlockSceneId === scene.id }"
            :aria-pressed="activeBlockSceneId === scene.id"
            :data-scene-id="scene.id"
            @click="applyBlockScene(scene.id)"
          >
            <strong>{{ scene.title }}</strong>
            <small>{{ scene.description }}</small>
            <span>
              {{
                scene.blocks
                  .map(
                    (block) =>
                      blockOptions.find((option) => option.value === block)?.title ?? block,
                  )
                  .join(' + ')
              }}
            </span>
          </button>
        </div>
      </section>
      <div class="frontend-workshop__block-grid" role="group" aria-label="可选组件积木">
        <button
          v-for="option in blockOptions"
          :key="option.value"
          type="button"
          :class="{ 'is-active': blocks.includes(option.value) }"
          :aria-pressed="blocks.includes(option.value)"
          :data-block-id="option.value"
          @click="toggleBlock(option.value)"
        >
          <div
            class="frontend-workshop__block-preview"
            :data-block-preview="option.value"
            aria-hidden="true"
          >
            <span v-if="blocks.includes(option.value)" class="frontend-workshop__block-selected"
              >已加入</span
            >
            <div
              v-if="option.value === 'character-header'"
              class="frontend-workshop__mock-character"
            >
              <span class="frontend-workshop__mock-avatar"></span>
              <span class="frontend-workshop__mock-copy">
                <i></i>
                <i></i>
                <i></i>
              </span>
              <b>状态</b>
            </div>
            <div
              v-else-if="option.value === 'attribute-grid'"
              class="frontend-workshop__mock-attributes"
            >
              <span><b>生命</b><i style="--fill: 78%"></i></span>
              <span><b>理智</b><i style="--fill: 54%"></i></span>
              <span><b>体力</b><i style="--fill: 66%"></i></span>
              <span><b>好感</b><i style="--fill: 84%"></i></span>
            </div>
            <div
              v-else-if="option.value === 'relationship-card'"
              class="frontend-workshop__mock-relationship"
            >
              <span class="frontend-workshop__mock-person"></span>
              <span class="frontend-workshop__mock-bond"><i></i><b>67</b></span>
              <span class="frontend-workshop__mock-person"></span>
              <small>熟悉 · 信任上升</small>
            </div>
            <div v-else-if="option.value === 'inventory'" class="frontend-workshop__mock-inventory">
              <span><b>武器</b><b>道具</b><b>线索</b></span>
              <i></i>
              <i></i>
              <i></i>
            </div>
            <div
              v-else-if="option.value === 'quest-timeline'"
              class="frontend-workshop__mock-timeline"
            >
              <span class="is-done"><i></i><b>已经完成</b></span>
              <span class="is-current"><i></i><b>当前目标</b></span>
              <span><i></i><b>下一阶段</b></span>
            </div>
            <div v-else-if="option.value === 'character-tabs'" class="frontend-workshop__mock-tabs">
              <span><b class="is-active">林</b><b>沈</b><b>苏</b></span>
              <i></i>
              <i></i>
              <i></i>
            </div>
            <div
              v-else-if="option.value === 'long-collapse'"
              class="frontend-workshop__mock-collapse"
            >
              <span><b>详细状态</b><i></i></span>
              <em></em>
              <em></em>
              <em></em>
            </div>
            <div v-else class="frontend-workshop__mock-banner">
              <span></span>
              <b>章节视觉</b>
              <i></i>
            </div>
          </div>
          <header class="frontend-workshop__block-heading">
            <strong>{{ option.title }}</strong>
            <small>原名：{{ option.technicalName }}</small>
          </header>
          <p>{{ option.description }}</p>
          <dl>
            <div>
              <dt>适合这样用</dt>
              <dd>{{ option.bestFor }}</dd>
            </div>
            <div>
              <dt>加入后</dt>
              <dd>{{ option.structure }}</dd>
            </div>
          </dl>
          <footer>
            <em>{{ option.compatibility }}</em>
            <span>{{ blocks.includes(option.value) ? '点击移除' : '点击加入' }}</span>
          </footer>
        </button>
      </div>
      <section
        class="frontend-workshop__block-blueprint"
        :data-complexity="mobileComplexity.level"
        aria-live="polite"
      >
        <header>
          <span>
            <small>MOBILE BLUEPRINT</small>
            <strong>状态栏骨架</strong>
          </span>
          <em>移动端复杂度：{{ mobileComplexity.label }}</em>
        </header>
        <ol v-if="blockSkeleton.length">
          <li v-for="item in blockSkeleton" :key="item.block">
            <span>{{ item.title }}</span>
            <strong>{{ item.assignment }}</strong>
          </li>
        </ol>
        <p v-else>选择场景模板或单个积木后，这里会即时显示区域顺序与字段分配。</p>
        <ul>
          <li v-for="advice in mobileComplexity.advice" :key="advice">{{ advice }}</li>
        </ul>
      </section>
      <details class="frontend-workshop__module-prompt" data-prompt-module="blocks">
        <summary>查看并自定义组件积木提示词</summary>
        <label class="frontend-workshop__module-switch">
          <input v-model="promptInjectionEnabled.blocks" type="checkbox" />
          <span>注入组件积木提示词</span>
        </label>
        <pre>{{ modulePromptPreviews.blocks }}</pre>
        <label>
          <span>自定义组件积木提示词（填写后替代默认）</span>
          <textarea
            v-model="promptCustomizations.blocks"
            rows="4"
            maxlength="4000"
            placeholder="例如：人物头部与关系卡形成错落档案页，不要对称卡片阵列。"
          ></textarea>
        </label>
        <button type="button" @click="promptCustomizations.blocks = ''">恢复默认</button>
      </details>
      <section class="frontend-workshop__image-urls">
        <header>
          <strong>成品图片直链</strong>
          <small>与给 AI 看的参考图不同；这些 URL 会写入模板</small>
        </header>
        <div>
          <input
            v-model="imageUrlDraft"
            inputmode="url"
            placeholder="https://example.com/character.webp"
            @keydown.enter="submitOnEnter($event, addImageUrl)"
          />
          <button type="button" @click="addImageUrl">添加</button>
        </div>
        <ul v-if="imageUrls.length">
          <li v-for="url in imageUrls" :key="url">
            <span>{{ url }}</span>
            <button type="button" aria-label="移除图片直链" @click="removeImageUrl(url)">×</button>
          </li>
        </ul>
        <p>
          仅接受 HTTPS，最多 4
          条。图片失效时仍必须保留文字信息；是否联网加载继续受资源库预览安全设置和真实酒馆网络影响。
        </p>
      </section>
    </details>
    <section class="frontend-workshop__target-size">
      <header>
        <span>
          <small>DESIGN RATIO</small>
          <strong>状态栏尺寸与比例</strong>
        </span>
        <em>
          {{
            selectedTargetSize
              ? `${selectedTargetSize.width}×${selectedTargetSize.height}`
              : '自动高度'
          }}
        </em>
      </header>
      <p>
        这些是构图预设，不是酒馆强制像素。最终成品仍会随消息宽度缩放；自由排版画布只保持这里的宽高比例。
      </p>
      <div class="frontend-workshop__size-presets">
        <button
          v-for="preset in targetSizePresets"
          :key="preset.id"
          type="button"
          :class="{ 'is-active': targetSizePreset === preset.id }"
          @click="applyTargetSizePreset(preset.id)"
        >
          <strong>{{ preset.label }}</strong>
          <small>{{ preset.note }}</small>
        </button>
      </div>
      <div v-if="targetSizePreset !== 'auto'" class="frontend-workshop__custom-size">
        <label>
          <span>设计宽度</span>
          <input
            v-model.number="targetWidth"
            type="number"
            min="160"
            max="1200"
            @change="applyCustomTargetSize"
          />
        </label>
        <span aria-hidden="true">×</span>
        <label>
          <span>设计高度</span>
          <input
            v-model.number="targetHeight"
            type="number"
            min="100"
            max="1800"
            @change="applyCustomTargetSize"
          />
        </label>
        <small>
          画布会用相同比例放大到便于操作的尺寸，不会真的缩成
          {{ targetWidth }}×{{ targetHeight }} 像素。
        </small>
      </div>
    </section>
    <section class="frontend-workshop__layout-reference">
      <span>
        <small>LAYOUT BLUEPRINT</small>
        <strong>自由排版参考</strong>
        <p>
          把字段和成品图片拖到想要的位置并缩放。它只告诉 AI
          构图关系，最终仍会转换成适配酒馆消息宽度的响应式布局。位置和大小以方框外沿为准，框中文字只是内容示意。
        </p>
      </span>
      <div class="frontend-workshop__layout-reference-actions">
        <button type="button" @click="openLayoutStudio">
          {{ layoutReference?.items.length ? '继续调整布局' : '进入全屏排版' }}
        </button>
        <button
          v-if="layoutReference?.items.length"
          type="button"
          class="is-clear"
          @click="clearLayoutReference"
        >
          取消参考
        </button>
      </div>
      <em v-if="layoutReference?.items.length">
        已保存 {{ layoutReference.items.length }} 个对象
      </em>
    </section>
    <section class="frontend-workshop__palettes" aria-labelledby="workshop-palettes">
      <header>
        <span>
          <small>COLOR SYSTEM</small>
          <strong id="workshop-palettes">参考色卡</strong>
        </span>
        <label>
          导入色卡
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,application/json,text/plain,text/css,.gpl"
            @change="importPalette"
          />
        </label>
      </header>
      <p>可不选择。支持色卡图片取色，以及 JSON、CSS、TXT、GPL 中的 HEX/RGB 色值。</p>
      <div class="frontend-workshop__palette-strip">
        <button
          type="button"
          :class="{ 'is-active': !activePaletteId }"
          @click="activePaletteId = ''"
        >
          <strong>不限定配色</strong>
          <small>由风格要求决定</small>
        </button>
        <article
          v-for="palette in paletteOptions"
          :key="palette.id"
          :class="{ 'is-active': activePaletteId === palette.id }"
        >
          <button type="button" @click="choosePalette(palette.id)">
            <span>
              <i
                v-for="color in palette.colors"
                :key="color"
                :style="{ backgroundColor: color }"
                :title="color"
              ></i>
            </span>
            <strong>{{ palette.name }}</strong>
            <small>{{ palette.source === 'classic' ? '经典配色' : '导入色卡' }}</small>
          </button>
          <button
            v-if="palette.source === 'imported'"
            type="button"
            aria-label="删除导入色卡"
            @click="removeImportedPalette(palette.id)"
          >
            ×
          </button>
        </article>
      </div>
      <small v-if="paletteStatus" role="status">{{ paletteStatus }}</small>
    </section>
    <section class="frontend-workshop__typography" aria-labelledby="workshop-typography">
      <header>
        <span>
          <small>TYPOGRAPHY</small>
          <strong id="workshop-typography">字体与排版</strong>
        </span>
        <em>本机字体或用户直链</em>
      </header>
      <div class="frontend-workshop__type-pickers">
        <label>
          <span>标题方向</span>
          <select v-model="titleTypography">
            <option
              v-for="option in typographyOptions"
              :key="`title-${option.value}`"
              :value="option.value"
            >
              {{ option.label }} · {{ option.description }}
            </option>
          </select>
          <input
            v-if="titleTypography === 'custom'"
            v-model="titleFontUrl"
            inputmode="url"
            placeholder="标题字体 HTTPS 直链，推荐 .woff2"
          />
        </label>
        <label>
          <span>正文方向</span>
          <select v-model="bodyTypography">
            <option
              v-for="option in typographyOptions"
              :key="`body-${option.value}`"
              :value="option.value"
            >
              {{ option.label }} · {{ option.description }}
            </option>
          </select>
          <input
            v-if="bodyTypography === 'custom'"
            v-model="bodyFontUrl"
            inputmode="url"
            placeholder="正文字体 HTTPS 直链，推荐 .woff2"
          />
        </label>
      </div>
      <div class="frontend-workshop__type-specimen">
        <span :style="{ fontFamily: selectedTitleStack }">角色 · 状态档案</span>
        <p :style="{ fontFamily: selectedBodyStack }">
          地点：城南 · 状态：正在探索 · 数值：82 / 100
        </p>
        <small> 自定义字体只使用你填写的白名单直链；需要服务器允许跨域，失效时自动回退。 </small>
      </div>
      <details class="frontend-workshop__text-styles">
        <summary>
          <span><strong>自定义文字样式</strong><small>例如小字、旁白、数值</small></span>
          <em>{{ customTextStyles.length }} / 6</em>
        </summary>
        <div class="frontend-workshop__text-style-add">
          <input
            v-model="customTextStyleName"
            maxlength="20"
            placeholder="样式名称，例如：小字"
            @keydown.enter="submitOnEnter($event, addCustomTextStyle)"
          />
          <button type="button" @click="addCustomTextStyle">添加</button>
        </div>
        <article v-for="(textStyle, index) in customTextStyles" :key="textStyle.id">
          <header>
            <strong>{{ textStyle.label }}</strong>
            <button
              type="button"
              :aria-label="`删除${textStyle.label}样式`"
              @click="removeCustomTextStyle(textStyle.id)"
            >
              ×
            </button>
          </header>
          <select v-model="textStyle.typography">
            <option
              v-for="option in typographyOptions"
              :key="`${textStyle.id}-${option.value}`"
              :value="option.value"
            >
              {{ option.label }} · {{ option.description }}
            </option>
          </select>
          <input
            v-if="textStyle.typography === 'custom'"
            v-model="textStyle.fontUrl"
            inputmode="url"
            :placeholder="`${textStyle.label}字体 HTTPS 直链，推荐 .woff2`"
          />
          <small
            :style="{
              fontFamily: typographyStack(textStyle.typography, `SRLUserFontStyle${index + 1}`),
            }"
          >
            {{ textStyle.label }}预览：补充说明与次要信息
          </small>
        </article>
      </details>
    </section>
    <section class="frontend-workshop__references">
      <header>
        <span><strong>参考图</strong><small>可选 · 最多 3 张</small></span>
        <label>
          添加图片
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            @change="addReferenceImages"
          />
        </label>
      </header>
      <p>仅在所选模型支持识图时使用。请说明参考范围，避免 AI 把图片中的文字或布局全部照搬。</p>
      <div class="frontend-workshop__scope-chips" aria-label="参考图使用范围">
        <button
          v-for="option in referenceScopeOptions"
          :key="option.value"
          type="button"
          :class="{ 'is-active': referenceScopes.includes(option.value) }"
          :aria-pressed="referenceScopes.includes(option.value)"
          @click="toggleReferenceScope(option.value)"
        >
          {{ option.label }}
        </button>
      </div>
      <input
        v-model="referenceGuidance"
        class="frontend-workshop__reference-guidance"
        placeholder="补充说明，例如：字体只参考笔画气质，不照搬文字"
      />
      <div v-if="referenceImages.length" class="frontend-workshop__reference-grid">
        <figure v-for="image in referenceImages" :key="image.id">
          <img :src="image.dataUrl" :alt="image.name" />
          <figcaption>{{ image.name }}</figcaption>
          <button type="button" aria-label="移除参考图" @click="removeReferenceImage(image.id)">
            ×
          </button>
        </figure>
      </div>
    </section>
    <section class="frontend-workshop__locks" aria-labelledby="workshop-locks">
      <header>
        <span>
          <small>REVISION LOCKS</small>
          <strong id="workshop-locks">二次修改保护</strong>
        </span>
        <em>防止 AI 越改越偏</em>
      </header>
      <div>
        <button
          v-for="option in lockedAspectOptions"
          :key="option.value"
          type="button"
          :class="{ 'is-active': lockedAspects.includes(option.value) }"
          :aria-pressed="lockedAspects.includes(option.value)"
          @click="toggleLockedAspect(option.value)"
        >
          {{ option.label }}
        </button>
      </div>
    </section>
    <button
      class="frontend-workshop__panel-next"
      type="button"
      @click="activeDesignPanel = 'generate'"
    >
      下一步：确认并生成
    </button>
  </div>
</template>
<style scoped src="../styles/FrontendWorkshopBase.css"></style>
<style scoped src="../styles/FrontendWorkshopDesignReferences.css"></style>
<style scoped src="../styles/FrontendWorkshopDesignBlocks.css"></style>
<style scoped src="../styles/FrontendWorkshopDesignAppearance.css"></style>
<style scoped src="../styles/FrontendWorkshopDesignInputs.css"></style>
<style scoped src="../styles/FrontendWorkshopProof.css"></style>
<style scoped src="../styles/FrontendWorkshopDelivery.css"></style>
<style scoped src="../styles/FrontendWorkshopResponsive.css"></style>
