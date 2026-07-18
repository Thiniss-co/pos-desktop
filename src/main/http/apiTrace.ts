import { redactSensitiveText } from './apiError'

interface ApiTraceRequestEvent {
  readonly method: string
  readonly url: URL
}

export interface ApiTraceStartEvent extends ApiTraceRequestEvent {}

export interface ApiTraceFinishEvent extends ApiTraceRequestEvent {
  readonly elapsedMs: number
  readonly status: number
  readonly contentType?: string
  readonly backendCode?: string
  readonly traceId?: string
  readonly validationFields?: readonly string[]
}

export interface ApiTraceFailureEvent extends ApiTraceRequestEvent {
  readonly elapsedMs: number
  readonly classification: string
  readonly backendCode?: string
  readonly traceId?: string
  readonly validationFields?: readonly string[]
}

export interface ApiTracer {
  start(event: ApiTraceStartEvent): void
  finish(event: ApiTraceFinishEvent): void
  failure(event: ApiTraceFailureEvent): void
}

export interface ApiTracerOptions {
  readonly enabled?: boolean
  readonly sink?: (line: string) => void
}

export function isApiTraceEnabled(): boolean {
  return process.env['POS_API_TRACE'] === '1'
}

export function sanitizeApiUrl(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname}`
}

function formatFields(fields: Record<string, string | number | undefined>): string {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ')
}

function createLine(
  stage: 'start' | 'finish' | 'failure',
  event: ApiTraceStartEvent | ApiTraceFinishEvent | ApiTraceFailureEvent
): string {
  const baseFields = {
    stage,
    method: event.method,
    url: sanitizeApiUrl(event.url)
  }

  if (stage === 'start') {
    return formatFields(baseFields)
  }

  const terminalEvent = event as ApiTraceFinishEvent | ApiTraceFailureEvent
  const terminalFields = {
    ...baseFields,
    elapsed_ms: terminalEvent.elapsedMs,
    backend_code: terminalEvent.backendCode,
    trace_id: terminalEvent.traceId,
    validation_fields:
      terminalEvent.validationFields && terminalEvent.validationFields.length > 0
        ? terminalEvent.validationFields.join(',')
        : undefined
  }

  if (stage === 'finish') {
    const finishEvent = terminalEvent as ApiTraceFinishEvent

    return formatFields({
      ...terminalFields,
      status: finishEvent.status,
      content_type: finishEvent.contentType
    })
  }

  return formatFields({
    ...terminalFields,
    classification: (terminalEvent as ApiTraceFailureEvent).classification
  })
}

export function createApiTracer(options: ApiTracerOptions = {}): ApiTracer {
  const enabled = options.enabled ?? isApiTraceEnabled()
  const sink = options.sink ?? ((line: string) => console.error(line))

  function emit(
    stage: 'start' | 'finish' | 'failure',
    event: ApiTraceStartEvent | ApiTraceFinishEvent | ApiTraceFailureEvent
  ): void {
    if (!enabled) {
      return
    }

    try {
      sink(redactSensitiveText(`[pos-api] ${createLine(stage, event)}`))
    } catch {
      // Diagnostics must never change an API request's outcome.
    }
  }

  return {
    start: (event) => emit('start', event),
    finish: (event) => emit('finish', event),
    failure: (event) => emit('failure', event)
  }
}
