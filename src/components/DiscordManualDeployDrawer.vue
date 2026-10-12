<script setup lang="ts">
import { ref } from 'vue'
import { useAssistantHelpContext } from '../composables/UseAssistantHelpContext'
import ResourceImageViewer from './ResourceImageViewer.vue'

import manualWorkerSource from 'virtual:srl-discord-manual-worker-source'

const props = defineProps<{
  open: boolean
  applicationId: string
  publicKey: string
  botToken: string
  interactionsUrl?: string
  installationUrl: string
  developerAppUrl: string
  developerBotUrl: string
}>()
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
    <Transition name="discord-manual-fade">
      <button
        v-if="open"
        class="discord-manual-backdrop"
        type="button"
        aria-label="关闭手动部署教程"
        @click="emit('close')"
      ></button>
    </Transition>

    <Transition name="discord-manual-slide">
      <aside
        v-if="open"
        class="discord-manual-drawer"
        data-assistant-help-context="discord-bridge"
        aria-label="Cloudflare 浏览器手动部署教程"
        data-assistant-focus="discord-manual-deploy-tutorial-content"
        data-assistant-focus-text="已为你展开浏览器手动部署教程，可以按顺序查看步骤。"
      >
        <header class="discord-manual-head">
          <div>
            <small>NO GITHUB / NO TERMINAL</small>
            <h3>浏览器手动部署教程</h3>
            <p>照顺序操作。部署到你自己的 Cloudflare；Bot Token 只保存为 Secret。</p>
          </div>
          <button type="button" aria-label="关闭" @click="emit('close')">×</button>
        </header>

        <div class="discord-manual-body">
          <section class="discord-manual-step">
            <span class="discord-manual-index">01</span>
            <div>
              <h4>准备 Discord App 的三个值</h4>
              <p>
                打开自己的 Discord App，按路径复制 Application ID、Public Key 和 Bot Token，并填入
                SRL 的配置框。
              </p>
              <p class="discord-manual-note discord-manual-note--soft">
                如果侧栏挡住配置框，先关掉教程填完三个值，再重新打开手动部署教程。
              </p>
              <a :href="developerAppUrl" target="_blank" rel="noopener noreferrer">
                打开 Discord General Information
              </a>
              <a :href="developerBotUrl" target="_blank" rel="noopener noreferrer">
                打开 Discord Bot 设置
              </a>
              <code>Application ID：General Information → APPLICATION ID</code>
              <figure
                class="discord-manual-screenshot"
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
                class="discord-manual-screenshot"
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
              <p class="discord-manual-note">
                不要把 Application Secret 当成 Public Key。Bot Token 是密码。
              </p>
            </div>
          </section>

          <section class="discord-manual-step">
            <span class="discord-manual-index">02</span>
            <div>
              <h4>在 Cloudflare 创建 Worker</h4>
              <p>
                打开 Cloudflare 并登录 → Workers &amp; Pages → Create application → Hello World →
                Deploy。
              </p>
              <a href="https://dash.cloudflare.com/" target="_blank" rel="noopener noreferrer">
                打开 Cloudflare Dashboard
              </a>
              <p class="discord-manual-note discord-manual-note--soft">
                如果页面名称略有不同，选择创建一个新的 Worker / Hello World Worker。
              </p>
            </div>
          </section>

          <section class="discord-manual-step">
            <span class="discord-manual-index">03</span>
            <div>
              <h4>把 SRL 生成的代码放进 Worker</h4>
              <p>
                打开刚创建的 Worker → Edit Code。全选并删除示例代码，粘贴下面复制的 Bridge
                代码，然后 Deploy。
              </p>
              <button
                class="discord-manual-copy"
                type="button"
                :disabled="!manualWorkerSource"
                @click="copyText(manualWorkerSource, 'Bridge 代码已复制')"
              >
                复制 Bridge 代码
              </button>
              <p class="discord-manual-note discord-manual-note--soft">
                代码与一键版使用同一个 Worker 源码，并会自动创建数据库表；不需要手写代码或 SQL。
              </p>
            </div>
          </section>

          <section class="discord-manual-step">
            <span class="discord-manual-index">04</span>
            <div>
              <h4>创建数据库并绑定到 Worker</h4>
              <p>Cloudflare Dashboard → D1 SQL Database → Create Database。数据库名称可填：</p>
              <code>srl-discord-source-handoff</code>
              <a
                href="https://developers.cloudflare.com/d1/get-started/"
                target="_blank"
                rel="noopener noreferrer"
              >
                查看 Cloudflare D1 创建和绑定说明
              </a>
              <p>回到 Worker → Settings → Bindings → Add binding → D1 database：</p>
              <code>Variable name：DB</code>
              <p>数据库下拉框选择刚创建的那一个，再保存。</p>
              <p class="discord-manual-note discord-manual-note--soft">
                名称可以不同，但变量名必须准确填 <strong>DB</strong>。第一次访问 Worker
                时会自动建表。
              </p>
            </div>
          </section>

          <section class="discord-manual-step">
            <span class="discord-manual-index">05</span>
            <div>
              <h4>添加三个 Discord 配置值</h4>
              <p>
                Worker → Settings → Variables and Secrets → Add。每项填入 SRL 配置框中对应的值：
              </p>
              <div class="discord-manual-value">
                <span>DISCORD_APPLICATION_ID</span>
                <strong>{{ applicationId || '请先在 SRL 填写 Application ID' }}</strong>
                <button
                  type="button"
                  :disabled="!applicationId"
                  @click="copyText(applicationId, 'Application ID 已复制')"
                >
                  复制值
                </button>
              </div>
              <div class="discord-manual-value">
                <span>DISCORD_PUBLIC_KEY</span>
                <strong>{{ publicKey || '请先在 SRL 填写 Public Key' }}</strong>
                <button
                  type="button"
                  :disabled="!publicKey"
                  @click="copyText(publicKey, 'Public Key 已复制')"
                >
                  复制值
                </button>
              </div>
              <div class="discord-manual-value">
                <span>DISCORD_BOT_TOKEN</span>
                <strong>{{ botToken ? '已填写，可复制' : '请先在 SRL 填写 Bot Token' }}</strong>
                <button
                  type="button"
                  :disabled="!botToken"
                  @click="copyText(botToken, 'Bot Token 已复制')"
                >
                  复制值
                </button>
              </div>
              <code>Application ID：Type 选 Text；没有 Type 时不要勾选 Secret</code>
              <code>Public Key：Type 选 Text；没有 Type 时不要勾选 Secret</code>
              <code>Bot Token：Type 选 Secret；没有 Type 时勾选 Secret</code>
              <a
                href="https://developers.cloudflare.com/workers/configuration/secrets/"
                target="_blank"
                rel="noopener noreferrer"
              >
                查看添加 Secret 的官方步骤
              </a>
              <p class="discord-manual-note">
                Cloudflare 界面可能显示 Type 选择器，也可能在 Value 旁显示 Secret
                勾选框；按上面对应方式设置。三项添加后保存并 Deploy。Bot Token 必须保存为
                Secret，不要发给别人。
              </p>
              <figure
                class="discord-manual-screenshot"
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
                  截图展示 Secret 勾选框界面；有 Type 选择器时按上方说明选择类型。
                </figcaption>
              </figure>
            </div>
          </section>

          <section class="discord-manual-step">
            <span class="discord-manual-index">06</span>
            <div>
              <h4>复制 Worker 根链接回 SRL</h4>
              <p>
                部署成功后，在 Worker 的 Domains 页面复制 Production 的 workers.dev 地址，格式类似：
              </p>
              <figure
                class="discord-manual-screenshot"
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
                  如果没有 Production URL，先开启 workers.dev；Preview URL 不用开启。
                </figcaption>
              </figure>
              <p class="discord-manual-note discord-manual-note--soft">
                如果 Overview 显示 <strong>No URLs enabled</strong>，在 Domains 页面启用 Production
                的 <code>workers.dev</code> 开关，再复制生产地址。
              </p>
              <code>https://你的-worker.workers.dev</code>
              <p>
                粘贴到 SRL 的“Cloudflare 部署链接”，然后点“检查部署配置”。SRL 会检查 Worker
                /health、D1 和 Discord 凭证；状态条会提示失败项。不要自己给根链接添加路径。
              </p>
            </div>
          </section>

          <section class="discord-manual-step">
            <span class="discord-manual-index">07</span>
            <div>
              <h4>把交互地址填到 Discord</h4>
              <p>
                SRL 测试成功后会生成这条地址。复制后打开 Discord → General Information →
                Interactions Endpoint URL，粘贴并保存。地址必须以 <code>/interactions</code> 结尾，
                Public Key 必须来自同一个 Discord App。
              </p>
              <code v-if="interactionsUrl">{{ interactionsUrl }}</code>
              <code v-else>先在 SRL 填入 Worker 根链接，再点“检查部署配置”</code>
              <button
                class="discord-manual-copy"
                type="button"
                :disabled="!interactionsUrl"
                @click="copyText(interactionsUrl || '', 'Discord 交互地址已复制')"
              >
                复制 Discord 交互地址
              </button>
              <a :href="developerAppUrl" target="_blank" rel="noopener noreferrer">
                打开 Discord General Information
              </a>
              <p class="discord-manual-note discord-manual-note--soft">
                如果出现“无法验证指定的交互端点 URL”，依次核对：地址是否以
                <code>/interactions</code> 结尾、Worker 的 Production
                <code>DISCORD_PUBLIC_KEY</code> 是否与当前 App 一致、最新配置是否已 Deploy，以及
                workers.dev 地址是否已启用。初次验证发送 PING，只依赖 Public Key 验签；Application
                ID 和 Bot Token 不参与这一步。
              </p>
              <figure
                class="discord-manual-screenshot"
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
                <figcaption>先核对 `/interactions` 路径和同一个 App 的 Public Key。</figcaption>
              </figure>
            </div>
          </section>

          <section class="discord-manual-step">
            <span class="discord-manual-index">08</span>
            <div>
              <h4>安装并测试消息命令</h4>
              <p>先完成个人账号安装，再注册命令。下面的按钮只会打开设置页，不会自动安装 App：</p>
              <a :href="installationUrl" target="_blank" rel="noopener noreferrer">
                打开 Discord Installation 页面
              </a>
              <ol>
                <li>在 Installation Contexts 中开启 <strong>User Install</strong>。</li>
                <li>在 Install Link 中选择 <strong>Discord Provided Link</strong>。</li>
                <li>
                  在 Default Install Settings → User Install 中添加
                  <code>applications.commands</code>，然后点 <strong>Save Changes</strong>。
                </li>
                <li>
                  回到 Install Link 区域复制生成的安装链接；用准备操作消息的 Discord 账号打开链接，
                  并在授权页点 <strong>Add to my apps</strong>。
                </li>
              </ol>
              <p>
                完成 Add to my apps 后，回到 SRL 点“注册消息命令”，再在 Discord 里右键一条消息 →
                Apps → 保存到资源库。
              </p>
              <p class="discord-manual-note discord-manual-note--soft">
                “注册成功”只表示 Discord 已登记命令，不代表当前账号已安装 App。若 Apps
                菜单里找不到命令，先确认当前账号已完成 Add to my apps，且安装的是 SRL 中配置的同一个
                Discord App。
              </p>
              <p class="discord-manual-note discord-manual-note--soft">
                自动检查帖子更新需要额外把 Bot
                加入对应服务器，并允许它查看来源频道；保存消息本身不要求这一点。
              </p>
            </div>
          </section>

          <p v-if="copyStatus" class="discord-manual-status" role="status">{{ copyStatus }}</p>
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

<style scoped src="../styles/DiscordManualDeployDrawer.css"></style>
