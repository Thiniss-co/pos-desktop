import { mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'pos-desktop-electron-smoke-'))
const bundlePath = join(temporaryDirectory, 'database-smoke.cjs')
const sourcePath = join(projectRoot, 'scripts', 'databaseSmoke.ts')
const esbuildPath = join(projectRoot, 'node_modules', '.bin', 'esbuild')
const electronPath = join(projectRoot, 'node_modules', '.bin', 'electron')

try {
  const bundleResult = spawnSync(
    esbuildPath,
    [
      sourcePath,
      '--bundle',
      '--platform=node',
      '--format=cjs',
      '--external:better-sqlite3',
      '--external:electron',
      `--outfile=${bundlePath}`
    ],
    { cwd: projectRoot, stdio: 'inherit' }
  )

  if (bundleResult.status !== 0) {
    process.exitCode = bundleResult.status ?? 1
  } else {
    const smokeResult = spawnSync(electronPath, [bundlePath], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_PATH: join(projectRoot, 'node_modules')
      },
      stdio: 'inherit'
    })

    process.exitCode = smokeResult.status ?? 1
  }
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true })
}
