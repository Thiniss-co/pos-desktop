import { deepEqual, equal, throws } from 'node:assert/strict'
import { closeDatabase } from '../../../src/main/database/connection'
import { UserPreferencesService } from '../../../src/main/services/userPreferences.service'
import { databaseTest } from '../support/sandbox'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories } from '../support/realRepositories'

/**
 * POS improvements, Stage 5 — per-user preferences on the real 0023 schema: two cashiers on one
 * register keep their own choice, defaults hold until a user chooses, and the closed key/value set
 * is enforced by the database itself.
 */
databaseTest(
  'per-user preferences are isolated by company and user, with defaults and a closed key set',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    try {
      const { userPreferences } = realRepositories(database)
      let context = { isAuthenticated: true, companyUuid: 'company-a', userUuid: 'cashier-1' }
      const service = new UserPreferencesService({
        session: { getContext: () => context },
        repository: userPreferences,
        now: () => new Date('2026-10-04T12:00:00Z')
      })

      deepEqual(service.current(), { touchMode: false, autoPrint: true })
      deepEqual(service.set({ key: 'ui.touchMode', value: true }), {
        touchMode: true,
        autoPrint: true
      })
      deepEqual(service.set({ key: 'printing.autoPrint', value: false }), {
        touchMode: true,
        autoPrint: false
      })

      context = { isAuthenticated: true, companyUuid: 'company-a', userUuid: 'cashier-2' }
      deepEqual(service.current(), { touchMode: false, autoPrint: true })
      context = { isAuthenticated: true, companyUuid: 'company-b', userUuid: 'cashier-1' }
      deepEqual(service.current(), { touchMode: false, autoPrint: true })
      equal(
        service.autoPrintFor({ companyUuid: 'company-a', userUuid: 'cashier-1' }),
        false,
        'the choice survives for its own user'
      )

      // A second write updates in place (one row per user and key).
      context = { isAuthenticated: true, companyUuid: 'company-a', userUuid: 'cashier-1' }
      service.set({ key: 'ui.touchMode', value: false })
      equal(database.prepare('SELECT COUNT(*) FROM user_preferences').pluck().get(), 2)

      throws(() =>
        database
          .prepare(
            "INSERT INTO user_preferences VALUES ('c', 'u', 'ui.theme', 'true', '2026-10-04T12:00:00Z')"
          )
          .run()
      )
      throws(() =>
        database
          .prepare(
            "INSERT INTO user_preferences VALUES ('c', 'u', 'ui.touchMode', 'yes', '2026-10-04T12:00:00Z')"
          )
          .run()
      )
    } finally {
      closeDatabase(database)
    }
  }
)
