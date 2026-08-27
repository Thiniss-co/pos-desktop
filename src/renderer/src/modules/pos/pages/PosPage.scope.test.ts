import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./PosPage.vue', import.meta.url), 'utf8')

describe('PosPage Phase 3B–3E boundary', () => {
  it('exposes no durable sale operation, even after Phase 3E adds a payment preview trigger', () => {
    // Phase 3E replaces the always-disabled cart-footer button with a working trigger that opens
    // PaymentPanel, and adds a legitimate `payment` Pinia store — `pos.payment.completeSale` is
    // that panel's still-disabled, phase-neutral label (see PaymentPanel.test.ts's own "no @click"
    // assertion), and calls like `payment.resetPayment()` are ordinary store methods, never a
    // completion handler here. `\bpayment\(` (not `payment\(`) still catches a literal call to a
    // function named exactly `payment(...)` — e.g. a payment-processor charge — without matching
    // every camelCase method ending in "...Payment(".
    expect(source).toMatch(/variant="transaction"[^>]*full-width[^>]*disabled/)
    expect(source).not.toMatch(/finalize|createInvoice|outbox|\bpayment\(/i)
    expect(source).not.toContain('window.posApi')
  })

  it('uses logical layout properties so the receipt spine mirrors in RTL', () => {
    expect(source).toContain('border-inline-start')
    expect(source).toContain('padding-block')
    expect(source).not.toMatch(/margin-left|margin-right|border-left|border-right/)
  })

  it('shows an explicit retry state when reading the current shift fails', () => {
    expect(source).toContain('v-if="freshness === \'error\'"')
    expect(source).toContain('shift.loadCurrent()')
    expect(source).toContain("t('pos.shiftUnavailable')")
  })
})
