import { spawnSync } from 'node:child_process'
import process from 'node:process'

const run = `reader-${Date.now()}-${process.pid}`
const port = 5200 + (process.pid % 3000)
const result = spawnSync(
  process.execPath,
  ['scripts/Run-IsolatedAudit.mjs', '--suite', 'reader-native', '--run', run, '--port', String(port)],
  { stdio: 'inherit', windowsHide: true },
)

if (result.error)
  throw result.error

process.exit(result.status ?? 1)
