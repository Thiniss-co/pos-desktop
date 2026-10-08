import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { store, t } from '../support/app.mjs'
import {
  activate,
  deviceUuid,
  openShift,
  payExactCash,
  refreshWorkstation,
  scan,
  signIn,
  waitForRoute,
  waitForServerInvoices
} from '../support/journey.mjs'
import { queryLocal } from '../support/localDb.mjs'
import {
  PACKAGED_APP_DIR,
  buildUpdateTestAppImages,
  launchPackagedApp
} from '../support/packagedApp.mjs'
import { startProxy } from '../support/proxy.mjs'
import { freePort, startSandbox } from '../support/sandbox.mjs'
import { startStaticFeed } from '../support/staticFeed.mjs'

/**
 * V1 Windows readiness — a real PACKAGED upgrade from version A to version B through the automatic
 * updater, with durable offline work pending. Linux AppImage (the only package this host can run and
 * upgrade); the Windows NSIS upgrade is the same flow and is BLOCKED here (no Windows environment).
 *
 *  1. A (1.0.0) and B (1.0.1) are built from the same source; B's AppImage and latest-linux.yml are
 *     served by an isolated local feed. A signs in, opens a shift and downloads B in the background.
 *  2. A sale is made offline: it stays queued (pending upload). A cart line is on screen.
 *  3. The restart is refused while the cart line is on screen; once the cart is empty it is accepted:
 *     A quits through its normal shutdown and the updater installs B.
 *  4. B starts on the same profile: version 1.0.1, still signed in, the queued sale untouched (same key
 *     and bytes); on reconnect it uploads exactly once. B finds itself up to date.
 *
 * The host needs `--no-sandbox` for an unpacked/AppImage Electron (see packagedApp.mjs) and runs the
 * AppImage with APPIMAGE_EXTRACT_AND_RUN=1 (no libfuse2). The updater's own relaunch of B carries no
 * arguments, so the journey starts B itself.
 */
const COLA = '6221000000011'
const APPIMAGE_ENV = { APPIMAGE_EXTRACT_AND_RUN: '1' }

async function updateStatus(page) {
  const result = await page.evaluate(async () => await window.posApi.updates.getStatus())
  if (!result.ok) throw new Error(`update status failed: ${JSON.stringify(result)}`)
  return result.data
}

async function until(read, predicate, label, timeout = 180_000) {
  const deadline = Date.now() + timeout
  let value = await read()
  while (!predicate(value)) {
    if (Date.now() > deadline) throw new Error(`${label}: ${JSON.stringify(value)}`)
    await new Promise((resolve) => setTimeout(resolve, 500))
    value = await read()
  }
  return value
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function pendingSale(profileDir) {
  const [row] = queryLocal(
    profileDir,
    `SELECT local_queue_uuid, idempotency_key, state, payload_json FROM sync_queue
      WHERE aggregate_type = 'invoice' ORDER BY rowid DESC LIMIT 1`,
    [],
    PACKAGED_APP_DIR
  )
  return row ?? null
}

/** Processes started from `appImage` (the AppImage runtime sets APPIMAGE for it and its children). */
function processesOf(appImage) {
  const pids = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const environ = readFileSync(`/proc/${entry}/environ`, 'utf8').split('\0')
      if (environ.includes(`APPIMAGE=${appImage}`)) pids.push(Number(entry))
    } catch {
      // Gone, or another user's process.
    }
  }
  return pids
}

/** Ends what the updater relaunched (it has no debugging port) through the app's normal quit. */
async function stopRelaunched(appImage) {
  const pids = processesOf(appImage)
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Already gone.
    }
  }
  await until(
    async () => processesOf(appImage).length,
    (left) => left === 0,
    'the relaunched B did not quit',
    30_000
  )
  return pids.length
}

async function setOnline(page, proxy, on) {
  if (on) await proxy.online()
  else await proxy.offline()
  await page.evaluate(async () => await window.posApi.connectivity.checkNow())
}

export async function run(ctx) {
  const sandbox = await startSandbox({
    runDir: ctx.runDir,
    port: await freePort(),
    flags: { POS_OFFLINE_PHYSICAL_PRESENCE_ENABLED: 'true' }
  })
  const proxy = await startProxy(sandbox.origin)
  const feedDir = join(ctx.runDir, 'feed')
  mkdirSync(feedDir, { recursive: true })
  const feed = await startStaticFeed(feedDir, await freePort())
  ctx.step('isolated backend, proxy and update feed', { api: proxy.origin, feed: feed.url })
  let app = null
  let built = null
  try {
    built = buildUpdateTestAppImages({
      apiOrigin: proxy.origin,
      feedUrl: feed.url,
      versions: ['1.0.0', '1.0.1'],
      outputRoot: join(ctx.runDir, 'builds')
    })
    copyFileSync(built['1.0.1'].appImage, join(feedDir, 'pos-desktop-1.0.1.AppImage'))
    copyFileSync(built['1.0.1'].metadata, join(feedDir, 'latest-linux.yml'))
    const versionB = sha256(built['1.0.1'].appImage)
    ctx.step('A and B built; B published on the isolated feed', {
      a: sha256(built['1.0.0'].appImage).slice(0, 16),
      b: versionB.slice(0, 16)
    })

    const profileDir = join(ctx.runDir, 'profile')
    app = await launchPackagedApp({
      runDir: ctx.runDir,
      profileDir,
      binary: built['1.0.0'].appImage,
      extraEnv: APPIMAGE_ENV
    })
    ctx.session = app
    let page = app.page
    const runtimeA = await page.evaluate(
      async () => (await window.posApi.system.getRuntimeInfo()).data
    )
    ctx.step('1: A running', { version: runtimeA.appVersion })
    if (runtimeA.appVersion !== '1.0.0') throw new Error('1: A is not 1.0.0')

    await activate(ctx, page)
    await signIn(ctx, page)
    await waitForRoute(page, 'pos')
    const device = await deviceUuid(sandbox)
    sandbox.fixture('assign-device', device)
    sandbox.fixture('mode-physical-presence', '')
    await refreshWorkstation(ctx, page)
    await openShift(ctx, page)

    // 1. Background check and download of B.
    await page.evaluate(async () => await window.posApi.updates.checkNow())
    const ready = await until(
      () => updateStatus(page),
      (status) => status.phase === 'ready' || status.phase === 'error',
      '1: B was not downloaded'
    )
    ctx.step('1: B downloaded in the background', {
      phase: ready.phase,
      available: ready.availableVersion,
      errorCode: ready.errorCode,
      feedRequests: feed.requests
    })
    if (ready.phase !== 'ready' || ready.availableVersion !== '1.0.1')
      throw new Error('1: the update is not ready')

    // 2. Offline sale (queued) and a cart line on screen.
    await setOnline(page, proxy, false)
    await scan(ctx, page, COLA)
    await payExactCash(ctx, page)
    await page
      .getByRole('dialog')
      .getByRole('button', { name: new RegExp(await t(page, 'pos.tender.newSale')) })
      .click()
    const queued = await until(
      () => pendingSale(profileDir),
      (row) => row !== null && row.state === 'pending',
      '2: the offline sale was not queued'
    )
    await scan(ctx, page, COLA)

    // 3. Refused with a cart line; accepted once the cart is empty.
    const refused = await page.evaluate(async () => await window.posApi.updates.restartToInstall())
    ctx.step('3: restart while a sale is on screen', refused.data)
    if (refused.data.restarting || !refused.data.blockers.includes('sale_in_progress'))
      throw new Error('3: the restart was not refused while a cart line was on screen')
    await store(page, 'cart', 's.clear()')
    await until(
      () => updateStatus(page),
      (status) => status.blockers.length === 0,
      '3: the empty cart still blocks the restart',
      30_000
    )
    const exited = new Promise((resolve) => app.child.once('exit', resolve))
    const accepted = await page.evaluate(async () => await window.posApi.updates.restartToInstall())
    ctx.step('3: restart once the cart is empty', accepted.data)
    if (!accepted.data.restarting) throw new Error('3: the authorized restart was refused')
    await exited
    await app.close()
    app = null
    const installedB = join(built['1.0.0'].dir, 'pos-desktop-1.0.1.AppImage')
    await until(
      () => existsSync(installedB),
      (present) => present,
      '3: the updater did not install B next to A',
      60_000
    )
    ctx.step('3: B installed by the updater', {
      oldRemoved: !existsSync(built['1.0.0'].appImage),
      sameAsFeed: sha256(installedB) === versionB
    })
    if (sha256(installedB) !== versionB) throw new Error('3: the installed file is not B')
    // The updater starts B itself (no arguments, so no debugging port); B then holds the
    // single-instance lock. Record that it started, then let it quit so the journey can drive B.
    const relaunched = await until(
      async () => processesOf(installedB).length,
      (count) => count > 0,
      '3: the updater did not start B',
      60_000
    ).catch(() => 0)
    ctx.step('3: the updater started B after installing it', {
      processes: relaunched,
      stopped: relaunched > 0 ? await stopRelaunched(installedB) : 0
    })

    // 4. B on the same profile.
    app = await launchPackagedApp({
      runDir: ctx.runDir,
      profileDir,
      binary: installedB,
      extraEnv: APPIMAGE_ENV
    })
    ctx.session = app
    page = app.page
    await waitForRoute(page, 'pos')
    const runtimeB = await page.evaluate(
      async () => (await window.posApi.system.getRuntimeInfo()).data
    )
    const kept = pendingSale(profileDir)
    ctx.step('4: B running on the same profile', {
      version: runtimeB.appVersion,
      sale: kept.state,
      sameKey: kept.idempotency_key === queued.idempotency_key,
      sameBytes: kept.payload_json === queued.payload_json
    })
    await ctx.shot(page, '04-version-b-after-upgrade')
    if (runtimeB.appVersion !== '1.0.1') throw new Error('4: B is not 1.0.1')
    if (
      kept.idempotency_key !== queued.idempotency_key ||
      kept.payload_json !== queued.payload_json
    )
      throw new Error('4: the queued sale changed across the upgrade')
    await setOnline(page, proxy, true)
    const report = await waitForServerInvoices(sandbox, device, 1, 120_000)
    const statusB = await until(
      () => updateStatus(page),
      (status) => status.phase === 'idle' || status.phase === 'error',
      '4: B never finished its first check',
      120_000
    )
    ctx.step('4: uploaded once after the upgrade; B is up to date', {
      serverInvoices: report.device_invoice_count,
      update: statusB.phase
    })
    if (report.device_invoice_count !== 1)
      throw new Error('4: the sale did not upload exactly once')
  } finally {
    await app?.close()
    // Nothing started from either AppImage may outlive the journey (the AppImage runtime's children).
    for (const version of Object.values(built ?? {})) {
      await stopRelaunched(version.appImage).catch(() => undefined)
      await stopRelaunched(join(version.dir, 'pos-desktop-1.0.1.AppImage')).catch(() => undefined)
    }
    await feed.stop()
    await proxy.stop().catch(() => undefined)
    await sandbox.stop()
  }
}
