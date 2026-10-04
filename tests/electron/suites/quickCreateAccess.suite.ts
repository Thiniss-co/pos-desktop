import { deepEqual, equal, throws } from 'node:assert/strict'
import { desktopBootstrapFixture } from '../../../src/main/testing/fixtures/desktopBootstrap.fixture'
import { QuickCreateAccessService } from '../../../src/main/services/quickCreateAccess.service'
import { databaseTest } from '../support/sandbox'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories } from '../support/realRepositories'

/**
 * POS improvements, Stage 1 — quick-create access decided in main from the REAL persisted bootstrap:
 * the negotiated capability, the plan feature, the permission, and the user the cache belongs to.
 */

const CASHIER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CASHIER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

databaseTest(
  'quick-create access follows the persisted capability, permission and snapshot owner',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const { bootstrapSnapshot } = realRepositories(database)
    let sessionUser: string | null = CASHIER_A
    const access = new QuickCreateAccessService({
      snapshot: bootstrapSnapshot,
      session: { getContext: () => ({ userUuid: sessionUser }) }
    })

    // An older backend: no `quick_create` block, so nothing is available whatever the permissions.
    bootstrapSnapshot.persistSnapshot(
      desktopBootstrapFixture({ permissions: ['pos.view', 'customers.create'] }),
      '2026-01-01T00:01:00+00:00',
      { permissionsOwnerUserUuid: CASHIER_A }
    )
    deepEqual(access.access(), {
      available: false,
      customer: false,
      supplier: false,
      product: false
    })

    // Negotiated, granted customers.create only (fast path: same catalog revision).
    bootstrapSnapshot.persistSnapshot(
      desktopBootstrapFixture({
        permissions: ['pos.view', 'customers.create'],
        quick_create: { version: 1 }
      }),
      '2026-01-01T00:02:00+00:00',
      { permissionsOwnerUserUuid: CASHIER_A }
    )
    deepEqual(access.access(), { available: true, customer: true, supplier: false, product: false })
    equal(bootstrapSnapshot.getCapabilityVersion('quick_create'), 1)
    equal(bootstrapSnapshot.getPermissionsOwnerUserUuid(), CASHIER_A)

    // Cashier B signs in on the same workstation: A's cached grant never authorizes B.
    sessionUser = CASHIER_B
    deepEqual(access.access(), {
      available: false,
      customer: false,
      supplier: false,
      product: false
    })
    throws(() => access.assertCanCreate('customer'), { backendCode: 'PERMISSION_DENIED' })

    // B's own bootstrap (no grant) replaces the cache and its owner.
    bootstrapSnapshot.persistSnapshot(
      desktopBootstrapFixture({ permissions: ['pos.view'], quick_create: { version: 1 } }),
      '2026-01-01T00:03:00+00:00',
      { permissionsOwnerUserUuid: CASHIER_B }
    )
    deepEqual(access.access(), {
      available: true,
      customer: false,
      supplier: false,
      product: false
    })

    // A later bootstrap from a server that lost the capability clears it again.
    bootstrapSnapshot.persistSnapshot(
      desktopBootstrapFixture({ permissions: ['pos.view', 'customers.manage'] }),
      '2026-01-01T00:04:00+00:00',
      { permissionsOwnerUserUuid: CASHIER_B }
    )
    equal(bootstrapSnapshot.getCapabilityVersion('quick_create'), null)
    equal(access.access().customer, false)
    database.close()
  }
)
