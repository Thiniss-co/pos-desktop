import { spawnSync } from 'node:child_process'
import { t } from '../support/app.mjs'
import { openSandboxAndApp, setupPhysicalPresenceTill, sizeWindow } from '../support/journey.mjs'
import { queryLocal } from '../support/localDb.mjs'
import { tap, touchSession } from '../support/touch.mjs'

/**
 * V1 Windows readiness — the quick-create product PRICE entered by touch only.
 *
 * Touch mode is switched on by touch; the quick-create product dialog is opened by touch; the price
 * is entered ONLY with the on-screen keypad (1, 2, ., 5 → 12.5) and the product saved by touch. The
 * product NAME is a free-text field and is typed with the (system) keyboard, as on a touch till. The
 * frozen request carries the typed price in minor units (1250) and the server stores 1250.
 */
const NAME = 'Touch Priced Juice'

function serverProduct(sandbox, name) {
  const script = `
import json, sqlite3, sys
con = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True)
con.row_factory = sqlite3.Row
print(json.dumps([dict(r) for r in con.execute("SELECT uuid, name, price FROM products WHERE name = ?", (sys.argv[2],))]))
`
  const result = spawnSync('python3', ['-I', '-c', script, sandbox.databasePath, name], {
    encoding: 'utf8'
  })
  if (result.status !== 0) throw new Error(`server query failed: ${result.stderr}`)
  return JSON.parse(result.stdout)
}

async function until(read, predicate, label, timeout = 90_000) {
  const deadline = Date.now() + timeout
  let value = await read()
  while (!predicate(value)) {
    if (Date.now() > deadline) throw new Error(`${label}: ${JSON.stringify(value)}`)
    await new Promise((resolve) => setTimeout(resolve, 500))
    value = await read()
  }
  return value
}

export async function run(ctx) {
  const session = await openSandboxAndApp(ctx, {
    flags: { POS_OFFLINE_PHYSICAL_PRESENCE_ENABLED: 'true' }
  })
  const { sandbox } = session
  try {
    sandbox.fixture('quick-create-grant', 'cashier:catalog.products.create:1')
    await setupPhysicalPresenceTill(ctx, session)
    const page = session.page
    await sizeWindow(session, 1366, 850)
    const cdp = await touchSession(page)

    // Touch mode on, by touch.
    await tap(cdp, page.getByRole('button', { name: await t(page, 'shell.user.menuLabel') }))
    await tap(cdp, page.getByTestId('touch-mode-switch'))
    await page.waitForFunction(() => document.documentElement.dataset.touch === 'on')
    await tap(cdp, page.getByRole('button', { name: await t(page, 'shell.user.menuLabel') }))

    // Quick create → product, by touch.
    const inline = page.locator('.quick-actions button[data-action="quick-create"]').first()
    if (await inline.isVisible().catch(() => false)) {
      await tap(cdp, inline)
    } else {
      await tap(cdp, page.locator('.quick-actions [data-action="more"]').first())
      await tap(cdp, page.locator('[role="menuitem"][data-action="quick-create"]').first())
    }
    await tap(cdp, page.getByTestId('more-actions-product'))
    const dialog = page.getByTestId('quick-create-dialog')
    await dialog.waitFor()
    // Free text: the system keyboard.
    await dialog
      .getByLabel(await t(page, 'quickCreate.field.name'))
      .first()
      .fill(NAME)

    // The price: on-screen keypad only.
    const price = dialog.getByTestId('quick-create-price')
    await price.getByTestId('numeric-keypad').waitFor()
    for (const key of ['1', '2', '.', '5']) await tap(cdp, price.locator(`[data-key="${key}"]`))
    const typed = await price.locator('input').inputValue()
    ctx.step('price typed on the keypad', { typed })
    await ctx.shot(page, 'A1-quick-create-price-by-touch')
    if (typed !== '12.5') throw new Error(`the keypad price reads ${typed}`)
    await tap(cdp, page.getByTestId('quick-create-save'))
    await dialog.waitFor({ state: 'detached', timeout: 15_000 })

    const [queued] = queryLocal(
      session.profileDir,
      `SELECT state, canonical_payload_json FROM entity_create_outbox
        WHERE entity_type = 'product' ORDER BY rowid DESC LIMIT 1`
    )
    const frozenPrice = JSON.parse(queued.canonical_payload_json).price
    const stored = await until(
      () => serverProduct(sandbox, NAME),
      (rows) => rows.length === 1,
      'the server never stored the product'
    )
    ctx.step('product created with the keypad price', {
      frozenPrice,
      server: stored
    })
    // Main converts the typed decimal to minor units before freezing the request.
    if (frozenPrice !== 1250) throw new Error(`the frozen request carries ${frozenPrice}`)
    if (Number(stored[0].price) !== 1250)
      throw new Error(`the server stored ${stored[0].price} minor units`)
  } finally {
    await session.app.close().catch(() => undefined)
    await sandbox.stop()
  }
}
