import type {
  AssignableRoles,
  CompanyUser,
  CompanyUserAccess,
  CompanyUserList,
  CreateCompanyUserInput,
  ListUsersInput,
  SetEnabledInput,
  SetRolesInput,
  UpdateCompanyUserInput
} from '@shared/contracts/company-users.contract'
import { unwrapIpcResult } from '@renderer/shared/utils/unwrapIpcResult'
import { toIpcPayload } from '@renderer/shared/utils/ipcPayload'

export class CompanyUsersService {
  constructor(
    private readonly gateway: Window['posApi']['companyUsers'] = window.posApi.companyUsers
  ) {}

  async getAccess(): Promise<CompanyUserAccess> {
    return unwrapIpcResult(await this.gateway.getAccess())
  }

  async list(input: ListUsersInput): Promise<CompanyUserList> {
    return unwrapIpcResult(await this.gateway.list(toIpcPayload(input)))
  }

  async get(uuid: string): Promise<CompanyUser> {
    return unwrapIpcResult(await this.gateway.get({ uuid }))
  }

  async create(input: CreateCompanyUserInput): Promise<CompanyUser> {
    return unwrapIpcResult(await this.gateway.create(toIpcPayload(input)))
  }

  async update(input: UpdateCompanyUserInput): Promise<CompanyUser> {
    return unwrapIpcResult(await this.gateway.update(toIpcPayload(input)))
  }

  async setRoles(input: SetRolesInput): Promise<CompanyUser> {
    return unwrapIpcResult(await this.gateway.setRoles(toIpcPayload(input)))
  }

  async setEnabled(input: SetEnabledInput): Promise<CompanyUser> {
    return unwrapIpcResult(await this.gateway.setEnabled(toIpcPayload(input)))
  }

  async listAssignableRoles(): Promise<AssignableRoles> {
    return unwrapIpcResult(await this.gateway.listAssignableRoles())
  }
}
