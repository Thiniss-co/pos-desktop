#!/usr/bin/env node
/**
 * Playwright ↔ real Electron ↔ disposable Laravel journeys.
 *
 *   node tests/playwright/run.mjs <journey> [<journey> ...]
 *
 * Isolation (all inside one per-run directory under the system temp dir):
 *  - a private D-Bus session with a run-local, unlocked gnome-keyring (XDG_RUNTIME_DIR and
 *    XDG_DATA_HOME point into the run directory, so the user's real keyring is never opened);
 *  - an isolated Electron profile (XDG_CONFIG_HOME) per launch;
 *  - a disposable SQLite Laravel backend written only through the guarded PHP entry points.
 * `ELECTRON_RUN_AS_NODE` is removed from every child environment.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EVIDENCE_ROOT } from './support/paths.mjs'

const SELF = fileURLToPath(import.meta.url)
const journeys = process.argv.slice(2)

if (journeys.length === 0) {
  // A run that names no journey would test nothing; it must never read as a pass.
  console.error('usage: node tests/playwright/run.mjs <journey> [<journey> ...]')
  process.exit(2)
}

if (process.env.PW_WRAPPED !== '1') {
  const runDir = mkdtempSync(join(realpathSync(tmpdir()), 'pos-pw-'))
  const runtime = join(runDir, 'runtime')
  mkdirSync(runtime, { recursive: true })
  chmodSync(runtime, 0o700)
  mkdirSync(join(runDir, 'data'), { recursive: true })
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DISPLAY: process.env.DISPLAY ?? ':0',
    XAUTHORITY: process.env.XAUTHORITY ?? '',
    LANG: 'C.UTF-8',
    XDG_RUNTIME_DIR: runtime,
    XDG_DATA_HOME: join(runDir, 'data'),
    PW_WRAPPED: '1',
    PW_RUN_DIR: runDir,
    // Optional: an explicit Chrome for journeys that drive the owner portal (default: the installed Chrome).
    PW_CHROME_PATH: process.env.PW_CHROME_PATH ?? '',
    // Optional: the backend tree the disposable sandbox runs from (see support/paths.mjs).
    PW_BACKEND_ROOT: process.env.PW_BACKEND_ROOT ?? '',
    // Optional: the audit folder journey evidence is written to (see support/paths.mjs).
    PW_EVIDENCE_ROOT: process.env.PW_EVIDENCE_ROOT ?? '',
    // Opt-in: serve the disposable backend through the guarded HTTP router (see support/sandbox.mjs).
    POS_SANDBOX_GUARD_HTTP: process.env.POS_SANDBOX_GUARD_HTTP === '1' ? '1' : ''
  }
  const script =
    'printf "pw-run" | gnome-keyring-daemon --unlock --components=secrets --daemonize >/dev/null 2>&1; exec node "$0" "$@"'
  const result = spawnSync('dbus-run-session', ['--', 'sh', '-c', script, SELF, ...journeys], {
    env,
    stdio: 'inherit'
  })
  console.log(`[pw] run directory: ${runDir}`)
  process.exit(result.status ?? 1)
}

const runDir = process.env.PW_RUN_DIR
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
let failures = 0

for (const name of journeys) {
  const evidenceDir = join(EVIDENCE_ROOT, 'playwright', name)
  mkdirSync(evidenceDir, { recursive: true })
  const facts = { journey: name, startedAt: new Date().toISOString(), runDir, steps: [] }
  const ctx = {
    runDir: join(runDir, name),
    evidenceDir,
    facts,
    step(label, detail = {}) {
      facts.steps.push({ at: new Date().toISOString(), label, ...detail })
      console.log(
        `[pw:${name}] ${label}${Object.keys(detail).length ? ' ' + JSON.stringify(detail) : ''}`
      )
    },
    async shot(page, label) {
      const file = join(evidenceDir, `${label}.png`)
      await page.screenshot({ path: file })
      facts.steps.push({ at: new Date().toISOString(), screenshot: `${label}.png` })
      return file
    }
  }
  mkdirSync(ctx.runDir, { recursive: true })
  try {
    const module = await import(`./journeys/${name}.mjs`)
    await module.run(ctx)
    facts.result = 'passed'
  } catch (error) {
    failures += 1
    facts.result = 'failed'
    facts.error = String(error?.stack ?? error)
    // Main-process trace (API, install, renewal, upload lines) for diagnosing the failure.
    facts.failureTrace = (ctx.session?.logs ?? [])
      .join('')
      .split('\n')
      .filter((line) => /\[pos-|error|Error/.test(line))
      .slice(-150)
    console.error(`[pw:${name}] FAILED\n${facts.error}`)
  } finally {
    facts.finishedAt = new Date().toISOString()
    writeFileSync(join(evidenceDir, `result-${stamp}.json`), JSON.stringify(facts, null, 2))
  }
}

process.exit(failures === 0 ? 0 : 1)
