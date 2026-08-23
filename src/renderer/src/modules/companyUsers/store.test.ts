import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { publicAppErrorSchema } from '@shared/contracts/api.contract'
import type {
  AssignableRoles,
  CompanyUser,
  CompanyUserAccess,
  CompanyUserList
} from '@shared/contracts/company-users.contract'
import { CompanyUsersService } from './service'
import { useCompanyUsersStore } from './store'

const user: CompanyUser = {
  uuid: '22222222-2222-4222-8222-222222222222',
  name: 'Cashier One',
  email: 'cashier@example.test',
  isActive: true,
  roles: ['cashier'],
  createdAt: null,
  updatedAt: null
}

const list: CompanyUserList = {
  users: [user],
  page: { page: 1, perPage: 25, total: 1, lastPage: 1 }
}

const roles: AssignableRoles = {
  systemRoles: [{ key: 'cashier', label: 'Cashier', assignable: true }],
  companyRoles: []
}

function serviceFor(
  access: CompanyUserAccess,
  overrides: Partial<Window['posApi']['companyUsers']> = {}
): CompanyUsersService {
  return new CompanyUsersService({
    getAccess: async () => ({ ok: true, data: access }),
    list: async () => ({ ok: true, data: list }),
    get: async () => ({ ok: true, data: user }),
    create: async () => ({ ok: true, data: user }),
    update: async () => ({ ok: true, data: user }),
    setRoles: async () => ({ ok: true, data: user }),
    setEnabled: async () => ({ ok: true, data: user }),
    listAssignableRoles: async () => ({ ok: true, data: roles }),
    ...overrides
  })
}

describe('useCompanyUsersStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('does not list users when the current bootstrap permission allows management but not viewing', async () => {
    const gateway = {
      getAccess: async () => ({
        ok: true,
        data: { canView: false, canManage: true, userLimit: 5 }
      }),
      list: vi.fn(async () => ({ ok: true as const, data: list })),
      get: async () => ({ ok: true, data: user }),
      create: async () => ({ ok: true, data: user }),
      update: async () => ({ ok: true, data: user }),
      setRoles: async () => ({ ok: true, data: user }),
      setEnabled: async () => ({ ok: true, data: user }),
      listAssignableRoles: async () => ({ ok: true, data: roles })
    } satisfies Window['posApi']['companyUsers']
    const store = useCompanyUsersStore()

    await store.initialize(new CompanyUsersService(gateway))

    expect(gateway.list).not.toHaveBeenCalled()
    expect(store.list).toBeNull()
  })

  it('clears management state after a server-side permission denial', async () => {
    const denied = publicAppErrorSchema.parse({
      category: 'authorization',
      message: 'Permission denied',
      retryable: false,
      backendCode: 'PERMISSION_DENIED'
    })
    const store = useCompanyUsersStore()
    const service = serviceFor(
      { canView: true, canManage: true, userLimit: 5 },
      { create: async () => ({ ok: false, error: denied }) }
    )

    await store.initialize(service)
    await store.loadAssignableRoles(service)
    const created = await store.create(
      {
        name: 'Cashier Two',
        email: 'cashier.two@example.test',
        password: 'password123',
        roles: ['cashier'],
        companyRoleIds: []
      },
      service
    )

    expect(created).toBeNull()
    expect(store.access).toEqual({ canView: false, canManage: false, userLimit: 5 })
    expect(store.list).toBeNull()
    expect(store.assignableRoles).toBeNull()
    expect(store.error).toBe(
      'Your permission to manage company users was removed. Controls are no longer available.'
    )
  })

  it('keeps the displayed user unchanged when the server denies a role assignment', async () => {
    const denied = publicAppErrorSchema.parse({
      category: 'authorization',
      message: 'Role assignment is not allowed.',
      retryable: false,
      backendCode: 'ROLE_ASSIGNMENT_FORBIDDEN'
    })
    const store = useCompanyUsersStore()
    const service = serviceFor(
      { canView: true, canManage: true, userLimit: 5 },
      { setRoles: async () => ({ ok: false, error: denied }) }
    )

    await store.initialize(service)
    const result = await store.setRoles(
      { uuid: user.uuid, roles: ['company_admin'], companyRoleIds: [] },
      service
    )

    expect(result).toBeNull()
    expect(store.list).toEqual(list)
    expect(store.selectedUser).toBeNull()
    expect(store.error).toBe('You are not allowed to assign that role.')
  })
})
