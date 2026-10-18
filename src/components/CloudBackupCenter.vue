<script setup lang="ts">
import '../styles/CloudBackup.css'
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import { SRL_BACK_REQUEST_EVENT, type SrlBackRequestDetail } from '../composables/UseBackStack'
import FeatureAppHeader from './FeatureAppHeader.vue'
import BackupScopeTree from './BackupScopeTree.vue'
import ResourceImageViewer from './ResourceImageViewer.vue'
import {
  useCloudBackupCenter,
  type CloudBackupCenterProps,
  type CloudBackupCenterEvents,
} from '../composables/UseCloudBackupCenter'
const props = defineProps<CloudBackupCenterProps>()
const emit = defineEmits<CloudBackupCenterEvents>()
const controller = useCloudBackupCenter(emit, () => props.resources)
const {
  status,
  formatTime,
  snapshot,
  activeProvider,
  selectProvider,
  busyAction,
  createBackup,
  nativeTransport,
  nativeBackupActive,
  cancelNativeBackup,
  webBackup,
  pauseWebBackup,
  resumeWebBackup,
  webNotificationPermission,
  enableBackupNotifications,
  loadBackups,
  message,
  restoreProgress,
  restorePhase,
  restoreOperation,
  stopRestore,
  lastMetrics,
  metricSpeed,
  formatMetricDuration,
  formatMetricBytes,
  excessBackupCount,
  excessBackupBytes,
  cleanupRetention,
  activeConfig,
  backups,
  restorePicker,
  closeRestorePicker,
  selectedRestoreKeys,
  hasRestoreSelection,
  restoreResourceCount,
  restoreScopeIds,
  restoreScopeModel,
  restorePreview,
  pendingRestores,
  resumePendingRestore,
  formatBytes,
  download,
  restore,
  saveConfig,
  github,
  openTutorialPreview,
  editingCredential,
  refillCredential,
  githubToken,
  cancelCredentialRefill,
  webdav,
  KOOFR_URL,
  webdavPassword,
  setScheduleMode,
  updateScheduleValue,
  updateScheduleUnit,
  updateScheduleTime,
  activeProtection,
  cloudScopeModel,
  setCloudScopeModel,
  communitySourcesEnabled,
  communitySourcesDisabledReason,
  backupScopeResources,
  backupContentSummary,
  testConnection,
  tutorialPreview,
  closeTutorialPreview,
} = controller
const scopeDialog = ref<HTMLDialogElement>()
const scopeDialogOpen = ref(false)
const scopeDraft = ref({ ...cloudScopeModel.value })

async function openBackupScope(): Promise<void> {
  scopeDraft.value = {
    resourceIds: [...cloudScopeModel.value.resourceIds],
    scopeIds: [...cloudScopeModel.value.scopeIds],
  }
  scopeDialogOpen.value = true
  await nextTick()
  scopeDialog.value?.showModal()
}

function applyBackupScope(): void {
  setCloudScopeModel(scopeDraft.value)
  scopeDialog.value?.close()
}

function handleScopeBack(event: Event): void {
  if (!scopeDialog.value?.open || !(event instanceof CustomEvent)) return
  const detail = event.detail as SrlBackRequestDetail
  detail.handled = true
  event.stopImmediatePropagation()
  scopeDialog.value.close()
}

onMounted(() => window.addEventListener(SRL_BACK_REQUEST_EVENT, handleScopeBack, true))
onUnmounted(() => window.removeEventListener(SRL_BACK_REQUEST_EVENT, handleScopeBack, true))
</script>

<template>
  <section class="cloud-center">
    <FeatureAppHeader title="云备份" @back="emit('back')" />

    <section class="cloud-status" :class="{ 'cloud-status--error': status.lastError }">
      <i aria-hidden="true"></i>
      <div>
        <strong>{{ status.lastError ? '上次备份失败' : formatTime(status.lastSuccessAt) }}</strong>
        <p>
          {{
            status.lastError ||
            status.lastWarning ||
            (snapshot.credentials[activeProvider] === 'valid'
              ? '凭证已保存 · 正在使用'
              : snapshot.credentials[activeProvider] === 'invalid'
                ? '服务端已确认凭据失效，请重新填写'
                : '还没有保存云端凭证')
          }}
        </p>
        <p v-if="status.lastSuccessAt && status.lastResourceCount !== undefined">
          {{ status.provider === 'webdav' ? 'Koofr' : 'GitHub' }} · 上次成功备份
          {{ status.lastResourceCount }} 项
        </p>
      </div>
      <time v-if="status.lastSuccessAt">{{
        new Date(status.lastSuccessAt).toLocaleString('zh-CN')
      }}</time>
    </section>

    <nav
      class="cloud-provider-tabs"
      aria-label="选择云端备份方式"
      data-assistant-focus="backup-provider"
    >
      <button
        type="button"
        :aria-pressed="activeProvider === 'github'"
        :class="{ 'is-active': activeProvider === 'github' }"
        :disabled="Boolean(busyAction)"
        @click="selectProvider('github')"
      >
        <strong>GitHub</strong>
      </button>
      <button
        type="button"
        :aria-pressed="activeProvider === 'webdav'"
        :class="{ 'is-active': activeProvider === 'webdav' }"
        :disabled="Boolean(busyAction)"
        @click="selectProvider('webdav')"
      >
        <strong>Koofr</strong>
      </button>
    </nav>

    <div class="cloud-workspace">
      <section class="cloud-operations">
        <header>
          <h2>{{ restorePicker ? '导入云端备份' : '云端备份' }}</h2>
          <span>{{ activeProvider === 'github' ? 'GitHub' : 'Koofr' }}</span>
        </header>
        <div v-if="!restorePicker" class="cloud-primary-actions">
          <button
            v-if="!nativeTransport && webBackup?.status === 'running'"
            type="button"
            @click="pauseWebBackup"
          >
            暂停备份
          </button>
          <button
            v-if="
              !nativeTransport &&
              webBackup &&
              webBackup.status !== 'running' &&
              webBackup.status !== 'completed'
            "
            type="button"
            :disabled="Boolean(busyAction)"
            @click="resumeWebBackup"
          >
            继续备份
          </button>
          <button
            class="button--primary"
            data-assistant-focus="backup-create"
            type="button"
            :disabled="Boolean(busyAction) || nativeBackupActive"
            @click="createBackup"
          >
            {{ busyAction === 'backup' ? '生成并上传中…' : '立即备份（只传变化）' }}</button
          ><button
            v-if="busyAction === 'backup' || nativeBackupActive"
            type="button"
            @click="cancelNativeBackup"
          >
            {{
              nativeBackupActive && busyAction !== 'backup' ? '取消云备份任务' : '取消本次备份'
            }}</button
          ><button type="button" :disabled="Boolean(busyAction)" @click="loadBackups">
            {{ busyAction === 'list' ? '读取中…' : '刷新云端列表' }}
          </button>
        </div>
        <p v-if="!nativeTransport && !restorePicker" class="cloud-operations__note">
          可切换页面继续备份；保活沿用设置中的后台音频。
          <button
            v-if="webNotificationPermission !== 'granted'"
            type="button"
            @click="enableBackupNotifications"
          >
            开启完成通知
          </button>
          <span v-else>完成后发送系统通知。</span>
        </p>
        <p
          v-if="busyAction === 'backup' && message"
          class="cloud-message cloud-message--live"
          role="status"
          aria-live="polite"
        >
          {{ message }}
        </p>
        <section v-if="!restorePicker" class="cloud-backup-scope" aria-label="本次云备份范围">
          <div class="cloud-backup-scope__header">
            <strong>本次备份范围</strong>
            <button type="button" :disabled="Boolean(busyAction)" @click="openBackupScope">
              调整范围 <span aria-hidden="true">↗</span>
            </button>
          </div>
          <p>{{ backupContentSummary }}</p>
          <small>保存配置后生效。</small>
        </section>
        <div v-for="record in pendingRestores" :key="record.id" class="cloud-retention-alert">
          <span
            ><strong
              >恢复尚未完成 · {{ record.restore?.resourceKeys?.length ?? '原范围' }} 项</strong
            ><small>{{ record.restore?.item.objectKey }}</small></span
          >
          <button
            type="button"
            :disabled="Boolean(busyAction)"
            @click="resumePendingRestore(record.id)"
          >
            继续恢复
          </button>
        </div>
        <p
          v-if="message && busyAction !== 'backup' && !restorePicker"
          class="cloud-message"
          role="status"
        >
          {{ message }}
        </p>
        <details v-if="lastMetrics && !restorePicker" class="cloud-metrics">
          <summary>
            <span>上次任务性能</span>
            <strong>{{ metricSpeed(lastMetrics) }}</strong>
          </summary>
          <dl>
            <div>
              <dt>准备</dt>
              <dd>
                {{
                  formatMetricDuration(
                    lastMetrics.prepareMs + lastMetrics.hashMs + lastMetrics.objectBuildMs,
                  )
                }}
              </dd>
            </div>
            <div>
              <dt>本机准备</dt>
              <dd>
                {{
                  formatMetricDuration(
                    lastMetrics.nativeDiskMs +
                      lastMetrics.bridgeEncodeMs +
                      lastMetrics.bridgeTransferMs,
                  )
                }}
              </dd>
            </div>
            <div>
              <dt>请求累计耗时</dt>
              <dd>{{ formatMetricDuration(lastMetrics.networkMs) }}</dd>
            </div>
            <div>
              <dt>远端确认</dt>
              <dd>{{ formatMetricDuration(lastMetrics.verifyMs) }}</dd>
            </div>
            <div>
              <dt>清理</dt>
              <dd>{{ formatMetricDuration(lastMetrics.maintenanceMs) }}</dd>
            </div>
          </dl>
          <p>
            读取 {{ formatMetricBytes(lastMetrics.localReadBytes) }} · 上传
            {{ formatMetricBytes(lastMetrics.uploadedBytes) }} · 重试
            {{ lastMetrics.retryCount }} 次。 平均速度包含准备和校验时间。
          </p>
        </details>
        <div v-if="excessBackupCount" class="cloud-retention-alert">
          <span>
            <strong>当前多出 {{ excessBackupCount }} 份旧备份</strong>
            <small>新备份成功后自动清理，也可手动清理。</small>
          </span>
          <button type="button" :disabled="Boolean(busyAction)" @click="cleanupRetention">
            {{
              busyAction === 'prune'
                ? '清理中…'
                : `核对并清理（最多 ${formatBytes(excessBackupBytes)}）`
            }}
          </button>
        </div>
        <div v-if="backups.length && !restorePicker" class="cloud-backup-list">
          <article v-for="item in backups" :key="item.id">
            <div>
              <strong :title="item.objectKey">{{
                new Date(item.createdAt).toLocaleString('zh-CN')
              }}</strong
              ><small
                >{{
                  item.kind === 'githubSnapshot' || item.kind === 'webdavSnapshot'
                    ? item.partCount !== undefined
                      ? '资源合计'
                      : '清单'
                    : '归档'
                }}
                {{ formatBytes(item.size)
                }}<template v-if="item.partCount"> · {{ item.partCount }} 个分卷</template></small
              >
            </div>
            <span
              ><button type="button" :disabled="Boolean(busyAction)" @click="download(item)">
                {{ busyAction === `download:${item.id}` ? '下载中…' : '下载' }}</button
              ><button type="button" :disabled="Boolean(busyAction)" @click="restore(item)">
                {{ busyAction === `restore:${item.id}` ? '处理中…' : '导入本机' }}
              </button></span
            >
          </article>
        </div>
        <div v-else-if="!restorePicker" class="cloud-empty">
          <strong>还没有读取云端备份</strong>
          <p>保存配置后先测试连接，再创建备份或刷新列表。</p>
        </div>
        <section
          v-if="restorePicker"
          class="cloud-restore-selection"
          aria-labelledby="cloud-restore-selection-title"
        >
          <header>
            <div>
              <strong id="cloud-restore-selection-title">{{
                new Date(restorePicker.item.createdAt).toLocaleString('zh-CN')
              }}</strong>
              <span :title="restorePicker.item.objectKey">恢复时合并现有资源</span>
            </div>
          </header>
          <details class="cloud-restore-scope" :open="!busyAction">
            <summary>
              选择要导入的内容
              <span>{{ selectedRestoreKeys.size }} / {{ restoreResourceCount }} 项已选</span>
            </summary>
            <BackupScopeTree
              v-model="restoreScopeModel"
              :inert="Boolean(busyAction)"
              :resources="restorePicker.resources"
              :available-scope-ids="restoreScopeIds"
              mode="restore"
            />
            <p>
              当前资源预计新增 {{ restorePreview.added }} 项 · 已有内容
              {{ restorePreview.skipped }} 项<template v-if="restorePreview.conflicts">
                · {{ restorePreview.conflicts }} 项 ID 冲突保留两份</template
              >。历史另行合并，实际以导入结果为准。
            </p>
          </details>
          <div class="cloud-restore-selection__tools">
            <button
              class="button--primary"
              type="button"
              :disabled="Boolean(busyAction) || !hasRestoreSelection"
              @click="restore(restorePicker.item)"
            >
              {{ busyAction === `restore:${restorePicker.item.id}` ? '导入中…' : '导入所选内容' }}
            </button>
            <button
              v-if="!restoreOperation"
              type="button"
              :disabled="Boolean(busyAction)"
              @click="closeRestorePicker"
            >
              返回列表
            </button>
            <button
              v-if="restoreOperation"
              type="button"
              :disabled="restorePhase === 'commit' || restorePhase === 'extras'"
              @click="stopRestore"
            >
              停止本次导入
            </button>
          </div>
          <div v-if="message" class="cloud-restore-progress" role="status" aria-live="polite">
            <template
              v-if="
                restoreProgress &&
                busyAction.startsWith('restore:') &&
                (restorePhase === 'prepare' || restorePhase === 'commit')
              "
            >
              <div class="cloud-restore-progress__heading">
                <strong>{{ restoreProgress.phase === 'prepare' ? '已准备' : '正在写入' }}</strong>
                <span>{{ restoreProgress.completed }} / {{ restoreProgress.total }} 项</span>
              </div>
              <progress
                :value="restoreProgress.completed"
                :max="Math.max(1, restoreProgress.total)"
                aria-label="当前导入阶段进度"
              />
              <small
                >包含历史版本 ·
                {{
                  restoreProgress.phase === 'prepare'
                    ? '下载、校验与暂存'
                    : '当前批次写入完成后生效'
                }}</small
              >
            </template>
            <p v-if="message">{{ message }}</p>
          </div>
        </section>
      </section>

      <details class="cloud-connection" :open="snapshot.credentials[activeProvider] !== 'valid'">
        <summary>
          <strong>连接与自动备份设置</strong
          ><span>{{
            snapshot.credentials[activeProvider] === 'valid' ? '已配置' : '需要配置'
          }}</span>
        </summary>
        <form class="cloud-config" :inert="Boolean(busyAction)" @submit.prevent="saveConfig()">
          <p class="cloud-operations__note">
            请使用私有仓库或未公开分享的 Koofr 目录。保存配置后生效。
          </p>

          <template v-if="activeProvider === 'github'">
            <details class="cloud-beginner-guide">
              <summary>
                <span><strong>GitHub 配置教程</strong><small>私有仓库与专用令牌</small></span>
                <i>约 3 分钟</i>
              </summary>
              <div class="cloud-tutorial-steps cloud-tutorial-steps--real">
                <article class="cloud-tutorial-step">
                  <span class="cloud-tutorial-step__number">1</span>
                  <div>
                    <h3>建一个“私人盒子”</h3>
                    <p>点下面按钮，仓库名随便填；只要勾选 <b>Private</b>，再点创建。</p>
                  </div>
                  <button
                    type="button"
                    class="tutorial-real-shot"
                    aria-label="放大查看已脱敏的 GitHub 新建私有仓库真实截图"
                    @click="
                      openTutorialPreview(
                        '/tutorials/github-create-repository-redacted.webp',
                        'GitHub 新建仓库真实页面，账号已经隐藏',
                        $event,
                      )
                    "
                  >
                    <img
                      src="/tutorials/github-create-repository-redacted.webp"
                      alt="GitHub 新建仓库真实页面，账号已经隐藏"
                      loading="lazy"
                      decoding="async"
                    /><span>点图放大</span>
                  </button>
                  <ol class="tutorial-real-notes">
                    <li>
                      <b>Repository name</b> 填一个好认的名字，例如 <code>srl-backups</code>。
                    </li>
                    <li><b>Choose visibility</b> 保持 <b>Private</b>，其他项目保持默认。</li>
                    <li>滑到页面最下方，点绿色 <b>Create repository</b>。</li>
                  </ol>
                  <a href="https://github.com/new" target="_blank" rel="noreferrer"
                    >打开建仓库页面 →</a
                  >
                </article>

                <article class="cloud-tutorial-step">
                  <span class="cloud-tutorial-step__number">2</span>
                  <div>
                    <h3>领一把“专用钥匙”</h3>
                    <p>
                      Repository access 只选刚建的仓库；Contents 改成
                      <b>Read and write</b>，然后生成。
                    </p>
                  </div>
                  <button
                    type="button"
                    class="tutorial-real-shot"
                    aria-label="放大查看已脱敏的 GitHub 细粒度令牌真实截图"
                    @click="
                      openTutorialPreview(
                        '/tutorials/github-token-settings-redacted.webp',
                        'GitHub 新建细粒度令牌真实页面，账号已经隐藏',
                        $event,
                      )
                    "
                  >
                    <img
                      src="/tutorials/github-token-settings-redacted.webp"
                      alt="GitHub 新建细粒度令牌真实页面，账号已经隐藏"
                      loading="lazy"
                      decoding="async"
                    /><span>点图放大</span>
                  </button>
                  <ol class="tutorial-real-notes">
                    <li><b>Token name</b> 填 <code>SRL Backup</code>；到期时间按你需要选择。</li>
                    <li>
                      <b>Repository access</b> 选择
                      <b>Only select repositories</b>，再选刚建的仓库。
                    </li>
                    <li>
                      继续向下，在 <b>Repository permissions</b> 中把 <b>Contents</b> 改成
                      <b>Read and write</b>。
                    </li>
                    <li>最下方生成令牌后立刻复制；GitHub 只完整显示这一次。</li>
                  </ol>
                  <a
                    href="https://github.com/settings/personal-access-tokens/new"
                    target="_blank"
                    rel="noreferrer"
                    >打开领钥匙页面 →</a
                  >
                </article>

                <article class="cloud-tutorial-step">
                  <span class="cloud-tutorial-step__number">3</span>
                  <div>
                    <h3>把 3 项粘贴到下面</h3>
                    <p>用户名、仓库名和刚复制的钥匙填好，点“测试连接”。成功后就结束了。</p>
                  </div>
                  <div
                    class="tutorial-shot tutorial-shot--compact"
                    role="img"
                    aria-label="将 GitHub 资料粘贴到资源库的操作示意图"
                  >
                    <div class="tutorial-shot__bar">
                      <i></i><i></i><i></i><span>SRL · 云备份</span>
                    </div>
                    <div class="tutorial-shot__body">
                      <label>你的 GitHub 名字 <span>octocat</span></label
                      ><label>备份仓库名字 <span>我的酒馆备份</span></label
                      ><label>刚复制的钥匙 <span>••••••••••••••••</span></label
                      ><button type="button" tabindex="-1">测试连接</button>
                    </div>
                  </div>
                </article>
              </div>
              <p class="cloud-device-note">
                <b>手机和电脑步骤相同：</b>直接点上面的绿色链接即可，不需要在 GitHub
                菜单里层层寻找。手机页面较窄时左右滑动教程卡片。
              </p>
            </details>
            <label
              ><span>你的 GitHub 名字</span
              ><input
                v-model.trim="github.owner"
                autocomplete="username"
                placeholder="例如 octocat"
            /></label>
            <label
              ><span>备份仓库名字</span
              ><input v-model.trim="github.repository" placeholder="例如 srl-backups"
            /></label>
            <div
              v-if="snapshot.credentials.github === 'valid' && !editingCredential.github"
              class="cloud-credential-status"
            >
              <span><strong>GitHub 密钥</strong><small>已保存 · 正在使用</small></span>
              <button type="button" @click="refillCredential('github')">重新填写密钥</button>
            </div>
            <label v-else
              ><span>{{
                snapshot.credentials.github === 'invalid' ? 'GitHub 密钥已失效' : 'GitHub 密钥'
              }}</span
              ><input
                v-model="githubToken"
                type="password"
                autocomplete="new-password"
                placeholder="github_pat_…"
              /><small>{{
                snapshot.credentials.github === 'valid'
                  ? '新密钥验证通过后替换旧密钥。'
                  : '仅保存在当前设备。'
              }}</small>
              <button
                v-if="snapshot.credentials.github === 'valid'"
                type="button"
                class="cloud-credential-cancel"
                @click="cancelCredentialRefill('github')"
              >
                取消重新填写
              </button></label
            >
          </template>

          <template v-else>
            <details class="cloud-beginner-guide">
              <summary>
                <span><strong>Koofr 配置教程</strong><small>获取应用密码</small></span
                ><i>约 3 分钟</i>
              </summary>
              <nav class="webdav-official-links" aria-label="Koofr 官方教程">
                <a
                  href="https://koofr.eu/help/linking-koofr-with-desktops/how-to-generate-an-application-specific-password-in-koofr/"
                  target="_blank"
                  rel="noreferrer"
                  ><strong>Koofr 官方说明</strong><span>应用密码教程 · 手机和电脑步骤相同</span
                  ><i>打开 →</i></a
                >
              </nav>
              <div class="cloud-tutorial-steps cloud-tutorial-steps--real">
                <article class="cloud-tutorial-step">
                  <span class="cloud-tutorial-step__number">1</span>
                  <div>
                    <h3>打开 Preferences</h3>
                    <p>登录 Koofr 后点右上角头像，在菜单里点被绿圈标出的 Preferences。</p>
                  </div>
                  <button
                    type="button"
                    class="tutorial-real-shot"
                    aria-label="放大查看已脱敏的 Koofr 应用密码设置真实截图"
                    @click="
                      openTutorialPreview(
                        '/tutorials/koofr-step-1-preferences-redacted.png',
                        '第 1 步：打开 Koofr Preferences，账号已经隐藏',
                        $event,
                      )
                    "
                  >
                    <img
                      src="/tutorials/koofr-step-1-preferences-redacted.png"
                      alt="第 1 步：打开 Koofr Preferences，账号已经隐藏"
                      loading="lazy"
                      decoding="async"
                    /><span>点图放大</span>
                  </button>
                </article>
                <article class="cloud-tutorial-step">
                  <span class="cloud-tutorial-step__number">2</span>
                  <div>
                    <h3>选择 Password</h3>
                    <p>进入 Preferences 后，在左侧菜单点被绿圈标出的 Password。</p>
                  </div>
                  <button
                    type="button"
                    class="tutorial-real-shot"
                    aria-label="放大查看已脱敏的 Koofr 应用密码生成结果真实截图"
                    @click="
                      openTutorialPreview(
                        '/tutorials/koofr-step-2-password-redacted.png',
                        '第 2 步：选择 Password，个人资料已经裁掉',
                        $event,
                      )
                    "
                  >
                    <img
                      src="/tutorials/koofr-step-2-password-redacted.png"
                      alt="第 2 步：选择 Password，个人资料已经裁掉"
                      loading="lazy"
                      decoding="async"
                    /><span>点图放大</span>
                  </button>
                </article>
                <article class="cloud-tutorial-step">
                  <span class="cloud-tutorial-step__number">3</span>
                  <div>
                    <h3>生成应用密码</h3>
                    <p>滑到 App passwords，在名称框填“SRL WebDAV Backup”，再点 Generate。</p>
                  </div>
                  <button
                    type="button"
                    class="tutorial-real-shot"
                    aria-label="放大查看 Koofr 应用密码生成位置"
                    @click="
                      openTutorialPreview(
                        '/tutorials/koofr-step-3-generate-redacted.png',
                        '第 3 步：填写名称并生成应用密码，账号已经隐藏',
                        $event,
                      )
                    "
                  >
                    <img
                      src="/tutorials/koofr-step-3-generate-redacted.png"
                      alt="第 3 步：填写名称并生成应用密码，账号已经隐藏"
                      loading="lazy"
                      decoding="async"
                    /><span>点图放大</span>
                  </button>
                </article>
                <article class="cloud-tutorial-step">
                  <span class="cloud-tutorial-step__number">4</span>
                  <div>
                    <h3>复制密码并填入 SRL</h3>
                    <p>
                      立即点 Copy；回到这里，地址用
                      <code>https://app.koofr.net/dav/Koofr</code
                      >，用户名填注册邮箱，应用密码填刚复制的内容。
                    </p>
                  </div>
                  <button
                    type="button"
                    class="tutorial-real-shot"
                    aria-label="放大查看 Koofr 应用密码复制按钮"
                    @click="
                      openTutorialPreview(
                        '/tutorials/koofr-step-4-copy-redacted.png',
                        '第 4 步：立即复制应用密码，真实密码已经遮挡',
                        $event,
                      )
                    "
                  >
                    <img
                      src="/tutorials/koofr-step-4-copy-redacted.png"
                      alt="第 4 步：立即复制应用密码，真实密码已经遮挡"
                      loading="lazy"
                      decoding="async"
                    /><span>点图放大</span>
                  </button>
                  <p class="cloud-koofr-ready">地址和备份文件夹已由 SRL 自动配置</p>
                </article>
              </div>
              <p class="cloud-device-note">
                <b>Koofr 手机和电脑步骤相同：</b>手机页面较窄时打开浏览器“桌面版网站”更容易找到
                Password。SRL 不再展示其他 WebDAV 服务商，避免用户在不同入口之间迷路。
              </p>
            </details>
            <div class="cloud-fixed-value">
              <span>Koofr 服务器</span><strong>{{ KOOFR_URL }}</strong
              ><small>已自动配置，不需要修改</small>
            </div>
            <label
              ><span>Koofr 注册邮箱</span
              ><input v-model.trim="webdav.username" autocomplete="username"
            /></label>
            <div
              v-if="snapshot.credentials.webdav === 'valid' && !editingCredential.webdav"
              class="cloud-credential-status"
            >
              <span><strong>Koofr 应用密码</strong><small>已保存 · 正在使用</small></span>
              <button type="button" @click="refillCredential('webdav')">重新填写密钥</button>
            </div>
            <label v-else
              ><span>{{
                snapshot.credentials.webdav === 'invalid'
                  ? 'Koofr 应用密码已失效'
                  : 'Koofr 应用密码'
              }}</span
              ><input
                v-model="webdavPassword"
                type="password"
                autocomplete="new-password"
              /><small>{{
                snapshot.credentials.webdav === 'valid'
                  ? '新密码验证通过后替换旧密码。'
                  : '仅保存在当前设备。'
              }}</small>
              <button
                v-if="snapshot.credentials.webdav === 'valid'"
                type="button"
                class="cloud-credential-cancel"
                @click="cancelCredentialRefill('webdav')"
              >
                取消重新填写
              </button></label
            >
            <div class="cloud-fixed-value">
              <span>备份文件夹</span><strong>{{ webdav.folder || 'SRL-Backups' }}</strong
              ><small>上传成功后由 SRL 自动创建</small>
            </div>
          </template>

          <div class="cloud-config__row">
            <label
              ><span>保留份数</span
              ><input
                v-model.number="activeConfig.retention"
                type="number"
                inputmode="numeric"
                min="1"
                max="30"
              /><small>新备份成功后清理多余旧备份；异常时暂停清理。</small></label
            >
            <label class="cloud-auto"
              ><input v-model="activeConfig.autoBackup" type="checkbox" /><span
                ><strong>自动备份</strong
                ><small>{{
                  nativeTransport
                    ? '打开应用时检查，上传可在后台继续。'
                    : '打开网页时检查，错过则下次补做。'
                }}</small></span
              ></label
            >
          </div>
          <section v-if="activeConfig.autoBackup" class="cloud-schedule" aria-label="自动备份频率">
            <header><strong>备份频率</strong></header>
            <div class="cloud-schedule__modes">
              <button
                type="button"
                :class="{ 'is-active': activeConfig.schedule?.mode === 'interval' }"
                @click="setScheduleMode('interval')"
              >
                按间隔</button
              ><button
                type="button"
                :class="{ 'is-active': activeConfig.schedule?.mode === 'daily' }"
                @click="setScheduleMode('daily')"
              >
                每天定时
              </button>
            </div>
            <div v-if="activeConfig.schedule?.mode === 'interval'" class="cloud-schedule__fields">
              <label
                ><span>每隔</span
                ><input
                  type="number"
                  inputmode="numeric"
                  :min="activeConfig.schedule.unit === 'minutes' ? 15 : 1"
                  :max="
                    activeConfig.schedule.unit === 'minutes'
                      ? 1440
                      : activeConfig.schedule.unit === 'hours'
                        ? 168
                        : 30
                  "
                  :value="activeConfig.schedule.value"
                  @input="updateScheduleValue"
              /></label>
              <label
                ><span>单位</span
                ><select :value="activeConfig.schedule.unit" @change="updateScheduleUnit">
                  <option value="minutes">分钟</option>
                  <option value="hours">小时</option>
                  <option value="days">天</option>
                </select></label
              >
            </div>
            <label v-else-if="activeConfig.schedule?.mode === 'daily'" class="cloud-schedule__time"
              ><span>每天几点</span
              ><input type="time" :value="activeConfig.schedule.time" @input="updateScheduleTime"
            /></label>
            <p v-if="nativeTransport">间隔最短 15 分钟；关闭期间不生成新备份。</p>
            <p v-else>间隔最短 15 分钟；网页关闭或被系统冻结时暂停。</p>
          </section>
          <details class="cloud-protection">
            <summary>
              <span><strong>备份安全与流量</strong><small>完整性校验和自动备份条件</small></span>
              <i>高级</i>
            </summary>
            <div class="cloud-protection__body">
              <div v-if="activeConfig.autoBackup" class="cloud-protection__conditions">
                <label class="cloud-protection__toggle">
                  <input v-model="activeProtection.wifiOnly" type="checkbox" />
                  <span
                    ><strong>自动备份仅 Wi-Fi</strong><small>手动备份不受此条件限制。</small></span
                  >
                </label>
                <label class="cloud-protection__toggle">
                  <input v-model="activeProtection.chargingOnly" type="checkbox" />
                  <span
                    ><strong>自动备份仅充电时</strong
                    ><small>设备不提供电量接口时不会强行拦截。</small></span
                  >
                </label>
              </div>
              <ul class="cloud-protection__facts">
                <li>恢复前校验文件完整性；失败时保留旧备份。</li>
                <li>中断后复用已完成部分，继续未完成内容。</li>
              </ul>
            </div>
          </details>
          <div class="cloud-config__actions">
            <button type="button" :disabled="Boolean(busyAction)" @click="testConnection">
              {{
                busyAction === 'test'
                  ? '测试中…'
                  : activeProvider === 'webdav' && !nativeTransport
                    ? '测试连接（网页可能受限）'
                    : '测试连接'
              }}</button
            ><button type="submit">保存并设为当前方式</button>
          </div>
        </form>
      </details>
    </div>

    <Teleport to="body">
      <dialog
        ref="scopeDialog"
        class="cloud-scope-dialog"
        aria-label="调整备份范围"
        @keydown.esc.stop.prevent="scopeDialog?.close()"
        @click.self="scopeDialog?.close()"
        @close="scopeDialogOpen = false"
      >
        <header>
          <h2>备份范围</h2>
          <button type="button" aria-label="关闭备份范围" @click="scopeDialog?.close()">×</button>
        </header>
        <div v-if="scopeDialogOpen" class="cloud-scope-dialog__body">
          <p>密钥默认不备份；社区内容只允许备份到私有目标。</p>
          <p>
            换机请展开额外资源，勾选需要的相册、创作资料及凭据；网页登录、系统与目录授权需在新设备重新设置。
          </p>
          <BackupScopeTree
            v-model="scopeDraft"
            :resources="backupScopeResources"
            :categories="props.categories"
            mode="cloud"
            :disabled-scope-ids="communitySourcesEnabled ? [] : ['extra.communitySources']"
            :disabled-scope-reasons="{
              'extra.communitySources': communitySourcesDisabledReason,
            }"
          />
        </div>
        <footer>
          <button type="button" @click="scopeDialog?.close()">取消</button>
          <button type="button" class="cloud-scope-dialog__confirm" @click="applyBackupScope">
            确认范围
          </button>
        </footer>
      </dialog>
      <ResourceImageViewer
        v-if="tutorialPreview"
        :src="tutorialPreview.source"
        :name="tutorialPreview.alt"
        :cover="true"
        :minimal="true"
        @close="closeTutorialPreview"
      />
    </Teleport>
  </section>
</template>
