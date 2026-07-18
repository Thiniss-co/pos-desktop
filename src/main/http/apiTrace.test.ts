import { describe, expect, it } from 'vitest'
import { createApiTracer, sanitizeApiUrl, type ApiTracer } from './apiTrace'

describe('API tracing', () => {
  const url = new URL(
    'https://trace-user:trace-password@api.example.test:8443/register?token=secret#hash'
  )

  it('does not emit while disabled', () => {
    const lines: string[] = []
    const tracer = createApiTracer({ enabled: false, sink: (line) => lines.push(line) })

    tracer.start({ method: 'POST', url })
    tracer.finish({ method: 'POST', url, elapsedMs: 12, status: 200 })
    tracer.failure({ method: 'POST', url, elapsedMs: 12, classification: 'unknown' })

    expect(lines).toEqual([])
  })

  it('keeps only the protocol, host, port, and path in trace URLs', () => {
    expect(sanitizeApiUrl(url)).toBe('https://api.example.test:8443/register')
  })

  it('emits only whitelisted trace fields and redacts sensitive text defensively', () => {
    const lines: string[] = []
    const tracer = createApiTracer({ enabled: true, sink: (line) => lines.push(line) })

    tracer.failure({
      method: 'POST',
      url,
      elapsedMs: 12,
      classification: 'connection_refused',
      backendCode: 'AUTHORIZATION=Bearer actual-token',
      traceId: 'trace-1',
      validationFields: ['company_code', 'activation_code'],
      headers: { Authorization: 'Bearer authorization-secret' },
      token: 'token-secret',
      company_code: 'company-acme',
      activation_code: 'activation-secret',
      fingerprint_hash: 'fingerprint-secret'
    } as unknown as Parameters<ApiTracer['failure']>[0])

    const [line] = lines
    expect(line).toContain('stage=failure')
    expect(line).toContain('classification=connection_refused')
    expect(line).toContain('validation_fields=company_code,activation_code')
    expect(line).not.toContain('trace-user')
    expect(line).not.toContain('trace-password')
    expect(line).not.toContain('secret')
    expect(line).not.toContain('actual-token')
    expect(line).not.toContain('authorization-secret')
    expect(line).not.toContain('token-secret')
    expect(line).not.toContain('company-acme')
    expect(line).not.toContain('activation-secret')
    expect(line).not.toContain('fingerprint-secret')
    expect(line).not.toContain('?token=')
    expect(line).not.toContain('#hash')
  })

  it('includes validation field names without their values', () => {
    const lines: string[] = []
    const tracer = createApiTracer({ enabled: true, sink: (line) => lines.push(line) })

    tracer.finish({
      method: 'POST',
      url,
      elapsedMs: 12,
      status: 422,
      validationFields: ['company_code', 'activation_code']
    })

    expect(lines[0]).toContain('validation_fields=company_code,activation_code')
    expect(lines[0]).not.toContain('company-acme')
    expect(lines[0]).not.toContain('activation-secret')
  })
})
