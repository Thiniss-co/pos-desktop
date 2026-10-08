/**
 * The PACKAGED till (electron-builder `--dir` output), not the harness build: the production bundle
 * with the OS print boundary, the files allowlist and the release fuses. Only the API origin differs
 * from a release, because it is baked at build time: a test package targets the disposable backend
 * on loopback and therefore opts in with MAIN_VITE_POS_ALLOW_LOOPBACK_ORIGIN=true.
 *
 * The fuses disable --inspect, so Playwright's Electron launcher cannot attach; the binary is started
 * with --remote-debugging-port and driven through CDP. It runs inside run.mjs's isolated D-Bus session
 * and run-local keyring, with XDG_CONFIG_HOME inside the run directory, and with CUPS_SERVER pointing
 * at a socket that does not exist, so no print job can reach any real printer. See the launch
 * arguments for the one difference from an installed till: Chromium's OS process sandbox is off.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { DESKTOP_ROOT } from './paths.mjs'
import { freePort } from './sandbox.mjs'

export const PACKAGED_BINARY = join(DESKTOP_ROOT, 'dist', 'linux-unpacked', 'pos-desktop')
/** userData inside the profile: the packaged app is named by its productName. */
export const PACKAGED_APP_DIR = 'pos-desktop'

function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: DESKTOP_ROOT, env, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout
}

/** Production build + electron-builder --dir, exactly as `npm run build:unpack` minus typecheck. */
export function buildPackagedApp(origin, { allowLoopback }) {
  const env = { ...process.env, MAIN_VITE_POS_API_ORIGIN: origin }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.POS_PRINT_BOUNDARY
  delete env.MAIN_VITE_POS_ALLOW_LOOPBACK_ORIGIN
  if (allowLoopback) env.MAIN_VITE_POS_ALLOW_LOOPBACK_ORIGIN = 'true'
  run('npx', ['electron-vite', 'build'], env)
  run('npx', ['electron-builder', '--dir', '--publish', 'never'], env)
  if (!existsSync(PACKAGED_BINARY)) throw new Error(`no packaged binary at ${PACKAGED_BINARY}`)
  return PACKAGED_BINARY
}

/** The fuses actually written into the packaged binary, as `@electron/fuses read` reports them. */
export function readFuses() {
  const output = run('npx', ['--no-install', '@electron/fuses', 'read', '--app', PACKAGED_BINARY], {
    ...process.env,
    NO_COLOR: '1',
    FORCE_COLOR: '0'
  })
  return Object.fromEntries(
    // eslint-disable-next-line no-control-regex
    [...output.replace(/\u001b\[[0-9;]*m/g, '').matchAll(/^\s*(\w+) is (Enabled|Disabled)/gm)].map(
      (match) => [match[1], match[2] === 'Enabled']
    )
  )
}

async function waitForDebugger(port, child) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the packaged app exited (${child.exitCode})`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('the packaged app never opened its debugging port')
}

async function rendererPage(browser) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      const page = context
        .pages()
        .find((candidate) => candidate.url().includes('/renderer/index.html'))
      if (page) {
        await page.waitForLoadState('domcontentloaded')
        await page.waitForFunction(() => Boolean(document.querySelector('#app')?.__vue_app__))
        return page
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('the packaged renderer window never appeared')
}

/** Every packaged till a journey started; the runner kills the survivors after each journey. */
const livePackagedApps = new Set()

export function stopAllPackagedApps() {
  let leftRunning = 0
  for (const child of livePackagedApps) {
    if (child.exitCode === null && child.signalCode === null) {
      leftRunning += 1
      child.kill('SIGKILL')
    }
  }
  livePackagedApps.clear()
  return leftRunning
}

export async function launchPackagedApp({
  runDir,
  profileDir,
  width = 1366,
  height = 850,
  // A run-local HOME (e.g. with an isolated NSS trust store, see tlsBackend.mjs); never the real one.
  home = process.env.HOME
}) {
  if (profileDir.includes('/.config/pos-desktop')) {
    throw new Error('refusing to use a real workstation profile')
  }
  mkdirSync(profileDir, { recursive: true })
  const port = await freePort()
  const logs = []
  const child = spawn(
    PACKAGED_BINARY,
    [
      `--remote-debugging-port=${port}`,
      '--password-store=gnome-libsecret',
      '--ozone-platform=x11',
      // Ubuntu 24+ denies unprivileged user namespaces to unconfined binaries, so Chromium falls back
      // to the setuid chrome-sandbox, which must be root-owned 4755. The .deb installs an AppArmor
      // profile (or the setuid bit) for that; an unpacked directory cannot have either without root.
      // The test launch therefore turns off Chromium's OS process sandbox only (as
      // scripts/runReceiptRenderCheck.mjs does); the app's own webPreferences are unchanged.
      '--no-sandbox'
    ],
    {
      cwd: runDir,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        DISPLAY: process.env.DISPLAY ?? ':0',
        XAUTHORITY: process.env.XAUTHORITY ?? '',
        XDG_CONFIG_HOME: profileDir,
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
        XDG_DATA_HOME: process.env.XDG_DATA_HOME,
        DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
        LANG: 'en_US.UTF-8',
        // No print job can leave this run: the CUPS client talks to a socket that does not exist.
        CUPS_SERVER: join(runDir, 'no-cups-server.sock'),
        POS_API_TRACE: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  livePackagedApps.add(child)
  child.stdout.on('data', (chunk) => logs.push(String(chunk)))
  child.stderr.on('data', (chunk) => logs.push(String(chunk)))
  await waitForDebugger(port, child)
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  const page = await rendererPage(browser)
  // Size the real window (there is no Electron handle under CDP); fall back to a viewport override
  // where Electron's CDP lacks the Browser window domain.
  try {
    const targetId = (await (await page.context().newCDPSession(page)).send('Target.getTargetInfo'))
      .targetInfo.targetId
    const browserSession = await browser.newBrowserCDPSession()
    const { windowId } = await browserSession.send('Browser.getWindowForTarget', { targetId })
    await browserSession.send('Browser.setWindowBounds', { windowId, bounds: { width, height } })
  } catch {
    await page.setViewportSize({ width, height })
  }
  await page.waitForTimeout(500)

  async function close() {
    await browser.close().catch(() => undefined)
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          resolve()
        }, 10_000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }

  return { child, browser, page, logs, close }
}
