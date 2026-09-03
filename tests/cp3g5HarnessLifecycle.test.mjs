/* eslint-disable @typescript-eslint/explicit-function-return-type */
/**
 * CP-3G-6 live-harness process-lifecycle regressions.
 *
 * The defect these cover: `php artisan serve` is a supervisor whose listening socket is held by a
 * `php -S` grandchild. Signalling only the artisan child left that grandchild alive, holding the
 * port with an already-deleted database, so a later run connected to a dead server.
 *
 * Every assertion below is made on **pids and process groups this harness recorded**, or on a real
 * socket bind. None is a `pgrep` on a command name.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  isProcessAlive,
  listeningSocketInodes,
  loopbackPortIsFree,
  processGroupMembers,
  processOwnsSocketInode,
  parseChildDiagnostics,
  readProcessStat,
  reserveLoopbackPort,
  startOwnedProcessGroup,
  terminateOwnedProcessGroup,
  waitUntil
} from '../scripts/cp3g5LiveUpload.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(HERE, '..')
const WRAPPER = join(PROJECT_ROOT, 'scripts/cp3g5LiveUpload.mjs')
const SEEDER = join(PROJECT_ROOT, 'tests/electron/support/cp3g5/seedLiveBackend.php')
const BACKEND_ROOT = resolve(PROJECT_ROOT, '..', 'pos-backend')
const TEMP_ROOT = tmpdir()
const SANDBOX_PREFIX = 'pos-desktop-cp3g5-'
const SECRET_SHAPES = /(?:plainTextToken|Bearer|Stack trace|#0|\b[0-9a-f]{64}\b)/i

function cleanEnvironment() {
  const environment = { ...process.env }

  for (const name of [
    'APP_CONFIG_CACHE',
    'APP_ENV',
    'CP3G5_DIAGNOSTICS',
    'CP3G5_FAULT',
    'CP3G5_LIVE_HARNESS',
    'CP3G5_SEED_ONLY',
    'CP3G5_RESPONSE_FILE',
    'CP3G5_RUN_NONCE',
    'CP3G5_TEMP_ROOT',
    'DB_CONNECTION',
    'DB_DATABASE',
    'DB_URL'
  ]) {
    delete environment[name]
  }

  return environment
}

/** Every live descendant of `root`, discovered through parent links — never through a name. */
function descendantsOf(root) {
  const stats = readdirSync('/proc')
    .filter((entry) => /^\d+$/.test(entry))
    .map((entry) => readProcessStat(Number(entry)))
    .filter((stat) => stat !== null)
  const found = new Map()
  let frontier = [root]

  while (frontier.length > 0) {
    const next = []

    for (const stat of stats) {
      if (frontier.includes(stat.ppid) && !found.has(stat.pid)) {
        found.set(stat.pid, stat)
        next.push(stat.pid)
      }
    }

    frontier = next
  }

  return [...found.values()]
}

function existingSandboxes() {
  return new Set(readdirSync(TEMP_ROOT).filter((name) => name.startsWith(SANDBOX_PREFIX)))
}

/**
 * Runs the wrapper in its own process group, watching the real process tree while it runs.
 *
 * The watcher records the server's process-group identity and members from parent links, and the
 * moments at which the group emptied and the sandbox directory disappeared, so cleanup **ordering**
 * can be asserted rather than assumed.
 */
async function runWrapper(overrides = {}, { timeoutMs = 420_000 } = {}) {
  const before = existingSandboxes()
  const child = spawn(process.execPath, [WRAPPER], {
    cwd: PROJECT_ROOT,
    env: { ...cleanEnvironment(), CP3G5_BACKEND_ROOT: BACKEND_ROOT, ...overrides },
    encoding: 'utf8',
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  const observed = {
    serverGroupId: null,
    serverPids: new Set(),
    sandbox: null,
    sampledServerHoldingSandbox: false,
    sandboxRemovedWhileServerAlive: false
  }
  const wrapperGroup = readProcessStat(child.pid)?.pgid ?? child.pid
  let running = true

  const watcher = (async () => {
    while (running) {
      for (const stat of descendantsOf(child.pid)) {
        // The server tree is the descendant group this harness detached away from its own.
        if (stat.pgid !== wrapperGroup && stat.pgid !== child.pid) {
          observed.serverGroupId ??= stat.pgid
        }

        if (observed.serverGroupId !== null && stat.pgid === observed.serverGroupId) {
          observed.serverPids.add(stat.pid)
        }
      }

      if (observed.sandbox === null) {
        const appeared = readdirSync(TEMP_ROOT).filter(
          (name) => name.startsWith(SANDBOX_PREFIX) && !before.has(name)
        )

        if (appeared.length > 0) observed.sandbox = join(TEMP_ROOT, appeared[0])
      }

      if (observed.serverGroupId !== null && observed.sandbox !== null) {
        const serverAlive = processGroupMembers(observed.serverGroupId).length > 0
        const sandboxPresent = existsSync(observed.sandbox)

        if (serverAlive && sandboxPresent) {
          // Proof the watcher actually sampled the window the ordering rule is about, rather than
          // passing because it happened to look only before and after it.
          observed.sampledServerHoldingSandbox = true
        }

        if (serverAlive && !sandboxPresent) {
          // The rule this run must never break: the disposable database is not removed while a
          // process that could still have it open is alive.
          observed.sandboxRemovedWhileServerAlive = true
        }
      }

      await new Promise((done) => setTimeout(done, 20))
    }
  })()

  // The losing timer must be cleared: an uncleared one keeps this file's event loop alive for its
  // full budget after the last case, so the run appears to hang long after its final assertion.
  let timeoutHandle
  const finished = await Promise.race([
    new Promise((done) => child.once('close', (code) => done({ code }))),
    new Promise((done) => {
      timeoutHandle = setTimeout(() => done({ code: 'timeout' }), timeoutMs)
    })
  ])

  clearTimeout(timeoutHandle)
  running = false
  await watcher

  const port = /ready on http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout)?.[1]

  return {
    status: finished.code,
    stdout,
    stderr,
    observed,
    port: port ? Number(port) : null,
    sandboxesAfter: readdirSync(TEMP_ROOT).filter(
      (name) => name.startsWith(SANDBOX_PREFIX) && !before.has(name)
    )
  }
}

/** Asserts that every process this run created is gone, by recorded pid and by group. */
function assertNothingSurvives(result) {
  assert.notEqual(result.observed.serverGroupId, null, 'no server process group was observed')
  assert.ok(result.observed.serverPids.size >= 2, 'expected at least artisan and its php -S child')

  for (const pid of result.observed.serverPids) {
    assert.equal(isProcessAlive(pid), false, `recorded server pid ${pid} survived the run`)
  }

  assert.deepEqual(processGroupMembers(result.observed.serverGroupId), [])
  assert.deepEqual(result.sandboxesAfter, [])
}

/**
 * The seed-only variant: no server is ever started, so there is no group to observe. Everything
 * else a full run must prove still has to hold — no surviving process this run created, and no
 * sandbox left behind.
 */
function assertNothingSurvivesSeedOnly(result) {
  assert.equal(result.observed.serverGroupId, null, 'seed-only mode must never start a server')

  for (const pid of result.observed.serverPids) {
    assert.equal(isProcessAlive(pid), false, `recorded pid ${pid} survived the run`)
  }

  assert.deepEqual(result.sandboxesAfter, [])
}

// ---------------------------------------------------------------------------------------------
// The process tree, and the defect itself
// ---------------------------------------------------------------------------------------------

test('artisan serve really does hold its socket in a php -S grandchild', async () => {
  const port = await reserveLoopbackPort()
  const owned = startOwnedProcessGroup(
    'php',
    ['artisan', 'serve', '--host=127.0.0.1', `--port=${port}`],
    {
      cwd: BACKEND_ROOT,
      env: { ...cleanEnvironment(), APP_ENV: 'testing', DB_CONNECTION: 'sqlite' },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  owned.child.stdout.on('data', () => {})
  owned.child.stderr.on('data', () => {})

  try {
    await waitUntil(async () => !(await loopbackPortIsFree(port)), 30_000)

    const members = owned.members()
    const inodes = listeningSocketInodes(port)
    const listener = members.filter((pid) => processOwnsSocketInode(pid, inodes))

    // Two processes, one group, and the socket is held by the *grandchild* — not by the pid the
    // wrapper used to signal.
    assert.ok(members.length >= 2, 'artisan serve should run at least two processes')
    assert.equal(listener.length, 1)
    assert.notEqual(listener[0], owned.pid, 'the listener must be the grandchild, not artisan')
    assert.equal(readProcessStat(listener[0]).ppid, owned.pid)
    assert.equal(readProcessStat(owned.pid).pgid, owned.pid, 'artisan leads its own group')
  } finally {
    const termination = await terminateOwnedProcessGroup(owned)
    assert.equal(termination.terminated, true)
  }

  assert.equal(await loopbackPortIsFree(port), true)
})

test('a graceful group terminates on SIGTERM without escalation', async () => {
  const owned = startOwnedProcessGroup(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore'
  })
  const termination = await terminateOwnedProcessGroup(owned, { gracefulMs: 5_000 })

  assert.equal(termination.terminated, true)
  assert.equal(termination.escalated, false)
  assert.deepEqual(termination.survivors, [])
  assert.equal(isProcessAlive(owned.pid), false)
})

test('a SIGTERM-resistant owned group is escalated to SIGKILL within a bounded wait', async () => {
  const owned = startOwnedProcessGroup(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    { stdio: 'ignore' }
  )

  // Give the child time to install its handler, so the escalation is genuinely required.
  await new Promise((done) => setTimeout(done, 500))

  const started = Date.now()
  const termination = await terminateOwnedProcessGroup(owned, {
    gracefulMs: 750,
    forcedMs: 5_000
  })

  assert.equal(termination.escalated, true, 'SIGTERM was ignored, so SIGKILL must follow')
  assert.equal(termination.terminated, true)
  assert.deepEqual(termination.survivors, [])
  assert.ok(Date.now() - started < 10_000, 'escalation must be bounded')
})

test('a group that outlives its leader is still terminated whole', async () => {
  // A leader that exits immediately after spawning a child which keeps running: exactly the
  // artisan/php -S shape, reduced to something with no PHP in it.
  const owned = startOwnedProcessGroup(
    process.execPath,
    [
      '-e',
      "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); setTimeout(()=>process.exit(0),200)"
    ],
    { stdio: 'ignore' }
  )

  await waitUntil(async () => !isProcessAlive(owned.pid), 10_000)
  assert.ok(processGroupMembers(owned.processGroupId).length > 0, 'the orphan should still run')

  const termination = await terminateOwnedProcessGroup(owned)

  assert.equal(termination.terminated, true)
  assert.deepEqual(processGroupMembers(owned.processGroupId), [])
})

test('the harness refuses to signal its own process group', async () => {
  const ownGroup = readProcessStat(process.pid).pgid

  await assert.rejects(
    () => terminateOwnedProcessGroup({ processGroupId: ownGroup, command: 'forged' }),
    /does not own/
  )
  await assert.rejects(
    () => terminateOwnedProcessGroup({ processGroupId: 1, command: 'forged' }),
    /does not own/
  )
  await assert.rejects(
    () => terminateOwnedProcessGroup({ processGroupId: process.pid, command: 'forged' }),
    /does not own/
  )
})

test('the harness contains no broad process matching anywhere', () => {
  for (const file of [WRAPPER, SEEDER, join(PROJECT_ROOT, 'tests/cp3g5HarnessSafety.test.mjs')]) {
    const source = readFileSync(file, 'utf8')

    assert.doesNotMatch(source, /\b(?:pkill|killall|fuser|kill\s+-9\s+\$)/)
  }

  const wrapper = readFileSync(WRAPPER, 'utf8')

  // The only kill targets are a recorded pid and a recorded process group.
  const killTargets = [...wrapper.matchAll(/process\.kill\(([^,]+),/g)].map((match) =>
    match[1].trim()
  )
  assert.deepEqual([...new Set(killTargets)].sort(), ['-processGroupId', 'child.pid'])
  // Socket ownership is only ever read, never turned into a kill target.
  assert.doesNotMatch(wrapper, /process\.kill\([^)]*(?:inode|listener|port)/i)
  assert.equal(wrapper.includes('8399'), false, 'the fixed port must be gone')
})

// ---------------------------------------------------------------------------------------------
// The wrapper, end to end
// ---------------------------------------------------------------------------------------------

test('a failing run after the server is ready leaves no child or grandchild', async () => {
  const result = await runWrapper({ CP3G5_FAULT: 'fail-after-ready', CP3G5_PAYLOADS: '1' })

  assert.notEqual(result.status, 0)
  assertNothingSurvives(result)
  assert.match(result.stdout, /temporary directory removed and verified absent/)
  assert.equal(await loopbackPortIsFree(result.port), true)
})

test('a Laravel startup failure leaves no owned process and releases nothing it did not take', async () => {
  const result = await runWrapper({
    CP3G5_FAULT: 'server-startup-failure',
    CP3G5_PAYLOADS: '1'
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /never became ready/)
  assert.deepEqual(result.sandboxesAfter, [])

  if (result.observed.serverGroupId !== null) {
    assert.deepEqual(processGroupMembers(result.observed.serverGroupId), [])

    for (const pid of result.observed.serverPids) {
      assert.equal(isProcessAlive(pid), false)
    }
  }
})

test('an Electron suite failure still terminates the whole Laravel tree', async () => {
  const result = await runWrapper({ CP3G5_FAULT: 'suite-failure', CP3G5_PAYLOADS: '1' })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Electron SQLite suite failed with no child output forwarded/)
  assertNothingSurvives(result)
  assert.equal(await loopbackPortIsFree(result.port), true)
})

test('a hung suite is timed out and its whole process group is cleaned', async () => {
  const result = await runWrapper({
    CP3G5_FAULT: 'suite-hang',
    CP3G5_PAYLOADS: '1',
    CP3G5_SUITE_TIMEOUT_MS: '3000'
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /exceeded its time budget/)
  assertNothingSurvives(result)
  assert.equal(await loopbackPortIsFree(result.port), true)
})

test('the temporary directory is removed only after the server group is gone', async () => {
  const result = await runWrapper({ CP3G5_FAULT: 'fail-after-ready', CP3G5_PAYLOADS: '1' })

  assert.notEqual(result.status, 0)
  assert.equal(
    result.observed.sampledServerHoldingSandbox,
    true,
    'the watcher never sampled the window in which the server and its sandbox coexist'
  )
  assert.equal(
    result.observed.sandboxRemovedWhileServerAlive,
    false,
    'the disposable database must never be deleted while an owned server can still hold it open'
  )
  assertNothingSurvives(result)
})

test('two consecutive runs need no manual cleanup and never share a port', async () => {
  const first = await runWrapper({ CP3G5_FAULT: 'fail-after-ready', CP3G5_PAYLOADS: '1' })
  const second = await runWrapper({ CP3G5_FAULT: 'fail-after-ready', CP3G5_PAYLOADS: '1' })

  assertNothingSurvives(first)
  assertNothingSurvives(second)
  assert.notEqual(first.port, second.port, 'each run must select its own loopback port')
  assert.notEqual(first.observed.serverGroupId, second.observed.serverGroupId)
  assert.equal(await loopbackPortIsFree(first.port), true)
  assert.equal(await loopbackPortIsFree(second.port), true)
})

test('an unrelated PHP server on another port is never touched', async () => {
  const port = await reserveLoopbackPort()
  const bystander = startOwnedProcessGroup('php', ['-S', `127.0.0.1:${port}`, '-t', PROJECT_ROOT], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  bystander.child.stdout.on('data', () => {})
  bystander.child.stderr.on('data', () => {})

  try {
    await waitUntil(async () => !(await loopbackPortIsFree(port)), 20_000)

    const inodes = listeningSocketInodes(port)
    assert.ok(processOwnsSocketInode(bystander.pid, inodes), 'the bystander must hold the socket')

    const result = await runWrapper({ CP3G5_FAULT: 'fail-after-ready', CP3G5_PAYLOADS: '1' })

    assert.notEqual(result.status, 0)
    assertNothingSurvives(result)

    // Untouched: still alive, still holding the same socket, and its port never became free.
    assert.equal(isProcessAlive(bystander.pid), true)
    assert.equal(await loopbackPortIsFree(port), false)
    assert.ok(processOwnsSocketInode(bystander.pid, listeningSocketInodes(port)))
  } finally {
    const termination = await terminateOwnedProcessGroup(bystander)
    assert.equal(termination.terminated, true)
  }
})

test('a port already taken is reported, never reclaimed', async () => {
  const port = await reserveLoopbackPort()
  const holder = createServer()

  await new Promise((done) => holder.listen(port, '127.0.0.1', done))

  try {
    // The harness's own free-port predicate is what gates the start, and it refuses.
    assert.equal(await loopbackPortIsFree(port), false)

    const inodes = listeningSocketInodes(port)
    assert.ok(inodes.length > 0)
    assert.ok(processOwnsSocketInode(process.pid, inodes), 'this test process holds the socket')

    // Nothing in the harness maps that ownership to a signal.
    assert.equal(isProcessAlive(process.pid), true)
  } finally {
    await new Promise((done) => holder.close(done))
  }

  assert.equal(await loopbackPortIsFree(port), true)
})

test('wrapper output stays free of tokens and stack traces on every failure path', async () => {
  for (const fault of ['fail-after-ready', 'suite-failure', 'server-startup-failure']) {
    const result = await runWrapper({ CP3G5_FAULT: fault, CP3G5_PAYLOADS: '1' })

    assert.notEqual(result.status, 0)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, SECRET_SHAPES)
  }
})

test('the exact unauthorized seeder invocation is still rejected before Laravel loads', () => {
  const result = spawnSync('php', [SEEDER, BACKEND_ROOT, '12'], {
    cwd: PROJECT_ROOT,
    env: cleanEnvironment(),
    encoding: 'utf8'
  })

  assert.notEqual(result.status, 0)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'CP-3G-5 seeder rejected: authorization marker missing\n')
})

test('packaging still excludes every harness asset', () => {
  const config = readFileSync(join(PROJECT_ROOT, 'electron-builder.yml'), 'utf8')

  for (const exclusion of [
    '!scripts/cp3g5LiveUpload.mjs',
    '!tests/electron/support/cp3g5/**',
    '!**/pos-desktop-cp3g5-*',
    '!**/cp3g5-backend.sqlite',
    '!**/cp3g5-fixture.json'
  ]) {
    assert.ok(config.includes(exclusion), `electron-builder configuration lacks ${exclusion}`)
  }
})

test('a full successful run leaves no child, no grandchild and no sandbox', async () => {
  const result = await runWrapper({ CP3G5_PAYLOADS: '32' })

  assert.equal(result.status, 0, 'the live gate must pass end to end')
  assert.match(result.stdout, /Electron SQLite live suite passed/)
  assert.match(result.stdout, /temporary directory removed and verified absent/)
  assertNothingSurvives(result)
  assert.equal(await loopbackPortIsFree(result.port), true)
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, SECRET_SHAPES)
})

// -----------------------------------------------------------------------------------------------
// CP-3G-7 F2 — fixture-seeding determinism.
//
// The proven root cause: the seeder pinned `$soldAt` to the shift's second-precision `opened_at`,
// written once before the minting loop, while each minted product's catalog-revision validity
// began at that product's own second-precision `updated_at`.
// `SellableProductResolver::resolveCurrent()` throws `SellableCatalogUnavailable` when
// `$asOf->lt($validFrom)`, so seeding only survived while the whole loop stayed inside one
// wall-clock second. Before the fix a 100-payload seed failed 9 times out of 10; after it, 10/10.
// -----------------------------------------------------------------------------------------------

test('seeding survives a minting loop that spans several wall-clock seconds', async () => {
  // 100 is the seeder's maximum and guarantees the loop crosses at least one second boundary on
  // any machine that could run this suite, which is precisely the condition that used to fail.
  const result = await runWrapper({ CP3G5_SEED_ONLY: '1', CP3G5_PAYLOADS: '100' })

  assert.equal(result.status, 0, 'a multi-second minting loop must still seed successfully')
  assert.match(result.stdout, /minted 100 upload fixtures/)
  assert.doesNotMatch(result.stderr, /sellable-resolve/)
  assert.doesNotMatch(result.stderr, /fixture-creation-failed/)
  assertNothingSurvivesSeedOnly(result)
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, SECRET_SHAPES)
})

test('seed-only mode still performs the complete cleanup and leaks nothing', async () => {
  const result = await runWrapper({ CP3G5_SEED_ONLY: '1', CP3G5_PAYLOADS: '21' })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /seed-only mode: fixture minted, skipping server and suite/)
  assert.match(result.stdout, /temporary directory removed and verified absent/)
  // Skipping the server must not skip a single cleanup step.
  assertNothingSurvivesSeedOnly(result)
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, SECRET_SHAPES)
})

test('every run reports a distinct opaque identity, and never its sandbox path or nonce', async () => {
  const first = await runWrapper({ CP3G5_SEED_ONLY: '1', CP3G5_PAYLOADS: '2' })
  const second = await runWrapper({ CP3G5_SEED_ONLY: '1', CP3G5_PAYLOADS: '2' })

  const identity = (result) => /run identity ([0-9a-f]{12})/.exec(result.stdout)?.[1] ?? null

  assert.notEqual(identity(first), null)
  assert.notEqual(identity(second), null)
  assert.notEqual(identity(first), identity(second), 'two runs must never share an identity')

  for (const result of [first, second]) {
    const output = `${result.stdout}${result.stderr}`

    assert.doesNotMatch(output, SECRET_SHAPES)
    // The identity is a digest, never the directory it identifies.
    assert.doesNotMatch(output, new RegExp(`${SANDBOX_PREFIX}[A-Za-z0-9]+`))
  }
})

test('the diagnostic channel accepts only whitelisted, shape-checked fields', () => {
  // Everything a leak would look like, offered directly to the parser.
  const hostile = [
    'CP3G5-DIAG {"phase":"seed","token":"1|abcdefghijklmnopqrstuvwxyz0123456789ABCD"}',
    'CP3G5-DIAG {"phase":"seed","code":"Bearer secret-value"}',
    'CP3G5-DIAG {"operation":"seed","identifier":"insert into x values (?, ?)"}',
    'CP3G5-DIAG {"exception":"a b c"}',
    'CP3G5-DIAG {"sqlstate":"' + 'x'.repeat(500) + '"}',
    'CP3G5-DIAG not-json',
    'CP3G5-DIAG [1,2,3]',
    'PDOException: SQLSTATE[HY000] near "select": syntax error',
    '#0 /var/www/html/thinis-pos/pos-backend/vendor/autoload.php(1)'
  ].join('\n')

  const parsed = parseChildDiagnostics(hostile)

  // Each hostile line either loses its unsafe field and keeps its safe one, or is dropped whole.
  // Nothing hostile survives in any form.
  assert.deepEqual(parsed, [{ phase: 'seed' }, { phase: 'seed' }, { operation: 'seed' }])

  for (const record of parsed) {
    for (const [key, value] of Object.entries(record)) {
      assert.ok(
        ['phase', 'operation', 'code', 'exception', 'sqlstate', 'identifier', 'driver_code', 'transaction_level', 'iteration'].includes(key),
        `unexpected diagnostic key ${key}`
      )
      assert.doesNotMatch(String(value), SECRET_SHAPES)
    }
  }

  assert.deepEqual(parseChildDiagnostics(undefined), [])
  assert.deepEqual(parseChildDiagnostics(''), [])
})

test('a genuine seeder diagnostic survives the parser intact', () => {
  const parsed = parseChildDiagnostics(
    'noise before\n' +
      'CP3G5-DIAG {"phase":"seed","operation":"sellable-resolve","code":"fixture-creation-failed",' +
      '"exception":"App\\\\Modules\\\\Catalog\\\\Exceptions\\\\SellableCatalogUnavailable",' +
      '"sqlstate":"23000","driver_code":19,"identifier":"products.sku","iteration":14,"transaction_level":1}\n' +
      'noise after'
  )

  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].phase, 'seed')
  assert.equal(parsed[0].operation, 'sellable-resolve')
  assert.equal(parsed[0].code, 'fixture-creation-failed')
  assert.match(parsed[0].exception, /SellableCatalogUnavailable$/)
  assert.equal(parsed[0].sqlstate, '23000')
  assert.equal(parsed[0].driver_code, 19)
  assert.equal(parsed[0].identifier, 'products.sku')
  assert.equal(parsed[0].iteration, 14)
  assert.equal(parsed[0].transaction_level, 1)
})

test.after(() => {
  // Nothing should be left, but a stray sandbox from a crashed case must not leak into the next run.
  for (const name of readdirSync(TEMP_ROOT).filter((entry) => entry.startsWith(SANDBOX_PREFIX))) {
    rmSync(join(TEMP_ROOT, name), { force: true, recursive: true })
  }
})
