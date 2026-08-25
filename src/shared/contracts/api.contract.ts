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
    traceId: z.string().optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
    contentType: z.string().trim().min(1).max(200).optional()
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
    // Laravel's ApiResponse::error() serializes an empty PHP array as `[]`, while an explicit
    // null has also appeared on controller-produced errors. Both mean no field-level validation
    // errors, so normalize only those empty representations to the contract's record shape.
    errors: z.preprocess(
      (value) =>
        value === null || value === undefined || (Array.isArray(value) && value.length === 0)
          ? {}
          : value,
      fieldErrorsSchema
    ),
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
