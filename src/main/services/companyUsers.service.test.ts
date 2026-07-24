import { describe, expect, it, vi } from 'vitest'
import { DesktopApiClient } from '../http/desktopApiClient'
import { CompanyUsersService } from './companyUsers.service'

const deviceUuid = '00000000-0000-4000-8000-000000000001'
const userUuid = '22222222-2222-4222-8222-222222222222'
const roleUuid = '11111111-1111-4111-8111-111111111111'

function userResource(): Record<string, unknown> {
  return {
    id: userUuid,
    uuid: userUuid,
    name: 'Cashier One',
    email: 'cashier@example.test',
    company_id: 42,
    is_active: true,
    roles: ['cashier'],
    created_at: '2026-07-24T10:00:00Z',
    updated_at: '2026-07-24T10:00:00Z'
  }
}

function envelope(data: unknown, meta: Record<string, unknown> = {}): Record<string, unknown> {
  return { success: true, message: 'OK', code: 'SUCCESS', data, meta }
}

describe('CompanyUsersService', () => {
  it('keeps company identifiers and credentials in main while using the exact desktop routes', async () => {
    const calls: Array<{ url: URL; init?: RequestInit }> = []
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      calls.push({ url, init })

      if (url.pathname.endsWith('/assignable-roles')) {
        return new Response(
          JSON.stringify(
            envelope({
              system_roles: [{ key: 'cashier', label: 'Cashier', assignable: true }],
              company_roles: [{ uuid: roleUuid, name: 'Seller', is_active: true }]
            })
          ),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }

      if (init?.method === 'GET' && url.pathname.endsWith('/company/users')) {
        return new Response(
          JSON.stringify(
            envelope([userResource()], {
              current_page: 1,
              per_page: 25,
              total: 1,
              last_page: 1
            })
          ),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }

      return new Response(JSON.stringify(envelope(userResource())), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })
    const apiClient = new DesktopApiClient({
      apiOrigin: new URL('https://api.example.test'),
      getAccessToken: () => 'main-owned-token',
      getDeviceUuid: () => deviceUuid,
      fetchImplementation: fetchImplementation as unknown as typeof fetch
    })
    const service = new CompanyUsersService(apiClient, {
      getPermissions: () => ['users.view', 'users.manage'],
      getLimit: () => 5
    })

    expect(service.getAccess()).toEqual({ canView: true, canManage: true, userLimit: 5 })

    await expect(service.list({ search: 'Cashier', isActive: true, page: 1 })).resolves.toEqual({
      users: [
        {
          uuid: userUuid,
          name: 'Cashier One',
          email: 'cashier@example.test',
          isActive: true,
          roles: ['cashier'],
          createdAt: '2026-07-24T10:00:00Z',
          updatedAt: '2026-07-24T10:00:00Z'
        }
      ],
      page: { page: 1, perPage: 25, total: 1, lastPage: 1 }
    })

    await service.create({
      name: 'Cashier One',
      email: 'cashier@example.test',
      password: 'password123',
      roles: ['cashier'],
      companyRoleIds: [roleUuid]
    })
    await service.setRoles({ uuid: userUuid, roles: ['cashier'], companyRoleIds: [roleUuid] })
    await service.setEnabled({ uuid: userUuid, enabled: false })
    await expect(service.listAssignableRoles()).resolves.toEqual({
      systemRoles: [{ key: 'cashier', label: 'Cashier', assignable: true }],
      companyRoles: [{ uuid: roleUuid, name: 'Seller', isActive: true }]
    })

    expect(calls[0]?.url.pathname).toBe('/api/v1/desktop/company/users')
    expect(calls[0]?.url.searchParams.get('filter[is_active]')).toBe('1')
    const headers = new Headers(calls[0]?.init?.headers)
    expect(headers.get('Authorization')).toBe('Bearer main-owned-token')
    expect(headers.get('X-Device-UUID')).toBe(deviceUuid)
    expect(calls[1]?.init?.method).toBe('POST')
    expect(calls[1]?.url.pathname).toBe('/api/v1/desktop/company/users')
    expect(JSON.parse(calls[1]?.init?.body as string)).toEqual({
      name: 'Cashier One',
      email: 'cashier@example.test',
      password: 'password123',
      roles: ['cashier'],
      company_role_ids: [roleUuid]
    })
    expect(calls[2]?.init?.method).toBe('PUT')
    expect(calls[2]?.url.pathname).toBe(`/api/v1/desktop/company/users/${userUuid}`)
    expect(calls[3]?.url.pathname).toBe(`/api/v1/desktop/company/users/${userUuid}/deactivate`)
    expect(JSON.stringify(await service.get(userUuid))).not.toContain('company_id')
  })

  it('does not create a local queue entry when the online request is unavailable', async () => {
    const apiClient = new DesktopApiClient({
      apiOrigin: new URL('https://api.example.test'),
      getAccessToken: () => 'main-owned-token',
      getDeviceUuid: () => deviceUuid,
      fetchImplementation: vi.fn(async () => {
        throw new Error('offline')
      })
    })
    const service = new CompanyUsersService(apiClient, {
      getPermissions: () => ['users.manage'],
      getLimit: () => null
    })

    await expect(
      service.create({
        name: 'Cashier One',
        email: 'cashier@example.test',
        password: 'password123',
        roles: ['cashier'],
        companyRoleIds: []
      })
    ).rejects.toMatchObject({ category: 'transport' })
  })
})
