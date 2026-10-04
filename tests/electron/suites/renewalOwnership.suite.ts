import { deepEqual, equal, ok, rejects, throws } from 'node:assert/strict'
import { closeDatabase } from '../../../src/main/database/connection'
import { databaseMigrations } from '../../../src/main/database/migrations'
import { DesktopApiClient } from '../../../src/main/http/desktopApiClient'
import { DESKTOP_LICENSE_JWT_KEY, LicenseService } from '../../../src/main/services/license.service'
import { SecureStorageService } from '../../../src/main/services/secureStorage.service'
import { captureRenewalOwner } from '../../../src/main/services/renewalOwner'
import { databaseTest } from '../support/sandbox'
import { fakeSafeStorage } from '../support/fakeSafeStorage'
import {
  openExistingTestDatabase,
  openTestDatabase,
  runTestMigrations
} from '../support/openTestDatabase'
import { realRepositories } from '../support/realRepositories'

/**
 * Rev 4 §6.4 / §7.1 on real SQLite:
 *  - authority rows are warehouse-bound; a pre-v2 row (NULL warehouse) is never selected, and its
 *    warehouse is filled once only from the server's own v2 publication of the same bytes;
 *  - selection compares parsed instants on a half-open window and is deterministic;
 *  - a license leg whose owner changed in flight writes NOTHING (token, metadata, anchor, authority).
 */

const COMPANY = '10000000-0000-4000-8000-000000000001'
const DEVICE = '10000000-0000-4000-8000-000000000002'
const WAREHOUSE_A = '10000000-0000-4000-8000-00000000000a'
const WAREHOUSE_B = '10000000-0000-4000-8000-00000000000b'

interface PublishedAuthority {
  readonly id: string
  readonly mode: 'physical_presence'
  readonly policy_revision: number
  readonly contract_version: number
  readonly issued_at: string
  readonly not_before: string
  readonly not_after: string
  readonly authority_hash: string
  readonly [extra: string]: unknown
}

function published(overrides: Record<string, unknown> = {}): PublishedAuthority {
  return {
    id: '10000000-0000-4000-8000-0000000000f1',
    mode: 'physical_presence' as const,
    policy_revision: 1,
    contract_version: 3,
    issued_at: '2026-09-30T10:00:00+00:00',
    not_before: '2026-09-30T10:00:00+00:00',
    not_after: '2026-10-03T10:00:00+00:00',
    authority_hash: 'a'.repeat(64),
    ...overrides
  }
}

databaseTest('a pre-v2 authority keeps a NULL warehouse and is never selected', (sandbox) => {
  // Build the database as it stood before 0017, store an authority, then migrate.
  const legacy = openExistingTestDatabase(sandbox)
  runTestMigrations(legacy, databaseMigrations.slice(0, 16))
  legacy
    .prepare(
      `INSERT INTO offline_sale_authorities (authority_uuid, company_uuid, device_uuid, mode, policy_revision,
        contract_version, issued_at, not_before, not_after, authority_hash, observed_at, created_at)
       VALUES (?, ?, ?, 'physical_presence', 1, 3, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      published().id,
      COMPANY,
      DEVICE,
      published().issued_at,
      published().not_before,
      published().not_after,
      'a'.repeat(64),
      '2026-09-30T10:00:00Z',
      '2026-09-30T10:00:00Z'
    )
  runTestMigrations(legacy, databaseMigrations)
  const repository = realRepositories(legacy).offlineSaleAuthorities

  equal(repository.findByUuid(published().id)?.warehouseUuid, null)
  equal(repository.findUsable(COMPANY, DEVICE, WAREHOUSE_A, '2026-10-01T00:00:00Z'), null)

  // The server later publishes the SAME authority in v2 → filled once, then selectable for A only.
  repository.observe(
    published({ warehouse_uuid: WAREHOUSE_A }),
    COMPANY,
    DEVICE,
    '2026-10-01T00:00:00Z'
  )
  equal(repository.findByUuid(published().id)?.warehouseUuid, WAREHOUSE_A)
  equal(
    repository.findUsable(COMPANY, DEVICE, WAREHOUSE_A, '2026-10-01T00:00:00Z')?.authorityUuid,
    published().id
  )
  equal(repository.findUsable(COMPANY, DEVICE, WAREHOUSE_B, '2026-10-01T00:00:00Z'), null)
  closeDatabase(legacy)
})

databaseTest(
  'fill-once refuses mismatched bytes and a different warehouse; evidence is append-only',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const { offlineSaleAuthorities: repository } = realRepositories(database)

    repository.observe(
      published({ warehouse_uuid: WAREHOUSE_A }),
      COMPANY,
      DEVICE,
      '2026-10-01T00:00:00Z'
    )
    repository.observe(
      published({ warehouse_uuid: WAREHOUSE_B }),
      COMPANY,
      DEVICE,
      '2026-10-01T00:01:00Z'
    )
    repository.observe(
      published({ not_after: '2026-10-09T10:00:00+00:00' }),
      COMPANY,
      DEVICE,
      '2026-10-01T00:02:00Z'
    )

    const stored = repository.findByUuid(published().id)
    equal(stored?.warehouseUuid, WAREHOUSE_A)
    equal(stored?.notAfter, published().not_after)
    const conflicts = database
      .prepare('SELECT reason FROM offline_sale_authority_conflicts ORDER BY id')
      .all() as Array<{ reason: string }>
    deepEqual(
      conflicts.map((c) => c.reason),
      ['warehouse_mismatch', 'immutable_field_mismatch']
    )
    throws(() => database.prepare('DELETE FROM offline_sale_authority_conflicts').run())
    throws(() => database.prepare("UPDATE offline_sale_authority_conflicts SET reason = 'x'").run())
    closeDatabase(database)
  }
)

databaseTest('selection is half-open on parsed instants and deterministic', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const { offlineSaleAuthorities: repository } = realRepositories(database)
  repository.observe(
    published({ warehouse_uuid: WAREHOUSE_A }),
    COMPANY,
    DEVICE,
    '2026-10-01T00:00:00Z'
  )
  repository.observe(
    published({
      id: '10000000-0000-4000-8000-0000000000f2',
      not_after: '2026-10-03T10:00:00+00:00',
      not_before: '2026-09-30T11:00:00+00:00',
      issued_at: '2026-09-30T11:00:00+00:00',
      warehouse_uuid: WAREHOUSE_A
    }),
    COMPANY,
    DEVICE,
    '2026-10-01T00:00:00Z'
  )

  // A different textual form of the same instant must not decide the boundary.
  equal(repository.findUsable(COMPANY, DEVICE, WAREHOUSE_A, '2026-10-03T10:00:00.000Z'), null)
  equal(repository.findUsable(COMPANY, DEVICE, WAREHOUSE_A, '2026-09-30T09:59:59.999Z'), null)
  ok(repository.findUsable(COMPANY, DEVICE, WAREHOUSE_A, '2026-09-30T10:00:00.000Z'))
  // Equal not_after → the later not_before wins, every time.
  equal(
    repository.findUsable(COMPANY, DEVICE, WAREHOUSE_A, '2026-10-01T00:00:00Z')?.authorityUuid,
    '10000000-0000-4000-8000-0000000000f2'
  )
  closeDatabase(database)
})

databaseTest('a license leg whose owner changed in flight writes nothing', async (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  const secure = new SecureStorageService(repositories.secureSecrets, fakeSafeStorage())
  repositories.sessionMetadata.establish({
    userName: 'Cashier',
    userEmail: 'cashier@example.test',
    userUuid: '10000000-0000-4000-8000-0000000000c1',
    userIsActive: true,
    companyUuid: COMPANY,
    deviceUuid: DEVICE,
    serverDeviceId: '10000000-0000-4000-8000-0000000000d1'
  })
  const owner = (): ReturnType<typeof captureRenewalOwner> =>
    captureRenewalOwner({
      session: repositories.sessionMetadata,
      epoch: repositories.sessionEpoch,
      assignment: repositories.bootstrapSnapshot
    })
  ok(owner(), 'a signed-in owner exists before the request')

  const envelope = {
    success: true,
    message: 'License validated successfully.',
    code: 'LICENSE_VALIDATED',
    data: {
      token: 'jwt',
      expires_at: '2026-10-03T10:00:00Z',
      server_time: '2026-09-30T10:00:00Z',
      last_validated_at: '2026-09-30T10:00:00Z',
      next_validation_due_at: '2026-10-03T10:00:00Z',
      max_offline_hours: 72,
      subscription: null,
      access: {
        is_active: true,
        is_trial: false,
        is_in_grace: false,
        is_expired: false,
        is_suspended: false,
        can_login: true,
        can_sell: true,
        can_sync: true,
        can_activate_device: true,
        restriction_level: 'none',
        warning_message: null
      },
      offline_sale_authority: published({ warehouse_uuid: WAREHOUSE_A })
    },
    meta: {}
  }
  const apiClient = new DesktopApiClient({
    apiOrigin: new URL('https://api.example.test'),
    getAccessToken: () => 'token',
    getDeviceUuid: () => DEVICE,
    fetchImplementation: (async () => {
      // Sign-out lands while the response is in flight.
      repositories.sessionMetadata.clear()
      repositories.sessionEpoch.increment()
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => envelope
      }
    }) as unknown as typeof fetch
  })
  const license = new LicenseService(apiClient, repositories.licenseMetadata, secure, undefined, {
    database,
    owner,
    offlineSaleAuthorities: repositories.offlineSaleAuthorities
  })

  await rejects(license.validate(), (error: { code?: string }) => error.code === 'owner-changed')

  equal(repositories.secureSecrets.get(DESKTOP_LICENSE_JWT_KEY), null)
  equal(repositories.licenseMetadata.getTrustedTimeAnchor(), null)
  equal(
    (database.prepare('SELECT COUNT(*) AS n FROM offline_sale_authorities').get() as { n: number })
      .n,
    0
  )
  closeDatabase(database)
})
