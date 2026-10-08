import { createHash } from 'node:crypto'
import { deepEqual, equal, ok } from 'node:assert/strict'
import { closeDatabase, type SqliteDatabase } from '../../../src/main/database/connection'
import { databaseMigrations } from '../../../src/main/database/migrations'
import {
  InvoiceDispositionDiscoveryService,
  phpJsonEncode
} from '../../../src/main/services/invoiceDispositionDiscovery.service'
import { allocationItemLineUuid } from '../../../src/main/services/allocationJournal'
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
  overrides: {
    readonly quarantineReason?: string
    readonly backendCode?: string
    readonly mutatePayload?: (payload: Record<string, unknown>) => void
  } = {}
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

  // The sale's own immutable journal row for the frozen proof (allocation, sequence, quantity).
  insertRow(database, 'local_stock_allocation_consumptions', {
    local_uuid: CONSUMPTION_UUID,
    allocation_uuid: ALLOCATION_UUID,
    consumption_sequence: 4,
    invoice_local_uuid: INVOICE_UUID,
    item_local_uuid: ITEM_UUID,
    quantity_milli: 5000,
    server_status: 'pending',
    rights_generation: 1,
    invoice_idempotency_key: INVOICE_UUID,
    item_line_uuid: allocationItemLineUuid(INVOICE_UUID, 0),
    created_at: NOW
  })

  const payload = frozenPayload()
  overrides.mutatePayload?.(payload)
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
        ? {
            invoice_uuid: '00000000-0000-4000-8000-0000000009b1',
            server_number: 'POS-20260906-0001'
          }
        : null,
    proof_results: [
      {
        line_index: 0,
        proof_index: 0,
        allocation_uuid: ALLOCATION_UUID,
        rights_generation: 1,
        consumption_sequence: 4,
        local_consumption_uuid: CONSUMPTION_UUID,
        item_line_uuid: allocationItemLineUuid(INVOICE_UUID, 0),
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
    // The backend hashes PHP `json_encode` output of its in-memory result.
    result_hash: overrides.breakHash ? HASH_64 : sha256(phpJsonEncode(result)),
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
    // PS9: an invoice whose historical stock-tracking evidence never existed. No operator
    // disposition may paper that over, so it must never become a candidate — and the closed
    // allowlist is what guarantees that without anyone remembering to exclude it.
    { backendCode: 'DESKTOP_HISTORICAL_STOCK_TRACKING_UNVERIFIABLE' },
    { quarantineReason: 'catalog_window_violation' },
    { quarantineReason: 'something_invented_later' }
  ]) {
    const database = migrated(sandbox)
    seedRejectedInvoice(database, overrides)

    const candidates = new InvoiceDispositionDiscoveryService({ database }).findCandidates(OWNER)

    equal(candidates.length, 0, `expected no candidate for ${JSON.stringify(overrides)}`)
    database.exec(
      'DELETE FROM sync_queue; DELETE FROM local_stock_allocation_consumptions; DELETE FROM stock_allocation_grants; DELETE FROM local_invoice_items; DELETE FROM local_invoices; DELETE FROM sale_attempts; DELETE FROM offline_sale_authorities;'
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
        status: overrides?.decision === 'reject_permanently' ? 'quarantined' : 'processed',
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
        'DELETE FROM invoice_disposition_conflicts; DELETE FROM sync_queue; DELETE FROM local_stock_allocation_consumptions; DELETE FROM stock_allocation_grants; DELETE FROM local_invoice_items; DELETE FROM local_invoices; DELETE FROM sale_attempts; DELETE FROM offline_sale_authorities;'
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

// ---------------------------------------------------------------------------------------------
// The backend's actual result shape (DispositionProofEvaluator / DisposeQuarantinedInvoiceAction)
// ---------------------------------------------------------------------------------------------

const ALLOCATION_B_UUID = '00000000-0000-4000-8000-0000000009b6'
const ITEM_2_UUID = '00000000-0000-4000-8000-0000000009b3'
const ITEM_3_UUID = '00000000-0000-4000-8000-0000000009b4'
const CONSUMPTION_B_UUID = '00000000-0000-4000-8000-0000000009b7'
const CONSUMPTION_A5_UUID = '00000000-0000-4000-8000-0000000009b8'

function line(allocation: Record<string, unknown>): Record<string, unknown> {
  const base = (frozenPayload().items as Record<string, unknown>[])[0]

  return { ...base, quantity: '2.000', allocations: [allocation] }
}

/**
 * Three lines on two allocation identities, interleaved: line 0 → A#4, line 1 → B#1, line 2 → A#5.
 * The backend enumerates proofs grouped by identity in first-appearance order and sorted by sequence
 * within it — A#4 (line 0), A#5 (line 2), B#1 (line 1) — which is NOT the frozen line order.
 */
function seedInterleavedInvoice(database: SqliteDatabase): { payloadJson: string } {
  const seeded = seedRejectedInvoice(database, {
    quarantineReason: 'allocation_insufficient_rights',
    mutatePayload: (payload) => {
      const items = payload.items as Record<string, unknown>[]
      items.push(
        line({
          allocation_uuid: ALLOCATION_B_UUID,
          rights_generation: 1,
          consumption_sequence: 1,
          local_consumption_uuid: CONSUMPTION_B_UUID,
          quantity_milli: 2000
        }),
        line({
          allocation_uuid: ALLOCATION_UUID,
          rights_generation: 1,
          consumption_sequence: 5,
          local_consumption_uuid: CONSUMPTION_A5_UUID,
          quantity_milli: 2000
        })
      )
    }
  })

  insertRow(database, 'stock_allocation_grants', {
    allocation_uuid: ALLOCATION_B_UUID,
    contract_version: 1,
    company_uuid: COMPANY_UUID,
    device_uuid: DEVICE_UUID,
    warehouse_uuid: WAREHOUSE_UUID,
    product_uuid: PRODUCT_UUID,
    server_sequence: 2,
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

  for (const [index, itemUuid] of [
    [1, ITEM_2_UUID],
    [2, ITEM_3_UUID]
  ] as const) {
    insertRow(database, 'local_invoice_items', {
      local_uuid: itemUuid,
      invoice_local_uuid: INVOICE_UUID,
      line_index: index,
      product_uuid: PRODUCT_UUID,
      product_name: 'Widget',
      track_stock: 1,
      quantity_milli: 2000,
      unit_price_amount: 1000,
      currency: 'USD',
      price_revision: HASH_64,
      tax_mode: 'none',
      tax_rate_basis_points: 0,
      tax_revision: HASH_64,
      discount_value: 0,
      subtotal_amount: 2000,
      discount_amount: 0,
      tax_amount: 0,
      total_amount: 2000,
      allocation_covered_milli: 2000,
      uncovered_milli: 0,
      created_at: NOW
    })
  }

  for (const [uuid, allocation, sequence, item, lineIndex] of [
    [CONSUMPTION_B_UUID, ALLOCATION_B_UUID, 1, ITEM_2_UUID, 1],
    [CONSUMPTION_A5_UUID, ALLOCATION_UUID, 5, ITEM_3_UUID, 2]
  ] as const) {
    insertRow(database, 'local_stock_allocation_consumptions', {
      local_uuid: uuid,
      allocation_uuid: allocation,
      consumption_sequence: sequence,
      invoice_local_uuid: INVOICE_UUID,
      item_local_uuid: item,
      quantity_milli: 2000,
      server_status: 'pending',
      rights_generation: 1,
      invoice_idempotency_key: INVOICE_UUID,
      item_line_uuid: allocationItemLineUuid(INVOICE_UUID, lineIndex),
      created_at: NOW
    })
  }

  return { payloadJson: seeded.payloadJson }
}

/**
 * The decision the backend stores for the interleaved invoice when A#5 exceeds the remaining rights:
 * A#4 and B#1 accepted with `server_consumption_uuid: null` (the evaluator never fills it in), A#5
 * overridden; coverage for A (through 4) and B (through 1); one hold for A from sequence 5.
 */
function interleavedResult(payloadJson: string): Record<string, unknown> {
  const requestHash = invoiceRequestHash(JSON.parse(payloadJson))
  const proof = (
    lineIndex: number,
    allocation: string,
    sequence: number,
    consumption: string,
    quantity: number,
    outcome: 'accepted' | 'overridden',
    reason: string | null
  ): Record<string, unknown> => ({
    line_index: lineIndex,
    proof_index: 0,
    allocation_uuid: allocation,
    rights_generation: 1,
    consumption_sequence: sequence,
    local_consumption_uuid: consumption,
    item_line_uuid: allocationItemLineUuid(INVOICE_UUID, lineIndex),
    quantity_milli: quantity,
    request_hash: requestHash,
    outcome,
    server_consumption_uuid: null,
    override_reason: reason
  })

  return {
    version: 1,
    decision: 'accept_without_proof',
    decided_at: '2026-09-06T10:00:00+00:00',
    binding: {
      idempotency_key: INVOICE_UUID,
      local_invoice_uuid: INVOICE_UUID,
      request_hash: requestHash,
      client_contract_version: 3,
      offline_sale_authority_uuid: AUTHORITY_UUID
    },
    invoice: {
      invoice_uuid: '00000000-0000-4000-8000-0000000009b1',
      server_number: 'POS/2026/0001'
    },
    proof_results: [
      proof(0, ALLOCATION_UUID, 4, CONSUMPTION_UUID, 5000, 'accepted', null),
      proof(
        2,
        ALLOCATION_UUID,
        5,
        CONSUMPTION_A5_UUID,
        2000,
        'overridden',
        'allocation_insufficient_rights'
      ),
      proof(1, ALLOCATION_B_UUID, 1, CONSUMPTION_B_UUID, 2000, 'accepted', null)
    ],
    coverage: [
      {
        allocation_uuid: ALLOCATION_UUID,
        rights_generation: 1,
        accepted_consumption_sequence: 4,
        accepted_consumed_quantity_milli: 5000,
        accepted_chain_hash: null
      },
      {
        allocation_uuid: ALLOCATION_B_UUID,
        rights_generation: 1,
        accepted_consumption_sequence: 1,
        accepted_consumed_quantity_milli: 2000,
        accepted_chain_hash: null
      }
    ],
    required_holds: [
      {
        allocation_uuid: ALLOCATION_UUID,
        rights_generation: 1,
        first_overridden_sequence: 5,
        reason: 'invoice_disposition_chain_break',
        release_allowed: false
      }
    ]
  }
}

/** Recursively re-sorts object keys the way a MySQL JSON column returns them (length, then bytes). */
function mysqlKeyOrder(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(mysqlKeyOrder)
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.length - right.length || (left < right ? -1 : 1))
        .map(([key, nested]) => [key, mysqlKeyOrder(nested)])
    )
  }

  return value
}

function interleavedEntry(
  result: Record<string, unknown>,
  overrides: { readonly status?: string } = {}
): Record<string, unknown> {
  // Hashed over the backend's insertion order, then served in MySQL's order.
  const resultHash = sha256(phpJsonEncode(result))

  return {
    idempotency_key: INVOICE_UUID,
    local_invoice_uuid: INVOICE_UUID,
    status: overrides.status ?? 'processed',
    client_contract_version: 3,
    quarantine_reason: 'allocation_insufficient_rights',
    quarantined_at: NOW,
    processed_at: NOW,
    invoice: result.invoice,
    disposition: {
      id: '00000000-0000-4000-8000-0000000009d1',
      decision: result.decision,
      decided_at: result.decided_at,
      result_version: 1,
      result_hash: resultHash,
      result: mysqlKeyOrder(result)
    }
  }
}

function count(database: SqliteDatabase, sql: string): number {
  return (database.prepare(sql).get() as { n: number }).n
}

databaseTest(
  "PS6b the backend's stored result converges: identity order, null server consumptions, MySQL key order",
  (sandbox) => {
    const database = migrated(sandbox)
    const { payloadJson } = seedInterleavedInvoice(database)
    const service = new InvoiceDispositionDiscoveryService({ database })
    const [candidate] = service.findCandidates(OWNER)
    const journalBefore = database
      .prepare('SELECT * FROM local_stock_allocation_consumptions ORDER BY local_uuid')
      .all()

    const outcome = service.apply(
      OWNER,
      candidate,
      interleavedEntry(interleavedResult(payloadJson)) as never
    )

    equal(outcome.kind, 'applied', JSON.stringify(outcome))

    const invoice = database
      .prepare('SELECT sync_status, remote_uuid, server_number FROM local_invoices')
      .get() as { sync_status: string; remote_uuid: string; server_number: string }
    deepEqual(invoice, {
      sync_status: 'synced',
      remote_uuid: '00000000-0000-4000-8000-0000000009b1',
      server_number: 'POS/2026/0001'
    })

    // One row per proof; accepted rows carry no server consumption, exactly as the backend sent.
    deepEqual(
      database
        .prepare(
          `SELECT line_index, outcome, server_consumption_uuid, override_reason
             FROM invoice_disposition_proof_results ORDER BY line_index`
        )
        .all(),
      [
        {
          line_index: 0,
          outcome: 'accepted',
          server_consumption_uuid: null,
          override_reason: null
        },
        {
          line_index: 1,
          outcome: 'accepted',
          server_consumption_uuid: null,
          override_reason: null
        },
        {
          line_index: 2,
          outcome: 'overridden',
          server_consumption_uuid: null,
          override_reason: 'allocation_insufficient_rights'
        }
      ]
    )

    // Only A is held, from its first overridden sequence; B stays spendable.
    deepEqual(
      database
        .prepare(
          'SELECT allocation_uuid, first_overridden_sequence FROM stock_allocation_disposition_holds'
        )
        .all(),
      [{ allocation_uuid: ALLOCATION_UUID, first_overridden_sequence: 5 }]
    )

    // The immutable journal is byte-identical: nothing acknowledged, relabelled or removed.
    deepEqual(
      database
        .prepare('SELECT * FROM local_stock_allocation_consumptions ORDER BY local_uuid')
        .all(),
      journalBefore
    )

    closeDatabase(database)
  }
)

databaseTest(
  'PS6b a result that disagrees with the backend shape is a conflict and applies nothing',
  (sandbox) => {
    const cases: Array<
      [
        string,
        (result: Record<string, unknown>) => void,
        { status?: string; dropJournal?: boolean }
      ]
    > = [
      // The decision says accepted, but the status read says the upload is still quarantined.
      ['binding-mismatch', () => undefined, { status: 'quarantined' }],
      // The frozen line order instead of the backend's identity order.
      [
        'proof-set-mismatch',
        (result) => {
          const proofs = result.proof_results as unknown[]
          result.proof_results = [proofs[0], proofs[2], proofs[1]]
        },
        {}
      ],
      // Coverage that does not equal the accepted prefix of this invoice.
      [
        'coverage-prefix-unverified',
        (result) => {
          ;(result.coverage as Record<string, unknown>[])[0].accepted_consumed_quantity_milli = 7000
        },
        {}
      ],
      // A frozen proof that is no longer this invoice's own journal row.
      ['proof-set-mismatch', () => undefined, { dropJournal: true }],
      // An accepted proof after the identity's prefix broke.
      [
        'coverage-prefix-unverified',
        (result) => {
          const proofs = result.proof_results as Record<string, unknown>[]
          proofs[0].outcome = 'overridden'
          proofs[0].override_reason = 'allocation_sequence_gap'
          proofs[1].outcome = 'accepted'
          proofs[1].override_reason = null
        },
        {}
      ]
    ]

    for (const [expectedCode, mutate, options] of cases) {
      const database = migrated(sandbox)
      const { payloadJson } = seedInterleavedInvoice(database)

      if (options.dropJournal) {
        database
          .prepare('DELETE FROM local_stock_allocation_consumptions WHERE local_uuid = ?')
          .run(CONSUMPTION_B_UUID)
      }

      const service = new InvoiceDispositionDiscoveryService({ database })
      const [candidate] = service.findCandidates(OWNER)
      const result = interleavedResult(payloadJson)
      mutate(result)

      const outcome = service.apply(
        OWNER,
        candidate,
        interleavedEntry(result, { status: options.status }) as never
      )

      equal(outcome.kind, 'conflict', `expected ${expectedCode}, got ${JSON.stringify(outcome)}`)
      equal((outcome as { code: string }).code, expectedCode)
      equal(count(database, 'SELECT COUNT(*) AS n FROM invoice_disposition_applications'), 0)
      equal(count(database, 'SELECT COUNT(*) AS n FROM stock_allocation_disposition_holds'), 0)
      equal(
        count(database, "SELECT COUNT(*) AS n FROM local_invoices WHERE sync_status = 'rejected'"),
        1
      )
      // The conflict is durable evidence and finalizes the row: discovery never asks again.
      equal(count(database, 'SELECT COUNT(*) AS n FROM invoice_disposition_conflicts'), 1)
      equal(service.findCandidates(OWNER).length, 0)
      database.exec(
        'DELETE FROM invoice_disposition_conflicts; DELETE FROM sync_queue; DELETE FROM local_stock_allocation_consumptions; DELETE FROM stock_allocation_grants; DELETE FROM local_invoice_items; DELETE FROM local_invoices; DELETE FROM sale_attempts; DELETE FROM offline_sale_authorities;'
      )
      closeDatabase(database)
    }
  }
)

databaseTest(
  'PS6b migration 0034 still forbids a server consumption on an overridden proof',
  (sandbox) => {
    const database = migrated(sandbox)
    seedRejectedInvoice(database)
    insertRow(database, 'invoice_disposition_applications', {
      invoice_local_uuid: INVOICE_UUID,
      disposition_uuid: '00000000-0000-4000-8000-0000000009d1',
      decision: 'reject_permanently',
      result_version: 1,
      result_json: '{}',
      result_hash: HASH_64,
      queue_failure_json: '{}',
      queue_failure_hash: HASH_64,
      request_hash: HASH_64,
      remote_invoice_uuid: null,
      applied_at: NOW
    })

    const insert = (outcome: string, server: string | null, reason: string | null): void => {
      database
        .prepare(
          `INSERT INTO invoice_disposition_proof_results (
             invoice_local_uuid, line_index, proof_index, allocation_uuid, rights_generation,
             consumption_sequence, local_consumption_uuid, quantity_milli, outcome,
             server_consumption_uuid, override_reason, created_at
           ) VALUES (?, ?, 0, ?, 1, 4, ?, 5000, ?, ?, ?, ?)`
        )
        .run(
          INVOICE_UUID,
          count(database, 'SELECT COUNT(*) AS n FROM invoice_disposition_proof_results'),
          ALLOCATION_UUID,
          CONSUMPTION_UUID,
          outcome,
          server,
          reason,
          NOW
        )
    }

    insert('accepted', null, null)
    insert('accepted', '00000000-0000-4000-8000-0000000009e1', null)
    let refused = false

    try {
      insert('overridden', '00000000-0000-4000-8000-0000000009e2', 'permanent_rejection')
    } catch {
      refused = true
    }

    ok(refused, 'an overridden proof with a server consumption must be refused')
    closeDatabase(database)
  }
)
