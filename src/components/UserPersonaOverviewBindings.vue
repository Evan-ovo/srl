<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { userPersonaService } from '../core/AppContainer'
import { parseSillyTavernPersonaBackup } from '../parser/SillyTavernPersonaBackup'
import type { Resource, ResourceSummary } from '../types/Resource'
import type { UserPersonaEntry } from '../types/UserPersona'

const props = defineProps<{ resource: Resource; relatedResources?: ResourceSummary[] }>()
const entries = ref<UserPersonaEntry[]>([])
const selectedAvatarId = ref('')
const error = ref('')
const selected = computed(() =>
  entries.value.find((entry) => entry.avatarId === selectedAvatarId.value),
)
const characterRows = computed(() =>
  (selected.value?.connections ?? [])
    .filter((connection) => connection.type === 'character')
    .map((connection, index) => {
      const snapshot = selected.value?.characterBindings[connection.id]
      const related = props.relatedResources?.find((resource) =>
        snapshot
          ? resource.contentHash === snapshot.hash
          : resource.fileName === connection.id || `${resource.name}.png` === connection.id,
      )
      return {
        id: connection.id,
        name: related?.name ?? snapshot?.name ?? connection.id.replace(/\.png$/i, ''),
        status: related
          ? '已关联资源库角色卡'
          : snapshot
            ? '保留酒馆角色卡信息，可随人设传回'
            : '保留酒馆角色卡标识，尚未匹配资源库',
        index,
      }
    }),
)

async function load(): Promise<void> {
  error.value = ''
  try {
    const result = await userPersonaService.load(props.resource.id)
    entries.value = parseSillyTavernPersonaBackup(result.view.raw).entries
    selectedAvatarId.value =
      entries.value.find((entry) => entry.avatarId === selectedAvatarId.value)?.avatarId ??
      entries.value[0]?.avatarId ??
      ''
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '读取酒馆原生绑定失败'
  }
}

watch(() => props.resource.id, load)
onMounted(load)
</script>

<template>
  <section class="persona-overview-bindings" aria-labelledby="persona-overview-bindings-title">
    <header class="resource-detail__tab-heading">
      <h3 id="persona-overview-bindings-title">酒馆原生绑定</h3>
    </header>
    <label v-if="entries.length > 1" class="field persona-overview-bindings__select">
      <span class="field__label">人设档案</span>
      <select v-model="selectedAvatarId" class="field__control">
        <option v-for="entry in entries" :key="entry.avatarId" :value="entry.avatarId">
          {{ entry.name }}
        </option>
      </select>
    </label>
    <p v-if="error" class="field__hint" role="alert">{{ error }}</p>
    <ol v-else-if="characterRows.length" class="world-browser__list">
      <li v-for="item in characterRows" :key="item.id">
        <div class="persona-overview-bindings__row">
          <i>{{ String(item.index + 1).padStart(2, '0') }}</i>
          <span
            ><strong>{{ item.name }}</strong
            ><small>{{ item.status }}</small></span
          >
          <em>{{ item.id }}</em>
        </div>
      </li>
    </ol>
    <p v-else class="field__hint">
      {{ selected ? '当前人设没有绑定角色卡。' : '没有可读取的人设档案。' }}
    </p>
  </section>
</template>

<style scoped>
.persona-overview-bindings {
  margin: 0 0 1.5rem;
  padding: 1rem 0;
  border-top: 1px solid var(--color-line, rgba(80, 105, 115, 0.2));
  border-bottom: 1px solid var(--color-line, rgba(80, 105, 115, 0.2));
}

.persona-overview-bindings__select {
  margin-bottom: 0.75rem;
}

.persona-overview-bindings__row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-height: 3.25rem;
}

.persona-overview-bindings__row span {
  min-width: 0;
  flex: 1;
}

.persona-overview-bindings__row strong,
.persona-overview-bindings__row small {
  display: block;
}

.persona-overview-bindings__row em {
  max-width: 40%;
  overflow-wrap: anywhere;
  text-align: right;
}
</style>
