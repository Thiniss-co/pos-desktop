import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { test } from 'node:test'
import type { SqliteDatabase } from '../../../src/main/database/connection'

const SANDBOX_PREFIX = 'pos-desktop-itest-'

export interface DatabaseSandbox {
  readonly root: string
  readonly databasePath: string
  register(database: SqliteDatabase): SqliteDatabase
  retain(): void
  dispose(): void
}

export function assertInsideSandbox(root: string, candidate: string): void {
  const canonicalRoot = realpathSync(root)
  const resolvedCandidate = resolve(canonicalRoot, candidate)

  if (resolvedCandidate === canonicalRoot || !resolvedCandidate.startsWith(canonicalRoot + sep)) {
    throw new Error(`Expected disposable database path inside sandbox: ${resolvedCandidate}`)
  }
}

function assertDisposableRoot(root: string): void {
  const canonicalRoot = realpathSync(root)
  const canonicalTmpDirectory = realpathSync(tmpdir())

  if (
    dirname(canonicalRoot) !== canonicalTmpDirectory ||
    !basename(canonicalRoot).startsWith(SANDBOX_PREFIX)
  ) {
    throw new Error(`Refusing to remove non-test directory: ${canonicalRoot}`)
  }
}

export function createSandbox(): DatabaseSandbox {
  const root = mkdtempSync(join(tmpdir(), SANDBOX_PREFIX))
  const databasePath = join(root, 'pos-desktop.sqlite')
  const handles = new Set<SqliteDatabase>()
  let retained = false
  let disposed = false

  return {
    root,
    databasePath,
    register(database) {
      handles.add(database)
      return database
    },
    retain() {
      retained = true
    },
    dispose() {
      if (disposed) {
        return
      }

      disposed = true
      assertDisposableRoot(root)
      assertInsideSandbox(root, databasePath)
      let leakedHandle = false

      for (const database of handles) {
        if (database.open) {
          leakedHandle = true

          try {
            database.close()
          } catch {
            // Cleanup must still remove the disposable directory even if a faulty test left a
            // connection in an unexpected state. The recorded leak below fails the test last.
          }
        }
      }

      if (retained || process.env.POS_ITEST_KEEP === '1') {
        console.log(`Retained Electron SQLite test sandbox: ${root}`)
      } else {
        rmSync(root, { force: true, recursive: true })
      }

      if (leakedHandle) {
        throw new Error('Electron SQLite test leaked an open database handle')
      }
    }
  }
}

export function databaseTest(
  name: string,
  callback: (sandbox: DatabaseSandbox) => void | Promise<void>
): void {
  test(name, async () => {
    const sandbox = createSandbox()

    try {
      await callback(sandbox)
    } finally {
      sandbox.dispose()
    }
  })
}
