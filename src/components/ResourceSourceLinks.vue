<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import { useTransientStatus } from '../composables/UseTransientStatus'
import {
  analyzeResourceLink,
  RESOURCE_INSTALL_TARGET,
  RESOURCE_LINK_PURPOSE,
  RESOURCE_LINK_TRUST_MODE,
  RESOURCE_LINK_TYPE,
  type ResourceLink,
  type ResourceLinkType,
} from '../types/Resource'
import DiscordCommunitySources from './DiscordCommunitySources.vue'
import ResourceLinkAdvancedSettings from './ResourceLinkAdvancedSettings.vue'
import ResourceLinkRow from './ResourceLinkRow.vue'

type PlatformGroupId = 'discord' | 'github' | 'other'

const props = defineProps<{ resourceId: string }>()
const links = defineModel<ResourceLink[]>('links', { required: true })

const advancedOpen = ref(false)
const openPlatforms = ref(new Set<PlatformGroupId>())
const discordManualOpen = ref(false)
const discordCommunityCount = ref(0)
const communityRevision = ref(0)
const addSourceOpen = ref(false)
const addSourceUrl = ref('')
const addSourceError = ref('')
const { statusMessage, showTransientStatus } = useTransientStatus()

const discordLinks = computed(() =>
  links.value.filter((link) => link.type === RESOURCE_LINK_TYPE.DISCORD),
)
const githubLinks = computed(() =>
  links.value.filter((link) => link.type === RESOURCE_LINK_TYPE.GITHUB),
)
const otherLinks = computed(() =>
  links.value.filter(
    (link) => link.type !== RESOURCE_LINK_TYPE.DISCORD && link.type !== RESOURCE_LINK_TYPE.GITHUB,
  ),
)
const groups = computed(() =>
  [
    discordLinks.value.length || discordCommunityCount.value
      ? {
          id: 'discord' as const,
          label: 'Discord',
          description: '已保存的社区发布来源与手动链接',
          count: discordLinks.value.length + discordCommunityCount.value,
          links: discordLinks.value,
        }
      : undefined,
    githubLinks.value.length
      ? {
          id: 'github' as const,
          label: 'GitHub',
          description: '仓库、Release、Raw 文件与文档',
          count: githubLinks.value.length,
          links: githubLinks.value,
        }
      : undefined,
    otherLinks.value.length
      ? {
          id: 'other' as const,
          label: '其他链接',
          description: '官网、Patreon、Ko-fi 与其他网页',
          count: otherLinks.value.length,
          links: otherLinks.value,
        }
      : undefined,
  ].flatMap((group) => (group ? [group] : [])),
)

function classifyLink(value: string): ResourceLinkType {
  try {
    const hostname = new URL(value).hostname.toLocaleLowerCase()
    if (
      hostname === 'discord.com' ||
      hostname === 'www.discord.com' ||
      hostname === 'ptb.discord.com' ||
      hostname === 'canary.discord.com'
    ) {
      return RESOURCE_LINK_TYPE.DISCORD
    }
    if (hostname === 'github.com' || hostname.endsWith('.github.com'))
      return RESOURCE_LINK_TYPE.GITHUB
    if (hostname === 'patreon.com' || hostname.endsWith('.patreon.com'))
      return RESOURCE_LINK_TYPE.PATREON
    if (hostname === 'ko-fi.com' || hostname.endsWith('.ko-fi.com')) return RESOURCE_LINK_TYPE.KOFI
    return RESOURCE_LINK_TYPE.WEBSITE
  } catch {
    return RESOURCE_LINK_TYPE.OTHER
  }
}

function createLink(value: string): ResourceLink {
  const id =
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `resource-link-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const analysis = analyzeResourceLink(value)
  const type = analysis.type ?? classifyLink(value)
  let label: string
  try {
    label = new URL(value).hostname
  } catch {
    label = '来源链接'
  }
  return {
    id,
    label,
    url: value,
    type,
    note: '',
    purpose: analysis.purpose ?? RESOURCE_LINK_PURPOSE.SOURCE_POST,
    installTarget: analysis.installTarget ?? RESOURCE_INSTALL_TARGET.NONE,
    trustMode: analysis.trustMode ?? RESOURCE_LINK_TRUST_MODE.LINK_ONLY,
    createdAt: Date.now(),
    ...(analysis.github ? { github: analysis.github } : {}),
    ...(analysis.versionRef ? { versionRef: analysis.versionRef } : {}),
  }
}

function openAddSource(): void {
  addSourceUrl.value = ''
  addSourceError.value = ''
  addSourceOpen.value = true
}

function closeAddSource(): void {
  addSourceOpen.value = false
  addSourceError.value = ''
}

function openPlatform(id: PlatformGroupId): void {
  const next = new Set(openPlatforms.value)
  next.add(id)
  openPlatforms.value = next
}

function submitAddSource(): void {
  const value = addSourceUrl.value.trim()
  if (!value) {
    addSourceError.value = '请先粘贴来源链接。'
    return
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    addSourceError.value = '链接格式不正确。'
    return
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    addSourceError.value = '来源链接只支持 http / https。'
    return
  }

  addSourceError.value = ''
  const link = createLink(parsed.toString())
  links.value = [...links.value, link]
  if (link.type === RESOURCE_LINK_TYPE.DISCORD) {
    openPlatform('discord')
    discordManualOpen.value = true
  } else if (link.type === RESOURCE_LINK_TYPE.GITHUB) {
    openPlatform('github')
  } else {
    openPlatform('other')
  }
  addSourceOpen.value = false
  showTransientStatus('来源链接已添加')
}

function updateLink(updated: ResourceLink): void {
  links.value = links.value.map((link) => (link.id === updated.id ? updated : link))
}

function removeLink(id: string): void {
  links.value = links.value.filter((link) => link.id !== id)
}

function togglePlatform(id: PlatformGroupId): void {
  const next = new Set(openPlatforms.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  openPlatforms.value = next
}

function handleCommunitySourcesChanged(): void {
  communityRevision.value += 1
}

onMounted(() => {
  window.addEventListener('srl:community-sources-changed', handleCommunitySourcesChanged)
})

onBeforeUnmount(() => {
  window.removeEventListener('srl:community-sources-changed', handleCommunitySourcesChanged)
})
</script>

<template>
  <section class="resource-sources" aria-labelledby="resource-sources-title">
    <header class="resource-sources__header">
      <div>
        <span id="resource-sources-title" class="field__label">来源与链接</span>
        <p>发布来源保持独立。完整帖子保存在本机；远端变化不会自动删除本地内容。</p>
      </div>
      <button class="resource-sources__advanced" type="button" @click="advancedOpen = true">
        高级设置 ›
      </button>
    </header>

    <button class="resource-sources__add" type="button" @click="openAddSource">添加来源</button>
    <p v-if="statusMessage" class="resource-sources__status" role="status">
      {{ statusMessage }}
    </p>

    <div v-if="groups.length" class="resource-sources__directory">
      <article
        v-for="group in groups"
        :key="group.id"
        class="resource-source-platform"
        :class="{ 'resource-source-platform--open': openPlatforms.has(group.id) }"
      >
        <button
          class="resource-source-platform__row"
          type="button"
          @click="togglePlatform(group.id)"
        >
          <i :class="`resource-source-platform__mark--${group.id}`"></i>
          <span class="resource-source-platform__copy">
            <strong>{{ group.label }}</strong>
            <small>{{ group.description }}</small>
          </span>
          <span class="resource-source-platform__count">{{ group.count }}</span>
          <span class="resource-source-platform__chevron">›</span>
        </button>

        <div v-if="openPlatforms.has(group.id)" class="resource-source-platform__body">
          <template v-if="group.id === 'discord'">
            <DiscordCommunitySources
              :key="`${props.resourceId}:${communityRevision}`"
              :resource-id="props.resourceId"
              @count="discordCommunityCount = $event"
            />

            <template v-if="group.links.length">
              <button
                class="resource-source-subgroup"
                type="button"
                :aria-expanded="discordManualOpen"
                @click="discordManualOpen = !discordManualOpen"
              >
                <span>
                  <strong>手动链接</strong>
                  <small>仅保存 URL 的来源，可编辑或删除</small>
                </span>
                <em>{{ group.links.length }}</em>
                <b :class="{ 'is-open': discordManualOpen }">›</b>
              </button>
              <div v-if="discordManualOpen" class="resource-source-link-list">
                <ResourceLinkRow
                  v-for="link in group.links"
                  :key="link.id"
                  :link="link"
                  @update="updateLink"
                  @remove="removeLink"
                />
              </div>
            </template>
          </template>

          <div v-else class="resource-source-link-list">
            <ResourceLinkRow
              v-for="link in group.links"
              :key="link.id"
              :link="link"
              @update="updateLink"
              @remove="removeLink"
            />
          </div>
        </div>
      </article>
    </div>

    <div
      v-if="!groups.some((group) => group.id === 'discord') || !openPlatforms.has('discord')"
      v-show="!groups.length"
      class="resource-sources__discord-probe"
    >
      <DiscordCommunitySources
        :key="`${props.resourceId}:${communityRevision}:probe`"
        :resource-id="props.resourceId"
        @count="discordCommunityCount = $event"
      />
    </div>

    <p v-if="!groups.length && discordCommunityCount === 0" class="resource-sources__empty">
      还没有保存来源。可以添加来源链接；保存 Discord 帖子请前往“功能 → 收件箱”。
    </p>

    <p class="resource-sources__hint">
      这里只显示实际存在的平台。Discord 完整正文使用独立本地来源存储，不会塞进资源列表摘要。
    </p>
  </section>

  <ResourceLinkAdvancedSettings
    v-if="advancedOpen"
    :context-resource-id="props.resourceId"
    @close="advancedOpen = false"
  />

  <Teleport to="body">
    <div
      v-if="addSourceOpen"
      class="resource-source-add-wrap mobile-dialog-viewport"
      role="presentation"
      @click.self="closeAddSource"
    >
      <section
        class="resource-source-add-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="resource-source-add-title"
      >
        <h3 id="resource-source-add-title">添加来源</h3>
        <p>仅保存来源链接，不会读取帖子正文。</p>

        <label class="resource-source-add-field">
          <span>链接</span>
          <input
            v-model="addSourceUrl"
            type="url"
            inputmode="url"
            autocomplete="off"
            maxlength="2000"
            placeholder="https://discord.com/channels/..."
          />
        </label>

        <p>需要保存 Discord 帖子，请前往“功能 → 收件箱”。</p>

        <p v-if="addSourceError" class="resource-source-add-error" role="alert">
          {{ addSourceError }}
        </p>

        <div class="resource-source-add-actions">
          <button type="button" @click="closeAddSource">取消</button>
          <button
            class="resource-source-add-actions__primary"
            type="button"
            @click="submitAddSource"
          >
            保存链接
          </button>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped src="../styles/ResourceSourceLinks.css"></style>
