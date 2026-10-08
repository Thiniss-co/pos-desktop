/**
 * Shared user journeys against the real app: activation, sign-in, device assignment, shift, sale.
 * Every interaction goes through accessible roles/labels resolved via the app's own i18n.
 */
import { buildApp, launchApp, t } from './app.mjs'
import { startSandbox } from './sandbox.mjs'
import { startProxy } from './proxy.mjs'
import { join } from 'node:path'

export const CASHIER = { email: 'cashier@desktop-mvp.test', password: 'Password123!' }
export const MANAGER = { email: 'manager@desktop-mvp.test', password: 'Password123!' }

export async function openSandboxAndApp(
  ctx,
  { flags = {}, profile = 'profile', proxy: withProxy = false, backendRoot = undefined } = {}
) {
  const sandbox = await startSandbox({
    runDir: ctx.runDir,
    flags,
    ...(backendRoot ? { backendRoot } : {})
  })
  ctx.step('disposable backend ready', { origin: sandbox.origin, database: sandbox.databasePath })
  const proxy = withProxy ? await startProxy(sandbox.origin) : null
  if (proxy) ctx.step('network proxy ready', { origin: proxy.origin })
  const outDir = buildApp(proxy?.origin ?? sandbox.origin)
  ctx.step('electron build ready', { outDir })
  const profileDir = join(ctx.runDir, profile)
  const launched = await launchApp({ outDir, profileDir })
  const userData = await launched.app.evaluate(({ app }) => app.getPath('userData'))
  if (!userData.startsWith(profileDir)) {
    throw new Error(`userData ${userData} is not inside the isolated profile ${profileDir}`)
  }
  ctx.step('electron launched with isolated profile', { userData })
  const session = { sandbox, proxy, outDir, profileDir, ...launched }
  // Lets the runner keep the main-process trace when a journey fails.
  ctx.session = session
  return session
}

export async function relaunch(ctx, session) {
  await session.app.close()
  const launched = await launchApp({ outDir: session.outDir, profileDir: session.profileDir })
  Object.assign(session, launched)
  ctx.step('electron relaunched on the same isolated profile')
  return session
}

export async function activate(ctx, page) {
  await page.getByLabel(await t(page, 'activation.companyCode')).fill('DESKTOP-MVP')
  await page.getByLabel(await t(page, 'activation.activationCode')).fill('ACTIVATE-DESKTOP-MVP')
  await page.getByLabel(await t(page, 'activation.deviceName')).fill('Playwright till')
  await page.getByRole('button', { name: await t(page, 'activation.activate') }).click()
  await page
    .getByRole('button', { name: await t(page, 'auth.signIn') })
    .waitFor({ timeout: 30_000 })
  ctx.step('activation completed')
}

export async function signIn(ctx, page, user = CASHIER) {
  await page.locator('input[autocomplete="username"]').fill(user.email)
  await page.locator('input[autocomplete="current-password"]').fill(user.password)
  await page.getByRole('button', { name: await t(page, 'auth.signIn') }).click()
  ctx.step('sign-in submitted', { user: user.email })
}

export async function waitForRoute(page, name, timeout = 60_000) {
  await page.waitForFunction(
    (n) =>
      document.querySelector('#app')?.__vue_app__?.config.globalProperties.$router.currentRoute
        .value.name === n,
    name,
    { timeout }
  )
}

export async function currentRoute(page) {
  return await page.evaluate(
    () =>
      document.querySelector('#app')?.__vue_app__?.config.globalProperties.$router.currentRoute
        .value.name
  )
}

export async function deviceUuid(sandbox) {
  const devices = sandbox.fixture('devices').devices
  if (devices.length !== 1) throw new Error(`expected one device, found ${devices.length}`)
  return devices[0].device_uuid
}

/** Clicks the workstation refresh control and waits until the store settles. */
export async function refreshWorkstation(ctx, page) {
  const store = (expr) =>
    page.evaluate(
      (e) =>
        new Function('s', `return (${e})`)(
          document
            .querySelector('#app')
            .__vue_app__.config.globalProperties.$pinia._s.get('workstationRefresh')
        ),
      expr
    )
  // Since Stage 5 every refresh button goes through the `workstationRefresh` store (manual path);
  // wait for ITS outcome, not the catalog store's legacy flag.
  await store('s ? (s.dismissMessage(), true) : false')
  // The header control (Rev 4 §13) — the POS page no longer repeats the button.
  await page.locator('[data-testid="workstation-refresh"]:visible').first().click()
  await page.waitForFunction(
    () => {
      const s = document
        .querySelector('#app')
        .__vue_app__.config.globalProperties.$pinia._s.get('workstationRefresh')
      return s && s.status === 'idle' && s.lastMessage !== null
    },
    null,
    { timeout: 60_000 }
  )
  const outcome = await store('s.lastMessage')
  // A refresh can leave a background catalog install running ("Updating catalog…"); sales and scans
  // are held until it finishes, which takes longer on a loaded machine.
  const updating = await t(page, 'shell.workstationRefresh.updating')
  await page.waitForFunction((text) => !document.body.innerText.includes(text), updating, {
    timeout: 90_000
  })
  ctx.step('workstation data refreshed', { outcome })
  return outcome
}

export async function openShift(ctx, page, openingCash = '100') {
  await page
    .getByRole('button', { name: await t(page, 'pos.openShift') })
    .first()
    .click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel(await t(page, 'pos.openingCash')).fill(openingCash)
  await dialog.getByRole('button', { name: await t(page, 'pos.openShift') }).click()
  await page.waitForFunction(
    () => {
      const s = document
        .querySelector('#app')
        .__vue_app__.config.globalProperties.$pinia._s.get('shift')
      return s?.currentShift?.status === 'open' || s?.shift?.status === 'open'
    },
    null,
    { timeout: 30_000 }
  )
  ctx.step('shift opened')
}

function cartSignature() {
  const s = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('cart')
  return JSON.stringify(
    (s?.lines ?? []).map((l) => [l.productUuid ?? l.uuid ?? '', String(l.quantity)])
  )
}

export async function scan(ctx, page, code) {
  const before = await page.evaluate(cartSignature)
  const input = page.getByLabel(await t(page, 'pos.quickSale.scanLabel'))
  await input.click()
  await page.keyboard.type(code, { delay: 5 })
  await page.keyboard.press('Enter')
  try {
    await page.waitForFunction(
      ([fn, previous]) => new Function(`return (${fn})()`)() !== previous,
      [cartSignature.toString(), before],
      { timeout: 10_000 }
    )
  } catch {
    const text = await page.evaluate(() => document.body.innerText.slice(0, 800))
    throw new Error(`scan of ${code} did not change the cart; screen: ${text}`)
  }
  ctx.step('scanned', { code })
}

async function templatePrefix(page, key) {
  const raw = await t(page, key, { offlineNumber: '\u0000' })
  return raw.split('\u0000')[0]
}

/** F9 opens payment, Shift+F9 is exact cash; waits for the committed notice. */
export async function payExactCash(ctx, page) {
  await page.keyboard.press('F9')
  await page.getByRole('dialog').waitFor({ timeout: 15_000 })
  await page.waitForTimeout(400)
  await page.keyboard.press('Shift+F9')
  const prefix = await templatePrefix(page, 'pos.payment.completion.committed')
  await page.getByText(prefix, { exact: false }).first().waitFor({ timeout: 30_000 })
  ctx.step('exact-cash sale committed')
}

export async function waitForServerInvoices(sandbox, uuid, count, timeout = 60_000) {
  const deadline = Date.now() + timeout
  let report = null
  while (Date.now() < deadline) {
    report = sandbox.fixture('report', uuid)
    if (report.device_invoice_count >= count) return report
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`server has ${report?.device_invoice_count} invoices, expected ${count}`)
}

export async function sizeWindow(session, width = 1366, height = 850) {
  await session.app.evaluate(
    ({ BrowserWindow }, [w, h]) => {
      const win = BrowserWindow.getAllWindows().find((x) => x.isVisible())
      win?.setSize(w, h)
    },
    [width, height]
  )
}

/** Reads the rendered product card for a product name: dimming, disabled state and stock text. */
export async function cardState(page, name) {
  return await page.evaluate((productName) => {
    const frames = [...document.querySelectorAll('.product-card-frame')]
    const frame = frames.find(
      (f) => f.querySelector('.product-card__name')?.textContent?.trim() === productName
    )
    if (!frame) return null
    const band = frame.firstElementChild
    const button = frame.querySelector('button.product-card')
    return {
      dimmed: band?.classList.contains('opacity-60') ?? false,
      mutedText: button?.classList.contains('text-muted') ?? false,
      disabled: button?.disabled ?? false,
      text: frame.innerText.replace(/\s+/g, ' ').trim()
    }
  }, name)
}

/** Opens payment and presses exact cash; returns the dialog text once completion settles. */
export async function attemptExactCash(ctx, page) {
  await page.keyboard.press('F9')
  await page.getByRole('dialog').waitFor({ timeout: 15_000 })
  await page.waitForTimeout(400)
  await page.keyboard.press('Shift+F9')
  await page.waitForFunction(
    () => {
      const s = document
        .querySelector('#app')
        .__vue_app__.config.globalProperties.$pinia._s.get('payment')
      return s && s.completionPending !== true && s.completionOutcome !== null
    },
    null,
    { timeout: 45_000 }
  )
  await page.waitForTimeout(500)
  const text = await page.getByRole('dialog').innerText()
  const outcome = await page.evaluate(() =>
    JSON.parse(
      JSON.stringify(
        document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('payment')
          .completionOutcome
      )
    )
  )
  ctx.step('exact-cash attempt settled', {
    outcome,
    dialog: text.replace(/\s+/g, ' ').slice(0, 400)
  })
  return { text, outcome }
}

export async function mainTrace(session, needle) {
  return session.logs
    .join('')
    .split('\n')
    .filter((line) => line.includes(needle))
}

/** Activation → sign-in → device assignment → PP policy → refresh → open shift. */
export async function setupPhysicalPresenceTill(
  ctx,
  session,
  { openingCash = '100', windowHours = null } = {}
) {
  const { page, sandbox } = session
  await sizeWindow(session)
  await activate(ctx, page)
  await signIn(ctx, page)
  await waitForRoute(page, 'pos')
  const uuid = await deviceUuid(sandbox)
  sandbox.fixture('assign-device', uuid)
  ctx.step(
    'policy set to physical presence',
    sandbox.fixture('mode-physical-presence', windowHours === null ? '' : String(windowHours))
  )
  await refreshWorkstation(ctx, page)
  await openShift(ctx, page, openingCash)
  return uuid
}

export async function readiness(page) {
  const result = await page.evaluate(async () => await window.posApi.offlineSale.getReadiness())
  return result.ok ? result.data : result
}

/** Launch again on the same isolated profile after the app was closed by the journey. */
export async function launchAgain(ctx, session) {
  const launched = await launchApp({ outDir: session.outDir, profileDir: session.profileDir })
  Object.assign(session, launched)
  ctx.step('electron launched again on the same isolated profile')
  return session
}

/**
 * Signs the current user out through the real UI (user menu → Sign out), so main AND the renderer
 * end the session (calling `window.posApi.auth.logout()` directly leaves the renderer store stale).
 */
export async function signOutViaMenu(ctx, page) {
  await page.getByRole('button', { name: await t(page, 'shell.user.menuLabel') }).click()
  await page
    .getByRole('menuitem', { name: await t(page, 'common.signOut') })
    .or(page.getByRole('button', { name: await t(page, 'common.signOut') }))
    .first()
    .click()
  // The confirmation dialog ("Sign out of this workstation?").
  await page
    .locator('[role=dialog],[role=alertdialog]')
    .getByRole('button', { name: await t(page, 'common.signOut') })
    .click()
  await page
    .getByRole('button', { name: await t(page, 'auth.signIn') })
    .waitFor({ timeout: 30_000 })
  ctx.step('signed out through the user menu')
}
