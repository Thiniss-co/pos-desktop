import { t } from '../support/app.mjs'
import {
  activate,
  deviceUuid,
  openSandboxAndApp,
  openShift,
  payExactCash,
  refreshWorkstation,
  relaunch,
  scan,
  signIn,
  sizeWindow,
  waitForRoute,
  waitForServerInvoices
} from '../support/journey.mjs'
import { queryLocal } from '../support/localDb.mjs'

/**
 * PS6b — a quarantined physical-presence sale reaching its operator-decided outcome on the register,
 * through the real app, the real backend contract and the real disposition endpoint.
 *
 *  1. Allocation-mode warehouse: a COLA sale acquires a real grant and consumes sequence 1 (uploaded).
 *  2. The warehouse becomes physical presence; the register installs an authority and keeps the grant.
 *  3. Precondition (labelled fixture): the server ends the grant as `released`; the register is not told.
 *  4. Offline, two COLA sales consume sequences 2 and 3 of the held grant under the authority (v3).
 *     Reconnected, the first upload is QUARANTINED; the second waits on it (its chain predecessor).
 *  5. An operator accepts the first sale without proof — POST /invoices/dispositions, the real route.
 *  6. RESTART: discovery runs, verifies the stored result and converges atomically: the invoice is
 *     synced to the server's invoice, the overridden proof is recorded, the grant is held, the
 *     immutable journal is untouched. The hold releases the dependent sale into its own upload, which
 *     is quarantined in turn.
 *  7. The operator rejects the dependent sale permanently. RECONNECT: discovery applies it; the sale
 *     stays rejected locally and quarantined on the server, with its hold and no invoice.
 *  8. A further reconnect is an exact no-op (no new application, no second request for a decided row).
 */

const COLA = '6221000000011'

async function sell(ctx, page, label) {
  await scan(ctx, page, COLA)
  await payExactCash(ctx, page)
  await page
    .getByRole('dialog')
    .getByRole('button', { name: new RegExp(await t(page, 'pos.tender.newSale')) })
    .click()
  await page.waitForTimeout(500)
  ctx.step(`${label}: sale committed`)
}

function local(session, sql, params = []) {
  return queryLocal(session.profileDir, sql, params)
}

async function waitFor(description, probe, { timeout = 90_000, every = 1000, onTick } = {}) {
  const deadline = Date.now() + timeout
  let lastTick = Date.now()

  for (;;) {
    const value = probe()

    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`)
    if (onTick && Date.now() - lastTick >= 65_000) {
      lastTick = Date.now()
      await onTick()
    }
    await new Promise((resolve) => setTimeout(resolve, every))
  }
}

function queueRow(session, invoiceLocalUuid) {
  return local(
    session,
    `SELECT q.state, q.last_error_code, q.last_error_details, i.sync_status, i.remote_uuid, i.server_number
       FROM sync_queue q JOIN local_invoices i ON i.local_uuid = q.local_aggregate_uuid
      WHERE q.aggregate_type = 'invoice' AND q.local_aggregate_uuid = ?`,
    [invoiceLocalUuid]
  )[0]
}

async function dispose(sandbox, device, idempotencyKey, decision) {
  const { token } = sandbox.fixture('operator-token', device)
  const response = await fetch(new URL('/api/v1/desktop/invoices/dispositions', sandbox.origin), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'X-Device-UUID': device
    },
    body: JSON.stringify({
      idempotency_key: idempotencyKey,
      decision,
      justification: `PS6b journey: ${decision}`
    })
  })
  const body = await response.json()

  if (!response.ok) {
    throw new Error(`disposition ${decision} refused: ${response.status} ${JSON.stringify(body)}`)
  }

  return {
    status: response.status,
    decision: body.data.decision,
    outcomes: body.data.result.proof_results.map((proof) => [proof.outcome, proof.override_reason]),
    holds: body.data.result.required_holds.length
  }
}

async function reconnect(session) {
  await session.proxy.offline()
  await session.page.evaluate(async () => await window.posApi.connectivity.checkNow())
  await session.page.waitForTimeout(1500)
  await session.proxy.online()
  await session.page.evaluate(async () => await window.posApi.connectivity.checkNow())
}

export async function run(ctx) {
  const session = await openSandboxAndApp(ctx, {
    flags: {
      POS_OFFLINE_PHYSICAL_PRESENCE_ENABLED: 'true',
      STOCK_ALLOCATION_PREPARATION_ENABLED: 'true'
    },
    proxy: true
  })
  const { sandbox, proxy } = session
  let page = session.page

  try {
    await sizeWindow(session)
    await activate(ctx, page)
    await signIn(ctx, page)
    await waitForRoute(page, 'pos')
    const device = await deviceUuid(sandbox)
    sandbox.fixture('assign-device', device)
    ctx.step('1: allocation-mode warehouse', sandbox.fixture('mode-allocation', 'COLA-CAN'))
    await refreshWorkstation(ctx, page)
    await openShift(ctx, page)

    // 1. One online sale makes COLA a preparation candidate; offline stock preparation then grants
    //    an ADVANCE allocation with rights left over, and a refresh installs its coverage boundary.
    await sell(ctx, page, '1')
    await waitForServerInvoices(sandbox, device, 1, 90_000)
    await page.evaluate(async () => await window.posApi.preparation.runCycle())
    const advanceGrant = () =>
      local(
        session,
        `SELECT g.allocation_uuid, g.granted_quantity_milli, g.status,
                b.accepted_consumption_sequence IS NOT NULL AS covered
           FROM stock_allocation_grants g
           LEFT JOIN stock_allocation_coverage_boundaries b
             ON b.allocation_uuid = g.allocation_uuid AND b.rights_generation = g.rights_generation
          WHERE g.granted_quantity_milli >= 2000 AND g.status = 'active'
          ORDER BY g.received_at DESC LIMIT 1`
      )[0]
    let advance = null
    for (let tries = 0; tries < 30 && !advance; tries += 1) {
      advance = advanceGrant()
      if (!advance) {
        await page.waitForTimeout(1000)
        if (tries % 5 === 4)
          await page.evaluate(async () => await window.posApi.preparation.runCycle())
      }
    }
    if (!advance) throw new Error('1: no prepared (advance) grant arrived')
    for (let tries = 0; tries < 3 && advance.covered !== 1; tries += 1) {
      await refreshWorkstation(ctx, page)
      advance = advanceGrant()
    }
    ctx.step('1: advance grant held by the register', advance)
    if (advance?.covered !== 1) throw new Error('1: the advance grant never received its boundary')

    // 2. Physical presence; the grant stays held.
    ctx.step('2: policy -> physical presence', sandbox.fixture('mode-physical-presence'))
    await refreshWorkstation(ctx, page)
    const authorities = local(
      session,
      "SELECT authority_uuid FROM offline_sale_authorities WHERE mode = 'physical_presence'"
    )
    if (authorities.length < 1) throw new Error('2: no physical-presence authority installed')
    ctx.step('2: server grants after the policy change', sandbox.fixture('allocations', device))
    ctx.step('2: register grant after the policy change', advanceGrant() ?? null)

    // 3. The server ends the grant; the register is not told.
    const released = sandbox.fixture('release-allocations', device)
    ctx.step('3: precondition, server releases the grant', released)
    if (released.released < 1) throw new Error('3: the server held no active grant to release')

    // 4. Two offline sales on the held grant, then reconnect.
    await proxy.offline()
    await page.evaluate(async () => await window.posApi.connectivity.checkNow())
    await sell(ctx, page, '4a')
    await sell(ctx, page, '4b')
    const [saleA, saleB] = local(
      session,
      `SELECT i.local_uuid, i.upload_payload_version, i.offline_sale_authority_uuid,
              (SELECT COUNT(*) FROM local_stock_allocation_consumptions c
                WHERE c.invoice_local_uuid = i.local_uuid) AS proofs
         FROM local_invoices i ORDER BY i.created_at ASC LIMIT 2 OFFSET 1`
    )
    ctx.step('4: offline physical-presence sales with allocation proofs', { saleA, saleB })
    if (!saleA?.offline_sale_authority_uuid || saleA.proofs < 1 || saleB?.proofs < 1)
      throw new Error('4: expected two authority-backed sales carrying allocation proofs')
    const journalBefore = local(
      session,
      'SELECT * FROM local_stock_allocation_consumptions ORDER BY local_uuid'
    )

    await proxy.online()
    await page.evaluate(async () => await window.posApi.connectivity.checkNow())
    const quarantinedA = await waitFor('sale A to be quarantined', () => {
      const row = queueRow(session, saleA.local_uuid)
      return row?.state === 'rejected' && row.last_error_code === 'DESKTOP_INVOICE_QUARANTINED'
        ? row
        : null
    })
    ctx.step('4: sale A quarantined; sale B waits on it', {
      a: { state: quarantinedA.state, details: JSON.parse(quarantinedA.last_error_details) },
      b: queueRow(session, saleB.local_uuid)?.state
    })
    await ctx.shot(page, '04-quarantined')

    // 5. The operator accepts sale A without proof, through the real endpoint.
    const acceptA = await dispose(sandbox, device, saleA.local_uuid, 'accept_without_proof')
    ctx.step('5: operator accepted sale A', acceptA)

    // 6. Restart: discovery converges.
    await relaunch(ctx, session)
    page = session.page
    await waitForRoute(page, 'pos')
    const convergedA = await waitFor('sale A to converge', () => {
      const row = queueRow(session, saleA.local_uuid)
      return row?.state === 'synced' && row.sync_status === 'synced' ? row : null
    })
    const serverAfterA = sandbox.fixture('disposition-report', device)
    const serverA = serverAfterA.syncs.find((sync) => sync.idempotency_key === saleA.local_uuid)
    const applicationA = local(
      session,
      'SELECT decision, disposition_uuid, remote_invoice_uuid FROM invoice_disposition_applications WHERE invoice_local_uuid = ?',
      [saleA.local_uuid]
    )[0]
    const proofsA = local(
      session,
      'SELECT outcome, override_reason, server_consumption_uuid FROM invoice_disposition_proof_results WHERE invoice_local_uuid = ?',
      [saleA.local_uuid]
    )
    const holds = local(
      session,
      'SELECT allocation_uuid, first_overridden_sequence, invoice_local_uuid FROM stock_allocation_disposition_holds'
    )
    const journalAfter = local(
      session,
      'SELECT * FROM local_stock_allocation_consumptions ORDER BY local_uuid'
    )
    ctx.step('6: sale A converged after restart', {
      local: { remote: convergedA.remote_uuid, number: convergedA.server_number },
      server: serverA,
      application: applicationA,
      proofs: proofsA,
      holds,
      journalUnchanged: JSON.stringify(journalBefore) === JSON.stringify(journalAfter)
    })
    if (serverA?.status !== 'processed' || convergedA.remote_uuid !== serverA.invoice_uuid)
      throw new Error('6: the register did not converge on the server invoice')
    if (
      applicationA?.decision !== 'accept_without_proof' ||
      applicationA.disposition_uuid !== serverA.disposition_uuid
    )
      throw new Error('6: the applied decision is not the stored one')
    if (proofsA.length < 1 || proofsA.some((proof) => proof.outcome !== 'overridden'))
      throw new Error('6: expected the overridden proof to be recorded')
    if (holds.length < 1) throw new Error('6: no disposition hold installed')
    if (JSON.stringify(journalBefore) !== JSON.stringify(journalAfter))
      throw new Error('6: the immutable consumption journal changed')
    await ctx.shot(page, '06-converged-after-restart')

    // ...and the hold releases the dependent sale into its own upload and quarantine.
    const quarantinedB = await waitFor(
      'sale B to be quarantined',
      () => {
        const row = queueRow(session, saleB.local_uuid)
        return row?.state === 'rejected' && row.last_error_code === 'DESKTOP_INVOICE_QUARANTINED'
          ? row
          : null
      },
      { timeout: 120_000 }
    )
    ctx.step('6: dependent sale B uploaded and quarantined', {
      details: JSON.parse(quarantinedB.last_error_details)
    })

    // 7. The operator rejects sale B permanently; a reconnect applies it.
    const rejectB = await dispose(sandbox, device, saleB.local_uuid, 'reject_permanently')
    ctx.step('7: operator rejected sale B permanently', rejectB)
    await waitFor(
      'sale B decision to be applied',
      () =>
        local(
          session,
          'SELECT decision FROM invoice_disposition_applications WHERE invoice_local_uuid = ?',
          [saleB.local_uuid]
        )[0],
      { timeout: 300_000, every: 2000, onTick: () => reconnect(session) }
    )
    const rowB = queueRow(session, saleB.local_uuid)
    const serverAfterB = sandbox.fixture('disposition-report', device)
    const serverB = serverAfterB.syncs.find((sync) => sync.idempotency_key === saleB.local_uuid)
    ctx.step('7: sale B decision applied after reconnect', {
      local: { state: rowB.state, status: rowB.sync_status, remote: rowB.remote_uuid },
      server: serverB
    })
    if (rowB.state !== 'rejected' || rowB.sync_status !== 'rejected' || rowB.remote_uuid !== null)
      throw new Error('7: a permanently rejected sale must stay rejected with no server invoice')
    if (serverB?.status !== 'quarantined' || serverB.invoice_uuid !== null)
      throw new Error('7: the server holds an invoice for a rejected sale')

    // 8. Replay: another reconnect changes nothing.
    const before = local(session, 'SELECT COUNT(*) AS n FROM invoice_disposition_applications')[0].n
    const conflicts = local(session, 'SELECT COUNT(*) AS n FROM invoice_disposition_conflicts')[0].n
    await page.waitForTimeout(61_000)
    await reconnect(session)
    await page.waitForTimeout(5000)
    const after = local(session, 'SELECT COUNT(*) AS n FROM invoice_disposition_applications')[0].n
    const serverInvoices = sandbox.fixture('report', device).device_invoice_count
    ctx.step('8: replay is a no-op', {
      applications: [before, after],
      conflicts,
      serverInvoices
    })
    if (after !== before || after !== 2 || conflicts !== 0)
      throw new Error(
        '8: a repeated discovery changed the applied decisions or recorded a conflict'
      )
    if (serverInvoices !== 2)
      throw new Error('8: expected exactly two server invoices (sale 1 and A)')

    await page.goto(page.url().replace(/#.*$/, '#/sync'))
    await page.waitForTimeout(1500)
    await ctx.shot(page, '08-sync-page')
  } finally {
    ctx.facts.mainLogTail = session.logs
      .join('')
      .split('\n')
      .filter((line) => line.includes('sync-status') || line.includes('dispositions'))
      .slice(-40)
    await session.app.close().catch(() => undefined)
    await proxy?.stop()
    await sandbox.stop()
  }
}
