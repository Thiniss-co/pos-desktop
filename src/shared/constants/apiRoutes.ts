export type DesktopApiMethod = 'GET' | 'POST'

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
  bootstrap: {
    path: '/bootstrap',
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
  }
} satisfies Record<string, DesktopApiRoute>)
