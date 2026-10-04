# Receipt QR contract (POS improvements, Stage 6)

Every printed sale receipt and every accepted-refund receipt carries a QR. Its type follows the
document's FROZEN fiscal context, never today's settings.

| Document | Title | QR type | Payload |
|---|---|---|---|
| Sale, frozen regime `sa_zatca_phase1` | Simplified Tax Invoice / فاتورة ضريبية مبسطة | `zatca-p1` | ZATCA Phase 1 TLV (below) over the sale's frozen identity and totals |
| Accepted refund, frozen regime `sa_zatca_phase1` | Credit Note / إشعار دائن, plus "This credit note relates to invoice number (N), issued on D" | `zatca-p1` | TLV over the server-frozen note identity, its acceptance time stamp, and its total and VAT (positive; the sign is an unverified interpretation) |
| Sale or refund, frozen regime `none` | Receipt / Refund receipt | `txn-ref-v1` | `THINIS-TXN/1;…` (below), never labelled ZATCA |
| Sale committed before fiscal context existed (historical) | Receipt – historical copy, plus "Issued before fiscal data was recorded; this is not a tax invoice" | `txn-ref-v1` | Built from existing facts only; no VAT identity is fabricated |

## `zatca-p1`

- Source: ZATCA's QR code guide.
- Five TLV fields: 1 seller name, 2 VAT number, 3 UTC time stamp `YYYY-MM-DDTHH:MM:SSZ`, 4 total with VAT, 5 VAT total.
- Each field is a one-byte tag, a one-byte UTF-8 byte length (1–255), then the value; the whole is Base64-encoded, at most 500 characters.
- Amounts are invariant decimals built from minor units and the currency exponent (`1000.00`).
- Encoders: desktop `src/shared/receipt/fiscalQr.ts`; backend `App\Modules\POS\Support\ZatcaPhase1Qr`.
- Golden vector: `zatca-phase1-qr-golden.json`, byte-identical in both repositories (`verify:fixture`). It includes the official example: "Bobs Records" / 310122393500003 / 2022-04-25T15:30:00Z / 1000.00 / 150.00.

## `txn-ref-v1`

- Agreed with the receipt-snapshot work (owner view and reprint):
  `THINIS-TXN/1;co=<company uuid>;doc=<sale|refund>;id=<local document uuid>;ts=<UTC YYYY-MM-DDTHH:MM:SSZ>;amt=<decimal>;cur=<ISO 4217>`
- ASCII, at most 255 characters, fixed key order.
- Desktop: `src/shared/receipt/transactionQr.ts` exports `encodeTransactionReferenceQr(facts)` and `canonicalJson(value)`.

## Freezing

- **Sales.** `local_invoice_fiscal_context` is written inside the sale-commit transaction. It holds the regime, seller name, VAT number, seller address and fiscal revision copied from the mirrored `fiscal_identity`, plus the QR type and payload. A ZATCA register with an incomplete identity refuses the sale with `FISCAL_SETUP_INCOMPLETE`, both at preview and at commit.
- **Refunds.** The backend freezes `pos_refunds.fiscal_snapshot` at acceptance. A register that sends `?fiscal_contract_version=1` receives it and freezes it in `local_refund_fiscal_context`.
- **Reprints** always reuse the stored payload.

## Verification before dispatch

Preparation (Phase P) does all of the following before the synchronous authorization fence (Phase F):

1. Recomputes the expected payload from the frozen facts.
2. Decodes the QR from the rendered receipt image.
3. Requires an exact match that also parses as the expected type.
4. Records `qr_verified_sha256` on the job.

`beginDispatching` requires `qr_verified_sha256`. A missing, unreadable or mismatched QR ends the job as `failed_before_dispatch` (`RECEIPT_QR_INVALID`); the sale or refund itself is untouched.
