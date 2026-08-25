import { equal, throws } from 'node:assert/strict'
import { closeDatabase } from '../../../src/main/database/connection'
import { DesktopApiClient } from '../../../src/main/http/desktopApiClient'
import { BootstrapService } from '../../../src/main/services/bootstrap.service'
import { desktopBootstrapFixture } from '../../../src/main/testing/fixtures/desktopBootstrap.fixture'
import { databaseTest } from '../support/sandbox'
import { readCommitted } from '../support/committedState'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories } from '../support/realRepositories'

databaseTest(
  'bootstrap remains fail-closed when completion fails after the snapshot commits',
  async (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const identities = repositories.deviceIdentity
    identities.create({
      deviceUuid: '33333333-3333-4333-8333-333333333333',
      deviceName: 'Example Register',
      platform: 'linux',
      osVersion: '6.0',
      appVersion: '1.0.0',
      isRegistered: true
    })
    identities.markRegisteredWithBackend('2026-01-01T00:00:00Z')
    const resource = desktopBootstrapFixture()
    const apiClient = new DesktopApiClient({
      apiOrigin: new URL('https://api.example.test'),
      getAccessToken: () => 'desktop-token',
      getDeviceUuid: () => resource.device.device_uuid,
      fetchImplementation: (async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            success: true,
            message: 'Bootstrap retrieved.',
            code: 'DESKTOP_BOOTSTRAP_RETRIEVED',
            data: resource,
            meta: {}
          })
        }) as Response) as typeof fetch
    })
    const service = new BootstrapService(
      apiClient,
      identities,
      { assertCanSync: () => undefined },
      {
        markComplete: () => {
          throw new Error('completion write failed')
        }
      },
      repositories.bootstrapSnapshot
    )

    await throwsAsync(() => service.refresh(), /completion write failed/)
    closeDatabase(database)

    equal(readCommitted(sandbox, 'SELECT * FROM catalog_products').length, 1)
    equal(
      readCommitted<{ is_complete: number }>(sandbox, 'SELECT is_complete FROM bootstrap_state')[0]
        ?.is_complete ?? 0,
      0
    )
  }
)

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
