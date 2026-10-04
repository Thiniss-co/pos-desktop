import { deepEqual, equal, ok, throws } from 'node:assert/strict'
import { closeDatabase } from '../../../src/main/database/connection'
import { FiscalContextService } from '../../../src/main/receipt/fiscalContext.service'
import { decodeZatcaPhase1Qr } from '../../../src/shared/receipt/fiscalQr'
import { decodeTransactionReferenceQr } from '../../../src/shared/receipt/transactionQr'
import { databaseTest } from '../support/sandbox'
import { readCommitted } from '../support/committedState'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories } from '../support/realRepositories'
import {
  bootstrapResource,
  companyUuid,
  setUpAuthorizedContext,
  validIntent
} from '../support/localSaleFixture'

/**
 * POS improvements, Stage 6 — fiscal context frozen INSIDE the sale-commit transaction, on the real
 * 0024 schema: the mirrored identity becomes each sale's immutable context and exact QR payload; a
 * ZATCA register with an incomplete identity never commits; a non-fiscal register gets the
 * transaction reference; the bootstrap block replaces (or removes) the mirror.
 */

const ZATCA_IDENTITY = {
  regime: 'sa_zatca_phase1' as const,
  seller_name: 'Harbour Coffee Trading LLC',
  vat_number: '310122393500003',
  seller_address: {
    street: '1 Corniche Road',
    city: 'Jeddah',
    postal_code: '23511',
    country: 'Saudi Arabia'
  },
  revision: 3
}

databaseTest(
  'a ZATCA sale freezes its identity and the exact TLV payload in the commit transaction; the row is immutable',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    try {
      const repositories = realRepositories(database)
      const fiscal = new FiscalContextService(repositories.fiscalContexts)
      const { localSale } = setUpAuthorizedContext(
        database,
        repositories,
        undefined,
        'online',
        true,
        {
          fiscalContext: fiscal
        }
      )
      // After setup: the fixture's own bootstrap (no fiscal block) clears the mirror.
      repositories.fiscalContexts.replaceIdentity(
        companyUuid,
        ZATCA_IDENTITY,
        '2026-01-01T00:02:00Z'
      )

      const outcome = localSale.complete('f6000000-0000-4000-8000-000000000001', validIntent())
      ok(outcome.outcome === 'committed', JSON.stringify(outcome))

      const [invoice] = readCommitted(
        sandbox,
        'SELECT local_uuid, sold_at, grand_total_amount, tax_total_amount, currency, currency_exponent FROM local_invoices'
      ) as Array<Record<string, unknown>>
      const [context] = readCommitted(
        sandbox,
        'SELECT * FROM local_invoice_fiscal_context'
      ) as Array<Record<string, unknown>>
      equal(context?.regime, 'sa_zatca_phase1')
      equal(context?.qr_type, 'zatca-p1')
      equal(context?.seller_name, 'Harbour Coffee Trading LLC')
      equal(context?.fiscal_revision, 3)
      deepEqual(JSON.parse(String(context?.seller_address_json)), ZATCA_IDENTITY.seller_address)

      const fields = decodeZatcaPhase1Qr(String(context?.qr_payload))
      ok(fields)
      equal(fields?.sellerName, 'Harbour Coffee Trading LLC')
      equal(fields?.vatNumber, '310122393500003')
      equal(fields?.timestamp, `${String(invoice?.sold_at).slice(0, 19)}Z`)

      // The gate's recomputation from frozen facts reproduces the stored payload.
      const expected = fiscal.expectedSaleQr({
        invoiceLocalUuid: String(invoice?.local_uuid),
        companyUuid,
        soldAt: String(invoice?.sold_at),
        grandTotalAmount: Number(invoice?.grand_total_amount),
        taxTotalAmount: Number(invoice?.tax_total_amount),
        currency: String(invoice?.currency),
        currencyExponent: Number(invoice?.currency_exponent)
      })
      equal(expected?.payload, context?.qr_payload)

      // A later identity change never touches the frozen row.
      repositories.fiscalContexts.replaceIdentity(
        companyUuid,
        {
          ...ZATCA_IDENTITY,
          seller_address: { ...ZATCA_IDENTITY.seller_address, street: '99 New Street' },
          revision: 4
        },
        '2026-01-02T00:00:00Z'
      )
      equal(
        repositories.fiscalContexts.invoiceContext(String(invoice?.local_uuid))?.sellerAddress
          ?.street,
        '1 Corniche Road'
      )
      throws(() =>
        database.prepare("UPDATE local_invoice_fiscal_context SET seller_name = 'x'").run()
      )
      throws(() => database.prepare('DELETE FROM local_invoice_fiscal_context').run())
    } finally {
      closeDatabase(database)
    }
  }
)

databaseTest(
  'a ZATCA register with an incomplete identity never commits (non-terminal), then commits the same attempt once complete',
  async (sandbox) => {
    const database = openTestDatabase(sandbox)
    try {
      const repositories = realRepositories(database)
      const fiscal = new FiscalContextService(repositories.fiscalContexts)
      const { localSale } = setUpAuthorizedContext(
        database,
        repositories,
        undefined,
        'online',
        true,
        {
          fiscalContext: fiscal
        }
      )
      // After setup: the fixture's own bootstrap (no fiscal block) clears the mirror.
      repositories.fiscalContexts.replaceIdentity(
        companyUuid,
        { ...ZATCA_IDENTITY, vat_number: '210122393500003' },
        '2026-01-01T00:02:00Z'
      )
      const attemptKey = 'f6000000-0000-4000-8000-000000000002'

      const refused = localSale.complete(attemptKey, validIntent())
      deepEqual(refused, { outcome: 'failed', code: 'fiscal-setup-incomplete', attemptKey })
      equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 0)
      equal(readCommitted(sandbox, 'SELECT * FROM local_invoice_fiscal_context').length, 0)
      equal(
        (readCommitted(sandbox, 'SELECT state FROM sale_attempts') as Array<{ state: string }>)[0]
          ?.state,
        'claimed'
      )

      repositories.fiscalContexts.replaceIdentity(
        companyUuid,
        ZATCA_IDENTITY,
        '2026-01-01T00:03:00Z'
      )
      const retried = await localSale.retry(attemptKey)
      ok(retried.outcome === 'committed', JSON.stringify(retried))
      equal(readCommitted(sandbox, 'SELECT * FROM local_invoice_fiscal_context').length, 1)
    } finally {
      closeDatabase(database)
    }
  }
)

databaseTest(
  'a non-fiscal register freezes a txn-ref-v1 reference; the bootstrap block replaces and removes the mirror',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    try {
      const repositories = realRepositories(database)
      const fiscal = new FiscalContextService(repositories.fiscalContexts)
      const { localSale } = setUpAuthorizedContext(
        database,
        repositories,
        undefined,
        'online',
        true,
        {
          fiscalContext: fiscal
        }
      )

      const outcome = localSale.complete('f6000000-0000-4000-8000-000000000003', validIntent())
      ok(outcome.outcome === 'committed', JSON.stringify(outcome))
      const [context] = readCommitted(
        sandbox,
        'SELECT invoice_local_uuid, regime, qr_type, qr_payload, seller_name FROM local_invoice_fiscal_context'
      ) as Array<Record<string, unknown>>
      equal(context?.regime, 'none')
      equal(context?.qr_type, 'txn-ref-v1')
      equal(context?.seller_name, null)
      const reference = decodeTransactionReferenceQr(String(context?.qr_payload))
      equal(reference?.co, companyUuid)
      equal(reference?.id, context?.invoice_local_uuid)
      equal(reference?.doc, 'sale')

      // Bootstrap persistence: the negotiated block becomes the mirror; a response without it removes it.
      repositories.bootstrapSnapshot.persistSnapshot(
        bootstrapResource({ fiscal_identity: ZATCA_IDENTITY } as never),
        '2026-01-01T00:05:00+00:00'
      )
      equal(repositories.fiscalContexts.identity(companyUuid)?.regime, 'sa_zatca_phase1')
      repositories.bootstrapSnapshot.persistSnapshot(
        bootstrapResource(),
        '2026-01-01T00:06:00+00:00'
      )
      equal(repositories.fiscalContexts.identity(companyUuid), null)
    } finally {
      closeDatabase(database)
    }
  }
)
