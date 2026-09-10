export type DesktopApiMethod = 'GET' | 'POST' | 'PUT'

export interface DesktopApiRoute {
  readonly path: string
  readonly method: DesktopApiMethod
  readonly requiresAuth: boolean
  readonly requiresDeviceUuid: boolean
}

export const DESKTOP_API_ROUTES = Object.freeze({
  deviceRegister: {
    path: '/device/register',
    method: 'POST',
    requiresAuth: false,
    requiresDeviceUuid: false
  },
  authLogin: {
    path: '/auth/login',
    method: 'POST',
    requiresAuth: false,
    requiresDeviceUuid: false
  },
  authMe: {
    path: '/auth/me',
    method: 'GET',
    requiresAuth: true,
    requiresDeviceUuid: true
  },
  authLogout: {
    path: '/auth/logout',
    method: 'POST',
    requiresAuth: true,
    requiresDeviceUuid: true
  },
  /**
   * BH-04B-3: `allocation_payload_version=2` asks the backend for the reconciliation representation
   * of the allocation envelope — the §3.1 coverage boundary on each grant plus the §9.2-4 terminal
   * markers. It is payload-format negotiation only: it is not authorization, it does not claim this
   * client is safe, and it never grants any new ability to release stock.
   *
   * Omitting it (which every already-shipped desktop does) returns the original 21-key envelope and
   * no terminal-marker key, so this app can be deployed after the backend without a flag day. A
   * backend that predates the negotiation ignores the parameter and answers in the legacy shape,
   * which this app still parses — and then stays in the conservative spendability mode, because a
   * response with no coverage is never read as a verified zero boundary.
   *
   * PS4 §15.2: `offline_sale_contract_version=1` additionally asks for the issued offline-sale
   * authority block. Same discipline and for the same reason — the response schema is `.strict()`,
   * so the backend must not send the key unless it was asked for, and a backend that predates the
   * negotiation ignores the parameter and answers in the shape this client already parses.
   *
   * Asking for it does NOT cause issuance. Bootstrap issues nothing (§6.3.1); it republishes an
   * authority a successful `license/validate` already minted, and the window it reports is
   * unchanged by being read.
   */
  bootstrap: {
    path: '/bootstrap?allocation_payload_version=2&offline_sale_contract_version=1',
    method: 'GET',
    requiresAuth: true,
    requiresDeviceUuid: true
  },
  deviceHeartbeat: {
    path: '/device/heartbeat',
    method: 'POST',
    requiresAuth: true,
    requiresDeviceUuid: true
  },
  licenseValidate: {
    path: '/license/validate',
    method: 'POST',
    requiresAuth: true,
    requiresDeviceUuid: true
  },
  shiftsCurrent: {
    path: '/shifts/current',
    method: 'GET',
    requiresAuth: true,
    requiresDeviceUuid: true
  },
  shiftsOpen: {
    path: '/shifts/open',
    method: 'POST',
    requiresAuth: true,
    requiresDeviceUuid: true
  },
  shiftsShow: {
    path: '/shifts',
    method: 'GET',
    requiresAuth: true,
    requiresDeviceUuid: true
  },
  shiftsPause: {
    path: '/shifts',
    method: 'POST',
    requiresAuth: true,
    requiresDeviceUuid: true
  },
  shiftsResume: {
    path: '/shifts',
    method: 'POST',
    requiresAuth: true,
    requiresDeviceUuid: true
  },
  shiftsClose: {
    path: '/shifts',
    method: 'POST',
    requiresAuth: true,
    requiresDeviceUuid: true
  },
  stockAllocationsTopUp: {
    path: '/stock-allocations/top-up',
    method: 'POST',
    requiresAuth: true,
    requiresDeviceUuid: true
  },
  /**
   * CP3: the coordinated server-computed preparation operation (plan §5.1).
   *
   * The backend ships this capability disabled and answers 404 while it is off, so an ordinary
   * not-found here is a *capability* answer and not an error worth retrying — never a reason to
   * mint a new operation identity.
   */
  offlineStockPrepare: {
    path: '/offline-stock/prepare',
    method: 'POST',
    requiresAuth: true,
    requiresDeviceUuid: true
  },
  invoicesUpload: {
    path: '/invoices/upload',
    method: 'POST',
    requiresAuth: true,
    requiresDeviceUuid: true
  },
  refundsUpload: {
    path: '/refunds/upload',
    method: 'POST',
    requiresAuth: true,
    requiresDeviceUuid: true
  },
  companyUsersList: {
    path: '/company/users',
    method: 'GET',
    requiresAuth: true,
    requiresDeviceUuid: true
  },
  companyUsersGet: {
    path: '/company/users',
    method: 'GET',
    requiresAuth: true,
    requiresDeviceUuid: true
  },
  companyUsersCreate: {
    path: '/company/users',
    method: 'POST',
    requiresAuth: true,
    requiresDeviceUuid: true
  },
  companyUsersUpdate: {
    path: '/company/users',
    method: 'PUT',
    requiresAuth: true,
    requiresDeviceUuid: true
  },
  companyUsersActivate: {
    path: '/company/users',
    method: 'POST',
    requiresAuth: true,
    requiresDeviceUuid: true
  },
  companyUsersDeactivate: {
    path: '/company/users',
    method: 'POST',
    requiresAuth: true,
    requiresDeviceUuid: true
  },
  companyAssignableRoles: {
    path: '/company/assignable-roles',
    method: 'GET',
    requiresAuth: true,
    requiresDeviceUuid: true
  }
} satisfies Record<string, DesktopApiRoute>)

function allocationMutationRoute(allocationUuid: string, operation: string): DesktopApiRoute {
  if (!/^[0-9a-f-]{36}$/i.test(allocationUuid)) {
    throw new Error('A valid allocation UUID is required')
  }

  return {
    path: `/stock-allocations/${allocationUuid.toLowerCase()}/${operation}`,
    method: 'POST',
    requiresAuth: true,
    requiresDeviceUuid: true
  }
}

export function stockAllocationSealRoute(allocationUuid: string): DesktopApiRoute {
  return allocationMutationRoute(allocationUuid, 'seal')
}

export function stockAllocationAcknowledgeSealRoute(allocationUuid: string): DesktopApiRoute {
  return allocationMutationRoute(allocationUuid, 'acknowledge-seal')
}
