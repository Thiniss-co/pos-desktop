import { equal, throws } from 'node:assert/strict'
import { closeDatabase } from '../../../src/main/database/connection'
import { DesktopApiClient } from '../../../src/main/http/desktopApiClient'
import { ActivationService } from '../../../src/main/services/activation.service'
import { databaseTest } from '../support/sandbox'
import { readCommitted } from '../support/committedState'
import { failingDatabase } from '../support/failingDatabase'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories } from '../support/realRepositories'

const identity = {
  deviceUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  deviceName: 'Example Register',
  platform: 'linux',
  osVersion: '6.0',
  appVersion: '1.0.0',
  isRegistered: false
}

function activationApiClient(): DesktopApiClient {
  return new DesktopApiClient({
    apiOrigin: new URL('https://api.example.test'),
    getAccessToken: () => null,
    getDeviceUuid: () => null,
    fetchImplementation: (async () =>
      ({
        ok: true,
        status: 201,
        headers: new Headers(),
        json: async () => ({
          success: true,
          message: 'Device registered.',
          code: 'DEVICE_REGISTERED',
          data: {
            id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            device_uuid: identity.deviceUuid,
            device_name: identity.deviceName,
            platform: identity.platform,
            status: 'active',
            last_seen_at: null,
            created_at: '2026-01-01T00:00:00+00:00',
            updated_at: '2026-01-01T00:00:00+00:00'
          },
          meta: {}
        })
      }) as Response) as typeof fetch
  })
}

databaseTest(
  'activation commits local registration and server device state together',
  async (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    repositories.deviceIdentity.create(identity)
    const service = new ActivationService(
      database,
      repositories.deviceIdentity,
      repositories.deviceRegistration,
      activationApiClient()
    )

    await service.register({ companyCode: 'EXAMPLE', activationCode: 'activation-code' })
    closeDatabase(database)

    equal(
      readCommitted<{ registered_at: string }>(
        sandbox,
        'SELECT registered_at FROM device_identity'
      )[0]?.registered_at === null,
      false
    )
    equal(
      readCommitted<{ status: string }>(sandbox, 'SELECT status FROM device_registration')[0]
        ?.status,
      'active'
    )
  }
)

databaseTest('activation write failure rolls back both registration records', async (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  repositories.deviceIdentity.create(identity)
  const failing = failingDatabase(database, { failOnWriteNumber: 2 })
  const failingRepositories = realRepositories(failing)
  const service = new ActivationService(
    failing,
    failingRepositories.deviceIdentity,
    failingRepositories.deviceRegistration,
    activationApiClient()
  )

  await throwsAsync(
    () => service.register({ companyCode: 'EXAMPLE', activationCode: 'activation-code' }),
    /Injected SQLite write failure/
  )
  closeDatabase(database)

  equal(
    readCommitted<{ registered_at: string | null }>(
      sandbox,
      'SELECT registered_at FROM device_identity'
    )[0]?.registered_at,
    null
  )
  equal(readCommitted(sandbox, 'SELECT * FROM device_registration').length, 0)
})

async function throwsAsync(callback: () => Promise<unknown>, expected: RegExp): Promise<void> {
  let failure: unknown

  try {
    await callback()
  } catch (error) {
    failure = error
  }

  throws(() => {
    if (failure) {
      throw failure
    }
  }, expected)
}
