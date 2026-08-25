import {
  apiEnvelopeSchema,
  type ApiEnvelope,
  type ApiSuccessEnvelope
} from '@shared/contracts/api.contract'
import { invalidResponseEnvelopeError, normalizeApiEnvelopeError } from './apiError'

export function parseApiEnvelope(payload: unknown): ApiEnvelope {
  const parsed = apiEnvelopeSchema.safeParse(payload)

  if (!parsed.success) {
    throw invalidResponseEnvelopeError()
  }

  return parsed.data
}

export function unwrapApiEnvelope<T>(payload: unknown): T {
  const envelope = parseApiEnvelope(payload)

  if (!envelope.success) {
    throw normalizeApiEnvelopeError(envelope)
  }

  return (envelope as ApiSuccessEnvelope).data as T
}
