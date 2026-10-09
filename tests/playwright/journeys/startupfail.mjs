import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { t } from '../support/app.mjs'
import {
  launchAgain,
  payExactCash,
  scan,
  setupPhysicalPresenceTill,
  waitForRoute,
  waitForServerInvoices,
  openSandboxAndApp
} from '../support/journey.mjs'
import { localDatabasePath, queryLocal } from '../support/localDb.mjs'
import { buildPackagedApp, PACKAGED_APP_DIR } from '../support/packagedApp.mjs'
import { DESKTOP_ROOT } from '../support/paths.mjs'

const require = createRequire(import.meta.url)

/**
 * V1 Windows readiness — the startup-error screen, through a REAL blocked database upgrade.
 *
 *  1. A real till sells offline: one sale is left pending upload. The app is closed normally.
 *  2. Controlled failure (app closed, isolated profile only): one derived row is damaged the way the
 *     upgrade suite's "legacy orphan proof row" is (an `invoice_disposition_proof_results` row whose
 *     parent does not exist, written with foreign keys off) and migration 0034 is marked not applied,
 *     so the next start runs 0034 and its copy fails on the orphan (FOREIGN KEY constraint failed).
 *  3. The app starts on that profile on a private Xephyr display, twice: the harness build on the
 *     profile itself, then the PACKAGED till on a copy of the database. Each time no POS window opens;
 *     the only window is the native error box (captured as a screenshot) with the recovery steps, the
 *     data folder, the version (the packaged till's own) and the reason. Dismissing it quits the app.
 *  4. Each failed start leaves its database untouched: every file byte-identical, migration 0034 still
 *     unapplied, the pending sale's key and bytes unchanged, integrity ok.
 *  5. Support's repair (on the data, never deleting the database): the orphan row is removed. The till
 *     starts, applies 0034, and on reconnect uploads the pending sale exactly once.
 *
 * The failing starts are spawned directly (not under Playwright, whose launch waits for a window that
 * never comes); like packagedApp.mjs they pass `--no-sandbox`, which this host requires for an Electron
 * started outside Playwright. The app's own webPreferences are unchanged.
 */
const COLA = '6221000000011'
const ORPHAN_INVOICE = 'ffffffff-ffff-4fff-8fff-ffffffffffff'

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Every file of the database (the .sqlite and any -wal / -shm) with its hash. */
function databaseFiles(profileDir, appDir = 'Electron') {
  const dir = join(profileDir, appDir)
  return Object.fromEntries(
    readdirSync(dir)
      .filter((name) => name.startsWith('pos-desktop.sqlite'))
      .sort()
      .map((name) => [name, sha256(join(dir, name))])
  )
}

function python(script, args) {
  const result = spawnSync('python3', ['-c', script, ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`python failed: ${result.stderr}`)
  return result.stdout.trim()
}

/** The test's controlled damage, on a CLOSED app's isolated profile only (localDatabasePath refuses a real one). */
function damageForUpgrade(profileDir) {
  return python(
    `
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.execute('PRAGMA foreign_keys = OFF')
con.execute("""INSERT INTO invoice_disposition_proof_results
  (invoice_local_uuid, line_index, proof_index, allocation_uuid, rights_generation, consumption_sequence,
   local_consumption_uuid, quantity_milli, outcome, server_consumption_uuid, override_reason, created_at)
  VALUES (?, 0, 0, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, 1, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 5000,
          'overridden', NULL, 'allocation_sequence_gap', '2026-10-09T00:00:00.000Z')""", (sys.argv[2],))
con.execute('DELETE FROM schema_migrations WHERE version = 34')
con.commit()
print(con.execute('PRAGMA foreign_key_check').fetchall())
con.close()
`,
    [localDatabasePath(profileDir), ORPHAN_INVOICE]
  )
}

/** Support's repair (docs/support/blocked-migration-recovery.md §3): remove just the damaged row. */
function repairOrphan(profileDir) {
  return python(
    `
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
cur = con.execute('DELETE FROM invoice_disposition_proof_results WHERE invoice_local_uuid = ?', (sys.argv[2],))
con.commit()
print(cur.rowcount, con.execute('PRAGMA integrity_check').fetchone()[0], len(con.execute('PRAGMA foreign_key_check').fetchall()))
con.close()
`,
    [localDatabasePath(profileDir), ORPHAN_INVOICE]
  )
}

function migrations(profileDir, appDir = 'Electron') {
  return queryLocal(
    profileDir,
    'SELECT MAX(version) AS max, COUNT(*) AS n FROM schema_migrations',
    [],
    appDir
  )[0]
}

function pendingSale(profileDir, appDir = 'Electron') {
  return queryLocal(
    profileDir,
    `SELECT local_queue_uuid, idempotency_key, state, payload_json FROM sync_queue
      WHERE aggregate_type = 'invoice' ORDER BY rowid DESC LIMIT 1`,
    [],
    appDir
  )[0]
}

function databaseState(profileDir, appDir = 'Electron') {
  return {
    files: databaseFiles(profileDir, appDir),
    migrations: migrations(profileDir, appDir),
    sale: pendingSale(profileDir, appDir),
    integrity: queryLocal(profileDir, 'PRAGMA integrity_check', [], appDir)[0].integrity_check
  }
}

async function until(read, predicate, label, timeout) {
  const deadline = Date.now() + timeout
  let value = read()
  while (!predicate(value)) {
    if (Date.now() > deadline) throw new Error(`${label}: ${JSON.stringify(value)}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
    value = read()
  }
  return value
}

function x(display, command, args) {
  return spawnSync(command, args, { encoding: 'utf8', env: { ...process.env, DISPLAY: display } })
}

/**
 * Starts `command args` on a private Xephyr display against `profileDir`, expects the error box as
 * its only window, screenshots it, dismisses it, and waits for the process to quit.
 */
async function failingStart(ctx, { label, command, args, profileDir, shotName, processes }) {
  const free = [90, 91, 92, 93, 94, 95, 96, 98, 99].find((n) => !existsSync(`/tmp/.X11-unix/X${n}`))
  if (free === undefined) throw new Error(`${label}: no free X display for Xephyr`)
  const display = `:${free}`
  const xephyr = spawn(
    'Xephyr',
    [display, '-screen', '1280x800x24', '-ac', '-br', '-nolisten', 'tcp'],
    {
      stdio: 'ignore'
    }
  )
  processes.push(xephyr)
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const logs = []
  const app = spawn(command, [...args, '--ozone-platform=x11', '--no-sandbox'], {
    cwd: DESKTOP_ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DISPLAY: display,
      XAUTHORITY: '',
      XDG_CONFIG_HOME: profileDir,
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
      LANG: 'en_US.UTF-8',
      CUPS_SERVER: join(profileDir, 'no-cups-server.sock')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  processes.push(app)
  app.stdout.on('data', (chunk) => logs.push(String(chunk)))
  app.stderr.on('data', (chunk) => logs.push(String(chunk)))
  const exited = new Promise((resolve) => app.once('exit', (code) => resolve(code)))
  try {
    // The display is private to this start: any visible window on it belongs to this app.
    const found = await until(
      () => x(display, 'xdotool', ['search', '--onlyvisible', '--name', '.']).stdout.trim(),
      (ids) => ids.length > 0 || app.exitCode !== null,
      `${label}: no window appeared`,
      60_000
    )
    if (!found) throw new Error(`${label}: the app exited (${app.exitCode}) without an error box`)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const ids = found.split('\n')
    const windows = ids.map((id) => x(display, 'xdotool', ['getwindowname', id]).stdout.trim())
    const grab = spawnSync(
      'ffmpeg',
      [
        '-loglevel',
        'error',
        '-y',
        '-f',
        'x11grab',
        '-video_size',
        '1280x800',
        '-i',
        display
      ].concat(['-frames:v', '1', join(ctx.evidenceDir, shotName)]),
      { encoding: 'utf8' }
    )
    const logged = logs.join('')
    const facts = {
      windows,
      screenshot: grab.status === 0 ? shotName : grab.stderr,
      stillRunning: app.exitCode === null,
      blockedUpgradeLogged:
        /Application initialization failed.*FOREIGN KEY constraint failed/s.test(logged)
    }
    // Only the error box: the POS window never opens on a database that cannot be upgraded. Its text
    // (title, steps, folder, version, reason) is read on the screenshot.
    if (ids.length !== 1) throw new Error(`${label}: expected only the error box, saw ${windows}`)
    if (!facts.blockedUpgradeLogged) throw new Error(`${label}: not the blocked 0034 upgrade`)
    x(display, 'xdotool', ['key', '--window', ids[0], 'Return'])
    facts.exitCode = await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 20_000))
    ])
    if (facts.exitCode === 'timeout') throw new Error(`${label}: the app did not quit`)
    return facts
  } finally {
    ctx.facts[`${label}Log`] = logs.join('').split('\n').slice(-30)
    if (app.exitCode === null) app.kill('SIGKILL')
    xephyr.kill('SIGTERM')
  }
}

export async function run(ctx) {
  const session = await openSandboxAndApp(ctx, {
    flags: { POS_OFFLINE_PHYSICAL_PRESENCE_ENABLED: 'true' },
    proxy: true
  })
  const { sandbox, proxy, profileDir } = session
  const processes = []
  try {
    // 1. A real pending sale.
    const device = await setupPhysicalPresenceTill(ctx, session)
    await proxy.offline()
    await session.page.evaluate(async () => await window.posApi.connectivity.checkNow())
    await scan(ctx, session.page, COLA)
    await payExactCash(ctx, session.page)
    await session.page
      .getByRole('dialog')
      .getByRole('button', { name: new RegExp(await t(session.page, 'pos.tender.newSale')) })
      .click()
    const sale = await until(
      () => pendingSale(profileDir),
      (row) => row?.state === 'pending',
      '1: the offline sale was not queued',
      30_000
    )
    await session.app.close()
    ctx.step('1: offline sale pending; app closed', {
      sale: sale.state,
      migrations: migrations(profileDir)
    })

    // 2. Controlled failure.
    const fkCheck = damageForUpgrade(profileDir)
    const before = databaseState(profileDir)
    ctx.step('2: one derived row damaged, 0034 marked not applied', { fkCheck, before })

    // 3a / 4a. The harness build on the profile itself.
    const harness = await failingStart(ctx, {
      label: '3a-harness',
      command: require('electron'),
      args: [join(session.outDir, 'main', 'index.js'), '--password-store=gnome-libsecret'],
      profileDir,
      shotName: '03a-startup-error-box-harness.png',
      processes
    })
    const afterHarness = databaseState(profileDir)
    ctx.step('3a: the harness build shows the error box and leaves the database untouched', {
      ...harness,
      sameDatabase: JSON.stringify(afterHarness) === JSON.stringify(before),
      afterHarness
    })
    if (JSON.stringify(afterHarness) !== JSON.stringify(before))
      throw new Error('4a: the failed start changed the database')

    // 3b / 4b. The packaged till on a copy of the same database (its data folder is `pos-desktop`).
    const packagedProfile = join(ctx.runDir, 'packaged-profile')
    mkdirSync(join(packagedProfile, PACKAGED_APP_DIR), { recursive: true })
    for (const name of Object.keys(before.files)) {
      copyFileSync(
        join(profileDir, 'Electron', name),
        join(packagedProfile, PACKAGED_APP_DIR, name)
      )
    }
    const packagedBefore = databaseState(packagedProfile, PACKAGED_APP_DIR)
    const binary = buildPackagedApp(proxy.origin, { allowLoopback: true })
    const packaged = await failingStart(ctx, {
      label: '3b-packaged',
      command: binary,
      args: ['--password-store=gnome-libsecret'],
      profileDir: packagedProfile,
      shotName: '03b-startup-error-box-packaged.png',
      processes
    })
    const packagedAfter = databaseState(packagedProfile, PACKAGED_APP_DIR)
    ctx.step('3b: the packaged till shows the error box and leaves the database untouched', {
      ...packaged,
      sameDatabase: JSON.stringify(packagedAfter) === JSON.stringify(packagedBefore),
      packagedAfter
    })
    if (JSON.stringify(packagedAfter) !== JSON.stringify(packagedBefore))
      throw new Error('4b: the failed packaged start changed the database')

    // 5. Support's repair, then a normal start: 0034 applied, the sale uploads once.
    const repaired = repairOrphan(profileDir)
    ctx.step('5: support removed the damaged row (database kept)', {
      removedIntegrityFkRows: repaired
    })
    await launchAgain(ctx, session)
    await waitForRoute(session.page, 'pos')
    const upgraded = migrations(profileDir)
    const kept = pendingSale(profileDir)
    if (kept.idempotency_key !== sale.idempotency_key || kept.payload_json !== sale.payload_json)
      throw new Error('5: the pending sale changed across the repair')
    await proxy.online()
    await session.page.evaluate(async () => await window.posApi.connectivity.checkNow())
    const report = await waitForServerInvoices(sandbox, device, 1, 90_000)
    ctx.step('5: the repaired till starts, upgrades and uploads the sale exactly once', {
      migrations: upgraded,
      serverInvoices: report.device_invoice_count
    })
    await ctx.shot(session.page, '05-after-repair')
    if (upgraded.max !== 34) throw new Error('5: migration 0034 was not applied after the repair')
    if (report.device_invoice_count !== 1)
      throw new Error('5: the sale did not upload exactly once')
  } finally {
    for (const child of processes) if (child.exitCode === null) child.kill('SIGKILL')
    await session.app.close().catch(() => undefined)
    await proxy.stop().catch(() => undefined)
    await sandbox.stop()
  }
}
