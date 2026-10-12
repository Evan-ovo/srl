import postcss from 'postcss'
import type { ReferenceSource } from '../types/AppearanceReference.js'

/** The build and installed-APP reader use the same CSS interpretation. No styles are executed. */
export function parseAppearanceCss(
  content: string,
  path: string,
  line = 1,
  onImport?: (specifier: string) => void,
): ReferenceSource {
  const source: ReferenceSource = { path: `${path}:${line}`, rules: [] }
  const root = postcss.parse(content)
  if (onImport)
    root.walkAtRules('import', (rule) => {
      const target = rule.params.match(/^(?:url\(\s*)?(?:['"]([^'"]+)['"]|([^\s)]+))/u)
      if (target) onImport(target[1] ?? target[2]!)
    })
  const collect = (rule: postcss.Rule | postcss.AtRule, selector: string) => {
    const conditions: string[] = []
    for (let parent: postcss.AnyNode | undefined = rule.parent; parent; parent = parent.parent)
      if (parent.type === 'atrule') conditions.unshift(`@${parent.name} ${parent.params}`)
    const declarations: Record<string, string> = {}
    rule.nodes?.forEach((node) => {
      if (node.type === 'decl')
        declarations[node.prop] = node.value + (node.important ? ' !important' : '')
    })
    source.rules.push({
      line: line + (rule.source?.start?.line ?? 1) - 1,
      selector,
      conditions: conditions.join(' / '),
      declarations,
    })
  }
  root.walkRules((rule) => collect(rule, rule.selector))
  root.walkAtRules('property', (rule) => {
    if (rule.params.startsWith('--')) {
      const initial = rule.nodes?.find(
        (node) => node.type === 'decl' && node.prop === 'initial-value',
      )
      if (initial?.type === 'decl')
        source.rules.push({
          selector: `@property ${rule.params}`,
          conditions: '',
          line: line + (rule.source?.start?.line ?? 1) - 1,
          declarations: { [rule.params]: initial.value },
        })
    }
  })
  return source
}
