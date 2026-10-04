import { t } from '../support/app.mjs'
import {
  openSandboxAndApp,
  payExactCash,
  scan,
  setupPhysicalPresenceTill,
  waitForRoute
} from '../support/journey.mjs'

const BOOTSTRAP = /^GET \/api\/v1\/desktop\/bootstrap/

async function storeValue(page, id, expression) {
  return await page.evaluate(
    ([storeId, expr]) => {
      const s = document
        .querySelector('#app')
        .__vue_app__.config.globalProperties.$pinia._s.get(storeId)
      return new Function('s', `return (${expr})`)(s)
    },
    [id, expression]
  )
}

const revision = (page) => storeValue(page, 'catalog', 's.status?.contract?.revision ?? null')
const cartState = (page) =>
  storeValue(
    page,
    'cart',
    '({ lines: s.lines.map((l) => [l.product?.sku ?? l.product?.uuid, String(l.quantity), l.catalogRevision]), catalogChanged: s.catalogChanged, revision: s.contract?.revision ?? null })'
  )

async function waitRefreshIdle(page, timeout = 60_000) {
  await page.waitForFunction(
    () => {
      const s = document
        .querySelector('#app')
        .__vue_app__.config.globalProperties.$pinia._s.get('workstationRefresh')
      return s && s.status === 'idle' && s.lastMessage !== null
    },
    null,
    { timeout }
  )
  return await storeValue(page, 'workstationRefresh', 's.lastMessage')
}

async function clearCart(page) {
  await storeValue(page, 'cart', 's.resetDraft("cleared") || true')
  await storeValue(page, 'workstationRefresh', 's.dismissMessage() || true')
}

/**
 * Stage 5 (Rev 4 §8): safe catalog installation — consent before the machine handshake, main-owned
 * holds, apply-before-release, lost release recovered by polling, queued scans processed against
 * the NEW contract, and no silent repricing or payment supersession.
 */
export async function run(ctx) {
  const session = await openSandboxAndApp(ctx, {
    flags: { POS_OFFLINE_PHYSICAL_PRESENCE_ENABLED: 'true' },
    proxy: true
  })
  const { sandbox, proxy, app } = session
  let page = session.page
  const refreshButton = () => page.locator('[data-testid="workstation-refresh"]').first()
  try {
    await setupPhysicalPresenceTill(ctx, session)

    // A. Empty cart: one click installs, no consent needed.
    const r0 = await revision(page)
    await new Promise((r) => setTimeout(r, 1100)) // generated_at has 1 s resolution
    await refreshButton().click()
    const a = await waitRefreshIdle(page)
    const r1 = await revision(page)
    ctx.step('A: empty-cart refresh', { outcome: a, revisionChanged: r0 !== r1 })
    if (a !== 'installed') throw new Error(`A: expected installed, got ${a}`)
    await ctx.shot(page, 'A-empty-cart-refreshed')

    // B. Lines in the cart: consent first, as slowly as the cashier likes, then install + review.
    await scan(ctx, page, '6221000000011')
    await refreshButton().click()
    const consent = page.getByRole('alertdialog')
    await consent.waitFor()
    await ctx.shot(page, 'B-consent-dialog')
    await new Promise((r) => setTimeout(r, 4000)) // a slow human; no machine timeout applies
    await new Promise((r) => setTimeout(r, 1100))
    await consent
      .getByRole('button', { name: await t(page, 'shell.workstationRefresh.consentConfirm') })
      .click()
    const b = await waitRefreshIdle(page)
    const cartB = await cartState(page)
    ctx.step('B: manual refresh with lines after slow consent', { outcome: b, cart: cartB })
    if (b !== 'installed') throw new Error(`B: expected installed, got ${b}`)
    if (!cartB.catalogChanged)
      throw new Error('B: the open cart must be flagged for review, never repriced')
    await ctx.shot(page, 'B-installed-cart-needs-review')
    await clearCart(page)

    // C. Draft changes AFTER consent (the bootstrap response is slow): not installed.
    await scan(ctx, page, '6221000000011')
    await refreshButton().click()
    await page.getByRole('alertdialog').waitFor()
    const rC0 = await revision(page)
    proxy.rule('slow bootstrap', BOOTSTRAP, { delayResponseMs: 3500, times: 1 })
    await new Promise((r) => setTimeout(r, 1100))
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: await t(page, 'shell.workstationRefresh.consentConfirm') })
      .click()
    await new Promise((r) => setTimeout(r, 500))
    await scan(ctx, page, '6221000000035') // the cashier keeps working while the refresh is slow
    const c = await waitRefreshIdle(page)
    const rC1 = await revision(page)
    ctx.step('C: draft changed after consent', {
      outcome: c,
      installed: rC0 !== rC1,
      cart: await cartState(page)
    })
    if (c !== 'draft-changed') throw new Error(`C: expected draft-changed, got ${c}`)
    if (rC0 !== rC1) throw new Error('C: nothing may be installed when the draft changed')
    await ctx.shot(page, 'C-draft-changed-not-installed')
    await clearCart(page)

    // D. Payment dialog open: a refresh request never supersedes it.
    await scan(ctx, page, '6221000000011')
    await page.keyboard.press('F9')
    await page.getByRole('dialog').waitFor()
    const rD0 = await revision(page)
    await new Promise((r) => setTimeout(r, 1100))
    const d = await page.evaluate(async () => await window.posApi.catalog.refresh())
    const rD1 = await revision(page)
    ctx.step('D: refresh while the payment dialog is open', {
      ok: d.ok,
      error: d.ok ? null : d.error?.message,
      installed: rD0 !== rD1
    })
    if (rD0 !== rD1) throw new Error('D: an install superseded an open payment')
    await page.waitForTimeout(400)
    await page.keyboard.press('Shift+F9')
    const prefix = (
      await t(page, 'pos.payment.completion.committed', { offlineNumber: '\u0000' })
    ).split('\u0000')[0]
    await page.getByText(prefix).first().waitFor({ timeout: 30_000 })
    ctx.step('D: the open payment completed afterwards, unaffected')
    await ctx.shot(page, 'D-payment-completed-after-refused-refresh')
    await page.keyboard.press('F9')
    await page.waitForTimeout(400)

    // E. Lost release (simulated: main drops the release push) + scans queued during the hold.
    await app.evaluate(({ webContents }) => {
      for (const wc of webContents.getAllWebContents()) {
        if (wc.__posDropRelease) continue
        const original = wc.send.bind(wc)
        wc.__posDropRelease = true
        wc.send = (channel, ...args) => {
          if (channel === 'catalog:install-release' && globalThis.__posDropRelease !== false) {
            globalThis.__posDroppedReleases = (globalThis.__posDroppedReleases ?? 0) + 1
            return
          }
          return original(channel, ...args)
        }
      }
      globalThis.__posDropRelease = true
    })
    const rE0 = await revision(page)
    await new Promise((r) => setTimeout(r, 1100))
    await refreshButton().click()
    await page
      .getByRole('button', { name: await t(page, 'shell.workstationRefresh.updating') })
      .first()
      .waitFor({ timeout: 20_000 })
    ctx.step('E: hold armed and release push dropped; scanning during the hold')
    await ctx.shot(page, 'E-updating-catalog-hold')
    const input = page.getByLabel(await t(page, 'pos.quickSale.scanLabel'))
    await input.click()
    await page.keyboard.type('6221000000011', { delay: 5 })
    await page.keyboard.press('Enter')
    await page.keyboard.type('6221000000035', { delay: 5 })
    await page.keyboard.press('Enter')
    const duringHold = await cartState(page)
    await page.waitForFunction(
      () => {
        const s = document
          .querySelector('#app')
          .__vue_app__.config.globalProperties.$pinia._s.get('cart')
        return s.lines.length === 2
      },
      null,
      { timeout: 20_000 }
    )
    const afterHold = await cartState(page)
    const rE1 = await revision(page)
    const dropped = await app.evaluate(() => globalThis.__posDroppedReleases ?? 0)
    ctx.step('E: queued scans processed after the new contract was applied', {
      droppedReleases: dropped,
      linesDuringHold: duringHold.lines.length,
      after: afterHold,
      installedRevision: rE1,
      changed: rE0 !== rE1
    })
    if (dropped < 1) throw new Error('E: expected the release push to have been dropped')
    if (afterHold.catalogChanged)
      throw new Error('E: queued scans must land on the new contract, not need review')
    if (!afterHold.lines.every((l) => l[2] === rE1))
      throw new Error('E: a queued line used the superseded revision')
    await app.evaluate(() => {
      globalThis.__posDropRelease = false
    })
    await ctx.shot(page, 'E-queued-scans-on-new-contract')

    // F. Renderer reload: the fresh page reads the installed catalog and sells normally.
    await clearCart(page)
    await page.reload()
    await waitForRoute(page, 'pos')
    await page.waitForTimeout(1500)
    const rF = await revision(page)
    ctx.step('F: after renderer reload', { revision: rF, matchesInstalled: rF === rE1 })
    await scan(ctx, page, '6221000000028')
    await payExactCash(ctx, page)
    await ctx.shot(page, 'F-sale-after-reload')
  } finally {
    ctx.facts.installTrace = session.logs
      .join('')
      .split('\n')
      .filter((l) => l.includes('pos-install') || l.includes('bootstrap') || l.includes('renewal'))
      .slice(-60)
    await session.app.close().catch(() => undefined)
    await proxy?.stop()
    await sandbox.stop()
  }
}
