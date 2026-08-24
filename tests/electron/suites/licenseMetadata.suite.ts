import { equal, throws } from 'node:assert/strict'
import { closeDatabase } from '../../../src/main/database/connection'
import { licenseStatusFixture } from '../../../src/main/testing/fixtures/licenseStatus.fixture'
import { LICENSE_TRUSTED_TIME_ANCHOR_KEY } from '../../../src/main/repositories/licenseMetadata.repository'
import { databaseTest } from '../support/sandbox'
import { readCommitted, tableDigest } from '../support/committedState'
import { failingDatabase } from '../support/failingDatabase'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories } from '../support/realRepositories'

databaseTest(
  'license status and its trusted-time anchor persist atomically with exact timestamp semantics',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repository = realRepositories(database).licenseMetadata
    const status = licenseStatusFixture({ expiresAt: null })
    repository.setValidatedStatus(status, '2026-01-01T00:00:00+00:00')

    equal(repository.getStatus()?.validatedAt, '2026-01-01T00:00:00+00:00')
    equal(repository.getStatus()?.expiresAt, null)
    closeDatabase(database)

    equal(
      readCommitted<{ value: string }>(sandbox, 'SELECT value FROM app_settings WHERE key = ?', [
        LICENSE_TRUSTED_TIME_ANCHOR_KEY
      ])[0]?.value,
      '2026-01-01T00:00:00+00:00'
    )
  }
)

databaseTest('a forced metadata failure leaves both the status and anchor unchanged', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const stable = realRepositories(database).licenseMetadata
  stable.setValidatedStatus(licenseStatusFixture(), '2026-01-01T00:00:00+00:00')
  const statusBefore = tableDigest(sandbox, 'license_state_metadata')
  const anchorBefore = tableDigest(sandbox, 'app_settings')
  const failing = realRepositories(
    failingDatabase(database, { failOnWriteNumber: 2 })
  ).licenseMetadata

  throws(
    () =>
      failing.setValidatedStatus(
        licenseStatusFixture({ restrictionLevel: 'blocked' }),
        '2026-01-02T00:00:00+00:00'
      ),
    /Injected SQLite write failure/
  )
  closeDatabase(database)

  equal(tableDigest(sandbox, 'license_state_metadata'), statusBefore)
  equal(tableDigest(sandbox, 'app_settings'), anchorBefore)
})

databaseTest('corrupt persisted license details fail closed without throwing', (sandbox) => {
  const database = openTestDatabase(sandbox)
  database
    .prepare(
      'INSERT INTO license_state_metadata (id, status, updated_at, details_json) VALUES (1, ?, ?, ?)'
    )
    .run('unknown', '2026-01-01T00:00:00Z', '{broken')
  const repository = realRepositories(database).licenseMetadata
  equal(repository.getStatus(), null)
  closeDatabase(database)
})
