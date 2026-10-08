export const IPC_CHANNELS = Object.freeze({
  systemGetRuntimeInfo: 'system:get-runtime-info',
  deviceGetIdentitySummary: 'device:get-identity-summary',
  deviceRegister: 'device:register',
  authGetSessionSummary: 'auth:get-session-summary',
  authLogin: 'auth:login',
  authRefreshSession: 'auth:refresh-session',
  authLogout: 'auth:logout',
  licenseValidate: 'license:validate',
  licenseGetAccess: 'license:get-access',
  licenseAccessChanged: 'license:access-changed',
  bootstrapGetStatus: 'bootstrap:get-status',
  bootstrapRefresh: 'bootstrap:refresh',
  catalogGetStatus: 'catalog:get-status',
  catalogRefresh: 'catalog:refresh',
  catalogListCategories: 'catalog:list-categories',
  catalogSearchProducts: 'catalog:search-products',
  catalogGetProduct: 'catalog:get-product',
  catalogGetProductForSale: 'catalog:get-product-for-sale',
  /** Main → renderer only: a stock or snapshot change hint; carries no quantities. */
  catalogChanged: 'catalog:changed',
  // Owner UX plan P9: the company identity (read) and its change notice (main → renderer only).
  brandingGet: 'branding:get',
  brandingChanged: 'branding:changed',
  quickCreateGetAccess: 'quick-create:get-access',
  quickCreateCustomer: 'quick-create:create-customer',
  quickCreateSupplier: 'quick-create:create-supplier',
  quickCreateProduct: 'quick-create:create-product',
  quickCreateProductOptions: 'quick-create:product-options',
  quickCreateList: 'quick-create:list',
  quickCreateRetry: 'quick-create:retry',
  quickCreateReassign: 'quick-create:reassign',
  quickCreateResubmit: 'quick-create:resubmit',
  quickCreateChanged: 'quick-create:changed',
  catalogFindByBarcode: 'catalog:find-by-barcode',
  catalogListPaymentMethods: 'catalog:list-payment-methods',
  catalogSearchCustomers: 'catalog:search-customers',
  catalogGetCustomer: 'catalog:get-customer',
  shiftsCurrent: 'shifts:current',
  shiftsLocalAuthority: 'shifts:local-authority',
  shiftsGet: 'shifts:get',
  shiftsOpen: 'shifts:open',
  shiftsPause: 'shifts:pause',
  shiftsResume: 'shifts:resume',
  shiftsClose: 'shifts:close',
  checkoutValidate: 'checkout:validate',
  checkoutComplete: 'checkout:complete',
  checkoutPendingAttempts: 'checkout:pending-attempts',
  checkoutRetryAttempt: 'checkout:retry-attempt',
  checkoutAbandonAttempt: 'checkout:abandon-attempt',
  checkoutAcknowledgeAttempt: 'checkout:acknowledge-attempt',
  checkoutAttemptStatus: 'checkout:attempt-status',
  /** Main → renderer only (Rev 4 §9.1): claimed/committed attempts changed; carries no payload. */
  checkoutAttemptsChanged: 'checkout:attempts-changed',
  /** Rev 4 §8 — the catalog-install lifecycle. */
  posDraftState: 'pos:draft-state',
  /** Main → renderer only: arm the install hold and reply. */
  catalogInstallHold: 'catalog:install-hold',
  catalogInstallHoldReply: 'catalog:install-hold-reply',
  catalogInstallHoldStatus: 'catalog:install-hold-status',
  /** Main → renderer only: the hold reached a terminal state. */
  catalogInstallRelease: 'catalog:install-release',
  workstationRefresh: 'workstation:refresh',
  /**
   * CP4: the narrow preparation surface (plan §10 CP4 — "no broad database/network IPC").
   *
   * Two channels only. `preparationGetReadiness` returns a *projection*: categorical states and
   * integer milli quantities. `preparationRunCycle` takes **no arguments at all** — §5.2 forbids a
   * renderer-supplied product set from ever reaching the wire, and a channel that accepted one
   * would make that a code-review rule instead of a boundary property.
   */
  // PS6 §14.3: one request-only READ. The renderer asks for the projection and supplies nothing —
  // no owner, no clock, no quantity, no window — exactly like the preparation channels below.
  offlineSaleGetReadiness: 'offline-sale:get-readiness',
  preparationGetReadiness: 'preparation:get-readiness',
  preparationRunCycle: 'preparation:run-cycle',
  allocationRecoveryStart: 'allocation-recovery:start',
  allocationRecoveryResume: 'allocation-recovery:resume',
  syncGetStatus: 'sync:get-status',
  syncUploadNow: 'sync:upload-now',
  syncListFailures: 'sync:list-failures',
  syncSupportIssues: 'sync:support-issues',
  syncChanged: 'sync:changed',
  connectivityGetState: 'connectivity:get-state',
  connectivityCheckNow: 'connectivity:check-now',
  connectivityChanged: 'connectivity:changed',
  preferencesGetLocale: 'preferences:get-locale',
  preferencesSetLocale: 'preferences:set-locale',
  preferencesGetTheme: 'preferences:get-theme',
  preferencesSetTheme: 'preferences:set-theme',
  preferencesGetPosCartWidth: 'preferences:get-pos-cart-width',
  preferencesSetPosCartWidth: 'preferences:set-pos-cart-width',
  // POS improvements, Stage 5: per-user preferences of the signed-in user.
  preferencesGetUser: 'preferences:get-user',
  preferencesSetUser: 'preferences:set-user',
  // POS workspace: the signed-in user's selling-screen layout on this workstation.
  preferencesGetPosWorkspace: 'preferences:get-pos-workspace',
  preferencesSetPosWorkspace: 'preferences:set-pos-workspace',
  companyUsersGetAccess: 'company-users:get-access',
  companyUsersList: 'company-users:list',
  companyUsersGet: 'company-users:get',
  companyUsersCreate: 'company-users:create',
  companyUsersUpdate: 'company-users:update',
  companyUsersSetRoles: 'company-users:set-roles',
  companyUsersSetEnabled: 'company-users:set-enabled',
  companyUsersListAssignableRoles: 'company-users:list-assignable-roles',
  // Plan §5 (r5) -- the refund domain. Sales channels are read-only local-first lookups; refund
  // channels are the durable online-only submission flow.
  salesListInvoices: 'sales:list-invoices',
  salesGetInvoice: 'sales:get-invoice',
  refundsGetRefundable: 'refunds:get-refundable',
  // POS improvements, Stage 3: whether this session may start a refund (shows the POS action).
  refundsGetAccess: 'refunds:get-access',
  refundsPreview: 'refunds:preview',
  refundsSubmit: 'refunds:submit',
  refundsResume: 'refunds:resume',
  refundsCancelPrepared: 'refunds:cancel-prepared',
  // Receipt-printing plan (rev 5) -- printing (main-owned document build, render, dispatch). Every
  // channel: assertTrustedSender, then a strict Zod input schema, then the channel's own
  // authority check.
  printingGetWorkstationSettings: 'printing:get-workstation-settings',
  printingSaveWorkstationSettings: 'printing:save-workstation-settings',
  printingListPrinters: 'printing:list-printers',
  printingPreview: 'printing:preview',
  printingDispatch: 'printing:dispatch',
  printingGetJob: 'printing:get-job',
  printingCancelJob: 'printing:cancel-job',
  printingLatestForDocument: 'printing:latest-for-document',
  // POS improvements, Stage 7 -- automatic printing: one sale's state, the setup banner, and the
  // recovery notices of the signed-in user.
  printingAutoPrintStatus: 'printing:auto-print-status',
  printingAutoPrintSetup: 'printing:auto-print-setup',
  printingAutoPrintNotices: 'printing:auto-print-notices',
  printingAutoPrintDismissNotices: 'printing:auto-print-dismiss-notices',
  // Receipt-printing plan §D-11 -- the CompanyAdmin receipt-profile editor. Same discipline as
  // printing: assertTrustedSender, a strict Zod input schema, then the caller's session and the
  // mirrored `canManage` verdict inside `ReceiptProfileAdminService`.
  receiptProfileGet: 'receipt-profile:get',
  receiptProfileChooseLogo: 'receipt-profile:choose-logo',
  receiptProfilePublish: 'receipt-profile:publish',
  // V1 Windows readiness: main-owned automatic updates.
  updatesGetStatus: 'updates:get-status',
  updatesCheckNow: 'updates:check-now',
  updatesRestartToInstall: 'updates:restart-to-install',
  updatesChanged: 'updates:changed'
})
