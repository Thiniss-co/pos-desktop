import { deepEqual, equal, ok, throws } from 'node:assert/strict'
import { closeDatabase } from '../../../src/main/database/connection'
import { databaseMigrations } from '../../../src/main/database/migrations'
import { invoiceRequestHash } from '../../../src/main/services/invoiceRequestHash'
import { databaseTest } from '../support/sandbox'
import { readCommitted } from '../support/committedState'
import {
  openPreOffersTestDatabase,
  openTestDatabase,
  runTestMigrations
} from '../support/openTestDatabase'
import { realRepositories } from '../support/realRepositories'
import {
  bootstrapResource,
  productUuid,
  setUpAuthorizedContext,
  validIntent
} from '../support/localSaleFixture'

/**
 * Owner expansion Phase E — register offers on a real SQLite database: the bootstrap `offers` block
 * is installed with the catalog (and replaced with it), a sale rung under an offer commits the
 * offer's discount and the offer itself, and its frozen upload is a v6 request carrying
 * `offer_revision_uuid` on that line only. A cart priced without the offer main sees is refused
 * with zero writes.
 */

const OFFER_UUID = 'abababab-abab-4bab-8bab-abababababab'

function offersBlock(
  productUuids: readonly string[] = [productUuid]
): NonNullable<ReturnType<typeof bootstrapResource>['offers']> {
  return {
    version: 1 as const,
    revisions: [
      {
        id: OFFER_UUID,
        name: 'Ten off water',
        type: 'percentage' as const,
        value: 1000,
        priority: 0,
        ordinal: 7,
        starts_at: '2026-01-01T00:00:00+00:00',
        ends_at: null,
        product_uuids: [...productUuids]
      }
    ]
  }
}

databaseTest(
  'Phase E: the bootstrap offers block installs with the catalog contract',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    try {
      const repositories = realRepositories(database)
      repositories.bootstrapSnapshot.persistSnapshot(
        bootstrapResource({ offers: offersBlock() }),
        '2026-01-01T00:01:00+00:00'
      )

      deepEqual(repositories.catalog.getContract()?.offers, [
        {
          revisionUuid: OFFER_UUID,
          name: 'Ten off water',
          type: 'percentage',
          value: 1000,
          priority: 0,
          ordinal: 7,
          startsAt: '2026-01-01T00:00:00.000Z',
          endsAt: null,
          productUuids: [productUuid]
        }
      ])

      // Re-applying the same catalog without the block (an older backend) leaves no offers.
      repositories.bootstrapSnapshot.persistSnapshot(
        bootstrapResource(),
        '2026-01-01T00:02:00+00:00'
      )
      equal(repositories.catalog.getContract()?.offers, undefined)
      deepEqual(readCommitted(sandbox, 'SELECT * FROM catalog_offer_products'), [])
    } finally {
      closeDatabase(database)
    }
  }
)

databaseTest(
  'Phase E: an offer targeting a product outside the contract refuses the catalog',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    try {
      const repositories = realRepositories(database)
      throws(
        () =>
          repositories.bootstrapSnapshot.persistSnapshot(
            bootstrapResource({ offers: offersBlock(['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee']) }),
            '2026-01-01T00:01:00+00:00'
          ),
        (error: unknown) =>
          (error as { backendCode?: string }).backendCode === 'CATALOG_OFFERS_INVALID'
      )
      equal(repositories.catalog.getContract(), null)
    } finally {
      closeDatabase(database)
    }
  }
)

databaseTest(
  'Phase E: a sale under an offer stores the offer and uploads as v6 with the offered line only',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    try {
      const repositories = realRepositories(database)
      repositories.bootstrapSnapshot.persistSnapshot(
        bootstrapResource({ offers: offersBlock() }),
        '2026-01-01T00:01:00+00:00'
      )
      const { localSale } = setUpAuthorizedContext(database, repositories)

      const outcome = localSale.complete(
        'f0000000-0000-4000-8000-0000000000e1',
        validIntent({
          items: [
            {
              id: 'item-1',
              productUuid,
              quantity: '1.000',
              discountType: null,
              discountValue: 0,
              offerRevisionUuid: OFFER_UUID
            },
            {
              // Same product with a manual discount: the manual discount replaces any offer.
              id: 'item-2',
              productUuid,
              quantity: '1.000',
              discountType: 'fixed',
              discountValue: 50
            }
          ],
          payments: [
            {
              id: 'payment-1',
              paymentMethodUuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              amount: 1850,
              reference: null
            }
          ]
        })
      )
      ok(outcome.outcome === 'committed', JSON.stringify(outcome))
      equal(outcome.invoice.grandTotalAmount, 1850)

      deepEqual(
        readCommitted(
          sandbox,
          'SELECT discount_type, discount_value, discount_amount, offer_revision_uuid, offer_name FROM local_invoice_items ORDER BY line_index'
        ),
        [
          {
            discount_type: 'percentage',
            discount_value: 1000,
            discount_amount: 100,
            offer_revision_uuid: OFFER_UUID,
            offer_name: 'Ten off water'
          },
          {
            discount_type: 'fixed',
            discount_value: 50,
            discount_amount: 50,
            offer_revision_uuid: null,
            offer_name: null
          }
        ]
      )

      const [queued] = readCommitted(
        sandbox,
        "SELECT payload_json FROM sync_queue WHERE aggregate_type = 'invoice'"
      ) as Array<{ payload_json: string }>
      const payload = JSON.parse(queued?.payload_json ?? '{}') as Record<string, unknown>
      const items = payload.items as Array<Record<string, unknown>>
      equal(payload.client_contract_version, 6)
      equal(items[0]?.offer_revision_uuid, OFFER_UUID)
      equal('offer_revision_uuid' in (items[1] ?? {}), false)
      ok(/^[a-f0-9]{64}$/.test(invoiceRequestHash(payload as never)))
    } finally {
      closeDatabase(database)
    }
  }
)

databaseTest(
  'Phase E: a cart priced without the live offer is refused with zero business writes',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    try {
      const repositories = realRepositories(database)
      repositories.bootstrapSnapshot.persistSnapshot(
        bootstrapResource({ offers: offersBlock() }),
        '2026-01-01T00:01:00+00:00'
      )
      const { localSale } = setUpAuthorizedContext(database, repositories)

      const outcome = localSale.complete('f0000000-0000-4000-8000-0000000000e2', validIntent())
      ok(outcome.outcome !== 'committed', JSON.stringify(outcome))
      equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 0)
      equal(readCommitted(sandbox, 'SELECT * FROM sync_queue').length, 0)
    } finally {
      closeDatabase(database)
    }
  }
)

databaseTest(
  'Phase E: migration 0032 on a populated pre-0032 database keeps every sale row and reads no offers',
  (sandbox) => {
    const database = openPreOffersTestDatabase(sandbox)
    try {
      const repositories = realRepositories(database)
      const { localSale } = setUpAuthorizedContext(database, repositories)
      ok(
        localSale.complete('f0000000-0000-4000-8000-0000000000e3', validIntent()).outcome ===
          'committed'
      )
      const before = readCommitted(sandbox, 'SELECT * FROM local_invoice_items ORDER BY 1')
      const queueBefore = readCommitted(sandbox, 'SELECT * FROM sync_queue ORDER BY 1')

      runTestMigrations(database, databaseMigrations)

      deepEqual(
        readCommitted(sandbox, 'SELECT * FROM local_invoice_items ORDER BY 1').map((row) => {
          const {
            offer_revision_uuid: offer,
            offer_name: name,
            ...rest
          } = row as Record<string, unknown>
          equal(offer, null)
          equal(name, null)
          return rest
        }),
        before
      )
      deepEqual(readCommitted(sandbox, 'SELECT * FROM sync_queue ORDER BY 1'), queueBefore)
      equal(realRepositories(database).catalog.getContract()?.offers, undefined)
      deepEqual(database.pragma('foreign_key_check'), [])
    } finally {
      closeDatabase(database)
    }
  }
)
