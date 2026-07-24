import { describe, expect, it } from 'vitest'
import { companyUsersCreateInputSchema } from '@shared/validators/ipc.validators'
import { handleIpcRequest } from './handleIpcRequest'

describe('company user IPC validation', () => {
  it('rejects malformed or injected create payloads before an IPC handler can call the service', async () => {
    const result = await handleIpcRequest(
      {
        name: 'Cashier One',
        email: 'cashier@example.test',
        password: 'password123',
        roles: ['super_admin'],
        company_id: 42
      },
      companyUsersCreateInputSchema,
      () => 'not called'
    )

    expect(result).toMatchObject({ ok: false, error: { category: 'validation' } })
  })
})
