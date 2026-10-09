/**
 * Process control for a PACKAGED till driven over CDP, so one journey (`wintill`) runs against:
 *  - `local`: the Linux package on this machine (launchPackagedApp), to prove the journey itself;
 *  - `vbox`:  the NSIS-installed till inside a DISPOSABLE Windows VM (VirtualBox), started in the
 *    cashier's interactive session by the scheduled task that tests/windows/Set-AcceptanceGuest.ps1
 *    creates, and reached through a NAT port forward (host 127.0.0.1:<cdp port> → guest).
 *
 * A controller starts the till and returns its renderer page, hard-kills it (a power cut), or quits
 * it normally. The vbox controller refuses any VM not named `thinis-pos-win11-acceptance*`: it never
 * touches another machine (the owner's lab VMs included).
 */
import { spawnSync } from 'node:child_process'
import { chromium } from 'playwright-core'
import { queryLocal } from './localDb.mjs'
import { launchPackagedApp, PACKAGED_APP_DIR, rendererPage } from './packagedApp.mjs'

const VM_NAME = /^thinis-pos-win11-acceptance[A-Za-z0-9-]*$/

export function localTillController({ runDir, profileDir, binary }) {
  let session = null
  return {
    kind: 'local',
    async start() {
      session = await launchPackagedApp({ runDir, profileDir, binary })
      return session.page
    },
    async kill() {
      const exited = new Promise((resolve) => session.child.once('exit', resolve))
      session.child.kill('SIGKILL')
      await exited
      await session.browser.close().catch(() => undefined)
      session = null
    },
    async quit() {
      await session.close()
      session = null
    },
    /** The till's local database (closed or open, read-only). */
    query(sql) {
      return queryLocal(profileDir, sql, [], PACKAGED_APP_DIR)
    },
    logs() {
      return session?.logs ?? []
    },
    async stop() {
      if (session) await session.close().catch(() => undefined)
      session = null
    }
  }
}

export function vboxTillController({
  vm,
  username,
  passwordFile,
  cdpUrl,
  taskName = 'ThinisPosTill',
  width = 1366,
  height = 850
}) {
  if (!VM_NAME.test(vm ?? '')) {
    throw new Error(`refusing VM ${vm}: only a disposable thinis-pos-win11-acceptance* VM`)
  }
  if (!username || !passwordFile || !cdpUrl) {
    throw new Error('vbox controller: username, passwordFile and cdpUrl are required')
  }
  let browser = null

  function guest(exe, args) {
    // `run -- <program> <args>`: without --exe the first argument is the program (VBoxManage 7).
    const result = spawnSync(
      'VBoxManage',
      ['guestcontrol', vm, 'run', '--username', username, '--passwordfile', passwordFile].concat([
        '--wait-stdout',
        '--wait-stderr',
        '--',
        exe,
        ...args
      ]),
      { encoding: 'utf8', timeout: 60_000 }
    )
    return { status: result.status, stdout: result.stdout, stderr: result.stderr }
  }

  async function cdpReachable() {
    try {
      return (await fetch(`${cdpUrl}/json/version`)).ok
    } catch {
      return false
    }
  }

  async function until(predicate, label, timeout = 90_000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (await predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    throw new Error(`vbox controller: ${label}`)
  }

  return {
    kind: 'vbox',
    async start() {
      const run = guest('C:\\Windows\\System32\\schtasks.exe', ['/run', '/tn', taskName])
      if (run.status !== 0) throw new Error(`schtasks /run failed: ${run.stderr || run.stdout}`)
      await until(cdpReachable, 'the till never opened its debugging port')
      browser = await chromium.connectOverCDP(cdpUrl)
      const page = await rendererPage(browser)
      try {
        const targetId = (
          await (await page.context().newCDPSession(page)).send('Target.getTargetInfo')
        ).targetInfo.targetId
        const session = await browser.newBrowserCDPSession()
        const { windowId } = await session.send('Browser.getWindowForTarget', { targetId })
        await session.send('Browser.setWindowBounds', { windowId, bounds: { width, height } })
      } catch {
        await page.setViewportSize({ width, height })
      }
      return page
    },
    async kill() {
      guest('C:\\Windows\\System32\\taskkill.exe', ['/F', '/T', '/IM', 'pos-desktop.exe'])
      await browser?.close().catch(() => undefined)
      browser = null
      await until(async () => !(await cdpReachable()), 'the till did not die', 30_000)
    },
    async quit() {
      // WM_CLOSE to the window: the till's normal quit path (workers stop, SQLite closes).
      guest('C:\\Windows\\System32\\taskkill.exe', ['/IM', 'pos-desktop.exe'])
      await browser?.close().catch(() => undefined)
      browser = null
      await until(async () => !(await cdpReachable()), 'the till did not quit', 60_000)
    },
    /** The till's database stays inside the VM; durable checks go through the app and the server. */
    query() {
      return null
    },
    logs() {
      return []
    },
    async stop() {
      if (await cdpReachable()) await this.kill().catch(() => undefined)
    }
  }
}
