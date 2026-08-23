import type { ConnectivitySnapshot } from './connectivity.contract'

export type ConnectivityPolicy =
  'online_required' | 'offline_capable_with_business_guards' | 'local_only'

export const CONNECTIVITY_PRECONDITION = Object.freeze({
  deviceActivation: 'online_required',
  login: 'online_required',
  licenseValidation: 'online_required',
  companyUserManagement: 'online_required',
  catalogueRefresh: 'online_required',
  viewCachedCatalogue: 'local_only',
  localCheckout: 'offline_capable_with_business_guards',
  invoiceSync: 'online_required'
} as const satisfies Record<string, ConnectivityPolicy>)

/**
 * This is a necessary precondition, never an authorization. Commercial access, RBAC, device
 * binding, shift state, and local integrity remain separate main-process guards.
 */
export function meetsConnectivityPrecondition(
  policy: ConnectivityPolicy,
  snapshot: ConnectivitySnapshot
): boolean {
  if (policy === 'local_only' || policy === 'offline_capable_with_business_guards') {
    return true
  }

  return snapshot.status === 'online' && snapshot.backendReachable === true
}
