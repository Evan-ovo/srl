import type { ComputedRef, Ref, ShallowRef } from 'vue'
import { nextTick } from 'vue'
import { browserStorageService } from '../core/AppContainer'
import type { EditScope } from '../types/PresetStitcherAppView'
import { type ResourceSummary } from '../types/Resource'
import {
  applyEntryEdit,
  type AssemblyEntry,
  createPresetPromptSlotMacro,
  type PresetFavoriteSnapshot,
  type PresetSegmentView,
  readPresetPromptSlots,
} from '../utils/PresetStitcher'

interface PresetEntryEditingContext {
  editor: Ref<
    | {
        scope: EditScope
        key: string
        name: string
        role: string
        content: string
      }
    | undefined
  >
  sourceKey: (segment: Pick<PresetSegmentView, 'identifier'>) => string
  editorSelection: Ref<
    { start: number; end: number },
    { start: number; end: number } | { start: number; end: number }
  >
  editorTextarea: Readonly<ShallowRef<HTMLTextAreaElement | null>>
  variableName: Ref<string, string>
  variableValue: Ref<string, string>
  variableValueSelection: Ref<{ start: number; end: number }, { start: number; end: number }>
  variableWriterOpen: Ref<boolean, boolean>
  slotName: Ref<string, string>
  slotId: Ref<string, string>
  slotWriterError: Ref<string, string>
  slotWriterOpen: Ref<boolean, boolean>
  unreadWrittenVariables: ComputedRef<{ scope: 'chat' | 'global'; name: string; label: string }[]>
  notice: Ref<string, string>
  errorMessage: Ref<string, string>
  assembly: Ref<AssemblyEntry[]>
  sourceOverrides: Ref<Map<string, { name: string; role: string; content: string }>>
  favorites: Ref<PresetFavoriteSnapshot[]>
  sourceSummary: Ref<ResourceSummary | undefined>
  buildCurrentSourceEntry: (identifier: string) => AssemblyEntry | undefined
  insertNewEntry: (value: { name: string; role: string; content: string }) => void
}

export function usePresetEntryEditing(getContext: () => PresetEntryEditingContext) {
  function beginNewEntry(): void {
    const context = getContext()
    context.editor.value = { scope: 'new', key: '', name: '', role: 'system', content: '' }
    context.editorSelection.value = { start: 0, end: 0 }
  }

  function beginSourceEdit(segment: PresetSegmentView): void {
    const context = getContext()

    context.editor.value = {
      scope: 'source',
      key: context.sourceKey(segment),
      name: segment.name,
      role: segment.role,
      content: segment.content,
    }
    context.editorSelection.value = { start: segment.content.length, end: segment.content.length }
  }

  function beginTargetEdit(entry: AssemblyEntry): void {
    const context = getContext()

    if (entry.marker) return
    context.editor.value = {
      scope: 'target',
      key: entry.key,
      name: entry.name,
      role: entry.role,
      content: entry.content,
    }
    context.editorSelection.value = { start: entry.content.length, end: entry.content.length }
  }

  function beginFavoriteEdit(favorite: PresetFavoriteSnapshot): void {
    const context = getContext()

    context.editor.value = {
      scope: 'favorite',
      key: favorite.id,
      name: favorite.name,
      role: favorite.role,
      content: favorite.content,
    }
    context.editorSelection.value = { start: favorite.content.length, end: favorite.content.length }
  }

  function rememberEditorSelection(event: Event): void {
    const context = getContext()

    const textarea = event.currentTarget as HTMLTextAreaElement
    context.editorSelection.value = {
      start: textarea.selectionStart ?? textarea.value.length,
      end: textarea.selectionEnd ?? textarea.value.length,
    }
  }

  function insertVariable(value: string, placeholder?: string, event?: Event): void {
    const context = getContext()

    const current = context.editor.value
    if (!current) return
    const eventTextarea = (event?.currentTarget as HTMLElement | undefined)
      ?.closest('.stitch-editor')
      ?.querySelector<HTMLTextAreaElement>('textarea')
    const length = current.content.length
    const start = Math.min(Math.max(context.editorSelection.value.start, 0), length)
    const end = Math.min(Math.max(context.editorSelection.value.end, start), length)
    current.content = `${current.content.slice(0, start)}${value}${current.content.slice(end)}`
    const placeholderStart = placeholder ? value.indexOf(placeholder) : -1
    const selectionStart = start + (placeholderStart >= 0 ? placeholderStart : value.length)
    const selectionEnd = selectionStart + (placeholderStart >= 0 ? placeholder!.length : 0)
    context.editorSelection.value = { start: selectionStart, end: selectionEnd }
    void nextTick(() => {
      const textarea = eventTextarea ?? context.editorTextarea.value
      if (!textarea) return
      if (typeof textarea.focus === 'function') textarea.focus({ preventScroll: true })
      if (typeof textarea.setSelectionRange === 'function')
        textarea.setSelectionRange(selectionStart, selectionEnd)
    })
  }

  function openVariableWriter(): void {
    const context = getContext()

    context.variableName.value = ''
    context.variableValue.value = ''
    context.variableWriterOpen.value = true
  }

  function openSlotWriter(event?: Event): void {
    const context = getContext()
    const editorPanel = (event?.currentTarget as HTMLElement | undefined)?.closest('.stitch-editor')
    const textarea = editorPanel?.querySelector<HTMLTextAreaElement>('textarea')
    if (textarea) {
      context.editorSelection.value = {
        start: textarea.selectionStart ?? textarea.value.length,
        end: textarea.selectionEnd ?? textarea.value.length,
      }
    }
    const selectedText = textarea
      ? textarea.value.slice(context.editorSelection.value.start, context.editorSelection.value.end)
      : ''
    const selectedSlot = readPresetPromptSlots(selectedText)[0]
    context.slotId.value = selectedSlot?.id ?? ''
    context.slotName.value = selectedSlot?.label ?? ''
    context.slotWriterError.value = ''
    context.slotWriterOpen.value = true
  }

  function openSlotWriterForVariable(event?: Event): void {
    const context = getContext()
    const panel = (event?.currentTarget as HTMLElement | undefined)?.closest(
      '.stitch-variable-writer',
    )
    const textarea = panel?.querySelector<HTMLTextAreaElement>('textarea')
    if (textarea) {
      context.variableValueSelection.value = {
        start: textarea.selectionStart ?? textarea.value.length,
        end: textarea.selectionEnd ?? textarea.value.length,
      }
    }
    context.slotId.value = ''
    context.slotName.value = ''
    context.slotWriterError.value = ''
    context.slotWriterOpen.value = true
  }

  function insertPromptSlot(event?: Event): void {
    const context = getContext()
    const panel = (event?.currentTarget as HTMLElement | undefined)?.closest('.stitch-slot-writer')
    const name = (
      panel?.querySelector<HTMLInputElement>('input')?.value ?? context.slotName.value
    ).trim()
    try {
      const macro = createPresetPromptSlotMacro(name, context.slotId.value || crypto.randomUUID())
      const editor = context.editor.value
      if (editor?.scope === 'new' && !editor.name.trim()) editor.name = name
      context.slotWriterOpen.value = false
      context.slotWriterError.value = ''
      context.slotId.value = ''
      if (context.variableWriterOpen.value) {
        const value = context.variableValue.value
        const start = Math.min(context.variableValueSelection.value.start, value.length)
        const end = Math.min(
          Math.max(context.variableValueSelection.value.end, start),
          value.length,
        )
        context.variableValue.value = `${value.slice(0, start)}${macro}${value.slice(end)}`
        const cursor = start + macro.length
        context.variableValueSelection.value = { start: cursor, end: cursor }
        void nextTick(() => {
          const textarea = document.querySelector<HTMLTextAreaElement>(
            '.stitch-variable-writer textarea',
          )
          textarea?.focus({ preventScroll: true })
          textarea?.setSelectionRange(cursor, cursor)
        })
        return
      }
      insertVariable(macro)
    } catch (error) {
      context.slotWriterError.value = error instanceof Error ? error.message : '占位名无效'
    }
  }

  function insertVariableWrite(event?: Event): void {
    const context = getContext()

    const panel = (event?.currentTarget as HTMLElement | undefined)?.closest(
      '.stitch-variable-writer',
    )
    const name = (
      panel?.querySelector<HTMLInputElement>('input')?.value ?? context.variableName.value
    ).trim()
    if (!name) return
    const value =
      panel?.querySelector<HTMLTextAreaElement>('textarea')?.value ?? context.variableValue.value
    context.variableWriterOpen.value = false
    insertVariable(`{{setvar::${name}::${value}}}`)
  }

  function insertUnreadWrittenVariable(event: Event): void {
    const context = getContext()

    const select = event.currentTarget as HTMLSelectElement
    const variable = context.unreadWrittenVariables.value.find(
      (item) => `${item.scope}:${item.name}` === select.value,
    )
    select.value = ''
    if (!variable) return
    const macro =
      variable.scope === 'global'
        ? `{{getglobalvar::${variable.name}}}`
        : `{{getvar::${variable.name}}}`
    insertVariable(macro, undefined, event)
  }

  async function copyEntryContent(content: string): Promise<void> {
    const context = getContext()

    if (!content) return
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(content)
      else {
        const textarea = document.createElement('textarea')
        textarea.value = content
        textarea.setAttribute('readonly', '')
        textarea.style.cssText = 'position:fixed;opacity:0;pointer-events:none;'
        document.body.append(textarea)
        textarea.select()
        const copied = document.execCommand('copy')
        textarea.remove()
        if (!copied) throw new Error('浏览器拒绝复制')
      }
      context.notice.value = '条目正文已复制'
    } catch {
      context.errorMessage.value = '复制失败，请检查浏览器剪贴板权限'
    }
  }

  function saveEdit(): void {
    const context = getContext()

    const value = context.editor.value
    if (!value) return
    if (!value.name.trim()) {
      context.errorMessage.value = '条目名称不能为空'
      return
    }
    if (value.scope === 'new') {
      context.insertNewEntry({ name: value.name.trim(), role: value.role, content: value.content })
    } else if (value.scope === 'target') {
      const entry = context.assembly.value.find((item) => item.key === value.key)
      if (entry) applyEntryEdit(entry, value)
    } else if (value.scope === 'source') {
      const next = new Map(context.sourceOverrides.value)
      next.set(value.key, { name: value.name.trim(), role: value.role, content: value.content })
      context.sourceOverrides.value = next
      const [resourceId, ...identifierParts] = value.key.split(':')
      const identifier = identifierParts.join(':')
      const selected = context.assembly.value.find(
        (entry) => entry.key === `pick:${resourceId}:${identifier}`,
      )
      if (selected) applyEntryEdit(selected, value)
    } else {
      const now = Date.now()
      context.favorites.value = browserStorageService.setStitchFavorites(
        context.favorites.value.map((favorite) => {
          if (favorite.id !== value.key) return favorite
          const prompt = {
            ...favorite.prompt,
            name: value.name.trim(),
            role: value.role,
            content: value.content,
          }
          return {
            ...favorite,
            name: value.name.trim(),
            role: value.role,
            content: value.content,
            prompt,
            updatedAt: now,
          }
        }),
      )
      context.assembly.value
        .filter((entry) => entry.favoriteId === value.key)
        .forEach((entry) => applyEntryEdit(entry, value))
    }
    context.editor.value = undefined
    context.errorMessage.value = ''
    context.notice.value = '修改已保存到当前工作副本'
  }

  function cancelEdit(): void {
    const context = getContext()

    context.editor.value = undefined
  }

  function isFavorite(segment: PresetSegmentView): boolean {
    const context = getContext()

    const source = context.sourceSummary.value
    return Boolean(
      source &&
      context.favorites.value.some(
        (favorite) =>
          favorite.sourceResourceId === source.id && favorite.identifier === segment.identifier,
      ),
    )
  }

  function toggleFavorite(segment: PresetSegmentView): void {
    const context = getContext()

    const source = context.sourceSummary.value
    if (!source) return
    const existing = context.favorites.value.find(
      (favorite) =>
        favorite.sourceResourceId === source.id && favorite.identifier === segment.identifier,
    )
    if (existing) {
      context.favorites.value = browserStorageService.setStitchFavorites(
        context.favorites.value.filter((favorite) => favorite.id !== existing.id),
      )
      context.notice.value = `已取消收藏「${segment.name}」`
      return
    }
    const entry = context.buildCurrentSourceEntry(segment.identifier)
    if (!entry) return
    const now = Date.now()
    context.favorites.value = browserStorageService.setStitchFavorites([
      {
        id: crypto.randomUUID(),
        sourceResourceId: source.id,
        sourceName: source.name,
        identifier: entry.identifier,
        name: entry.name,
        role: entry.role,
        content: entry.content,
        prompt: entry.prompt,
        createdAt: now,
        updatedAt: now,
      },
      ...context.favorites.value,
    ])
    context.notice.value = `已收藏「${segment.name}」`
  }

  function removeFavorite(favorite: PresetFavoriteSnapshot): void {
    const context = getContext()

    context.favorites.value = browserStorageService.setStitchFavorites(
      context.favorites.value.filter((item) => item.id !== favorite.id),
    )
    context.notice.value = `已删除收藏「${favorite.name}」`
  }
  return {
    beginSourceEdit,
    beginNewEntry,
    beginTargetEdit,
    beginFavoriteEdit,
    rememberEditorSelection,
    insertVariable,
    openVariableWriter,
    openSlotWriter,
    openSlotWriterForVariable,
    insertPromptSlot,
    insertVariableWrite,
    insertUnreadWrittenVariable,
    copyEntryContent,
    saveEdit,
    cancelEdit,
    isFavorite,
    toggleFavorite,
    removeFavorite,
  }
}
