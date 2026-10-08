import { openQuickCreateMenu } from '../support/workspace.mjs'
import { launchApp, t } from '../support/app.mjs'
import { openSandboxAndApp, setupPhysicalPresenceTill, waitForRoute } from '../support/journey.mjs'
import { queryLocal } from '../support/localDb.mjs'

/**
 * V1 Windows readiness — register quick-create through a REAL process termination (SIGKILL).
 *
 *  A. Offline: a customer is quick-created with the network down (queued), the till is killed, it
 *     restarts still offline (the request survives with its key and frozen bytes), then reconnects:
 *     the server holds exactly one customer for it.
 *  B. Lost answer: online, the server commits the customer but its answer is held back; the till is
 *     killed while the request is in flight, restarts, and replays the SAME request: still exactly
 *     one customer (the server answers the replay with the original).
 */
const CUSTOMERS = /^POST \/api\/v1\/desktop\/quick-create\/customers/

async function quickCreateCustomer(ctx, page, name) {
  await openQuickCreateMenu(page)
  await page.getByTestId('more-actions-customer').click()
  const dialog = page.getByTestId('quick-create-dialog')
  await dialog.waitFor()
  await dialog
    .getByLabel(await t(page, 'quickCreate.field.name'))
    .first()
    .fill(name)
  await page.getByTestId('quick-create-save').click()
  await dialog.waitFor({ state: 'detached', timeout: 15_000 })
  ctx.step('customer quick-created through the dialog', { name })
}

function outbox(profileDir, name) {
  const [row] = queryLocal(
    profileDir,
    `SELECT request_key, client_entity_uuid, state, dispatch_count, canonical_payload_json
       FROM entity_create_outbox
      WHERE entity_type = 'customer' AND canonical_payload_json LIKE ?
      ORDER BY rowid DESC LIMIT 1`,
    [`%${name}%`]
  )
  return row ?? null
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

async function kill(session) {
  const child = session.app.process()
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGKILL')
  await exited
}

async function relaunchAfterKill(ctx, session) {
  Object.assign(
    session,
    await launchApp({ outDir: session.outDir, profileDir: session.profileDir })
  )
  await waitForRoute(session.page, 'pos')
  ctx.step('relaunched on the same profile after SIGKILL')
}

async function setOnline(session, on) {
  if (on) await session.proxy.online()
  else await session.proxy.offline()
  await session.page.evaluate(async () => await window.posApi.connectivity.checkNow())
}

function serverCustomer(sandbox, clientUuid) {
  const report = sandbox.fixture('quick-create-report')
  return {
    customers: report.customers.filter((row) => row.uuid === clientUuid).length,
    requests: report.requests.filter(
      (row) => row.entity_type === 'customer' && row.client_entity_uuid === clientUuid
    )
  }
}

export async function run(ctx) {
  const session = await openSandboxAndApp(ctx, {
    flags: { POS_OFFLINE_PHYSICAL_PRESENCE_ENABLED: 'true' },
    proxy: true
  })
  const { sandbox, proxy } = session
  try {
    sandbox.fixture('quick-create-grant', 'cashier:customers.create:1')
    await setupPhysicalPresenceTill(ctx, session)

    // A. Offline, killed, restarted offline, reconnected.
    await setOnline(session, false)
    await quickCreateCustomer(ctx, session.page, 'Qck Offline Customer')
    const queued = await until(
      () => outbox(session.profileDir, 'Qck Offline Customer'),
      (row) => row?.state === 'pending',
      'A: the request was not queued'
    )
    await kill(session)
    await relaunchAfterKill(ctx, session)
    const afterRestart = outbox(session.profileDir, 'Qck Offline Customer')
    ctx.step('A: queued request after SIGKILL and an offline restart', {
      state: afterRestart?.state,
      sameKey: afterRestart?.request_key === queued.request_key,
      sameBytes: afterRestart?.canonical_payload_json === queued.canonical_payload_json
    })
    if (
      afterRestart?.request_key !== queued.request_key ||
      afterRestart.canonical_payload_json !== queued.canonical_payload_json
    )
      throw new Error('A: the queued request changed across the kill')
    await setOnline(session, true)
    const createdA = await until(
      () => outbox(session.profileDir, 'Qck Offline Customer'),
      (row) => row?.state === 'accepted' || row?.state === 'created',
      'A: the request was not accepted after reconnect'
    )
    const serverA = serverCustomer(sandbox, queued.client_entity_uuid)
    ctx.step('A: after reconnect', { local: createdA.state, server: serverA })
    if (serverA.customers !== 1) throw new Error('A: the server does not hold exactly one customer')

    // B. The server commits; its answer is held; the till is killed meanwhile.
    proxy.rule('customer-answer-held', CUSTOMERS, { delayResponseMs: 600_000, times: 1 })
    await quickCreateCustomer(ctx, session.page, 'Qck Lost Customer')
    const inFlight = await until(
      () => outbox(session.profileDir, 'Qck Lost Customer'),
      (row) => row !== null && serverCustomer(sandbox, row.client_entity_uuid).customers === 1,
      'B: the server never committed the customer'
    )
    ctx.step('B: server committed; till waiting for the answer', {
      state: inFlight.state,
      dispatches: inFlight.dispatch_count
    })
    await kill(session)
    proxy.clear('customer-answer-held')
    await relaunchAfterKill(ctx, session)
    const createdB = await until(
      () => outbox(session.profileDir, 'Qck Lost Customer'),
      (row) => row?.state === 'accepted' || row?.state === 'created',
      'B: the replayed request was not accepted'
    )
    const serverB = serverCustomer(sandbox, inFlight.client_entity_uuid)
    ctx.step('B: after restart and replay', {
      local: createdB.state,
      dispatches: createdB.dispatch_count,
      sameKey: createdB.request_key === inFlight.request_key,
      sameBytes: createdB.canonical_payload_json === inFlight.canonical_payload_json,
      server: serverB
    })
    await ctx.shot(session.page, 'B1-after-replay')
    if (serverB.customers !== 1) throw new Error('B: the server does not hold exactly one customer')
    if (createdB.request_key !== inFlight.request_key)
      throw new Error('B: the replay used another request key')
    if (createdB.canonical_payload_json !== inFlight.canonical_payload_json)
      throw new Error('B: the replay changed the frozen request')
  } finally {
    await session.app.close().catch(() => undefined)
    await proxy?.stop().catch(() => undefined)
    await sandbox.stop()
  }
}
