import { z } from 'zod'

export const publicAppErrorCategorySchema = z.enum([
  'configuration',
  'transport',
  'authentication',
  'authorization',
  'validation',
  'conflict',
  'rejected',
  'unexpected'
])

export const fieldErrorsSchema = z.record(z.string(), z.array(z.string()))

export const publicAppErrorSchema = z
  .object({
    category: publicAppErrorCategorySchema,
    message: z.string(),
    backendCode: z.string().optional(),
    retryable: z.boolean(),
    fieldErrors: fieldErrorsSchema.optional(),
    traceId: z.string().optional()
  })
  .strict()

export const apiSuccessEnvelopeSchema = z
  .object({
    success: z.literal(true),
    message: z.string(),
    code: z.string(),
    data: z.unknown(),
    meta: z.record(z.string(), z.unknown()).default({})
  })
  .passthrough()

export const apiErrorEnvelopeSchema = z
  .object({
    success: z.literal(false),
    message: z.string(),
    code: z.string(),
    errors: fieldErrorsSchema.default({}),
    meta: z
      .object({
        trace_id: z.string().optional()
      })
      .passthrough()
      .default({})
  })
  .passthrough()

export const apiEnvelopeSchema = z.union([apiSuccessEnvelopeSchema, apiErrorEnvelopeSchema])

export type PublicAppError = z.infer<typeof publicAppErrorSchema>
export type ApiSuccessEnvelope = z.infer<typeof apiSuccessEnvelopeSchema>
export type ApiErrorEnvelope = z.infer<typeof apiErrorEnvelopeSchema>
export type ApiEnvelope = z.infer<typeof apiEnvelopeSchema>
