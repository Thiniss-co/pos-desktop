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
  /**
   * r5 §0.1: `refund_contract_version=1` additionally asks for the confirmed-refund-calculation
   * capability marker. Same discipline as the other negotiated parameters above -- a backend that
   * predates it ignores the parameter and answers without `refund_contract`, and this app then
   * offers no refund at all rather than guessing whether the write path is protected.
   *
   * Receipt-printing plan §D-10/§D-11: `receipt_profile_version=1` additionally asks for the
   * company receipt-profile block (branding) and the caller's `can_manage` capability. Same
   * discipline -- a backend that predates it ignores the parameter and answers without
   * `receipt_profile`, and this app mirrors nothing and hides the branding editor.
   */
  /**
   * Owner receipt copies: `receipt_snapshot_version=2` asks whether the server stores sale receipt
   * snapshots (`receipt_snapshot: {version: N}`, N = the newest version stored; it stores 1..N). v2 adds
   * the frozen fiscal context and its exact QR. Without the block the register keeps its snapshots
   * pending and sends none.
   */
  /**
   * Owner UX plan P9: `company_branding_version=1` additionally asks for the `company_branding`
   * block (logo and primary colour); an older backend ignores it and the default brand is shown.
   */
  /**
   * Owner UX plan P8: `product_image_version=1` additionally asks for the `product_images` block.
   * A backend that predates it ignores the parameter and answers without the block; this app then
   * keeps whatever references it holds (none on a first run) and shows monograms.
   */
  /**
   * Rev 4 §6.3: `offline_sale_contract_version=2` asks for the warehouse-bound authority
   * representation. A backend that supports only v1 answers 422 on that field before any work, and
   * the client then uses `bootstrapOfflineSaleV1` (identical except for the version).
   */
  /**
   * Owner expansion Phase E: `offers_version=1` asks for the `offers` block (the register offers the
   * catalog contract carries). A backend that predates it ignores the parameter; no offers apply.
   */
  bootstrap: {
    path: '/bootstrap?allocation_payload_version=2&offline_sale_contract_version=2&refund_contract_version=1&receipt_profile_version=2&product_image_version=1&company_branding_version=1&quick_create_version=1&catalog_tax_policy_version=2&fiscal_identity_version=1&receipt_snapshot_version=2&offers_version=1',
    method: 'GET',
    requiresAuth: true,
    requiresDeviceUuid: true
  },
  bootstrapOfflineSaleV1: {
    path: '/bootstrap?allocation_payload_version=2&offline_sale_contract_version=1&refund_contract_version=1&receipt_profile_version=2&product_image_version=1&company_branding_version=1&quick_create_version=1&catalog_tax_policy_version=2&fiscal_identity_version=1&receipt_snapshot_version=2&offers_version=1',
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
  // POS improvements, Stage 2: register quick-create (durable, keyed, replayed verbatim by the server).
  quickCreateCustomers: {
    path: '/quick-create/customers',
    method: 'POST',
    requiresAuth: true,
    requiresDeviceUuid: true
  },
  quickCreateSuppliers: {
    path: '/quick-create/suppliers',
    method: 'POST',
    requiresAuth: true,
    requiresDeviceUuid: true
  },
  quickCreateProducts: {
    path: '/quick-create/products',
    method: 'POST',
    requiresAuth: true,
    requiresDeviceUuid: true
  },
  refundsUpload: {
    // POS improvements, Stage 6: asks for the credit note's frozen fiscal facts in the acceptance
    // response. A query parameter, never part of the hashed body; an older backend ignores it.
    path: '/refunds/upload?fiscal_contract_version=1',
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
  },
  /**
   * Receipt-printing plan §D-10 — administration only. The backend re-checks CompanyAdmin role AND
   * `receipts.profile.manage` on every write (§D-10 "Correction A"); these routes carry no
   * authority of their own.
   */
  receiptProfileUploadLogo: {
    path: '/receipt-profile/logo',
    method: 'POST',
    requiresAuth: true,
    requiresDeviceUuid: true
  },
  receiptProfilePublish: {
    path: '/receipt-profile',
    method: 'PUT',
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

/**
 * r5 §2/§3 — `GET /api/v1/desktop/invoices/{invoice}` by remote UUID. Used to read the refund
 * read model (refunded/refundable quantities and amounts) before offering a refund.
 */
export function invoiceShowRoute(invoiceRemoteUuid: string): DesktopApiRoute {
  if (!/^[0-9a-f-]{36}$/i.test(invoiceRemoteUuid)) {
    throw new Error('A valid invoice UUID is required')
  }

  return {
    path: `/invoices/${invoiceRemoteUuid.toLowerCase()}`,
    method: 'GET',
    requiresAuth: true,
    requiresDeviceUuid: true
  }
}

/**
 * Receipt-printing plan §D-10/§D-11 — `GET /api/v1/desktop/receipt-profile/assets/{sha256}`. The
 * sha must already be a lowercase 64-hex string (as recorded by the mirror), which this validates
 * before it ever reaches a URL path segment.
 */
export function receiptProfileAssetRoute(sha256: string): DesktopApiRoute {
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('A valid asset sha256 is required')
  }

  return {
    path: `/receipt-profile/assets/${sha256}`,
    method: 'GET',
    requiresAuth: true,
    requiresDeviceUuid: true
  }
}

/**
 * Owner UX plan P8 — `GET /api/v1/desktop/product-image-assets/{sha256}`. The sha must already be a
 * lowercase 64-hex string (as recorded from the bootstrap block), validated before it reaches a path.
 */
export function productImageAssetRoute(sha256: string): DesktopApiRoute {
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('A valid asset sha256 is required')
  }

  return {
    path: `/product-image-assets/${sha256}`,
    method: 'GET',
    requiresAuth: true,
    requiresDeviceUuid: true
  }
}

/** Owner UX plan P9 — `GET /api/v1/desktop/company-branding/assets/{sha256}`. */
export function companyBrandAssetRoute(sha256: string): DesktopApiRoute {
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('A valid asset sha256 is required')
  }

  return {
    path: `/company-branding/assets/${sha256}`,
    method: 'GET',
    requiresAuth: true,
    requiresDeviceUuid: true
  }
}

/** Owner receipt copies: the frozen receipt snapshot of one of this register's accepted sale uploads. */
export function invoiceReceiptSnapshotRoute(invoiceLocalUuid: string): DesktopApiRoute {
  return {
    path: `/invoices/${encodeURIComponent(invoiceLocalUuid)}/receipt-snapshot`,
    method: 'POST',
    requiresAuth: true,
    requiresDeviceUuid: true
  }
}

/** POS improvements, Stage 2: the stored result of one of THIS register's quick-create requests. */
export function quickCreateRequestRoute(requestKey: string): DesktopApiRoute {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestKey)) {
    throw new Error('A quick-create request key must be a UUID')
  }
  return {
    path: `/quick-create/requests/${requestKey.toLowerCase()}`,
    method: 'GET',
    requiresAuth: true,
    requiresDeviceUuid: true
  }
}
