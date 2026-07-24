import {
  assignableRolesSchema,
  companyUserAccessSchema,
  companyUserListSchema,
  companyUserSchema,
  createCompanyUserInputSchema,
  listUsersInputSchema,
  setEnabledInputSchema,
  setRolesInputSchema,
  updateCompanyUserInputSchema,
  type AssignableRoles,
  type CompanyUser,
  type CompanyUserAccess,
  type CompanyUserList,
  type CreateCompanyUserInput,
  type ListUsersInput,
  type SetEnabledInput,
  type SetRolesInput,
  type UpdateCompanyUserInput
} from '@shared/contracts/company-users.contract'
import { DESKTOP_API_ROUTES, type DesktopApiRoute } from '@shared/constants/apiRoutes'
import type { DesktopApiClient } from '../http/desktopApiClient'
import {
  assignableRoleResourceSchema,
  companyUserResourceSchema,
  paginationMetaResourceSchema,
  type CompanyUserResource
} from '../http/desktopResources.contract'

export interface CompanyUsersBootstrapReader {
  getPermissions(): string[]
  getLimit(key: string): number | null
}

function routeForUser(route: DesktopApiRoute, uuid: string, suffix = ''): DesktopApiRoute {
  return { ...route, path: `${route.path}/${uuid}${suffix}` }
}

function mapCompanyUser(resource: CompanyUserResource): CompanyUser {
  return companyUserSchema.parse({
    uuid: resource.uuid,
    name: resource.name,
    email: resource.email,
    isActive: resource.is_active,
    roles: resource.roles,
    createdAt: resource.created_at ?? null,
    updatedAt: resource.updated_at ?? null
  })
}

function listRoute(input: ListUsersInput): DesktopApiRoute {
  const query = new URLSearchParams()

  if (input.search) {
    query.set('search', input.search)
  }

  if (input.isActive !== undefined) {
    query.set('filter[is_active]', input.isActive ? '1' : '0')
  }

  if (input.role) {
    query.set('filter[role]', input.role)
  }

  if (input.page) {
    query.set('page', String(input.page))
  }

  if (input.perPage) {
    query.set('per_page', String(input.perPage))
  }

  const suffix = query.toString()

  return {
    ...DESKTOP_API_ROUTES.companyUsersList,
    path: suffix
      ? `${DESKTOP_API_ROUTES.companyUsersList.path}?${suffix}`
      : DESKTOP_API_ROUTES.companyUsersList.path
  }
}

export class CompanyUsersService {
  constructor(
    private readonly apiClient: DesktopApiClient,
    private readonly bootstrap: CompanyUsersBootstrapReader
  ) {}

  getAccess(): CompanyUserAccess {
    const permissions = new Set(this.bootstrap.getPermissions())

    return companyUserAccessSchema.parse({
      canView: permissions.has('users.view'),
      canManage: permissions.has('users.manage'),
      userLimit: this.bootstrap.getLimit('users')
    })
  }

  async list(rawInput: ListUsersInput): Promise<CompanyUserList> {
    const input = listUsersInputSchema.parse(rawInput)
    const response = await this.apiClient.requestWithMeta<unknown>(listRoute(input))
    const resources = companyUserResourceSchema.array().parse(response.data)
    const page = paginationMetaResourceSchema.parse(response.meta)

    return companyUserListSchema.parse({
      users: resources.map(mapCompanyUser),
      page: {
        page: page.current_page,
        perPage: page.per_page,
        total: page.total,
        lastPage: page.last_page
      }
    })
  }

  async get(uuid: string): Promise<CompanyUser> {
    const resource = companyUserResourceSchema.parse(
      await this.apiClient.request<unknown>(routeForUser(DESKTOP_API_ROUTES.companyUsersGet, uuid))
    )

    return mapCompanyUser(resource)
  }

  async create(rawInput: CreateCompanyUserInput): Promise<CompanyUser> {
    const input = createCompanyUserInputSchema.parse(rawInput)
    const resource = companyUserResourceSchema.parse(
      await this.apiClient.request<unknown>(DESKTOP_API_ROUTES.companyUsersCreate, {
        name: input.name,
        email: input.email,
        password: input.password,
        roles: input.roles,
        company_role_ids: input.companyRoleIds
      })
    )

    return mapCompanyUser(resource)
  }

  async update(rawInput: UpdateCompanyUserInput): Promise<CompanyUser> {
    const input = updateCompanyUserInputSchema.parse(rawInput)
    const body: Record<string, unknown> = {}

    if (input.name !== undefined) {
      body.name = input.name
    }
    if (input.email !== undefined) {
      body.email = input.email
    }
    if (input.password !== undefined) {
      body.password = input.password
    }
    if (input.roles !== undefined) {
      body.roles = input.roles
    }
    if (input.companyRoleIds !== undefined) {
      body.company_role_ids = input.companyRoleIds
    }

    const resource = companyUserResourceSchema.parse(
      await this.apiClient.request<unknown>(
        routeForUser(DESKTOP_API_ROUTES.companyUsersUpdate, input.uuid),
        body
      )
    )

    return mapCompanyUser(resource)
  }

  async setRoles(rawInput: SetRolesInput): Promise<CompanyUser> {
    const input = setRolesInputSchema.parse(rawInput)
    const resource = companyUserResourceSchema.parse(
      await this.apiClient.request<unknown>(
        routeForUser(DESKTOP_API_ROUTES.companyUsersUpdate, input.uuid),
        {
          roles: input.roles,
          company_role_ids: input.companyRoleIds
        }
      )
    )

    return mapCompanyUser(resource)
  }

  async setEnabled(rawInput: SetEnabledInput): Promise<CompanyUser> {
    const input = setEnabledInputSchema.parse(rawInput)
    const route = input.enabled
      ? routeForUser(DESKTOP_API_ROUTES.companyUsersActivate, input.uuid, '/activate')
      : routeForUser(DESKTOP_API_ROUTES.companyUsersDeactivate, input.uuid, '/deactivate')
    const resource = companyUserResourceSchema.parse(await this.apiClient.request<unknown>(route))

    return mapCompanyUser(resource)
  }

  async listAssignableRoles(): Promise<AssignableRoles> {
    const resource = assignableRoleResourceSchema.parse(
      await this.apiClient.request<unknown>(DESKTOP_API_ROUTES.companyAssignableRoles)
    )

    return assignableRolesSchema.parse({
      systemRoles: resource.system_roles,
      companyRoles: resource.company_roles.map((role) => ({
        uuid: role.uuid,
        name: role.name,
        isActive: role.is_active
      }))
    })
  }
}
