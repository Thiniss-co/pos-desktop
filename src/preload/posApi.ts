import { ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import type { ActivationInput, ActivationResult } from '@shared/contracts/activation.contract'
import type { LoginInput, SessionSummary } from '@shared/contracts/auth.contract'
import type { BootstrapResult, BootstrapStatus } from '@shared/contracts/bootstrap.contract'
import type {
  CheckoutAbandonAttemptInput,
  CheckoutAcknowledgeAttemptInput,
  CheckoutCompleteInput,
  CheckoutCompletionOutcome,
  CheckoutIntent,
  CheckoutPendingAttemptsInput,
  CheckoutPreviewOutcome,
  CheckoutRecoveryState,
  CheckoutRetryAttemptInput
} from '@shared/contracts/checkout.contract'
import type {
  CatalogCategory,
  CatalogBarcodeLookup,
  CatalogCustomer,
  CatalogCustomerPage,
  CatalogCustomerSearchInput,
  CatalogPaymentMethod,
  CatalogProduct,
  CatalogProductPage,
  CatalogRefreshResult,
  CatalogSearchInput,
  CatalogStatus
} from '@shared/contracts/catalog.contract'
import type { ConnectivitySnapshot } from '@shared/contracts/connectivity.contract'
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
import type { SyncStatus } from '@shared/contracts/sync.contract'
import type { RuntimeInfo } from '@shared/contracts/system.contract'
import type {
  CloseShiftInput,
  OpenShiftInput,
  PauseShiftInput,
  ResumeShiftInput,
  Shift
} from '@shared/contracts/shift.contract'

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
    findProductByBarcode(input: { barcode: string }): Promise<IpcResult<CatalogBarcodeLookup>>
    listPaymentMethods(): Promise<IpcResult<CatalogPaymentMethod[]>>
    searchCustomers(input: CatalogCustomerSearchInput): Promise<IpcResult<CatalogCustomerPage>>
    getCustomer(input: { uuid: string }): Promise<IpcResult<CatalogCustomer>>
  }
  readonly shifts: {
    current(): Promise<IpcResult<Shift | null>>
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
  }
  readonly sync: {
    getStatus(): Promise<IpcResult<SyncStatus>>
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
    findProductByBarcode: (input: { barcode: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.catalogFindByBarcode, input),
    listPaymentMethods: () => ipcRenderer.invoke(IPC_CHANNELS.catalogListPaymentMethods),
    searchCustomers: (input: CatalogCustomerSearchInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.catalogSearchCustomers, input),
    getCustomer: (input: { uuid: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.catalogGetCustomer, input)
  }),
  shifts: Object.freeze({
    current: () => ipcRenderer.invoke(IPC_CHANNELS.shiftsCurrent),
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
      ipcRenderer.invoke(IPC_CHANNELS.checkoutPendingAttempts, input)
  }),
  sync: Object.freeze({
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.syncGetStatus)
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
  })
})
