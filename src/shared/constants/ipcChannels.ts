export const IPC_CHANNELS = Object.freeze({
  systemGetRuntimeInfo: 'system:get-runtime-info',
  deviceGetIdentitySummary: 'device:get-identity-summary',
  deviceRegister: 'device:register',
  authGetSessionSummary: 'auth:get-session-summary',
  authLogin: 'auth:login',
  authRefreshSession: 'auth:refresh-session',
  authLogout: 'auth:logout',
  licenseValidate: 'license:validate',
  bootstrapGetStatus: 'bootstrap:get-status',
  bootstrapRefresh: 'bootstrap:refresh',
  syncGetStatus: 'sync:get-status'
})
