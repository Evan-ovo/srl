import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import process from 'node:process'
import console from 'node:console'

const sourceRoots = [
  'src',
  'server',
  'cloudflare',
  'workers',
  'scripts',
  'android/app/src/main',
  'android/nativeapp/src/main',
]

export function countSourceLines(source) {
  const text = source.trimEnd()
  return text ? text.split(/\r?\n/u).length : 0
}

export function checkSourceBudgets(files, config) {
  const errors = []
  const actual = new Map(files.map((file) => [file.path, file.lines]))
  for (const file of files) {
    const budget = config.exceptions[file.path]
    const limit = budget?.maxLines ?? config.defaultMaxLines
    if (file.lines > limit)
      errors.push(`${file.path}: ${file.lines} 行，超过 ${limit} 行；请先按职责拆分。`)
  }
  for (const [path, budget] of Object.entries(config.exceptions)) {
    if (!budget.reason?.trim()) errors.push(`${path}: 必须说明保留较长文件的职责原因。`)
    if (!actual.has(path)) errors.push(`${path}: 文件已退出检查范围，请移除旧预算。`)
    else if (actual.get(path) <= config.defaultMaxLines)
      errors.push(`${path}: 已降到默认上限以内，请移除例外。`)
  }
  return errors
}

export function inspectSourceStructure(root) {
  const deleted = new Set(
    execFileSync('git', ['ls-files', '--deleted', '-z', '--', ...sourceRoots], {
      cwd: root,
      encoding: 'utf8',
    }).split('\0'),
  )
  const paths = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...sourceRoots],
    { cwd: root, encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean)
  const files = [...new Set(paths)]
    .filter((path) => !deleted.has(path))
    .filter((path) => /\.(?:ts|vue|js|mjs|java|kt)$/u.test(path))
    .filter((path) => !/(?:\.test\.|\.spec\.|\/(?:tests?|assets|vendor)\/)/u.test(path))
    .map((path) => ({ path, lines: countSourceLines(readFileSync(resolve(root, path), 'utf8')) }))
  const config = JSON.parse(
    readFileSync(resolve(root, 'scripts/SourceStructureBudget.json'), 'utf8'),
  )
  return { files, errors: checkSourceBudgets(files, config) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const result = inspectSourceStructure(root)
  if (result.errors.length) {
    console.error(result.errors.join('\n'))
    process.exitCode = 1
  } else {
    console.log(
      `Source structure: ${result.files.length} 个源码文件通过；既有长文件不允许继续增长。`,
    )
  }
}
