/**
 * Real Electron under Playwright: the built main process, preload and renderer, launched with an
 * isolated profile (XDG_CONFIG_HOME inside the run directory) against the disposable backend.
 *
 * The process must already run inside the isolated D-Bus session with an unlocked, run-local
 * gnome-keyring (see `run.mjs`), because the app's secure storage is Electron `safeStorage`.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { DESKTOP_ROOT } from './paths.mjs'

const require = createRequire(import.meta.url)
const builtFor = new Map()

export function buildApp(origin) {
  const outDir = join(DESKTOP_ROOT, 'out', 'pw-test')
  if (builtFor.get(outDir) === origin && existsSync(join(outDir, 'main', 'index.js'))) {
    return outDir
  }
  // POS_PRINT_BOUNDARY=virtual compiles the controlled print destination instead of the OS spooler
  // boundary (src/main/receipt/printBoundary.types.ts): no journey can reach a physical printer.
  const env = { ...process.env, MAIN_VITE_POS_API_ORIGIN: origin, POS_PRINT_BOUNDARY: 'virtual' }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync('npx', ['electron-vite', 'build', '--outDir', outDir], {
    cwd: DESKTOP_ROOT,
    env,
    encoding: 'utf8'
  })
  if (result.status !== 0) {
    throw new Error(`electron-vite build failed:\n${result.stdout}\n${result.stderr}`)
  }
  builtFor.set(outDir, origin)
  return outDir
}

export async function launchApp({ outDir, profileDir, trace = true, extraEnv = {} }) {
  if (profileDir.includes('/.config/pos-desktop')) {
    throw new Error('refusing to use a real workstation profile')
  }
  mkdirSync(profileDir, { recursive: true })
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DISPLAY: process.env.DISPLAY ?? ':0',
    XAUTHORITY: process.env.XAUTHORITY ?? '',
    XDG_CONFIG_HOME: profileDir,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
    LANG: 'en_US.UTF-8',
    // The virtual print destination of the harness build: PDFs land next to the isolated profile.
    POS_VIRTUAL_PRINT_DIR: virtualPrintDir(profileDir),
    ...(trace ? { POS_API_TRACE: '1' } : {}),
    ...extraEnv
  }
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [
      join(outDir, 'main', 'index.js'),
      '--password-store=gnome-libsecret',
      '--ozone-platform=x11'
    ],
    env,
    cwd: DESKTOP_ROOT,
    timeout: 60_000
  })
  const logs = []
  const child = app.process()
  child.stdout?.on('data', (chunk) => logs.push(String(chunk)))
  child.stderr?.on('data', (chunk) => logs.push(String(chunk)))
  const page = await mainWindow(app)
  return { app, page, logs }
}

/** Where the harness build's virtual printer writes its jobs for a given isolated profile. */
export function virtualPrintDir(profileDir) {
  return join(profileDir, 'virtual-printer')
}

export async function mainWindow(app) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const found = app.windows().find((w) => w.url().includes('/renderer/index.html'))
    if (found) {
      await found.waitForLoadState('domcontentloaded')
      return found
    }
    await app.waitForEvent('window', { timeout: 5_000 }).catch(() => undefined)
  }
  throw new Error('the renderer window never appeared')
}

/** Translate through the running app's i18n, so journeys work in EN and AR. */
export async function t(page, key, params) {
  return await page.evaluate(
    ([k, p]) => document.querySelector('#app').__vue_app__.config.globalProperties.$t(k, p ?? {}),
    [key, params ?? null]
  )
}

export async function store(page, id, fn, arg) {
  return await page.evaluate(
    ([storeId, source, a]) => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
      const s = pinia._s.get(storeId)
      return new Function('s', 'a', source)(s, a)
    },
    [id, fn, arg ?? null]
  )
}
