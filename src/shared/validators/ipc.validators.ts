import { z } from 'zod'
import { activationInputSchema } from '@shared/contracts/activation.contract'
import { loginInputSchema } from '@shared/contracts/auth.contract'
import {
  catalogBarcodeInputSchema,
  catalogCustomerSearchInputSchema,
  catalogProductIdInputSchema,
  catalogSearchInputSchema
} from '@shared/contracts/catalog.contract'
import {
  checkoutAbandonAttemptInputSchema as checkoutAbandonAttemptContractSchema,
  checkoutAcknowledgeAttemptInputSchema as checkoutAcknowledgeAttemptContractSchema,
  checkoutAttemptStatusInputSchema as checkoutAttemptStatusContractSchema,
  checkoutCompleteInputSchema as checkoutCompleteContractSchema,
  checkoutIntentSchema,
  checkoutPendingAttemptsInputSchema as checkoutPendingAttemptsContractSchema,
  checkoutRetryAttemptInputSchema as checkoutRetryAttemptContractSchema
} from '@shared/contracts/checkout.contract'
import {
  localeCodeSchema,
  posCartWidthPreferenceSchema,
  themePreferenceSchema
} from '@shared/contracts/preferences.contract'
import { syncListFailuresInputSchema as syncListFailuresContractSchema } from '@shared/contracts/sync.contract'
import {
  printerSettingsSchema,
  printingPreviewInputSchema as printingPreviewContractSchema,
  printingDispatchInputSchema as printingDispatchContractSchema,
  printingGetJobInputSchema as printingGetJobContractSchema,
  printingCancelJobInputSchema as printingCancelJobContractSchema,
  printingLatestForDocumentInputSchema as printingLatestForDocumentContractSchema,
  receiptProfilePublishInputSchema as receiptProfilePublishContractSchema
} from '@shared/contracts/printing.contract'
import {
  refundsCancelPreparedInputSchema as refundsCancelPreparedContractSchema,
  refundsPreviewInputSchema as refundsPreviewContractSchema,
  refundsResumeInputSchema as refundsResumeContractSchema,
  refundsSubmitInputSchema as refundsSubmitContractSchema,
  refundsGetRefundableInputSchema as refundsGetRefundableContractSchema,
  salesGetInvoiceInputSchema as salesGetInvoiceContractSchema,
  salesListInvoicesInputSchema as salesListInvoicesContractSchema
} from '@shared/contracts/refund.contract'
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
/**
 * `catalog:refresh` takes no caller-supplied field at all — not even an empty object. Every
 * identity the refresh acts on (company, device, user, and the authorization to refresh) is
 * re-derived main-side from the authenticated session and the bound device, so the renderer has
 * nothing legitimate to send and any payload is rejected.
 */
export const catalogRefreshInputSchema = z.undefined()
export const catalogListCategoriesInputSchema = z.undefined()
export const catalogSearchProductsInputSchema = catalogSearchInputSchema
export const catalogGetProductInputSchema = catalogProductIdInputSchema
export const catalogGetProductForSaleInputSchema = catalogProductIdInputSchema
export const catalogFindByBarcodeInputSchema = catalogBarcodeInputSchema
export const catalogListPaymentMethodsInputSchema = z.undefined()
export const catalogSearchCustomersInputSchema = catalogCustomerSearchInputSchema
export const catalogGetCustomerInputSchema = catalogProductIdInputSchema
export const shiftsCurrentInputSchema = z.undefined()
export const shiftsLocalAuthorityInputSchema = z.undefined()
export const shiftsGetInputSchema = shiftIdInputSchema
export const shiftsOpenInputSchema = openShiftInputSchema
export const shiftsPauseInputSchema = pauseShiftInputSchema
export const shiftsResumeInputSchema = resumeShiftInputSchema
export const shiftsCloseInputSchema = closeShiftInputSchema
export const checkoutValidateInputSchema = checkoutIntentSchema
export const checkoutCompleteInputSchema = checkoutCompleteContractSchema
export const checkoutPendingAttemptsInputSchema = checkoutPendingAttemptsContractSchema
export const checkoutRetryAttemptInputSchema = checkoutRetryAttemptContractSchema
export const checkoutAbandonAttemptInputSchema = checkoutAbandonAttemptContractSchema
export const checkoutAcknowledgeAttemptInputSchema = checkoutAcknowledgeAttemptContractSchema
export const checkoutAttemptStatusInputSchema = checkoutAttemptStatusContractSchema
/**
 * CP4: both preparation channels take an empty, strict object.
 *
 * `.strict()` on an empty shape is the point: a renderer cannot smuggle a product set, a quantity,
 * a duration, an owner tuple, or a clock through either channel, because any key at all is a
 * validation failure. §4's invariant that the renderer supplies no authoritative quantity,
 * ownership, time, or grant right is enforced here rather than trusted.
 */
export const offlineSaleGetReadinessInputSchema = z.object({}).strict()
export const preparationGetReadinessInputSchema = z.object({}).strict()
export const preparationRunCycleInputSchema = z.object({}).strict()

export const allocationRecoveryStartInputSchema = z.object({ allocationUuid: z.uuid() }).strict()
export const syncGetStatusInputSchema = z.undefined()
export const syncUploadNowInputSchema = z.undefined()
export const syncListFailuresInputSchema = syncListFailuresContractSchema
export const syncSupportIssuesInputSchema = z.undefined()
export const connectivityGetStateInputSchema = z.undefined()
export const connectivityCheckNowInputSchema = z.undefined()
export const preferencesGetLocaleInputSchema = z.undefined()
export const preferencesSetLocaleInputSchema = localeCodeSchema
export const preferencesGetThemeInputSchema = z.undefined()
export const preferencesSetThemeInputSchema = themePreferenceSchema
export const preferencesGetPosCartWidthInputSchema = z.undefined()
// Integer px in [320, 960], or null to restore the design default. Layout-only: no transaction
// state can ride on this channel.
export const preferencesSetPosCartWidthInputSchema = posCartWidthPreferenceSchema
export const companyUsersGetAccessInputSchema = z.undefined()
export const companyUsersListInputSchema = listUsersInputSchema
export const companyUsersGetInputSchema = companyUserIdInputSchema
export const companyUsersCreateInputSchema = createCompanyUserInputSchema
export const companyUsersUpdateInputSchema = updateCompanyUserInputSchema
export const companyUsersSetRolesInputSchema = setRolesInputSchema
export const companyUsersSetEnabledInputSchema = setEnabledInputSchema
export const companyUsersListAssignableRolesInputSchema = z.undefined()

export const salesListInvoicesInputSchema = salesListInvoicesContractSchema
export const salesGetInvoiceInputSchema = salesGetInvoiceContractSchema
export const refundsGetRefundableInputSchema = refundsGetRefundableContractSchema
export const refundsPreviewInputSchema = refundsPreviewContractSchema
export const refundsSubmitInputSchema = refundsSubmitContractSchema
export const refundsResumeInputSchema = refundsResumeContractSchema
export const refundsCancelPreparedInputSchema = refundsCancelPreparedContractSchema

export const printingGetWorkstationSettingsInputSchema = z.undefined()
export const printingSaveWorkstationSettingsInputSchema = printerSettingsSchema
export const printingListPrintersInputSchema = z.undefined()
export const printingPreviewInputSchema = printingPreviewContractSchema
export const printingDispatchInputSchema = printingDispatchContractSchema
export const printingGetJobInputSchema = printingGetJobContractSchema
export const printingCancelJobInputSchema = printingCancelJobContractSchema
export const printingLatestForDocumentInputSchema = printingLatestForDocumentContractSchema

// Receipt-printing plan §D-11: get and choose-logo take no argument at all -- the renderer can never
// name a file path, an owner or a company. Publish is the strict editor contract.
export const receiptProfileGetInputSchema = z.undefined()
export const receiptProfileChooseLogoInputSchema = z.undefined()
export const receiptProfilePublishInputSchema = receiptProfilePublishContractSchema
