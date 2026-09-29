import { ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import type { OfflineSaleReadiness } from '@shared/contracts/offlineSaleReadiness.contract'
import type { ActivationInput, ActivationResult } from '@shared/contracts/activation.contract'
import type { LoginInput, SessionSummary } from '@shared/contracts/auth.contract'
import type { BootstrapResult, BootstrapStatus } from '@shared/contracts/bootstrap.contract'
import type {
  CheckoutAbandonAttemptInput,
  CheckoutAcknowledgeAttemptInput,
  CheckoutAttemptStatus,
  CheckoutAttemptStatusInput,
  CheckoutCompleteInput,
  CheckoutCompletionOutcome,
  CheckoutIntent,
  CheckoutPendingAttemptsInput,
  CheckoutPreviewOutcome,
  CheckoutRecoveryState,
  CheckoutRetryAttemptInput
} from '@shared/contracts/checkout.contract'
import type {
  RefundableInvoice,
  RefundLineSelection,
  RefundOutcome,
  RefundPreview,
  SaleDetail,
  SalesInvoiceList
} from '@shared/contracts/refund.contract'
import type {
  PrinterInfo,
  PrinterSettings,
  PrintingDispatchInput,
  PrintingPreviewInput,
  PrintJobView,
  PrintPreviewOutput,
  ReceiptDocumentRef,
  ReceiptProfileChooseLogoOutput,
  ReceiptProfileGetOutput,
  ReceiptProfilePublishInput
} from '@shared/contracts/printing.contract'
import type {
  CatalogCategory,
  CatalogBarcodeLookup,
  CatalogCustomer,
  CatalogCustomerPage,
  CatalogCustomerSearchInput,
  CatalogPaymentMethod,
  CatalogProduct,
  CatalogProductForSale,
  CatalogProductPage,
  CatalogRefreshResult,
  CatalogSearchInput,
  CatalogStatus
} from '@shared/contracts/catalog.contract'
import type { ConnectivitySnapshot } from '@shared/contracts/connectivity.contract'
import type {
  PreparationCycleResult,
  PreparationReadiness
} from '@shared/contracts/preparation.contract'
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
import type { DeviceIdentitySummary } from '@shared/contracts/device.contract'
import type { IpcResult } from '@shared/contracts/ipc.contract'
import type { CommercialAccessSnapshot } from '@shared/contracts/license.contract'
import type { LocaleCode, ThemePreference } from '@shared/contracts/preferences.contract'
import type {
  SyncFailureCursor,
  SyncFailurePage,
  SyncStatus
} from '@shared/contracts/sync.contract'
import type { RuntimeInfo } from '@shared/contracts/system.contract'
import type {
  CloseShiftInput,
  OpenShiftInput,
  PauseShiftInput,
  ResumeShiftInput,
  Shift
} from '@shared/contracts/shift.contract'
import type { ShiftLocalAuthority } from '@shared/contracts/shiftAuthority.contract'

export interface PosApi {
  readonly system: {
    getRuntimeInfo(): Promise<IpcResult<RuntimeInfo>>
  }
  readonly device: {
    getIdentitySummary(): Promise<IpcResult<DeviceIdentitySummary>>
    register(input: ActivationInput): Promise<IpcResult<ActivationResult>>
  }
  readonly auth: {
    getSessionSummary(): Promise<IpcResult<SessionSummary>>
    login(input: LoginInput): Promise<IpcResult<SessionSummary>>
    refreshSession(): Promise<IpcResult<SessionSummary>>
    logout(): Promise<IpcResult<void>>
  }
  readonly license: {
    validate(): Promise<IpcResult<CommercialAccessSnapshot>>
    getAccess(): Promise<IpcResult<CommercialAccessSnapshot>>
    onAccessChanged(listener: (snapshot: CommercialAccessSnapshot) => void): () => void
  }
  readonly bootstrap: {
    getStatus(): Promise<IpcResult<BootstrapStatus>>
    refresh(): Promise<IpcResult<BootstrapResult>>
  }
  readonly catalog: {
    getStatus(): Promise<IpcResult<CatalogStatus>>
    refresh(): Promise<IpcResult<CatalogRefreshResult>>
    listCategories(): Promise<IpcResult<CatalogCategory[]>>
    searchProducts(input: CatalogSearchInput): Promise<IpcResult<CatalogProductPage>>
    getProduct(input: { uuid: string }): Promise<IpcResult<CatalogProduct>>
    /** Rev 3: the product, the catalog revision it was read under, and its stock view. */
    getProductForSale(input: { uuid: string }): Promise<IpcResult<CatalogProductForSale>>
    findProductByBarcode(input: { barcode: string }): Promise<IpcResult<CatalogBarcodeLookup>>
    listPaymentMethods(): Promise<IpcResult<CatalogPaymentMethod[]>>
    searchCustomers(input: CatalogCustomerSearchInput): Promise<IpcResult<CatalogCustomerPage>>
    getCustomer(input: { uuid: string }): Promise<IpcResult<CatalogCustomer>>
    /** Rev 3: main → renderer hint that catalog or stock data may have changed. */
    onChanged(listener: (change: CatalogChange) => void): () => void
  }
  readonly shifts: {
    current(): Promise<IpcResult<Shift | null>>
    localAuthority(): Promise<IpcResult<ShiftLocalAuthority>>
    get(input: { uuid: string }): Promise<IpcResult<Shift>>
    open(input: OpenShiftInput): Promise<IpcResult<Shift>>
    pause(input: PauseShiftInput): Promise<IpcResult<Shift>>
    resume(input: ResumeShiftInput): Promise<IpcResult<Shift>>
    close(input: CloseShiftInput): Promise<IpcResult<Shift>>
  }
  readonly checkout: {
    validate(input: CheckoutIntent): Promise<IpcResult<CheckoutPreviewOutcome>>
    complete(input: CheckoutCompleteInput): Promise<IpcResult<CheckoutCompletionOutcome>>
    retryAttempt(input: CheckoutRetryAttemptInput): Promise<IpcResult<CheckoutCompletionOutcome>>
    abandonAttempt(
      input: CheckoutAbandonAttemptInput
    ): Promise<IpcResult<CheckoutCompletionOutcome>>
    acknowledgeAttempt(
      input: CheckoutAcknowledgeAttemptInput
    ): Promise<IpcResult<CheckoutCompletionOutcome>>
    pendingAttempts(input: CheckoutPendingAttemptsInput): Promise<IpcResult<CheckoutRecoveryState>>
    attemptStatus(input: CheckoutAttemptStatusInput): Promise<IpcResult<CheckoutAttemptStatus>>
  }
  readonly sync: {
    getStatus(): Promise<IpcResult<SyncStatus>>
    uploadNow(): Promise<IpcResult<SyncStatus>>
    listFailures(cursor?: SyncFailureCursor | null): Promise<IpcResult<SyncFailurePage>>
    onChanged(listener: (status: SyncStatus) => void): () => void
  }
  readonly allocationRecovery: {
    start(input: { allocationUuid: string }): Promise<IpcResult<void>>
    resume(): Promise<IpcResult<void>>
  }
  /**
   * CP4: offline stock preparation. Both methods take **no arguments** — the renderer may ask for
   * preparation, but main resolves the owner, the product set, the quantities, and the clock (§5.2,
   * §4).
   */
  /** PS6 §14.3: read-only. There is deliberately no write channel on this surface. */
  readonly offlineSale: {
    getReadiness(): Promise<IpcResult<OfflineSaleReadiness>>
  }
  readonly preparation: {
    getReadiness(): Promise<IpcResult<PreparationReadiness>>
    runCycle(): Promise<IpcResult<PreparationCycleResult>>
  }
  readonly connectivity: {
    getState(): Promise<IpcResult<ConnectivitySnapshot>>
    checkNow(): Promise<IpcResult<ConnectivitySnapshot>>
    onChanged(listener: (snapshot: ConnectivitySnapshot) => void): () => void
  }
  readonly preferences: {
    getLocale(): Promise<IpcResult<LocaleCode | null>>
    setLocale(locale: LocaleCode): Promise<IpcResult<LocaleCode>>
    getTheme(): Promise<IpcResult<ThemePreference | null>>
    setTheme(theme: ThemePreference): Promise<IpcResult<ThemePreference>>
  }
  readonly companyUsers: {
    getAccess(): Promise<IpcResult<CompanyUserAccess>>
    list(input: ListUsersInput): Promise<IpcResult<CompanyUserList>>
    get(input: { uuid: string }): Promise<IpcResult<CompanyUser>>
    create(input: CreateCompanyUserInput): Promise<IpcResult<CompanyUser>>
    update(input: UpdateCompanyUserInput): Promise<IpcResult<CompanyUser>>
    setRoles(input: SetRolesInput): Promise<IpcResult<CompanyUser>>
    setEnabled(input: SetEnabledInput): Promise<IpcResult<CompanyUser>>
    listAssignableRoles(): Promise<IpcResult<AssignableRoles>>
  }
  readonly sales: {
    listInvoices(input: {
      search?: string
      limit?: number
      cursor?: string | null
    }): Promise<IpcResult<SalesInvoiceList>>
    getInvoice(input: { invoiceLocalUuid: string }): Promise<IpcResult<SaleDetail>>
  }
  readonly refunds: {
    getRefundable(input: { invoiceLocalUuid: string }): Promise<IpcResult<RefundableInvoice>>
    preview(input: {
      invoiceLocalUuid: string
      lines: RefundLineSelection[]
      stockReturned: boolean
    }): Promise<IpcResult<RefundPreview>>
    submit(input: {
      previewId: string
      invoiceLocalUuid: string
      lines: RefundLineSelection[]
      stockReturned: boolean
      paymentMethodUuid: string | null
      reference?: string | null
      reason?: string | null
      notes?: string | null
    }): Promise<IpcResult<RefundOutcome>>
    resume(input: { localRefundUuid: string }): Promise<IpcResult<RefundOutcome>>
    cancelPrepared(input: { localRefundUuid: string }): Promise<IpcResult<{ cancelled: boolean }>>
  }
  readonly printing: {
    getWorkstationSettings(): Promise<IpcResult<PrinterSettings>>
    saveWorkstationSettings(settings: PrinterSettings): Promise<IpcResult<PrinterSettings>>
    listPrinters(): Promise<IpcResult<PrinterInfo[]>>
    preview(input: PrintingPreviewInput): Promise<IpcResult<PrintPreviewOutput>>
    dispatch(input: PrintingDispatchInput): Promise<IpcResult<PrintJobView>>
    getJob(input: { requestId: string }): Promise<IpcResult<PrintJobView>>
    cancelJob(input: { requestId: string }): Promise<IpcResult<PrintJobView>>
    latestForDocument(input: {
      document: ReceiptDocumentRef
    }): Promise<IpcResult<PrintJobView | null>>
  }
  /** Receipt-printing plan §D-11: the CompanyAdmin receipt-profile editor. No method accepts a
   *  file path; the logo file is chosen in main through the native dialog. */
  readonly receiptProfile: {
    get(): Promise<IpcResult<ReceiptProfileGetOutput>>
    chooseLogo(): Promise<IpcResult<ReceiptProfileChooseLogoOutput>>
    publish(input: ReceiptProfilePublishInput): Promise<IpcResult<ReceiptProfileGetOutput>>
  }
}

function isCountShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const counts = value as Record<string, unknown>

  return (
    typeof counts.pending === 'number' &&
    typeof counts.uploading === 'number' &&
    typeof counts.retryableError === 'number' &&
    typeof counts.conflict === 'number' &&
    typeof counts.rejected === 'number'
  )
}

/** Dependency-free structural guard for a pushed status; keeps the sandboxed bundle import-free. */
export interface CatalogChange {
  readonly reason: 'stock' | 'snapshot'
  readonly revision: string | null
}

function isCatalogChangeShape(value: unknown): value is CatalogChange {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const change = value as Record<string, unknown>
  return (
    (change.reason === 'stock' || change.reason === 'snapshot') &&
    (change.revision === null ||
      (typeof change.revision === 'string' && /^[a-f0-9]{64}$/.test(change.revision)))
  )
}

function isSyncStatusShape(value: unknown): value is SyncStatus {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const status = value as Record<string, unknown>

  return (
    (status.state === 'idle' || status.state === 'paused') &&
    (status.pausedReason === null || typeof status.pausedReason === 'string') &&
    isCountShape(status.counts)
  )
}

export const posApi: PosApi = Object.freeze({
  system: Object.freeze({
    getRuntimeInfo: () => ipcRenderer.invoke(IPC_CHANNELS.systemGetRuntimeInfo)
  }),
  device: Object.freeze({
    getIdentitySummary: () => ipcRenderer.invoke(IPC_CHANNELS.deviceGetIdentitySummary),
    register: (input: ActivationInput) => ipcRenderer.invoke(IPC_CHANNELS.deviceRegister, input)
  }),
  auth: Object.freeze({
    getSessionSummary: () => ipcRenderer.invoke(IPC_CHANNELS.authGetSessionSummary),
    login: (input: LoginInput) => ipcRenderer.invoke(IPC_CHANNELS.authLogin, input),
    refreshSession: () => ipcRenderer.invoke(IPC_CHANNELS.authRefreshSession),
    logout: () => ipcRenderer.invoke(IPC_CHANNELS.authLogout)
  }),
  license: Object.freeze({
    validate: () => ipcRenderer.invoke(IPC_CHANNELS.licenseValidate),
    getAccess: () => ipcRenderer.invoke(IPC_CHANNELS.licenseGetAccess),
    onAccessChanged: (listener: (snapshot: CommercialAccessSnapshot) => void) => {
      const subscription = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
        // The main-process publisher validates this strictly before send. The bridge deliberately
        // exposes only the renderer-safe access projection, never license or session internals.
        listener(payload as CommercialAccessSnapshot)
      }

      ipcRenderer.on(IPC_CHANNELS.licenseAccessChanged, subscription)
      return () => ipcRenderer.off(IPC_CHANNELS.licenseAccessChanged, subscription)
    }
  }),
  bootstrap: Object.freeze({
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.bootstrapGetStatus),
    refresh: () => ipcRenderer.invoke(IPC_CHANNELS.bootstrapRefresh)
  }),
  catalog: Object.freeze({
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.catalogGetStatus),
    refresh: () => ipcRenderer.invoke(IPC_CHANNELS.catalogRefresh),
    listCategories: () => ipcRenderer.invoke(IPC_CHANNELS.catalogListCategories),
    searchProducts: (input: CatalogSearchInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.catalogSearchProducts, input),
    getProduct: (input: { uuid: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.catalogGetProduct, input),
    getProductForSale: (input: { uuid: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.catalogGetProductForSale, input),
    findProductByBarcode: (input: { barcode: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.catalogFindByBarcode, input),
    listPaymentMethods: () => ipcRenderer.invoke(IPC_CHANNELS.catalogListPaymentMethods),
    searchCustomers: (input: CatalogCustomerSearchInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.catalogSearchCustomers, input),
    getCustomer: (input: { uuid: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.catalogGetCustomer, input),
    onChanged: (listener: (change: CatalogChange) => void) => {
      const subscription = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
        // Structural check only (the preload stays dependency-free); the Electron event object is
        // never handed to a renderer listener.
        if (isCatalogChangeShape(payload)) {
          listener({ reason: payload.reason, revision: payload.revision })
        }
      }

      ipcRenderer.on(IPC_CHANNELS.catalogChanged, subscription)
      return () => ipcRenderer.off(IPC_CHANNELS.catalogChanged, subscription)
    }
  }),
  shifts: Object.freeze({
    current: () => ipcRenderer.invoke(IPC_CHANNELS.shiftsCurrent),
    localAuthority: () => ipcRenderer.invoke(IPC_CHANNELS.shiftsLocalAuthority),
    get: (input: { uuid: string }) => ipcRenderer.invoke(IPC_CHANNELS.shiftsGet, input),
    open: (input: OpenShiftInput) => ipcRenderer.invoke(IPC_CHANNELS.shiftsOpen, input),
    pause: (input: PauseShiftInput) => ipcRenderer.invoke(IPC_CHANNELS.shiftsPause, input),
    resume: (input: ResumeShiftInput) => ipcRenderer.invoke(IPC_CHANNELS.shiftsResume, input),
    close: (input: CloseShiftInput) => ipcRenderer.invoke(IPC_CHANNELS.shiftsClose, input)
  }),
  checkout: Object.freeze({
    validate: (input: CheckoutIntent) => ipcRenderer.invoke(IPC_CHANNELS.checkoutValidate, input),
    complete: (input: CheckoutCompleteInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.checkoutComplete, input),
    retryAttempt: (input: CheckoutRetryAttemptInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.checkoutRetryAttempt, input),
    abandonAttempt: (input: CheckoutAbandonAttemptInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.checkoutAbandonAttempt, input),
    acknowledgeAttempt: (input: CheckoutAcknowledgeAttemptInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.checkoutAcknowledgeAttempt, input),
    pendingAttempts: (input: CheckoutPendingAttemptsInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.checkoutPendingAttempts, input),
    attemptStatus: (input: CheckoutAttemptStatusInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.checkoutAttemptStatus, input)
  }),
  sync: Object.freeze({
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.syncGetStatus),
    uploadNow: () => ipcRenderer.invoke(IPC_CHANNELS.syncUploadNow),
    // The cursor is the only thing a caller may name. There is no owner and no filter here, and
    // no numeric row index: main resolves the company/device pair from its own session.
    listFailures: (cursor?: SyncFailureCursor | null) =>
      ipcRenderer.invoke(IPC_CHANNELS.syncListFailures, { cursor: cursor ?? null }),
    onChanged: (listener: (status: SyncStatus) => void) => {
      const subscription = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
        // Main validates the status against its schema before every send. This second, structural
        // check is deliberately hand-written rather than a shared schema import: the preload runs
        // sandboxed, so it stays dependency-free (see posApiSurface.test.ts). It also guarantees
        // the Electron event object itself is never handed to a renderer listener.
        if (isSyncStatusShape(payload)) {
          listener(payload)
        }
      }

      ipcRenderer.on(IPC_CHANNELS.syncChanged, subscription)
      return () => ipcRenderer.off(IPC_CHANNELS.syncChanged, subscription)
    }
  }),
  allocationRecovery: Object.freeze({
    start: (input: { allocationUuid: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.allocationRecoveryStart, input),
    resume: () => ipcRenderer.invoke(IPC_CHANNELS.allocationRecoveryResume)
  }),
  offlineSale: Object.freeze({
    // Read-only, and takes no argument at all: main resolves the owner, the trusted clock and the
    // stored authority itself. The renderer can ask; it can never assert.
    getReadiness: () => ipcRenderer.invoke(IPC_CHANNELS.offlineSaleGetReadiness, {})
  }),
  preparation: Object.freeze({
    getReadiness: () => ipcRenderer.invoke(IPC_CHANNELS.preparationGetReadiness, {}),
    runCycle: () => ipcRenderer.invoke(IPC_CHANNELS.preparationRunCycle, {})
  }),
  connectivity: Object.freeze({
    getState: () => ipcRenderer.invoke(IPC_CHANNELS.connectivityGetState),
    checkNow: () => ipcRenderer.invoke(IPC_CHANNELS.connectivityCheckNow),
    onChanged: (listener: (snapshot: ConnectivitySnapshot) => void) => {
      const subscription = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
        // The fixed main-process event validates snapshots before broadcast. Keep this preload
        // module dependency-free so it remains compatible with Electron's sandboxed preload.
        listener(payload as ConnectivitySnapshot)
      }

      ipcRenderer.on(IPC_CHANNELS.connectivityChanged, subscription)
      return () => ipcRenderer.off(IPC_CHANNELS.connectivityChanged, subscription)
    }
  }),
  preferences: Object.freeze({
    getLocale: () => ipcRenderer.invoke(IPC_CHANNELS.preferencesGetLocale),
    setLocale: (locale: LocaleCode) =>
      ipcRenderer.invoke(IPC_CHANNELS.preferencesSetLocale, locale),
    getTheme: () => ipcRenderer.invoke(IPC_CHANNELS.preferencesGetTheme),
    setTheme: (theme: ThemePreference) =>
      ipcRenderer.invoke(IPC_CHANNELS.preferencesSetTheme, theme)
  }),
  companyUsers: Object.freeze({
    getAccess: () => ipcRenderer.invoke(IPC_CHANNELS.companyUsersGetAccess),
    list: (input: ListUsersInput) => ipcRenderer.invoke(IPC_CHANNELS.companyUsersList, input),
    get: (input: { uuid: string }) => ipcRenderer.invoke(IPC_CHANNELS.companyUsersGet, input),
    create: (input: CreateCompanyUserInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.companyUsersCreate, input),
    update: (input: UpdateCompanyUserInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.companyUsersUpdate, input),
    setRoles: (input: SetRolesInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.companyUsersSetRoles, input),
    setEnabled: (input: SetEnabledInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.companyUsersSetEnabled, input),
    listAssignableRoles: () => ipcRenderer.invoke(IPC_CHANNELS.companyUsersListAssignableRoles)
  }),
  sales: Object.freeze({
    listInvoices: (input: { search?: string; limit?: number; cursor?: string | null }) =>
      ipcRenderer.invoke(IPC_CHANNELS.salesListInvoices, input),
    getInvoice: (input: { invoiceLocalUuid: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.salesGetInvoice, input)
  }),
  refunds: Object.freeze({
    getRefundable: (input: { invoiceLocalUuid: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.refundsGetRefundable, input),
    preview: (input: {
      invoiceLocalUuid: string
      lines: RefundLineSelection[]
      stockReturned: boolean
    }) => ipcRenderer.invoke(IPC_CHANNELS.refundsPreview, input),
    submit: (input: {
      previewId: string
      invoiceLocalUuid: string
      lines: RefundLineSelection[]
      stockReturned: boolean
      paymentMethodUuid: string | null
      reference?: string | null
      reason?: string | null
      notes?: string | null
    }) => ipcRenderer.invoke(IPC_CHANNELS.refundsSubmit, input),
    resume: (input: { localRefundUuid: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.refundsResume, input),
    cancelPrepared: (input: { localRefundUuid: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.refundsCancelPrepared, input)
  }),
  printing: Object.freeze({
    getWorkstationSettings: () => ipcRenderer.invoke(IPC_CHANNELS.printingGetWorkstationSettings),
    saveWorkstationSettings: (settings: PrinterSettings) =>
      ipcRenderer.invoke(IPC_CHANNELS.printingSaveWorkstationSettings, settings),
    listPrinters: () => ipcRenderer.invoke(IPC_CHANNELS.printingListPrinters),
    preview: (input: PrintingPreviewInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.printingPreview, input),
    dispatch: (input: PrintingDispatchInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.printingDispatch, input),
    getJob: (input: { requestId: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.printingGetJob, input),
    cancelJob: (input: { requestId: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.printingCancelJob, input),
    latestForDocument: (input: { document: ReceiptDocumentRef }) =>
      ipcRenderer.invoke(IPC_CHANNELS.printingLatestForDocument, input)
  }),
  receiptProfile: Object.freeze({
    get: () => ipcRenderer.invoke(IPC_CHANNELS.receiptProfileGet),
    chooseLogo: () => ipcRenderer.invoke(IPC_CHANNELS.receiptProfileChooseLogo),
    publish: (input: ReceiptProfilePublishInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.receiptProfilePublish, input)
  })
})
