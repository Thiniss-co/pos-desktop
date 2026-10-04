import {
  attemptExactCash,
  openSandboxAndApp,
  readiness,
  scan,
  setupPhysicalPresenceTill,
  waitForRoute
} from '../support/journey.mjs'
import { queryLocal } from '../support/localDb.mjs'

/** Shift the MAIN process wall clock (simulation; the renderer and the server keep real time). */
async function shiftMainClock(app, offsetMs) {
  await app.evaluate((_electron, offset) => {
    if (!globalThis.__posRealDate) {
      const Real = Date
      globalThis.__posRealDate = Real
      class Shifted extends Real {
        constructor(...args) {
          if (args.length === 0) super(Real.now() + (globalThis.__posDateOffset ?? 0))
          else super(...args)
        }
        static now() {
          return Real.now() + (globalThis.__posDateOffset ?? 0)
        }
      }
      Shifted.parse = Real.parse
      Shifted.UTC = Real.UTC
      globalThis.Date = Shifted
    }
    globalThis.__posDateOffset = offset
  }, offsetMs)
}

async function pinia(page, id, expression) {
  return await page.evaluate(
    ([storeId, expr]) =>
      new Function('s', `return (${expr})`)(
        document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get(storeId)
      ),
    [id, expression]
  )
}

async function cards(page) {
  return await page.evaluate(() =>
    [...document.querySelectorAll('.product-card-frame')].map((frame) => ({
      name: frame.querySelector('.product-card__name')?.textContent?.trim(),
      disabled: frame.querySelector('button.product-card')?.disabled === true,
      dimmed: frame.querySelector('.opacity-60') !== null
    }))
  )
}

/**
 * Stage 8 (Rev 4 §4.3, A8): a physical-presence authority LAPSES while the till is offline (1-hour
 * policy window; main's clock moved +61 min — a simulation). Cards stay enabled, the POS page
 * explains the situation, scanning still works, and completing an uncovered tracked sale is refused
 * as the NON-terminal `offline-sale-authority-unavailable` with its attempt and intent kept.
 */
export async function run(ctx) {
  const session = await openSandboxAndApp(ctx, {
    // The restore path: offline time limits switched back on, so a 1-hour window really lapses.
    flags: { POS_OFFLINE_PHYSICAL_PRESENCE_ENABLED: 'true', POS_OFFLINE_LIMITS_ENFORCED: 'true' },
    proxy: true
  })
  const { sandbox, proxy, app } = session
  const page = session.page
  try {
    await setupPhysicalPresenceTill(ctx, session, { windowHours: 1 })
    const before = await readiness(page)
    ctx.step('1-hour authority held', {
      mode: before.mode,
      remainingSeconds: before.remainingSeconds,
      lapsed: before.physicalPresenceLapsed
    })
    if (before.mode !== 'physical_presence') throw new Error('expected a usable PP authority')

    await proxy.offline()
    await shiftMainClock(app, 61 * 60_000)
    ctx.step('offline; main-process clock +61 min (simulation)')
    await page.waitForTimeout(1500)
    const lapsed = await readiness(page)
    ctx.step('readiness after the window ended', {
      mode: lapsed.mode,
      lapsed: lapsed.physicalPresenceLapsed,
      clockUntrusted: lapsed.clockUntrusted
    })
    if (lapsed.physicalPresenceLapsed !== true) throw new Error('expected physicalPresenceLapsed')

    await pinia(page, 'offlineSale', 's.refresh()')
    await page.locator('[data-testid="pp-notice-lapsed"]').waitFor({ timeout: 15_000 })
    const facts = await cards(page)
    ctx.step('cards while lapsed', facts)
    if (facts.some((card) => card.disabled || card.dimmed)) {
      throw new Error('a lapsed authority must never dim or disable a product')
    }
    await ctx.shot(page, '01-lapsed-notice-en')
    await pinia(page, 'locale', "s.setLocale('ar')")
    await page.waitForTimeout(600)
    await ctx.shot(page, '02-lapsed-notice-ar')
    await pinia(page, 'locale', "s.setLocale('en')")
    await page.waitForTimeout(400)

    await scan(ctx, page, '6221000000011')
    const outcome = await attemptExactCash(ctx, page)
    const attempts = queryLocal(
      session.profileDir,
      'SELECT state, intent_json IS NOT NULL AS has_intent, failure_code FROM sale_attempts'
    )
    ctx.step('uncovered tracked sale while lapsed', { outcome: outcome.outcome, attempts })
    if (outcome.outcome?.code !== 'offline-sale-authority-unavailable') {
      throw new Error(`expected offline-sale-authority-unavailable, got ${outcome.outcome?.code}`)
    }
    if (attempts.length !== 1 || attempts[0].state !== 'claimed' || attempts[0].has_intent !== 1) {
      throw new Error('the attempt must stay claimed with its intent (non-terminal)')
    }
    await ctx.shot(page, '03-payment-refused-non-terminal')
    await page.keyboard.press('Escape')
    await waitForRoute(page, 'pos')
  } finally {
    await session.app.close().catch(() => undefined)
    await proxy?.stop()
    await sandbox.stop()
  }
}
