import { equal, ok, throws } from 'node:assert/strict'
import { closeDatabase } from '../../../src/main/database/connection'
import { databaseTest } from '../support/sandbox'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories } from '../support/realRepositories'

const UUID_A = '00000000-0000-4000-8000-000000000001'
const HASH_64 = 'a'.repeat(64)
const NOW = '2026-08-29T12:00:00.000Z'

databaseTest(
  'SaleAttemptRepository claims, commits, acknowledges, and blocks a second claim',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const owner = { companyUuid: UUID_A, deviceUuid: UUID_A, userUuid: UUID_A }

    const claimed = repositories.saleAttempts.claim({
      attemptKey: UUID_A,
      ...owner,
      claimSessionEpoch: 1,
      originShiftUuid: UUID_A,
      originShiftObservedAt: NOW,
      originBranchUuid: UUID_A,
      originWarehouseUuid: UUID_A,
      originContextFingerprint: HASH_64,
      intentFingerprint: HASH_64,
      intentVersion: 1,
      intentJson: '{"v":1}'
    })
    equal(claimed.state, 'claimed')

    ok(repositories.saleAttempts.findBlockingForOwner(owner) !== null)
    throws(() =>
      repositories.saleAttempts.claim({
        attemptKey: '00000000-0000-4000-8000-000000000002',
        ...owner,
        claimSessionEpoch: 1,
        originShiftUuid: UUID_A,
        originShiftObservedAt: NOW,
        originBranchUuid: UUID_A,
        originWarehouseUuid: UUID_A,
        originContextFingerprint: HASH_64,
        intentFingerprint: HASH_64,
        intentVersion: 1,
        intentJson: '{"v":1}'
      })
    )

    const invoice = repositories.localSale.insertInvoice({
      localUuid: UUID_A,
      attemptKey: UUID_A,
      offlineNumber: 'POS-000001-20260829-000001',
      companyUuid: UUID_A,
      branchUuid: UUID_A,
      warehouseUuid: UUID_A,
      deviceUuid: UUID_A,
      userUuid: UUID_A,
      shiftUuid: UUID_A,
      commitSessionEpoch: 1,
      catalogRevision: HASH_64,
      intentFingerprint: HASH_64,
      customerUuid: null,
      currency: 'USD',
      currencyExponent: 2,
      taxMode: 'none',
      invoiceDiscountType: null,
      invoiceDiscountValue: 0,
      subtotalAmount: 1000,
      discountTotalAmount: 0,
      taxTotalAmount: 0,
      grandTotalAmount: 1000,
      paidTotalAmount: 1000,
      changeDueAmount: 0,
      soldAt: NOW,
      connectivityStateAtSale: 'online',
      soldWhileOffline: false,
      notes: null,
      commercialSnapshotJson: '{}',
      createdAt: NOW
    })
    equal(invoice.localUuid, UUID_A)

    repositories.saleAttempts.markCommitted(UUID_A, invoice.localUuid, NOW)
    equal(repositories.saleAttempts.findBlockingForOwner(owner), null)

    const committed = repositories.saleAttempts.findByKeyForOwner(UUID_A, owner)
    ok(
      committed !== null && committed.state === 'committed' && committed.invoiceLocalUuid === UUID_A
    )

    const unacknowledged = repositories.saleAttempts.listUnacknowledgedCommittedForOwner(
      owner,
      10,
      null
    )
    equal(unacknowledged.length, 1)

    repositories.saleAttempts.markAcknowledged(UUID_A, NOW)
    const acknowledged = repositories.saleAttempts.findByKeyForOwner(UUID_A, owner)
    ok(
      acknowledged !== null &&
        acknowledged.state === 'acknowledged' &&
        acknowledged.intentJson === null
    )

    closeDatabase(database)
  }
)

databaseTest(
  'SaleAttemptRepository rejects and abandons independently, purging intent_json',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const owner = { companyUuid: UUID_A, deviceUuid: UUID_A, userUuid: UUID_A }

    repositories.saleAttempts.claim({
      attemptKey: UUID_A,
      ...owner,
      claimSessionEpoch: 1,
      originShiftUuid: UUID_A,
      originShiftObservedAt: NOW,
      originBranchUuid: UUID_A,
      originWarehouseUuid: UUID_A,
      originContextFingerprint: HASH_64,
      intentFingerprint: HASH_64,
      intentVersion: 1,
      intentJson: '{"v":1}'
    })
    repositories.saleAttempts.markRejected(UUID_A, 'invalid-request', NOW)

    const rejected = repositories.saleAttempts.findByKeyForOwner(UUID_A, owner)
    ok(
      rejected !== null &&
        rejected.state === 'rejected' &&
        rejected.intentJson === null &&
        rejected.failureCode === 'invalid-request'
    )

    const secondKey = '00000000-0000-4000-8000-000000000003'
    repositories.saleAttempts.claim({
      attemptKey: secondKey,
      ...owner,
      claimSessionEpoch: 2,
      originShiftUuid: UUID_A,
      originShiftObservedAt: NOW,
      originBranchUuid: UUID_A,
      originWarehouseUuid: UUID_A,
      originContextFingerprint: HASH_64,
      intentFingerprint: HASH_64,
      intentVersion: 1,
      intentJson: '{"v":1}'
    })
    repositories.saleAttempts.markAbandoned(secondKey, NOW)
    const abandoned = repositories.saleAttempts.findByKeyForOwner(secondKey, owner)
    ok(abandoned !== null && abandoned.state === 'abandoned' && abandoned.intentJson === null)

    closeDatabase(database)
  }
)

databaseTest(
  'StockAllocationRepository computes remaining quantity from immutable rows only',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)

    repositories.saleAttempts.claim({
      attemptKey: UUID_A,
      companyUuid: UUID_A,
      deviceUuid: UUID_A,
      userUuid: UUID_A,
      claimSessionEpoch: 1,
      originShiftUuid: UUID_A,
      originShiftObservedAt: NOW,
      originBranchUuid: UUID_A,
      originWarehouseUuid: UUID_A,
      originContextFingerprint: HASH_64,
      intentFingerprint: HASH_64,
      intentVersion: 1,
      intentJson: '{"v":1}'
    })
    repositories.localSale.insertInvoice({
      localUuid: UUID_A,
      attemptKey: UUID_A,
      offlineNumber: 'POS-000001-20260829-000001',
      companyUuid: UUID_A,
      branchUuid: UUID_A,
      warehouseUuid: UUID_A,
      deviceUuid: UUID_A,
      userUuid: UUID_A,
      shiftUuid: UUID_A,
      commitSessionEpoch: 1,
      catalogRevision: HASH_64,
      intentFingerprint: HASH_64,
      customerUuid: null,
      currency: 'USD',
      currencyExponent: 2,
      taxMode: 'none',
      invoiceDiscountType: null,
      invoiceDiscountValue: 0,
      subtotalAmount: 1000,
      discountTotalAmount: 0,
      taxTotalAmount: 0,
      grandTotalAmount: 1000,
      paidTotalAmount: 1000,
      changeDueAmount: 0,
      soldAt: NOW,
      connectivityStateAtSale: 'online',
      soldWhileOffline: false,
      notes: null,
      commercialSnapshotJson: '{}',
      createdAt: NOW
    })
    repositories.localSale.insertItem({
      localUuid: UUID_A,
      invoiceLocalUuid: UUID_A,
      lineIndex: 0,
      productUuid: UUID_A,
      productName: 'Widget',
      sku: null,
      barcode: null,
      unit: null,
      trackStock: true,
      quantityMilli: 3000,
      unitPriceAmount: 1000,
      currency: 'USD',
      priceRevision: HASH_64,
      taxUuid: null,
      taxMode: 'none',
      taxRateBasisPoints: 0,
      taxRevision: HASH_64,
      discountType: null,
      discountValue: 0,
      subtotalAmount: 3000,
      discountAmount: 0,
      taxAmount: 0,
      totalAmount: 3000,
      createdAt: NOW
    })

    const grant = repositories.stockAllocations.upsertGrant({
      allocationUuid: UUID_A,
      contractVersion: 1,
      companyUuid: UUID_A,
      deviceUuid: UUID_A,
      warehouseUuid: UUID_A,
      productUuid: UUID_A,
      serverSequence: 1,
      lifecycleGeneration: 1,
      grantedQuantityMilli: 5000,
      consumeUntil: '2026-12-31T00:00:00.000Z',
      envelopeHash: HASH_64,
      receivedAt: NOW
    })
    equal(repositories.stockAllocations.remainingMilli(grant.allocationUuid), 5000)

    const sequence = repositories.stockAllocations.nextConsumptionSequence(grant.allocationUuid)
    equal(sequence, 1)
    repositories.stockAllocations.insertConsumption({
      localUuid: UUID_A,
      allocationUuid: grant.allocationUuid,
      consumptionSequence: sequence,
      invoiceLocalUuid: UUID_A,
      itemLocalUuid: UUID_A,
      quantityMilli: 3000,
      createdAt: NOW
    })

    equal(repositories.stockAllocations.remainingMilli(grant.allocationUuid), 2000)
    equal(repositories.stockAllocations.nextConsumptionSequence(grant.allocationUuid), 2)

    const usable = repositories.stockAllocations.usableGrantsForProduct(
      { companyUuid: UUID_A, deviceUuid: UUID_A, warehouseUuid: UUID_A },
      UUID_A,
      NOW
    )
    equal(usable.length, 1)

    repositories.localStock.insertMovement({
      localUuid: UUID_A,
      invoiceLocalUuid: UUID_A,
      itemLocalUuid: UUID_A,
      productUuid: UUID_A,
      warehouseUuid: UUID_A,
      quantityMilli: 3000,
      createdAt: NOW
    })
    equal(repositories.localStock.movementsForInvoice(UUID_A).length, 1)

    closeDatabase(database)
  }
)

databaseTest(
  'BootstrapSnapshotRepository exposes the singleton branch and warehouse readers',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)

    equal(repositories.bootstrapSnapshot.getBranch(), null)
    equal(repositories.bootstrapSnapshot.getWarehouse(), null)

    database
      .prepare(
        'INSERT INTO bootstrap_branch (id, branch_uuid, name, is_active, updated_at) VALUES (1, ?, ?, 1, ?)'
      )
      .run(UUID_A, 'Main Branch', NOW)
    database
      .prepare(
        'INSERT INTO bootstrap_warehouse (id, warehouse_uuid, name, is_active, updated_at) VALUES (1, ?, ?, 1, ?)'
      )
      .run(UUID_A, 'Main Warehouse', NOW)

    const branch = repositories.bootstrapSnapshot.getBranch()
    const warehouse = repositories.bootstrapSnapshot.getWarehouse()
    ok(branch !== null && branch.branchUuid === UUID_A && branch.isActive)
    ok(warehouse !== null && warehouse.warehouseUuid === UUID_A && warehouse.isActive)

    closeDatabase(database)
  }
)

databaseTest(
  'the partial unique index lets sync_queue carry exactly one invoice/upload row per invoice',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)

    repositories.syncQueue.enqueue({
      localQueueUuid: UUID_A,
      aggregateType: 'invoice',
      localAggregateUuid: UUID_A,
      operation: 'upload',
      payloadJson: '{}',
      payloadHash: HASH_64,
      idempotencyKey: UUID_A
    })

    throws(() =>
      repositories.syncQueue.enqueue({
        localQueueUuid: '00000000-0000-4000-8000-000000000004',
        aggregateType: 'invoice',
        localAggregateUuid: UUID_A,
        operation: 'upload',
        payloadJson: '{}',
        payloadHash: HASH_64,
        idempotencyKey: '00000000-0000-4000-8000-000000000004'
      })
    )

    closeDatabase(database)
  }
)
