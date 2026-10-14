import { CARD_REFERENCE, createReferenceChapters } from '../core/AppearanceReference'
import type { AppearanceScope } from '../core/AppearanceScopes'
import type { ReferenceCatalog } from '../types/AppearanceReference'

/** A bounded view of the existing manual; not a second CSS source registry. */
export function assistantAppearanceReference(
  catalog: ReferenceCatalog,
  scope: AppearanceScope,
  query = '',
  offset = 0,
) {
  const chapter = createReferenceChapters(catalog).find((item) => item.scope.value === scope.value)
  if (!chapter) throw new Error('该区域没有CSS接口章节')
  const keyword = query.trim().toLowerCase()
  const rules = chapter.sources
    .flatMap((source) => source.rules.map((rule) => ({ source: source.path, ...rule })))
    .filter((rule) => !keyword || JSON.stringify(rule).toLowerCase().includes(keyword))
  const page = rules.slice(offset, offset + 20)
  const names = new Set(
    page.flatMap((rule) => [
      ...Object.keys(rule.declarations).filter((name) => name.startsWith('--')),
      ...Object.values(rule.declarations).flatMap((value) =>
        [...value.matchAll(/var\(\s*(--[^\s,)]+)/gu)].map((match) => match[1]!),
      ),
    ]),
  )
  const variables = chapter.variables.filter(
    (item) =>
      names.has(item.name) ||
      (keyword && `${item.name} ${item.meaning}`.toLowerCase().includes(keyword)),
  )
  return {
    version: chapter.installed ?? { version: catalog.version, fingerprint: catalog.fingerprint },
    sourceKind: chapter.installed ? 'installed-app' : 'host-source',
    query,
    offset,
    total: rules.length,
    nextOffset: offset + page.length < rules.length ? offset + page.length : null,
    rules: page,
    variables: variables.map(({ name, meaning, definitions }) => ({ name, meaning, definitions })),
    layoutContract: CARD_REFERENCE,
    hint: '规则条件、顺序和来源均保留；本页并非完整CSS，未找到时换关键词或翻页。变量定义不等于当前计算值，以inspect_ui为准。',
  }
}
