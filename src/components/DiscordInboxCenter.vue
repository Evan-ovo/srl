<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createAsyncPanel } from '../core/AsyncPanel'
import {
  SRL_BACK_REQUEST_EVENT,
  useBackStack,
  type SrlBackRequestDetail,
} from '../composables/UseBackStack'
import { useConfirmDialogState } from '../composables/UseConfirmDialog'
import { assistantGuidance } from '../core/ProductAssistantGuidance'
import FeatureShell from './FeatureShell.vue'
import DiscordInboxPanel from './DiscordInboxPanel.vue'
import DiscordResourceDownloadPanel from './DiscordResourceDownloadPanel.vue'
import DiscordPendingSources from './DiscordPendingSources.vue'
import DiscordNativeInboxMode from './DiscordNativeInboxMode.vue'
import type { ResourceSummary } from '../types/Resource'

type InboxSubpage = 'auto-binding-review' | 'pending-sources'

defineEmits<{ back: []; 'open-resource': [resource: ResourceSummary] }>()
const settingsOpen = ref(false)
const inboxPanel = ref<InstanceType<typeof DiscordInboxPanel> | null>(null)
const subpage = ref<InboxSubpage | null>(null)
const autoBindingReviewCount = ref<number | null>(null)
const autoBindingReviewHasMore = ref(false)
const pendingSourceCount = ref<number | null>(null)
const inboxTitle = computed(() =>
  subpage.value === 'auto-binding-review'
    ? '自动绑定审核'
    : subpage.value === 'pending-sources'
      ? '待整理来源'
      : '收件箱',
)
watch(
  assistantGuidance,
  (guide) => {
    if (
      guide?.destination === 'inbox' &&
      [
        'inbox-connection',
        'discord-oneclick-tutorial',
        'discord-github-tutorial',
        'discord-manual-deploy-tutorial',
      ].includes(guide.id)
    ) {
      settingsOpen.value = true
    }
  },
  { immediate: true },
)
const { activeDialog } = useConfirmDialogState()
function openSetupSettings() {
  settingsOpen.value = true
}
const backStack = useBackStack([
  {
    id: 'inbox-secondary-page',
    isActive: () => Boolean(subpage.value),
    back: () => {
      subpage.value = null
    },
  },
  {
    id: 'inbox-connection',
    isActive: () => settingsOpen.value,
    back: () => {
      settingsOpen.value = false
    },
  },
])
function closeSettingsOnEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || activeDialog.value || backStack.back() === 'none') return
  event.preventDefault()
  event.stopImmediatePropagation()
}
function closeSettingsOnBack(event: Event): void {
  const detail = (event as CustomEvent<SrlBackRequestDetail>).detail
  if (!detail || detail.handled || activeDialog.value || backStack.back() === 'none') return
  detail.handled = true
  event.stopImmediatePropagation()
}
onMounted(() => {
  window.addEventListener('srl:discord-setup-settings', openSetupSettings)
  window.addEventListener('keydown', closeSettingsOnEscape, true)
  window.addEventListener(SRL_BACK_REQUEST_EVENT, closeSettingsOnBack, true)
  window.addEventListener('srl:community-sources-changed', refreshOrganizationCounts)
})
onBeforeUnmount(() => {
  window.removeEventListener('srl:discord-setup-settings', openSetupSettings)
  window.removeEventListener('keydown', closeSettingsOnEscape, true)
  window.removeEventListener(SRL_BACK_REQUEST_EVENT, closeSettingsOnBack, true)
  window.removeEventListener('srl:community-sources-changed', refreshOrganizationCounts)
})
function refreshOrganizationCounts(): void {
  void inboxPanel.value?.refreshAutoBindings()
}
function updateOrganizationCounts(counts: {
  review: number
  reviewHasMore: boolean
  pending: number
}): void {
  autoBindingReviewCount.value = counts.review
  autoBindingReviewHasMore.value = counts.reviewHasMore
  pendingSourceCount.value = counts.pending
}
const ConnectionSettings = createAsyncPanel(
  'Discord 连接设置',
  () => import('./ResourceLinkAdvancedSettings.vue'),
)
</script>

<template>
  <FeatureShell :title="inboxTitle" @back="subpage ? (subpage = null) : $emit('back')">
    <template #actions>
      <button
        v-if="!subpage"
        class="feature-header-action feature-header-action--ghost"
        type="button"
        data-assistant-focus="inbox-connection-settings"
        @click="settingsOpen = true"
      >
        连接设置
      </button>
      <button
        v-if="!subpage"
        class="feature-header-action feature-header-action--icon"
        type="button"
        aria-label="清理云端"
        title="清理云端"
        data-assistant-focus="inbox-cloud-cleanup"
        @click="inboxPanel?.openCloudCleanup()"
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M4 7h16M9 7V4h6v3m-9 0 1 13h10l1-13M10 11v5m4-5v5"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1.7"
          />
        </svg>
      </button>
      <button
        v-if="!subpage"
        class="feature-header-action feature-header-action--icon"
        type="button"
        aria-label="收件箱设置"
        title="收件箱设置"
        data-assistant-focus="inbox-automation-settings"
        @click="inboxPanel?.openAutomationSettings()"
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M4 7h9m4 0h3M4 17h3m4 0h9M13 5v4M7 15v4"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1.7"
          />
          <circle cx="15" cy="7" r="2" stroke="currentColor" stroke-width="1.7" />
          <circle cx="9" cy="17" r="2" stroke="currentColor" stroke-width="1.7" />
        </svg>
      </button>
    </template>
    <div
      class="discord-inbox-center__content"
      :class="{ 'discord-inbox-center__content--subpage': subpage }"
    >
      <template v-if="!subpage">
        <section class="discord-inbox-center__group">
          <DiscordNativeInboxMode />
        </section>
        <section class="discord-inbox-center__group">
          <DiscordInboxPanel
            ref="inboxPanel"
            @organization-counts="updateOrganizationCounts"
            @open-resource="$emit('open-resource', $event)"
          />
        </section>
        <nav class="discord-inbox-center__secondary" aria-label="帖子整理">
          <button type="button" @click="subpage = 'auto-binding-review'">
            <span class="discord-inbox-center__label">自动绑定审核</span>
            <span
              v-if="autoBindingReviewCount !== null"
              class="discord-inbox-center__count"
              :aria-label="`${autoBindingReviewCount}${autoBindingReviewHasMore ? '+' : ''} 条`"
            >
              {{ autoBindingReviewCount }}{{ autoBindingReviewHasMore ? '+' : '' }}
            </span>
            <span aria-hidden="true">›</span>
          </button>
          <button type="button" @click="subpage = 'pending-sources'">
            <span class="discord-inbox-center__label">待整理来源</span>
            <span
              v-if="pendingSourceCount !== null"
              class="discord-inbox-center__count"
              :aria-label="`${pendingSourceCount} 条`"
            >
              {{ pendingSourceCount }}
            </span>
            <span aria-hidden="true">›</span>
          </button>
        </nav>
        <section class="discord-inbox-center__group">
          <DiscordResourceDownloadPanel />
        </section>
      </template>
      <DiscordInboxPanel
        v-else-if="subpage === 'auto-binding-review'"
        view="review"
        @open-resource="$emit('open-resource', $event)"
      />
      <DiscordPendingSources v-else page-view />
    </div>
  </FeatureShell>
  <ConnectionSettings
    v-if="settingsOpen"
    title="Discord 连接设置"
    back-label="返回收件箱"
    @close="settingsOpen = false"
  />
</template>

<style scoped>
.discord-inbox-center__content {
  box-sizing: border-box;
  width: 100%;
  max-width: 52rem;
  margin: 16px auto 0;
  padding: 0 16px;
  border: 1px solid var(--color-line);
  border-radius: var(--glass-radius-panel);
  background: var(--color-surface-raised);
}

.discord-inbox-center__content--subpage {
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
}

.discord-inbox-center__secondary {
  display: grid;
  gap: 8px;
  padding: 16px 0;
  border-top: 1px solid var(--color-line);
}

.discord-inbox-center__group {
  padding: 16px 0;
}

.discord-inbox-center__group + .discord-inbox-center__group {
  border-top: 1px solid var(--color-line);
}

.discord-inbox-center__secondary button {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 50px;
  padding: 9px 14px;
  text-align: left;
  font: inherit;
  cursor: pointer;
}

.discord-inbox-center__secondary button span:first-child {
  flex: 1;
  font-weight: 650;
}

.discord-inbox-center__secondary .discord-inbox-center__count {
  min-width: 1.75em;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--color-accent-soft);
  color: var(--color-accent);
  font-size: 0.82em;
  font-weight: 700;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
</style>
