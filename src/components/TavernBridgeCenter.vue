<script setup lang="ts">
import { watch } from 'vue'
import { useDeviceRelayStatus } from '../services/RelayWorkerSettingsService'

import { assistantGuidance } from '../core/ProductAssistantGuidance'
import FeatureAppHeader from './FeatureAppHeader.vue'
import FeatureBackButton from './FeatureBackButton.vue'
import TavernBridgeInstallGuide from './TavernBridgeInstallGuide.vue'
import TavernParcelExchange from './TavernParcelExchange.vue'
import { formatBytes } from '../utils/LibraryFormatting'
import {
  useTavernBridgeCenter,
  type TavernBridgeCenterProps,
  type TavernBridgeCenterEvents,
} from '../composables/UseTavernBridgeCenter'
const props = withDefaults(defineProps<TavernBridgeCenterProps>(), {
  categories: () => [],
  initialLocalIds: () => [],
})
const emit = defineEmits<TavernBridgeCenterEvents>()
const deviceRelayStatus = useDeviceRelayStatus()
const {
  state,
  busy,
  sendContent,
  setSendContent,
  includeChatScripts,
  saveChatCarryScripts,
  transferSettingsDialog,
  openTransferSettings,
  canCancelTransfer,
  cancelTransfer,
  canBindDirectory,
  bindDirectory,
  acceptPairing,
  canShowDeviceJoin,
  joinDeviceRelay,
  deviceCode,
  canUseLocalTavernHost,
  connectLocalTavern,
  installGuideOpen,
  error,
  progress,
  localDirectEnabled,
  setLocalDirectEnabled,
  localDirectAvailable,
  LOCAL_DIRECT_BRIDGE_EXTENSION_VERSION,
  refreshTavernResources,
  disconnectTavern,
  activeDirection,
  bridgeDiffSummary,
  selectSyncEntries,
  showOnlyMissingTavern,
  showOnlyMissingLocal,
  tavernReceiveFilters,
  tavernReceiveFilter,
  selectTavernReceiveFilter,
  tavernSearch,
  visibleTavernItems,
  pagedVisibleTavernItems,
  tavernPage,
  tavernPageCount,
  selectAllTavern,
  selectedTavernIds,
  showOnlySelectedTavern,
  toggleSelection,
  tavernResourceLabel,
  itemExistsLocally,
  pullFromTavern,
  localSendFilters,
  localSendFilter,
  search,
  bridgeFolderFilter,
  bridgeTagFilter,
  bridgeTagOptions,
  bridgeFavoritesOnly,
  selectAllLocal,
  selectedLocalIds,
  filteredLocalResources,
  pagedFilteredLocalResources,
  localPage,
  localPageCount,
  tavernItems,
  showOnlySelectedLocal,
  resourceLabel,
  resourceExistsInTavern,
  conflictPolicy,
  personaAvatarMode,
  includeChatRegex,
  selectedChatCount,
  selectedPersonaCount,
  canCheckPersonaAvatars,
  sendConflictCount,
  sendToTavern,
  reports,
  transferQueue,
  failedTransferKeys,
  retryFailedTransfers,
  openAuthorTools,
  authorToolsDialog,
  closeAuthorTools,
  AUTHOR_TOOLS,
  showAuthorToolDetails,
  selectedAuthorTool,
  copyAuthorToolRepository,
  copiedAuthorToolId,
} = useTavernBridgeCenter(props, emit)

watch(
  assistantGuidance,
  (guide) => {
    if (guide?.id === 'tavern-transfer-install' && guide.destination === 'tavernBridge') {
      installGuideOpen.value = true
    }
  },
  { immediate: true },
)
</script>

<template>
  <section class="tavern-bridge" data-srl-controls aria-labelledby="tavern-bridge-title">
    <FeatureAppHeader
      title="酒馆互传"
      title-id="tavern-bridge-title"
      :back-label="initialKind === 'userPersona' ? '返回人设列表' : '返回功能桌面'"
      @back="emit('back')"
    >
      <template #actions>
        <button
          type="button"
          class="feature-header-action feature-header-action--icon"
          aria-label="酒馆互传设置"
          aria-haspopup="dialog"
          :title="sendContent === 'original' ? '发送原版' : '发送修改版'"
          :disabled="busy"
          @click="openTransferSettings"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            aria-hidden="true"
          >
            <path
              d="m9.5 3-.5 2-2 .8-1.8-1-2.5 4.4 1.7 1.3v2.4l-1.7 1.3 2.5 4.4 1.8-1 2 .8.5 2h5l.5-2 2-.8 1.8 1 2.5-4.4-1.7-1.3v-2.4l1.7-1.3-2.5-4.4-1.8 1-2-.8-.5-2z"
            />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
      </template>
    </FeatureAppHeader>

    <section v-if="state.status !== 'connected'" class="tavern-bridge-pairing">
      <header class="tavern-bridge-pairing__heading">
        <div>
          <strong>{{ state.status === 'pairing' ? '核对配对码' : '连接酒馆' }}</strong>
          <span class="tavern-bridge-pairing__status" :data-status="state.status">
            {{ state.status === 'pairing' ? '待确认' : '未连接' }}
          </span>
        </div>
        <p>{{ state.detail }}</p>
      </header>

      <section v-if="state.status === 'pairing'" class="tavern-bridge-pairing__code">
        <span>配对码</span>
        <code v-if="state.pairCode">{{ state.pairCode }}</code>
        <small v-if="state.tavernOrigin">来源：{{ state.tavernOrigin }}</small>
        <button
          class="tavern-bridge__primary"
          type="button"
          :disabled="busy"
          data-assistant-focus="tavern-transfer-entry"
          data-assistant-focus-text="核对配对码后，点这里连接酒馆哦～"
          @click="acceptPairing"
        >
          数字一致，允许本次连接
        </button>
      </section>

      <template v-else>
        <form v-if="canShowDeviceJoin" class="tavern-device-join" @submit.prevent="joinDeviceRelay">
          <label>
            <span>酒馆设备码</span>
            <input
              v-model="deviceCode"
              class="tavern-device-join__code"
              type="text"
              autocomplete="one-time-code"
              autocapitalize="characters"
              maxlength="8"
              placeholder="AB23CD45"
              :disabled="!deviceRelayStatus.enabled || busy"
            />
          </label>
          <button
            class="tavern-bridge__primary"
            type="submit"
            :disabled="busy"
            :data-relay-enabled="deviceRelayStatus.enabled"
            data-assistant-focus="tavern-transfer-entry"
            data-assistant-focus-text="点这里连接酒馆，再把资源发送过去哦～"
          >
            {{ busy ? '正在连接' : deviceRelayStatus.enabled ? '连接酒馆' : '中继码未开启' }}
          </button>
          <small>在酒馆扩展生成八位设备码，两分钟内输入。</small>
        </form>

        <section v-if="canUseLocalTavernHost" class="tavern-local-connect">
          <div>
            <strong>同一台手机上的酒馆</strong>
            <p>不需要设备码，在酒馆扩展确认一次即可。</p>
          </div>
          <button
            type="button"
            :disabled="busy"
            data-assistant-focus="tavern-transfer-entry"
            data-assistant-focus-text="同一台设备可以从这里直连酒馆哦～"
            @click="connectLocalTavern"
          >
            {{ busy ? '连接中' : '直连' }}
          </button>
        </section>

        <details v-if="canBindDirectory" class="tavern-directory-guide">
          <summary>
            <span
              ><strong>直接读写酒馆文件夹</strong><small>不用启动酒馆 · 下次打开生效</small></span
            ><span aria-hidden="true">⌄</span>
          </summary>
          <div>
            <p>选择酒馆根目录或 data 文件夹，会自动定位唯一用户；找到多个用户时会提示你重选。</p>
            <ol>
              <li>
                <strong>电脑：</strong>右键酒馆启动快捷方式 → 打开文件所在位置，找到
                <code>SillyTavern/data/default-user</code>。
              </li>
              <li>
                <strong>安卓 Termux：</strong>文件选择器左侧菜单 → Termux →
                <code>SillyTavern/data/default-user</code>。多用户请选择自己的用户文件夹。
              </li>
              <li>
                <strong>核对：</strong>同一层应有 <code>settings.json</code> 和
                <code>characters</code> 文件夹。
              </li>
            </ol>
            <p>
              看不到 Termux
              或目录不可选时，表示当前安装方式没有向文件选择器开放目录，请使用上面的在线互传；不要复制或移动整个酒馆来绕过权限。
            </p>
            <p>写入前完全关闭酒馆，避免它用内存中的旧设置覆盖文件。不会自动同步或联动删除。</p>
            <div class="tavern-directory-guide__actions">
              <button type="button" :disabled="busy" @click="bindDirectory()">
                选择 / 继续使用目录</button
              ><button type="button" :disabled="busy" @click="bindDirectory(false)">重选</button>
            </div>
          </div>
        </details>

        <button
          v-if="canShowDeviceJoin"
          class="tavern-bridge-help-toggle"
          type="button"
          :aria-expanded="installGuideOpen"
          @click="installGuideOpen = !installGuideOpen"
        >
          <span>连接帮助</span>
          <span>{{ installGuideOpen ? '收起' : '查看' }}</span>
        </button>

        <TavernBridgeInstallGuide v-if="canShowDeviceJoin && installGuideOpen" />
      </template>

      <div v-if="error || progress" class="tavern-bridge-inline-report" aria-live="polite">
        <p v-if="error" role="alert">{{ error }}</p>
        <strong v-else>{{ progress }}</strong>
      </div>
    </section>

    <template v-else>
      <section class="tavern-bridge-connected-summary" aria-label="连接状态">
        <span>
          <i aria-hidden="true"></i>
          <strong>{{ state.transport === 'directory' ? '已绑定酒馆目录' : '已连接酒馆' }}</strong>
        </span>
        <small>{{ state.detail }}</small>
        <details class="tavern-bridge-connection-tools">
          <summary>连接管理</summary>
          <div>
            <label
              v-if="canUseLocalTavernHost && state.transport !== 'directory'"
              class="tavern-bridge-local-direct"
            >
              <input v-model="localDirectEnabled" type="checkbox" @change="setLocalDirectEnabled" />
              <span>
                <strong>本机酒馆直传</strong>
                <small v-if="localDirectAvailable">文件经本机传输；失败时回退设备码。</small>
                <small v-else
                  >需酒馆互传扩展 {{ LOCAL_DIRECT_BRIDGE_EXTENSION_VERSION }} 或更新版本。</small
                >
              </span>
            </label>
            <p>连接与已读取的目录在当前资源库会话中保持；需要最新内容时可在酒馆资源处刷新目录。</p>
            <button type="button" @click="disconnectTavern">断开连接</button>
          </div>
        </details>
      </section>
      <nav class="tavern-bridge-tabs" aria-label="传输方向">
        <button
          type="button"
          :class="{ 'is-active': activeDirection === 'fromTavern' }"
          :aria-current="activeDirection === 'fromTavern' ? 'page' : undefined"
          @click="activeDirection = 'fromTavern'"
        >
          <strong>从酒馆取回</strong>
        </button>
        <button
          type="button"
          :class="{ 'is-active': activeDirection === 'toTavern' }"
          :aria-current="activeDirection === 'toTavern' ? 'page' : undefined"
          data-assistant-focus="tavern-transfer-entry"
          data-assistant-focus-text="点这里切到发送到酒馆，再选择要传的内容哦～"
          @click="activeDirection = 'toTavern'"
        >
          <strong>发送到酒馆</strong>
        </button>
      </nav>

      <details v-if="bridgeDiffSummary" class="tavern-bridge-diff" aria-label="两端差异总览">
        <summary>
          <strong>两端差异</strong>
          <span
            >酒馆独有 {{ bridgeDiffSummary.tavernOnly }} · 本地独有
            {{ bridgeDiffSummary.localOnly }}</span
          >
        </summary>
        <div class="tavern-bridge-diff__actions">
          <button
            type="button"
            :disabled="!bridgeDiffSummary.tavernOnly"
            @click="
              () => {
                selectSyncEntries('fromTavern', ['tavern-only'])
                showOnlyMissingTavern = true
              }
            "
          >
            <strong>{{ bridgeDiffSummary.tavernOnly }}</strong>
            <span>酒馆独有</span>
          </button>
          <button
            type="button"
            :disabled="!bridgeDiffSummary.localOnly"
            @click="
              () => {
                selectSyncEntries('toTavern', ['local-only'])
                showOnlyMissingLocal = true
              }
            "
          >
            <strong>{{ bridgeDiffSummary.localOnly }}</strong>
            <span>本地独有</span>
          </button>
          <button
            type="button"
            :disabled="!bridgeDiffSummary.localNewer"
            @click="selectSyncEntries('toTavern', ['local-newer'])"
          >
            <strong>{{ bridgeDiffSummary.localNewer }}</strong>
            <span>本地较新</span>
          </button>
          <button
            type="button"
            :disabled="!bridgeDiffSummary.tavernNewer"
            @click="selectSyncEntries('fromTavern', ['tavern-newer'])"
          >
            <strong>{{ bridgeDiffSummary.tavernNewer }}</strong>
            <span>酒馆较新</span>
          </button>
          <small>
            {{ bridgeDiffSummary.consistent }} 项一致
            <template v-if="bridgeDiffSummary.unverified">
              · {{ bridgeDiffSummary.unverified }} 项待复核</template
            >
          </small>
        </div>
      </details>

      <section v-if="activeDirection === 'fromTavern'" class="tavern-bridge-workspace">
        <header>
          <div>
            <h2>酒馆资源</h2>
          </div>
          <button
            type="button"
            :disabled="busy"
            @click="refreshTavernResources(tavernReceiveFilter === 'chat' ? 'chat' : undefined)"
          >
            {{ tavernReceiveFilter === 'chat' ? '重新读取聊天记录' : '刷新目录' }}
          </button>
        </header>
        <div class="tavern-bridge-explorer">
          <div class="tavern-bridge-type-filter" aria-label="酒馆资源类型筛选">
            <button
              v-for="filter in tavernReceiveFilters"
              :key="filter.key"
              type="button"
              :class="{ 'is-active': tavernReceiveFilter === filter.key }"
              @click="selectTavernReceiveFilter(filter.key)"
            >
              <span>{{ filter.label }}</span>
              <small>{{ filter.count }}</small>
            </button>
          </div>
          <label class="tavern-bridge-search">
            <span aria-hidden="true">⌕</span>
            <input v-model="tavernSearch" type="search" placeholder="搜索酒馆资源" />
          </label>
          <div class="tavern-bridge-selectbar">
            <button
              type="button"
              :disabled="busy || !visibleTavernItems.length"
              @click="selectAllTavern"
            >
              {{
                visibleTavernItems.length &&
                visibleTavernItems.every((item) => selectedTavernIds.has(item.id))
                  ? '取消当前全选'
                  : '全选当前分类'
              }}
            </button>
            <span
              >当前 {{ visibleTavernItems.length }} 项 · 已选 {{ selectedTavernIds.size }} 项</span
            >
            <div class="tavern-bridge-filter-actions">
              <label class="tavern-bridge-missing-toggle">
                <input v-model="showOnlyMissingTavern" type="checkbox" />
                <span>只看库中缺少的</span>
              </label>
              <button
                type="button"
                :class="{ 'is-active': showOnlySelectedTavern }"
                :aria-pressed="showOnlySelectedTavern"
                @click="showOnlySelectedTavern = !showOnlySelectedTavern"
              >
                只看已选 <small>{{ selectedTavernIds.size }}</small>
              </button>
            </div>
          </div>
        </div>
        <div class="tavern-bridge-resource-grid">
          <button
            v-for="item in pagedVisibleTavernItems"
            :key="item.id"
            type="button"
            class="tavern-bridge-resource-card"
            :class="{
              'is-selected': selectedTavernIds.has(item.id),
              'is-chat': item.kind === 'chat',
            }"
            :aria-pressed="selectedTavernIds.has(item.id)"
            :disabled="busy"
            @click="toggleSelection('tavern', item.id)"
          >
            <i aria-hidden="true"></i>
            <span class="tavern-bridge-resource-card__body"
              ><strong>{{ item.name }}</strong
              ><small>{{ item.kind === 'chat' ? item.detail : item.fileName }}</small></span
            >
            <span class="tavern-bridge-resource-card__meta">
              <em>{{ tavernResourceLabel(item.kind) }}</em>
              <small class="tavern-bridge-file-size">{{
                typeof item.size === 'number' && Number.isFinite(item.size) && item.size >= 0
                  ? formatBytes(item.size)
                  : item.sizeLabel || '酒馆未提供大小'
              }}</small>
              <em v-if="itemExistsLocally(item)" class="tavern-bridge-exists">可能已在库中</em>
            </span>
          </button>
          <p v-if="!visibleTavernItems.length" class="tavern-bridge-empty">
            当前分类没有匹配资源，请切换分类或清除搜索。
          </p>
        </div>
        <nav v-if="tavernPageCount > 1" class="tavern-bridge-pagination" aria-label="酒馆资源分页">
          <button type="button" :disabled="busy || tavernPage <= 1" @click="tavernPage -= 1">
            <span aria-hidden="true">‹</span> 上一页
          </button>
          <span class="tavern-bridge-page-indicator"
            >第 {{ tavernPage }} / {{ tavernPageCount }} 页</span
          >
          <button
            type="button"
            :disabled="busy || tavernPage >= tavernPageCount"
            @click="tavernPage += 1"
          >
            下一页 <span aria-hidden="true">›</span>
          </button>
        </nav>
        <button
          class="tavern-bridge__primary tavern-bridge__sticky-action"
          type="button"
          :disabled="busy || !selectedTavernIds.size"
          @click="pullFromTavern"
        >
          <span>{{ busy ? '正在接收…' : `取回 ${selectedTavernIds.size} 项到资源库` }}</span>
        </button>
      </section>

      <section v-else class="tavern-bridge-workspace">
        <header>
          <div>
            <h2>本地资源</h2>
          </div>
        </header>
        <div class="tavern-bridge-type-filter" aria-label="本地资源类型筛选">
          <button
            v-for="filter in localSendFilters"
            :key="filter.key"
            type="button"
            :class="{ 'is-active': localSendFilter === filter.key }"
            @click="localSendFilter = filter.key"
          >
            <span>{{ filter.label }}</span>
            <small>{{ filter.count }}</small>
          </button>
        </div>
        <label class="tavern-bridge-search">
          <span aria-hidden="true">⌕</span>
          <input v-model="search" type="search" placeholder="搜索名称或文件名" />
        </label>
        <div class="tavern-bridge-library-filter" aria-label="按库内整理筛选">
          <select v-model="bridgeFolderFilter" aria-label="按文件夹筛选">
            <option value="">全部文件夹</option>
            <option v-for="category in props.categories" :key="category.id" :value="category.id">
              {{ category.name }}
            </option>
          </select>
          <select v-model="bridgeTagFilter" aria-label="按标签筛选">
            <option value="">全部标签</option>
            <option v-for="tag in bridgeTagOptions" :key="tag" :value="tag">{{ tag }}</option>
          </select>
          <label class="tavern-bridge-missing-toggle">
            <input v-model="bridgeFavoritesOnly" type="checkbox" />
            <span>只看收藏</span>
          </label>
        </div>
        <div class="tavern-bridge-selectbar">
          <button
            type="button"
            :disabled="busy || !filteredLocalResources.length"
            @click="selectAllLocal"
          >
            {{
              filteredLocalResources.length &&
              filteredLocalResources.every((resource) => selectedLocalIds.has(resource.id))
                ? '取消当前全选'
                : '全选当前结果'
            }}
          </button>
          <span>已选 {{ selectedLocalIds.size }} / {{ filteredLocalResources.length }}</span>
          <div class="tavern-bridge-filter-actions">
            <label v-if="tavernItems.length" class="tavern-bridge-missing-toggle">
              <input v-model="showOnlyMissingLocal" type="checkbox" />
              <span>只看酒馆缺少的</span>
            </label>
            <button
              type="button"
              :class="{ 'is-active': showOnlySelectedLocal }"
              :aria-pressed="showOnlySelectedLocal"
              @click="showOnlySelectedLocal = !showOnlySelectedLocal"
            >
              只看已选 <small>{{ selectedLocalIds.size }}</small>
            </button>
          </div>
        </div>
        <details class="tavern-bridge-send-options">
          <summary>
            <strong>发送设置</strong>
            <span>
              同名{{
                conflictPolicy === 'copy' ? '保留副本' : conflictPolicy === 'skip' ? '跳过' : '覆盖'
              }}
              <template v-if="selectedPersonaCount">
                ·
                {{
                  personaAvatarMode === 'none'
                    ? '只传人设'
                    : personaAvatarMode === 'missing'
                      ? '补传封面'
                      : '替换封面'
                }}
              </template>
            </span>
          </summary>
          <div class="tavern-bridge-send-options__body">
            <fieldset v-if="selectedChatCount" class="tavern-bridge-conflicts">
              <legend>聊天记录导入</legend>
              <label
                ><input
                  v-model="includeChatRegex"
                  type="radio"
                  :value="false"
                  :disabled="busy"
                /><span
                  ><strong>只导入聊天记录</strong
                  ><small>默认，使用酒馆已有正则；始终保留聊天副本</small></span
                ></label
              >
              <label
                ><input
                  v-model="includeChatRegex"
                  type="radio"
                  :value="true"
                  :disabled="busy"
                /><span
                  ><strong>同时导入配套正则</strong
                  ><small>添加到目标角色并保持停用，随后在酒馆选择启用</small></span
                ></label
              >
            </fieldset>
            <fieldset class="tavern-bridge-conflicts">
              <legend>{{ selectedPersonaCount ? '人设同名时' : '资源同名时' }}</legend>
              <label
                ><input
                  v-model="conflictPolicy"
                  type="radio"
                  value="copy"
                  :disabled="busy || !!selectedPersonaCount"
                /><span
                  ><strong>保留副本</strong
                  ><small>{{
                    selectedPersonaCount ? '人设不支持同名副本' : '推荐，不改动酒馆原资源'
                  }}</small></span
                ></label
              >
              <label
                ><input v-model="conflictPolicy" type="radio" value="skip" :disabled="busy" /><span
                  ><strong>跳过同名</strong
                  ><small>{{
                    selectedPersonaCount ? '人设有改动时可选择另存一份' : '只发送酒馆里没有的资源'
                  }}</small></span
                ></label
              >
              <label
                ><input
                  v-model="conflictPolicy"
                  type="radio"
                  value="overwrite"
                  :disabled="busy"
                /><span><strong>覆盖同名</strong><small>发送前会再次确认</small></span></label
              >
            </fieldset>
            <fieldset
              v-if="selectedPersonaCount"
              class="tavern-bridge-conflicts tavern-bridge-avatar-options"
            >
              <legend>默认封面 · 可选</legend>
              <label
                ><input
                  v-model="personaAvatarMode"
                  type="radio"
                  value="none"
                  :disabled="busy"
                /><span
                  ><strong>只传人设</strong><small>不传封面；酒馆缺头像时生成默认图</small></span
                ></label
              >
              <label :class="{ 'is-disabled': !canCheckPersonaAvatars }"
                ><input
                  v-model="personaAvatarMode"
                  type="radio"
                  value="missing"
                  :disabled="busy || !canCheckPersonaAvatars"
                /><span
                  ><strong>补传缺少的封面</strong
                  ><small>默认；无缓存封面时只传人设，同名头像保留原图</small></span
                ></label
              >
              <label :class="{ 'is-disabled': !canCheckPersonaAvatars }"
                ><input
                  v-model="personaAvatarMode"
                  type="radio"
                  value="replace"
                  :disabled="busy || !canCheckPersonaAvatars"
                /><span><strong>替换同名封面</strong><small>逐项核对后确认覆盖</small></span></label
              >
              <p v-if="!canCheckPersonaAvatars" class="tavern-bridge-avatar-options__note">
                传送封面需要更新酒馆互传扩展；当前仍可只传人设。
              </p>
              <p v-else class="tavern-bridge-avatar-options__note">
                仅处理已缓存的默认人设封面；发送前核对文件名和酒馆现状。封面策略与人设同名策略相互独立。
              </p>
            </fieldset>
          </div>
        </details>
        <p v-if="sendConflictCount" class="tavern-bridge-conflict-note" role="status">
          所选中有 {{ sendConflictCount }} 项与酒馆同名：{{
            conflictPolicy === 'copy'
              ? '将以副本名发送，不改动酒馆原资源'
              : conflictPolicy === 'skip'
                ? selectedPersonaCount
                  ? '人设会先核对内容；有改动时可选择另存，其他同名项跳过'
                  : '这些项将被跳过'
                : '这些项将覆盖酒馆中的同名资源'
          }}。
        </p>
        <div class="tavern-bridge-resource-grid">
          <button
            v-for="resource in pagedFilteredLocalResources"
            :key="resource.id"
            type="button"
            class="tavern-bridge-resource-card"
            :class="{ 'is-selected': selectedLocalIds.has(resource.id) }"
            :aria-pressed="selectedLocalIds.has(resource.id)"
            :disabled="busy"
            @click="toggleSelection('local', resource.id)"
          >
            <i aria-hidden="true"></i>
            <span class="tavern-bridge-resource-card__body"
              ><strong>{{ resource.name }}</strong
              ><small>{{ resource.fileName }}</small></span
            >
            <span class="tavern-bridge-resource-card__meta">
              <em>{{ resourceLabel(resource) }}</em>
              <small class="tavern-bridge-file-size">{{
                Number.isFinite(resource.fileSize) && resource.fileSize >= 0
                  ? formatBytes(resource.fileSize)
                  : '大小未知'
              }}</small>
              <em v-if="resourceExistsInTavern(resource)" class="tavern-bridge-exists"
                >酒馆可能已有</em
              >
            </span>
          </button>
          <p v-if="!filteredLocalResources.length" class="tavern-bridge-empty">
            当前筛选没有可发送资源，请切换分类或清除筛选。
          </p>
        </div>
        <nav v-if="localPageCount > 1" class="tavern-bridge-pagination" aria-label="本地资源分页">
          <button type="button" :disabled="busy || localPage <= 1" @click="localPage -= 1">
            <span aria-hidden="true">‹</span> 上一页
          </button>
          <span class="tavern-bridge-page-indicator"
            >第 {{ localPage }} / {{ localPageCount }} 页</span
          >
          <button
            type="button"
            :disabled="busy || localPage >= localPageCount"
            @click="localPage += 1"
          >
            下一页 <span aria-hidden="true">›</span>
          </button>
        </nav>
        <button
          class="tavern-bridge__primary tavern-bridge__sticky-action"
          type="button"
          :disabled="busy || !selectedLocalIds.size"
          @click="sendToTavern"
        >
          <span>{{ busy ? '正在发送…' : `发送 ${selectedLocalIds.size} 项到酒馆` }}</span>
        </button>
      </section>

      <aside
        v-if="progress || error || reports.length"
        class="tavern-bridge-report"
        aria-live="polite"
      >
        <p v-if="error" role="alert">{{ error }}</p>
        <strong v-else-if="progress">{{ progress }}</strong>
        <button
          v-if="busy && canCancelTransfer"
          class="tavern-bridge-cancel"
          type="button"
          @click="cancelTransfer"
        >
          停止当前传输
        </button>
        <ul v-if="transferQueue.length" class="tavern-bridge-queue">
          <li v-for="item in transferQueue" :key="item.key" :data-status="item.status">
            <i aria-hidden="true"></i>
            <span
              ><strong>{{ item.label }} · {{ item.name }}</strong
              ><small v-if="item.detail">{{ item.detail }}</small></span
            >
            <em>{{
              item.status === 'pending'
                ? '等待'
                : item.status === 'active'
                  ? '进行中'
                  : item.status === 'done'
                    ? '完成'
                    : '失败 / 未完成'
            }}</em>
          </li>
        </ul>
        <button
          v-if="failedTransferKeys.length && !busy"
          class="tavern-bridge-retry"
          type="button"
          @click="retryFailedTransfers"
        >
          重试 {{ failedTransferKeys.length }} 个失败或未完成项
        </button>
        <ol v-if="reports.length">
          <li v-for="item in reports.slice(0, 5)" :key="item">{{ item }}</li>
        </ol>
        <small v-if="reports.length" class="tavern-bridge-report-hint"
          >最近 {{ reports.length }} 条记录会跨会话保留</small
        >
      </aside>
    </template>
    <TavernParcelExchange
      :resources="resources"
      :send-content="sendContent"
      :include-chat-scripts="includeChatScripts"
      :initial-ids="initialLocalIds"
      @import-files="(files, onComplete) => emit('import-files', files, onComplete)"
    />
    <section
      v-if="!initialKind"
      class="tavern-bridge-author-tools"
      aria-labelledby="author-tools-title"
    >
      <div>
        <h2 id="author-tools-title">作者的其他小工具</h2>
      </div>
      <button type="button" @click="openAuthorTools">查看其他小工具</button>
    </section>

    <Teleport to="body">
      <dialog
        ref="transferSettingsDialog"
        class="tavern-transfer-settings"
        data-srl-controls
        aria-labelledby="tavern-transfer-settings-title"
        @click.self="transferSettingsDialog?.close()"
        @cancel.prevent="transferSettingsDialog?.close()"
      >
        <header>
          <h2 id="tavern-transfer-settings-title">互传设置</h2>
          <button type="button" aria-label="关闭互传设置" @click="transferSettingsDialog?.close()">
            ×
          </button>
        </header>
        <div class="tavern-transfer-settings__body">
          <div class="tavern-transfer-settings__setting">
            <label class="tavern-transfer-settings__row"
              ><span>聊天记录互传携带脚本</span
              ><input
                v-model="includeChatScripts"
                type="checkbox"
                role="switch"
                aria-label="聊天记录互传携带脚本"
                :disabled="busy"
                @change="saveChatCarryScripts"
            /></label>
            <p>仅携带角色脚本，随聊天资料保存；全局和预设脚本请自行添加。读了么默认不运行。</p>
          </div>
          <div class="tavern-transfer-settings__setting">
            <div class="tavern-transfer-settings__row">
              <span id="tavern-send-version-label">酒馆互传版本</span>
              <div
                class="tavern-transfer-settings__versions"
                role="group"
                aria-labelledby="tavern-send-version-label"
              >
                <button
                  v-for="option in ['original', 'modified'] as const"
                  :key="option"
                  type="button"
                  :aria-pressed="sendContent === option"
                  :disabled="busy"
                  @click="setSendContent(option)"
                >
                  {{ option === 'original' ? '原版' : '修改版' }}
                </button>
              </div>
            </div>
            <p>
              {{
                sendContent === 'original' ? '发送未修改的原文件' : '使用已保存的名称、内容与封面'
              }}
            </p>
          </div>
          <p v-if="error" role="alert">{{ error }}</p>
        </div>
      </dialog>

      <div
        v-if="authorToolsDialog"
        class="author-tools-dialog"
        role="presentation"
        tabindex="-1"
        @click.self="closeAuthorTools"
        @keydown.esc="closeAuthorTools"
      >
        <section
          v-if="authorToolsDialog === 'list'"
          class="author-tools-dialog__sheet"
          role="dialog"
          aria-modal="true"
          aria-labelledby="author-tools-dialog-title"
        >
          <header class="author-tools-dialog__header">
            <div>
              <small>AUTHOR TOOLBOX</small>
              <h2 id="author-tools-dialog-title">作者的其他小工具</h2>
            </div>
            <button type="button" aria-label="关闭" @click="closeAuthorTools">×</button>
          </header>
          <p class="author-tools-dialog__intro">
            每个项目独立维护与发布，点击后查看具体用途和仓库地址。
          </p>
          <ol class="author-tools-dialog__list">
            <li v-for="tool in AUTHOR_TOOLS" :key="tool.id">
              <small>{{ tool.eyebrow }}</small>
              <h3>{{ tool.name }}</h3>
              <p>{{ tool.summary }}</p>
              <button type="button" @click="showAuthorToolDetails(tool.id)">查看详情</button>
            </li>
          </ol>
        </section>

        <section
          v-else-if="selectedAuthorTool"
          class="author-tools-dialog__sheet"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="`author-tool-${selectedAuthorTool.id}-title`"
        >
          <header class="author-tools-dialog__header">
            <FeatureBackButton
              class="author-tools-dialog__back"
              label="返回小工具列表"
              @click="authorToolsDialog = 'list'"
            />
            <button type="button" aria-label="关闭" @click="closeAuthorTools">×</button>
          </header>
          <article class="author-tool-detail">
            <small>{{ selectedAuthorTool.eyebrow }}</small>
            <h2 :id="`author-tool-${selectedAuthorTool.id}-title`">
              {{ selectedAuthorTool.name }}
            </h2>
            <p class="author-tool-detail__summary">{{ selectedAuthorTool.summary }}</p>
            <ul>
              <li v-for="detail in selectedAuthorTool.details" :key="detail">{{ detail }}</li>
            </ul>
            <label>GitHub 项目地址</label>
            <code>{{ selectedAuthorTool.repository }}</code>
            <div class="author-tool-detail__actions">
              <a :href="selectedAuthorTool.repository" target="_blank" rel="noreferrer"
                >打开 GitHub</a
              >
              <button type="button" @click="copyAuthorToolRepository(selectedAuthorTool)">
                {{ copiedAuthorToolId === selectedAuthorTool.id ? '已复制地址' : '一键复制地址' }}
              </button>
            </div>
          </article>
        </section>
      </div>
    </Teleport>
  </section>
</template>

<style scoped src="../styles/TavernBridgeCenter.css"></style>
