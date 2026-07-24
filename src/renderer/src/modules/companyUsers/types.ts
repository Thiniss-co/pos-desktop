import type {
  AssignableRoles,
  CompanyUser,
  CompanyUserAccess,
  CompanyUserList,
  ListUsersInput
} from '@shared/contracts/company-users.contract'

export type CompanyUsersDisplayState = CompanyUserList | null
export type CompanyUsersAccessState = CompanyUserAccess | null
export type CompanyUsersRoleState = AssignableRoles | null
export type CompanyUsersQuery = ListUsersInput
export type CompanyUserDetailState = CompanyUser | null
