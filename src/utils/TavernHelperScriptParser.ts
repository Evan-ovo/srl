/*
 * Implements JS-Slash-Runner 4.8.19 character-script data compatibility.
 * Modified for SRL by jixiangruyi117 on 2026-08-09: read-only extraction and stable ordering.
 * Distributed under the Aladdin Free Public License, Version 9.
 */

import type { PreviewRuntimeScript } from './RichContentPreview'
import { isRecord } from './UnknownValue'

export interface ExtractScriptOptions {
  source: NonNullable<PreviewRuntimeScript['source']>
  fallbackName?: string
}

export interface HelperScriptRecord extends PreviewRuntimeScript {
  id: string
  source: NonNullable<PreviewRuntimeScript['source']>
  folder: string
  info: string
  buttons: string[]
  enabled: boolean
}

/** Visits recognized leaves while retaining folders, wrappers and unknown records. */
export function mapTavernHelperScriptTrees(
  values: unknown[],
  visit: (script: HelperScriptRecord, raw: Record<string, unknown>, key: string) => boolean,
  prefix: string,
  folder = '',
): unknown[] {
  return values.flatMap((node, index) => {
    if (!isRecord(node)) return [node]
    const key = `${prefix}/${index}`
    const childrenKey = Array.isArray(node.scripts) ? 'scripts' : 'value'
    if (node.type === 'folder' && Array.isArray(node[childrenKey])) {
      return [
        {
          ...node,
          [childrenKey]: mapTavernHelperScriptTrees(
            node[childrenKey],
            visit,
            key,
            readString(node.name) || folder,
          ),
        },
      ]
    }
    const script = toScript(node, index, { source: 'character' }, folder)
    const raw = node.type === 'script' && isRecord(node.value) ? node.value : node
    return !script || visit(script, raw, key) ? [node] : []
  })
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeSettingsRecord(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value
  if (!Array.isArray(value)) return undefined
  try {
    const entries = value.filter(
      (entry): entry is [string, unknown] =>
        Array.isArray(entry) && entry.length >= 2 && typeof entry[0] === 'string',
    )
    return Object.fromEntries(entries)
  } catch {
    return undefined
  }
}

function buttonNames(value: Record<string, unknown>): string[] {
  const button = isRecord(value.button) ? value.button : undefined
  const values = Array.isArray(button?.buttons)
    ? button.buttons
    : Array.isArray(value.buttons)
      ? value.buttons
      : []
  return values
    .filter(isRecord)
    .map((item) => readString(item.name))
    .filter(Boolean)
}

function toScript(
  value: unknown,
  index: number,
  options: ExtractScriptOptions,
  folder = '',
  inheritedEnabled = true,
): HelperScriptRecord | undefined {
  if (!isRecord(value)) return undefined
  const scriptValue = value.type === 'script' && isRecord(value.value) ? value.value : value
  const content = readString(scriptValue.content) || readString(scriptValue.script)
  const hasTypedShape = value.type === 'script'
  const hasLegacyShape =
    Boolean(content) &&
    (typeof scriptValue.id === 'string' ||
      typeof scriptValue.name === 'string' ||
      typeof scriptValue.info === 'string' ||
      Array.isArray(scriptValue.buttons))
  if ((!hasTypedShape && !hasLegacyShape) || !content) return undefined

  const name =
    readString(scriptValue.name) ||
    options.fallbackName ||
    `${options.source === 'character' ? '角色卡脚本' : '绑定脚本'} ${index + 1}`
  return {
    id: readString(scriptValue.id) || `${options.source}-${folder || 'root'}-${index}`,
    source: options.source,
    folder,
    name,
    info: readString(scriptValue.info),
    content,
    data: isRecord(scriptValue.data) ? scriptValue.data : {},
    enabled: inheritedEnabled && scriptValue.enabled === true,
    buttons: buttonNames(scriptValue),
    buttonDefinitions: (() => {
      const button = isRecord(scriptValue.button) ? scriptValue.button : undefined
      const entries = Array.isArray(button?.buttons)
        ? button.buttons
        : Array.isArray(scriptValue.buttonDefinitions)
          ? scriptValue.buttonDefinitions
          : Array.isArray(scriptValue.buttons)
            ? scriptValue.buttons
            : []
      return entries.flatMap((entry) =>
        isRecord(entry) && readString(entry.name)
          ? [
              {
                name: readString(entry.name),
                visible: button?.enabled !== false && entry.visible === true,
              },
            ]
          : typeof entry === 'string' && entry.trim()
            ? [{ name: entry, visible: true }]
            : [],
      )
    })(),
  }
}

function flattenTrees(
  values: unknown[],
  options: ExtractScriptOptions,
  inheritedEnabled = true,
): HelperScriptRecord[] {
  return values.flatMap((tree, treeIndex) => {
    if (!isRecord(tree)) return []
    const modernChildren = Array.isArray(tree.scripts) ? tree.scripts : undefined
    const legacyChildren = Array.isArray(tree.value) ? tree.value : undefined
    if (tree.type === 'folder' && (modernChildren || legacyChildren)) {
      const folder = readString(tree.name) || `文件夹 ${treeIndex + 1}`
      const folderEnabled = inheritedEnabled && (legacyChildren ? true : tree.enabled === true)
      return flattenTrees(
        (modernChildren ?? legacyChildren ?? []).map((script) =>
          isRecord(script) && !readString(script.folder) ? { ...script, folder } : script,
        ),
        options,
        folderEnabled,
      ).map((script) => ({ ...script, folder: script.folder || folder }))
    }
    const script = toScript(tree, treeIndex, options, readString(tree.folder), inheritedEnabled)
    return script ? [script] : []
  })
}

export function extractTavernHelperScripts(
  value: unknown,
  options: ExtractScriptOptions,
): HelperScriptRecord[] {
  if (typeof value === 'string') {
    const content = value.trim()
    if (!content) return []
    return [
      {
        id: `${options.source}-plain`,
        source: options.source,
        folder: '',
        name: options.fallbackName || '用户脚本',
        info: '',
        content,
        enabled: true,
        buttons: [],
      },
    ]
  }
  if (Array.isArray(value)) return flattenTrees(value, options)
  if (!isRecord(value)) return []

  const extensions = isRecord(value.extensions) ? value.extensions : undefined
  const helper = normalizeSettingsRecord(extensions?.tavern_helper)
  const scriptSettings = normalizeSettingsRecord(value.script)
  const legacyScripts = Array.isArray(extensions?.TavernHelper_scripts)
    ? extensions.TavernHelper_scripts
    : []
  const sources = [
    Array.isArray(value.scripts) ? value.scripts : [],
    Array.isArray(scriptSettings?.scripts) ? scriptSettings.scripts : [],
    Array.isArray(helper?.scripts) ? helper.scripts : [],
    legacyScripts,
  ]
  const direct = toScript(value, 0, options)
  const scripts = [
    ...(direct ? [direct] : []),
    ...sources.flatMap((items) => flattenTrees(items, options)),
  ]
  const seen = new Set<string>()
  return scripts.filter((script) => {
    const key = `${script.id}\u0000${script.content}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export async function readTavernHelperScriptBlob(
  blob: Pick<Blob, 'text'>,
  fileName: string,
  options: ExtractScriptOptions,
): Promise<HelperScriptRecord[]> {
  const text = await blob.text()
  const trimmed = text.trim()
  if (!trimmed) return []
  if (fileName.toLocaleLowerCase().endsWith('.json') || /^[{[]/.test(trimmed)) {
    try {
      return extractTavernHelperScripts(JSON.parse(trimmed) as unknown, options)
    } catch {
      // A JavaScript file may legitimately start with an array or object literal.
    }
  }
  return extractTavernHelperScripts(trimmed, options)
}
