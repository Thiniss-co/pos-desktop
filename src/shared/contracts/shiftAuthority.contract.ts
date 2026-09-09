import { z } from 'zod'

/**
 * The renderer-visible projection of the main process's durable, owner-scoped shift observation
 * (`shift_observation`). It is deliberately narrower than `Shift`: it carries no cash figures and
 * no server DTO fields, only the identity and the verdict the main process already uses to admit
 * or deny a sale. Every non-`open` kind is a denial the renderer must honour.
 */
export const shiftLocalAuthoritySchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('open'),
      shiftUuid: z.uuid(),
      observedAt: z.string()
    })
    .strict(),
  z
    .object({
      kind: z.literal('not-open'),
      status: z.enum(['paused', 'closed', 'cancelled'])
    })
    .strict(),
  z.object({ kind: z.literal('none'), observedAt: z.string() }).strict(),
  z.object({ kind: z.literal('reconciliation-required'), since: z.string() }).strict(),
  z.object({ kind: z.literal('unknown') }).strict(),
  z.object({ kind: z.literal('foreign') }).strict()
])

export type ShiftLocalAuthority = z.infer<typeof shiftLocalAuthoritySchema>
