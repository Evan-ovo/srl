<script setup lang="ts">
import { onUnmounted, ref } from 'vue'

import {
  BRIDGE_EXTENSION_NAME,
  BRIDGE_DOWNLOAD_VERSION,
  BRIDGE_REPO_URL,
  BRIDGE_SERVER_PLUGIN_INSTALL_COMMAND,
  BRIDGE_SERVER_PLUGIN_SCRIPT_URL,
} from '../utils/BridgeInstall'

const downloadRoot = `${import.meta.env.BASE_URL}downloads/`
const copiedTarget = ref('')
const copyError = ref('')
let copyTimer: number | undefined

function legacyCopy(value: string): boolean {
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

async function copyText(target: string, value: string): Promise<void> {
  copyError.value = ''
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
    } else if (!legacyCopy(value)) {
      throw new Error('clipboard unavailable')
    }
    copiedTarget.value = target
    if (copyTimer !== undefined) window.clearTimeout(copyTimer)
    copyTimer = window.setTimeout(() => {
      copiedTarget.value = ''
    }, 2000)
  } catch {
    copiedTarget.value = ''
    copyError.value = '复制失败，请手动选中文本复制'
  }
}

onUnmounted(() => {
  if (copyTimer !== undefined) window.clearTimeout(copyTimer)
})
</script>

<template>
  <aside
    class="tavern-bridge-install"
    aria-label="互传组件安装引导"
    data-assistant-focus="tavern-transfer-install-content"
    data-assistant-focus-text="已为你展开酒馆互传安装教程，可以按这里的步骤安装。"
  >
    <header>
      <small>INSTALL · {{ BRIDGE_DOWNLOAD_VERSION }}</small>
      <strong>还没有安装互传扩展？</strong>
      <p>
        HTTPS 中继码需自部署 Worker，在设置 → 自部署 Worker 保存地址并检测通过；酒馆端填写相同地址。
        此方式只需页面扩展；服务端插件用于旧版或本机离线中继兼容。
      </p>
    </header>

    <section class="tavern-bridge-install__git" aria-label="页面扩展安装（推荐）">
      <div class="tavern-bridge-install__section-heading">
        <span>RECOMMENDED</span>
        <h3>页面扩展 · 用酒馆内置安装</h3>
      </div>
      <div class="tavern-bridge-install__copyline">
        <a :href="BRIDGE_REPO_URL" target="_blank" rel="noreferrer noopener">
          {{ BRIDGE_REPO_URL }}
        </a>
        <button type="button" @click="copyText('repo', BRIDGE_REPO_URL)">
          {{ copiedTarget === 'repo' ? '已复制' : '复制链接' }}
        </button>
      </div>
      <ol class="tavern-bridge-install__steps">
        <li>
          <b>01</b>
          <span><strong>打开扩展面板</strong><small>进入酒馆，点击顶部拼图图标</small></span>
        </li>
        <li>
          <b>02</b>
          <span><strong>选择 Install Extension</strong><small>进入扩展安装输入框</small></span>
        </li>
        <li>
          <b>03</b>
          <span><strong>粘贴并安装</strong><small>粘贴仓库链接，确认安装</small></span>
        </li>
      </ol>
      <p class="tavern-bridge-install__verify">
        <b>验证：</b>扩展列表出现「{{
          BRIDGE_EXTENSION_NAME
        }}」（酒馆资源库互传）即成功；以后更新只需在「管理扩展」里点更新按钮。
      </p>
    </section>

    <section class="tavern-bridge-install__server" aria-label="服务端插件安装">
      <div class="tavern-bridge-install__section-heading">
        <span>LEGACY SUPPORT</span>
        <h3>服务端插件 · 一键脚本</h3>
      </div>
      <p class="tavern-bridge-install__section-note">仅旧版兼容或本机离线中继需要。</p>
      <div class="tavern-bridge-install__copyline">
        <code>{{ BRIDGE_SERVER_PLUGIN_INSTALL_COMMAND }}</code>
        <button type="button" @click="copyText('command', BRIDGE_SERVER_PLUGIN_INSTALL_COMMAND)">
          {{ copiedTarget === 'command' ? '已复制' : '复制命令' }}
        </button>
      </div>
      <ul class="tavern-bridge-install__notes">
        <li>① 在运行 SillyTavern 的那台机器上执行上方命令。</li>
        <li>② Windows 用户请用 Git Bash 执行（后续可改用 PowerShell 版脚本）。</li>
        <li>
          ③
          <a :href="BRIDGE_SERVER_PLUGIN_SCRIPT_URL" target="_blank" rel="noreferrer noopener"
            >查看脚本源码</a
          >
          ，可先阅读脚本内容再执行。
        </li>
      </ul>
    </section>

    <p v-if="copyError" class="tavern-bridge-install__copy-error" role="alert">{{ copyError }}</p>

    <details class="tavern-bridge-install__offline">
      <summary>离线 / 备用安装（ZIP 下载）</summary>
      <p>适用场景：没有 git 环境、内网部署、上面的安装方式执行失败。</p>
      <div>
        <a :href="`${downloadRoot}srl-bridge-complete-v${BRIDGE_DOWNLOAD_VERSION}.zip`" download>
          <span><strong>完整兼容包</strong><small>扩展 + 旧中继服务端 + 中文说明</small></span>
          <i aria-hidden="true">↓</i>
        </a>
        <a :href="`${downloadRoot}srl-bridge-extension-v${BRIDGE_DOWNLOAD_VERSION}.zip`" download>
          <span><strong>页面扩展</strong><small>支持 HTTPS 设备码与同浏览器互传</small></span>
          <i aria-hidden="true">↓</i>
        </a>
        <a
          :href="`${downloadRoot}srl-bridge-server-plugin-v${BRIDGE_DOWNLOAD_VERSION}.zip`"
          download
        >
          <span><strong>仅服务端插件</strong><small>设备码中继组件</small></span>
          <i aria-hidden="true">↓</i>
        </a>
      </div>
      <p class="tavern-bridge-install__verify">
        ZIP 安装的用户在版本升级时需重新下载离线包覆盖安装。
      </p>
    </details>
  </aside>
</template>

<style scoped src="../styles/TavernBridgeInstallGuide.css"></style>
