import { deepEqual, equal, throws } from 'node:assert/strict'
import { closeDatabase } from '../../../src/main/database/connection'
import type { SqliteDatabase } from '../../../src/main/database/connection'
import { publicAppErrorSchema } from '../../../src/shared/contracts/api.contract'
import { desktopBootstrapFixture } from '../../../src/main/testing/fixtures/desktopBootstrap.fixture'
import type { SessionEstablishInput } from '../../../src/main/repositories/sessionMetadata.repository'
import { SessionService } from '../../../src/main/services/session.service'
import {
  ShiftAuthorityService,
  type ShiftAuthorityContext
} from '../../../src/main/services/shiftAuthority.service'
import { databaseTest } from '../support/sandbox'
import { readCommitted, tableDigest } from '../support/committedState'
import { openExistingTestDatabase, openTestDatabase } from '../support/openTestDatabase'
import { realRepositories, type RealRepositories } from '../support/realRepositories'

const companyUuid = '11111111-1111-4111-8111-111111111111'
const serverDeviceId = '22222222-2222-4222-8222-222222222222'
const deviceUuid = '33333333-3333-4333-8333-333333333333'
const userUuid = '44444444-4444-4444-8444-444444444444'
const shiftUuid = '55555555-5555-4555-8555-555555555555'

function sessionInput(): SessionEstablishInput {
  return {
    userName: 'Cashier',
    userEmail: 'cashier@example.test',
    userUuid,
    userIsActive: true,
    companyUuid,
    deviceUuid,
    serverDeviceId
  }
}

function bindAuthority(
  database: SqliteDatabase,
  repositories: RealRepositories
): { authority: ShiftAuthorityService; session: SessionService } {
  repositories.deviceIdentity.create({
    deviceUuid,
    deviceName: 'Example Register',
    platform: 'linux',
    osVersion: '6.0',
    appVersion: '1.0.0',
    isRegistered: true
  })
  repositories.deviceIdentity.markRegisteredWithBackend('2026-01-01T00:00:00.000Z')
  repositories.bootstrapSnapshot.persistSnapshot(
    desktopBootstrapFixture(),
    '2026-01-01T00:00:00.000Z'
  )
  const session = new SessionService(
    repositories.sessionMetadata,
    { deleteSecret: () => undefined },
    {
      database,
      epoch: repositories.sessionEpoch,
      observations: repositories.shiftObservations
    }
  )
  session.startSession(sessionInput())
  const authority = new ShiftAuthorityService({
    observations: repositories.shiftObservations,
    session: repositories.sessionMetadata,
    company: repositories.bootstrapSnapshot,
    device: {
      getOrCreate: () => {
        const identity = repositories.deviceIdentity.get()

        if (!identity) {
          throw new Error('Test device identity is unavailable')
        }

        return identity
      }
    },
    epoch: repositories.sessionEpoch,
    now: () => new Date('2026-01-01T01:00:00.000Z')
  })

  return { authority, session }
}

function writeOpenObservation(
  authority: ShiftAuthorityService,
  repositories: RealRepositories
): ShiftAuthorityContext {
  const context = authority.captureContext()
  repositories.shiftObservations.write({
    kind: 'shift',
    ...context,
    shiftUuid,
    status: 'open',
    openedAt: '2026-01-01T00:00:00.000Z',
    observedAt: '2026-01-01T01:00:00.000Z',
    source: 'current'
  })
  return context
}

databaseTest(
  'shift authority SQLite constraints preserve the discriminated observation model',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)

    equal(repositories.sessionEpoch.current(), 1)
    equal(repositories.sessionEpoch.increment(), 2)
    equal('set' in repositories.sessionEpoch, false)
    throws(
      () => database.prepare('UPDATE session_epoch SET value = 1 WHERE id = 1').run(),
      /session_epoch must increment by one/
    )

    repositories.shiftObservations.write({
      kind: 'none',
      companyUuid,
      deviceUuid,
      userUuid,
      sessionEpoch: 2,
      observedAt: '2026-01-01T00:00:00.000Z',
      source: 'current'
    })

    deepEqual(
      database.prepare('SELECT kind, shift_uuid, status FROM shift_observation WHERE id = 1').get(),
      { kind: 'none', shift_uuid: null, status: null }
    )
    throws(
      () =>
        database.prepare('UPDATE shift_observation SET shift_uuid = ? WHERE id = 1').run(shiftUuid),
      /CHECK constraint failed/
    )
    throws(
      () => database.prepare('UPDATE shift_observation SET status = ? WHERE id = 1').run('open'),
      /CHECK constraint failed/
    )

    closeDatabase(database)
  }
)

databaseTest(
  'session epochs invalidate old authority, survive refreshes, and persist after restart',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const { authority, session } = bindAuthority(database, repositories)
    const oldContext = writeOpenObservation(authority, repositories)

    equal(repositories.sessionEpoch.current(), 2)
    equal(authority.resolveForSell().kind, 'open')

    session.refreshSession(sessionInput())
    equal(repositories.sessionEpoch.current(), 2)
    equal(authority.resolveForSell().kind, 'open')

    session.endSession()
    equal(repositories.sessionEpoch.current(), 3)
    equal(repositories.shiftObservations.get(), null)
    session.endSession()
    equal(repositories.sessionEpoch.current(), 3)
    session.startSession(sessionInput())
    equal(repositories.sessionEpoch.current(), 4)
    repositories.shiftObservations.write({
      kind: 'shift',
      ...oldContext,
      shiftUuid,
      status: 'open',
      openedAt: '2026-01-01T00:00:00.000Z',
      observedAt: '2026-01-01T01:00:00.000Z',
      source: 'current'
    })
    equal(authority.resolveForSell().kind, 'foreign')

    session.applyApiFailure(
      publicAppErrorSchema.parse({
        category: 'authentication',
        message: 'Session revoked',
        backendCode: 'SESSION_REVOKED',
        retryable: false
      })
    )
    equal(repositories.sessionEpoch.current(), 5)
    equal(repositories.shiftObservations.get(), null)
    closeDatabase(database)

    const reopened = openExistingTestDatabase(sandbox)
    const restartedRepositories = realRepositories(reopened)
    equal(restartedRepositories.sessionEpoch.current(), 5)
    closeDatabase(reopened)
  }
)

databaseTest(
  'reconciliation_required survives a process restart and continues to deny selling',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const { authority } = bindAuthority(database, repositories)
    const context = authority.captureContext()
    repositories.shiftObservations.write({
      kind: 'reconciliation_required',
      ...context,
      observedAt: '2026-01-01T01:00:00.000Z',
      source: 'close'
    })
    closeDatabase(database)

    const reopened = openExistingTestDatabase(sandbox)
    const restartedRepositories = realRepositories(reopened)
    const restartedAuthority = new ShiftAuthorityService({
      observations: restartedRepositories.shiftObservations,
      session: restartedRepositories.sessionMetadata,
      company: restartedRepositories.bootstrapSnapshot,
      device: {
        getOrCreate: () => {
          const identity = restartedRepositories.deviceIdentity.get()

          if (!identity) {
            throw new Error('Test device identity is unavailable')
          }

          return identity
        }
      },
      epoch: restartedRepositories.sessionEpoch
    })

    deepEqual(restartedAuthority.resolveForSell(), {
      kind: 'reconciliation-required',
      since: '2026-01-01T01:00:00.000Z'
    })
    closeDatabase(reopened)
  }
)

databaseTest(
  'shift observation writes leave checkout, payment, invoice, outbox, and stock state untouched',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const { authority } = bindAuthority(database, repositories)
    const before = ['catalog_stock_items', 'payment_methods', 'sync_queue'].map((table) =>
      tableDigest(sandbox, table)
    )
    const context = authority.captureContext()

    authority.recordCurrent(context, null)

    const after = ['catalog_stock_items', 'payment_methods', 'sync_queue'].map((table) =>
      tableDigest(sandbox, table)
    )
    deepEqual(after, before)
    deepEqual(
      readCommitted<{ name: string }>(
        sandbox,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('checkout_previews', 'invoices', 'payments', 'outbox')"
      ),
      []
    )
    closeDatabase(database)
  }
)
