/// <reference types="electron-vite/node" />

interface ImportMetaEnv {
  readonly MAIN_VITE_POS_API_ORIGIN?: string
  /** Test packages only: lets a packaged till use a loopback HTTP origin (see runtimeConfig). */
  readonly MAIN_VITE_POS_ALLOW_LOOPBACK_ORIGIN?: string
}
