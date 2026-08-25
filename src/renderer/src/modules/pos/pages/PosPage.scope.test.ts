import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./PosPage.vue', import.meta.url), 'utf8')

describe('PosPage Phase 3B boundary', () => {
  it('keeps checkout visibly unavailable and exposes no durable sale operation', () => {
    expect(source).toMatch(/variant="transaction"[^>]*full-width[^>]*disabled/)
    expect(source).not.toMatch(/finalize|completeSale|createInvoice|outbox|payment\(/i)
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
