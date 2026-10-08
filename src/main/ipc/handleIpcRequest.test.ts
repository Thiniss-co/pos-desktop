import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { publicAppErrorSchema } from '@shared/contracts/api.contract'
import type { IpcMainInvokeEvent } from 'electron'
import { rendererIndexUrl } from '../security/securityPolicy'
import { handleIpcRequest, handleTrustedIpcRequest } from './handleIpcRequest'

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

  it('passes a public contract-invalid error through to the renderer', async () => {
    const contractError = publicAppErrorSchema.parse({
      category: 'unexpected',
      message:
        'The service returned unsupported bootstrap data. Please update the desktop application or contact support.',
      backendCode: 'bootstrap_payload_contract_invalid',
      retryable: false
    })

    const result = await handleIpcRequest(undefined, z.undefined(), () => {
      throw contractError
    })

    expect(result).toEqual({ ok: false, error: contractError })
  })
})

describe('handleTrustedIpcRequest', () => {
  const event = (url: string, parent: unknown = null): IpcMainInvokeEvent =>
    ({ senderFrame: { parent, url } }) as unknown as IpcMainInvokeEvent

  it("answers the application's own main frame", async () => {
    const result = await handleTrustedIpcRequest(
      event(`${rendererIndexUrl().href}#/pos`),
      undefined,
      z.undefined(),
      () => 'answered'
    )

    expect(result).toEqual({ ok: true, data: 'answered' })
  })

  it('refuses any other sender before the payload is parsed or the handler runs', async () => {
    const handler = vi.fn()

    for (const sender of [
      event('file:///home/cashier/Downloads/index.html'),
      event('https://evil.example/'),
      event(rendererIndexUrl().href, {})
    ]) {
      const result = await handleTrustedIpcRequest(sender, 'not even valid', z.undefined(), handler)

      expect(result).toMatchObject({ ok: false, error: { category: 'authorization' } })
    }
    expect(handler).not.toHaveBeenCalled()
  })
})
