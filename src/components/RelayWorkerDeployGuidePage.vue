<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { SRL_BACK_REQUEST_EVENT, type SrlBackRequestDetail } from '../composables/UseBackStack'

const emit = defineEmits<{ close: [] }>()
const closeButton = ref<HTMLButtonElement | null>(null)
const copiedDeployCommand = ref(false)
const copyError = ref('')
const deployCommand = 'pnpm exec wrangler deploy --config wrangler.example.jsonc'
let copyTimer: number | undefined

function fallbackCopy(value: string): boolean {
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  return copied
}

async function copyDeployCommand(): Promise<void> {
  copyError.value = ''
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(deployCommand)
    } else if (!fallbackCopy(deployCommand)) {
      throw new Error('clipboard unavailable')
    }
    copiedDeployCommand.value = true
    if (copyTimer !== undefined) window.clearTimeout(copyTimer)
    copyTimer = window.setTimeout(() => {
      copiedDeployCommand.value = false
    }, 2000)
  } catch {
    copiedDeployCommand.value = false
    copyError.value = '复制失败，请手动选择命令复制'
  }
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopImmediatePropagation()
    emit('close')
  }
}

function handleBack(event: Event): void {
  const detail = (event as CustomEvent<SrlBackRequestDetail>).detail
  if (!detail || detail.handled) return
  detail.handled = true
  emit('close')
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown, true)
  window.addEventListener(SRL_BACK_REQUEST_EVENT, handleBack, true)
  closeButton.value?.focus()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown, true)
  window.removeEventListener(SRL_BACK_REQUEST_EVENT, handleBack, true)
  if (copyTimer !== undefined) window.clearTimeout(copyTimer)
})
</script>

<template>
  <Teleport to="#srl-independent-page-outlet">
    <main
      class="srl-independent-page relay-worker-guide"
      role="main"
      aria-label="SRL-Worker-Public 操作步骤"
      tabindex="-1"
    >
      <header class="relay-worker-guide__topbar">
        <span>SRL-Worker-Public</span>
        <button
          ref="closeButton"
          class="relay-worker-guide__close"
          type="button"
          aria-label="返回设置"
          @click="emit('close')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
          <span>返回设置</span>
        </button>
      </header>

      <div class="relay-worker-guide__scroll">
        <article class="relay-worker-guide__content">
          <section class="relay-worker-guide__step" aria-labelledby="worker-step-one">
            <span class="relay-worker-guide__number">01</span>
            <div>
              <h2 id="worker-step-one">Fork 仓库</h2>
              <a
                href="https://github.com/jixiangruyi117/SRL-Worker-Public/fork"
                target="_blank"
                rel="noreferrer"
              >
                Fork SRL-Worker-Public ↗
              </a>
            </div>
          </section>

          <section class="relay-worker-guide__step" aria-labelledby="worker-step-two">
            <span class="relay-worker-guide__number">02</span>
            <div>
              <h2 id="worker-step-two">在 Cloudflare 部署</h2>
              <ol>
                <li>
                  打开 Cloudflare Dashboard → <strong>Workers &amp; Pages</strong> →
                  <strong>Create application</strong>，在 <strong>Import a repository</strong> 旁点
                  <strong>Get started</strong>。
                </li>
                <li>
                  连接 GitHub 并选择刚才 Fork 的仓库；若仓库未显示，先授权 Cloudflare GitHub App
                  访问该仓库。生产分支选 <code>main</code>。
                </li>
                <li>
                  Worker 名称填 <code>srl-worker-public</code>；Root directory 留默认；Build command
                  留空；Deploy command 填：
                </li>
              </ol>
              <div class="relay-worker-guide__command">
                <pre><code>{{ deployCommand }}</code></pre>
                <button type="button" @click="copyDeployCommand">
                  {{ copiedDeployCommand ? '已复制' : '复制命令' }}
                </button>
              </div>
              <ul class="relay-worker-guide__build-options">
                <li><strong>Preview command</strong>：<code>npx wrangler preview</code></li>
                <li><strong>Enable Preview builds</strong>：关闭</li>
                <li><strong>Protect with Cloudflare Access</strong>：关闭</li>
                <li><strong>Advanced settings</strong>：保持默认</li>
              </ul>
              <p>开启 Cloudflare Access 会拦截 SRL 对 Worker 的请求。</p>
              <p v-if="copyError" class="relay-worker-guide__copy-error" role="alert">
                {{ copyError }}
              </p>
              <p>
                点击 <strong>Save and Deploy</strong>。若部署失败，在 Worker
                的部署历史中打开本次构建日志。
              </p>
              <a href="https://dash.cloudflare.com/" target="_blank" rel="noreferrer">
                打开 Cloudflare Dashboard ↗
              </a>
            </div>
          </section>

          <section class="relay-worker-guide__step" aria-labelledby="worker-step-three">
            <span class="relay-worker-guide__number">03</span>
            <div>
              <h2 id="worker-step-three">填回 Worker 地址</h2>
              <p>
                复制 Cloudflare 显示的 HTTPS 根地址，在 SRL 的
                <!-- SRL-PUBLIC-SYNC: BEGIN REPLACE id=public-relayworkerdeployguidepage-vue-1 -->
                <strong>设置 → 自部署 Worker</strong>
                <!-- SRL-PUBLIC-SYNC: END REPLACE id=public-relayworkerdeployguidepage-vue-1 -->
                中粘贴并保存，再点“检查连接”；检测通过后中继码才会开启。
              </p>
            </div>
          </section>

          <section class="relay-worker-guide__after" aria-labelledby="worker-after-title">
            <h2 id="worker-after-title">部署后</h2>
            <p>
              更新：在 GitHub Fork 页面点 <strong>Sync fork → Update branch</strong>；Cloudflare
              监听的 <code>main</code> 有更新后会自动重新部署。
            </p>
          </section>
        </article>
      </div>
    </main>
  </Teleport>
</template>

<style scoped src="../styles/RelayWorkerDeployGuidePage.css"></style>
