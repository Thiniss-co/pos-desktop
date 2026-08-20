import { z } from 'zod'
import { activationInputSchema } from '@shared/contracts/activation.contract'
import { loginInputSchema } from '@shared/contracts/auth.contract'
import {
  companyUserIdInputSchema,
  createCompanyUserInputSchema,
  listUsersInputSchema,
  setEnabledInputSchema,
  setRolesInputSchema,
  updateCompanyUserInputSchema
} from '@shared/contracts/company-users.contract'

export const systemGetRuntimeInfoInputSchema = z.undefined()
export const deviceGetIdentitySummaryInputSchema = z.undefined()
export const deviceRegisterInputSchema = activationInputSchema
export const authGetSessionSummaryInputSchema = z.undefined()
export const authLoginInputSchema = loginInputSchema
export const authRefreshSessionInputSchema = z.undefined()
export const authLogoutInputSchema = z.undefined()
export const licenseValidateInputSchema = z.undefined()
export const licenseGetAccessInputSchema = z.undefined()
export const bootstrapGetStatusInputSchema = z.undefined()
export const bootstrapRefreshInputSchema = z.undefined()
export const syncGetStatusInputSchema = z.undefined()
export const companyUsersGetAccessInputSchema = z.undefined()
export const companyUsersListInputSchema = listUsersInputSchema
export const companyUsersGetInputSchema = companyUserIdInputSchema
export const companyUsersCreateInputSchema = createCompanyUserInputSchema
export const companyUsersUpdateInputSchema = updateCompanyUserInputSchema
export const companyUsersSetRolesInputSchema = setRolesInputSchema
export const companyUsersSetEnabledInputSchema = setEnabledInputSchema
export const companyUsersListAssignableRolesInputSchema = z.undefined()
