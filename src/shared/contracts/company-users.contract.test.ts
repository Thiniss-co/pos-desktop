import { describe, expect, it } from 'vitest'
import {
  createCompanyUserInputSchema,
  setRolesInputSchema,
  updateCompanyUserInputSchema
} from './company-users.contract'

const roleId = '11111111-1111-4111-8111-111111111111'
const userId = '22222222-2222-4222-8222-222222222222'

describe('company user IPC contracts', () => {
  it('accepts a minimal company-scoped create request', () => {
    expect(
      createCompanyUserInputSchema.parse({
        name: 'Cashier One',
        email: 'cashier@example.test',
        password: 'password123',
        companyRoleIds: [roleId]
      })
    ).toMatchObject({ roles: [], companyRoleIds: [roleId] })
  })

  it('rejects company and platform privilege injection', () => {
    expect(
      createCompanyUserInputSchema.safeParse({
        name: 'Cashier One',
        email: 'cashier@example.test',
        password: 'password123',
        roles: ['super_admin'],
        company_id: 99
      }).success
    ).toBe(false)
  })

  it('requires a complete non-empty role set when roles are replaced', () => {
    expect(
      setRolesInputSchema.safeParse({ uuid: userId, roles: [], companyRoleIds: [] }).success
    ).toBe(false)
    expect(
      setRolesInputSchema.safeParse({
        uuid: userId,
        roles: ['cashier'],
        companyRoleIds: []
      }).success
    ).toBe(true)
  })

  it('requires at least one actual editable field on update', () => {
    expect(updateCompanyUserInputSchema.safeParse({ uuid: userId }).success).toBe(false)
  })
})
