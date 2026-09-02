import type { SqliteDatabase } from '../../../src/main/database/connection'

export interface FailingDatabaseOptions {
  readonly failOnWriteNumber?: number
  readonly failWhen?: (statementSql: string, writeNumber: number) => boolean
  readonly onWrite?: (writeNumber: number) => void
  /** Runs after a real write, for deliberate post-write integrity corruption tests. */
  readonly afterWrite?: (statementSql: string, writeNumber: number) => void
  /**
   * Builds the thrown value. Defaults to a plain `Error`, which `LocalSaleService` classifies as a
   * definite (if unexpected) rejection. Supply one carrying `code: 'SQLITE_BUSY'`/`'SQLITE_LOCKED'`
   * to exercise the distinct storage-failure path, which must leave the attempt `claimed`.
   */
  readonly failWith?: (writeNumber: number) => unknown
}

type Statement = ReturnType<SqliteDatabase['prepare']>

function wrapStatement(
  statement: Statement,
  options: FailingDatabaseOptions,
  nextWriteNumber: () => number,
  statementSql: string
): Statement {
  return new Proxy(statement, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)

      if (property !== 'run' || typeof value !== 'function') {
        return typeof value === 'function' ? value.bind(target) : value
      }

      return (...arguments_: unknown[]) => {
        const writeNumber = nextWriteNumber()
        options.onWrite?.(writeNumber)

        if (
          writeNumber === options.failOnWriteNumber ||
          options.failWhen?.(statementSql, writeNumber)
        ) {
          throw options.failWith
            ? options.failWith(writeNumber)
            : new Error(`Injected SQLite write failure #${writeNumber}`)
        }

        const result = Reflect.apply(value, target, arguments_)
        options.afterWrite?.(statementSql, writeNumber)
        return result
      }
    }
  })
}

/**
 * Injects one statement-write failure while leaving transaction() bound to the actual SQLite
 * connection. It is intentionally not an in-memory repository fake.
 */
export function failingDatabase(
  database: SqliteDatabase,
  options: FailingDatabaseOptions
): SqliteDatabase {
  let writeCount = 0

  return new Proxy(database, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)

      if (property === 'prepare' && typeof value === 'function') {
        return (...arguments_: unknown[]) =>
          wrapStatement(
            Reflect.apply(value, target, arguments_) as Statement,
            options,
            () => ++writeCount,
            typeof arguments_[0] === 'string' ? arguments_[0] : ''
          )
      }

      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}
