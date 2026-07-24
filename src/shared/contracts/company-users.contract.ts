import { z } from 'zod'

export const companyUserSystemRoleSchema = z.enum(['company_admin', 'manager', 'cashier'])

const companyUserNameSchema = z.string().trim().min(1).max(255)
const companyUserEmailSchema = z.string().trim().email().max(255)
const companyUserPasswordSchema = z.string().min(8).max(255)
const companyRoleIdsSchema = z.array(z.uuid()).max(100)
const systemRolesSchema = z.array(companyUserSystemRoleSchema).max(3)

function hasAtLeastOneRole(value: {
  roles?: readonly string[]
  companyRoleIds?: readonly string[]
}): boolean {
  return (value.roles?.length ?? 0) + (value.companyRoleIds?.length ?? 0) > 0
}

export const companyUserSchema = z
  .object({
    uuid: z.uuid(),
    name: companyUserNameSchema,
    email: companyUserEmailSchema,
    isActive: z.boolean(),
    roles: z.array(z.string().trim().min(1).max(255)),
    createdAt: z.string().nullable(),
    updatedAt: z.string().nullable()
  })
  .strict()

export type CompanyUser = z.infer<typeof companyUserSchema>

export const companyUserListItemSchema = companyUserSchema
export type CompanyUserListItem = z.infer<typeof companyUserListItemSchema>

export const companyUserPageSchema = z
  .object({
    page: z.number().int().positive(),
    perPage: z.number().int().positive().max(100),
    total: z.number().int().nonnegative(),
    lastPage: z.number().int().positive()
  })
  .strict()

export const companyUserListSchema = z
  .object({
    users: z.array(companyUserListItemSchema),
    page: companyUserPageSchema
  })
  .strict()

export type CompanyUserList = z.infer<typeof companyUserListSchema>

export const assignableSystemRoleSchema = z
  .object({
    key: companyUserSystemRoleSchema,
    label: z.string().trim().min(1).max(255),
    assignable: z.boolean()
  })
  .strict()

export const assignableCompanyRoleSchema = z
  .object({
    uuid: z.uuid(),
    name: z.string().trim().min(1).max(255),
    isActive: z.boolean()
  })
  .strict()

export const assignableRolesSchema = z
  .object({
    systemRoles: z.array(assignableSystemRoleSchema),
    companyRoles: z.array(assignableCompanyRoleSchema)
  })
  .strict()

export type AssignableRoles = z.infer<typeof assignableRolesSchema>

export const createCompanyUserInputSchema = z
  .object({
    name: companyUserNameSchema,
    email: companyUserEmailSchema,
    password: companyUserPasswordSchema,
    roles: systemRolesSchema.default([]),
    companyRoleIds: companyRoleIdsSchema.default([])
  })
  .strict()
  .refine(hasAtLeastOneRole, {
    message: 'At least one system or company role is required.',
    path: ['roles']
  })

export type CreateCompanyUserInput = z.infer<typeof createCompanyUserInputSchema>

export const updateCompanyUserInputSchema = z
  .object({
    uuid: z.uuid(),
    name: companyUserNameSchema.optional(),
    email: companyUserEmailSchema.optional(),
    password: companyUserPasswordSchema.optional(),
    roles: systemRolesSchema.optional(),
    companyRoleIds: companyRoleIdsSchema.optional()
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      value.email !== undefined ||
      value.password !== undefined ||
      value.roles !== undefined ||
      value.companyRoleIds !== undefined,
    { message: 'At least one editable field is required.' }
  )
  .refine(
    (value) =>
      value.roles === undefined || value.companyRoleIds === undefined || hasAtLeastOneRole(value),
    {
      message: 'At least one system or company role is required.',
      path: ['roles']
    }
  )

export type UpdateCompanyUserInput = z.infer<typeof updateCompanyUserInputSchema>

export const setRolesInputSchema = z
  .object({
    uuid: z.uuid(),
    roles: systemRolesSchema,
    companyRoleIds: companyRoleIdsSchema
  })
  .strict()
  .refine(hasAtLeastOneRole, {
    message: 'At least one system or company role is required.',
    path: ['roles']
  })

export type SetRolesInput = z.infer<typeof setRolesInputSchema>

export const setEnabledInputSchema = z
  .object({
    uuid: z.uuid(),
    enabled: z.boolean()
  })
  .strict()

export type SetEnabledInput = z.infer<typeof setEnabledInputSchema>

export const companyUserIdInputSchema = z.object({ uuid: z.uuid() }).strict()
export type CompanyUserIdInput = z.infer<typeof companyUserIdInputSchema>

export const listUsersInputSchema = z
  .object({
    search: z.string().trim().max(255).optional(),
    isActive: z.boolean().optional(),
    role: companyUserSystemRoleSchema.optional(),
    page: z.number().int().positive().optional(),
    perPage: z.number().int().positive().max(100).optional()
  })
  .strict()

export type ListUsersInput = z.infer<typeof listUsersInputSchema>

export const companyUserAccessSchema = z
  .object({
    canView: z.boolean(),
    canManage: z.boolean(),
    userLimit: z.number().int().nonnegative().nullable()
  })
  .strict()

export type CompanyUserAccess = z.infer<typeof companyUserAccessSchema>
