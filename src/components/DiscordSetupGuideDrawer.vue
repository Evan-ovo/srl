<script setup lang="ts">
import { ref } from 'vue'
import { useAssistantHelpContext } from '../composables/UseAssistantHelpContext'
import ResourceImageViewer from './ResourceImageViewer.vue'

import {
  DISCORD_BRIDGE_DEPLOY_URL,
  DISCORD_BRIDGE_WRANGLER_TEMPLATE,
} from '../services/DiscordBridgeDeployService'

const props = withDefaults(
  defineProps<{
    open: boolean
    deploymentMode?: 'one-click' | 'github'
    applicationId: string
    publicKey: string
    botToken: string
    interactionsUrl?: string
    installationUrl: string
    developerAppUrl: string
    developerBotUrl: string
  }>(),
  { deploymentMode: 'one-click' },
)

const emit = defineEmits<{ close: [] }>()
const copyStatus = ref('')
useAssistantHelpContext('discord-bridge', () => props.open)
const previewImage = ref<{ source: string; alt: string }>()

function openScreenshot(event: MouseEvent | KeyboardEvent): void {
  const trigger = event.currentTarget
  if (!(trigger instanceof HTMLElement)) return
  const image = trigger.querySelector('img')
  if (!image) return
  trigger.focus({ preventScroll: true })
  previewImage.value = { source: image.currentSrc || image.src, alt: image.alt }
}

async function copyText(value: string, message: string): Promise<void> {
  if (!value) return
  try {
    await navigator.clipboard.writeText(value)
  } catch {
    const input = document.createElement('textarea')
    input.value = value
    input.setAttribute('readonly', '')
    input.style.position = 'fixed'
    input.style.left = '-9999px'
    document.body.append(input)
    input.select()
    document.execCommand('copy')
    input.remove()
  }
  copyStatus.value = message
  window.setTimeout(() => {
    if (copyStatus.value === message) copyStatus.value = ''
  }, 1800)
}
</script>

<template>
  <Teleport to="body">
    <Transition name="discord-guide-fade">
      <button
        v-if="open"
        class="discord-guide-backdrop"
        type="button"
        :aria-label="`关闭${props.deploymentMode === 'github' ? 'GitHub 部署' : '一键部署'}教程`"
        @click="emit('close')"
      ></button>
    </Transition>
    <Transition name="discord-guide-slide">
      <aside
        v-if="open"
        class="discord-guide-drawer"
        data-assistant-help-context="discord-bridge"
        :data-assistant-focus="
          props.deploymentMode === 'github'
            ? 'discord-github-tutorial-content'
            : 'discord-oneclick-tutorial-content'
        "
        data-assistant-focus-text="已为你展开 Discord 部署教程，可以按步骤查看配置和部署方法。"
        :aria-label="`Discord ${props.deploymentMode === 'github' ? 'GitHub 部署' : '一键部署'}教程`"
      >
        <header class="discord-guide-drawer__header">
          <div>
            <small>GITHUB + CLOUDFLARE</small>
            <h3>{{ props.deploymentMode === 'github' ? 'GitHub 部署教程' : '一键部署教程' }}</h3>
          </div>
          <button
            type="button"
            :aria-label="`关闭${props.deploymentMode === 'github' ? 'GitHub 部署' : '一键部署'}教程`"
            @click="emit('close')"
          >
            ×
          </button>
        </header>

        <div class="discord-guide-drawer__body">
          <p class="discord-guide-intro">
            {{
              props.deploymentMode === 'github'
                ? '先把项目 Fork 到自己的 GitHub，再让 Cloudflare 从这个仓库部署。以后推送到 main 会自动部署。'
                : '按顺序完成下面步骤。每个人都要部署到自己的 Cloudflare，并使用自己的 Discord App。'
            }}
          </p>

          <section class="discord-guide-step">
            <span>01</span>
            <div>
              <h4>先准备 Discord App 的三个值</h4>
              <p>
                打开自己的 Discord App。在 General Information 找到 Application ID 和 Public Key；在
                Bot 页面生成 Bot Token。把三个值填入 SRL 配置框，再回来点复制。
              </p>
              <p class="discord-guide-note discord-guide-note--soft">
                如果侧栏挡住了配置框，先关闭教程，填完三个值，再重新打开本教程。
              </p>
              <a :href="developerAppUrl" target="_blank" rel="noopener noreferrer">
                打开 Discord General Information
              </a>
              <a :href="developerBotUrl" target="_blank" rel="noopener noreferrer">
                打开 Discord Bot 设置
              </a>
              <code>Application ID：General Information → APPLICATION ID</code>
              <figure
                class="discord-guide-screenshot"
                role="button"
                tabindex="0"
                aria-label="放大查看教程截图"
                @click="openScreenshot($event)"
                @keydown.enter.prevent="openScreenshot"
                @keydown.space.prevent="openScreenshot"
              >
                <img
                  :src="'/tutorials/discord-application-id-redacted.png'"
                  alt="Discord General Information 页面，绿色圈出已遮挡的 Application ID 和 Public Key"
                  loading="lazy"
                />
                <figcaption>
                  绿色圈出 Application ID 和 Public
                  Key；两个值都已遮挡。中文界面把公钥一项显示为“客户端”。
                </figcaption>
              </figure>
              <code>Public Key：General Information → PUBLIC KEY（中文界面显示为“客户端”）</code>
              <code>Bot Token：Bot → Reset Token</code>
              <figure
                class="discord-guide-screenshot"
                role="button"
                tabindex="0"
                aria-label="放大查看教程截图"
                @click="openScreenshot($event)"
                @keydown.enter.prevent="openScreenshot"
                @keydown.space.prevent="openScreenshot"
              >
                <img
                  :src="'/tutorials/discord-bot-token-redacted.png'"
                  alt="Discord Bot 页面，绿色圈出 Reset Token 按钮"
                  loading="lazy"
                />
                <figcaption>绿色圈线标出生成 Bot Token 的按钮；截图没有显示令牌。</figcaption>
              </figure>
              <div class="discord-guide-copy-list">
                <button
                  type="button"
                  :disabled="!applicationId"
                  @click="copyText(applicationId, 'Application ID 已复制')"
                >
                  复制 Application ID
                </button>
                <button
                  type="button"
                  :disabled="!publicKey"
                  @click="copyText(publicKey, 'Public Key 已复制')"
                >
                  复制 Public Key
                </button>
                <button
                  type="button"
                  :disabled="!botToken"
                  @click="copyText(botToken, 'Bot Token 已复制')"
                >
                  复制 Bot Token
                </button>
              </div>
              <p class="discord-guide-note">
                不要把 Application Secret 当作 Public Key。Bot Token 是密码，只粘贴到自己的
                Cloudflare Secret。
              </p>
            </div>
          </section>

          <section v-if="props.deploymentMode === 'one-click'" class="discord-guide-step">
            <span>02</span>
            <div>
              <h4>点下面按钮开始部署</h4>
              <p>
                不用先手动 Fork。点下面按钮后，Cloudflare 会让你登录并连接 GitHub 或
                GitLab，再自动把模板复制到你的账号并部署 Worker。按页面提示完成即可。
              </p>
              <a
                class="discord-guide-action"
                :href="DISCORD_BRIDGE_DEPLOY_URL"
                target="_blank"
                rel="noopener noreferrer"
              >
                打开 Cloudflare 一键部署
              </a>
              <p class="discord-guide-note discord-guide-note--soft">
                这一步也会为你创建并绑定 D1 数据库。部署完成后，先不要关闭此教程。
              </p>
              <p class="discord-guide-note discord-guide-note--soft">
                这会创建连接自动部署的代码副本，不是可直接点 GitHub“Sync fork”更新的
                Fork。原仓库有新版时，需要手动同步或合并后再推送。
              </p>
            </div>
          </section>

          <section v-if="props.deploymentMode === 'github'" class="discord-guide-step">
            <span>02</span>
            <div>
              <h4>先创建 D1 并记下数据库 ID</h4>
              <p>使用你自己的 Cloudflare 账号，按顺序创建数据库并复制它的 ID：</p>
              <ol>
                <li>打开 Workers &amp; Pages → D1 SQL，点 <strong>Create Database</strong>。</li>
                <li>
                  Name 填 <strong>srl-discord-source-handoff</strong>；Data location
                  保持默认自动选择，点 <strong>Create</strong>。
                </li>
                <li>
                  创建后在数据库列表找到 <strong>UUID</strong> 列，再打开对应数据库详情复制完整的
                  <strong>Database ID</strong>。若列表中的 UUID
                  被省略显示，请以详情页里的完整值为准；数据库名称和 Database ID 是不同的值。
                </li>
              </ol>
              <a href="https://dash.cloudflare.com/" target="_blank" rel="noopener noreferrer">
                打开 Cloudflare Dashboard
              </a>
              <figure
                class="discord-guide-screenshot"
                role="button"
                tabindex="0"
                aria-label="放大查看教程截图"
                @click="openScreenshot($event)"
                @keydown.enter.prevent="openScreenshot"
                @keydown.space.prevent="openScreenshot"
              >
                <img
                  :src="'/tutorials/discord-github/d1-empty-create-callout.jpg'"
                  alt="Cloudflare D1 数据库列表为空，标出开始创建数据库的位置"
                  loading="lazy"
                />
                <figcaption>列表为空时，先创建 D1 数据库；仓库导入不会自动创建它。</figcaption>
              </figure>
              <figure
                class="discord-guide-screenshot"
                role="button"
                tabindex="0"
                aria-label="放大查看教程截图"
                @click="openScreenshot($event)"
                @keydown.enter.prevent="openScreenshot"
                @keydown.space.prevent="openScreenshot"
              >
                <img
                  :src="'/tutorials/discord-github/d1-create-form-callout.jpg'"
                  alt="Cloudflare 创建 D1 数据库表单，标出数据库名称和创建按钮"
                  loading="lazy"
                />
                <figcaption>
                  数据库名必须与配置中的名称完全一致；位置提示可保持自动选择。
                </figcaption>
              </figure>
              <figure
                class="discord-guide-screenshot"
                role="button"
                tabindex="0"
                aria-label="放大查看教程截图"
                @click="openScreenshot($event)"
                @keydown.enter.prevent="openScreenshot"
                @keydown.space.prevent="openScreenshot"
              >
                <img
                  :src="'/tutorials/discord-github/d1-database-uuid-column.jpg'"
                  alt="Cloudflare D1 数据库列表中 UUID 列的位置"
                  loading="lazy"
                />
                <figcaption>
                  创建后在列表中看 UUID 列；若值被截断，打开对应数据库详情复制完整 Database ID。
                </figcaption>
              </figure>
              <p class="discord-guide-note discord-guide-note--soft">
                Database ID 不是密码，但不要发到公共聊天；Bot Token 是密码，绝不能写进 GitHub。
              </p>
            </div>
          </section>

          <section v-if="props.deploymentMode === 'github'" class="discord-guide-step">
            <span>03</span>
            <div>
              <h4>Fork 仓库，并一次填好 Wrangler 配置</h4>
              <p>
                点击下面链接，在 GitHub 页面右上方点 Fork，再选择自己的账号并点 Create fork。已经
                Fork 过就跳过 Fork 操作，直接编辑自己的 Fork。
              </p>
              <a
                href="https://github.com/jixiangruyi117/SRL-Discord-Bridge/fork"
                target="_blank"
                rel="noopener noreferrer"
              >
                Fork SRL Discord Bridge
              </a>
              <p>
                打开 Fork 根目录的 <code>wrangler.jsonc</code>，把下面三个占位内容分别换成刚记下的
                D1 Database ID、Discord Application ID 和同一 App 的 Public
                Key。其它固定字段照抄；不要把 Bot Token 放进这个文件。
              </p>
              <pre
                class="discord-guide-config"
              ><code>{{ DISCORD_BRIDGE_WRANGLER_TEMPLATE }}</code></pre>
              <figure
                class="discord-guide-screenshot"
                role="button"
                tabindex="0"
                aria-label="放大查看教程截图"
                @click="openScreenshot($event)"
                @keydown.enter.prevent="openScreenshot"
                @keydown.space.prevent="openScreenshot"
              >
                <img
                  :src="'/tutorials/discord-github/wrangler-database-id-location.jpg'"
                  alt="wrangler.jsonc 中 database_id 应填写的位置示意"
                  loading="lazy"
                />
                <figcaption>
                  Database ID 填在 database_id 的引号内；不要改固定数据库名、binding 或
                  migrations_dir。
                </figcaption>
              </figure>
              <p>
                Discord 的 Application ID 和 Public Key 是公开标识，可以放在 <code>vars</code>；
                <code>keep_vars</code> 让后续 Wrangler 部署保留 Cloudflare
                面板上的变量。保存文件后提交并推送到 <strong>main</strong>。
              </p>
              <p class="discord-guide-note discord-guide-note--soft">
                D1 不会因为导入仓库而自动创建。首次部署会先运行数据库迁移；如果出现 “Couldn't find a
                D1 DB named srl-discord-source-handoff”，回头核对 D1 是否创建在同一个 Cloudflare
                账号，以及名称和 Database ID 是否对应。
              </p>
              <figure
                class="discord-guide-screenshot"
                role="button"
                tabindex="0"
                aria-label="放大查看教程截图"
                @click="openScreenshot($event)"
                @keydown.enter.prevent="openScreenshot"
                @keydown.space.prevent="openScreenshot"
              >
                <img
                  :src="'/tutorials/discord-github/d1-migration-not-found.jpg'"
                  alt="Cloudflare 部署日志提示找不到 srl-discord-source-handoff D1 数据库"
                  loading="lazy"
                />
                <figcaption>
                  找不到 D1 时，再核对数据库是否已创建、名称和 Database ID 是否对应。
                </figcaption>
              </figure>
              <p class="discord-guide-note discord-guide-note--soft">
                已经因 D1 缺失而部署失败的话，创建数据库、推送配置后，到 Cloudflare Workers Builds
                重试失败的部署。
              </p>
              <p class="discord-guide-note discord-guide-note--soft">
                Workers Builds 自动生成的 API Token 默认没有 D1 权限。若日志仍显示找不到 D1，到
                Worker → Settings → Builds 的 API token 设置中选择自定义 User API
                Token：保留部署所需的 Workers 权限，并在同一账户增加 <strong>D1 Read</strong> 和
                <strong>D1 Write</strong>。Token 只保存在 Cloudflare，不能提交到 GitHub。
              </p>
              <p class="discord-guide-note discord-guide-note--soft">
                Fork 是把代码副本放进你的 GitHub 账号。这里不需要复制或手写 Worker 代码。
              </p>
            </div>
          </section>

          <section v-if="props.deploymentMode === 'github'" class="discord-guide-step">
            <span>04</span>
            <div>
              <h4>让 Cloudflare 导入你的 Fork</h4>
              <p>
                打开 Cloudflare → Workers &amp; Pages → Create application → Import a
                repository。授权 GitHub 后选中你的 SRL-Discord-Bridge 仓库和
                <strong>main</strong> 分支。
              </p>
              <a href="https://dash.cloudflare.com/" target="_blank" rel="noopener noreferrer"
                >打开 Cloudflare Dashboard</a
              >
              <a
                href="https://developers.cloudflare.com/workers/ci-cd/builds/"
                target="_blank"
                rel="noopener noreferrer"
              >
                查看 Cloudflare 导入 Git 仓库的官方步骤
              </a>
              <p>
                项目设置中确认 Worker 名称为 <strong>srl-discord-source-bridge</strong>，Build
                command 填 <strong>npm run typecheck</strong>，Deploy command 填
                <strong>npm run deploy</strong>，然后点 Save and Deploy。
              </p>
              <p class="discord-guide-note discord-guide-note--soft">
                Production branch 选 <strong>main</strong>，关闭
                <strong>Enable Preview Builds</strong>。 Preview command 保留默认的
                <code>npx wrangler preview</code> 即可；关闭预览构建后它不会运行。 当前项目锁定的
                Wrangler 版本也低于 Cloudflare Worker Previews 的最低要求；只有升级 Wrangler
                并单独配置预览环境的 D1 和 Discord 变量后，才开启预览构建。
              </p>
              <figure
                class="discord-guide-screenshot"
                role="button"
                tabindex="0"
                aria-label="放大查看教程截图"
                @click="openScreenshot($event)"
                @keydown.enter.prevent="openScreenshot"
                @keydown.space.prevent="openScreenshot"
              >
                <img
                  :src="'/tutorials/discord-github/cloudflare-build-preview-settings.jpg'"
                  alt="Cloudflare 构建设置中 Preview builds 和 Cloudflare Access 开关的位置"
                  loading="lazy"
                />
                <figcaption>关闭 Preview Builds，并保持 Cloudflare Access 关闭。</figcaption>
              </figure>
              <p class="discord-guide-note discord-guide-note--soft">
                <strong>Protect with Cloudflare Access</strong> 保持关闭。Discord 必须能直接请求
                Worker 的 Interactions URL；Access 登录门禁会拦截 Discord 的签名请求。
              </p>
              <p class="discord-guide-note discord-guide-note--soft">
                Workers Builds 自动生成的 API Token 默认没有 D1 权限。到 Worker → Settings → Builds
                的 API token 设置中选择自定义 User API Token：保留部署所需的 Workers
                权限，并在同一账户增加
                <strong>D1 Read</strong> 和
                <strong>D1 Write</strong>，否则数据库即使已创建，迁移也可能报找不到。 Token 只保存在
                Cloudflare，不能提交到 GitHub。
              </p>
              <p class="discord-guide-note discord-guide-note--soft">
                Cloudflare 会按 <code>wrangler.jsonc</code> 中的数据库 ID 将 D1 绑定到
                Worker；首次部署时 <code>npm run deploy</code> 会先应用数据库迁移，再发布 Worker。
              </p>
            </div>
          </section>

          <section class="discord-guide-step">
            <span>{{ props.deploymentMode === 'github' ? '05' : '04' }}</span>
            <div>
              <h4>把 Discord 值加到 Cloudflare</h4>
              <p>
                打开 Cloudflare Dashboard → Workers &amp; Pages → 你的 Worker → Settings → Variables
                and Secrets → Add。
              </p>
              <a href="https://dash.cloudflare.com/" target="_blank" rel="noopener noreferrer">
                打开 Cloudflare Dashboard
              </a>
              <p v-if="props.deploymentMode === 'github'">
                GitHub 部署教程已在 <strong>wrangler.jsonc</strong> 的 <code>vars</code> 中配置
                Application ID 和 Public Key，这里只需在 <strong>Production</strong> 环境添加
                <code>DISCORD_BOT_TOKEN</code> 并勾选 <strong>Secret</strong>。不要再添加同名的 ID /
                Public Key；如果之前已在面板添加过，请确认它们与配置文件中的值一致。
              </p>
              <p v-else>
                选择 <strong>Production</strong> 环境，分别添加 Application ID、Public Key 和 Bot
                Token。Key 是变量名；前两项保持 <strong>Secret</strong> 未勾选，Bot Token 勾选
                <strong>Secret</strong>。
              </p>
              <figure
                class="discord-guide-screenshot"
                role="button"
                tabindex="0"
                aria-label="放大查看教程截图"
                @click="openScreenshot($event)"
                @keydown.enter.prevent="openScreenshot"
                @keydown.space.prevent="openScreenshot"
              >
                <img
                  :src="'/tutorials/discord-github/cloudflare-production-variable-fields.jpg'"
                  alt="Cloudflare 新增环境变量表单中环境、Key、Value 和 Secret 的位置"
                  loading="lazy"
                />
                <figcaption>
                  这里填写 Bot Token：Key 是 DISCORD_BOT_TOKEN，Value 粘贴 Token，并勾选 Secret。
                </figcaption>
              </figure>
              <code v-if="props.deploymentMode !== 'github'"
                >Key：DISCORD_APPLICATION_ID Value：Discord General Information → Application
                ID</code
              >
              <code v-if="props.deploymentMode !== 'github'"
                >Key：DISCORD_PUBLIC_KEY Value：同一 Discord App 的 General Information → Public
                Key</code
              >
              <code
                >Key：DISCORD_BOT_TOKEN Value：Discord Bot 页面生成的 Bot Token（勾选 Secret）</code
              >
              <a
                href="https://developers.cloudflare.com/workers/configuration/secrets/"
                target="_blank"
                rel="noopener noreferrer"
              >
                查看 Cloudflare 添加 Secret 的官方步骤
              </a>
              <p class="discord-guide-note">
                点 <strong>Add variable and deploy</strong> 并等待 Production 部署完成。Bot Token
                是密码，不要发给别人，也不要放到 GitHub 代码里。
              </p>
              <p class="discord-guide-note discord-guide-note--soft">
                如果看到“Update your Wrangler
                configuration”提示，它只是同步建议，不代表部署失败。确认 Fork 的
                <code>wrangler.jsonc</code> 已加入 <code>"keep_vars": true</code>，后续部署会保留
                Cloudflare 面板变量；不要把 Bot Token 复制到配置文件。
              </p>
            </div>
          </section>

          <section class="discord-guide-step">
            <span>{{ props.deploymentMode === 'github' ? '06' : '05' }}</span>
            <div>
              <h4>把 Worker 根链接填回 SRL</h4>
              <p>
                打开 Worker 的 <strong>Domains</strong> 页面，启用 <strong>Production</strong> 的
                <code>workers.dev</code> 开关。Preview 保持关闭即可。若 Overview 显示
                <strong>No URLs enabled</strong>，说明还没有启用 Production URL。
              </p>
              <figure
                class="discord-guide-screenshot"
                role="button"
                tabindex="0"
                aria-label="放大查看教程截图"
                @click="openScreenshot($event)"
                @keydown.enter.prevent="openScreenshot"
                @keydown.space.prevent="openScreenshot"
              >
                <img
                  :src="'/tutorials/discord-github/workers-dev-enable-redacted.jpg'"
                  alt="Cloudflare Worker Domains 页面，遮挡账户子域名并标出 Production workers.dev 开关"
                  loading="lazy"
                />
                <figcaption>
                  开启 Production 的 workers.dev URL；图中的账户子域名已遮挡。
                </figcaption>
              </figure>
              <p>启用后复制 Worker 根链接，例如：</p>
              <code>https://你的-worker.workers.dev</code>
              <p>
                回到本页后面的“Cloudflare 部署链接”框，只粘贴这条根链接，然后点“检查部署配置”。SRL
                会检查
                <code>/health</code> 的 D1 查询和三项变量是否存在，再用 Bot Token 向 Discord 核对
                App ID 与 Public Key。状态条会分别提示 D1
                失败、缺少变量、凭证不匹配或核验通过；不要自己给根链接加路径。
              </p>
            </div>
          </section>

          <section class="discord-guide-step">
            <span>{{ props.deploymentMode === 'github' ? '07' : '06' }}</span>
            <div>
              <h4>把 Discord 接收地址粘到 App</h4>
              <p>SRL 测试成功后，会自动生成下面这条地址。复制它：</p>
              <code v-if="interactionsUrl">{{ interactionsUrl }}</code>
              <code v-else>先填入 Worker 根链接，SRL 才能生成地址</code>
              <div class="discord-guide-copy-list">
                <button
                  type="button"
                  :disabled="!interactionsUrl"
                  @click="copyText(interactionsUrl || '', 'Discord 交互地址已复制')"
                >
                  复制 Discord 交互地址
                </button>
              </div>
              <p>
                回到 Discord Developer Portal → General Information → Interactions Endpoint
                URL，粘贴并保存。这里必须填上面生成的完整地址，结尾应为
                <code>/interactions</code>；不要填 Worker 根链接。Discord 验证时会检查 Public Key
                签名，Public Key 必须来自同一个 Discord App。
              </p>
              <a :href="developerAppUrl" target="_blank" rel="noopener noreferrer">
                打开 Discord General Information
              </a>
              <figure
                class="discord-guide-screenshot"
                role="button"
                tabindex="0"
                aria-label="放大查看教程截图"
                @click="openScreenshot($event)"
                @keydown.enter.prevent="openScreenshot"
                @keydown.space.prevent="openScreenshot"
              >
                <img
                  :src="'/tutorials/discord-github/discord-endpoint-validation-error.jpg'"
                  alt="Discord 交互端点 URL 验证失败示例，并标出应检查的路径和 Public Key"
                  loading="lazy"
                />
                <figcaption>
                  遇到“无法验证指定的交互端点 URL”时，确认地址以 /interactions 结尾，并且 Public Key
                  与该 Discord App 匹配。
                </figcaption>
              </figure>
              <p class="discord-guide-note discord-guide-note--soft">
                如果 Discord 提示“无法验证指定的交互端点 URL”，先检查 Production 上的
                <code>DISCORD_PUBLIC_KEY</code> 是否与当前 App 完全一致、Public Key
                配置是否已部署，以及地址是否为
                <code>https://你的-worker.workers.dev/interactions</code>。初次 PING 验证不使用
                Application ID 或 Bot Token；这两项缺失会让
                <code>/health</code> 显示未完整配置或让命令注册失败，需另行补齐。
              </p>
            </div>
          </section>

          <section class="discord-guide-step">
            <span>{{ props.deploymentMode === 'github' ? '08' : '07' }}</span>
            <div>
              <h4>先把 App 添加到自己的 Discord 账号</h4>
              <p>
                点下面按钮进入 Developer Portal 的 Installation
                设置页，这个按钮只打开设置页，不会安装 App。按顺序完成下面设置：
              </p>
              <a :href="installationUrl" target="_blank" rel="noopener noreferrer">
                打开 Discord Installation 页面
              </a>
              <ol>
                <li>在 Installation Contexts 中开启 <strong>User Install</strong>。</li>
                <li>在 Install Link 中选择 <strong>Discord Provided Link</strong>。</li>
                <li>
                  在出现的 Default Install Settings → User Install 中添加
                  <code>applications.commands</code>，然后点 <strong>Save Changes</strong>。
                </li>
                <li>
                  回到 Install Link 区域复制生成的安装链接；用准备操作消息的 Discord
                  账号打开该链接，并在授权页点
                  <strong>Add to my apps</strong>。
                </li>
              </ol>
              <p>仅把 Bot 添加到服务器不等于把 App 添加到个人账号；此命令只支持 User Install。</p>
              <p>
                完成 Add to my apps 后回到 SRL，点“注册消息命令”，再在 Discord 里右键一条消息 → Apps
                → 保存到资源库。
              </p>
              <p class="discord-guide-note discord-guide-note--soft">
                SRL 显示“注册成功”只表示 Discord 已登记命令，不代表当前账号已安装 App。若 Apps
                里仍看不到命令，先确认当前账号完成了 Add to my apps，并且安装的是 SRL 中填写的同一个
                Discord App。
              </p>
              <p class="discord-guide-note discord-guide-note--soft">
                只有还要自动检查社区帖子更新时，才需要把 Bot 加入对应服务器，并允许它查看来源频道。
              </p>
            </div>
          </section>

          <section v-if="props.deploymentMode === 'github'" class="discord-guide-step">
            <span>09</span>
            <div>
              <h4>以后同步 Bridge 更新</h4>
              <p>
                原仓库发布新版后，打开你自己的 Fork 首页。在分支状态提示中点
                <strong>Sync fork</strong>，再点绿色的
                <strong>Update branch</strong>，把上游更新同步到 Fork 的 <code>main</code>。
              </p>
              <figure
                class="discord-guide-screenshot"
                role="button"
                tabindex="0"
                aria-label="放大查看教程截图"
                @click="openScreenshot($event)"
                @keydown.enter.prevent="openScreenshot"
                @keydown.space.prevent="openScreenshot"
              >
                <img
                  :src="'/tutorials/discord-github/fork-sync-status.png'"
                  alt="GitHub Fork 页面显示分支与上游有提交差异，并圈出 Sync fork 菜单"
                  loading="lazy"
                />
                <figcaption>
                  在自己的 Fork 页面打开 Sync fork；ahead/behind 的数字会随更新变化。
                </figcaption>
              </figure>
              <figure
                class="discord-guide-screenshot"
                role="button"
                tabindex="0"
                aria-label="放大查看教程截图"
                @click="openScreenshot($event)"
                @keydown.enter.prevent="openScreenshot"
                @keydown.space.prevent="openScreenshot"
              >
                <img
                  :src="'/tutorials/discord-github/fork-update-branch.png'"
                  alt="GitHub 同步 Fork 确认框，标出绿色 Update branch 按钮"
                  loading="lazy"
                />
                <figcaption>点击 Update branch 同步上游提交。</figcaption>
              </figure>
              <p class="discord-guide-note discord-guide-note--soft">
                不要点红色的 <strong>Discard commits</strong>：它会丢弃你 Fork
                中独有的提交。若同步时出现冲突，先处理冲突，不要用丢弃提交来绕过。
              </p>
              <p>
                同步完成后，Cloudflare Workers Builds 会从 <code>main</code> 自动重新部署。到
                Cloudflare 的 Deployments 页面确认最新部署成功；如果失败，先看构建日志再继续。
              </p>
              <a
                href="https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/syncing-a-fork"
                target="_blank"
                rel="noopener noreferrer"
              >
                查看 GitHub 同步 Fork 的官方说明
              </a>
            </div>
          </section>

          <p v-if="copyStatus" class="discord-guide-status" role="status">{{ copyStatus }}</p>
        </div>
      </aside>
    </Transition>
    <ResourceImageViewer
      v-if="previewImage"
      :src="previewImage.source"
      :name="previewImage.alt"
      :cover="true"
      :minimal="true"
      @close="previewImage = undefined"
    />
  </Teleport>
</template>

<style scoped src="../styles/DiscordSetupGuideDrawer.css"></style>
