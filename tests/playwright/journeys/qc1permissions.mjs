import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { t } from '../support/app.mjs'
import {
  CASHIER,
  activate,
  deviceUuid,
  openSandboxAndApp,
  refreshWorkstation,
  relaunch,
  signIn,
  signOutViaMenu,
  waitForRoute
} from '../support/journey.mjs'

/**
 * POS improvements, Stage 1 — permission delegation end to end, through BOTH real UIs and the real
 * desktop API against one guarded disposable backend:
 *  1. cashier A signs in: the register's main process reports no quick-create access;
 *  2. the owner creates cashier B in the company-owner SPA, then grants A "Add customers" in the new
 *     Register quick actions panel (A's other grants untouched);
 *  3. A's register session was invalidated; A signs in again and main now reports customer access;
 *  4. direct desktop API: A creates a customer (201), an exact replay returns the stored 201, a
 *     different payload under the same key is IDEMPOTENCY_CONFLICT; cashier B is refused (403);
 *  5. B signs in on the register: main reports no access for B, although A's grant was cached there;
 *  6. the backend holds exactly one customer and one accepted request.
 * The register UI action itself arrives with the dialogs in Stage 2 (qc2offline).
 */

const ADMIN = { email: 'admin@desktop-mvp.test', password: 'Password123!' }
const CASHIER_B = { email: 'bea.cashier@desktop-mvp.test', password: 'Password123!' }

async function access(page) {
  const result = await page.evaluate(() => window.posApi.quickCreate.getAccess())
  if (!result.ok) throw new Error(`getAccess failed: ${JSON.stringify(result.error)}`)
  return result.data
}

async function apiLogin(origin, user, device) {
  const response = await fetch(`${origin}/api/v1/desktop/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email: user.email, password: user.password, device_uuid: device })
  })
  const body = await response.json()
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`desktop login ${user.email} answered ${response.status} ${body.code}`)
  }
  return body.data.token
}

async function apiCreateCustomer(origin, token, device, body) {
  const response = await fetch(`${origin}/api/v1/desktop/quick-create/customers`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'X-Device-UUID': device
    },
    body: JSON.stringify(body)
  })
  const json = await response.json()
  return {
    status: response.status,
    code: json.code,
    outcome: response.headers.get('idempotency-outcome'),
    replayed: response.headers.get('idempotent-replayed'),
    entity: json.data?.entity?.uuid ?? null
  }
}

/** Waits for the sign-in screen after the owner's change ended A's register session. */
async function reachSignIn(ctx, session) {
  const signInButton = async (page) =>
    page.getByRole('button', { name: await t(page, 'auth.signIn') })
  // The next authenticated call learns the token is revoked.
  await session.page.evaluate(() => window.posApi.bootstrap.refresh()).catch(() => undefined)
  try {
    await (await signInButton(session.page)).waitFor({ timeout: 20_000 })
    ctx.step('register returned to the sign-in screen after the owner change')
    return 'in-app'
  } catch {
    await relaunch(ctx, session)
    await (await signInButton(session.page)).waitFor({ timeout: 30_000 })
    ctx.step('register shows the sign-in screen after a relaunch')
    return 'relaunch'
  }
}

export async function run(ctx) {
  const session = await openSandboxAndApp(ctx)
  const { sandbox } = session
  const chrome = await chromium.launchPersistentContext(join(ctx.runDir, 'chrome'), {
    ...(process.env.PW_CHROME_PATH
      ? { executablePath: process.env.PW_CHROME_PATH }
      : { channel: 'chrome' }),
    headless: true,
    viewport: { width: 1280, height: 900 }
  })
  const owner = chrome.pages()[0] ?? (await chrome.newPage())
  const ownerUrl = (path) => new URL(path, sandbox.origin).toString()

  try {
    await activate(ctx, session.page)
    await signIn(ctx, session.page, CASHIER)
    await waitForRoute(session.page, 'pos')
    const device = await deviceUuid(sandbox)
    ctx.step('device assigned', sandbox.fixture('assign-device', device))
    await refreshWorkstation(ctx, session.page)

    // 1. Before any grant.
    const before = await access(session.page)
    ctx.step('1: cashier A access before the grant', before)
    if (!before.available || before.customer || before.supplier || before.product) {
      throw new Error(`1: expected capability without grants, got ${JSON.stringify(before)}`)
    }

    // 2. Owner SPA: create cashier B, then grant A "Add customers".
    await owner.goto(ownerUrl('/owner/login'))
    await owner.locator('#email').fill(ADMIN.email)
    await owner.locator('#password').fill(ADMIN.password)
    await owner.locator('button[type=submit]').click()
    await owner.waitForURL((u) => !u.pathname.endsWith('/login'))
    ctx.step('owner signed in to the company-owner SPA')

    await owner.goto(ownerUrl('/owner/staff/new'))
    await owner.locator('#staff-name').fill('Bea Cashier')
    await owner.locator('#staff-email').fill(CASHIER_B.email)
    await owner.locator('#staff-role').selectOption('cashier')
    await owner.locator('#staff-password').fill(CASHIER_B.password)
    await owner.locator('#staff-password-confirmation').fill(CASHIER_B.password)
    const created = owner.waitForResponse(
      (r) => r.request().method() === 'POST' && /\/api\/v1\/company-owner\/staff$/.test(r.url())
    )
    await owner.locator('form button[type=submit]').first().click()
    const createdResponse = await created
    if (createdResponse.status() !== 201) {
      throw new Error(`2: staff create answered ${createdResponse.status()}`)
    }
    ctx.step('2: owner created cashier B in the SPA', { email: CASHIER_B.email })
    await owner.waitForTimeout(500)
    await ctx.shot(owner, '02a-owner-created-cashier-b')

    const cashierA = await owner.evaluate(async (email) => {
      const list = await (
        await fetch(`/api/v1/company-owner/staff?search=${encodeURIComponent(email)}`, {
          credentials: 'same-origin',
          headers: { Accept: 'application/json' }
        })
      ).json()
      return list.data.find((member) => member.email === email).id
    }, CASHIER.email)
    await owner.goto(ownerUrl(`/owner/staff/${cashierA}`))
    const panel = owner.getByTestId('staff-quick-actions')
    await panel.waitFor()
    const grantsBefore = sandbox.fixture('quick-create-report').grants[CASHIER.email]
    await ctx.shot(owner, '02b-owner-quick-actions-before')
    await owner.locator('#staff-quick-customers').check()
    const saved = owner.waitForResponse(
      (r) => r.request().method() === 'PUT' && /quick-create-permissions$/.test(r.url())
    )
    await panel.locator('button[type=submit]').click()
    const savedResponse = await saved
    if (savedResponse.status() !== 200)
      throw new Error(`2: save answered ${savedResponse.status()}`)
    await owner.waitForTimeout(400)
    await ctx.shot(owner, '02c-owner-quick-actions-granted')
    const grantsAfter = sandbox.fixture('quick-create-report').grants[CASHIER.email]
    ctx.step('2: owner granted Add customers', { grantsBefore, grantsAfter })
    const preserved = grantsBefore.every((name) => grantsAfter.includes(name))
    if (
      !grantsAfter.includes('customers.create') ||
      !preserved ||
      grantsAfter.length !== grantsBefore.length + 1
    ) {
      throw new Error(`2: unexpected grants ${JSON.stringify({ grantsBefore, grantsAfter })}`)
    }

    // 3. A's register session was invalidated by the change; A signs in again.
    const path = await reachSignIn(ctx, session)
    await signIn(ctx, session.page, CASHIER)
    await waitForRoute(session.page, 'pos')
    await refreshWorkstation(ctx, session.page)
    const afterGrant = await access(session.page)
    ctx.step('3: cashier A access after the grant', { afterGrant, signInPath: path })
    if (!afterGrant.customer || afterGrant.supplier || afterGrant.product) {
      throw new Error(`3: expected customer access only, got ${JSON.stringify(afterGrant)}`)
    }
    await ctx.shot(session.page, '03-register-cashier-a-after-grant')

    // 4. Direct desktop API attempts (real device-bound tokens; the backend is the authority).
    const tokenA = await apiLogin(sandbox.origin, CASHIER, device)
    const body = {
      request_key: randomUUID(),
      client_entity_uuid: randomUUID(),
      payload: { name: 'Qc1 Walk-in', phone: '0500000101' }
    }
    const created1 = await apiCreateCustomer(sandbox.origin, tokenA, device, body)
    const replay = await apiCreateCustomer(sandbox.origin, tokenA, device, body)
    const conflict = await apiCreateCustomer(sandbox.origin, tokenA, device, {
      ...body,
      payload: { name: 'Qc1 Changed' }
    })
    const tokenB = await apiLogin(sandbox.origin, CASHIER_B, device)
    const denied = await apiCreateCustomer(sandbox.origin, tokenB, device, {
      request_key: randomUUID(),
      client_entity_uuid: randomUUID(),
      payload: { name: 'Qc1 Not allowed' }
    })
    ctx.step('4: direct API attempts', { created1, replay, conflict, denied })
    if (created1.status !== 201 || created1.outcome !== 'accepted') throw new Error('4: create')
    if (replay.status !== 201 || replay.replayed !== 'true' || replay.entity !== created1.entity) {
      throw new Error('4: replay')
    }
    if (conflict.status !== 409 || conflict.code !== 'IDEMPOTENCY_CONFLICT')
      throw new Error('4: conflict')
    if (denied.status !== 403 || denied.code !== 'PERMISSION_DENIED') throw new Error('4: denied')

    // 5. Cashier B on the register: A's cached grant never authorizes B.
    await signOutViaMenu(ctx, session.page)
    await signIn(ctx, session.page, CASHIER_B)
    await waitForRoute(session.page, 'pos')
    const accessB = await access(session.page)
    ctx.step('5: cashier B access on the same register', accessB)
    if (accessB.customer || accessB.supplier || accessB.product) {
      throw new Error(
        `5: cashier B must have no quick-create access, got ${JSON.stringify(accessB)}`
      )
    }
    await refreshWorkstation(ctx, session.page)
    const accessB2 = await access(session.page)
    ctx.step('5: cashier B access after B’s own bootstrap', accessB2)
    if (accessB2.customer) throw new Error('5: B gained access')
    await ctx.shot(session.page, '05-register-cashier-b')

    // 6. Backend effects.
    const report = sandbox.fixture('quick-create-report')
    ctx.step('6: backend quick-create report', {
      requests: report.requests,
      bindings: report.bindings.length,
      customers: report.customers.filter((c) => c.name.startsWith('Qc1'))
    })
    const mine = report.customers.filter((c) => c.name.startsWith('Qc1'))
    if (mine.length !== 1 || mine[0].uuid !== body.client_entity_uuid) {
      throw new Error(`6: expected exactly one Qc1 customer, got ${JSON.stringify(mine)}`)
    }
    if (report.requests.length !== 1 || report.requests[0].outcome !== 'accepted') {
      throw new Error(`6: expected one accepted request, got ${JSON.stringify(report.requests)}`)
    }
  } finally {
    ctx.facts.mainLogTail = session.logs
      .join('')
      .split('\n')
      .filter((l) => l.includes('api') || l.includes('POS'))
      .slice(-60)
    await chrome.close().catch(() => undefined)
    await session.app.close().catch(() => undefined)
    await sandbox.stop()
  }
}
