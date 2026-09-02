import type {
  LocalInvoiceItemRow,
  LocalInvoicePaymentRow,
  LocalInvoiceRow,
  LocalStockAllocationConsumptionRow,
  StockAllocationGrantRow
} from '@shared/contracts/sale.contract'
import { milliToQuantity } from './localSale.fingerprint'

/**
 * The exact v2 wire body for `POST /api/v1/desktop/invoices/upload` (BE-3F-3/BE-3F-2A contract),
 * reconstructed byte-for-byte from committed rows. `local_invoices.local_uuid` is always sent as
 * both `idempotency_key` and `local_invoice_uuid`, matching the frozen backend invariant that they
 * are the same identity end to end.
 *
 * `rights_generation` is not a stored column on `local_stock_allocation_consumptions` (plan §5.4)
 * — Phase 3F never advances lifecycle generations locally (no seal/release flow is implemented on
 * the desktop side), so it is always the referenced grant's own `rightsGeneration` at the moment
 * of consumption, looked up via `grantsByAllocationUuid`.
 *
 * @param consumptionsByItem allocation-consumption rows for this invoice, keyed by
 *   `local_invoice_items.local_uuid`. Empty/absent for an untracked line.
 */
export function buildUploadPayload(
  invoice: LocalInvoiceRow,
  items: readonly LocalInvoiceItemRow[],
  payments: readonly LocalInvoicePaymentRow[],
  consumptionsByItem: ReadonlyMap<string, readonly LocalStockAllocationConsumptionRow[]>,
  grantsByAllocationUuid: ReadonlyMap<string, StockAllocationGrantRow>
): Record<string, unknown> {
  return {
    idempotency_key: invoice.localUuid,
    local_invoice_uuid: invoice.localUuid,
    catalog_revision: invoice.catalogRevision,
    offline_number: invoice.offlineNumber,
    sold_at: invoice.soldAt,
    sold_while_offline: invoice.soldWhileOffline,
    customer_uuid: invoice.customerUuid,
    currency: invoice.currency,
    tax_mode: invoice.taxMode,
    client_contract_version: 2,
    shift_uuid: invoice.shiftUuid,
    items: [...items]
      .sort((left, right) => left.lineIndex - right.lineIndex)
      .map((item) => {
        const consumptions = consumptionsByItem.get(item.localUuid) ?? []

        return {
          product_uuid: item.productUuid,
          barcode: item.barcode,
          quantity: milliToQuantity(item.quantityMilli),
          unit_price_amount: item.unitPriceAmount,
          currency: item.currency,
          price_revision: item.priceRevision,
          tax_id: item.taxUuid,
          tax_mode: item.taxMode,
          tax_rate_basis_points: item.taxRateBasisPoints,
          tax_revision: item.taxRevision,
          discount_type: item.discountType,
          discount_value: item.discountValue,
          ...(item.trackStock
            ? {
                allocations: consumptions.map((consumption) => {
                  const grant = grantsByAllocationUuid.get(consumption.allocationUuid)

                  if (!grant) {
                    throw new Error(
                      `Allocation consumption references an unknown grant: ${consumption.allocationUuid}`
                    )
                  }

                  return {
                    allocation_uuid: consumption.allocationUuid,
                    rights_generation: grant.rightsGeneration,
                    consumption_sequence: consumption.consumptionSequence,
                    local_consumption_uuid: consumption.localUuid,
                    quantity_milli: consumption.quantityMilli
                  }
                })
              }
            : {})
        }
      }),
    invoice_discount: {
      type: invoice.invoiceDiscountType,
      value: invoice.invoiceDiscountValue
    },
    payments: [...payments]
      .sort((left, right) => left.paymentIndex - right.paymentIndex)
      .map((payment) => ({
        payment_method_uuid: payment.paymentMethodUuid,
        type: payment.type,
        amount: payment.amount,
        reference: payment.reference,
        paid_at: payment.paidAt
      })),
    notes: invoice.notes
  }
}
