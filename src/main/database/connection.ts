import { app } from 'electron'
import Database from 'better-sqlite3'
import { join } from 'path'

export type SqliteDatabase = Database.Database

export interface DatabaseConnectionOptions {
  readonly databasePath?: string
}

export function getDefaultDatabasePath(): string {
  return join(app.getPath('userData'), 'pos-desktop.sqlite')
}

export function openDatabase(options: DatabaseConnectionOptions = {}): SqliteDatabase {
  const database = new Database(options.databasePath ?? getDefaultDatabasePath())

  database.pragma('foreign_keys = ON')
  database.pragma('journal_mode = WAL')
  database.pragma('busy_timeout = 5000')

  return database
}

export function closeDatabase(database: SqliteDatabase): void {
  if (database.open) {
    database.close()
  }
}
