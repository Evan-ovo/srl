<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, ref } from 'vue'
import FeatureAppHeader from './FeatureAppHeader.vue'
import ActionSheet, { type ActionSheetAction } from './ActionSheet.vue'
import UserPersonaListItem from './UserPersonaListItem.vue'
import UserPersonaTemplatePanel from './UserPersonaTemplatePanel.vue'
import {
  useUserPersonaApp,
  type UserPersonaAppProps,
  type UserPersonaAppEvents,
} from '../composables/UseUserPersonaApp'
const TavernBridgeCenter = defineAsyncComponent(() => import('./TavernBridgeCenter.vue'))
const props = defineProps<UserPersonaAppProps>()
const emit = defineEmits<UserPersonaAppEvents>()
const versionActionOpen = ref(false)
const selectedVersionActionId = ref('')
const versionRenameOpen = ref(false)
const versionRenameDraft = ref('')
const expandedPreviewIds = ref(new Set<string>())
let versionLongPressTimer: ReturnType<typeof setTimeout> | undefined
const {
  page,
  transferOpen,
  busy,
  loading,
  saving,
  goBack,
  openTransfer,
  importTransferredFiles,
  selectedResourceId,
  backLabel,
  headerMoreOpen,
  headerMoreActions,
  selectHeaderMore,
  importPersonaFiles,
  startNewPack,
  statusMessage,
  errorMessage,
  searchQuery,
  listLimit,
  filteredResources,
  visibleResources,
  openResource,
  draft,
  entries,
  selectedAvatarId,
  changeEntry,
  currentWarnings,
  creatingPack,
  isDirty,
  saveDraft,
  avatarPreviewUrl,
  avatarPreviewFailed,
  avatarSourceUrl,
  cachedAvatarResource,
  pendingAvatarFile,
  chooseAvatarImage,
  onAvatarFileChange,
  onAvatarUrlInput,
  removeAvatarBinding,
  showTemplates,
  selectedTemplateId,
  applyTemplate,
  USER_PERSONA_TEMPLATES,
  customTemplates,
  selectedCustomTemplate,
  deleteSelectedCustomTemplate,
  creatingTemplate,
  customTemplateName,
  saveCustomTemplate,
  insertPlaceholder,
  showAdvanced,
  USER_PERSONA_POSITIONS,
  USER_PERSONA_ROLES,
  selectedWorldBookId,
  onWorldBookChange,
  worldBooks,
  characterSearchQuery,
  characterCategoryFilter,
  filteredCharacters,
  selectedCharacterIds,
  toggleCharacter,
  addableProfileCharacters,
  selectedVariantCharacterId,
  selectedVariantCharacter,
  personaVariantCharacters,
  activeVariantVersions,
  editorMode,
  chooseProfileCharacter,
  openGlobalProfileEditor,
  openProfileCharacter,
  deleteProfileCharacter,
  openVariantVersion,
  setDefaultVariantVersion,
  deleteVersionFromList,
  previewVersion,
  resolvedProfilePreview,
  characterAvatarId,
  activeProfileVariant,
  isDefaultVariantVersion,
  versionComparison,
  textTargetLabel,
  bindDescriptionInput,
  selectTextInput,
  changeProfileOverrideMode,
  openCharacterPicker,
  addVariantVersion,
  restoreProfileOverride,
  updateProfileOverride,
  updateProfileAddition,
  unresolvedConnections,
} = useUserPersonaApp(props, emit)

const versionActions = computed<ActionSheetAction[]>(() => {
  const version = activeVariantVersions.value.find(
    (item) => item.id === selectedVersionActionId.value,
  )
  if (!version) return []
  const isDefault =
    version.id === draft.value.profile.variants[selectedVariantCharacterId.value]?.defaultVersionId
  return [
    { id: 'rename', label: '重命名' },
    ...(!isDefault ? [{ id: 'default', label: '设为默认版本' }] : []),
    { id: 'delete', label: '移入回收站', danger: true },
  ]
})

function personaCharacterNames(
  resource: (typeof props.resources)[number],
  key: 'personaNativeCharacterNames' | 'personaProfileCharacterNames',
): string[] {
  const names = resource.metadata[key]
  return Array.isArray(names)
    ? Array.from(
        new Set(names.filter((name): name is string => typeof name === 'string' && !!name.trim())),
      ).slice(0, 8)
    : []
}

function cancelVersionLongPress(): void {
  if (versionLongPressTimer) clearTimeout(versionLongPressTimer)
  versionLongPressTimer = undefined
}

function startVersionLongPress(versionId: string, event: PointerEvent): void {
  if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return
  cancelVersionLongPress()
  versionLongPressTimer = setTimeout(() => {
    selectedVersionActionId.value = versionId
    versionActionOpen.value = true
    versionLongPressTimer = undefined
  }, 550)
}

function openVersionActions(versionId: string): void {
  selectedVersionActionId.value = versionId
  versionActionOpen.value = true
}

function selectVersionAction(action: ActionSheetAction): void {
  const versionId = selectedVersionActionId.value
  if (action.id === 'rename') {
    const version = activeVariantVersions.value.find((item) => item.id === versionId)
    if (!version) return
    versionRenameDraft.value = version.name
    versionRenameOpen.value = true
  } else if (action.id === 'default') setDefaultVariantVersion(versionId)
  else if (action.id === 'delete') deleteVersionFromList(versionId)
}

function saveVersionRename(): void {
  const name = versionRenameDraft.value.trim()
  const version = Object.values(draft.value.profile.variants)
    .map((character) => character.versions[selectedVersionActionId.value])
    .find((item) => item !== undefined)
  if (!name || !version) return
  version.name = name.slice(0, 80)
  versionRenameOpen.value = false
}

function toggleVersionPreview(versionId: string): void {
  const next = new Set(expandedPreviewIds.value)
  if (next.has(versionId)) next.delete(versionId)
  else next.add(versionId)
  expandedPreviewIds.value = next
}

onBeforeUnmount(cancelVersionLongPress)
</script>

<template>
  <TavernBridgeCenter
    v-if="transferOpen"
    :resources="resources"
    :categories="categories"
    :initial-local-ids="selectedResourceId ? [selectedResourceId] : []"
    initial-kind="userPersona"
    @back="goBack"
    @import-files="importTransferredFiles"
  />
  <section
    v-show="!transferOpen"
    class="persona-app"
    data-srl-controls
    :data-page="page"
    aria-labelledby="persona-app-title"
    :aria-busy="busy"
  >
    <FeatureAppHeader
      :title="
        page === 'list'
          ? 'user才是老大'
          : page === 'profile-sections'
            ? '人设内容'
            : page === 'versions'
              ? `${selectedVariantCharacter?.name ?? '角色卡'} · 版本`
              : page === 'character-picker'
                ? '选择角色卡'
                : creatingPack
                  ? '新建人设'
                  : editorMode === 'variant'
                    ? `${selectedVariantCharacter?.name ?? '角色卡'} · ${activeProfileVariant?.name ?? '角色人设'}`
                    : '编辑人设'
      "
      title-id="persona-app-title"
      :back-label="backLabel"
      :back-disabled="busy"
      @back="goBack"
    >
      <template #actions>
        <button
          v-if="headerMoreActions.length"
          class="feature-header-action feature-header-action--icon"
          type="button"
          :aria-label="editorMode === 'variant' ? '版本操作' : '更多人设操作'"
          :disabled="busy"
          @click="headerMoreOpen = true"
        >
          …
        </button>
        <button
          v-if="page === 'list'"
          class="feature-header-action feature-header-action--primary"
          type="button"
          :disabled="busy"
          @click="startNewPack"
        >
          新建
        </button>
        <button
          v-else-if="(page === 'profile-sections' && !isDirty) || page === 'versions'"
          class="feature-header-action"
          type="button"
          :disabled="busy"
          @click="page === 'versions' ? addVariantVersion() : openCharacterPicker()"
        >
          {{ page === 'versions' ? '新增版本' : '添加角色' }}
        </button>
        <button
          v-if="page === 'editor' || isDirty"
          class="feature-header-action feature-header-action--primary"
          type="button"
          :disabled="busy"
          @click="saveDraft"
        >
          {{ saving ? '保存中' : '保存' }}
        </button>
      </template>
    </FeatureAppHeader>
    <input
      ref="importInput"
      class="persona-app__import-input"
      type="file"
      accept=".json,application/json"
      multiple
      hidden
      @change="importPersonaFiles"
    />
    <ActionSheet
      v-model:open="headerMoreOpen"
      :title="editorMode === 'variant' ? '版本操作' : '人设操作'"
      :actions="headerMoreActions"
      @select="selectHeaderMore"
    />
    <ActionSheet
      v-model:open="versionActionOpen"
      title="版本操作"
      :actions="versionActions"
      :description="activeVariantVersions.find((item) => item.id === selectedVersionActionId)?.name"
      @select="selectVersionAction"
    />
    <Teleport to="body">
      <div
        v-if="versionRenameOpen"
        class="persona-app__rename-overlay"
        role="presentation"
        @click.self="versionRenameOpen = false"
        @keydown.esc.stop="versionRenameOpen = false"
      >
        <form
          class="persona-app__rename-dialog"
          data-srl-controls
          data-srl-dialog
          role="dialog"
          aria-modal="true"
          aria-labelledby="persona-version-rename-title"
          @submit.prevent="saveVersionRename"
        >
          <h2 id="persona-version-rename-title">重命名版本</h2>
          <input v-model="versionRenameDraft" aria-label="版本名称" maxlength="80" autofocus />
          <div class="persona-app__rename-actions">
            <button type="button" @click="versionRenameOpen = false">取消</button>
            <button type="button" :disabled="!versionRenameDraft.trim()" @click="saveVersionRename">
              确定
            </button>
          </div>
        </form>
      </div>
    </Teleport>
    <div class="persona-app__body">
      <p v-if="statusMessage" class="persona-app__notice" role="status">{{ statusMessage }}</p>
      <p v-if="errorMessage" class="persona-app__error" role="alert">{{ errorMessage }}</p>
      <p v-if="isDirty && page !== 'editor'" class="persona-app__dirty" role="status">
        未保存的修改
      </p>
      <template v-if="page === 'list'">
        <div class="persona-app__toolbar">
          <input v-model="searchQuery" type="search" aria-label="搜索人设" placeholder="搜索人设" />
          <button class="button button--quiet" type="button" :disabled="busy" @click="openTransfer">
            酒馆互传
          </button>
        </div>
        <p v-if="loading" role="status">读取中…</p>
        <ul class="persona-app__list" aria-label="已创建的人设">
          <li v-for="resource in visibleResources" :key="resource.id">
            <UserPersonaListItem
              :resource="resource"
              :native-character-names="
                personaCharacterNames(resource, 'personaNativeCharacterNames')
              "
              :profile-character-names="
                personaCharacterNames(resource, 'personaProfileCharacterNames')
              "
              :disabled="busy"
              @open="openResource(resource.id)"
            />
          </li>
        </ul>
        <p v-if="!filteredResources.length && !loading" class="persona-app__empty">
          {{ searchQuery ? '没有匹配的人设' : '暂无人设，点右上角新建' }}
        </p>
        <button
          v-if="visibleResources.length < filteredResources.length"
          class="button button--quiet"
          type="button"
          @click="listLimit += 30"
        >
          加载更多
        </button>
      </template>
      <section v-else-if="page === 'profile-sections'" class="persona-app__navigation">
        <p class="persona-app__context">{{ draft.name }} · 全局人设与角色专属补充</p>
        <button class="persona-app__navigation-item" type="button" @click="openGlobalProfileEditor">
          <span
            ><strong>全局人设</strong><small>所有角色卡共用；专属补充接在全局内容之后</small></span
          ><span aria-hidden="true">›</span>
        </button>
        <div
          v-for="character in personaVariantCharacters"
          :key="character.id"
          class="persona-app__profile-character-row"
        >
          <button
            class="persona-app__navigation-item"
            type="button"
            @click="openProfileCharacter(character.id)"
          >
            <span
              ><strong>{{ character.name }}</strong
              ><small
                >{{
                  Object.keys(draft.profile.variants[character.id]?.versions ?? {}).length
                }}
                个角色人设版本</small
              ></span
            ><span aria-hidden="true">›</span>
          </button>
          <button
            class="persona-app__profile-character-delete"
            type="button"
            :aria-label="`删除${character.name}的人设`"
            @click="deleteProfileCharacter(character.id)"
          >
            删除
          </button>
        </div>
      </section>
      <section v-else-if="page === 'versions'" class="persona-app__navigation">
        <p class="persona-app__context">
          {{ draft.name }} · {{ selectedVariantCharacter?.name }}的专属补充
        </p>
        <article
          v-for="version in activeVariantVersions"
          :key="version.id"
          class="persona-app__version-card"
          @pointerdown="startVersionLongPress(version.id, $event)"
          @pointerup="cancelVersionLongPress"
          @pointerleave="cancelVersionLongPress"
          @pointercancel="cancelVersionLongPress"
          @contextmenu.prevent="openVersionActions(version.id)"
        >
          <div class="persona-app__version-heading">
            <strong>{{ version.name }}</strong>
            <span class="persona-app__version-badge">
              {{
                version.id === draft.profile.variants[selectedVariantCharacterId]?.defaultVersionId
                  ? '默认'
                  : '专属'
              }}
            </span>
            <button
              class="persona-app__version-edit"
              type="button"
              @click="openVariantVersion(version.id)"
            >
              编辑
            </button>
            <button
              class="persona-app__version-more"
              type="button"
              :aria-label="`${version.name}的版本操作`"
              @click="openVersionActions(version.id)"
            >
              ⋯
            </button>
          </div>
          <button
            class="persona-app__version-preview-toggle"
            type="button"
            :aria-expanded="expandedPreviewIds.has(version.id)"
            @click="toggleVersionPreview(version.id)"
          >
            {{ expandedPreviewIds.has(version.id) ? '收起预览' : '预览内容' }}
          </button>
          <pre v-if="expandedPreviewIds.has(version.id)" class="persona-app__version-preview">{{
            previewVersion(version.id) || '此版本暂无单独内容。'
          }}</pre>
        </article>
      </section>
      <section v-else-if="page === 'character-picker'" class="persona-app__character-picker">
        <p class="persona-app__profile-hint">选择一张角色卡，再填写只对这张卡生效的人设内容。</p>
        <div class="persona-app__toolbar">
          <input
            v-model="characterSearchQuery"
            type="search"
            aria-label="搜索角色卡"
            placeholder="搜索角色卡"
          /><select v-model="characterCategoryFilter" aria-label="角色卡分类">
            <option value="all">全部分类</option>
            <option v-for="category in categories" :key="category.id" :value="category.id">
              {{ category.name }}
            </option>
          </select>
        </div>
        <button
          v-for="character in addableProfileCharacters"
          :key="character.id"
          class="persona-app__navigation-item"
          type="button"
          @click="chooseProfileCharacter(characterAvatarId(character))"
        >
          <span
            ><strong>{{ character.name || character.fileName }}</strong
            ><small>{{ character.fileName }}</small></span
          ><span aria-hidden="true">＋</span>
        </button>
        <p v-if="!addableProfileCharacters.length" class="persona-app__empty">
          {{ characterSearchQuery ? '没有匹配的角色卡' : '没有可添加的角色卡' }}
        </p>
      </section>
      <form v-else-if="page === 'editor'" class="persona-app__editor" @submit.prevent="saveDraft">
        <div class="persona-app__context">
          <span
            >{{ draft.name || '新建人设' }} ·
            {{ editorMode === 'global' ? '全局人设' : '角色专属补充' }}</span
          >
          <span class="persona-app__save-state" :class="{ 'is-dirty': isDirty }" role="status">
            {{ isDirty ? '未保存' : creatingPack ? '未入库' : '已保存到本机' }}
          </span>
        </div>
        <label v-if="entries.length > 1" class="persona-app__field"
          ><span>文件内人设</span
          ><select :value="selectedAvatarId" :disabled="busy" @change="changeEntry">
            <option v-for="entry in entries" :key="entry.avatarId" :value="entry.avatarId">
              {{ entry.name }}
            </option>
          </select></label
        >
        <ul v-if="currentWarnings.length" class="persona-app__error">
          <li v-for="warning in currentWarnings" :key="warning">{{ warning }}</li>
        </ul>
        <fieldset v-if="editorMode === 'global'" :disabled="busy">
          <div class="persona-app__identity">
            <div class="persona-app__name-fields">
              <label class="persona-app__field"
                ><span>人设名</span
                ><input
                  v-model="draft.name"
                  name="personaName"
                  type="text"
                  autocomplete="off"
                  required
              /></label>
              <label class="persona-app__field"
                ><span>备注</span><input v-model="draft.title" name="personaNote" type="text"
              /></label>
              <details class="persona-app__avatar-disclosure">
                <summary>
                  头像与封面
                  <small>{{
                    cachedAvatarResource || pendingAvatarFile || avatarSourceUrl
                      ? '已设置'
                      : '未设置'
                  }}</small>
                </summary>
                <div class="persona-app__avatar-fields">
                  <div class="persona-app__avatar-preview">
                    <img
                      v-if="avatarPreviewUrl && !avatarPreviewFailed"
                      :src="avatarPreviewUrl"
                      alt="人设封面"
                      referrerpolicy="no-referrer"
                      @error="avatarPreviewFailed = true"
                    /><span v-else aria-hidden="true">{{ draft.name.slice(0, 1) || '我' }}</span>
                  </div>
                  <div class="persona-app__avatar-options">
                    <div class="persona-app__actions">
                      <button class="button button--quiet" type="button" @click="chooseAvatarImage">
                        选择图片</button
                      ><button
                        v-if="cachedAvatarResource || pendingAvatarFile || avatarSourceUrl"
                        class="button button--quiet"
                        type="button"
                        @click="removeAvatarBinding"
                      >
                        移除
                      </button>
                    </div>
                    <label class="persona-app__field"
                      ><span>头像 URL</span
                      ><input
                        v-model="avatarSourceUrl"
                        type="url"
                        placeholder="https://"
                        @input="onAvatarUrlInput"
                    /></label>
                    <small>默认只留在资源库；酒馆互传时可选择发送已缓存封面。</small>
                    <p v-if="avatarPreviewFailed" class="persona-app__error">
                      图片无法预览，请检查地址或选择本地图片。
                    </p>
                  </div>
                  <input
                    ref="avatarInput"
                    type="file"
                    accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
                    hidden
                    @change="onAvatarFileChange"
                  />
                </div>
              </details>
            </div>
          </div>
          <div class="persona-app__description-heading">
            <label for="persona-description">全局人设</label>
            <div class="persona-app__actions">
              <button
                class="button button--quiet"
                type="button"
                @click="insertPlaceholder('{{user}}')"
                v-text="'{{user}}'"
              /><button
                class="button button--quiet"
                type="button"
                @click="insertPlaceholder('{{char}}')"
                v-text="'{{char}}'"
              /><button
                class="button button--quiet"
                type="button"
                :aria-expanded="showTemplates"
                aria-controls="persona-templates"
                @click="showTemplates = !showTemplates"
              >
                模板
              </button>
            </div>
          </div>
          <!-- SRL-PUBLIC-SYNC: BEGIN REPLACE id=persona-template-panel -->
          <UserPersonaTemplatePanel
            v-if="showTemplates"
            v-model:selected-template-id="selectedTemplateId"
            v-model:creating="creatingTemplate"
            v-model:template-name="customTemplateName"
            :builtin-templates="USER_PERSONA_TEMPLATES"
            :custom-templates="customTemplates"
            :can-delete="!!selectedCustomTemplate"
            :target-label="editorMode === 'global' ? '全局人设' : textTargetLabel"
            @apply="applyTemplate"
            @save="saveCustomTemplate"
            @delete="deleteSelectedCustomTemplate"
          />
          <!-- SRL-PUBLIC-SYNC: END REPLACE id=persona-template-panel -->
          <textarea
            id="persona-description"
            :ref="bindDescriptionInput"
            v-model="draft.description"
            :data-section-id="draft.profile.sections[0]?.id"
            name="personaDescription"
            rows="8"
            @focus="selectTextInput"
          />
          <details
            class="persona-app__disclosure"
            :open="showAdvanced"
            @toggle="showAdvanced = ($event.target as HTMLDetailsElement).open"
          >
            <summary>高级 · 酒馆注入</summary>
            <div class="persona-app__injection">
              <label class="persona-app__field"
                ><span>注入位置</span
                ><select v-model.number="draft.position">
                  <option :value="USER_PERSONA_POSITIONS.IN_PROMPT">主提示词</option>
                  <option :value="USER_PERSONA_POSITIONS.AFTER_CHARACTER_LEGACY">
                    角色描述之后（旧版）
                  </option>
                  <option :value="USER_PERSONA_POSITIONS.TOP_AUTHORS_NOTE">作者注释之前</option>
                  <option :value="USER_PERSONA_POSITIONS.BOTTOM_AUTHORS_NOTE">作者注释之后</option>
                  <option :value="USER_PERSONA_POSITIONS.AT_DEPTH">聊天指定深度</option>
                  <option :value="USER_PERSONA_POSITIONS.NONE">不注入</option>
                  <option
                    v-if="!Object.values(USER_PERSONA_POSITIONS).some((v) => v === draft.position)"
                    :value="draft.position"
                  >
                    原位置 {{ draft.position }}
                  </option>
                </select></label
              >
              <template v-if="draft.position === USER_PERSONA_POSITIONS.AT_DEPTH"
                ><label class="persona-app__field"
                  ><span>深度</span
                  ><input v-model.number="draft.depth" type="number" min="0" step="1" /></label
                ><label class="persona-app__field"
                  ><span>消息身份</span
                  ><select v-model.number="draft.role">
                    <option :value="USER_PERSONA_ROLES.SYSTEM">系统</option>
                    <option :value="USER_PERSONA_ROLES.USER">用户</option>
                    <option :value="USER_PERSONA_ROLES.ASSISTANT">助手</option>
                  </select></label
                ></template
              >
            </div>
          </details>
          <details class="persona-app__disclosure persona-app__bindings">
            <summary>
              酒馆绑定与世界书<span v-if="selectedCharacterIds.size || draft.lorebook"
                >（{{ selectedCharacterIds.size }} 个 char{{
                  draft.lorebook ? ' · ' + draft.lorebook : ''
                }}）</span
              >
            </summary>
            <label class="persona-app__field"
              ><span>世界书</span
              ><select v-model="selectedWorldBookId" @change="onWorldBookChange">
                <option value="">
                  {{
                    draft.lorebook && !selectedWorldBookId ? `原绑定：${draft.lorebook}` : '不绑定'
                  }}
                </option>
                <option v-for="book in worldBooks" :key="book.id" :value="book.id">
                  {{ book.name }}
                </option>
              </select></label
            >
            <button
              v-if="draft.lorebook && !selectedWorldBookId"
              class="button button--quiet"
              type="button"
              @click="draft.lorebook = ''"
            >
              解除原世界书绑定
            </button>
            <div class="persona-app__toolbar">
              <input
                v-model="characterSearchQuery"
                type="search"
                aria-label="搜索 char"
                placeholder="搜索 char"
              /><select v-model="characterCategoryFilter" aria-label="char 分类">
                <option value="all">全部分类</option>
                <option v-for="category in categories" :key="category.id" :value="category.id">
                  {{ category.name }}
                </option>
              </select>
            </div>
            <div class="persona-app__characters">
              <label
                v-for="character in filteredCharacters"
                :key="character.id"
                class="persona-app__character"
                ><input
                  type="checkbox"
                  :checked="selectedCharacterIds.has(character.id)"
                  @change="toggleCharacter(character.id)"
                /><span>{{ character.name }}</span
                ><small>{{ character.fileName }}</small></label
              >
              <p v-if="!filteredCharacters.length">没有可选 char</p>
            </div>
            <p v-if="unresolvedConnections.length">
              保留酒馆原绑定：{{ unresolvedConnections.map((c) => c.id).join('、') }}
            </p>
            <small>绑定按酒馆名称匹配；关联的 char 和世界书需另行传入酒馆。</small>
          </details>
        </fieldset>
        <fieldset v-else :disabled="busy" class="persona-app__variant-editor">
          <label class="persona-app__field"
            ><span>版本名称</span
            ><input
              v-model="activeProfileVariant!.name"
              aria-label="角色人设版本名称"
              maxlength="80"
          /></label>
          <section
            v-for="section in draft.profile.sections"
            :key="`override-${section.id}`"
            class="persona-app__profile-override"
            :data-mode="activeProfileVariant?.overrides[section.id]?.mode ?? 'inherit'"
          >
            <div class="persona-app__override-heading">
              <strong>{{
                draft.profile.sections.length === 1 ? '全局人设' : section.name || '全局设定'
              }}</strong>
              <select
                :value="activeProfileVariant?.overrides[section.id]?.mode ?? 'inherit'"
                :aria-label="`${section.name || '全局'}内容方式`"
                @change="changeProfileOverrideMode(section.id, $event)"
              >
                <option value="inherit">沿用全局</option>
                <option value="replace">仅此版本改写</option>
                <option value="disable">此版本不使用</option>
              </select>
            </div>
            <template v-if="activeProfileVariant?.overrides[section.id]?.mode === 'replace'">
              <details class="persona-app__original-text">
                <summary>查看全局原文</summary>
                <p>{{ section.text || '全局人设暂无内容。' }}</p>
              </details>
              <label class="persona-app__field">
                <span>此版本使用的内容</span>
                <textarea
                  :value="activeProfileVariant.overrides[section.id]?.text ?? ''"
                  rows="4"
                  :aria-label="`替换${section.name || '全局'}内容`"
                  @input="
                    updateProfileOverride(section.id, ($event.target as HTMLTextAreaElement).value)
                  "
                />
              </label>
              <button
                class="persona-app__version-preview-toggle"
                type="button"
                @click="restoreProfileOverride(section.id)"
              >
                恢复使用全局内容
              </button>
            </template>
            <template v-else-if="activeProfileVariant?.overrides[section.id]?.mode === 'disable'">
              <p class="persona-app__profile-override-note">此版本不使用这段全局设定</p>
              <button
                class="persona-app__version-preview-toggle"
                type="button"
                @click="restoreProfileOverride(section.id)"
              >
                恢复使用全局内容
              </button>
            </template>
            <p v-else class="persona-app__inherited-text">
              {{ section.text || '全局人设暂无内容。' }}
            </p>
          </section>
          <section class="persona-app__addition">
            <div class="persona-app__description-heading">
              <label for="persona-addition">角色专属补充</label>
              <div class="persona-app__actions">
                <button
                  class="button button--quiet"
                  type="button"
                  @click="insertPlaceholder('{{user}}')"
                  v-text="'{{user}}'"
                />
                <button
                  class="button button--quiet"
                  type="button"
                  @click="insertPlaceholder('{{char}}')"
                  v-text="'{{char}}'"
                />
                <button
                  class="button button--quiet"
                  type="button"
                  :aria-expanded="showTemplates"
                  aria-controls="persona-templates"
                  @click="showTemplates = !showTemplates"
                >
                  模板
                </button>
              </div>
            </div>
            <UserPersonaTemplatePanel
              v-if="showTemplates"
              v-model:selected-template-id="selectedTemplateId"
              v-model:creating="creatingTemplate"
              v-model:template-name="customTemplateName"
              :builtin-templates="USER_PERSONA_TEMPLATES"
              :custom-templates="customTemplates"
              :can-delete="!!selectedCustomTemplate"
              :target-label="textTargetLabel"
              @apply="applyTemplate"
              @save="saveCustomTemplate"
              @delete="deleteSelectedCustomTemplate"
            />
            <label class="persona-app__field"
              ><small
                >仅对{{ selectedVariantCharacter?.name || '当前角色卡' }}的此版本生效 ·
                接在全局之后</small
              ><textarea
                id="persona-addition"
                :ref="bindDescriptionInput"
                data-section-id=""
                :value="activeProfileVariant?.addition ?? ''"
                rows="4"
                aria-label="当前角色卡的追加人设"
                @focus="selectTextInput"
                @input="updateProfileAddition(($event.target as HTMLTextAreaElement).value)"
              />
            </label>
          </section>
          <details v-if="!isDefaultVariantVersion" class="persona-app__comparison">
            <summary>
              与默认版本比较 <small>{{ versionComparison.length }} 处内容差异</small>
            </summary>
            <p v-if="!versionComparison.length">合成内容与默认版本相同。</p>
            <section v-for="(difference, index) in versionComparison" :key="index">
              <strong>{{
                difference.name === '角色专属追加'
                  ? '角色专属补充'
                  : draft.profile.sections.length === 1
                    ? '全局人设'
                    : difference.name
              }}</strong>
              <small>默认版本</small>
              <p>{{ difference.before || '不使用／无内容' }}</p>
              <small>当前版本</small>
              <p>{{ difference.after || '不使用／无内容' }}</p>
            </section>
          </details>
        </fieldset>
        <details class="persona-app__profile-preview">
          <summary>
            <span>最终人设预览</span
            ><small>{{ Array.from(resolvedProfilePreview).length }} 字</small>
          </summary>
          <pre v-if="resolvedProfilePreview.trim()" class="persona-app__profile-preview-prompt">{{
            resolvedProfilePreview
          }}</pre>
          <p v-else class="persona-app__profile-preview-empty">此版本没有可注入的人设内容。</p>
        </details>
      </form>
    </div>
  </section>
</template>

<style src="../styles/UserPersonaApp.css"></style>
