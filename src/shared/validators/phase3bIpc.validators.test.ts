import { describe, expect, it } from 'vitest'
import {
  catalogFindByBarcodeInputSchema,
  catalogSearchProductsInputSchema,
  shiftsCloseInputSchema,
  shiftsOpenInputSchema,
  shiftsPauseInputSchema
} from './ipc.validators'

describe('Phase 3B IPC input contracts', () => {
  it('accepts bounded catalog reads without caller-owned business context', () => {
    expect(
      catalogSearchProductsInputSchema.safeParse({
        query: 'water',
        categoryUuid: null,
        limit: 24,
        offset: 0
      }).success
    ).toBe(true)
    expect(
      catalogSearchProductsInputSchema.safeParse({
        query: '',
        categoryUuid: null,
        limit: 1000,
        offset: 0,
        companyId: 42
      }).success
    ).toBe(false)
    expect(catalogFindByBarcodeInputSchema.safeParse({ barcode: '12' }).success).toBe(true)
  })

  it('keeps shift IDs, notes, and integer cash strictly bounded', () => {
    expect(shiftsOpenInputSchema.safeParse({ openingCashAmount: 1000 }).success).toBe(true)
    expect(shiftsOpenInputSchema.safeParse({ openingCashAmount: 1.5 }).success).toBe(false)
    expect(shiftsOpenInputSchema.safeParse({ openingCashAmount: 2_147_483_648 }).success).toBe(
      false
    )
    expect(
      shiftsPauseInputSchema.safeParse({
        uuid: '11111111-1111-4111-8111-111111111111',
        reason: 'x'.repeat(101)
      }).success
    ).toBe(false)
    expect(
      shiftsCloseInputSchema.safeParse({
        uuid: '11111111-1111-4111-8111-111111111111',
        actualCashAmount: 1000,
        accessAllowed: true
      }).success
    ).toBe(false)
  })
})
