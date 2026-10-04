import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// The final OS print boundary is chosen at BUILD time (see src/main/receipt/printBoundary.types.ts).
// Only the Playwright harness build sets POS_PRINT_BOUNDARY=virtual; every other build, including
// every production build, contains the real spooler boundary and no virtual destination.
const printBoundary =
  process.env.POS_PRINT_BOUNDARY === 'virtual'
    ? resolve('src/main/receipt/printBoundary.virtual.ts')
    : resolve('src/main/receipt/printBoundary.os.ts')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@printBoundary': printBoundary
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [vue(), tailwindcss()],
    define: {
      // The app only uses the Composition API (`useI18n()` in every `<script setup>`, no `$t`
      // global property, no `v-t` directive), so vue-i18n's legacy/full-install code paths are
      // dead weight. Defining these at build time (instead of leaving them for vue-i18n's runtime
      // `typeof x !== 'boolean'` fallback) lets the bundler eliminate that code and avoids the
      // fallback writing feature-flag globals onto `globalThis` in production.
      __VUE_I18N_FULL_INSTALL__: 'false',
      __VUE_I18N_LEGACY_API__: 'false',
      __INTLIFY_PROD_DEVTOOLS__: 'false'
    }
  }
})
