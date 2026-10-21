<script setup lang="ts">
import { candidateDetail } from '../utils/CharacterCardContentRows'

import type {
  CharacterCardContentEdit,
  CharacterCardContentSection,
} from '../types/CharacterCardContentEdit'

import { useCharacterCardContentWorkbench } from '../composables/UseCharacterCardContentWorkbench'

const props = defineProps<{
  card: Record<string, unknown>
  edits: CharacterCardContentEdit[]
  overriddenSections?: CharacterCardContentSection[]
  disabled?: boolean
  standaloneSection?: 'worldBook' | 'regex'
}>()

const emit = defineEmits<{
  'update:edits': [value: CharacterCardContentEdit[]]
  'draft-change': [dirty: boolean]
  'use-original': [section: CharacterCardContentSection]
  back: []
}>()
const {
  tabs,
  tab,
  isEditorOpen,
  editLabel,
  editText,
  editKeys,
  editSecondaryKeys,
  editFindRegex,
  editReplaceString,
  editScriptInfo,
  editEnabled,
  editConstant,
  editSelective,
  editPosition,
  editInsertionOrder,
  editDepth,
  editPlacement,
  editMarkdownOnly,
  editPromptOnly,
  trackMigration,
  importTrackMigration,
  query,
  page,
  pageSize,
  selectedKeys,
  importPage,
  importQuery,
  status,
  showRecords,
  recordPage,
  undoStack,
  formError,
  importError,
  isImporting,
  importInput,
  prepareSave,
  importCandidates,
  importMode,
  appliedEdits,
  entries,
  filteredEntries,
  pageCount,
  visibleEntries,
  filteredImports,
  importPageCount,
  visibleImports,
  editorDirty,
  undo,
  discardConflict,
  updateMigration,
  selectTab,
  exitWorkbench,
  openEditor,
  saveEditor,
  deleteEntry,
  deleteSelected,
  openImportPicker,
  importFile,
  applyImportSelection,
} = useCharacterCardContentWorkbench(props, emit)
defineExpose({ prepareSave })
function bindImportInput(element: unknown): void {
  importInput.value = element as typeof importInput.value
}
</script>

<template>
  <section
    class="card-content-workbench"
    :class="[`is-${tab}`, { 'is-editing': isEditorOpen }]"
    :aria-label="standaloneSection ? '资源内容编辑' : '角色卡卡内内容编辑'"
  >
    <header class="card-content-workbench__header">
      <button type="button" class="is-text" aria-label="退出编辑" @click="exitWorkbench">
        退出编辑
      </button>
      <div class="card-content-workbench__actions">
        <button
          v-if="!standaloneSection"
          type="button"
          class="is-secondary"
          :disabled="isImporting || disabled"
          @click="openImportPicker"
        >
          导入
        </button>
        <button type="button" class="is-primary" :disabled="disabled" @click="openEditor()">
          新建
        </button>
        <slot name="save" />
      </div>
    </header>
    <div v-if="isEditorOpen" class="card-content-workbench__editor-heading">
      <button
        type="button"
        class="is-text card-content-workbench__back"
        aria-label="返回列表"
        @click="isEditorOpen = false"
      >
        返回列表
      </button>
      <strong>{{
        tab === 'greeting'
          ? '开场白'
          : tab === 'worldBook'
            ? '世界书条目'
            : tab === 'regex'
              ? '正则规则'
              : '酒馆助手脚本'
      }}</strong>
    </div>

    <nav
      v-if="!isEditorOpen && !standaloneSection"
      class="card-content-workbench__tabs"
      aria-label="编辑内容类型"
    >
      <button
        v-for="item in tabs"
        :key="item.id"
        type="button"
        :aria-pressed="tab === item.id"
        :class="{ 'is-active': tab === item.id }"
        :disabled="disabled"
        @click="selectTab(item.id)"
      >
        <span>{{ item.label }}</span>
      </button>
    </nav>

    <div v-if="overriddenSections?.includes(tab)" class="card-content-workbench__notice">
      <span>当前预览与导出使用绑定资源，此处编辑的是原卡内容。</span>
      <button type="button" @click="emit('use-original', tab)">改用卡内内容</button>
    </div>
    <div v-if="editorDirty && !isEditorOpen" class="card-content-workbench__notice">
      <span>“{{ editLabel }}”还有未应用的输入，已暂存。</span>
      <button type="button" @click="isEditorOpen = true">继续编辑</button>
    </div>
    <div v-if="status && !isEditorOpen" class="card-content-workbench__notice" role="status">
      <span>{{ status }}</span>
      <button
        v-if="undoStack.length"
        type="button"
        :disabled="editorDirty || disabled"
        @click="undo"
      >
        撤销
      </button>
    </div>
    <section
      v-if="appliedEdits.conflicts.length"
      class="card-content-workbench__conflicts"
      role="alert"
    >
      <strong>{{ appliedEdits.conflicts.length }} 项修改未应用，请先处理再保存或导出</strong>
      <div v-for="edit in appliedEdits.conflicts" :key="edit.id">
        <span>{{ edit.label }}</span>
        <button type="button" @click="discardConflict(edit.id)">放弃此记录</button>
      </div>
    </section>

    <p v-if="!isEditorOpen && tab !== 'worldBook'" class="card-content-workbench__section-note">
      {{
        tab === 'greeting'
          ? '管理主开场白与备用开场白。导入后可选择替换主开场，或作为新备用开场。'
          : tab === 'regex'
            ? standaloneSection
              ? '编辑正则规则；保存修改会保留原版本。'
              : '编辑角色卡专属正则规则；资源库只保存规则，不执行替换。'
            : '管理角色卡内的酒馆助手脚本；资源库只保存源码，不会运行脚本。'
      }}
    </p>

    <input
      :ref="bindImportInput"
      class="card-content-workbench__file"
      type="file"
      :accept="
        tab === 'greeting'
          ? '.txt,.md,.json,.png,application/json,text/plain,image/png'
          : tab === 'helperScript'
            ? '.js,.json,application/json,text/javascript'
            : '.json,application/json'
      "
      @change="importFile"
    />
    <p v-if="isImporting" class="card-content-workbench__status" role="status">正在读取文件…</p>
    <p v-if="importError" class="card-content-workbench__error" role="alert">{{ importError }}</p>
    <p v-if="tab === 'helperScript' && !isEditorOpen" class="card-content-workbench__status">
      脚本按源码数据导入；资源库不会执行。酒馆助手加载已启用脚本时可能运行代码，新建与纯 JS
      文件导入默认停用。
    </p>

    <label
      v-if="importCandidates.length && tab === 'greeting' && !isEditorOpen"
      class="card-content-workbench__import-mode"
    >
      导入策略
      <select v-model="importMode">
        <option value="append">保留原主开场，添加为备用开场</option>
        <option value="replace-primary">替换主开场，其余添加为备用开场</option>
      </select>
    </label>

    <section
      v-if="importCandidates.length && !isEditorOpen"
      class="card-content-workbench__import-preview"
    >
      <header>
        <div>
          <strong>导入预览</strong>
          <small
            >{{ importCandidates.filter((item) => item.selected).length }} /
            {{ importCandidates.length }} 项已选</small
          >
        </div>
        <button
          type="button"
          class="is-text"
          @click="filteredImports.forEach((item) => (item.selected = true))"
        >
          选择筛选结果
        </button>
      </header>
      <input
        v-model="importQuery"
        type="search"
        aria-label="搜索待导入条目"
        placeholder="搜索待导入条目"
      />
      <label v-for="item in visibleImports" :key="item.id">
        <input v-model="item.selected" type="checkbox" />
        <span class="card-content-workbench__candidate">
          <strong>{{ item.label }}</strong>
          <small>{{ candidateDetail(item, tab) }}</small>
          <em v-if="item.warning">可能重复：{{ item.warning }}</em>
        </span>
      </label>
      <div v-if="importPageCount > 1" class="card-content-workbench__pagination">
        <button type="button" :disabled="importPage <= 1" @click="importPage--">上一页</button>
        <span>{{ importPage }} / {{ importPageCount }}</span>
        <button type="button" :disabled="importPage >= importPageCount" @click="importPage++">
          下一页
        </button>
      </div>
      <label class="card-content-workbench__migration"
        ><input v-model="importTrackMigration" type="checkbox" />随新版迁移这些修改</label
      >
      <p v-if="tab === 'worldBook'" class="card-content-workbench__import-note">
        仅嵌入勾选的条目到当前角色卡，不会新建独立的全局世界书。重复项会先提醒；导入只新增，不覆盖已有条目。
      </p>
      <footer>
        <button type="button" class="is-text" @click="importCandidates = []">取消导入</button>
        <button
          type="button"
          class="is-primary"
          :disabled="disabled || !importCandidates.some((item) => item.selected)"
          @click="applyImportSelection"
        >
          导入 {{ importCandidates.filter((item) => item.selected).length }} 项
        </button>
      </footer>
    </section>

    <div v-if="entries.length && !isEditorOpen" class="card-content-workbench__list-tools">
      <input
        v-model="query"
        type="search"
        :aria-label="standaloneSection ? '搜索资源条目' : '搜索卡内条目'"
        placeholder="搜索名称、触发词或正文"
      />
      <span>{{ filteredEntries.length }} 项</span>
    </div>
    <div v-if="selectedKeys.length && !isEditorOpen" class="card-content-workbench__selection">
      <span>已选 {{ selectedKeys.length }} 项</span>
      <button type="button" @click="selectedKeys = filteredEntries.map((row) => row.key)">
        选择筛选结果
      </button>
      <button type="button" @click="selectedKeys = []">取消选择</button>
      <button type="button" class="is-danger" @click="deleteSelected">删除所选</button>
    </div>

    <ul v-if="entries.length && !isEditorOpen" class="card-content-workbench__list">
      <li v-for="row in visibleEntries" :key="row.key">
        <input
          v-model="selectedKeys"
          type="checkbox"
          :value="row.key"
          :aria-label="`选择 ${row.label}`"
        />
        <div>
          <strong>{{ row.label }}</strong>
          <small>{{
            row.note || (tab === 'greeting' ? String(row.value).slice(0, 100) : '')
          }}</small>
        </div>
        <div>
          <button type="button" @click="openEditor(row)">编辑</button>
          <button type="button" class="is-danger" @click="deleteEntry(row)">删除</button>
        </div>
      </li>
    </ul>
    <p
      v-if="entries.length && !filteredEntries.length && !isEditorOpen"
      class="card-content-workbench__status"
    >
      没有匹配的条目，可修改搜索词或清空搜索。
    </p>
    <div v-if="!isEditorOpen && pageCount > 1" class="card-content-workbench__pagination">
      <button type="button" :disabled="page <= 1" @click="page--">上一页</button>
      <span>{{ page }} / {{ pageCount }}</span>
      <button type="button" :disabled="page >= pageCount" @click="page++">下一页</button>
    </div>
    <p v-if="!entries.length && !isEditorOpen" class="card-content-workbench__empty">
      <span aria-hidden="true">＋</span>
      <strong>还没有{{ tabs.find((item) => item.id === tab)?.label }}内容</strong>
      <small>可以新建一项，或从文件导入并选择要加入的内容。</small>
      <button type="button" class="is-primary" @click="openEditor()">
        新建{{ tabs.find((item) => item.id === tab)?.label }}
      </button>
    </p>

    <div
      v-if="isEditorOpen"
      class="card-content-workbench__editor"
      role="group"
      aria-label="条目编辑"
      @keydown.ctrl.enter="
        !$event.isComposing && ($event.stopPropagation(), $event.preventDefault(), saveEditor())
      "
    >
      <template v-if="tab === 'greeting'">
        <label>
          <span>开场白正文</span>
          <textarea v-model="editText" rows="6" placeholder="输入角色发给用户的第一段内容…" />
        </label>
        <small class="card-content-workbench__field-hint"
          >支持多段文本；保存后作为主开场白或备用开场白进入卡内容。</small
        >
      </template>

      <template v-else-if="tab === 'worldBook'">
        <label>
          <span>条目名称</span>
          <input v-model="editLabel" maxlength="120" placeholder="例如：旧城区的传闻" />
        </label>
        <label>
          <span>触发词 <small>每行一词 · 保留逗号</small></span>
          <textarea v-model="editKeys" class="is-keys" rows="2" placeholder="旧城区&#10;黑市入口" />
        </label>
        <label>
          <span>条目正文</span>
          <textarea v-model="editText" rows="5" placeholder="输入触发后注入对话的世界观内容…" />
        </label>
        <details class="card-content-workbench__advanced">
          <summary>更多世界书设置</summary>
          <label>
            <span>辅助触发词 <small>可选</small></span>
            <textarea
              v-model="editSecondaryKeys"
              class="is-keys"
              rows="2"
              placeholder="每行一个辅助触发词"
            />
          </label>
          <div
            class="card-content-workbench__field-grid"
            :class="{ 'has-depth': editPosition === '4' }"
          >
            <label>
              <span>注入位置</span>
              <select v-model="editPosition">
                <option value="0">角色设定前</option>
                <option value="1">角色设定后</option>
                <option value="2">作者注释前</option>
                <option value="3">作者注释后</option>
                <option value="5">示例对话前</option>
                <option value="6">示例对话后</option>
                <option value="4">指定深度</option>
                <option v-if="Number(editPosition) > 6" :value="editPosition">
                  保留原位置（{{ editPosition }}）
                </option>
              </select>
            </label>
            <label>
              <span>插入顺序</span>
              <input v-model.number="editInsertionOrder" type="number" />
            </label>
            <label v-if="editPosition === '4'">
              <span>注入深度</span
              ><input v-model.number="editDepth" type="number" min="0" step="1" />
            </label>
          </div>
          <div class="card-content-workbench__toggles">
            <label><input v-model="editEnabled" type="checkbox" />启用条目</label>
            <label><input v-model="editConstant" type="checkbox" />始终触发</label>
            <label
              ><input
                v-model="editSelective"
                type="checkbox"
                aria-label="需要辅助触发词"
              />需辅助词</label
            >
          </div>
        </details>
      </template>

      <template v-else-if="tab === 'regex'">
        <label><span>规则名称</span><input v-model="editLabel" maxlength="120" /></label>
        <label
          ><span>匹配正则</span
          ><input
            v-model="editFindRegex"
            class="is-code"
            spellcheck="false"
            autocapitalize="off"
            autocorrect="off"
            placeholder="例如：\b(hello)\b"
        /></label>
        <label
          ><span>替换内容</span
          ><textarea
            v-model="editReplaceString"
            class="is-code"
            spellcheck="false"
            autocapitalize="off"
            autocorrect="off"
            rows="4"
            placeholder="输入替换文本；留空表示删除匹配内容"
          />
        </label>
        <div class="card-content-workbench__toggles">
          <label><input v-model="editEnabled" type="checkbox" />启用此规则</label>
        </div>
        <fieldset class="card-content-workbench__regex-scope">
          <legend>作用范围</legend>
          <label><input v-model="editPlacement" type="checkbox" :value="1" />用户输入</label>
          <label><input v-model="editPlacement" type="checkbox" :value="2" />角色回复</label>
          <label><input v-model="editPlacement" type="checkbox" :value="5" />世界书</label>
          <label><input v-model="editMarkdownOnly" type="checkbox" />作用于显示</label>
          <label><input v-model="editPromptOnly" type="checkbox" />作用于发送给模型的内容</label>
        </fieldset>
      </template>

      <template v-else>
        <label><span>脚本名称</span><input v-model="editLabel" maxlength="120" /></label>
        <label
          ><span>说明</span
          ><input v-model="editScriptInfo" maxlength="240" placeholder="这段脚本的用途"
        /></label>
        <label
          ><span>脚本源码</span
          ><textarea
            v-model="editText"
            class="is-code"
            rows="8"
            spellcheck="false"
            autocapitalize="off"
            autocorrect="off"
            placeholder="脚本源码只会保存，不会在资源库执行。"
          />
        </label>
        <div class="card-content-workbench__toggles">
          <label><input v-model="editEnabled" type="checkbox" />在酒馆助手中启用</label>
        </div>
      </template>

      <p v-if="formError" class="card-content-workbench__error" role="alert">{{ formError }}</p>
      <label v-if="!standaloneSection" class="card-content-workbench__migration"
        ><input v-model="trackMigration" type="checkbox" />随新版迁移这项修改</label
      >
      <footer>
        <button type="button" class="is-secondary" @click="isEditorOpen = false">暂存并返回</button>
        <button type="button" class="is-primary" :disabled="disabled" @click="saveEditor">
          应用到草稿
        </button>
      </footer>
    </div>
    <details
      v-if="edits.length && !isEditorOpen && !standaloneSection"
      class="card-content-workbench__records"
      @toggle="showRecords = ($event.target as HTMLDetailsElement).open"
    >
      <summary>修改清单 · {{ edits.length }} 项</summary>
      <div v-if="showRecords">
        <p>勾选的修改可在更新版本时迁移；此处不是逐次编辑历史。</p>
        <label
          v-for="edit in edits.slice((recordPage - 1) * pageSize, recordPage * pageSize)"
          :key="edit.id"
        >
          <input
            type="checkbox"
            :checked="edit.migrateToVersions"
            @change="updateMigration(edit.id, $event)"
          />
          <span
            >{{
              edit.operation === 'delete' ? '删除' : edit.operation === 'add' ? '新增' : '修改'
            }}
            · {{ edit.label }}</span
          >
        </label>
        <div v-if="edits.length > pageSize" class="card-content-workbench__pagination">
          <button type="button" :disabled="recordPage <= 1" @click="recordPage--">上一页</button>
          <span>{{ recordPage }} / {{ Math.ceil(edits.length / pageSize) }}</span>
          <button
            type="button"
            :disabled="recordPage * pageSize >= edits.length"
            @click="recordPage++"
          >
            下一页
          </button>
        </div>
      </div>
    </details>
  </section>
</template>

<style scoped src="../styles/CharacterCardContentWorkbench.css"></style>
