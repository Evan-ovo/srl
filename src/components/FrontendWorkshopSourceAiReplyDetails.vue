<script setup lang="ts">
import { ref } from 'vue'
import type { FrontendWorkshopSourceAiGeneration } from '../services/FrontendWorkshopSourceAiSessionService'
defineProps<{ generation: FrontendWorkshopSourceAiGeneration }>()
const copyStatus = ref('')
const expanded = ref(false)
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    copyStatus.value = '已复制原文'
  } catch {
    copyStatus.value = '复制未成功，可在原文框内全选复制'
  }
}
function safeSource(url?: string): string | undefined {
  return url &&
    /^https:\/\/github\.com\/(?:N0VI028\/JS-Slash-Runner|SillyTavern\/SillyTavern)\/blob\//.test(
      url,
    )
    ? url
    : undefined
}
const labels = {
  receiving: '接收中',
  complete: '已收到并解析',
  invalid: '收到但无法应用',
  interrupted: '已中断',
}
</script>

<template>
  <details
    v-if="generation.receipts?.length || generation.lookups?.length"
    class="source-ai-message__details"
    @toggle="expanded = ($event.target as HTMLDetailsElement).open"
  >
    <summary>回复原文与查资料记录 · AI 请求尝试 {{ generation.receipts?.length ?? 0 }} 次</summary>
    <template v-if="expanded">
      <p>
        额外请求
        {{ Math.max(0, (generation.receipts?.length ?? 0) - 1) }}
        次，包含未成功的尝试。费用以接口服务商账单为准。
      </p>
      <div v-for="(receipt, index) in generation.receipts" :key="receipt.id">
        <p>第 {{ index + 1 }} 次：{{ labels[receipt.status] }}</p>
        <p v-if="receipt.usage">
          {{ receipt.usage.source === 'provider' ? '服务商返回' : '本机估算' }}：输入
          {{ receipt.usage.inputTokens }} / 输出 {{ receipt.usage.outputTokens }} Token
        </p>
        <p v-else>接口未返回用量，无法据此计算费用。</p>
        <p v-if="receipt.error">{{ receipt.error }}</p>
        <button type="button" @click="copy(receipt.rawText)">复制第 {{ index + 1 }} 次原文</button>
        <textarea
          readonly
          :value="receipt.rawText"
          :aria-label="`第 ${index + 1} 次 AI 回复原文`"
          rows="6"
        ></textarea>
      </div>
      <p v-if="copyStatus" role="status">{{ copyStatus }}</p>
      <ul v-if="generation.lookups?.length">
        <li v-for="(lookup, index) in generation.lookups" :key="index">
          {{ lookup.request }}：{{
            lookup.status === 'found'
              ? '已找到资料'
              : lookup.status === 'unavailable'
                ? '资料读取失败（不代表接口不存在）'
                : '未匹配到资料'
          }}
          <ul v-if="lookup.sources.length">
            <li v-for="(source, sourceIndex) in lookup.sources" :key="sourceIndex">
              <a
                v-if="safeSource(source.url)"
                :href="safeSource(source.url)"
                target="_blank"
                rel="noopener noreferrer"
                >{{ source.title }}</a
              >
              <span v-else>{{ source.title }}</span>
              <span v-if="source.lines"> · 行 {{ source.lines.join('–') }}</span>
              <span v-if="source.cached"> · 本机缓存</span>
            </li>
          </ul>
        </li>
      </ul>
    </template>
  </details>
</template>

<style scoped>
details {
  overflow-wrap: anywhere;
  min-width: 0;
}
textarea {
  display: block;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  margin-block: 6px;
  color: inherit;
  background: var(--control-background, var(--color-surface, transparent));
}
summary,
button {
  cursor: pointer;
}
ul {
  padding-inline-start: 18px;
}
</style>
