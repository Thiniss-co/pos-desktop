/// <reference types="electron-vite/node" />

interface ImportMetaEnv {
  readonly MAIN_VITE_POS_API_ORIGIN?: string
  /** Test packages only: lets a packaged till use a loopback HTTP origin (see runtimeConfig). */
  readonly MAIN_VITE_POS_ALLOW_LOOPBACK_ORIGIN?: string
  /** The automatic-update feed (electron-updater generic provider); unset = updates not configured. */
  readonly MAIN_VITE_POS_UPDATE_FEED_URL?: string
}
