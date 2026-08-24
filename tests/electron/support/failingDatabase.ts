import type { SqliteDatabase } from '../../../src/main/database/connection'

export interface FailingDatabaseOptions {
  readonly failOnWriteNumber: number
  readonly onWrite?: (writeNumber: number) => void
}

type Statement = ReturnType<SqliteDatabase['prepare']>

function wrapStatement(
  statement: Statement,
  options: FailingDatabaseOptions,
  nextWriteNumber: () => number
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

        if (writeNumber === options.failOnWriteNumber) {
          throw new Error(`Injected SQLite write failure #${writeNumber}`)
        }

        return Reflect.apply(value, target, arguments_)
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
            () => ++writeCount
          )
      }

      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}
