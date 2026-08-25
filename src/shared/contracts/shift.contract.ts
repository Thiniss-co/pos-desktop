import { z } from 'zod'

const optionalNoteSchema = z.string().trim().max(1000).nullable().optional()
// Laravel persists shift cash fields in signed SQL INTEGER columns.
const moneySchema = z.number().int().min(0).max(2_147_483_647)
const signedMoneySchema = z.number().int().min(-2_147_483_648).max(2_147_483_647)

export const shiftStatusSchema = z.enum(['open', 'paused', 'closed', 'cancelled'])

export const shiftSchema = z
  .object({
    uuid: z.uuid(),
    status: shiftStatusSchema,
    openingCashAmount: moneySchema,
    expectedCashAmount: signedMoneySchema.nullable(),
    actualCashAmount: moneySchema.nullable(),
    cashDifferenceAmount: z.number().int().nullable(),
    openedAt: z.string(),
    closedAt: z.string().nullable(),
    pausedAt: z.string().nullable(),
    pauseCount: z.number().int().nonnegative(),
    totalPausedSeconds: z.number().int().nonnegative(),
    activePause: z
      .object({
        uuid: z.uuid(),
        pausedAt: z.string(),
        reason: z.string().nullable(),
        notes: z.string().nullable()
      })
      .strict()
      .nullable(),
    notes: z.string().nullable(),
    closeNotes: z.string().nullable()
  })
  .strict()

export const openShiftInputSchema = z
  .object({
    openingCashAmount: moneySchema,
    notes: optionalNoteSchema
  })
  .strict()

export const shiftIdInputSchema = z.object({ uuid: z.uuid() }).strict()
export const pauseShiftInputSchema = z
  .object({
    uuid: z.uuid(),
    reason: z.string().trim().max(100).nullable().optional(),
    notes: optionalNoteSchema
  })
  .strict()
export const resumeShiftInputSchema = z
  .object({
    uuid: z.uuid(),
    resumeNotes: optionalNoteSchema
  })
  .strict()
export const closeShiftInputSchema = z
  .object({
    uuid: z.uuid(),
    actualCashAmount: moneySchema,
    closeNotes: optionalNoteSchema
  })
  .strict()

export type Shift = z.infer<typeof shiftSchema>
export type OpenShiftInput = z.infer<typeof openShiftInputSchema>
export type PauseShiftInput = z.infer<typeof pauseShiftInputSchema>
export type ResumeShiftInput = z.infer<typeof resumeShiftInputSchema>
export type CloseShiftInput = z.infer<typeof closeShiftInputSchema>
