import { deepEqual, equal } from 'node:assert/strict'
import { publicAppErrorSchema } from '../../../src/shared/contracts/api.contract'
import { handleRuntimeTransition } from '../../../src/renderer/src/app/session/runtimeTransition'
import { closeDatabase } from '../../../src/main/database/connection'
import { desktopBootstrapFixture } from '../../../src/main/testing/fixtures/desktopBootstrap.fixture'
import { licenseStatusFixture } from '../../../src/main/testing/fixtures/licenseStatus.fixture'
import { DESKTOP_LICENSE_JWT_KEY } from '../../../src/main/services/license.service'
import { DESKTOP_ACCESS_TOKEN_KEY } from '../../../src/main/services/session.service'
import { SecureStorageService } from '../../../src/main/services/secureStorage.service'
import { databaseTest } from '../support/sandbox'
import { readCommitted, tableDigest } from '../support/committedState'
import { fakeSafeStorage } from '../support/fakeSafeStorage'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories } from '../support/realRepositories'

databaseTest(
  'device recovery preserves durable SQLite state and the stable device UUID',
  async (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const storage = new SecureStorageService(repositories.secureSecrets, fakeSafeStorage())
    const deviceUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    repositories.deviceIdentity.create({
      deviceUuid,
      deviceName: 'Example Register',
      platform: 'linux',
      osVersion: '6.0',
      appVersion: '1.0.0',
      isRegistered: true
    })
    repositories.deviceIdentity.markRegisteredWithBackend('2026-01-01T00:00:00Z')
    repositories.deviceRegistration.set({
      serverDeviceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      status: 'active',
      lastSeenAt: null,
      updatedAt: '2026-01-01T00:00:00Z'
    })
    repositories.bootstrapSnapshot.persistSnapshot(
      desktopBootstrapFixture(),
      '2026-01-01T00:00:00Z'
    )
    repositories.licenseMetadata.setValidatedStatus(licenseStatusFixture(), '2026-01-01T00:00:00Z')
    repositories.sessionMetadata.establish({
      userName: 'Cashier',
      userEmail: 'cashier@example.test'
    })
    storage.setSecret(DESKTOP_LICENSE_JWT_KEY, 'license-jwt')
    storage.setSecret(DESKTOP_ACCESS_TOKEN_KEY, 'access-token')
    repositories.syncQueue.enqueue({
      localQueueUuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      aggregateType: 'invoice',
      localAggregateUuid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      operation: 'create',
      payloadJson: '{}',
      payloadHash: 'hash',
      idempotencyKey: 'queue-one'
    })

    const retainedTables = [
      'device_identity',
      'device_registration',
      'bootstrap_company',
      'license_state_metadata',
      'app_settings',
      'auth_session_metadata',
      'secure_secrets',
      'sync_queue'
    ]
    const before = retainedTables.map((table) => tableDigest(sandbox, table))
    let loginTransitions = 0
    let activationTransitions = 0

    const handled = await handleRuntimeTransition(
      publicAppErrorSchema.parse({
        category: 'authentication',
        message: 'Device binding changed.',
        backendCode: 'DESKTOP_TOKEN_DEVICE_MISMATCH',
        retryable: false
      }),
      {
        session: {
          refreshStartup: async () => undefined,
          replaceLogin: async () => {
            loginTransitions += 1
          },
          setAuthMessage: () => undefined
        },
        device: {
          refreshStartup: async () => undefined,
          replaceActivation: async () => {
            activationTransitions += 1
          },
          setDeviceRecoveryMessage: () => undefined
        }
      }
    )

    const after = retainedTables.map((table) => tableDigest(sandbox, table))
    closeDatabase(database)

    equal(handled, true)
    equal(loginTransitions, 0)
    equal(activationTransitions, 1)
    deepEqual(after, before)
    equal(
      readCommitted<{ device_uuid: string }>(sandbox, 'SELECT device_uuid FROM device_identity')[0]
        ?.device_uuid,
      deviceUuid
    )
  }
)
