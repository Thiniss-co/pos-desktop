import { deepEqual, equal } from 'node:assert/strict'
import { closeDatabase } from '../../../src/main/database/connection'
import { desktopBootstrapFixture } from '../../../src/main/testing/fixtures/desktopBootstrap.fixture'
import { licenseStatusFixture } from '../../../src/main/testing/fixtures/licenseStatus.fixture'
import { DESKTOP_LICENSE_JWT_KEY } from '../../../src/main/services/license.service'
import {
  DESKTOP_ACCESS_TOKEN_KEY,
  SessionService
} from '../../../src/main/services/session.service'
import { SecureStorageService } from '../../../src/main/services/secureStorage.service'
import { databaseTest } from '../support/sandbox'
import { readCommitted, tableDigest } from '../support/committedState'
import { fakeSafeStorage } from '../support/fakeSafeStorage'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories } from '../support/realRepositories'

databaseTest(
  'ending a session clears session/token data while retaining durable device, bootstrap, license, and queue state',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const snapshots = repositories.bootstrapSnapshot
    const metadata = repositories.licenseMetadata
    const storage = new SecureStorageService(repositories.secureSecrets, fakeSafeStorage())
    const sessionMetadata = repositories.sessionMetadata
    const queue = repositories.syncQueue

    database
      .prepare(
        'INSERT INTO device_identity (id, device_uuid, device_name, platform, os_version, app_version, registered_at, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'Example Register',
        'linux',
        '6.0',
        '1.0.0',
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:00:00Z'
      )
    database
      .prepare(
        'INSERT INTO device_registration (id, server_device_id, status, last_seen_at, updated_at) VALUES (1, ?, ?, ?, ?)'
      )
      .run('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'active', null, '2026-01-01T00:00:00Z')
    snapshots.persistSnapshot(desktopBootstrapFixture(), '2026-01-01T00:00:00Z')
    metadata.setValidatedStatus(licenseStatusFixture(), '2026-01-01T00:00:00Z')
    sessionMetadata.establish({ userName: 'Cashier', userEmail: 'cashier@example.test' })
    storage.setSecret(DESKTOP_LICENSE_JWT_KEY, 'license-jwt')
    storage.setSecret(DESKTOP_ACCESS_TOKEN_KEY, 'access-token')
    queue.enqueue({
      localQueueUuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      aggregateType: 'invoice',
      localAggregateUuid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      operation: 'create',
      payloadJson: '{}',
      payloadHash: 'hash',
      idempotencyKey: 'queue-one'
    })
    queue.enqueue({
      localQueueUuid: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      aggregateType: 'invoice',
      localAggregateUuid: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      operation: 'create',
      payloadJson: '{}',
      payloadHash: 'hash',
      idempotencyKey: 'queue-two'
    })
    const retainedTables = [
      'device_identity',
      'device_registration',
      'bootstrap_company',
      'license_state_metadata',
      'app_settings',
      'sync_queue'
    ]
    const before = retainedTables.map((table) => tableDigest(sandbox, table))

    new SessionService(sessionMetadata, storage).endSession()
    const after = retainedTables.map((table) => tableDigest(sandbox, table))
    closeDatabase(database)

    deepEqual(after, before)
    equal(
      readCommitted<{ user_email: string | null }>(
        sandbox,
        'SELECT user_email FROM auth_session_metadata'
      )[0]?.user_email,
      null
    )
    equal(readCommitted(sandbox, 'SELECT * FROM secure_secrets').length, 1)
  }
)
