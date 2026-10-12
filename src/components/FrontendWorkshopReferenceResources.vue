<script setup lang="ts">
import { ref } from 'vue'
import { deepSeaConversation } from '../utils/FrontendWorkshopTemplateWalkthrough'

defineProps<{ mode: 'sites' | 'templates'; canUseAi?: boolean }>()
const emit = defineEmits<{ usePrompt: [text: string] }>()
const copied = ref('')
const manualCopy = ref('')
const sites = [
  {
    name: 'GSAP Demo Hub',
    url: 'https://demos.gsap.com/',
    type: '官方演示',
    use: '滚动叙事、文字拆分、拖动、路径与复杂时间线。',
  },
  {
    name: 'Codrops',
    url: 'https://tympanus.net/codrops/',
    type: '创意教程',
    use: '透视画廊、图片形变、沉浸式页面；常附演示与实现讲解。',
  },
  {
    name: 'Three.js Examples',
    url: 'https://threejs.org/examples/',
    type: '官方示例',
    use: '真实三维、材质、镜头、后期效果与 CSS 3D。',
  },
  {
    name: 'Motion Examples',
    url: 'https://motion.dev/examples',
    type: '官方示例',
    use: '布局切换、弹簧、拖动与滚动动画；部分示例需会员。',
  },
  {
    name: 'Anime.js',
    url: 'https://animejs.com/',
    type: '官方演示',
    use: '交错入场、SVG 描边与形变、路径、时间线。',
  },
  {
    name: 'Animista',
    url: 'https://animista.net/',
    type: 'CSS 调参工具',
    use: '直接调节淡入、滑动、翻转等效果，并查看 CSS。',
  },
]
const reproductions = [
  {
    name: '折页档案 · 开场白',
    prompt:
      '请制作一个精致的酒馆角色开场白介绍页，角色为沈知遥。用暖纸、墨色和克制的金属色做编辑式排版，包含角色名、大幅角色图、人物简介、作者介绍与禁止二传说明。不要普通资料卡。加入有透视、正反面和纸张阴影的立体翻页，翻面后文字必须正向可读；再加入卡片堆叠、轻微视差和错峰入场。写好至少三则不同情境的备用开场白，目录显示标题、摘要和试读。点击进入应调用已核对的酒馆助手接口切换第0条消息真实备用开场白，不能只替换页面内文字。完整作品包带角色卡与备用开场白。使用适合消息iframe的HTML/CSS/JavaScript，手机重新安排布局，正文自然滚动，图片失败可读，支持减少动态效果；快速翻页与切换不乱序。按内容自动整理中文图层。先生成完整作品，之后再按我选定的范围局部修改。',
  },
  {
    name: '星图剧场 · 人物志',
    prompt:
      '请制作一个精致的酒馆人物介绍页，角色为闻星。用墨蓝、雾白与少量星光构成空间舞台，人物为视觉核心，不能用普通仪表盘卡片。加入可旋转、有远近透视的档案轮盘；背景、角色、前景做克制的分层视差；滚动时章节依次揭示；用可以切换的叙事牌堆介绍“停电的天文台”“凌晨的末班车”“寄给明天的信”，写完整备用开场白。目录点击应切换酒馆真实备用开场白，角色卡数据随作品导出。增加只读MVU关系状态区：使用已核对的Mvu.getMvuData读取当前楼层stat_data，变量更新后刷新；变量路径可配置，变量缺失显示未提供，不编造数值、不写入用户变量。接口不清楚先查资料。原生HTML/CSS/JavaScript适配消息iframe；手机可触控、正文底部可达，图片失败可读，支持减少动态效果、卸载清理和多实例隔离。自动组织中文图层。先输出可运行的完整作品，再局部调整和提取组件。',
  },
]
async function copy(text: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    copied.value = `已复制${label}`
    manualCopy.value = ''
  } catch {
    manualCopy.value = text
    copied.value = '请在下方长按选择并复制。'
  }
}
</script>

<template>
  <section class="fw-reference-resources">
    <template v-if="mode === 'sites'">
      <ul class="fw-reference-sites">
        <li v-for="site in sites" :key="site.url">
          <a :href="site.url" target="_blank" rel="noopener noreferrer"
            ><strong>{{ site.name }}</strong
            ><span aria-hidden="true">↗</span></a
          >
          <small>{{ site.type }}</small>
          <p>{{ site.use }}</p>
        </li>
      </ul>
      <details>
        <summary>看到喜欢的效果，怎么告诉 AI？</summary>
        <p>
          提供具体演示链接，写清触发方式、运动方向、层次和最终状态，再说明要应用到哪个区域。若模型无法读取网页，可补充截图和文字描述。
        </p>
      </details>
    </template>
    <template v-else>
      <details class="fw-template-case" open>
        <summary>深海观测档案 · 真实制作对话</summary>
        <p class="fw-template-meta">模型：deepseekv4f · 当时接口标识 deepseek-flash · 高思考</p>
        <p>
          五轮发送的提示词全部保留，换行已整理；可核实的 AI
          文字回复与操作结果分开展示，省略代码和思考过程。
        </p>
        <ol class="fw-template-turns">
          <li v-for="(turn, index) in deepSeaConversation" :key="turn.title">
            <h3>{{ index + 1 }}. {{ turn.title }}</h3>
            <p>{{ turn.operation }}</p>
            <details>
              <summary>发送给 AI 的完整提示词</summary>
              <p class="fw-template-text">{{ turn.prompt }}</p>
              <div class="fw-template-actions">
                <button
                  type="button"
                  class="button button--secondary"
                  @click="copy(turn.prompt, '提示词')"
                >
                  复制提示词</button
                ><button
                  v-if="canUseAi"
                  type="button"
                  class="button button--secondary"
                  @click="emit('usePrompt', turn.prompt)"
                >
                  带入 AI
                </button>
              </div>
            </details>
            <details v-if="turn.reply">
              <summary>AI 文字回复</summary>
              <p class="fw-template-text">{{ turn.reply }}</p>
            </details>
            <p class="fw-template-result">操作结果：{{ turn.result }}</p>
          </li>
        </ol>
      </details>
      <details v-for="item in reproductions" :key="item.name" class="fw-template-case">
        <summary>{{ item.name }} · 复现提示词</summary>
        <p>
          原模板由 Codex 编写并调试。以下按现有模板整理，供使用 deepseekv4f
          等模型重新制作；不是当时的 DS 对话记录。
        </p>
        <p class="fw-template-text">{{ item.prompt }}</p>
        <div class="fw-template-actions">
          <button
            type="button"
            class="button button--secondary"
            @click="copy(item.prompt, '提示词')"
          >
            复制提示词</button
          ><button
            v-if="canUseAi"
            type="button"
            class="button button--secondary"
            @click="emit('usePrompt', item.prompt)"
          >
            带入 AI
          </button>
        </div>
        <p>
          操作顺序：新建开场白 → AI 创作（工作模式）→ 发送要求 → 检查预览与开场白 → 局部修改 →
          满意后存为组件或导出完整作品包 → 在酒馆验证。
        </p>
      </details>
      <p v-if="copied" role="status">{{ copied }}</p>
      <textarea v-if="manualCopy" :value="manualCopy" readonly aria-label="手动复制模板提示词" />
    </template>
  </section>
</template>

<style scoped>
.fw-reference-resources {
  padding: 12px;
  font-size: 14px;
  overflow-wrap: anywhere;
}
.fw-reference-sites {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr));
  gap: 12px;
  list-style: none;
  margin: 0 0 16px;
  padding: 0;
}
.fw-reference-sites li {
  border-bottom: 1px solid var(--color-line);
  padding: 4px 0 10px;
}
.fw-reference-sites a {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 32px;
  color: var(--color-accent);
}
.fw-reference-sites small,
.fw-template-meta {
  color: var(--color-ink-soft);
  font-size: 12px;
}
.fw-reference-resources p {
  margin: 8px 0;
}
.fw-template-case {
  border-bottom: 1px solid var(--color-line);
  padding-block: 8px;
}
summary {
  cursor: pointer;
  padding-block: 6px;
}
.fw-template-case > summary {
  font-weight: 650;
}
.fw-template-turns {
  list-style: none;
  padding: 0;
  margin: 0;
}
.fw-template-turns > li {
  border-top: 1px solid var(--color-line);
  padding-block: 8px;
}
.fw-template-turns h3 {
  margin: 0;
  font-size: 14px;
}
.fw-template-text {
  white-space: pre-wrap;
  line-height: 1.7;
  user-select: text;
}
.fw-template-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.fw-template-actions .button {
  min-height: 30px;
  padding: 4px 8px;
  font-size: 12px;
}
.fw-template-result {
  font-size: 12px;
  color: var(--color-ink-soft);
}
textarea {
  width: 100%;
  min-height: 160px;
  font-size: 16px;
  color: var(--color-ink);
  background: var(--control-background, var(--color-surface));
}
</style>
