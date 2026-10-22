/* better-sqlite3 为 Electron ABI 编译；用同一运行时执行 Vitest，避免来回重编译。 */
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const runtime = require('electron')
const cli = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
const result = spawnSync(runtime, [cli, 'run', '--maxWorkers=2', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
})
process.exit(result.status ?? 1)
