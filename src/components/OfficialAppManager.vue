<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import '../styles/ConfirmDialog.css'
import FeatureAppHeader from './FeatureAppHeader.vue'
import { FEATURE_APP_REGISTRY } from '../core/FeatureAppRegistry'
import { officialAppService } from '../core/OfficialAppRuntime'
import {
  isOfficialAppId,
  type InstalledOfficialApp,
  type OfficialAppId,
  type OfficialAppInstallProgress,
  type OfficialAppUpdateInfo,
} from '../types/OfficialApp'
import { OFFICIAL_APP_DATA_DESCRIPTION } from '../types/OfficialApp'
defineEmits<{ back: [] }>()
const apps = FEATURE_APP_REGISTRY.filter((app) => isOfficialAppId(app.id))
const installed = ref<InstalledOfficialApp[]>([...officialAppService.installedSnapshot])
const availableUpdates = ref<Partial<Record<OfficialAppId, OfficialAppUpdateInfo>>>({})
const busy = ref(false)
const selectedUpdates = ref<OfficialAppId[]>([])
const installProgress = ref<Partial<Record<OfficialAppId, OfficialAppInstallProgress>>>({})
const message = ref('')
const updateCheckError = ref('')
const repairIds = ref(new Set<string>())
const updateNoticeItems = ref<AppUpdateNotice[]>([])
const selected = ref<OfficialAppId>()
const selectedAction = ref<'uninstall' | 'clearData'>()
const removeDataOnUninstall = ref(false)
const clearStyles = ref(false)
const confirmation = ref<HTMLDialogElement>()
const updatesDialog = ref<HTMLDialogElement>()
const helpDialog = ref<HTMLDialogElement>()
const actionError = ref('')
const actionResult = ref('')
const sizes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`
const find = (id: string) => installed.value.find((app) => app.id === id)
const formatVersion = (version: string) => `#${version}`
const formatShellVersion = (version: string) =>
  version.replace(/^srl-/u, '').replace(/-v(\d+)$/u, ' (v$1)')
interface AppUpdateNotice {
  id: OfficialAppId
  name: string
  currentVersion: string
  latestVersion: string
  latestShellVersion: string
  requiresHostUpdate: boolean
  requiresAssetRepair?: boolean
}
function updateNoticeKey(update: AppUpdateNotice): string {
  if (update.requiresHostUpdate) return `host:${update.latestVersion}@${update.latestShellVersion}`
  if (update.requiresAssetRepair)
    return `repair:${update.latestVersion}@${update.latestShellVersion}`
  return update.latestVersion
}
const appUpdates = computed(() =>
  apps.flatMap((app) => {
    const id = app.id
    if (!isOfficialAppId(id)) return []
    const update = availableUpdates.value[id]
    if (!update) return []
    return [
      {
        id,
        name: app.name,
        ...update,
      },
    ]
  }),
)
const updateFor = (id: string) => appUpdates.value.find((update) => update.id === id)
const updatable = appUpdates
const batchIds = computed(() => {
  const chosen = updatable.value.filter((update) => selectedUpdates.value.includes(update.id))
  return (chosen.length ? chosen : updatable.value).map((update) => update.id)
})
function progressText(id: string): string {
  if (!isOfficialAppId(id)) return ''
  const progress = installProgress.value[id]
  if (!progress) return ''
  switch (progress.stage) {
    case 'queued':
      return '等待下载'
    case 'downloading':
      return `正在下载 ${sizes(progress.downloadedBytes ?? 0)} / ${sizes(progress.totalBytes ?? 0)}`
    case 'checking':
      return '正在校验安装包'
    case 'waiting':
      return '下载完成，等待安装'
    case 'installing':
      return `正在安装 ${progress.completedFiles ?? 0} / ${progress.totalFiles ?? 0} 个文件`
    case 'done':
      return '更新成功'
    case 'failed':
      return `更新失败：${progress.message}`
  }
}
async function installUpdates(ids: OfficialAppId[] = batchIds.value) {
  if (busy.value || !ids.length) return
  const targets = [...ids]
  updatesDialog.value?.close()
  busy.value = true
  message.value = `正在更新 ${targets.length} 个 APP，最多同时下载两个包…`
  installProgress.value = Object.fromEntries(targets.map((id) => [id, { id, stage: 'queued' }]))
  try {
    const results = await officialAppService.installMany(targets, (progress) => {
      installProgress.value[progress.id] = progress
    })
    const succeeded = results.filter((result) => !result.error).map((result) => result.id)
    for (const result of results) {
      installProgress.value[result.id] = result.error
        ? { id: result.id, stage: 'failed', message: result.error.message }
        : { id: result.id, stage: 'done' }
    }
    selectedUpdates.value = selectedUpdates.value.filter((id) => !succeeded.includes(id))
    updateNoticeItems.value = updateNoticeItems.value.filter(
      (notice) => !succeeded.includes(notice.id),
    )
    message.value = '安装已完成，正在检查更新状态…'
    // Refresh once for the batch after every installation has committed or failed.
    try {
      await refresh()
      await checkForUpdates(false)
    } catch (error) {
      updateCheckError.value = error instanceof Error ? error.message : '更新检查失败'
    }
    message.value = `更新结束：完成 ${succeeded.length} 个${results.length > succeeded.length ? `，失败 ${results.length - succeeded.length} 个` : ''}`
  } catch (error) {
    message.value = error instanceof Error ? error.message : '更新失败'
    for (const id of targets)
      installProgress.value[id] = { id, stage: 'failed', message: message.value }
  } finally {
    busy.value = false
  }
}
const dismissedUpdates = (): Partial<Record<OfficialAppId, string>> => {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem('srl.officialApps.skippedUpdates.v1') ?? '{}',
    )
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return value as Partial<Record<OfficialAppId, string>>
  } catch {
    return {}
  }
}
async function refresh() {
  installed.value = await officialAppService.loadInstalled()
}
async function checkStatus() {
  if (busy.value) return
  busy.value = true
  message.value = '正在检查已安装 APP 的文件与完整性…'
  try {
    const results = await officialAppService.checkInstalledStatus()
    await refresh()
    const damaged = results.filter((item) => !item.ready)
    repairIds.value = new Set(damaged.map((item) => item.id))
    message.value = damaged.length
      ? `需要修复：${damaged.map((item) => apps.find((app) => app.id === item.id)?.name ?? item.id).join('、')}。请重新下载对应 APP，已有数据会保留。`
      : `已检查 ${results.length} 个 APP，程序文件完整。`
  } catch (error) {
    message.value = error instanceof Error ? error.message : '检查 APP 状态失败'
  } finally {
    busy.value = false
  }
}
async function checkForUpdates(showNotice: boolean) {
  updateCheckError.value = ''
  availableUpdates.value = await officialAppService.availableUpdates()
  await refresh()
  if (!showNotice) return
  const dismissed = dismissedUpdates()
  updateNoticeItems.value = appUpdates.value.filter((update) => {
    const skipped = dismissed[update.id]
    if (skipped === updateNoticeKey(update)) return false
    // Preserve prior content-version skips across shell rebuilds.
    return !(
      !update.requiresHostUpdate &&
      !update.requiresAssetRepair &&
      skipped?.split('@')[0] === update.latestVersion
    )
  })
  if (updateNoticeItems.value.length) {
    await nextTick()
    updatesDialog.value?.showModal()
  }
}
function closeUpdatesNotice() {
  updatesDialog.value?.close()
  updateNoticeItems.value = []
}
function closeHelp() {
  helpDialog.value?.close()
}
function skipCurrentVersion(id: OfficialAppId) {
  const notice = updateNoticeItems.value.find((item) => item.id === id)
  if (!notice) return
  const dismissed = dismissedUpdates()
  dismissed[id] = updateNoticeKey(notice)
  localStorage.setItem('srl.officialApps.skippedUpdates.v1', JSON.stringify(dismissed))
  updateNoticeItems.value = updateNoticeItems.value.filter((item) => item.id !== id)
  if (!updateNoticeItems.value.length) updatesDialog.value?.close()
}
async function install(id: string) {
  if (busy.value || !isOfficialAppId(id)) return
  delete installProgress.value[id]
  const updating = Boolean(find(id))
  busy.value = true
  message.value = updating ? '正在更新并校验 APP…' : '正在下载并校验 APP…'
  try {
    await officialAppService.install(id)
    repairIds.value.delete(id)
    selectedUpdates.value = selectedUpdates.value.filter((selectedId) => selectedId !== id)
    await refresh()
    await checkForUpdates(false)
    updateNoticeItems.value = updateNoticeItems.value.filter((item) => item.id !== id)
    if (!updateNoticeItems.value.length) updatesDialog.value?.close()
    message.value = updating ? '更新成功' : '安装成功'
  } catch (error) {
    message.value = error instanceof Error ? error.message : '安装失败'
  } finally {
    busy.value = false
  }
}
async function choose(id: string, action: 'uninstall' | 'clearData') {
  if (isOfficialAppId(id)) {
    selected.value = id
    selectedAction.value = action
    removeDataOnUninstall.value = false
    clearStyles.value = false
    message.value = ''
    actionError.value = ''
    actionResult.value = ''
    await nextTick()
    confirmation.value?.showModal()
  }
}
function cancelSelectedAction() {
  if (busy.value) return
  confirmation.value?.close()
  selected.value = undefined
  selectedAction.value = undefined
}
async function applySelectedAction() {
  if (busy.value || !selected.value || !selectedAction.value) return
  busy.value = true
  actionError.value = ''
  try {
    const app = selected.value
    if (selectedAction.value === 'clearData') {
      await officialAppService.clearAppData(app, clearStyles.value)
      actionResult.value =
        '已清理该 APP 的独占数据。程序文件、资源库原件、其他 APP、远端文件和共用配置均已保留；请刷新后再打开该 APP。'
    } else {
      const bytes = await officialAppService.uninstall(
        app,
        removeDataOnUninstall.value,
        removeDataOnUninstall.value && clearStyles.value,
      )
      actionResult.value = `已卸载，删除独占程序文件 ${sizes(bytes)}。共用文件继续保留；已加载的代码会在关闭或刷新页面后退出内存。`
    }
    await refresh()
  } catch (error) {
    actionError.value =
      error instanceof Error
        ? error.message
        : selectedAction.value === 'clearData'
          ? '清理数据失败'
          : '卸载失败'
  } finally {
    busy.value = false
  }
}
function reloadPage() {
  window.location.reload()
}
onMounted(async () => {
  try {
    await refresh()
  } catch (error) {
    message.value = String(error)
    return
  }
  try {
    await checkForUpdates(true)
  } catch (error) {
    updateCheckError.value = error instanceof Error ? error.message : '无法检查 APP 更新'
  }
})
</script>
<template>
  <FeatureAppHeader title="APP 管理" @back="$emit('back')">
    <template #actions>
      <button
        v-if="batchIds.length"
        class="feature-header-action official-app-manager__batch-update"
        type="button"
        :disabled="busy"
        :aria-label="`${selectedUpdates.some((id) => batchIds.includes(id)) ? '更新所选' : '更新全部'}（${batchIds.length}）`"
        @click="installUpdates()"
      >
        {{ selectedUpdates.some((id) => batchIds.includes(id)) ? '更新所选' : '更新全部' }}
      </button>
      <button
        type="button"
        class="feature-header-action feature-header-action--icon official-app-manager__help-trigger"
        aria-label="查看 APP 管理说明"
        aria-haspopup="dialog"
        aria-controls="official-app-manager-help-dialog"
        @click="helpDialog?.showModal()"
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M9.7 9a2.4 2.4 0 1 1 3.8 1.9c-.9.7-1.5 1.1-1.5 2.6" />
          <path d="M12 16.8v.1" />
        </svg>
      </button>
    </template>
  </FeatureAppHeader>
  <section class="official-app-manager" :aria-busy="busy">
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="updateCheckError" role="status">暂时无法检查 APP 更新：{{ updateCheckError }}</p>
    <ul>
      <li v-for="app in apps" :key="app.id">
        <div class="official-app-manager__app-info">
          <strong class="official-app-manager__app-name"
            ><label v-if="updateFor(app.id)" class="official-app-manager__select-update">
              <input
                v-model="selectedUpdates"
                type="checkbox"
                :value="app.id"
                :disabled="busy"
                :aria-label="`选择更新${app.name}`"
              /> </label
            >{{ app.name
            }}<span
              v-if="updateFor(app.id)"
              class="official-app-manager__update-dot"
              role="img"
              aria-label="有新版本"
            ></span
          ></strong>
          <small>{{
            find(app.id)
              ? `已安装 · ${sizes(find(app.id)!.files.reduce((sum, file) => sum + file.size, 0))}（含共用文件）`
              : '未安装'
          }}</small>
          <div v-if="updateFor(app.id)" class="official-app-manager__versions">
            <small>当前版本 {{ formatVersion(updateFor(app.id)!.currentVersion) }}</small>
            <small class="official-app-manager__update-version">
              最新版本 {{ formatVersion(updateFor(app.id)!.latestVersion) }}
            </small>
          </div>
          <small
            v-if="progressText(app.id)"
            class="official-app-manager__progress"
            :class="{
              'official-app-manager__progress--failed':
                isOfficialAppId(app.id) && installProgress[app.id]?.stage === 'failed',
            }"
            >{{ progressText(app.id) }}</small
          >
        </div>
        <div class="official-app-manager__app-actions">
          <button
            v-if="!find(app.id) || updateFor(app.id) || updateCheckError || repairIds.has(app.id)"
            type="button"
            :class="{ 'confirm-dialog__confirm': Boolean(find(app.id) && updateFor(app.id)) }"
            :disabled="busy"
            @click="install(app.id)"
          >
            {{ repairIds.has(app.id) ? '修复' : find(app.id) ? '更新' : '下载' }}
          </button>
          <span v-else class="official-app-manager__latest">已是最新</span>
          <button
            v-if="find(app.id)"
            type="button"
            :disabled="busy"
            @click="choose(app.id, 'uninstall')"
          >
            卸载
          </button>
          <button type="button" :disabled="busy" @click="choose(app.id, 'clearData')">
            清理数据
          </button>
        </div>
      </li>
    </ul>
  </section>
  <Teleport to="body">
    <dialog
      id="official-app-manager-help-dialog"
      ref="helpDialog"
      class="confirm-dialog official-app-manager__dialog official-app-manager__help-dialog"
      aria-labelledby="official-app-manager-help-title"
      @cancel.prevent="closeHelp"
    >
      <h3 id="official-app-manager-help-title">APP 管理说明</h3>
      <p>
        程序按需下载。资源库升级后，兼容且完整的已安装版本会继续使用；有新版本时可在此更新，原有数据保留。
      </p>
      <button type="button" class="button button--quiet" :disabled="busy" @click="checkStatus">
        检查 APP 状态
      </button>
      <p v-if="message" role="status">{{ message }}</p>
      <footer>
        <button type="button" autofocus @click="closeHelp">知道了</button>
      </footer>
    </dialog>
    <dialog
      v-if="updateNoticeItems.length"
      ref="updatesDialog"
      class="confirm-dialog official-app-manager__dialog official-app-manager__updates-dialog"
      aria-labelledby="official-app-updates-title"
      @cancel.prevent="closeUpdatesNotice"
    >
      <header class="official-app-manager__updates-header">
        <h3 id="official-app-updates-title">发现 APP 更新</h3>
        <p>可一键更新，或返回列表勾选多个 APP 更新；也可跳过当前版本。</p>
      </header>
      <ul class="official-app-manager__updates-list">
        <li v-for="update in updateNoticeItems" :key="update.id">
          <div>
            <strong>{{ update.name }}</strong>
            <small>当前 APP 包版本：{{ formatVersion(update.currentVersion) }}</small>
            <small>最新 APP 包版本：{{ formatVersion(update.latestVersion) }}</small>
            <small>发布壳版本：{{ formatShellVersion(update.latestShellVersion) }}</small>
            <small v-if="update.requiresHostUpdate">
              当前 APP 使用的宿主 API 版本不兼容，需要更新兼容包。
            </small>
            <small v-else-if="update.requiresAssetRepair">
              当前 APP 缺少运行资源，需要重新安装以修复。
            </small>
          </div>
          <div class="official-app-manager__updates-actions">
            <button
              type="button"
              class="confirm-dialog__confirm"
              :disabled="busy"
              @click="install(update.id)"
            >
              去更新
            </button>
            <button type="button" :disabled="busy" @click="skipCurrentVersion(update.id)">
              跳过 APP 当前版本
            </button>
          </div>
        </li>
      </ul>
      <footer class="official-app-manager__updates-footer">
        <button type="button" :disabled="busy" @click="closeUpdatesNotice">稍后处理</button>
        <button
          v-if="updatable.length"
          type="button"
          class="confirm-dialog__confirm"
          :disabled="busy"
          @click="installUpdates(updatable.map((update) => update.id))"
        >
          更新全部（{{ updatable.length }}）
        </button>
      </footer>
    </dialog>
    <dialog
      v-if="selected && selectedAction"
      ref="confirmation"
      class="confirm-dialog official-app-manager__dialog"
      aria-labelledby="official-app-action-title"
      @cancel.prevent="cancelSelectedAction"
    >
      <h3 id="official-app-action-title">
        {{ apps.find((app) => app.id === selected)?.name }} ·
        {{ selectedAction === 'clearData' ? '清理数据' : '卸载选项' }}
      </h3>
      <template v-if="actionResult">
        <p role="status">{{ actionResult }}</p>
        <p v-if="actionError" role="alert">列表刷新失败：{{ actionError }}</p>
        <footer>
          <button type="button" @click="cancelSelectedAction">知道了</button>
          <button type="button" class="confirm-dialog__confirm" @click="reloadPage">
            刷新页面
          </button>
        </footer>
      </template>
      <form v-else :aria-busy="busy" @submit.prevent="applySelectedAction">
        <fieldset :disabled="busy">
          <template v-if="selectedAction === 'clearData'">
            <label
              ><input v-model="clearStyles" type="checkbox" />同时删除该 APP 的自定义样式</label
            >
            <p>
              将清除：{{ OFFICIAL_APP_DATA_DESCRIPTION[selected] }}。APP
              程序文件继续保留，资源库原件、其他 APP、远端文件和共用 API/图床设置不会受影响。
            </p>
            <p>本机删除后无法撤销；正在使用该 APP 时会拒绝操作，避免旧页面把数据重新写回。</p>
          </template>
          <template v-else>
            <label
              ><input v-model="removeDataOnUninstall" type="radio" :value="false" />仅卸载
              APP，保留数据</label
            >
            <label
              ><input v-model="removeDataOnUninstall" type="radio" :value="true" />同时删除 APP
              数据</label
            >
          </template>
          <label v-if="selectedAction === 'uninstall' && removeDataOnUninstall"
            ><input v-model="clearStyles" type="checkbox" />同时删除该 APP 的自定义样式</label
          >
          <p v-if="selectedAction === 'uninstall'">
            局部样式默认保留，重装后继续生效。勾选删除时会从所有外观预设移除该 APP 的局部 CSS；通用
            CSS 保留。
          </p>
          <p v-if="selectedAction === 'uninstall' && removeDataOnUninstall">
            将清除：{{
              OFFICIAL_APP_DATA_DESCRIPTION[selected]
            }}。本机删除后无法撤销，请先备份需要的内容。
          </p>
          <p v-else-if="selectedAction === 'uninstall'">重新安装后可继续使用原有数据。</p>
        </fieldset>
        <p v-if="actionError" role="alert">{{ actionError }}</p>
        <p v-if="busy" role="status">
          {{ selectedAction === 'clearData' ? '正在清理数据…' : '正在卸载…' }}
        </p>
        <footer>
          <button type="button" :disabled="busy" autofocus @click="cancelSelectedAction">
            取消
          </button>
          <button type="submit" :disabled="busy">
            {{
              selectedAction === 'clearData'
                ? '确认清理数据'
                : removeDataOnUninstall
                  ? '确认卸载并清除数据'
                  : '确认仅卸载 APP'
            }}
          </button>
        </footer>
      </form>
    </dialog>
  </Teleport>
</template>
<style scoped>
.official-app-manager {
  padding: 0.75rem;
}
.official-app-manager__help-trigger svg {
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.7;
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
li {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 0.55rem;
  padding: 0.65rem 0;
  border-bottom: 1px solid var(--color-line);
}
.official-app-manager__app-info {
  min-width: 0;
}
.official-app-manager__app-name {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 1rem;
}
.official-app-manager__select-update {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 44px;
  min-height: 44px;
  cursor: pointer;
}
.official-app-manager__select-update input {
  width: 1.125rem;
  height: 1.125rem;
  accent-color: var(--color-accent);
}
.official-app-manager__progress {
  margin-top: 0.3rem;
  overflow-wrap: anywhere;
  opacity: 1;
}
.official-app-manager__progress--failed {
  color: var(--color-danger);
}
small {
  display: block;
  font-size: 0.8125rem;
  opacity: 0.75;
}
.official-app-manager__versions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.2rem 1rem;
  margin-top: 0.25rem;
}
button {
  min-height: 44px;
  flex-shrink: 0;
  padding: 0.4rem 0.65rem;
}
.official-app-manager__update-dot {
  display: inline-block;
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--color-danger);
  vertical-align: middle;
}
.official-app-manager__update-version {
  color: var(--color-danger);
}
.official-app-manager__app-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 0.45rem;
}
.official-app-manager__latest {
  flex-shrink: 0;
  padding-inline: 0.35rem;
  font-size: 0.75rem;
  opacity: 0.75;
}
.official-app-manager__updates-dialog[open] {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  height: min(26rem, calc(100dvh - 2rem));
  max-height: calc(100dvh - max(1rem, var(--safe-top)) - max(1rem, var(--safe-bottom)));
  padding: 1.25rem;
  overflow: hidden;
}
.official-app-manager__updates-header,
.official-app-manager__updates-footer {
  flex: 0 0 auto;
}
.official-app-manager__updates-header h3 {
  margin: 0 0 0.45rem;
}
.official-app-manager__updates-header p {
  margin: 0.45rem 0 0;
  font-size: 0.875rem;
  line-height: 1.5;
}
.official-app-manager__updates-list {
  min-height: 0;
  flex: 1 1 auto;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.official-app-manager__updates-list li {
  align-items: flex-start;
  flex-direction: column;
}
.official-app-manager__updates-list small {
  margin-top: 0.2rem;
}
.official-app-manager__updates-actions,
.official-app-manager__updates-footer {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  justify-content: flex-end;
  width: 100%;
}
.official-app-manager__dialog {
  position: fixed;
  inset: max(1rem, var(--safe-top)) max(1rem, var(--safe-right)) max(1rem, var(--safe-bottom))
    max(1rem, var(--safe-left));
  margin: auto;
  width: min(26rem, calc(100% - max(1rem, var(--safe-left)) - max(1rem, var(--safe-right))));
  font: inherit;
}
.official-app-manager__dialog::backdrop {
  background: var(--overlay-background);
  backdrop-filter: blur(2px);
}
.official-app-manager__dialog fieldset {
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
.official-app-manager__dialog p {
  font-size: 0.875rem;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.official-app-manager__dialog [role='alert'] {
  color: var(--color-danger);
}
.official-app-manager__dialog footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}
.official-app-manager__dialog button {
  min-width: 0;
  flex-shrink: 1;
}
label {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  min-height: 44px;
}
</style>
