import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [entry] = process.argv.slice(2)

if (!entry) {
  console.error('Usage: node scripts/runElectronNode.mjs <entry-path>')
  process.exitCode = 1
} else {
  const sourcePath = resolve(projectRoot, entry)

  if (!existsSync(sourcePath)) {
    console.error(`Electron Node entry does not exist: ${sourcePath}`)
    process.exitCode = 1
  } else {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'pos-desktop-electron-node-'))
    const bundlePath = join(temporaryDirectory, 'entry.cjs')
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
          '--target=node22',
          '--alias:@shared=./src/shared',
          '--external:better-sqlite3',
          '--external:electron',
          `--outfile=${bundlePath}`
        ],
        { cwd: projectRoot, stdio: 'inherit' }
      )

      if (bundleResult.status !== 0) {
        process.exitCode = bundleResult.status ?? 1
      } else {
        const runResult = spawnSync(electronPath, [bundlePath], {
          cwd: projectRoot,
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            NODE_OPTIONS: '--enable-source-maps',
            NODE_PATH: join(projectRoot, 'node_modules')
          },
          stdio: 'inherit'
        })

        process.exitCode = runResult.status ?? 1
      }
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true })
    }
  }
}
