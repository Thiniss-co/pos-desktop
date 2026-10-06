/**
 * POS workspace journeys: shared helpers for exact viewports, real touch input, unfocused scanner
 * bursts, cart geometry (rows that are FULLY visible through every clipping ancestor) and a
 * read-only snapshot of the business state that a layout change must never alter.
 *
 * Geometry and snapshots are read from the live renderer; nothing here writes application state.
 */
import { t } from './app.mjs'
import {
  activate,
  deviceUuid,
  openShift,
  refreshWorkstation,
  signIn,
  waitForRoute
} from './journey.mjs'

export const VIEWPORTS = [
  [1920, 1080],
  [1366, 768],
  [1024, 768],
  [800, 600]
]

/** The deterministic 25-line fixture: WS-01…WS-25 (barcodes 62910000000NN). */
export const NAMED_PRODUCT_COUNT = 25
export const namedBarcode = (index) => `62910000000${String(index).padStart(2, '0')}`
/** The ordinary-cart fixture: PL-01…PL-25 with short single-line names (barcodes 62920000000NN). */
export const plainBarcode = (index) => `62920000000${String(index).padStart(2, '0')}`
/** Lines sold by weight in the fixture: scanned with a fractional quantity prefix. */
export const FRACTIONAL_LINES = { 16: '1.250', 17: '0.750', 25: '2.375' }

export async function pinia(page, id, expression) {
  return await page.evaluate(
    ([storeId, body]) => {
      const store = document
        .querySelector('#app')
        .__vue_app__.config.globalProperties.$pinia._s.get(storeId)
      return new Function('s', `return (${body})`)(store)
    },
    [id, expression]
  )
}

/** Sets the renderer viewport exactly (content size) and returns what the renderer reports. */
export async function setContentViewport(session, width, height) {
  await session.app.evaluate(
    ({ BrowserWindow }, [w, h]) => {
      const win = BrowserWindow.getAllWindows().find((x) => x.isVisible())
      if (win?.isMaximized()) win.unmaximize()
      win?.setContentSize(w, h)
    },
    [width, height]
  )
  const page = session.page
  await page
    .waitForFunction(
      ([w, h]) => window.innerWidth === w && window.innerHeight === h,
      [width, height],
      { timeout: 5_000 }
    )
    .catch(() => undefined)
  await settle(page)
  const actual = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    zoom: Math.round((window.outerWidth / window.innerWidth) * 100) / 100
  }))
  if (actual.innerWidth !== width || actual.innerHeight !== height) {
    throw new Error(
      `viewport ${width}x${height} requested, renderer reports ${JSON.stringify(actual)}`
    )
  }
  return actual
}

/** Waits until two consecutive animation frames report the same document layout. */
export async function settle(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        let last = ''
        let stable = 0
        const tick = () => {
          const lines = document.querySelector('.cart-panel__lines')?.getBoundingClientRect()
          const key = `${window.innerWidth}x${window.innerHeight}:${lines?.width}:${lines?.height}:${document.body.scrollWidth}`
          stable = key === last ? stable + 1 : 0
          last = key
          if (stable >= 3) resolve(undefined)
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
  )
  await page.waitForTimeout(150)
}

export async function touchSession(page) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  return cdp
}

/** One real touch tap at the centre of the element (fails if something else is under the point). */
export async function tap(cdp, locator) {
  await locator.waitFor({ state: 'visible' })
  await locator.scrollIntoViewIfNeeded()
  let box = await locator.boundingBox()
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await locator.page().waitForTimeout(100)
    const next = await locator.boundingBox()
    if (box && next && Math.abs(next.x - box.x) < 0.5 && Math.abs(next.y - box.y) < 0.5) break
    box = next
  }
  if (!box) throw new Error('tap: element has no box')
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const hit = await locator.evaluate(
    (element, [x, y]) => {
      const under = document.elementFromPoint(x, y)
      return under === element || element.contains(under)
        ? null
        : { under: under?.outerHTML.slice(0, 160) ?? null, target: element.outerHTML.slice(0, 160) }
    },
    [point.x, point.y]
  )
  if (hit) throw new Error(`tap: the point is covered: ${JSON.stringify(hit)}`)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await locator.page().waitForTimeout(150)
}

/** A real touch drag from the centre of `locator` by (dx, dy), in steps. */
export async function touchDrag(cdp, locator, dx, dy, steps = 8) {
  await locator.waitFor({ state: 'visible' })
  const box = await locator.boundingBox()
  if (!box) throw new Error('touchDrag: element has no box')
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] })
  for (let i = 1; i <= steps; i += 1) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: start.x + (dx * i) / steps, y: start.y + (dy * i) / steps }]
    })
    await locator.page().waitForTimeout(16)
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await locator.page().waitForTimeout(200)
}

function cartSignature() {
  const s = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('cart')
  return JSON.stringify(
    (s?.lines ?? []).map((l) => [l.productUuid ?? l.uuid ?? '', String(l.quantity)])
  )
}

export async function cartSignatureOf(page) {
  return await page.evaluate(cartSignature)
}

/**
 * A keyboard-wedge scan with NO field focused: the characters arrive 5ms apart (a scanner, not a
 * person) and end with `suffix` ('Enter', 'Tab' or '' for none). Returns whether the cart changed.
 */
export async function scanBurst(
  page,
  code,
  { suffix = 'Enter', expectChange = true, blur = true } = {}
) {
  const before = await page.evaluate(cartSignature)
  if (blur) {
    await page.evaluate(() => {
      const active = document.activeElement
      if (active instanceof HTMLElement && active !== document.body) active.blur()
    })
  }
  await page.keyboard.type(code, { delay: 5 })
  if (suffix) await page.keyboard.press(suffix)
  if (!expectChange) {
    await page.waitForTimeout(700)
    return (await page.evaluate(cartSignature)) !== before
  }
  // Polled from Node: an in-page waitForFunction loop was observed to delay the detector's
  // suffix-less completion timer by >10 s in this harness (docs/audits/pos-workspace/REPORT.md);
  // measured from Node, every suffix lands in ~130-240 ms.
  const started = Date.now()
  while (Date.now() - started < 10_000) {
    if ((await page.evaluate(cartSignature)) !== before) return true
    await page.waitForTimeout(40)
  }
  const facts = await page.evaluate(() => ({
    active: document.activeElement?.outerHTML.slice(0, 160) ?? null,
    result: document.querySelector('.scan-entry__result')?.textContent?.trim() ?? null,
    field: document.querySelector('#scan-entry-input')?.value ?? null
  }))
  throw new Error(
    `scan burst ${code} (${suffix || 'no suffix'}) did not change the cart: ${JSON.stringify(facts)}`
  )
}

/** Types into the scan field (focused) and submits: the cashier's manual path. */
export async function scanInField(page, entry) {
  const before = await page.evaluate(cartSignature)
  const input = page.locator('#scan-entry-input')
  await input.click()
  await input.fill(entry)
  await page.keyboard.press('Enter')
  await page.waitForFunction(
    ([fn, previous]) => new Function(`return (${fn})()`)() !== previous,
    [cartSignature.toString(), before],
    { timeout: 10_000 }
  )
}

/**
 * Builds the 25-line cart through the scan field: each fixture product once, the weighed ones with a
 * fractional quantity prefix (`1.250*<barcode>`), exactly as a cashier would key them.
 */
export async function buildNamedCart(ctx, page, count = NAMED_PRODUCT_COUNT) {
  for (let index = 1; index <= count; index += 1) {
    const fraction = FRACTIONAL_LINES[index]
    await scanInField(page, fraction ? `${fraction}*${namedBarcode(index)}` : namedBarcode(index))
  }
  const lines = await pinia(page, 'cart', 's.lines.length')
  if (lines !== count) throw new Error(`expected ${count} cart lines, found ${lines}`)
  ctx.step('named cart built through the scan field', { lines })
}

/**
 * The legacy (allocation-free, online) till used by the workspace journeys: activation → sign-in →
 * device assignment → the long-name fixture → refresh → shift.
 */
export async function setupNamedTill(
  ctx,
  session,
  { products = NAMED_PRODUCT_COUNT, plainProducts = 0 } = {}
) {
  const { page, sandbox } = session
  await setContentViewport(session, 1366, 768)
  await activate(ctx, page)
  await signIn(ctx, page)
  await waitForRoute(page, 'pos')
  const uuid = await deviceUuid(sandbox)
  ctx.step('device assigned through the fence', sandbox.fixture('assign-device', uuid))
  const fixture = sandbox.fixture('create-named-products', String(products))
  ctx.step('named products precondition', { count: fixture.products.length })
  if (plainProducts > 0) {
    const plain = sandbox.fixture('create-plain-products', String(plainProducts))
    ctx.step('plain products precondition', { count: plain.products.length })
  }
  await refreshWorkstation(ctx, page)
  await openShift(ctx, page)
  return { device: uuid, products: fixture.products }
}

/**
 * Cart geometry at scrollTop 0. A row counts as fully visible only when its whole rectangle lies
 * inside the viewport AND inside every ancestor that clips (overflow other than `visible`).
 * "Ordinary" rows are rows whose name fits on one line and that carry no offer label.
 */
export async function measureCart(page) {
  return await page.evaluate(() => {
    const round = (n) => Math.round(n * 10) / 10
    const rectOf = (selector) => {
      const element = document.querySelector(selector)
      if (!element) return null
      const style = getComputedStyle(element)
      if (style.display === 'none' || style.visibility === 'hidden') return null
      const r = element.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) return null
      return { x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height) }
    }
    const clipRect = (element) => {
      let rect = { top: 0, left: 0, bottom: window.innerHeight, right: window.innerWidth }
      for (let node = element.parentElement; node; node = node.parentElement) {
        const style = getComputedStyle(node)
        const clips = [style.overflow, style.overflowX, style.overflowY].some(
          (v) => v && v !== 'visible'
        )
        if (!clips) continue
        const r = node.getBoundingClientRect()
        rect = {
          top: Math.max(rect.top, r.top + node.clientTop),
          left: Math.max(rect.left, r.left + node.clientLeft),
          bottom: Math.min(rect.bottom, r.top + node.clientTop + node.clientHeight),
          right: Math.min(rect.right, r.left + node.clientLeft + node.clientWidth)
        }
      }
      return rect
    }
    const lines = document.querySelector('.cart-panel__lines')
    const scrollers = []
    for (let node = lines; node; node = node.parentElement) {
      if (node.scrollTop > 0) scrollers.push(node)
    }
    scrollers.forEach((node) => (node.scrollTop = 0))
    const rows = [...document.querySelectorAll('.cart-line-item')].map((row) => {
      const r = row.getBoundingClientRect()
      const clip = clipRect(row)
      const name = row.querySelector('.cart-line-item__name')
      const nameStyle = name ? getComputedStyle(name) : null
      const lineHeight = nameStyle ? Number.parseFloat(nameStyle.lineHeight) || 20 : 20
      const nameLines = name ? Math.round(name.getBoundingClientRect().height / lineHeight) : 0
      const offer = row.querySelector('[data-testid="cart-line-offer"]') !== null
      const tol = 0.5
      const fullyVisible =
        r.height > 0 &&
        r.top >= clip.top - tol &&
        r.bottom <= clip.bottom + tol &&
        r.left >= clip.left - tol &&
        r.right <= clip.right + tol
      return {
        height: round(r.height),
        width: round(r.width),
        nameLines,
        offer,
        ordinary: nameLines <= 1 && !offer,
        fullyVisible
      }
    })
    const visibleRows = rows.filter((r) => r.fullyVisible)
    const scroller = document.scrollingElement
    const linesRect = rectOf('.cart-panel__lines')
    const cartRect = rectOf('.pos-workspace-shell__cart')
    const heights = rows.map((r) => r.height).sort((a, b) => a - b)
    return {
      viewport: {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio
      },
      dir: document.documentElement.dir,
      touch: document.documentElement.dataset.touch ?? null,
      density: document.querySelector('[data-density]')?.getAttribute('data-density') ?? null,
      preset: document.querySelector('[data-preset]')?.getAttribute('data-preset') ?? null,
      regions: {
        topBar: rectOf('header'),
        notices: rectOf('header + div'),
        workspace: rectOf('.pos-workspace-shell__body'),
        catalog: rectOf('.pos-workspace-shell__catalog'),
        rail: rectOf('.pos-workspace-shell__rail'),
        cart: cartRect,
        cartHeader: rectOf('.pos-page__cart-header'),
        customerRow: rectOf('.pos-page__customer-row'),
        toolbar: rectOf('.quick-actions'),
        touchBar: rectOf('.pos-page__touch-bar'),
        scan: rectOf('.scan-entry'),
        columnHeader: rectOf('.pos-page__cart-columns'),
        lines: linesRect,
        footer: rectOf('.cart-panel__footer'),
        compactBar: rectOf('.pos-workspace-shell__compact-bar')
      },
      cartChromeHeight: cartRect && linesRect ? round(cartRect.height - linesRect.height) : null,
      rows: {
        total: rows.length,
        fullyVisible: visibleRows.length,
        fullyVisibleOrdinary: visibleRows.filter((r) => r.ordinary).length,
        ordinaryTotal: rows.filter((r) => r.ordinary).length,
        wrappedTotal: rows.filter((r) => r.nameLines > 1).length,
        minHeight: heights[0] ?? null,
        medianHeight: heights[Math.floor(heights.length / 2)] ?? null,
        maxHeight: heights[heights.length - 1] ?? null,
        ordinaryHeight:
          rows
            .filter((r) => r.ordinary)
            .map((r) => r.height)
            .sort((a, b) => a - b)[0] ?? null
      },
      horizontalOverflow: scroller.scrollWidth > window.innerWidth + 1,
      pageOverflowY: (() => {
        const main = document.querySelector('main')
        if (!main) return null
        const bottom = main.getBoundingClientRect().bottom
        const culprits = [
          ...main.querySelectorAll(':scope > * , :scope > * > *, .pos-workspace-shell__body > *')
        ]
          .map((element) => ({
            cls: String(element.className).slice(0, 60),
            bottom: Math.round(element.getBoundingClientRect().bottom)
          }))
          .filter((entry) => entry.bottom > bottom + 1)
        return { amount: main.scrollHeight - main.clientHeight, culprits: culprits.slice(0, 4) }
      })(),
      footerFullyVisible: (() => {
        const footer = document.querySelector('.cart-panel__footer')
        if (!footer) return null
        const r = footer.getBoundingClientRect()
        const clip = clipRect(footer)
        return r.height > 0 && r.top >= clip.top - 0.5 && r.bottom <= clip.bottom + 0.5
      })()
    }
  })
}

/**
 * Everything a layout change must leave untouched, read from the live stores (read-only): cart lines
 * with their catalog evidence, quantities and amounts, invoice discount, customer, held drafts,
 * totals and the payment state.
 */
export async function businessSnapshot(page) {
  return await page.evaluate(() => {
    const stores = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s
    const cart = stores.get('cart')
    const catalog = stores.get('catalog')
    const payment = stores.get('payment')
    const plain = (value) => JSON.parse(JSON.stringify(value ?? null))
    return plain({
      lines: (cart?.lines ?? []).map((line) => ({
        id: line.id,
        product: line.product,
        quantity: line.quantity
      })),
      invoiceDiscount: [cart?.invoiceDiscountType ?? null, cart?.invoiceDiscountValue ?? null],
      calculation: cart?.calculation ?? null,
      heldDrafts: cart?.heldDrafts ?? [],
      customer: catalog?.selectedCustomerUuid ?? null,
      payment: payment
        ? {
            rows: payment.rows ?? null,
            attemptKey: payment.attemptKey ?? null,
            completionPending: payment.completionPending ?? null,
            completionOutcome: payment.completionOutcome ?? null
          }
        : null
    })
  })
}

export function diffSnapshots(before, after) {
  const a = JSON.stringify(before)
  const b = JSON.stringify(after)
  if (a === b) return null
  let index = 0
  while (index < a.length && a[index] === b[index]) index += 1
  return {
    at: index,
    before: a.slice(Math.max(0, index - 80), index + 120),
    after: b.slice(Math.max(0, index - 80), index + 120)
  }
}

/** Every visible enabled control smaller than 44×44 CSS px. */
export async function smallControls(page) {
  return await page.evaluate(() => {
    const selector =
      "button, [role='button'], [role='switch'], [role='menuitem'], [role='separator'][tabindex], a[href], select, input:not([type='hidden'])"
    return [...document.querySelectorAll(selector)]
      .filter((element) => {
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return (
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          Number(style.opacity) > 0 &&
          rect.width > 1 &&
          rect.height > 1 &&
          !element.disabled &&
          element.closest('[aria-hidden="true"], .sr-only, [inert]') === null
        )
      })
      .map((element) => {
        const rect = element.getBoundingClientRect()
        return {
          text: (element.getAttribute('aria-label') ?? element.textContent ?? '')
            .trim()
            .slice(0, 40),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      })
      .filter((entry) => entry.width < 44 || entry.height < 44)
  })
}

export async function setLocaleTheme(page, locale, theme) {
  await pinia(page, 'locale', `s.setLocale('${locale}')`)
  await pinia(page, 'theme', `s.setTheme('${theme}')`)
  await page.waitForTimeout(200)
}

export async function setTouchMode(page, on) {
  await pinia(page, 'userPreferences', `s.set('ui.touchMode', ${on ? 'true' : 'false'})`)
  await page.waitForFunction(
    (expected) => (document.documentElement.dataset.touch === 'on') === expected,
    on,
    { timeout: 10_000 }
  )
  await page.waitForTimeout(200)
}

export { t }

/**
 * POS workspace toolbar: the action button when it is on the row, otherwise the same action in the
 * More menu (opened first). Works the same for every journey, whatever width the cart has.
 */
export async function quickAction(page, id) {
  const inline = page.locator(`.quick-actions button[data-action="${id}"]`).first()
  if (await inline.isVisible().catch(() => false)) return inline
  await page.locator('.quick-actions [data-action="more"]').first().click()
  const item = page.locator(`[role="menuitem"][data-action="${id}"]`).first()
  await item.waitFor({ state: 'visible', timeout: 5_000 })
  return item
}

/** More → Quick create… → the existing quick-create chooser dialog. */
export async function openQuickCreateMenu(page) {
  await (await quickAction(page, 'quick-create')).click()
  await page.getByTestId('more-actions-dialog').waitFor()
}

/** Opens a cart line's menu and returns its Remove action (role menuitem, named "Remove <name>"). */
export async function lineRemoveAction(page, name) {
  await page
    .getByRole('button', { name: await t(page, 'pos.workspace.lineActions', { name }) })
    .click()
  const remove = page.getByRole('menuitem', { name: await t(page, 'pos.cart.removeOf', { name }) })
  await remove.waitFor({ state: 'visible', timeout: 5_000 })
  return remove
}
