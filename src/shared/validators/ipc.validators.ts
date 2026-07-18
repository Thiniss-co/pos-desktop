import { z } from 'zod'
import { activationInputSchema } from '@shared/contracts/activation.contract'
import { loginInputSchema } from '@shared/contracts/auth.contract'

export const systemGetRuntimeInfoInputSchema = z.undefined()
export const deviceGetIdentitySummaryInputSchema = z.undefined()
export const deviceRegisterInputSchema = activationInputSchema
export const authGetSessionSummaryInputSchema = z.undefined()
export const authLoginInputSchema = loginInputSchema
export const authRefreshSessionInputSchema = z.undefined()
export const authLogoutInputSchema = z.undefined()
export const licenseValidateInputSchema = z.undefined()
export const bootstrapGetStatusInputSchema = z.undefined()
export const bootstrapRefreshInputSchema = z.undefined()
export const syncGetStatusInputSchema = z.undefined()
