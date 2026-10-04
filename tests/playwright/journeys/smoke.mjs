import {
  activate,
  currentRoute,
  deviceUuid,
  openSandboxAndApp,
  openShift,
  payExactCash,
  refreshWorkstation,
  scan,
  signIn,
  waitForRoute,
  waitForServerInvoices
} from '../support/journey.mjs'

/**
 * Stage 0 smoke: real Electron ↔ disposable Laravel, activation → sign-in → bootstrap → device
 * assignment → shift → scanner sale → exact cash → upload, asserted in both the UI and the backend.
 */
export async function run(ctx) {
  const session = await openSandboxAndApp(ctx)
  const { page, sandbox } = session
  try {
    await page.evaluate(() => window.resizeTo?.(1366, 850))
    await session.app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.isVisible())
      w?.setSize(1366, 850)
    })
    await activate(ctx, page)
    await signIn(ctx, page)
    await waitForRoute(page, 'pos')
    const uuid = await deviceUuid(sandbox)
    ctx.step('device assigned through the fence', sandbox.fixture('assign-device', uuid))
    await refreshWorkstation(ctx, page)
    await ctx.shot(page, '01-pos-after-assignment')
    await openShift(ctx, page)
    await scan(ctx, page, '6221000000011')
    await ctx.shot(page, '02-cart-after-scan')
    await payExactCash(ctx, page)
    await ctx.shot(page, '03-exact-cash-done')
    const report = await waitForServerInvoices(sandbox, uuid, 1)
    ctx.step('server report', report)
    const stock = sandbox.fixture('stock', 'COLA-CAN')
    ctx.step('server stock', stock)
    if (Number(stock.stock_items[0].quantity) !== 99) {
      throw new Error(`expected COLA-CAN stock 99, got ${stock.stock_items[0].quantity}`)
    }
    ctx.step('route', { route: await currentRoute(page) })
  } finally {
    ctx.facts.mainLogTail = session.logs
      .join('')
      .split('\n')
      .filter((l) => l.includes('api') || l.includes('POS'))
      .slice(-40)
    await session.app.close().catch(() => undefined)
    await sandbox.stop()
  }
}
