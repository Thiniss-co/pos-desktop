#!/usr/bin/env node
/**
 * Proves the build-time print-boundary selection on real build output
 * (src/main/receipt/printBoundary.types.ts):
 *  - a default (production) build contains the OS spooler boundary and NO virtual destination;
 *  - the harness build (POS_PRINT_BOUNDARY=virtual) contains the virtual destination and NO OS print
 *    call, so no Playwright journey can reach a physical printer.
 *
 *   node scripts/verifyPrintBoundary.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Stage 7: the fault-injection seams (admission hold, QR-capture delay) exist only in the virtual destination.
const VIRTUAL_MARKERS = [
  'PW-Virtual-80',
  'POS_VIRTUAL_PRINT_DIR',
  'hold-auto-admission',
  'qr-capture-delay-ms'
]
const OS_PRINT_CALL = /\.print\(\s*\{/
const OS_PRINTER_LIST = 'getPrintersAsync'

function build(outDir, extraEnv) {
  const env = { ...process.env, ...extraEnv }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.POS_PRINT_BOUNDARY
  Object.assign(env, extraEnv)
  const result = spawnSync('npx', ['electron-vite', 'build', '--outDir', outDir], {
    cwd: projectRoot,
    env,
    encoding: 'utf8'
  })
  if (result.status !== 0) {
    throw new Error(`electron-vite build failed:\n${result.stdout}\n${result.stderr}`)
  }
}

function mainBundle(outDir) {
  const mainDir = join(outDir, 'main')
  return readdirSync(mainDir)
    .filter((file) => file.endsWith('.js'))
    .map((file) => readFileSync(join(mainDir, file), 'utf8'))
    .join('\n')
}

const work = mkdtempSync(join(tmpdir(), 'pos-print-boundary-'))
const failures = []
try {
  const production = join(work, 'production')
  const harness = join(work, 'harness')
  build(production, {})
  build(harness, { POS_PRINT_BOUNDARY: 'virtual' })

  const prod = mainBundle(production)
  for (const marker of VIRTUAL_MARKERS) {
    if (prod.includes(marker)) failures.push(`production bundle contains virtual marker ${marker}`)
  }
  if (!OS_PRINT_CALL.test(prod)) failures.push('production bundle lacks the OS print call')
  if (!prod.includes(OS_PRINTER_LIST)) failures.push('production bundle lacks the OS printer list')

  const test = mainBundle(harness)
  for (const marker of VIRTUAL_MARKERS) {
    if (!test.includes(marker)) failures.push(`harness bundle lacks virtual marker ${marker}`)
  }
  if (OS_PRINT_CALL.test(test)) failures.push('harness bundle contains an OS print call')
  if (test.includes(OS_PRINTER_LIST)) failures.push('harness bundle contains the OS printer list')
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`verify:print-boundary: ${failure}`)
  process.exit(1)
}
console.log(
  'verify:print-boundary: production build = OS boundary only; harness build = virtual destination only'
)
