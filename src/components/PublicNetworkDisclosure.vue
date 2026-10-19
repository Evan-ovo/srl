<!-- SRL-PUBLIC-SYNC: BEGIN PUBLIC-ONLY id=public-network-disclosure -->
<script setup lang="ts">
import { isAndroidApk } from '../core/AndroidAppUpdate'
import releaseConfig from '../../public-release.config.json'
const repositoryUrl = `https://github.com/${releaseConfig.repository}`
const distributionHost = isAndroidApk() ? '' : location.host
const services = [
  {
    name: 'APK 更新',
    trigger: '手动检查，或另行开启自动检查后；仅下载公开版本文件，不发送资源库正文。',
    domains: [
      'github.com',
      'release-assets.githubusercontent.com',
      'objects.githubusercontent.com',
    ],
  },
  {
    name: 'GitHub 备份与资料读取',
    trigger: '配置备份、导入仓库链接或授权助手读取时；备份按所选范围上传，令牌只交相应服务。',
    domains: [
      'api.github.com',
      'uploads.github.com',
      'raw.githubusercontent.com',
      'github.com',
      'release-assets.githubusercontent.com',
      'objects.githubusercontent.com',
    ],
  },
  {
    name: 'AI 与生图',
    trigger:
      '主动发送时；对话、所选资料、提示词、参考图及授权工具返回的内容交给所选 API。自定义服务以填写的域名为准。',
    domains: ['api.openai.com', 'api.anthropic.com', 'image.novelai.net'],
  },
  {
    name: '云盘',
    trigger: '连接、备份或恢复时；文件与凭据发送至你配置的 GitHub、WebDAV、Koofr 或自部署中继。',
    domains: ['app.koofr.net', '你配置的 WebDAV / Worker 域名'],
  },
  {
    name: 'Discord 收件与配置',
    trigger: '启用对应功能时；消息、附件、配对信息经你配置的 Discord Bridge 处理。',
    domains: [
      'discord.com',
      'cdn.discordapp.com',
      'media.discordapp.net',
      '你配置的 Discord Worker 域名',
    ],
  },
  {
    name: '部署网页',
    trigger: '主动打开配置教程或授权网页代理时；相关网站按自己的规则处理登录与访问。',
    domains: ['dash.cloudflare.com', 'deploy.workers.cloudflare.com', 'github.com', 'discord.com'],
  },
  {
    name: '自建图床与外部内容',
    trigger: '上传、浏览远端文件、读取链接或允许联网预览时；接收方可获对应文件、路径及网络信息。',
    domains: ['你配置的 ImgBed 域名', '导入内容、链接、图标及第三方 APP 实际引用的域名'],
  },
]
const referenceSites = [
  'docs.github.com',
  'developers.cloudflare.com',
  'koofr.eu',
  'developer.mozilla.org',
  'web.dev',
  'webkit.org',
  'demos.gsap.com',
  'tympanus.net',
  'threejs.org',
  'motion.dev',
  'animejs.com',
  'animista.net',
]
</script>
<template>
  <section class="public-network" aria-labelledby="public-network-title">
    <h2 id="public-network-title">隐私与网络</h2>
    <p>
      资源库内容默认保存在当前设备，不因打开 Public
      而自动上传给作者。可选联网功能可拒绝，仍可使用本地管理。
    </p>
    <p>
      加载网页、下载静态 APP 包、检查与下载更新会访问分发服务器。接收方可接触
      IP、访问时间、请求路径及部分请求头；这不等于上传你的资源正文。
    </p>
    <p>
      APK 自动检查默认关闭，可在“设置 → 自动检查 APK 更新”更改；手动检查始终保留。网页的应用壳加载与
      Service Worker 更新会连接当前站点，APK 开关不控制网页更新。
    </p>
    <details>
      <summary>联网服务与域名<span>按功能启用</span></summary>
      <div class="public-network__detail">
        <p v-if="distributionHost">
          当前网页分发站点：<code>{{ distributionHost }}</code>
        </p>
        <p v-else>APK 的静态 APP 包来自该发行版指定的分发站点，请核对下载页的分发地址。</p>
        <dl v-for="service in services" :key="service.name">
          <dt>{{ service.name }}</dt>
          <dd>
            {{ service.trigger
            }}<code v-for="domain in service.domains" :key="domain">{{ domain }}</code>
          </dd>
        </dl>
        <p>
          发布帖需按社区现行白名单披露实际域名；raw.githubusercontent.com 在所提供白名单内，其他
          GitHub 域名不因此自动豁免。
        </p>
        <p>
          帮助与效果参考外链仅在点击后打开：<code>{{ referenceSites.join('、') }}</code>
        </p>
      </div>
    </details>
    <details>
      <summary>你的选择与数据去向</summary>
      <div class="public-network__detail">
        <p>
          AI
          截图每次发送前另行询问；网页代理须单独授权，网页文字、控件标签、地址和公开标识可能发送给所选
          AI。可关闭截图、拒绝代理或暂停任务，已发给第三方的内容不能由本机撤回。
        </p>
        <p>
          远程预览与脚本默认关闭，可在设置中更改。第三方
          APP、导入作品、远程封面和图标可能引用自己的域名，请确认来源和权限；封面和图标链接可能在显示时加载，可移除链接或换成本地图片；不加载相应内容即可拒绝这些请求。
        </p>
        <p>
          备份按你选择的范围传输，包含凭据时可能携带可用密钥；图床只在你主动上传时发送所选文件。关闭自动备份、断开连接或移除配置可停止后续对应操作；已上传的副本需在目标服务删除。
        </p>
        <p>
          阅读确认和更新偏好保存在本机。网页还用固定版本值的功能性 Cookie
          记住已读状态，会随同站点请求发送，不用作个人跟踪标识。浏览器、应用和外部服务的数据清理分别生效。
        </p>
      </div>
    </details>
    <details>
      <summary>托管日志与源码</summary>
      <div class="public-network__detail">
        <p>
          本项目未内置访问统计或资源内容遥测上报。本仓库静态站点模板默认关闭 Workers
          应用日志；这不会关闭 Cloudflare 或其他托管商为提供服务、安全与计费处理的基础网络信息。
        </p>
        <p>
          不同部署者可能启用日志或统计。具体记录字段、用途、访问者和保存期限以该站点发布说明及托管商政策为准；无法通过客户端开关消除服务器收到的基础请求，不承诺“零日志”。
        </p>
        <p>
          <a :href="repositoryUrl" target="_blank" rel="noopener noreferrer"
            >查看 Public 完整源码</a
          >
          ·
          <a
            href="https://github.com/jixiangruyi117/SRL-Worker-Public"
            target="_blank"
            rel="noopener noreferrer"
            >中继源码</a
          >
          ·
          <a
            href="https://github.com/jixiangruyi117/SRL-Discord-Bridge"
            target="_blank"
            rel="noopener noreferrer"
            >Discord Bridge 源码</a
          >。使用与再分发按 LICENSE / NOTICE，源码公开不等于任意授权。
        </p>
        <p>发现社区作品安全问题，请优先私信管理组，避免在公开频道先发布具体利用方式。</p>
      </div>
    </details>
  </section>
</template>
<style scoped>
.public-network details {
  border-top: 1px solid var(--color-line);
}
.public-network summary {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 44px;
  cursor: pointer;
  font-size: 0.85rem;
  font-weight: 600;
}
.public-network summary::before {
  content: '›';
  color: var(--color-accent);
  font-size: 1.1rem;
}
.public-network details[open] > summary::before {
  transform: rotate(90deg);
}
.public-network summary span {
  margin-left: auto;
  font-size: 0.7rem;
  font-weight: 400;
  color: var(--color-ink-soft);
}
.public-network__detail {
  display: grid;
  gap: 0.7rem;
  padding: 0 0 0.75rem;
}
.public-network dl {
  margin: 0;
  display: grid;
  gap: 0.25rem;
}
.public-network dt {
  font-size: 0.8rem;
  font-weight: 650;
}
.public-network dd {
  margin: 0;
  font-size: 0.78rem;
  line-height: 1.65;
  color: var(--color-ink-soft);
}
.public-network code {
  display: block;
  overflow-wrap: anywhere;
  word-break: break-word;
  font-size: 0.72rem;
  line-height: 1.65;
  color: var(--color-accent);
}
.public-network p code {
  display: inline;
}
.public-network summary:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
</style>
<!-- SRL-PUBLIC-SYNC: END PUBLIC-ONLY id=public-network-disclosure -->
