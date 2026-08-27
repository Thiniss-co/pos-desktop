import { z } from 'zod'
import { activationInputSchema } from '@shared/contracts/activation.contract'
import { loginInputSchema } from '@shared/contracts/auth.contract'
import {
  catalogBarcodeInputSchema,
  catalogCustomerSearchInputSchema,
  catalogProductIdInputSchema,
  catalogSearchInputSchema
} from '@shared/contracts/catalog.contract'
import { checkoutIntentSchema } from '@shared/contracts/checkout.contract'
import { localeCodeSchema, themePreferenceSchema } from '@shared/contracts/preferences.contract'
import {
  closeShiftInputSchema,
  openShiftInputSchema,
  pauseShiftInputSchema,
  resumeShiftInputSchema,
  shiftIdInputSchema
} from '@shared/contracts/shift.contract'
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
export const catalogGetStatusInputSchema = z.undefined()
export const catalogListCategoriesInputSchema = z.undefined()
export const catalogSearchProductsInputSchema = catalogSearchInputSchema
export const catalogGetProductInputSchema = catalogProductIdInputSchema
export const catalogFindByBarcodeInputSchema = catalogBarcodeInputSchema
export const catalogListPaymentMethodsInputSchema = z.undefined()
export const catalogSearchCustomersInputSchema = catalogCustomerSearchInputSchema
export const catalogGetCustomerInputSchema = catalogProductIdInputSchema
export const shiftsCurrentInputSchema = z.undefined()
export const shiftsGetInputSchema = shiftIdInputSchema
export const shiftsOpenInputSchema = openShiftInputSchema
export const shiftsPauseInputSchema = pauseShiftInputSchema
export const shiftsResumeInputSchema = resumeShiftInputSchema
export const shiftsCloseInputSchema = closeShiftInputSchema
export const checkoutValidateInputSchema = checkoutIntentSchema
export const syncGetStatusInputSchema = z.undefined()
export const connectivityGetStateInputSchema = z.undefined()
export const connectivityCheckNowInputSchema = z.undefined()
export const preferencesGetLocaleInputSchema = z.undefined()
export const preferencesSetLocaleInputSchema = localeCodeSchema
export const preferencesGetThemeInputSchema = z.undefined()
export const preferencesSetThemeInputSchema = themePreferenceSchema
export const companyUsersGetAccessInputSchema = z.undefined()
export const companyUsersListInputSchema = listUsersInputSchema
export const companyUsersGetInputSchema = companyUserIdInputSchema
export const companyUsersCreateInputSchema = createCompanyUserInputSchema
export const companyUsersUpdateInputSchema = updateCompanyUserInputSchema
export const companyUsersSetRolesInputSchema = setRolesInputSchema
export const companyUsersSetEnabledInputSchema = setEnabledInputSchema
export const companyUsersListAssignableRolesInputSchema = z.undefined()
