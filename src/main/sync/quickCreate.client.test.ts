import { describe, expect, it } from 'vitest'
import { normalizeApiEnvelopeError } from '../http/apiError'
import { dispatchQuickCreate, type QuickCreateApiClient } from './quickCreate.client'

const request = {
  requestKey: '11111111-1111-4111-8111-111111111111',
  entityType: 'customer' as const,
  clientEntityUuid: '22222222-2222-4222-8222-222222222222',
  canonicalPayloadJson: '{"name":"A","phone":null}'
}

function answering(result: unknown, fail = false): QuickCreateApiClient & { bodies: unknown[] } {
  const bodies: unknown[] = []
  return {
    bodies,
    async requestWithMeta<T>(_route: unknown, body?: unknown) {
      bodies.push(body)
      if (fail) throw result
      return result as { data: T; code: string }
    }
  }
}

const error = (fields: Record<string, unknown>): Record<string, unknown> => ({
  category: 'unexpected',
  message: 'x',
  retryable: false,
  ...fields
})

describe('dispatchQuickCreate', () => {
  it('sends the frozen payload with the request key and entity id', async () => {
    const api = answering({
      code: 'DESKTOP_ENTITY_CREATED',
      data: {
        request_key: request.requestKey,
        client_entity_uuid: request.clientEntityUuid,
        entity_type: 'customer',
        entity: { uuid: request.clientEntityUuid }
      }
    })
    expect(await dispatchQuickCreate(api, request)).toEqual({
      kind: 'accepted',
      serverEntityUuid: request.clientEntityUuid
    })
    expect(api.bodies[0]).toEqual({
      request_key: request.requestKey,
      client_entity_uuid: request.clientEntityUuid,
      payload: { name: 'A', phone: null }
    })
  })

  it('never accepts an echo that names another request or entity', async () => {
    const api = answering({
      code: 'DESKTOP_ENTITY_CREATED',
      data: {
        request_key: request.requestKey,
        client_entity_uuid: request.clientEntityUuid,
        entity_type: 'customer',
        entity: { uuid: '33333333-3333-4333-8333-333333333333' }
      }
    })
    expect((await dispatchQuickCreate(api, request)).kind).toBe('unknown')
  })

  it.each([
    ['VALIDATION_ERROR', 'refused'],
    ['DESKTOP_ENTITY_UUID_CONFLICT', 'refused'],
    ['DESKTOP_PRODUCT_IDENTIFIER_TAKEN', 'refused'],
    ['DESKTOP_SUPPLIER_NAME_TAKEN', 'refused'],
    ['DESKTOP_ENTITY_REFERENCE_INVALID', 'refused'],
    ['IDEMPOTENCY_CONFLICT', 'conflict']
  ])('classifies %s as %s', async (code, kind) => {
    const result = await dispatchQuickCreate(
      answering(error({ category: 'validation', backendCode: code }), true),
      request
    )
    expect(result.kind).toBe(kind)
  })

  it('keeps a 403 as blocked, a 401 and every transport or server failure as unknown', async () => {
    expect(
      (
        await dispatchQuickCreate(
          answering(error({ category: 'authorization', backendCode: 'PERMISSION_DENIED' }), true),
          request
        )
      ).kind
    ).toBe('blocked_permission')
    const unauthenticated = await dispatchQuickCreate(
      answering(error({ category: 'authentication' }), true),
      request
    )
    expect(unauthenticated).toMatchObject({ kind: 'unknown', sessionEnded: true })
    expect(
      (
        await dispatchQuickCreate(
          answering(error({ category: 'transport', retryable: true }), true),
          request
        )
      ).kind
    ).toBe('unknown')
    expect(
      (
        await dispatchQuickCreate(
          answering(error({ category: 'conflict', backendCode: 'CONFLICT' }), true),
          request
        )
      ).kind
    ).toBe('unknown')
    expect(
      (await dispatchQuickCreate(answering(new Error('socket hang up'), true), request)).kind
    ).toBe('unknown')
  })

  it('classifies the REAL normalized server envelope of every stored refusal (codes are known)', async () => {
    for (const code of [
      'DESKTOP_SUPPLIER_NAME_TAKEN',
      'DESKTOP_PRODUCT_IDENTIFIER_TAKEN',
      'DESKTOP_ENTITY_UUID_CONFLICT',
      'DESKTOP_ENTITY_REFERENCE_INVALID'
    ]) {
      const envelope = normalizeApiEnvelopeError({
        success: false,
        message: 'refused',
        code,
        errors: { name: ['taken'] },
        meta: { trace_id: 'trace-1' }
      } as never)
      const result = await dispatchQuickCreate(answering(envelope, true), request)
      expect(result).toMatchObject({ kind: 'refused', code })
    }
  })
})
