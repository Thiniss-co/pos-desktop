import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Runs the receipt render check against REAL Electron (not ELECTRON_RUN_AS_NODE) so it exercises
 * a genuine hidden BrowserWindow, real Chromium layout/pagination and real printToPDF/capturePage
 * output. Needs a real DISPLAY. See scripts/receiptRenderCheck.entry.ts.
 */

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entry = resolve(projectRoot, 'scripts/receiptRenderCheck.entry.ts')

if (!existsSync(entry)) {
  console.error(`Entry does not exist: ${entry}`)
  process.exit(1)
}

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'pos-desktop-receipt-render-'))
const bundlePath = join(temporaryDirectory, 'entry.cjs')
const esbuildPath = join(projectRoot, 'node_modules', '.bin', 'esbuild')
const electronPath = join(projectRoot, 'node_modules', '.bin', 'electron')

try {
  const bundleResult = spawnSync(
    esbuildPath,
    [
      entry,
      '--bundle',
      '--platform=node',
      '--format=cjs',
      '--target=node22',
      '--alias:@shared=./src/shared',
      // Test bundles never reach an OS spooler (src/main/receipt/printBoundary.types.ts).
      '--alias:@printBoundary=./src/main/receipt/printBoundary.virtual.ts',
      '--external:electron',
      `--outfile=${bundlePath}`
    ],
    { cwd: projectRoot, stdio: 'inherit' }
  )

  if (bundleResult.status !== 0) {
    process.exitCode = bundleResult.status ?? 1
  } else {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    env.ELECTRON_DISABLE_SANDBOX = '1'

    // Chromium GPU/sandbox/ozone flags for this Linux host -- `--ozone-platform=x11` matches the
    // project's own existing `dev:linux` script (package.json) exactly; without it the GPU process
    // segfaults in this environment. These are Chromium's OWN process sandbox and GPU stack,
    // unrelated to, and not a weakening of, this app's `webPreferences.sandbox: true` renderer
    // security setting used throughout the codebase.
    const runResult = spawnSync(
      electronPath,
      [
        '--ozone-platform=x11',
        '--disable-gpu',
        '--in-process-gpu',
        '--disable-software-rasterizer',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        bundlePath
      ],
      {
        cwd: projectRoot,
        env,
        stdio: 'inherit'
      }
    )

    process.exitCode = runResult.status ?? 1
  }
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true })
}
