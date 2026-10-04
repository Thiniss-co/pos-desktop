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
  // Receipt-printing plan §D-11 -- the CompanyAdmin receipt-profile editor. Same discipline as
  // printing: assertTrustedSender, a strict Zod input schema, then the caller's session and the
  // mirrored `canManage` verdict inside `ReceiptProfileAdminService`.
  receiptProfileGet: 'receipt-profile:get',
  receiptProfileChooseLogo: 'receipt-profile:choose-logo',
  receiptProfilePublish: 'receipt-profile:publish'
})
