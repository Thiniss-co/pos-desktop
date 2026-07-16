import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { handleIpcRequest } from './handleIpcRequest'

describe('handleIpcRequest', () => {
  it('rejects invalid input before calling the handler', async () => {
    const result = await handleIpcRequest('unexpected', z.undefined(), () => 'not called')

    expect(result).toEqual({
      ok: false,
      error: {
        category: 'validation',
        message: 'The request is invalid',
        retryable: false
      }
    })
  })

  it('serializes unexpected errors without their message or stack', async () => {
    const result = await handleIpcRequest(undefined, z.undefined(), () => {
      throw new Error('/secret/path/database.sqlite failed')
    })

    expect(result).toEqual({
      ok: false,
      error: {
        category: 'unexpected',
        message: 'The request could not be completed',
        retryable: false
      }
    })
  })
})
