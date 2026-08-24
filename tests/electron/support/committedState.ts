import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import type { DatabaseSandbox } from './sandbox'

function assertTableName(table: string): void {
  if (!/^[a-z_]+$/.test(table)) {
    throw new Error(`Invalid test table name: ${table}`)
  }
}

function jsonValue(value: unknown): unknown {
  return Buffer.isBuffer(value) ? { blob: value.toString('base64') } : value
}

export function readCommitted<T>(
  sandbox: DatabaseSandbox,
  sql: string,
  parameters: unknown[] = []
): T[] {
  const database = new Database(sandbox.databasePath, { readonly: true, fileMustExist: true })

  try {
    return database.prepare(sql).all(...parameters) as T[]
  } finally {
    database.close()
  }
}

export function tableDigest(sandbox: DatabaseSandbox, table: string): string {
  assertTableName(table)
  const rows = readCommitted<Record<string, unknown>>(
    sandbox,
    `SELECT * FROM ${table} ORDER BY rowid`
  )
  const normalizedRows = rows.map((row) =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key, jsonValue(value)]))
  )

  return createHash('sha256').update(JSON.stringify(normalizedRows)).digest('hex')
}
