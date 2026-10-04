/**
 * Read-only access to the running app's LOCAL SQLite (inside the isolated profile), for asserting
 * durable effects. Opened with `mode=ro` through Python's sqlite3 (the app's better-sqlite3 build
 * targets Electron's ABI, not this Node). Never writes; refuses any path outside the run directory.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export function localDatabasePath(profileDir) {
  if (profileDir.includes('/.config/pos-desktop')) {
    throw new Error('refusing to read a real workstation profile')
  }
  const path = join(profileDir, 'Electron', 'pos-desktop.sqlite')
  if (!existsSync(path)) {
    throw new Error(`no local POS database at ${path}`)
  }
  return path
}

export function queryLocal(profileDir, sql, params = []) {
  const path = localDatabasePath(profileDir)
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
