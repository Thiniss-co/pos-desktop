import { equal, ok, rejects } from 'node:assert/strict'
import { closeDatabase } from '../../../src/main/database/connection'
import { DesktopApiClient } from '../../../src/main/http/desktopApiClient'
import {
  ACCESS_SEQUENCE_SETTING_KEY,
  admitAccessAnswer,
  SettingsAccessSequenceStore
} from '../../../src/main/services/accessOrdering'
import { LicenseService } from '../../../src/main/services/license.service'
import { captureRenewalOwner } from '../../../src/main/services/renewalOwner'
import { SecureStorageService } from '../../../src/main/services/secureStorage.service'
import { fakeSafeStorage } from '../support/fakeSafeStorage'
import { openExistingTestDatabase, openTestDatabase } from '../support/openTestDatabase'
import { realRepositories } from '../support/realRepositories'
import { databaseTest } from '../support/sandbox'

/**
 * Phase 6, criterion C3 on real SQLite: license answers are ordered by the server's `meta.access_sequence`, never by
 * clocks; an older or equal answer writes nothing; the accepted restriction survives a restart; a newer resume restores
 * access; a new session starts a fresh order; an unsequenced answer (older backend) may restrict but never relax.
 */

const COMPANY = '20000000-0000-4000-8000-000000000001'
const DEVICE = '20000000-0000-4000-8000-000000000002'

interface Answer {
  readonly canSell: boolean
  readonly sequence: number | null
  readonly serverTime: string
}

function envelope(answer: Answer): unknown {
  return {
    success: true,
    message: 'License validated successfully.',
    code: 'LICENSE_VALIDATED',
    data: {
      token: `jwt-${answer.sequence ?? 'none'}`,
      expires_at: '2026-12-31T00:00:00Z',
      server_time: answer.serverTime,
      last_validated_at: answer.serverTime,
      next_validation_due_at: '2026-12-31T00:00:00Z',
      max_offline_hours: 72,
      subscription: null,
      access: {
        is_active: true,
        is_trial: false,
        is_in_grace: false,
        is_expired: false,
        is_suspended: !answer.canSell,
        can_login: true,
        can_sell: answer.canSell,
        can_sync: answer.canSell,
        can_activate_device: true,
        restriction_level: answer.canSell ? 'allow_all' : 'block_all',
        warning_message: null
      }
    },
    meta:
      answer.sequence === null
        ? { trace_id: 't' }
        : { trace_id: 't', access_sequence: answer.sequence }
  }
}

interface Harness {
  readonly repositories: ReturnType<typeof realRepositories>
  readonly store: SettingsAccessSequenceStore
  readonly owner: () => ReturnType<typeof captureRenewalOwner>
  readonly signIn: () => void
  readonly validate: (answer: Answer) => Promise<void>
}

function harness(database: ReturnType<typeof openTestDatabase>): Harness {
  const repositories = realRepositories(database)
  const secure = new SecureStorageService(repositories.secureSecrets, fakeSafeStorage())
  const store = new SettingsAccessSequenceStore(repositories.appSettings)
  const owner = (): ReturnType<typeof captureRenewalOwner> =>
    captureRenewalOwner({
      session: repositories.sessionMetadata,
      epoch: repositories.sessionEpoch,
      assignment: repositories.bootstrapSnapshot
    })
  const signIn = (): void =>
    repositories.sessionMetadata.establish({
      userName: 'Cashier',
      userEmail: 'cashier@example.test',
      userUuid: '20000000-0000-4000-8000-0000000000c1',
      userIsActive: true,
      companyUuid: COMPANY,
      deviceUuid: DEVICE,
      serverDeviceId: '20000000-0000-4000-8000-0000000000d1'
    })
  const validate = async (answer: Answer): Promise<void> => {
    const apiClient = new DesktopApiClient({
      apiOrigin: new URL('https://api.example.test'),
      getAccessToken: () => 'token',
      getDeviceUuid: () => DEVICE,
      fetchImplementation: (async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => envelope(answer)
      })) as unknown as typeof fetch
    })
    const license = new LicenseService(
      apiClient,
      repositories.licenseMetadata,
      secure,
      () => new Date('2026-10-01T00:00:00Z'),
      {
        database,
        owner,
        accessOrdering: { store, currentStatus: () => repositories.licenseMetadata.getStatus() }
      }
    )
    await license.validate()
  }

  return { repositories, store, owner, signIn, validate }
}

const discarded = (error: { code?: string }): boolean => error.code === 'owner-changed'

databaseTest(
  'an older allow arriving after a newer deny writes nothing, and the denial survives a restart',
  async (sandbox) => {
    const database = openTestDatabase(sandbox)
    const { repositories, store, signIn, validate } = harness(database)
    signIn()

    await validate({ canSell: false, sequence: 5, serverTime: '2026-10-01T10:00:00Z' })
    // The delayed older answer even claims a LATER server time: clocks never decide.
    await rejects(
      validate({ canSell: true, sequence: 4, serverTime: '2026-10-01T11:00:00Z' }),
      discarded
    )
    // An equal sequence is also refused.
    await rejects(
      validate({ canSell: true, sequence: 5, serverTime: '2026-10-01T10:00:00Z' }),
      discarded
    )

    equal(repositories.licenseMetadata.getStatus()?.canSell, false)
    equal(store.get()?.sequence, 5)
    closeDatabase(database)

    // Restart (the app process ends; offline): the restriction and its sequence are what was committed together.
    const reopened = openExistingTestDatabase(sandbox)
    const after = realRepositories(reopened)
    equal(after.licenseMetadata.getStatus()?.canSell, false)
    ok(after.appSettings.get(ACCESS_SEQUENCE_SETTING_KEY)?.includes('"sequence":5'))
    closeDatabase(reopened)
  }
)

databaseTest(
  'a newer resume after a denial restores access even with an earlier server time (clock skew)',
  async (sandbox) => {
    const database = openTestDatabase(sandbox)
    const { repositories, signIn, validate } = harness(database)
    signIn()

    await validate({ canSell: false, sequence: 7, serverTime: '2026-10-01T12:00:00Z' })
    await validate({ canSell: true, sequence: 8, serverTime: '2026-10-01T09:00:00Z' })

    equal(repositories.licenseMetadata.getStatus()?.canSell, true)
    closeDatabase(database)
  }
)

databaseTest(
  'a bootstrap evaluated before a validation but delivered after it is refused (shared order)',
  async (sandbox) => {
    const database = openTestDatabase(sandbox)
    const { store, owner, signIn, validate } = harness(database)
    signIn()

    // Server order: bootstrap evaluated as 10, validation as 11; the validation's answer arrives first.
    await validate({ canSell: false, sequence: 11, serverTime: '2026-10-01T10:00:00Z' })
    // The bootstrap persist transaction admits its answer with the same rule before writing anything.
    let refused = false
    try {
      database.transaction(() => admitAccessAnswer(store, owner(), 10, true))()
    } catch (error) {
      refused = discarded(error as { code?: string })
    }
    ok(refused, 'the older bootstrap answer was not refused')
    equal(store.get()?.sequence, 11)
    closeDatabase(database)
  }
)

databaseTest(
  'a new session starts a fresh order; an unsequenced answer may restrict but never relax',
  async (sandbox) => {
    const database = openTestDatabase(sandbox)
    const { repositories, store, signIn, validate } = harness(database)
    signIn()
    await validate({ canSell: true, sequence: 40, serverTime: '2026-10-01T10:00:00Z' })

    // Older backend answer, restrictive: admitted. Then an unsequenced relaxing answer: refused.
    await validate({ canSell: false, sequence: null, serverTime: '2026-10-01T10:05:00Z' })
    equal(repositories.licenseMetadata.getStatus()?.canSell, false)
    await rejects(
      validate({ canSell: true, sequence: null, serverTime: '2026-10-01T10:06:00Z' }),
      discarded
    )
    equal(repositories.licenseMetadata.getStatus()?.canSell, false)

    // Sign out and in again (epoch changes): the server's counter for this device continues, but even a low value
    // from the new session is the first of its order.
    repositories.sessionMetadata.clear()
    repositories.sessionEpoch.increment()
    signIn()
    await validate({ canSell: true, sequence: 2, serverTime: '2026-10-01T11:00:00Z' })
    equal(repositories.licenseMetadata.getStatus()?.canSell, true)
    equal(store.get()?.sequence, 2)
    closeDatabase(database)
  }
)
