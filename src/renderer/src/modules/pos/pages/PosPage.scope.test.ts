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
    // V3 styles the page with Tailwind utilities instead of a scoped stylesheet: logical spacing /
    // alignment utilities must be present, and neither physical CSS properties nor physical
    // utilities (ml-/mr-/pl-/pr-/left-/right-/text-left/text-right/border-l/border-r) may appear.
    expect(source).toMatch(/\b(?:ms|me|ps|pe)-\d|\btext-(?:start|end)\b/)
    expect(source).not.toMatch(/margin-left|margin-right|border-left|border-right/)
    expect(source).not.toMatch(
      /\b(?:ml|mr|pl|pr|left|right)-\d|\btext-(?:left|right)\b|\bborder-[lr]\b|\brounded-[lr]\b/
    )
  })

  it('shows an explicit retry state when reading the current shift fails', () => {
    expect(source).toContain('v-if="freshness === \'error\'"')
    expect(source).toContain('shift.loadCurrent()')
    expect(source).toContain("t('pos.shiftUnavailable')")
  })

  it('names the actual checkout prerequisite instead of claiming a build gate exists', () => {
    expect(source).not.toContain('pos.checkoutUnavailable')
    expect(source).toContain('checkoutActionLabel')
    expect(source).toContain("t('pos.checkoutRequiresOpenShift')")
    expect(source).toContain("t('pos.checkoutRequiresItem')")
    expect(source).toContain("t('pos.checkoutRequiresValidCart')")
  })

  it('shows a live sync indicator instead of the CP-3G-4 placeholder', () => {
    // V3 moved the live queue indicator from the POS toolbar into the shell's top-bar sync pill,
    // which is visible on every page (the POS page included). The same live fields must drive it.
    const shellStatus = readFileSync(
      new URL('../../../app/shell/useShellStatus.ts', import.meta.url),
      'utf8'
    )
    const topBar = readFileSync(
      new URL('../../../app/shell/AppTopBar.vue', import.meta.url),
      'utf8'
    )
    expect(source).not.toContain('pos.syncPlaceholder')
    expect(shellStatus).toContain('syncPill')
    expect(shellStatus).toContain('sync.queuedCount')
    expect(shellStatus).toContain('sync.failedCount')
    expect(shellStatus).toContain('sync.isPaused')
    expect(topBar).toContain('syncPill.label')
  })

  it('subscribes and disposes the sync store with the page lifecycle', () => {
    expect(source).toContain('sync.initialize()')
    expect(source).toContain('sync.dispose()')
  })

  it('never makes till rendering depend on connectivity, and never uploads from the renderer', () => {
    // The chip reads queue state only. A cashier offline must still see what is waiting, and the
    // renderer may never dispatch or authorize an upload.
    expect(source).not.toMatch(/uploadNow|listFailures|invoicesUpload/)
    expect(source).not.toMatch(/v-if="[^"]*connectivity[^"]*"/)
  })
})
