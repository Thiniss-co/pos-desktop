import { createHash } from 'node:crypto'
import { deepEqual, equal, ok } from 'node:assert/strict'
import { closeDatabase, type SqliteDatabase } from '../../../src/main/database/connection'
import { databaseMigrations } from '../../../src/main/database/migrations'
import { InvoiceDispositionDiscoveryService } from '../../../src/main/services/invoiceDispositionDiscovery.service'
import { invoiceRequestHash } from '../../../src/main/services/invoiceRequestHash'
import { realRepositories } from '../support/realRepositories'
import { databaseTest } from '../support/sandbox'
import { openExistingTestDatabase, runTestMigrations } from '../support/openTestDatabase'
import {
  COMPANY_UUID,
  DEVICE_UUID,
  HASH_64,
  NOW,
  WAREHOUSE_UUID,
  insertRow
} from '../support/allocationScenario'

const INVOICE_UUID = '00000000-0000-4000-8000-0000000009a1'
const ATTEMPT_KEY = '00000000-0000-4000-8000-0000000009a2'
const ITEM_UUID = '00000000-0000-4000-8000-0000000009a3'
const QUEUE_UUID = '00000000-0000-4000-8000-0000000009a4'
const AUTHORITY_UUID = '00000000-0000-4000-8000-0000000009a5'
const ALLOCATION_UUID = '00000000-0000-4000-8000-0000000009a6'
const CONSUMPTION_UUID = '00000000-0000-4000-8000-0000000009a7'
const PRODUCT_UUID = '00000000-0000-4000-8000-000000000b01'
const OWNER = { companyUuid: COMPANY_UUID, deviceUuid: DEVICE_UUID }

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** The frozen v3 payload of a sale whose attached proof the server refused. */
function frozenPayload(): Record<string, unknown> {
  return {
    idempotency_key: INVOICE_UUID,
    local_invoice_uuid: INVOICE_UUID,
    catalog_revision: HASH_64,
    offline_number: 'POS-000001-20260906-0009a1',
    sold_at: NOW,
    sold_while_offline: true,
    customer_uuid: null,
    currency: 'USD',
    tax_mode: 'none',
    client_contract_version: 3,
    shift_uuid: COMPANY_UUID,
    offline_sale_authority_uuid: AUTHORITY_UUID,
    items: [
      {
        product_uuid: PRODUCT_UUID,
        barcode: null,
        quantity: '12.000',
        unit_price_amount: 1000,
        currency: 'USD',
        price_revision: HASH_64,
        tax_id: null,
        tax_mode: 'none',
        tax_rate_basis_points: 0,
        tax_revision: HASH_64,
        discount_type: null,
        discount_value: 0,
        stock_authorization: 'mixed',
        allocations: [
          {
            allocation_uuid: ALLOCATION_UUID,
            rights_generation: 1,
            consumption_sequence: 4,
            local_consumption_uuid: CONSUMPTION_UUID,
            quantity_milli: 5000
          }
        ]
      }
    ],
    invoice_discount: { type: null, value: 0 },
    payments: [
      {
        payment_method_uuid: COMPANY_UUID,
        type: 'cash',
        amount: 12000,
        reference: null,
        paid_at: NOW
      }
    ],
    notes: null
  }
}

/** Seed one rejected, quarantined v3 invoice with its queue row and its local consumption journal. */
function seedRejectedInvoice(
  database: SqliteDatabase,
  overrides: { readonly quarantineReason?: string; readonly backendCode?: string } = {}
): { payloadJson: string; payloadHash: string } {
  insertRow(database, 'offline_sale_authorities', {
    authority_uuid: AUTHORITY_UUID,
    company_uuid: COMPANY_UUID,
    device_uuid: DEVICE_UUID,
    mode: 'physical_presence',
    policy_revision: 1,
    contract_version: 3,
    issued_at: NOW,
    not_before: NOW,
    not_after: '2099-01-01T00:00:00.000Z',
    authority_hash: HASH_64,
    observed_at: NOW,
    created_at: NOW
  })

  insertRow(database, 'sale_attempts', {
    attempt_key: ATTEMPT_KEY,
    company_uuid: COMPANY_UUID,
    device_uuid: DEVICE_UUID,
    user_uuid: COMPANY_UUID,
    claim_session_epoch: 1,
    origin_shift_uuid: COMPANY_UUID,
    origin_shift_observed_at: NOW,
    origin_branch_uuid: COMPANY_UUID,
    origin_warehouse_uuid: WAREHOUSE_UUID,
    origin_context_fingerprint: HASH_64,
    intent_fingerprint: HASH_64,
    intent_version: 1,
    intent_json: '{"v":1}',
    state: 'claimed',
    claimed_at: NOW,
    updated_at: NOW
  })

  insertRow(database, 'local_invoices', {
    local_uuid: INVOICE_UUID,
    attempt_key: ATTEMPT_KEY,
    offline_number: 'POS-000001-20260906-0009a1',
    sync_status: 'rejected',
    sync_attempts: 1,
    company_uuid: COMPANY_UUID,
    branch_uuid: COMPANY_UUID,
    warehouse_uuid: WAREHOUSE_UUID,
    device_uuid: DEVICE_UUID,
    user_uuid: COMPANY_UUID,
    shift_uuid: COMPANY_UUID,
    commit_session_epoch: 1,
    catalog_revision: HASH_64,
    intent_fingerprint: HASH_64,
    currency: 'USD',
    currency_exponent: 2,
    tax_mode: 'none',
    invoice_discount_value: 0,
    subtotal_amount: 12000,
    discount_total_amount: 0,
    tax_total_amount: 0,
    grand_total_amount: 12000,
    paid_total_amount: 12000,
    change_due_amount: 0,
    due_amount: 0,
    sold_at: NOW,
    connectivity_state_at_sale: 'offline',
    sold_while_offline: 1,
    commercial_snapshot_json: '{}',
    upload_payload_version: 3,
    offline_sale_authority_uuid: AUTHORITY_UUID,
    stock_authorization_policy: 'physical_presence',
    created_at: NOW,
    updated_at: NOW
  })

  insertRow(database, 'local_invoice_items', {
    local_uuid: ITEM_UUID,
    invoice_local_uuid: INVOICE_UUID,
    line_index: 0,
    product_uuid: PRODUCT_UUID,
    product_name: 'Widget',
    track_stock: 1,
    quantity_milli: 12000,
    unit_price_amount: 1000,
    currency: 'USD',
    price_revision: HASH_64,
    tax_mode: 'none',
    tax_rate_basis_points: 0,
    tax_revision: HASH_64,
    discount_value: 0,
    subtotal_amount: 12000,
    discount_amount: 0,
    tax_amount: 0,
    total_amount: 12000,
    allocation_covered_milli: 5000,
    uncovered_milli: 7000,
    created_at: NOW
  })

  const payload = frozenPayload()
  const payloadJson = JSON.stringify(payload)
  const payloadHash = sha256(payloadJson)

  insertRow(database, 'sync_queue', {
    local_queue_uuid: QUEUE_UUID,
    aggregate_type: 'invoice',
    local_aggregate_uuid: INVOICE_UUID,
    operation: 'upload',
    payload_json: payloadJson,
    payload_hash: payloadHash,
    idempotency_key: INVOICE_UUID,
    state: 'rejected',
    attempt_count: 1,
    last_error_code: overrides.backendCode ?? 'DESKTOP_INVOICE_QUARANTINED',
    last_error_details: JSON.stringify({
      backendCode: overrides.backendCode ?? 'DESKTOP_INVOICE_QUARANTINED',
      httpStatus: 422,
      quarantineReason: overrides.quarantineReason ?? 'allocation_sequence_gap',
      message: 'quarantined'
    }),
    created_at: NOW,
    updated_at: NOW
  })

  return { payloadJson, payloadHash }
}

/** A well-formed authoritative decision for the seeded invoice. */
function envelope(
  payloadJson: string,
  overrides: {
    readonly decision?: 'accept_without_proof' | 'reject_permanently'
    readonly mutateResult?: (result: Record<string, unknown>) => void
    readonly breakHash?: boolean
  } = {}
): Record<string, unknown> {
  const decision = overrides.decision ?? 'accept_without_proof'
  const result: Record<string, unknown> = {
    version: 1,
    decision,
    decided_at: NOW,
    binding: {
      idempotency_key: INVOICE_UUID,
      local_invoice_uuid: INVOICE_UUID,
      request_hash: invoiceRequestHash(JSON.parse(payloadJson)),
      client_contract_version: 3,
      offline_sale_authority_uuid: AUTHORITY_UUID
    },
    invoice:
      decision === 'accept_without_proof'
        ? { invoice_uuid: '00000000-0000-4000-8000-0000000009b1', server_number: 'INV-1' }
        : null,
    proof_results: [
      {
        line_index: 0,
        proof_index: 0,
        allocation_uuid: ALLOCATION_UUID,
        rights_generation: 1,
        consumption_sequence: 4,
        local_consumption_uuid: CONSUMPTION_UUID,
        item_line_uuid: '00000000-0000-4000-8000-0000000009c1',
        quantity_milli: 5000,
        request_hash: invoiceRequestHash(JSON.parse(payloadJson)),
        outcome: 'overridden',
        server_consumption_uuid: null,
        override_reason:
          decision === 'reject_permanently' ? 'permanent_rejection' : 'allocation_sequence_gap'
      }
    ],
    coverage: [],
    required_holds: [
      {
        allocation_uuid: ALLOCATION_UUID,
        rights_generation: 1,
        first_overridden_sequence: 4,
        reason: 'invoice_disposition_chain_break',
        release_allowed: false
      }
    ]
  }

  overrides.mutateResult?.(result)

  return {
    id: '00000000-0000-4000-8000-0000000009d1',
    decision,
    decided_at: NOW,
    result_version: 1,
    result_hash: overrides.breakHash ? HASH_64 : sha256(JSON.stringify(result)),
    result
  }
}

function migrated(sandbox: Parameters<Parameters<typeof databaseTest>[1]>[0]): SqliteDatabase {
  const database = openExistingTestDatabase(sandbox)
  runTestMigrations(database, databaseMigrations)

  return database
}

databaseTest('PS6b a quarantined v3 invoice is an exact candidate', (sandbox) => {
  const database = migrated(sandbox)
  seedRejectedInvoice(database)

  const candidates = new InvoiceDispositionDiscoveryService({ database }).findCandidates(OWNER)

  equal(candidates.length, 1)
  equal(candidates[0].invoiceLocalUuid, INVOICE_UUID)
  equal(candidates[0].quarantineReason, 'allocation_sequence_gap')
  closeDatabase(database)
})

databaseTest('PS6b candidate selection excludes every ineligible failure', (sandbox) => {
  // §7.3a.5: an allowlist, not "everything terminal". Each of these is a row the operator
  // disposition path must never touch.
  for (const overrides of [
    { backendCode: 'DESKTOP_ALLOCATION_PROOF_REQUIRED' },
    { backendCode: 'DESKTOP_OFFLINE_SALE_AUTHORITY_INVALID' },
    { backendCode: 'VALIDATION_ERROR' },
    { backendCode: 'IDEMPOTENCY_CONFLICT' },
    { quarantineReason: 'catalog_window_violation' },
    { quarantineReason: 'something_invented_later' }
  ]) {
    const database = migrated(sandbox)
    seedRejectedInvoice(database, overrides)

    const candidates = new InvoiceDispositionDiscoveryService({ database }).findCandidates(OWNER)

    equal(candidates.length, 0, `expected no candidate for ${JSON.stringify(overrides)}`)
    database.exec(
      'DELETE FROM sync_queue; DELETE FROM local_invoice_items; DELETE FROM local_invoices; DELETE FROM sale_attempts; DELETE FROM offline_sale_authorities;'
    )
    closeDatabase(database)
  }
})

databaseTest('PS6b a verified acceptance converges exactly once', (sandbox) => {
  const database = migrated(sandbox)
  const { payloadJson } = seedRejectedInvoice(database)
  const service = new InvoiceDispositionDiscoveryService({ database })
  const [candidate] = service.findCandidates(OWNER)

  const first = service.apply(OWNER, candidate, {
    idempotency_key: INVOICE_UUID,
    status: 'processed',
    disposition: envelope(payloadJson)
  } as never)

  equal(first.kind, 'applied')

  const invoice = database
    .prepare('SELECT sync_status, remote_uuid FROM local_invoices WHERE local_uuid = ?')
    .get(INVOICE_UUID) as { sync_status: string; remote_uuid: string }
  equal(invoice.sync_status, 'synced')
  equal(invoice.remote_uuid, '00000000-0000-4000-8000-0000000009b1')
  equal(
    (
      database
        .prepare('SELECT state FROM sync_queue WHERE local_queue_uuid = ?')
        .get(QUEUE_UUID) as {
        state: string
      }
    ).state,
    'synced'
  )

  // The durable deny-spend hold exists and is structurally unreleasable.
  const hold = database
    .prepare('SELECT * FROM stock_allocation_disposition_holds WHERE allocation_uuid = ?')
    .get(ALLOCATION_UUID) as { release_allowed: number; first_overridden_sequence: number }
  equal(hold.release_allowed, 0)
  equal(hold.first_overridden_sequence, 4)

  // Re-running discovery finds nothing, and a repeated apply is a no-op rather than a second effect.
  equal(service.findCandidates(OWNER).length, 0)
  const second = service.apply(OWNER, candidate, {
    idempotency_key: INVOICE_UUID,
    status: 'processed',
    disposition: envelope(payloadJson)
  } as never)
  equal(second.kind, 'noop')
  equal(
    (
      database.prepare('SELECT COUNT(*) AS n FROM invoice_disposition_applications').get() as {
        n: number
      }
    ).n,
    1
  )

  closeDatabase(database)
})

databaseTest(
  'PS6b a permanent rejection commits nothing and still holds the identity',
  (sandbox) => {
    const database = migrated(sandbox)
    const { payloadJson } = seedRejectedInvoice(database)
    const service = new InvoiceDispositionDiscoveryService({ database })
    const [candidate] = service.findCandidates(OWNER)

    const outcome = service.apply(OWNER, candidate, {
      idempotency_key: INVOICE_UUID,
      status: 'quarantined',
      disposition: envelope(payloadJson, { decision: 'reject_permanently' })
    } as never)

    equal(outcome.kind, 'applied')

    // The record stays visibly blocked: the sale was not committed.
    equal(
      (
        database
          .prepare('SELECT sync_status FROM local_invoices WHERE local_uuid = ?')
          .get(INVOICE_UUID) as {
          sync_status: string
        }
      ).sync_status,
      'rejected'
    )
    equal(
      (
        database
          .prepare('SELECT state FROM sync_queue WHERE local_queue_uuid = ?')
          .get(QUEUE_UUID) as {
          state: string
        }
      ).state,
      'rejected'
    )
    // ...and the hold is installed anyway: later local sequences still depend on journal entries the
    // server will never accept.
    ok(
      database
        .prepare('SELECT 1 FROM stock_allocation_disposition_holds WHERE allocation_uuid = ?')
        .get(ALLOCATION_UUID)
    )

    closeDatabase(database)
  }
)

databaseTest(
  'PS6b every verification failure records a conflict and applies nothing',
  (sandbox) => {
    const cases: Array<[string, Parameters<typeof envelope>[1]]> = [
      ['result-hash-mismatch', { breakHash: true }],
      [
        'binding-mismatch',
        {
          mutateResult: (result) => {
            ;(result.binding as Record<string, unknown>).idempotency_key = 'someone-elses-key'
          }
        }
      ],
      [
        'payload-hash-mismatch',
        {
          mutateResult: (result) => {
            ;(result.binding as Record<string, unknown>).request_hash = 'b'.repeat(64)
          }
        }
      ],
      [
        'proof-set-mismatch',
        {
          mutateResult: (result) => {
            ;(result.proof_results as unknown[]).push({
              ...(result.proof_results as Record<string, unknown>[])[0],
              proof_index: 1
            })
          }
        }
      ],
      [
        'hold-instruction-mismatch',
        {
          mutateResult: (result) => {
            result.required_holds = []
          }
        }
      ],
      [
        'rejection-contains-accepted-proof',
        {
          decision: 'reject_permanently',
          mutateResult: (result) => {
            const proof = (result.proof_results as Record<string, unknown>[])[0]
            proof.outcome = 'accepted'
            proof.server_consumption_uuid = '00000000-0000-4000-8000-0000000009e1'
            proof.override_reason = null
          }
        }
      ]
    ]

    for (const [expectedCode, overrides] of cases) {
      const database = migrated(sandbox)
      const { payloadJson } = seedRejectedInvoice(database)
      const service = new InvoiceDispositionDiscoveryService({ database })
      const [candidate] = service.findCandidates(OWNER)

      const outcome = service.apply(OWNER, candidate, {
        idempotency_key: INVOICE_UUID,
        status: 'processed',
        disposition: envelope(payloadJson, overrides)
      } as never)

      equal(outcome.kind, 'conflict', `expected a conflict for ${expectedCode}`)
      equal((outcome as { code: string }).code, expectedCode)

      // NOTHING was applied: no application row, no hold, no state change on either side.
      equal(
        (
          database.prepare('SELECT COUNT(*) AS n FROM invoice_disposition_applications').get() as {
            n: number
          }
        ).n,
        0
      )
      equal(
        (
          database
            .prepare('SELECT COUNT(*) AS n FROM stock_allocation_disposition_holds')
            .get() as {
            n: number
          }
        ).n,
        0
      )
      equal(
        (
          database
            .prepare('SELECT sync_status FROM local_invoices WHERE local_uuid = ?')
            .get(INVOICE_UUID) as {
            sync_status: string
          }
        ).sync_status,
        'rejected'
      )

      database.exec(
        'DELETE FROM invoice_disposition_conflicts; DELETE FROM sync_queue; DELETE FROM local_invoice_items; DELETE FROM local_invoices; DELETE FROM sale_attempts; DELETE FROM offline_sale_authorities;'
      )
      closeDatabase(database)
    }
  }
)

databaseTest('PS6b a conflicting second decision never overwrites the first', (sandbox) => {
  const database = migrated(sandbox)
  const { payloadJson } = seedRejectedInvoice(database)
  const service = new InvoiceDispositionDiscoveryService({ database })
  const [candidate] = service.findCandidates(OWNER)

  service.apply(OWNER, candidate, {
    idempotency_key: INVOICE_UUID,
    status: 'processed',
    disposition: envelope(payloadJson)
  } as never)

  const different = envelope(payloadJson)
  ;(different as Record<string, unknown>).id = '00000000-0000-4000-8000-0000000009d2'

  const outcome = service.apply(OWNER, candidate, {
    idempotency_key: INVOICE_UUID,
    status: 'processed',
    disposition: different
  } as never)

  equal(outcome.kind, 'conflict')
  equal((outcome as { code: string }).code, 'conflicting-disposition')
  equal(
    (
      database.prepare('SELECT disposition_uuid FROM invoice_disposition_applications').get() as {
        disposition_uuid: string
      }
    ).disposition_uuid,
    '00000000-0000-4000-8000-0000000009d1'
  )

  closeDatabase(database)
})

databaseTest(
  'PS6b the overridden consumption stays counted and its grant becomes unspendable',
  (sandbox) => {
    // The conservation property of the whole checkpoint (review finding T1). The local journal row
    // is untouched and still counts; the identity is denied through an INDEPENDENT hold rather than
    // by relabelling the journal.
    const database = migrated(sandbox)
    const { payloadJson } = seedRejectedInvoice(database)

    insertRow(database, 'stock_allocation_grants', {
      allocation_uuid: ALLOCATION_UUID,
      contract_version: 1,
      company_uuid: COMPANY_UUID,
      device_uuid: DEVICE_UUID,
      warehouse_uuid: WAREHOUSE_UUID,
      product_uuid: PRODUCT_UUID,
      server_sequence: 1,
      rights_generation: 1,
      lifecycle_generation: 1,
      granted_quantity_milli: 10000,
      server_consumed_quantity_milli: 0,
      consume_until: '2099-01-01T00:00:00.000Z',
      status: 'active',
      envelope_hash: HASH_64,
      received_at: NOW,
      updated_at: NOW
    })

    insertRow(database, 'local_stock_allocation_consumptions', {
      local_uuid: CONSUMPTION_UUID,
      allocation_uuid: ALLOCATION_UUID,
      consumption_sequence: 4,
      invoice_local_uuid: INVOICE_UUID,
      item_local_uuid: ITEM_UUID,
      quantity_milli: 5000,
      server_status: 'pending',
      created_at: NOW
    })

    const service = new InvoiceDispositionDiscoveryService({ database })
    const [candidate] = service.findCandidates(OWNER)
    service.apply(OWNER, candidate, {
      idempotency_key: INVOICE_UUID,
      status: 'processed',
      disposition: envelope(payloadJson)
    } as never)

    // The journal row is BYTE-IDENTICAL: not relabelled, not deleted, still `pending` evidence.
    const consumption = database
      .prepare(
        'SELECT server_status, quantity_milli FROM local_stock_allocation_consumptions WHERE local_uuid = ?'
      )
      .get(CONSUMPTION_UUID) as { server_status: string; quantity_milli: number }
    equal(consumption.server_status, 'pending')
    equal(consumption.quantity_milli, 5000)

    const allocations = realRepositories(database).stockAllocations

    // Denied on BOTH paths: spendability and grant selection.
    equal(allocations.spendableMilli(ALLOCATION_UUID), 0)
    deepEqual(
      allocations.usableGrantsForProduct(
        { companyUuid: COMPANY_UUID, deviceUuid: DEVICE_UUID, warehouseUuid: WAREHOUSE_UUID },
        PRODUCT_UUID,
        NOW
      ),
      []
    )
    ok(allocations.hasDispositionHold(ALLOCATION_UUID, 1))

    closeDatabase(database)
  }
)
