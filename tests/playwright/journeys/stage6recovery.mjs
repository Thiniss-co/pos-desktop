import { t } from '../support/app.mjs'
import {
  attemptExactCash,
  deviceUuid as findDevice,
  openSandboxAndApp,
  readiness,
  scan,
  setupPhysicalPresenceTill,
  waitForServerInvoices
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

function attempts(session) {
  return queryLocal(
    session.profileDir,
    'SELECT attempt_key, state, dispatch_evidence, failure_code, intent_json IS NOT NULL AS has_intent FROM sale_attempts ORDER BY claimed_at'
  )
}

/**
 * Stage 6 (Rev 4 §5/§9): a detected clock rollback refuses the commit as the NON-terminal
 * `clock-untrusted` (nothing claimed; readiness agrees — C11), and once the clock is corrected the
 * same cart completes and uploads exactly once. The legacy-evidence path is `stage6legacy`.
 */
export async function run(ctx) {
  const session = await openSandboxAndApp(ctx, {
    flags: { POS_OFFLINE_PHYSICAL_PRESENCE_ENABLED: 'true' },
    proxy: true
  })
  const { sandbox, proxy } = session
  let page = session.page
  try {
    await setupPhysicalPresenceTill(ctx, session)
    const device = await findDevice(sandbox)

    // 1. Clock rolled back 10 minutes (simulated in main): refused before any claim, and the
    //    readiness panel agrees (B4). Nothing is recorded.
    await shiftMainClock(session.app, -10 * 60_000)
    ctx.step('main-process clock shifted back 10 minutes (simulation)')
    await scan(ctx, page, '6221000000011')
    const rolled = await attemptExactCash(ctx, page)
    const ready = await readiness(page)
    ctx.step('clock rollback at checkout', {
      outcome: rolled.outcome,
      readinessClockUntrusted: ready.clockUntrusted,
      attempts: attempts(session)
    })
    if (rolled.outcome?.outcome !== 'failed') throw new Error('a rolled-back clock must refuse')
    if (ready.clockUntrusted !== true) throw new Error('readiness must agree with the commit (B4)')
    if (attempts(session).length !== 0)
      throw new Error('nothing may be claimed under a rolled-back clock')
    await ctx.shot(page, '01-clock-rollback-refused')

    if (rolled.outcome?.code !== 'clock-untrusted') {
      throw new Error(`expected clock-untrusted, got ${rolled.outcome?.code}`)
    }

    // 2. Clock restored: the cashier reopens payment (which re-validates) and the same cart completes.
    await shiftMainClock(session.app, 0)
    await page.keyboard.press('Escape')
    await page.getByRole('dialog').waitFor({ state: 'hidden', timeout: 10_000 })
    await page.keyboard.press('F9')
    await page.getByRole('dialog').waitFor({ timeout: 15_000 })
    await page.waitForTimeout(600)
    await page.keyboard.press('F9') // the cash row is already there: F9 completes
    await page.waitForTimeout(2500)
    ctx.step('after restoring the clock and retrying', {
      payment: await page.evaluate(() => {
        const s = document
          .querySelector('#app')
          .__vue_app__.config.globalProperties.$pinia._s.get('payment')
        return JSON.parse(
          JSON.stringify({
            preview: s.previewOutcome,
            outcome: s.completionOutcome,
            pending: s.completionPending,
            error: s.completionError
          })
        )
      }),
      dialog: (
        await page
          .getByRole('dialog')
          .innerText()
          .catch(() => '')
      )
        .replace(/\s+/g, ' ')
        .slice(0, 500)
    })
    await ctx.shot(page, '02a-after-retry')
    const prefix = (
      await t(page, 'pos.payment.completion.committed', { offlineNumber: '\u0000' })
    ).split('\u0000')[0]
    await page.getByText(prefix).first().waitFor({ timeout: 30_000 })
    await waitForServerInvoices(sandbox, device, 1)
    ctx.step('after the clock was corrected the sale committed and uploaded')
    await ctx.shot(page, '02-committed-after-clock-corrected')
  } finally {
    await session.app.close().catch(() => undefined)
    await proxy?.stop()
    await sandbox.stop()
  }
}
