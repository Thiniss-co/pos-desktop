/**
 * Owner opening stock through the REAL company-owner SPA (headless Chrome via playwright-core) against
 * a disposable, guarded Laravel backend. Every HTTP request is served by guardedHttpRouter.php (the
 * resolved database is re-verified in the serving process) and passes a controllable proxy.
 *
 * Covers: create with optional opening stock; initialize an eligible existing product; the actionable
 * conflict for a product with history; clearing on untracking; the lost-answer regression for both entry
 * points (original held in flight → lookup before commit finds nothing → no replacement submission →
 * original commits → recovery shows the actual, attributed result, exactly once); a concurrent
 * independent writer that is never attributed to the unresolved request; adjust-only, permission and
 * feature states; EN/AR × light/dark layouts.
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { startProxy } from '../support/proxy.mjs'
import { startSandbox } from '../support/sandbox.mjs'

const ADMIN = { email: 'admin@desktop-mvp.test', password: 'Password123!' }
const PREFS_KEY = 'company-owner-ui-preferences'

export async function run(ctx) {
  const sandbox = await startSandbox({ runDir: ctx.runDir, guardHttp: true })
  const proxy = await startProxy(sandbox.origin, null, { preserveHost: true })
  ctx.step('sandbox', { guardedHttp: sandbox.guardHttp, database: sandbox.databasePath })
  const context = await chromium.launchPersistentContext(join(ctx.runDir, 'chrome'), {
    executablePath: '/usr/bin/google-chrome',
    headless: true,
    viewport: { width: 1280, height: 900 }
  })
  const page = context.pages()[0] ?? (await context.newPage())
  const url = (path) => new URL(path, proxy.origin).toString()
  const fixture = (op, arg = '') => sandbox.fixture(op, arg)

  const setPrefs = async (locale, theme) => {
    await page.evaluate(
      ([key, value]) => localStorage.setItem(key, value),
      [PREFS_KEY, JSON.stringify({ locale, theme })]
    )
    await page.reload()
    await page.waitForFunction(
      ([l, t]) =>
        document.documentElement.lang === l && document.documentElement.dataset.theme === t,
      [locale, theme]
    )
  }

  const pickCombobox = async (id, text) => {
    const input = page.locator(`#${id}`)
    await input.click()
    await input.fill(text)
    const listbox = await input.getAttribute('aria-controls')
    await page.locator(`[id="${listbox}"] [role=option]`).filter({ hasText: text }).first().click()
  }

  const openCreate = async () => {
    await page.goto(url('/owner/products/new'))
    await page.locator('#product-name').waitFor()
  }

  const fillProduct = async (sku, { opening = null } = {}) => {
    await page.locator('#product-name').fill(`Opening ${sku}`)
    await page.locator('#product-sku').fill(sku)
    await pickCombobox('product-category', '')
    await page.locator('#product-price').fill('12.50')
    if (opening) {
      await pickCombobox('product-opening-warehouse', 'Main')
      await page.locator('#product-opening-quantity').fill(opening)
    }
  }

  const directPost = async (path, body) =>
    await page.evaluate(
      async ([target, payload]) => {
        const token = (
          await (
            await fetch('/api/v1/company-owner/auth/csrf-token', {
              credentials: 'same-origin',
              headers: { Accept: 'application/json' }
            })
          ).json()
        ).data.csrf_token
        const response = await fetch(`/api/v1/company-owner${target}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-CSRF-TOKEN': token,
            'Idempotency-Key': crypto.randomUUID()
          },
          body: JSON.stringify(payload)
        })
        return { status: response.status, code: (await response.json()).code }
      },
      [path, body]
    )

  const productUuid = (sku) => fixture('create-owner-product', sku).uuid

  try {
    // --- sign in -------------------------------------------------------------------------------
    await page.goto(url('/owner/login'))
    await page.locator('#email').fill(ADMIN.email)
    await page.locator('#password').fill(ADMIN.password)
    await page.locator('button[type=submit]').click()
    await page.waitForURL((u) => !u.pathname.endsWith('/login'))
    await setPrefs('en', 'light')
    ctx.step('signed in')

    // --- 1. create a tracked product WITH optional opening stock --------------------------------
    await openCreate()
    await fillProduct('OSA-1', { opening: '5' })
    await page.getByTestId('opening-zero-cost').waitFor()
    await ctx.shot(page, 'create-with-opening-en-light')
    await page.getByTestId('product-submit').click()
    await page.waitForURL(/\/owner\/products\/[0-9a-f-]+\?tab=stock/)
    await page.getByTestId('stock-row-quantity').first().waitFor()
    assert.equal(await page.getByTestId('stock-row-quantity').first().textContent(), '5.000')
    const a = fixture('stock-position', 'OSA-1')
    assert.deepEqual(
      [a.products_with_sku, a.opening_adjustments, a.movements, a.position_events, a.journals],
      [1, 1, 1, 1, 0]
    )
    assert.equal(a.stock_row.average_unit_cost_amount, 0)
    ctx.step('create with opening stock', a)
    await ctx.shot(page, 'stock-tab-en-light')

    // --- 2. create WITHOUT opening stock, then initialize the eligible existing product ----------
    await openCreate()
    await fillProduct('OSB-1')
    await page.getByTestId('product-submit').click()
    await page.waitForURL(/\/owner\/products\/[0-9a-f-]+$/)
    assert.equal(fixture('stock-position', 'OSB-1').stock_row, null)
    await page.goto(page.url() + '?tab=stock')
    await page.getByTestId('stock-empty').waitFor()
    await page.getByTestId('opening-add').click()
    await pickCombobox('opening-dialog-warehouse', 'Main')
    await page.locator('#opening-dialog-quantity').fill('2.5')
    await ctx.shot(page, 'dialog-en-light')
    await page.getByTestId('opening-submit').click()
    await page.getByTestId('stock-row-quantity').first().waitFor()
    assert.equal(await page.getByTestId('stock-row-quantity').first().textContent(), '2.500')
    ctx.step('initialized existing product', fixture('stock-position', 'OSB-1'))

    // --- 3. a product WITH history: actionable conflict, nothing written -------------------------
    const colaBefore = fixture('stock-position', 'COLA-CAN')
    const colaUuid = await page.evaluate(async () => {
      const list = await (
        await fetch('/api/v1/company-owner/products?search=COLA-CAN', {
          credentials: 'same-origin',
          headers: { Accept: 'application/json' }
        })
      ).json()
      return list.data.find((p) => p.sku === 'COLA-CAN').id
    })
    await page.goto(url(`/owner/products/${colaUuid}?tab=stock`))
    await page.getByTestId('opening-add').click()
    await pickCombobox('opening-dialog-warehouse', 'Main')
    await page.locator('#opening-dialog-quantity').fill('1')
    await page.getByTestId('opening-submit').click()
    await page.getByText('already has stock history in this warehouse').waitFor()
    await ctx.shot(page, 'conflict-en-light')
    const colaAfter = fixture('stock-position', 'COLA-CAN')
    assert.equal(colaAfter.opening_adjustments, colaBefore.opening_adjustments)
    assert.equal(colaAfter.movements, colaBefore.movements)
    ctx.step('conflict refused', { code: 'OPENING_STOCK_POSITION_USED' })
    await page.keyboard.press('Escape')

    // --- 4. unticking tracking clears the dependent opening-stock fields ------------------------
    await openCreate()
    await pickCombobox('product-opening-warehouse', 'Main')
    await page.locator('#product-opening-quantity').fill('9')
    await page.locator('#product-track-stock').uncheck()
    assert.equal(await page.locator('#product-opening-quantity').count(), 0)
    await page.locator('#product-track-stock').check()
    assert.equal(await page.locator('#product-opening-quantity').inputValue(), '')
    ctx.step('untracking clears opening fields')
    const warehouseSearches = proxy.requests(/GET \/api\/v1\/company-owner\/warehouses\?/)
    assert.ok(
      warehouseSearches.length > 0 &&
        warehouseSearches.every((r) => /filter%5Bis_active%5D=1/.test(r.line)),
      'only ACTIVE warehouses are offered'
    )
    ctx.step('active warehouses only', { searches: warehouseSearches.length })

    // --- 5. lost answer while the original is still in flight (create) ---------------------------
    await openCreate()
    await fillProduct('OSC-1', { opening: '3' })
    const createHold = proxy.hold('hold-create', /^POST \/api\/v1\/company-owner\/products$/)
    await page.getByTestId('product-submit').click()
    await page.getByTestId('operation-unresolved').waitFor()
    assert.equal(
      await page.getByTestId('product-submit').count(),
      0,
      'no replacement submission while unresolved'
    )
    await page.getByTestId('operation-check').click()
    await page.getByTestId('operation-note').filter({ hasText: 'not proof' }).waitFor()
    assert.equal(
      fixture('stock-position', 'OSC-1').products_with_sku,
      0,
      'the original has not reached the server yet'
    )
    await ctx.shot(page, 'unresolved-create-en-light')
    await page.reload()
    await page.getByTestId('operation-unresolved').waitFor()
    assert.equal(
      await page.getByTestId('product-submit').count(),
      0,
      'a reload keeps the attempt locked'
    )
    const released = await createHold.release()
    assert.equal(released.status, 201)
    await page.getByTestId('operation-check').click()
    await page.waitForURL(/\/owner\/products\/[0-9a-f-]+\?tab=stock/)
    await page.getByTestId('stock-row-quantity').first().waitFor()
    const c = fixture('stock-position', 'OSC-1')
    assert.deepEqual(
      [c.products_with_sku, c.opening_adjustments, c.movements, c.position_events, c.journals],
      [1, 1, 1, 1, 0]
    )
    ctx.step('in-flight create resolved exactly once', c)

    // --- 6. lost answer while the original is still in flight (edit-page dialog) -----------------
    const d = productUuid('OSD-1')
    await page.goto(url(`/owner/products/${d}?tab=stock`))
    await page.getByTestId('opening-add').click()
    await pickCombobox('opening-dialog-warehouse', 'Main')
    await page.locator('#opening-dialog-quantity').fill('4')
    const dialogHold = proxy.hold('hold-opening', /^POST \/api\/v1\/company-owner\/opening-stock$/)
    await page.getByTestId('opening-submit').click()
    await page.getByTestId('operation-unresolved').waitFor()
    assert.equal(await page.getByTestId('opening-submit').count(), 0)
    await page.getByTestId('operation-check').click()
    await page
      .getByTestId('operation-observed')
      .filter({ hasText: 'does not show that this request failed' })
      .waitFor()
    await ctx.shot(page, 'unresolved-dialog-en-light')
    assert.equal((await dialogHold.release()).status, 201)
    await page.getByTestId('operation-check').click()
    await page.getByTestId('stock-row-quantity').first().waitFor()
    const dd = fixture('stock-position', 'OSD-1')
    assert.deepEqual([dd.opening_adjustments, dd.movements, dd.position_events], [1, 1, 1])
    ctx.step('in-flight dialog resolved exactly once', dd)

    // --- 7. a concurrent independent writer is never attributed to the unresolved request ---------
    const e = productUuid('OSE-1')
    await page.goto(url(`/owner/products/${e}?tab=stock`))
    await page.getByTestId('opening-add').click()
    await pickCombobox('opening-dialog-warehouse', 'Main')
    await page.locator('#opening-dialog-quantity').fill('6')
    const writerHold = proxy.hold('hold-writer', /^POST \/api\/v1\/company-owner\/opening-stock$/)
    await page.getByTestId('opening-submit').click()
    await page.getByTestId('operation-unresolved').waitFor()
    const independent = fixture('record-opening-stock', 'OSE-1:7')
    assert.equal(independent.result, 'recorded')
    await page.getByTestId('operation-check').click()
    await page
      .getByTestId('operation-observed')
      .filter({ hasText: 'does not show whether this request recorded it' })
      .waitFor()
    const observed = await page.getByTestId('operation-observed').textContent()
    assert.match(observed, /7\.000/)
    await ctx.shot(page, 'independent-writer-en-light')
    const late = await writerHold.release()
    assert.equal(late.status, 409)
    assert.equal(late.headers['idempotency-outcome'], 'refused')
    await page.getByTestId('operation-check').click()
    await page.getByText('This request was not recorded').waitFor()
    assert.equal(
      await page.getByTestId('opening-submit').count(),
      1,
      'a definitive refusal unlocks a NEW submission'
    )
    const ee = fixture('stock-position', 'OSE-1')
    assert.deepEqual([ee.opening_adjustments, ee.movements], [1, 1])
    ctx.step('independent writer not attributed', { independent, late: late.status, after: ee })
    await page.keyboard.press('Escape')

    // --- 8. adjust-only role, permission and feature states --------------------------------------
    fixture('owner-permission', 'inventory.view:0')
    fixture('owner-permission', 'inventory.manage:0')
    await openCreate()
    await page.getByTestId('opening-blocked').filter({ hasText: 'cannot view it' }).waitFor()
    await ctx.shot(page, 'adjust-only-en-light')
    fixture('owner-permission', 'inventory.view:1')
    fixture('owner-permission', 'inventory.manage:1')

    fixture('owner-permission', 'inventory.adjust:0')
    await openCreate()
    await page
      .getByTestId('opening-blocked')
      .filter({ hasText: 'needs permission to adjust stock' })
      .waitFor()
    const denied = await directPost('/opening-stock', {
      product_id: e,
      warehouse_id: await mainWarehouseUuid(page),
      quantity: '1'
    })
    assert.deepEqual(denied, { status: 403, code: 'PERMISSION_DENIED' })
    fixture('owner-permission', 'inventory.adjust:1')

    fixture('company-feature', 'inventory:0')
    await openCreate()
    await page
      .getByTestId('opening-blocked')
      .filter({ hasText: 'not included in your company' })
      .waitFor()
    const featureOff = await directPost('/opening-stock', {
      product_id: e,
      warehouse_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      quantity: '1'
    })
    assert.deepEqual(featureOff, { status: 403, code: 'FEATURE_NOT_ENABLED' })
    fixture('company-feature', 'inventory:1')
    ctx.step('access states', { denied, featureOff, injected: true })

    // --- 9. EN/AR × light/dark layouts ------------------------------------------------------------
    for (const locale of ['en', 'ar']) {
      for (const theme of ['light', 'dark']) {
        await openCreate()
        await setPrefs(locale, theme)
        await page.locator('#product-opening-quantity').waitFor()
        await page.locator('#product-opening-quantity').scrollIntoViewIfNeeded()
        await ctx.shot(page, `matrix-create-${locale}-${theme}`)
        await page.goto(url(`/owner/products/${d}?tab=stock`))
        await page.getByTestId('stock-row-quantity').first().waitFor()
        await ctx.shot(page, `matrix-stock-${locale}-${theme}`)
      }
    }
    ctx.step('layout matrix', { shots: 8 })
  } finally {
    await context.close().catch(() => undefined)
    await proxy.stop().catch(() => undefined)
    await sandbox.stop().catch(() => undefined)
  }
}

async function mainWarehouseUuid(page) {
  return await page.evaluate(async () => {
    const list = await (
      await fetch('/api/v1/company-owner/warehouses?search=Main', {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      })
    ).json()
    return list.data?.[0]?.id ?? 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  })
}
