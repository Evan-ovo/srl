import { createHash } from 'node:crypto'
import process from 'node:process'
import console from 'node:console'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const hash = (value) => createHash('sha256').update(value).digest('hex')
/** Bounded owner fingerprints, not a project-wide source scan. */
export async function checkAssistantKnowledge(root = process.cwd(), read = readFile) {
  const manifest = JSON.parse(
    await read(resolve(root, 'src/core/ProductAssistantKnowledgeSources.json'), 'utf8'),
  )
  const knowledge = await read(resolve(root, 'src/core/ProductAssistantKnowledge.ts'))
  const failures = []
  if (hash(knowledge) !== manifest.knowledgeSha256)
    failures.push('ProductAssistantKnowledge.ts 的说明已变化')
  for (const item of manifest.sources) {
    if (!/^src\/[\w/-]+\.(?:ts|vue|js)$/u.test(item.path) || !item.guides?.length)
      throw new Error('助手知识源清单无效')
    const source = await read(resolve(root, item.path))
    if (hash(source) !== item.sha256) failures.push(`${item.path} → ${item.guides.join('、')}`)
  }
  const guideIds = [...knowledge.toString('utf8').matchAll(/id: '([^']+)'/gu)].map(
    (match) => match[1],
  )
  for (const id of guideIds)
    if (!manifest.sources.some((item) => item.guides.includes(id)))
      failures.push(`功能说明 ${id} 未登记知识源`)
  if (failures.length)
    throw new Error(
      `蒜惹菈知识需要复核：\n${failures.join('\n')}\n核对入口/步骤/权限/工具，更新实际变化的说明，再刷新 ProductAssistantKnowledgeSources.json 的对应 SHA256；不能仅刷新指纹跳过复核。`,
    )
  return manifest.sources.length
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(`蒜惹菈知识源检查通过（${await checkAssistantKnowledge()} 个 Owner）`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
