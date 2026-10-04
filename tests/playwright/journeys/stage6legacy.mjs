import { spawnSync } from 'node:child_process'
import { t } from '../support/app.mjs'
import {
  activate,
  attemptExactCash,
  deviceUuid as findDevice,
  launchAgain,
  openSandboxAndApp,
  openShift,
  refreshWorkstation,
  scan,
  signIn,
  sizeWindow,
  waitForRoute
} from '../support/journey.mjs'
import { localDatabasePath, queryLocal } from '../support/localDb.mjs'

const TOPUP = /stock-allocations\/top-up/

function attempts(session) {
  return queryLocal(
    session.profileDir,
    'SELECT attempt_key, state, dispatch_evidence, failure_code, intent_json IS NOT NULL AS has_intent FROM sale_attempts ORDER BY claimed_at'
  )
}

/**
 * Stage 6 (Rev 4 §9): a real claimed attempt (allocation-mode warehouse, top-up answered 503 through
 * the proxy) is visible in Sync "Needs attention" and in the POS recovery banner; once marked as a
 * legacy-evidence attempt (the precondition migration 0016 writes for attempts claimed by an older
 * build — simulated with that same UPDATE while the app is closed), cancelling requires the explicit
 * acknowledgement and records the uncertainty with its intent before abandoning.
 */
export async function run(ctx) {
  const session = await openSandboxAndApp(ctx, { proxy: true })
  const { sandbox, proxy } = session
  let page = session.page
  try {
    await sizeWindow(session)
    await activate(ctx, page)
    await signIn(ctx, page)
    await waitForRoute(page, 'pos')
    const device = await findDevice(sandbox)
    sandbox.fixture('assign-device', device)
    ctx.step(
      'allocation-mode control warehouse',
      sandbox.fixture('mode-allocation', 'COLA-CAN,WATER-500,CHIPS-S')
    )
    await refreshWorkstation(ctx, page)
    await openShift(ctx, page)

    proxy.rule('503 top-up', TOPUP, { status: 503, code: 'SERVICE_UNAVAILABLE' })
    await scan(ctx, page, '6221000000011')
    const outcome = await attemptExactCash(ctx, page)
    ctx.step('allocation top-up 503 leaves the attempt claimed', {
      outcome: outcome.outcome,
      attempts: attempts(session)
    })
    const claimed = attempts(session).at(-1)
    if (claimed?.state !== 'claimed') throw new Error('expected a claimed attempt')
    await ctx.shot(page, '01-claimed-after-top-up-503')
    await page.keyboard.press('Escape')
    await page.goto(page.url().replace(/#.*$/, '#/sync'))
    await waitForRoute(page, 'sync')
    await page.waitForTimeout(1500)
    await ctx.shot(page, '02-sync-needs-attention')

    // Simulated legacy precondition, written while the app is closed.
    await session.app.close()
    const upd = spawnSync(
      'python3',
      [
        '-c',
        "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(\"UPDATE sale_attempts SET dispatch_evidence='unknown' WHERE attempt_key=? AND state='claimed'\", (sys.argv[2],)); c.commit(); print(c.total_changes)",
        localDatabasePath(session.profileDir),
        claimed.attempt_key
      ],
      { encoding: 'utf8' }
    )
    ctx.step('simulated legacy precondition (dispatch_evidence=unknown)', {
      changes: upd.stdout.trim()
    })
    proxy.clear('503 top-up')
    await launchAgain(ctx, session)
    page = session.page
    await waitForRoute(page, 'pos')
    await page.waitForTimeout(2000)
    await ctx.shot(page, '03-legacy-attempt-banner')
    const intentBefore = attempts(session).find((a) => a.attempt_key === claimed.attempt_key)
    ctx.step('legacy attempt after restart', intentBefore)
    if (intentBefore?.has_intent !== 1) throw new Error('the legacy attempt must keep its intent')

    await page
      .getByRole('button', { name: await t(page, 'pos.payment.completion.abandon') })
      .first()
      .click()
    await ctx.shot(page, '04-legacy-cancel-warning')
    await page
      .getByRole('button', { name: await t(page, 'pos.payment.completion.confirmAbandon') })
      .first()
      .click()
    await page.waitForTimeout(1500)
    const after = attempts(session).find((a) => a.attempt_key === claimed.attempt_key)
    const uncertainty = queryLocal(
      session.profileDir,
      'SELECT attempt_key, status FROM legacy_dispatch_uncertainties WHERE attempt_key = ?',
      [claimed.attempt_key]
    )
    ctx.step('legacy acknowledgement-cancel', { attempt: after, uncertainty })
    if (after?.state !== 'abandoned' || uncertainty.length !== 1) {
      throw new Error('the uncertainty must be recorded before the legacy attempt is abandoned')
    }
    await page.goto(page.url().replace(/#.*$/, '#/sync'))
    await waitForRoute(page, 'sync')
    await page.waitForTimeout(1500)
    await ctx.shot(page, '05-sync-needs-support-legacy')
  } finally {
    await session.app.close().catch(() => undefined)
    await proxy?.stop()
    await sandbox.stop()
  }
}
