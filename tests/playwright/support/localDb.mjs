/**
 * Read-only access to the running app's LOCAL SQLite (inside the isolated profile), for asserting
 * durable effects. Opened with `mode=ro` through Python's sqlite3 (the app's better-sqlite3 build
 * targets Electron's ABI, not this Node). The only write is `ageAssetRetryStamps`, made while the app is
 * closed; every path outside the run directory is refused.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `appDir` is the userData folder inside the profile: `Electron` for the harness build (launched as a
 * script), `pos-desktop` (the productName) for the packaged app.
 */
export function localDatabasePath(profileDir, appDir = 'Electron') {
  if (profileDir.includes('/.config/pos-desktop')) {
    throw new Error('refusing to read a real workstation profile')
  }
  const path = join(profileDir, appDir, 'pos-desktop.sqlite')
  if (!existsSync(path)) {
    throw new Error(`no local POS database at ${path}`)
  }
  return path
}

export function queryLocal(profileDir, sql, params = [], appDir = 'Electron') {
  const path = localDatabasePath(profileDir, appDir)
  const script = `
import json, sqlite3, sys
con = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True)
con.row_factory = sqlite3.Row
rows = [dict(r) for r in con.execute(sys.argv[2], json.loads(sys.argv[3]))]
print(json.dumps(rows))
`
  const result = spawnSync('python3', ['-c', script, path, sql, JSON.stringify(params)], {
    encoding: 'utf8'
  })
  if (result.status !== 0) {
    throw new Error(`local query failed: ${result.stderr}`)
  }
  return JSON.parse(result.stdout)
}

const RETRY_STAMP_TABLES = new Set(['product_image_assets', 'company_brand_assets'])

/**
 * Test clock for downloaded-asset retries: moves the stored `last_attempt_at` of failed, still-pending
 * assets back by `seconds`, as if that much time had passed. Only call it while the app is CLOSED (the
 * one write this module makes, like stage6legacy's precondition), on an isolated profile
 * (`localDatabasePath` refuses a real one), for one of the two asset tables.
 */
export function ageAssetRetryStamps(profileDir, table, seconds) {
  if (!RETRY_STAMP_TABLES.has(table) || !Number.isInteger(seconds) || seconds <= 0) {
    throw new Error(`refusing to age retry stamps of ${table} by ${seconds}`)
  }
  const script = `
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
cur = con.execute(
  "UPDATE ${table} SET last_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', last_attempt_at, ?) "
  "WHERE status = 'pending' AND attempts > 0 AND last_attempt_at IS NOT NULL",
  ('-' + sys.argv[2] + ' seconds',))
con.commit()
print(cur.rowcount)
`
  const result = spawnSync(
    'python3',
    ['-c', script, localDatabasePath(profileDir), String(seconds)],
    {
      encoding: 'utf8'
    }
  )
  if (result.status !== 0) {
    throw new Error(`aging retry stamps failed: ${result.stderr}`)
  }
  return Number(result.stdout.trim())
}
