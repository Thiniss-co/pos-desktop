import type { PosApi } from './posApi'

declare global {
  interface Window {
    posApi: PosApi
  }
}
