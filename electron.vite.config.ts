import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
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
    plugins: [vue()],
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
